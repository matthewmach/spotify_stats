/* Spotify Listening Stats — vanilla JS, no dependencies.
   Aggregates a per-play stream on the fly for any date window. */

const MS_H = 3_600_000;
// DAY_MS, trackIdFromUri, buildDataset (async, chunked) live in shared-build.js
const DATAKEY = { artists: "artists", albums: "albums", songs: "tracks" };

const state = {
  tab: "overview",
  window: null,                 // {start, end} inclusive day indices
  sort: { artists: { key: "plays", dir: -1 }, albums: { key: "plays", dir: -1 }, songs: { key: "plays", dir: -1 } },
  search: { artists: "", albums: "", songs: "" },
  page: { artists: 0, albums: 0, songs: 0 },
  pageSize: 100,                // number, or "all"
  tzOffset: -Math.round(new Date().getTimezoneOffset() / 60),  // hours to add to UTC (auto: local)
};
const TZ_LIST = Array.from({ length: 27 }, (_, i) => i - 12);   // UTC-12 … UTC+14
const tzLabel = (o) => (o === 0 ? "UTC" : "UTC" + (o > 0 ? "+" : "") + o);
// Common abbreviations per offset. Many show both standard + daylight names
// because the same offset means different zones depending on the time of year.
const TZ_NAMES = {
  "-10": "HST", "-9": "AKST", "-8": "PST / AKDT", "-7": "MST / PDT",
  "-6": "CST / MDT", "-5": "EST / CDT", "-4": "EDT / AST", "-3": "BRT / ADT",
  "0": "GMT", "1": "CET / BST", "2": "EET / CEST", "3": "MSK / EEST",
  "4": "GST", "5": "PKT", "7": "ICT", "8": "CST·CN / AWST", "9": "JST / KST",
  "10": "AEST", "11": "AEDT", "12": "NZST", "13": "NZDT",
};

let DATA, P, NP, AI, BI;        // raw + precomputed
let DAY_MONTH, DAY_WEEKDAY, DAY_DATE, ARTIST_FIRST;
let BASE_MS, N_DAYS;
let AGG = null, AGG_KEY = "";
const lastRendered = {};        // tab -> sorted row array currently shown

/* ---------- formatting ---------- */
const nf = new Intl.NumberFormat("en-US");
const fmtInt = (n) => nf.format(Math.round(n || 0));
const fmtHours = (ms) => {
  const h = (ms || 0) / MS_H;
  if (h >= 10) return fmtInt(h) + "h";
  if (h >= 1) return h.toFixed(1) + "h";
  return Math.round((ms || 0) / 60000) + "m";
};
const fmtPct = (x) => (x == null || isNaN(x) ? "—" : (x * 100).toFixed(1) + "%");
const minPer = (ms, plays) => (plays ? ms / plays / 60000 : 0);
const dDate = (d) => (d == null || d < 0 ? "—" : DAY_DATE[d]);

/* ---------- boot ---------- */
// docs/ (the GitHub Pages copy) sets <meta name="build" content="pages">; the
// local web/ copy does not. This drives the mode badge and skips the data.json
// fetch on Pages (there is none there).
const BUILD_PAGES = ((document.querySelector('meta[name="build"]') || {}).content) === "pages";
let DATA_SOURCE = "";  // 'local' | 'cache' | 'upload'

document.addEventListener("DOMContentLoaded", startup);

function updateBadge() {
  const b = document.getElementById("modeBadge");
  let label, cls, tip;
  if (BUILD_PAGES) { label = "Pages"; cls = "badge-pages"; tip = "Hosted build — your files are read in your browser, nothing is uploaded."; }
  else if (DATA_SOURCE === "local") { label = "Local"; cls = "badge-local"; tip = "Local build — loaded from data/data.json (cover art available)."; }
  else { label = "Browser"; cls = "badge-browser"; tip = "Loaded from files you picked in this browser."; }
  b.textContent = label; b.className = "badge " + cls; b.title = tip; b.hidden = false;
}

function precompute() {
  const pl = DATA.plays;
  NP = pl.t.length;
  P = {
    t: Int32Array.from(pl.t), ms: Float64Array.from(pl.ms),
    d: Int32Array.from(pl.d), h: Uint8Array.from(pl.h), f: Uint8Array.from(pl.f),
  };
  const nT = DATA.tracks.length;
  AI = new Int32Array(nT); BI = new Int32Array(nT);
  for (let i = 0; i < nT; i++) { AI[i] = DATA.tracks[i].ai; BI[i] = DATA.tracks[i].bi; }

  N_DAYS = DATA.nDays;
  BASE_MS = Date.parse(DATA.dayBase + "T00:00:00Z");
  DAY_MONTH = new Array(N_DAYS); DAY_WEEKDAY = new Uint8Array(N_DAYS); DAY_DATE = new Array(N_DAYS);
  for (let d = 0; d < N_DAYS; d++) {
    const dt = new Date(BASE_MS + d * DAY_MS);
    const iso = dt.toISOString().slice(0, 10);
    DAY_DATE[d] = iso;
    DAY_MONTH[d] = iso.slice(0, 7);
    DAY_WEEKDAY[d] = (dt.getUTCDay() + 6) % 7;     // Mon=0
  }
  ARTIST_FIRST = new Int32Array(DATA.artists.length).fill(2e9);
  for (let i = 0; i < NP; i++) {
    const ai = AI[P.t[i]], d = P.d[i];
    if (d < ARTIST_FIRST[ai]) ARTIST_FIRST[ai] = d;
  }
}

let pendingEnrich = false;   // set when we just returned from a Spotify sign-in

async function startup() {
  wireOnce();
  // If we just came back from Spotify, exchange the code for a token first.
  try { pendingEnrich = await spotifyHandleRedirect(); }
  catch (e) { setTimeout(() => enrichError(e.message), 400); }
  // Local build: prefer the freshly-built data.json (Pages has none, so skip).
  if (!BUILD_PAGES) {
    try {
      const r = await fetch("../data/data.json", { cache: "no-store" });
      if (r.ok) { DATA_SOURCE = "local"; return onDataReady(await r.json()); }
    } catch (e) {}
  }
  // Otherwise reuse a previous in-browser upload (returning Pages visitor).
  try { const cached = await idbGet("dataset"); if (cached) { DATA_SOURCE = "cache"; return onDataReady(cached); } } catch (e) {}
  // Nothing yet — ask the user for their files.
  showUploader();
}

