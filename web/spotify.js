/* spotify.js — optional in-browser enrichment via Spotify's PKCE OAuth flow
   (no client secret, safe for a static site). Lets a signed-in user pull cover
   art + popularity for the data already loaded. Genres come from Last.fm.

   The Client ID is public (not a secret). The Spotify app must list this page's
   URL as a Redirect URI, and (while the app is in development mode) the user's
   email must be on the app's allowlist. */

const SPOTIFY_CLIENT_ID = "b04d754ba7844eeba3813da5cc8fbc23";
const SP_AUTH = "https://accounts.spotify.com/authorize";
const SP_TOKEN = "https://accounts.spotify.com/api/token";
const SP_API = "https://api.spotify.com/v1";
// Redirect back to exactly this page (must match a Redirect URI in the Spotify app)
const SP_REDIRECT = location.origin + location.pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- PKCE helpers ---- */
function randString(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function challengeOf(verifier) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function spotifyLogin() {
  const verifier = randString(64);
  sessionStorage.setItem("sp_verifier", verifier);
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SP_REDIRECT,
    code_challenge_method: "S256",
    code_challenge: await challengeOf(verifier),
    scope: "", // genres/art are public catalog data — no user scopes needed
  });
  location.href = SP_AUTH + "?" + params.toString();
}

// Returns true if we just came back from Spotify with a code and got a token.
async function spotifyHandleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (code || err) {
    url.searchParams.delete("code"); url.searchParams.delete("state"); url.searchParams.delete("error");
    history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
  }
  if (err) throw new Error("Spotify sign-in was cancelled or denied (" + err + ").");
  if (!code) return false;
  const verifier = sessionStorage.getItem("sp_verifier");
  if (!verifier) return false;
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID, grant_type: "authorization_code",
    code, redirect_uri: SP_REDIRECT, code_verifier: verifier,
  });
  const r = await fetch(SP_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("Token exchange failed (" + r.status + "). Check the Redirect URI in your Spotify app.");
  saveToken(await r.json());
  sessionStorage.removeItem("sp_verifier");
  return true;
}

function saveToken(tok) {
  const t = { access: tok.access_token, refresh: tok.refresh_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
  sessionStorage.setItem("sp_token", JSON.stringify(t));
}
function getToken() { try { return JSON.parse(sessionStorage.getItem("sp_token")); } catch (e) { return null; } }
function spotifyConnected() { const t = getToken(); return !!(t && Date.now() < t.expiresAt); }

async function refreshToken(t) {
  if (!t.refresh) throw new Error("session expired");
  const body = new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, grant_type: "refresh_token", refresh_token: t.refresh });
  const r = await fetch(SP_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("session refresh failed");
  const tok = await r.json();
  if (!tok.refresh_token) tok.refresh_token = t.refresh;
  saveToken(tok);
  return getToken();
}

async function spotifyGet(path) {
  let t = getToken();
  if (!t) throw new Error("not connected");
  if (Date.now() > t.expiresAt - 60000 && t.refresh) t = await refreshToken(t);
  for (;;) {
    const r = await fetch(SP_API + path, { headers: { Authorization: "Bearer " + t.access } });
    if (r.status === 429) { await sleep(((+r.headers.get("Retry-After")) || 2) * 1000 + 500); continue; }
    if (r.status === 401 && t.refresh) { t = await refreshToken(t); continue; }
    if (!r.ok) throw new Error("Spotify API error " + r.status);
    return r.json();
  }
}

/* ---- Enrichment ----
   /tracks must come first (it's the only source of artist IDs), but we go in
   MOST-PLAYED-FIRST order and fetch each artist as soon as its ID appears, then
   re-render progressively. So your top artists' genres + the top cover art show
   up in the first second or two, and the long tail fills in after.

   onProgress(tracksDone, totalTracks, artistsDone, totalArtists, doRender). */
