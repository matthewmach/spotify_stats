"""
build.py — Aggregate Spotify Extended Streaming History JSONs into a compact
data.json the web UI loads. The UI aggregates on the fly for any date range,
so this emits a per-play stream plus entity metadata.

Reads every Streaming_History_Audio_*.json in HISTORY_DIR and produces:
  data/data.json

Run:  python build.py
"""

import json
import glob
import os
from datetime import datetime, timezone, date

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "data")

HISTORY_DIR = os.environ.get(
    "SPOTIFY_HISTORY_DIR",
    r"G:\Documents\Music\my_spotify_data\Spotify Extended Streaming History",
)

STREAM_MS = 30_000  # a play counts as a "stream" at >= 30s (Spotify's threshold)

# Per-play flag bits
F_SKIP = 1
F_DONE = 2      # reason_end == trackdone
F_SHUF = 4


def track_id(uri):
    if not uri:
        return None
    p = uri.split(":")
    return p[2] if len(p) == 3 and p[1] == "track" else None


def main():
    files = sorted(glob.glob(os.path.join(HISTORY_DIR, "Streaming_History_Audio_*.json")))
    if not files:
        raise SystemExit(f"No history files found in {HISTORY_DIR}")

    # Entity registries (insertion order = index)
    artist_idx, artists = {}, []           # name -> i ; [{name}]
    album_idx, albums = {}, []             # "artist\x01album" -> i ; [{name,artist}]
    track_idx, tracks = {}, []             # tid -> i ; [{id,name,artist,album,ai,bi}]

    def get_artist(name):
        i = artist_idx.get(name)
        if i is None:
            i = len(artists); artist_idx[name] = i; artists.append({"name": name})
        return i

    def get_album(artist, album):
        key = artist + "\x01" + album
        i = album_idx.get(key)
        if i is None:
            i = len(albums); album_idx[key] = i; albums.append({"name": album, "artist": artist})
        return i

    def get_track(tid, name, artist, album, ai, bi):
        i = track_idx.get(tid)
        if i is None:
            i = len(tracks); track_idx[tid] = i
            tracks.append({
                "id": None if tid.startswith("name::") else tid,
                "name": name, "artist": artist, "album": album, "ai": ai, "bi": bi,
            })
        return i

    # Raw plays collected, then sorted by timestamp
    raw = []  # (ts, track_i, ms, flags, hour)

    for fp in files:
        with open(fp, encoding="utf-8") as fh:
            data = json.load(fh)
        for rec in data:
            name = rec.get("master_metadata_track_name")
            if not name:
                continue
            artist = rec.get("master_metadata_album_artist_name") or "Unknown Artist"
            album = rec.get("master_metadata_album_album_name") or "Unknown Album"
            ms = rec.get("ms_played") or 0
            ts = rec.get("ts")
            if not ts:
                continue

            ai = get_artist(artist)
            bi = get_album(artist, album)
            tid = track_id(rec.get("spotify_track_uri")) or f"name::{artist}::{name}"
            ti = get_track(tid, name, artist, album, ai, bi)

            flags = 0
            if rec.get("skipped"):
                flags |= F_SKIP
            if rec.get("reason_end") == "trackdone":
                flags |= F_DONE
            if rec.get("shuffle"):
                flags |= F_SHUF

            hour = int(ts[11:13])
            raw.append((ts, ti, ms, flags, hour))

    raw.sort(key=lambda r: r[0])

    base_date = datetime.strptime(raw[0][0], "%Y-%m-%dT%H:%M:%SZ").date()

    P_t, P_ms, P_d, P_h, P_f = [], [], [], [], []
    total_ms = 0
    total_streams = 0
    total_skips = 0
    for ts, ti, ms, flags, hour in raw:
        d = (datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").date() - base_date).days
        P_t.append(ti)
        P_ms.append(ms)
        P_d.append(d)
        P_h.append(hour)
        P_f.append(flags)
        total_ms += ms
        if ms >= STREAM_MS:
            total_streams += 1
        if flags & F_SKIP:
            total_skips += 1

    n_days = P_d[-1] + 1
    last_date = base_date.fromordinal(base_date.toordinal() + P_d[-1])

    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "streamMs": STREAM_MS,
        "dayBase": base_date.isoformat(),       # day index 0 == this date (UTC)
        "nDays": n_days,
        "totals": {
            "plays": len(raw),
            "ms": total_ms,
            "streams": total_streams,
            "skipped": total_skips,
            "artists": len(artists),
            "albums": len(albums),
            "tracks": len(tracks),
            "first": raw[0][0],
            "last": raw[-1][0],
        },
        "artists": artists,
        "albums": albums,
        "tracks": tracks,
        "plays": {"t": P_t, "ms": P_ms, "d": P_d, "h": P_h, "f": P_f},
        "enriched": False,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, "data.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1e6
    hours = total_ms / 3_600_000
    print(f"Wrote {out_path} ({size_mb:.1f} MB)")
    print(f"  {len(raw):,} plays  |  {hours:,.0f} hours  |  "
          f"{len(artists):,} artists  {len(albums):,} albums  {len(tracks):,} tracks")
    print(f"  range {base_date} -> {last_date}  ({n_days} days)")


if __name__ == "__main__":
    main()