function showUploader(msg) {
  document.getElementById("loading").hidden = true;
  document.getElementById("filterbar").hidden = true;
  document.getElementById("changeFiles").hidden = true;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  document.getElementById("uploader").hidden = false;
  document.getElementById("connectSpotify").hidden = true;
  document.getElementById("processing").hidden = true;     // back to the idle prompt
  document.getElementById("dropzone").hidden = false;
  const help = document.querySelector(".up-help"); if (help) help.hidden = false;
  // file:// can't persist (no IndexedDB / no fetch) — warn so the box won't keep returning
  document.getElementById("fileWarn").hidden = location.protocol !== "file:";
  const st = document.getElementById("upStatus");
  if (msg) { st.hidden = false; st.className = "up-status err"; st.textContent = msg; }
  else { st.hidden = true; st.textContent = ""; }
}

let CHROME_WIRED = false;
function wireOnce() {
  if (CHROME_WIRED) return; CHROME_WIRED = true;

  document.getElementById("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab);
  });
  document.querySelectorAll("input[data-search]").forEach((inp) => {
    inp.addEventListener("input", () => {
      state.search[inp.dataset.search] = inp.value.toLowerCase().trim();
      state.page[inp.dataset.search] = 0;
      renderTable(inp.dataset.search);
    });
  });

  // page size + pager (delegated; controls live inside the table views)
  document.addEventListener("change", (e) => {
    if (e.target.classList.contains("pageSize")) {
      state.pageSize = e.target.value === "all" ? "all" : +e.target.value;
      for (const k in state.page) state.page[k] = 0;
      renderTable(state.tab);
    } else if (e.target.classList.contains("pageJump")) {
      const tab = e.target.closest("[data-pager]").dataset.pager;
      state.page[tab] = (+e.target.value || 1) - 1;
      renderTable(tab);
    }
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pg]");
    if (!b) return;
    const tab = b.closest("[data-pager]").dataset.pager;
    const total = (lastRendered[tab] || []).length;
    const ps = state.pageSize === "all" ? Math.max(1, total) : state.pageSize;
    const pages = Math.max(1, Math.ceil(total / ps));
    let p = state.page[tab] || 0;
    const act = b.dataset.pg;
    if (act === "first") p = 0;
    else if (act === "prev") p--;
    else if (act === "next") p++;
    else if (act === "last") p = pages - 1;
    state.page[tab] = Math.max(0, Math.min(pages - 1, p));
    renderTable(tab);
  });
  document.querySelectorAll("table[data-table]").forEach((tbl) => {
    tbl.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-key]");
      if (th) return onSort(tbl.dataset.table, th.dataset.key);
      const tr = e.target.closest("tr[data-pos]");
      if (tr) openDrawer(tbl.dataset.table, +tr.dataset.pos);
    });
  });

  // date range inputs (read N_DAYS live)
  const fromI = document.getElementById("fromDate"), toI = document.getElementById("toDate");
  const onDate = () => {
    const s = fromI.value ? dayIndexOf(fromI.value) : 0;
    const e = toI.value ? dayIndexOf(toI.value) : N_DAYS - 1;
    setWindow(Math.min(s, e), Math.max(s, e), null);
  };
  fromI.addEventListener("change", onDate);
  toI.addEventListener("change", onDate);

  // year chips (delegated)
  document.getElementById("yearChips").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.range === "all") setWindow(0, N_DAYS - 1, "all");
    else if (b.dataset.year) { const y = b.dataset.year; setWindow(dayIndexOf(`${y}-01-01`), dayIndexOf(`${y}-12-31`), y); }
  });
  // preset menu
  const pbtn = document.getElementById("presetMenuBtn"), pmenu = document.getElementById("presetMenu");
  pbtn.addEventListener("click", () => { pmenu.hidden = !pmenu.hidden; });
  document.addEventListener("click", (e) => { if (!e.target.closest(".rangepick")) pmenu.hidden = true; });
  pmenu.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    pmenu.hidden = true;
    if (b.dataset.n === "") return setWindow(0, N_DAYS - 1, "all");
    const n = +b.dataset.n, end = N_DAYS - 1; setWindow(Math.max(0, end - n + 1), end, null);
  });

  // drawer
  document.getElementById("drawer").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || e.target.id === "drawer") closeDrawer();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  // chart hover tooltips (delegated; data-tip lives on .hoverband rects)
  const tip = document.getElementById("chartTip");
  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest ? e.target.closest("[data-tl]") : null;
    if (el) {
      tip.innerHTML = `<span class="tl">${esc(el.getAttribute("data-tl"))}</span> <b>${esc(el.getAttribute("data-tv"))}</b>`;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      let x = e.clientX + 14, y = e.clientY + 14;
      if (x + r.width > window.innerWidth) x = e.clientX - r.width - 14;
      if (y + r.height > window.innerHeight) y = e.clientY - r.height - 14;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    } else if (!tip.hidden) {
      tip.hidden = true;
    }
  });

  // listening-clock time zone (delegated; #tzSelect is re-rendered each time)
  document.getElementById("view-overview").addEventListener("change", (e) => {
    if (e.target.id === "tzSelect") { state.tzOffset = +e.target.value; renderOverview(); }
  });

  // spotify connect / enrich
  document.getElementById("connectSpotify").addEventListener("click", connectSpotify);

  // change-files + clear cache + uploader
  document.getElementById("changeFiles").addEventListener("click", () => showUploader());
  document.getElementById("clearData").addEventListener("click", async () => {
    try {
      const db = await idbOpen();
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").clear();
    } catch {}
    sessionStorage.clear();
    location.reload();
  });
  const input = document.getElementById("fileInput"), dz = document.getElementById("dropzone");
  input.addEventListener("change", () => handleFiles([...input.files]));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => f.name.toLowerCase().endsWith(".json"));
    handleFiles(files);
  });
}

