/* Last.fm genre fetching — loads artist genres in the background.
   Never touches data.json; genres live separately and are applied in-memory. */

const LASTFM_API_KEY = "4d13b240413a42e5d7e71417370d6ee7";
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_MAX_TAGS = 5;
const LASTFM_MIN_COUNT = 10;
const LASTFM_CONCURRENCY = 5;

const LASTFM_BLOCKLIST = new Set([
  "seen live", "favorites", "favourites", "favorite", "favourite",
  "favorite songs", "favourite songs", "spotify", "love", "loved",
  "beautiful", "awesome", "amazing", "cool", "good", "great", "nice",
  "sexy", "catchy", "masterpiece", "vinyl", "owned", "albums i own",
  "want to see live", "wishlist", "my music", "music", "all", "favorite artists",
  "female vocalists", "male vocalists", "female vocalist", "male vocalist",
  "female fronted", "male fronted",
  "under 2000 listeners", "banger", "bangers", "vibe", "vibes",
]);

function lastfmIsDecade(tag) {
  const t = tag.replace(/ /g, "");
  return (t.endsWith("s") && t.slice(0, -1).match(/^\d+$/)) || (t.length === 4 && /^\d{4}$/.test(t));
}

function lastfmFilterTags(tags) {
  const out = [];
  for (const { name, count } of tags) {
    const t = name.trim().toLowerCase();
    if (!t || LASTFM_BLOCKLIST.has(t) || lastfmIsDecade(t)) continue;
    if (count !== undefined && count < LASTFM_MIN_COUNT) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= LASTFM_MAX_TAGS) break;
  }
  return out;
}

async function lastfmArtistTags(artist) {
  const params = new URLSearchParams({
    method: "artist.gettoptags", artist, api_key: LASTFM_API_KEY,
    format: "json", autocorrect: "1",
  });
  try {
    const r = await fetch(LASTFM_API + "?" + params);
    if (!r.ok) return [];
    const data = await r.json();
    return lastfmFilterTags((data.toptags || {}).tag || []);
  } catch { return []; }
}

async function lastfmPool(items, fn, concurrency, onBatch) {
  let done = 0;
  const total = items.length;
  let i = 0;
  async function worker() {
    while (i < total) {
      const idx = i++;
      await fn(items[idx]);
      done++;
      if (done % (concurrency * 4) === 0 && onBatch) onBatch(done, total);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, total); w++) workers.push(worker());
  await Promise.all(workers);
  if (onBatch) onBatch(done, total);
}
