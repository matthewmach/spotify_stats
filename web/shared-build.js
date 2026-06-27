/* shared-build.js — browser-side aggregation (mirrors build.py). Loaded via
   <script> in index.html. Async + chunked so a large history doesn't freeze the
   page and progress can be reported. */

var DAY_MS = 86_400_000;

function trackIdFromUri(uri) {
  if (!uri) return null;
  var p = uri.split(":");
  return p.length === 3 && p[1] === "track" ? p[2] : null;
}

function _tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

// records -> the same object shape build.py writes to data.json.
// onProgress(done, total) is called periodically; we await between chunks so the
// UI repaints. Returns a Promise.
async function buildDataset(records, onProgress) {
  var SEP = String.fromCharCode(1); // unlikely to appear in names
  var artistIdx = new Map(), artists = [];
  var albumIdx = new Map(), albums = [];
  var trackIdx = new Map(), tracks = [];

  function getArtist(name) {
    var i = artistIdx.get(name);
    if (i === undefined) { i = artists.length; artistIdx.set(name, i); artists.push({ name: name }); }
    return i;
  }
  function getAlbum(artist, album) {
    var k = artist + SEP + album, i = albumIdx.get(k);
    if (i === undefined) { i = albums.length; albumIdx.set(k, i); albums.push({ name: album, artist: artist }); }
    return i;
  }
  function getTrack(tid, name, artist, album, ai, bi) {
    var i = trackIdx.get(tid);
    if (i === undefined) {
      i = tracks.length; trackIdx.set(tid, i);
      tracks.push({ id: tid.slice(0, 6) === "name::" ? null : tid, name: name, artist: artist, album: album, ai: ai, bi: bi });
    }
    return i;
  }

  var raw = [];
  var N = records.length;
  var CHUNK = 10000;
  for (var j = 0; j < N; j++) {
    var rec = records[j];
    var name = rec.master_metadata_track_name;
    if (name) {
      var ts = rec.ts;
      if (ts) {
        var artist = rec.master_metadata_album_artist_name || "Unknown Artist";
        var album = rec.master_metadata_album_album_name || "Unknown Album";
        var ms = rec.ms_played || 0;
        var ai = getArtist(artist), bi = getAlbum(artist, album);
        var tid = trackIdFromUri(rec.spotify_track_uri) || ("name::" + artist + "::" + name);
        var ti = getTrack(tid, name, artist, album, ai, bi);
        var f = 0;
        if (rec.skipped) f |= 1;
        if (rec.reason_end === "trackdone") f |= 2;
        if (rec.shuffle) f |= 4;
        raw.push([ts, ti, ms, f, +ts.slice(11, 13)]);
      }
    }
    if ((j % CHUNK) === CHUNK - 1) { if (onProgress) onProgress(j + 1, N); await _tick(); }
  }
  if (onProgress) onProgress(N, N);
  if (!raw.length) throw new Error("no music plays in those files");

  raw.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });

  var baseIso = raw[0][0].slice(0, 10);
  var baseMs = Date.parse(baseIso + "T00:00:00Z");
  var P_t = [], P_ms = [], P_d = [], P_h = [], P_f = [];
  var totMs = 0, totStr = 0, totSkip = 0;
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    var d = Math.round((Date.parse(r[0].slice(0, 10) + "T00:00:00Z") - baseMs) / DAY_MS);
    P_t.push(r[1]); P_ms.push(r[2]); P_d.push(d); P_h.push(r[4]); P_f.push(r[3]);
    totMs += r[2]; if (r[2] >= 30000) totStr++; if (r[3] & 1) totSkip++;
  }
  var nDays = P_d[P_d.length - 1] + 1;
  return {
    generated: new Date().toISOString(), streamMs: 30000, dayBase: baseIso, nDays: nDays,
    totals: {
      plays: raw.length, ms: totMs, streams: totStr, skipped: totSkip,
      artists: artists.length, albums: albums.length, tracks: tracks.length,
      first: raw[0][0], last: raw[raw.length - 1][0],
    },
    artists: artists, albums: albums, tracks: tracks,
    plays: { t: P_t, ms: P_ms, d: P_d, h: P_h, f: P_f }, enriched: false,
  };
}