function onDataReady(data) {
  DATA = data;
  precompute();
  buildYearChips();
  buildPresetMenu();
  document.getElementById("loading").hidden = true;
  document.getElementById("uploader").hidden = true;
  document.getElementById("filterbar").hidden = false;
  document.getElementById("changeFiles").hidden = false;
  document.getElementById("clearData").hidden = !BUILD_PAGES;
  const fromI = document.getElementById("fromDate"), toI = document.getElementById("toDate");
  fromI.min = toI.min = DAY_DATE[0]; fromI.max = toI.max = DAY_DATE[N_DAYS - 1];
  updateBadge();
  AGG = null; AGG_KEY = "";
  setWindow(0, N_DAYS - 1, "all");
  setTab(state.tab || "overview");
  updateConnectButton();
  if (pendingEnrich) { pendingEnrich = false; runEnrichment(); }
  setTimeout(loadGenresBackground, 0);
}

/* ---------- Spotify enrichment (in-browser, via spotify.js) ---------- */
function updateConnectButton() {
  const btn = document.getElementById("connectSpotify");
  btn.hidden = !DATA || !!DATA.enriched;   // only offer it when we have un-enriched data
}
async function connectSpotify() {
  if (!DATA) return;
  if (spotifyConnected()) return runEnrichment();
  document.getElementById("connectSpotify").classList.add("busy");
  try { await spotifyLogin(); }            // redirects away to Spotify
  catch (e) { enrichError(e.message); }
}
async function runEnrichment() {
  if (!DATA || DATA.enriched) return;
  const bar = document.getElementById("enrichbar");
  const txt = document.getElementById("enrichText");
  const fill = document.getElementById("enrichBar");
  document.getElementById("connectSpotify").classList.add("busy");
  bar.hidden = false; txt.textContent = "Connecting to Spotify…"; fill.style.width = "2%";
  try {
    await spotifyEnrich(DATA, (td, tt, ad, at, doRender) => {
      txt.textContent = `Cover art ${td.toLocaleString()} / ${tt.toLocaleString()} · artists ${ad.toLocaleString()} / ${at.toLocaleString()}`;
      fill.style.width = Math.max(2, (td / tt) * 100) + "%";
      if (doRender) { AGG = null; AGG_KEY = ""; render(); }   // progressive: show art/genres as they arrive
    });
    idbSet("dataset", DATA).catch(() => {});   // persist enriched data
    AGG = null; AGG_KEY = "";                   // final rebuild
    render();
    updateConnectButton();
    txt.textContent = "Done — cover art added ✓"; fill.style.width = "100%";
    setTimeout(() => { bar.hidden = true; }, 1800);
  } catch (e) {
    enrichError(e.message);
  } finally {
    document.getElementById("connectSpotify").classList.remove("busy");
  }
}
function enrichError(msg) {
  const bar = document.getElementById("enrichbar"), txt = document.getElementById("enrichText");
  bar.hidden = false; txt.textContent = "Spotify: " + msg; document.getElementById("enrichBar").style.width = "0%";
  document.getElementById("connectSpotify").classList.remove("busy");
  setTimeout(() => { bar.hidden = true; }, 7000);
}

/* ---------- file loading + processing screen ---------- */
// Yield to the event loop so the DOM repaints. setTimeout (not rAF) — rAF is
// paused in background/offscreen tabs, which would hang processing.
const raf = () => new Promise((r) => setTimeout(r, 0));

function startProcessingUI() {
  document.getElementById("dropzone").hidden = true;
  document.getElementById("fileWarn").hidden = true;
  const help = document.querySelector(".up-help"); if (help) help.hidden = true;
  document.getElementById("upStatus").hidden = true;
  document.getElementById("processing").hidden = false;
  setProc("Reading your history…", 4, "");
}
function setProc(stage, pct, sub) {
  document.getElementById("procStage").textContent = stage;
  document.getElementById("procBar").style.width = Math.max(0, Math.min(100, pct)) + "%";
  document.getElementById("procSub").textContent = sub || "";
}
function failProcessing(msg) {
  document.getElementById("processing").hidden = true;
  document.getElementById("dropzone").hidden = false;
  const help = document.querySelector(".up-help"); if (help) help.hidden = false;
  document.getElementById("fileWarn").hidden = location.protocol !== "file:";
  const st = document.getElementById("upStatus");
  st.hidden = false; st.className = "up-status err"; st.textContent = msg;
}

// Read + parse + aggregate on the main thread, chunked with yields so the UI
// stays responsive and shows progress. (A Web Worker was tried but doubled
// memory on large exports and could hang; chunking is simpler and reliable.)
async function handleFiles(files) {
  if (!files || !files.length) return;
  startProcessingUI();
  await raf();
  try {
    // 1) read + parse each file
    const records = [];
    for (let i = 0; i < files.length; i++) {
      let json;
      try { json = JSON.parse(await files[i].text()); } catch (e) { continue; }
      if (Array.isArray(json)) for (const r of json) if (r && (r.ms_played != null || r.ts)) records.push(r);
      setProc("Reading your history…", 4 + ((i + 1) / files.length) * 34,
        `${i + 1} / ${files.length} files · ${records.length.toLocaleString()} plays`);
      await raf();
    }
    if (!records.length)
      return failProcessing("No streaming-history records found. Select your Streaming_History_Audio_*.json files.");

    // 2) aggregate (chunked, reports progress)
    const data = await buildDataset(records, (done, total) =>
      setProc("Aggregating plays…", 40 + (done / total) * 52, `${done.toLocaleString()} / ${total.toLocaleString()} plays`));

    // 3) show the stats immediately, then cache in the background so a slow
    //    IndexedDB write can never keep the spinner/upload screen up.
    setProc("Building views…", 96, `${data.totals.plays.toLocaleString()} plays`);
    await raf();
    DATA_SOURCE = "upload";
    onDataReady(data);
    idbSet("dataset", data).catch(() => {});
  } catch (e) {
    failProcessing("Could not read those files: " + (e.message || e));
  }
}

/* ---------- IndexedDB cache ---------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("spotifyStats", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readonly").objectStore("kv").get(key);
    t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
    t.onsuccess = () => res(); t.onerror = () => rej(t.error);
  });
}

/* ---------- day helpers ---------- */
function dayIndexOf(iso) {
  const d = Math.round((Date.parse(iso + "T00:00:00Z") - BASE_MS) / DAY_MS);
  return Math.max(0, Math.min(N_DAYS - 1, d));
}