async function spotifyEnrich(data, onProgress) {
  const SEP = String.fromCharCode(1);

  // track indices that have a Spotify id, ordered by play count (desc)
  const counts = new Int32Array(data.tracks.length);
  const pt = data.plays.t;
  for (let i = 0; i < pt.length; i++) counts[pt[i]]++;
  const order = [];
  for (let i = 0; i < data.tracks.length; i++) if (data.tracks[i].id) order.push(i);
  order.sort((a, b) => counts[b] - counts[a]);
  const trackIds = order.map((i) => data.tracks[i].id);
  const totalTracks = trackIds.length;

  const trackInfo = new Map();      // track id -> {img, imgBig, artistIds, popularity, duration_ms}
  const artistInfo = new Map();     // artist id -> {genres, img, popularity, followers}
  const seenArtist = new Set();
  const pendingArtists = [];        // artist ids waiting to be fetched
  let tracksDone = 0, artistsDone = 0, totalArtists = 0, lastRender = Date.now();

  function applyAll() {
    const nameToArtist = {};
    for (const t of data.tracks) {
      const info = trackInfo.get(t.id);
      if (info && info.artistIds.length && !(t.artist in nameToArtist)) nameToArtist[t.artist] = info.artistIds[0];
    }
    const albumArt = {};
    for (const t of data.tracks) {
      const info = trackInfo.get(t.id);
      if (!info) continue;
      t.img = info.img; t.popularity = info.popularity; t.duration_ms = info.duration_ms;
      const k = t.artist + SEP + t.album;
      if ((info.imgBig || info.img) && !(k in albumArt)) albumArt[k] = info.imgBig || info.img;
    }
    for (const a of data.artists) {
      const info = artistInfo.get(nameToArtist[a.name]);
      if (info) { a.img = info.img; a.popularity = info.popularity; a.followers = info.followers; }
    }
    for (const al of data.albums) {
      const k = al.artist + SEP + al.name;
      if (albumArt[k]) al.img = albumArt[k];
    }
  }

  function report() {
    const now = Date.now();
    const doRender = now - lastRender > 700;
    if (doRender) { applyAll(); lastRender = now; }
    onProgress(tracksDone, totalTracks, artistsDone, totalArtists, doRender);
  }

  async function flushArtists(force) {
    while (pendingArtists.length >= 50 || (force && pendingArtists.length)) {
      const batch = pendingArtists.splice(0, 50);
      const res = await spotifyGet("/artists?ids=" + batch.join(","));
      for (const ar of res.artists || []) {
        if (!ar) continue;
        const imgs = ar.images || [];
        artistInfo.set(ar.id, {
          genres: ar.genres || [], img: imgs.length ? imgs[imgs.length - 1].url : null,
          popularity: ar.popularity, followers: (ar.followers || {}).total,
        });
      }
      artistsDone += batch.length;
      report();
    }
  }

  for (let i = 0; i < trackIds.length; i += 50) {
    const res = await spotifyGet("/tracks?ids=" + trackIds.slice(i, i + 50).join(","));
    for (const tr of res.tracks || []) {
      if (!tr) continue;
      const imgs = (tr.album && tr.album.images) || [];
      const arts = tr.artists || [];
      trackInfo.set(tr.id, {
        img: imgs.length ? imgs[imgs.length - 1].url : null,
        imgBig: imgs.length ? imgs[0].url : null,
        artistIds: arts.map((a) => a.id).filter(Boolean),
        popularity: tr.popularity, duration_ms: tr.duration_ms,
      });
      for (const a of arts) if (a.id && !seenArtist.has(a.id)) { seenArtist.add(a.id); pendingArtists.push(a.id); totalArtists++; }
    }
    tracksDone = Math.min(i + 50, totalTracks);
    await flushArtists(i === 0);   // force after the first batch so top artists light up immediately
    report();
  }
  await flushArtists(true);        // any remaining artists
  applyAll();
  onProgress(tracksDone, totalTracks, artistsDone, totalArtists, true);
  data.enriched = true;
}