/* ---------- filter bar ---------- */
function yearsList() {
  const y0 = +DAY_DATE[0].slice(0, 4), y1 = +DAY_DATE[N_DAYS - 1].slice(0, 4);
  const out = []; for (let y = y0; y <= y1; y++) out.push(y); return out;
}
function buildYearChips() {
  const wrap = document.getElementById("yearChips");
  const chips = [`<button class="chip" data-range="all">All time</button>`]
    .concat(yearsList().map((y) => `<button class="chip" data-year="${y}">${y}</button>`));
  wrap.innerHTML = chips.join("");
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.range === "all") setWindow(0, N_DAYS - 1, "all");
    else if (b.dataset.year) {
      const y = b.dataset.year;
      setWindow(dayIndexOf(`${y}-01-01`), dayIndexOf(`${y}-12-31`), y);
    }
  });
}
function buildPresetMenu() {
  const menu = document.getElementById("presetMenu");
  const presets = [
    ["Last 30 days", 30], ["Last 90 days", 90], ["Last 6 months", 182],
    ["Last 12 months", 365], ["All time", null],
  ];
  menu.innerHTML = presets.map((p, i) => `<button data-n="${p[1] == null ? "" : p[1]}">${p[0]}</button>`).join("");
}

function setWindow(start, end, presetLabel) {
  state.window = { start, end };
  // sync chips
  document.querySelectorAll("#yearChips button").forEach((b) =>
    b.classList.toggle("active", !!(
      (presetLabel === "all" && b.dataset.range === "all") ||
      (b.dataset.year && b.dataset.year === presetLabel))));
  // sync date inputs
  document.getElementById("fromDate").value = DAY_DATE[start];
  document.getElementById("toDate").value = DAY_DATE[end];
  for (const k in state.page) state.page[k] = 0;   // new data → back to page 1
  AGG = null;                  // force recompute
  render();
}

/* ---------- aggregation ---------- */
function ensureAgg() {
  const key = state.window.start + "-" + state.window.end;
  if (AGG && AGG_KEY === key) return AGG;
  AGG = aggregate(state.window.start, state.window.end);
  AGG_KEY = key;
  return AGG;
}

function aggregate(start, end) {
  const nA = DATA.artists.length, nB = DATA.albums.length, nT = DATA.tracks.length;
  const mk = (n) => ({
    plays: new Int32Array(n), ms: new Float64Array(n), streams: new Int32Array(n),
    done: new Int32Array(n), skip: new Int32Array(n), shuf: new Int32Array(n),
    days: new Int32Array(n), first: new Int32Array(n).fill(-1), last: new Int32Array(n).fill(-1),
    seen: new Int32Array(n).fill(-1),
  });
  const A = mk(nA), B = mk(nB), T = mk(nT);
  const streamMs = DATA.streamMs;
  let totPlays = 0, totMs = 0, totStr = 0, totSkip = 0, totDone = 0, activeDays = 0, lastDay = -1;
  const monthly = {}, byHour = new Array(24).fill(0), byWeekday = new Array(7).fill(0);

  for (let i = 0; i < NP; i++) {
    const d = P.d[i];
    if (d < start || d > end) continue;
    const ti = P.t[i], ms = P.ms[i], f = P.f[i];
    const ai = AI[ti], bi = BI[ti];
    const isStr = ms >= streamMs ? 1 : 0;
    const sk = f & 1 ? 1 : 0, dn = f & 2 ? 1 : 0, sf = f & 4 ? 1 : 0;
    accum(T, ti, d, ms, isStr, dn, sk, sf);
    accum(A, ai, d, ms, isStr, dn, sk, sf);
    accum(B, bi, d, ms, isStr, dn, sk, sf);
    totPlays++; totMs += ms; totStr += isStr; totSkip += sk; totDone += dn;
    if (d !== lastDay) { activeDays++; lastDay = d; }
    const mo = DAY_MONTH[d];
    (monthly[mo] || (monthly[mo] = { plays: 0, ms: 0 })).plays++;
    monthly[mo].ms += ms;
    byHour[P.h[i]]++; byWeekday[DAY_WEEKDAY[d]]++;
  }

  // distinct tracks per artist/album within window
  const aTracks = new Int32Array(nA), bTracks = new Int32Array(nB);
  for (let ti = 0; ti < nT; ti++) if (T.plays[ti] > 0) { aTracks[AI[ti]]++; bTracks[BI[ti]]++; }

  const buildRows = (meta, S, extra) => {
    const rows = [];
    for (let i = 0; i < meta.length; i++) {
      if (S.plays[i] === 0) continue;
      const m = meta[i];
      const row = {
        idx: i, name: m.name, artist: m.artist, album: m.album, id: m.id,
        img: m.img, genres: m.genres, popularity: m.popularity, duration_ms: m.duration_ms,
        followers: m.followers, ai: m.ai, bi: m.bi,
        plays: S.plays[i], ms: S.ms[i], streams: S.streams[i],
        completed: S.done[i], skipped: S.skip[i], shuffle: S.shuf[i],
        days: S.days[i], first: S.first[i], last: S.last[i],
      };
      if (extra) extra(row, i);
      rows.push(row);
    }
    return rows;
  };

  const artists = buildRows(DATA.artists, A, (r, i) => (r.tracks = aTracks[i]));
  const albums = buildRows(DATA.albums, B, (r, i) => (r.tracks = bTracks[i]));
  const tracks = buildRows(DATA.tracks, T, null);

  // discovery: artists first heard within window, by month
  const discovery = {};
  for (let ai = 0; ai < nA; ai++) {
    const fd = ARTIST_FIRST[ai];
    if (fd >= start && fd <= end) {
      const mo = DAY_MONTH[fd]; discovery[mo] = (discovery[mo] || 0) + 1;
    }
  }

  return {
    totals: {
      plays: totPlays, ms: totMs, streams: totStr, skipped: totSkip, completed: totDone,
      artists: artists.length, albums: albums.length, tracks: tracks.length, days: activeDays,
    },
    artists, albums, tracks, monthly, byHour, byWeekday, discovery,
  };
}
function accum(S, i, d, ms, isStr, dn, sk, sf) {
  S.plays[i]++; S.ms[i] += ms; S.streams[i] += isStr; S.done[i] += dn; S.skip[i] += sk; S.shuf[i] += sf;
  if (S.first[i] < 0) S.first[i] = d;
  S.last[i] = d;
  if (S.seen[i] !== d) { S.days[i]++; S.seen[i] = d; }
}

/* ---------- nav ---------- */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + tab));
  render();
}
function render() {
  const a = ensureAgg();
  const w = state.window;
  document.getElementById("rangeLabel").textContent =
    `${DAY_DATE[w.start]} → ${DAY_DATE[w.end]} · ${fmtInt(a.totals.plays)} plays`;
  document.getElementById("rangeNote").textContent =
    `${fmtInt(a.totals.plays)} plays · ${fmtInt(a.totals.ms / MS_H)} h · ${fmtInt(a.totals.artists)} artists`;
  if (state.tab === "overview") renderOverview();
  else if (state.tab === "genres") renderGenres();
  else renderTable(state.tab);
}

/* ---------- overview ---------- */
function popDesc(p) {
  if (p >= 70) return "very mainstream";
  if (p >= 55) return "mainstream";
  if (p >= 40) return "balanced";
  if (p >= 25) return "fairly niche";
  return "deep cuts";
}
function renderOverview() {
  const a = ensureAgg(), t = a.totals, el = document.getElementById("view-overview");
  const hours = t.ms / MS_H;
  const cards = [
    ["Hours listened", fmtInt(hours), `${(hours / (t.days || 1)).toFixed(1)} h/active day`],
    ["Total plays", fmtInt(t.plays), `${fmtInt(t.streams)} streams (30s+)`],
    ["Active days", fmtInt(t.days), `${(t.plays / (t.days || 1)).toFixed(0)} plays/day`],
    ["Artists", fmtInt(t.artists), `${fmtInt(t.albums)} albums`],
    ["Tracks", fmtInt(t.tracks), `${fmtPct(t.skipped / t.plays)} skipped`],
    ["Avg play", minPer(t.ms, t.plays).toFixed(1) + "m", `${fmtPct(t.completed / t.plays)} completed`],
  ];
  // Taste popularity: play-weighted average Spotify track popularity (0–100),
  // i.e. sum(popularity × plays) / sum(plays) over enriched tracks.
  if (DATA.enriched) {
    let popSum = 0, popW = 0;
    for (const tr of a.tracks) if (tr.popularity != null) { popSum += tr.popularity * tr.plays; popW += tr.plays; }
    if (popW) {
      const score = popSum / popW;
      cards.push(["Taste popularity", Math.round(score) + "/100", `${popDesc(score)} · play-weighted`]);
    }
  }
  const months = Object.keys(a.monthly).sort();
  const monthHours = months.map((m) => a.monthly[m].ms / MS_H);
  const newA = months.map((m) => a.discovery[m] || 0);
  // shift UTC hour buckets into the selected time zone
  const clockHours = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) clockHours[((h + state.tzOffset) % 24 + 24) % 24] += a.byHour[h];

  el.innerHTML = `
    <div class="cards">
      ${cards.map((c) => `<div class="card"><div class="val">${c[1]}</div><div class="lbl">${c[0]}</div><div class="sub2">${c[2]}</div></div>`).join("")}
    </div>
    <div class="grid-full">
      <div class="panel"><h3>Listening over time</h3><div class="hint">Hours per month</div>${lineChart(months, monthHours, { w: 1180, fmtVal: (v) => fmtInt(v) + " h" })}</div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Top artists</h3><div class="hint">by plays in range</div>${topList(a.artists, "artist")}</div>
      <div class="panel"><h3>Top tracks</h3><div class="hint">by plays in range</div>${topList(a.tracks, "track")}</div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Top albums</h3><div class="hint">by plays in range</div>${topList(a.albums, "album")}</div>
      <div class="panel"><h3>Let it finish</h3><div class="hint">Tracks you completed most often</div>${topList([...a.tracks].sort((x, y) => y.completed - x.completed), "track", (r) => fmtInt(r.completed) + " ✓")}</div>
    </div>
    <div class="grid-full">
      <div class="panel"><h3>New artists discovered</h3><div class="hint">First time you heard each artist, per month</div>${barChart(months, newA, { w: 1180, every: Math.max(1, Math.ceil(months.length / 12)) })}</div>
    </div>
    <div class="grid2">
      <div class="panel">
        <div class="panelhead"><h3>Listening clock</h3>
          <select id="tzSelect" class="mini" title="Time zone">${TZ_LIST.map((o) => `<option value="${o}"${o === state.tzOffset ? " selected" : ""}>${tzLabel(o)}${TZ_NAMES[o] ? " · " + TZ_NAMES[o] : ""}</option>`).join("")}</select>
        </div>
        <div class="hint">Plays by hour of day · ${tzLabel(state.tzOffset)}</div>${barChart(HOURS, clockHours, { every: 3, suffix: "h" })}
      </div>
      <div class="panel"><h3>By weekday</h3><div class="hint">Plays per day of week</div>${barChart(WEEKDAYS, a.byWeekday, {})}</div>
    </div>`;
}

function topList(items, kind, valFn) {
  const rows = [...items].sort((a, b) => b.plays - a.plays).slice(0, 10);
  if (!rows.length) return `<div class="empty">No plays in this range.</div>`;
  return `<ul class="toplist">${rows.map((r, i) => {
    const img = r.img ? `<img class="thumb ${kind === "artist" ? "round" : ""}" loading="lazy" src="${r.img}">` : "";
    const sub = (kind === "track" || kind === "album") ? `<small>${esc(r.artist)}</small>` : "";
    return `<li><span class="rank">${i + 1}</span>${img}<span class="nm">${esc(r.name)} ${sub}</span><span class="v">${valFn ? valFn(r) : fmtInt(r.plays)}</span></li>`;
  }).join("")}</ul>`;
}

/* ---------- tables ---------- */
function baseCols(kind) {
  const cols = [
    { key: "_rank", label: "#", txt: true, rank: true },
    { key: "name", label: kind === "artist" ? "Artist" : kind === "album" ? "Album" : "Song", txt: true, main: true },
    { key: "plays", label: "Plays", get: (r) => r.plays, fmt: fmtInt, bar: true },
    { key: "streams", label: "Streams", get: (r) => r.streams, fmt: fmtInt },
    { key: "ms", label: "Hours", get: (r) => r.ms, fmt: fmtHours },
    { key: "avg", label: "Avg/play", get: (r) => minPer(r.ms, r.plays), fmt: (v) => v.toFixed(1) + "m" },
    { key: "share", label: "% plays", get: (r) => r.plays, fmt: (v, ctx) => fmtPct(ctx.total ? v / ctx.total : 0) },
    { key: "skip", label: "Skip %", get: (r) => r.skipped / r.plays, fmt: fmtPct },
    { key: "compl", label: "Compl %", get: (r) => r.completed / r.plays, fmt: fmtPct },
  ];
  if (kind !== "song") cols.push({ key: "tracks", label: "Tracks", get: (r) => r.tracks, fmt: fmtInt });
  if (kind === "song" && DATA.enriched) cols.push({ key: "pop", label: "Popularity", get: (r) => r.popularity, fmt: (v) => (v == null ? "—" : v) });
  cols.push({ key: "days", label: "Days", get: (r) => r.days, fmt: fmtInt });
  cols.push({ key: "last", label: "Last played", get: (r) => r.last, fmt: dDate, txt: true });
  return cols;
}
function onSort(tab, key) {
  const s = state.sort[tab];
  if (s.key === key) s.dir *= -1;
  else { s.key = key; s.dir = key === "name" ? 1 : -1; }
  state.page[tab] = 0;
  renderTable(tab);
}
function renderTable(tab) {
  const a = ensureAgg();
  const tbl = document.querySelector(`table[data-table="${tab}"]`);
  const kind = tab === "artists" ? "artist" : tab === "albums" ? "album" : "song";
  const cols = baseCols(kind);
  const sort = state.sort[tab], q = state.search[tab];

  let rows = a[DATAKEY[tab]];
  if (q) rows = rows.filter((r) =>
    r.name.toLowerCase().includes(q) ||
    (r.artist && r.artist.toLowerCase().includes(q)) ||
    (r.album && r.album.toLowerCase().includes(q)));
  const ctx = { total: a.totals.plays };

  const col = cols.find((c) => c.key === sort.key) || cols[2];
  const getv = col.get || ((r) => r[col.key]);
  const decorated = rows.map((r, i) => ({ r, v: col.rank ? i : getv(r, ctx) }));
  decorated.sort((x, y) => {
    let p = x.v, q2 = y.v;
    if (typeof p === "string" || typeof q2 === "string") { p = p || ""; q2 = q2 || ""; return p < q2 ? -sort.dir : p > q2 ? sort.dir : 0; }
    return ((p || 0) - (q2 || 0)) * sort.dir;
  });
  const sorted = decorated.map((o) => o.r);
  lastRendered[tab] = sorted;
  const total = sorted.length;
  const maxPlays = sorted.reduce((m, r) => (r.plays > m ? r.plays : m), 1);

  // pagination
  const ps = state.pageSize === "all" ? Math.max(1, total) : state.pageSize;
  const pages = Math.max(1, Math.ceil(total / ps));
  const page = Math.max(0, Math.min(state.page[tab] || 0, pages - 1));
  state.page[tab] = page;
  const start = page * ps;
  const shown = sorted.slice(start, start + ps);

  const thead = `<thead><tr>${cols.map((c) => {
    const on = c.key === sort.key;
    return `<th data-key="${c.key}" class="${c.txt ? "txtcol" : ""} ${on ? "sorted" : ""}">${c.label} ${on ? `<span class="arrow">${sort.dir < 0 ? "▼" : "▲"}</span>` : ""}</th>`;
  }).join("")}</tr></thead>`;

  const tbody = `<tbody>${shown.map((r, i) => `<tr data-pos="${start + i}">${cols.map((c) => {
    if (c.rank) return `<td class="txtcol rankcell">${fmtInt(start + i + 1)}</td>`;
    if (c.main) {
      const img = r.img ? `<img class="thumb ${tab === "artists" ? "round" : ""}" loading="lazy" src="${r.img}">` : "";
      const t2 = tab === "songs" ? `<div class="t2">${esc(r.artist)} · ${esc(r.album)}</div>`
        : tab === "albums" ? `<div class="t2">${esc(r.artist)}</div>` : "";
      return `<td class="txtcol"><div class="cellmain">${img}<div class="meta"><div class="t1">${esc(r.name)}</div>${t2}</div></div></td>`;
    }
    const v = (c.get || ((x) => x[c.key]))(r, ctx);
    const cell = c.fmt ? c.fmt(v, ctx) : v;
    if (c.bar) {
      const w = maxPlays ? (r.plays / maxPlays) * 100 : 0;
      return `<td class="barcell"><span class="fill" style="width:${w}%"></span><span>${cell}</span></td>`;
    }
    return `<td class="${c.txt ? "txtcol" : ""}">${cell}</td>`;
  }).join("")}</tr>`).join("")}</tbody>`;

  tbl.innerHTML = thead + tbody;
  document.querySelector(`[data-count="${tab}"]`).textContent =
    total ? `${fmtInt(start + 1)}–${fmtInt(start + shown.length)} of ${fmtInt(total)}` : "no matches";

  // sync the page-size selector + render the pager
  const view = document.getElementById("view-" + tab);
  const sizeSel = view.querySelector(".pageSize");
  if (sizeSel) sizeSel.value = String(state.pageSize);
  const pager = view.querySelector(`[data-pager="${tab}"]`);
  if (pager) {
    pager.innerHTML = pages <= 1 ? "" : `
      <button data-pg="first" ${page === 0 ? "disabled" : ""}>« First</button>
      <button data-pg="prev" ${page === 0 ? "disabled" : ""}>‹ Prev</button>
      <span class="pginfo">Page <input type="number" class="pageJump" min="1" max="${pages}" value="${page + 1}"> of ${fmtInt(pages)}</span>
      <button data-pg="next" ${page >= pages - 1 ? "disabled" : ""}>Next ›</button>
      <button data-pg="last" ${page >= pages - 1 ? "disabled" : ""}>Last »</button>`;
  }
}

/* ---------- genres (Last.fm, loaded separately in background) ---------- */
let GENRES = null;  // { artist_name: [tags], ... }
let GENRES_LOADED = false;

function genreProgress(text, pct, done) {
  const bar = document.getElementById("genrebar");
  const txt = document.getElementById("genreText");
  const fill = document.getElementById("genreBar");
  if (done) { txt.textContent = text; fill.style.width = "100%"; setTimeout(() => { bar.hidden = true; }, 1800); return; }
  bar.hidden = false; txt.textContent = text; fill.style.width = Math.max(2, pct) + "%";
}

function genreFor(artist) {
  if (!GENRES) return [];
  return GENRES[artist] || [];
}

async function loadGenresBackground() {
  // Load seed data from genres.json or IDB cache
  GENRES = {};
  const genreUrl = BUILD_PAGES ? "genres.json" : "../data/genres.json";
  try {
    genreProgress("Loading genres…", 50);
    const r = await fetch(genreUrl, { cache: "no-store" });
    if (r.ok) {
      GENRES = await r.json();
      if (GENRES.artists) GENRES = GENRES.artists;
    }
  } catch {}
  if (!Object.keys(GENRES).length) {
    try {
      const cached = await idbGet("genres");
      if (cached) { GENRES = cached; if (GENRES.artists) GENRES = GENRES.artists; }
    } catch {}
  }

  // Apply whatever we have so far
  if (Object.keys(GENRES).length) { applyGenres(); }

  // Fetch missing artists from Last.fm
  const missing = DATA.artists.filter((a) => !(a.name in GENRES)).sort((a, b) => (b.plays || 0) - (a.plays || 0));
  if (missing.length && typeof lastfmArtistTags === "function") {
    genreProgress(`Fetching ${missing.length.toLocaleString()} artists…`, 0);
    await lastfmPool(missing, async (a) => {
      const tags = await lastfmArtistTags(a.name);
      if (tags.length) GENRES[a.name] = tags;
    }, LASTFM_CONCURRENCY, (done, total) => {
      genreProgress(`Artists ${done.toLocaleString()} / ${total.toLocaleString()}`, (done / total) * 100);
      applyGenres();
    });
    idbSet("genres", GENRES).catch(() => {});
  }

  GENRES_LOADED = true;
  applyGenres();
  genreProgress(`Genres loaded — ${Object.keys(GENRES).length.toLocaleString()} artists ✓`, 100, true);
}

function applyGenres() {
  if (!GENRES || !DATA) return;
  for (const a of DATA.artists) a.genres = genreFor(a.name);
  for (const al of DATA.albums) al.genres = genreFor(al.artist);
  for (const t of DATA.tracks) t.genres = genreFor(t.artist);
  AGG = null; AGG_KEY = "";
  if (state.tab === "genres") renderGenres();
}

function renderGenres() {
  const el = document.getElementById("view-genres");
  if (!GENRES_LOADED) {
    el.innerHTML = `<div class="panel"><h3>Genres</h3>
      <p class="muted">Loading genres in the background…</p>
      <p class="muted">Genres come from Last.fm. Run <code>python genres.py</code> locally for instant loading,
      or wait a moment for them to load from the API.</p></div>`;
    return;
  }
  const a = ensureAgg();
  const gMs = {}, gPlays = {};
  for (const r of a.tracks) for (const g of (r.genres || [])) { gMs[g] = (gMs[g] || 0) + r.ms; gPlays[g] = (gPlays[g] || 0) + r.plays; }
  const top = Object.keys(gMs).sort((x, y) => gMs[y] - gMs[x]);
  if (!top.length) { el.innerHTML = `<div class="panel"><h3>Genres</h3><p class="muted">No genre data for this range.</p></div>`; return; }
  const exportBtn = GENRES ? `<button class="chip" id="exportGenres">⬇ Export genres.json</button>` : "";
  el.innerHTML = `<div class="panel"><div class="panelhead"><h3>Top genres</h3>${exportBtn}</div>
    <div class="hint">Hours listened in range, artist genres via Last.fm</div>
    ${hbarChart(top, top.map((g) => gMs[g] / MS_H), (v) => fmtInt(v) + "h")}</div>`;
  const btn = document.getElementById("exportGenres");
  if (btn) btn.addEventListener("click", exportGenresJson);
}

function exportGenresJson() {
  if (!GENRES) return;
  const blob = new Blob([JSON.stringify(GENRES)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "genres.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- drawer ---------- */
function openDrawer(tab, pos) {
  const r = (lastRendered[tab] || [])[pos];
  if (!r) return;
  const round = tab === "artists";
  const img = r.img ? `<img class="${round ? "round" : ""}" src="${r.img}">`
    : `<img class="${round ? "round" : ""}" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>">`;
  const sub = tab === "songs" ? `${esc(r.artist)} · ${esc(r.album)}`
    : tab === "albums" ? esc(r.artist) : `${fmtInt(r.tracks)} tracks`;
  const stats = [
    ["Plays", fmtInt(r.plays)], ["Streams (30s+)", fmtInt(r.streams)],
    ["Hours", fmtHours(r.ms)], ["Avg / play", minPer(r.ms, r.plays).toFixed(1) + "m"],
    ["Completed", `${fmtInt(r.completed)} (${fmtPct(r.completed / r.plays)})`],
    ["Skipped", `${fmtInt(r.skipped)} (${fmtPct(r.skipped / r.plays)})`],
    ["Distinct days", fmtInt(r.days)], ["Shuffle starts", fmtPct(r.shuffle / r.plays)],
  ];
  if (tab === "artists") {
    const uniqueSongs = new Set();
    for (let ti = 0; ti < DATA.tracks.length; ti++) if (AI[ti] === r.idx) uniqueSongs.add(DATA.tracks[ti].name);
    stats.push(["Unique songs", fmtInt(uniqueSongs.size)]);
  }
  if (tab === "songs" && r.popularity != null) stats.push(["Spotify popularity", r.popularity + "/100"]);
  if (r.followers != null) stats.push(["Followers", fmtInt(r.followers)]);

  // all-time yearly plays for this entity
  const pred = tab === "artists" ? (ti) => AI[ti] === r.idx
    : tab === "albums" ? (ti) => BI[ti] === r.idx : (ti) => ti === r.idx;
  const yb = yearBreakdown(pred);

  let related = "";
  const a = ensureAgg();
  if (tab === "artists") related = relatedList("Top tracks (in range)", a.tracks.filter((t) => t.ai === r.idx).sort((x, y) => y.plays - x.plays).slice(0, 8));
  else if (tab === "albums") related = relatedList("Tracks (in range)", a.tracks.filter((t) => t.bi === r.idx).sort((x, y) => y.plays - x.plays).slice(0, 12));

  const genreTags = genreFor(tab === "artists" ? r.name : r.artist);
  const genres = genreTags.length
    ? `<h4>Genres</h4><div>${genreTags.map((g) => `<span class="tag">${esc(g)}</span>`).join("")}</div>` : "";

  document.getElementById("drawerPanel").innerHTML = `
    <button class="closeBtn" data-close>✕</button>
    <div class="dhero">${img}<div><h2>${esc(r.name)}</h2><div class="dsub">${sub}</div>
      <div class="dsub">${dDate(r.first)} → ${dDate(r.last)} (in range)</div></div></div>
    <div class="dstats">${stats.map((s) => `<div class="dstat"><div class="v">${s[1]}</div><div class="l">${s[0]}</div></div>`).join("")}</div>
    ${genres}
    <h4>Plays by year (all time)</h4>${barChart(yb.years, yb.vals, {})}
    ${related}`;
  document.getElementById("drawer").hidden = false;
}
function yearBreakdown(pred) {
  const by = {};
  for (let i = 0; i < NP; i++) if (pred(P.t[i])) { const y = DAY_MONTH[P.d[i]].slice(0, 4); by[y] = (by[y] || 0) + 1; }
  const ys = yearsList().map(String);
  return { years: ys, vals: ys.map((y) => by[y] || 0) };
}
function relatedList(title, items) {
  if (!items.length) return "";
  return `<h4>${title}</h4><ul class="toplist">${items.map((t, i) =>
    `<li><span class="rank">${i + 1}</span><span class="nm">${esc(t.name)}</span><span class="v">${fmtInt(t.plays)} plays</span></li>`).join("")}</ul>`;
}
function closeDrawer() { document.getElementById("drawer").hidden = true; }

/* ---------- charts ---------- */
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Charts emit transparent "hoverband" rects (one per data point) carrying a
// data-tip; a single delegated handler shows an instant styled tooltip.
function barChart(labels, values, opts) {
  const W = opts.w || 600, H = 220, padB = 28, padL = 36, padT = 10;
  const n = values.length || 1, max = Math.max(1, ...values), bw = (W - padL) / n, every = opts.every || 1;
  const fmtVal = opts.fmtVal || ((v) => fmtInt(v));
  let bars = "", bands = "";
  values.forEach((v, i) => {
    const h = ((H - padB - padT) * v) / max, x = padL + i * bw, y = H - padB - h;
    bars += `<rect class="bar" x="${x + bw * 0.12}" y="${y}" width="${bw * 0.76}" height="${h}"/>`;
    bands += `<rect class="hoverband" x="${x}" y="${padT}" width="${bw}" height="${H - padB - padT}" data-tl="${esc(String(labels[i]))}" data-tv="${esc(fmtVal(v))}"/>`;
  });
  const xl = labels.map((l, i) => i % every === 0 ? `<text class="axislbl" x="${padL + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(String(l))}${opts.suffix || ""}</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}">${yAxis(max, padL, padT, H - padB, W)}${bars}${bands}${xl}</svg>`;
}
function lineChart(labels, values, opts = {}) {
  const W = opts.w || 600, H = 220, padB = 28, padL = 40, padT = 10, n = values.length;
  if (!n) return `<div class="empty">No data.</div>`;
  const max = Math.max(1, ...values), stepX = n > 1 ? (W - padL) / (n - 1) : 0;
  const px = (i) => padL + i * stepX, py = (v) => H - padB - ((H - padB - padT) * v) / max;
  const fmtVal = opts.fmtVal || ((v) => fmtInt(v));
  const pts = values.map((v, i) => `${px(i)},${py(v)}`).join(" ");
  const area = `${padL},${H - padB} ${pts} ${px(n - 1)},${H - padB}`;
  const every = Math.max(1, Math.ceil(n / 12));
  const xl = labels.map((l, i) => i % every === 0 ? `<text class="axislbl" x="${px(i)}" y="${H - 10}" text-anchor="middle">${esc(String(l))}</text>` : "").join("");
  const dots = values.map((v, i) => `<circle class="dot" cx="${px(i)}" cy="${py(v)}" r="2"/>`).join("");
  const bw = n > 1 ? stepX : (W - padL);
  const bands = values.map((v, i) => `<rect class="hoverband" x="${px(i) - bw / 2}" y="${padT}" width="${bw}" height="${H - padB - padT}" data-tl="${esc(String(labels[i]))}" data-tv="${esc(fmtVal(v))}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}">${yAxis(max, padL, padT, H - padB, W)}<polygon class="linearea" points="${area}"/><polyline class="linepath" points="${pts}"/>${dots}${bands}${xl}</svg>`;
}
function hbarChart(labels, values, fmt) {
  const rowH = 22, padL = 130, W = 600, H = labels.length * rowH + 10, max = Math.max(1, ...values);
  const rows = labels.map((l, i) => {
    const w = ((W - padL - 60) * values[i]) / max, y = i * rowH + 4;
    return `<text class="axislbl" x="${padL - 6}" y="${y + 12}" text-anchor="end" style="font-size:9px">${esc(l)}</text>
      <rect class="bar2" x="${padL}" y="${y}" width="${w}" height="${rowH - 6}" rx="3"/>
      <text class="axislbl" x="${padL + w + 5}" y="${y + 12}" style="font-size:9px">${fmt(values[i])}</text>
      <rect class="hoverband" x="0" y="${i * rowH}" width="${W}" height="${rowH}" data-tl="${esc(l)}" data-tv="${esc(fmt(values[i]))}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}">${rows}</svg>`;
}
function yAxis(max, padL, padT, bottom, W) {
  let out = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4, y = bottom - ((bottom - padT) * i) / 4;
    out += `<line class="gridline" x1="${padL}" y1="${y}" x2="${W}" y2="${y}"/><text class="axislbl" x="${padL - 6}" y="${y + 3}" text-anchor="end">${shortNum(v)}</text>`;
  }
  return out;
}
const shortNum = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : Math.round(v));

/* ---------- misc ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
