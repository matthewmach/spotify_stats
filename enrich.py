"""
enrich.py — Pull genres + cover art from the Spotify Web API and merge them
into data/data.json.

Uses the Client Credentials flow (no user login). You need a Spotify app:
  https://developer.spotify.com/dashboard  ->  Create app  ->  copy IDs.

Put the credentials in stats/config.json (see config.example.json):
  { "client_id": "...", "client_secret": "..." }

What it does:
  1. Batch /v1/tracks   (50 ids/call) -> album id, album cover, artist ids
  2. Batch /v1/artists  (50 ids/call) -> genres, artist image, popularity
  3. Writes data/metadata.json (cache) and merges into data/data.json

Re-running is cheap: already-cached ids are skipped.

Run:  python enrich.py
"""

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
DATA_PATH = os.path.join(DATA_DIR, "data.json")
META_PATH = os.path.join(DATA_DIR, "metadata.json")
CONFIG_PATH = os.path.join(HERE, "config.json")

API = "https://api.spotify.com/v1"
TOKEN_URL = "https://accounts.spotify.com/api/token"


# --- HTTP helpers ----------------------------------------------------------


def get_token(client_id, client_secret):
    auth = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["access_token"]


def api_get(path, token, params=None):
    """GET with retry on 429 (rate limit) and 401 (token refresh handled by caller)."""
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    while True:
        try:
            with urllib.request.urlopen(req) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = int(e.headers.get("Retry-After", "2")) + 1
                print(f"    rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            if e.code == 401:
                raise PermissionError("token_expired")
            raise


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# --- Main ------------------------------------------------------------------


def main():
    if not os.path.exists(CONFIG_PATH):
        raise SystemExit(
            "Missing config.json. Copy config.example.json to config.json and add "
            "your Spotify client_id / client_secret."
        )
    cfg = json.load(open(CONFIG_PATH, encoding="utf-8"))
    cid, csec = cfg.get("client_id"), cfg.get("client_secret")
    if not cid or not csec or cid.startswith("YOUR_"):
        raise SystemExit("Fill in client_id / client_secret in config.json.")

    data = json.load(open(DATA_PATH, encoding="utf-8"))

    # Load existing cache so re-runs are incremental
    cache = {"tracks": {}, "artists": {}, "albums": {}}
    if os.path.exists(META_PATH):
        cache.update(json.load(open(META_PATH, encoding="utf-8")))
        # ensure all keys present
        for k in ("tracks", "artists", "albums"):
            cache.setdefault(k, {})

    token = [get_token(cid, csec)]   # list so inner fns can refresh

    def call(path, params=None):
        try:
            return api_get(path, token[0], params)
        except PermissionError:
            token[0] = get_token(cid, csec)
            return api_get(path, token[0], params)

    # --- Step 1: tracks -> album + artist ids + album art ------------------
    track_ids = [t["id"] for t in data["tracks"] if t.get("id")]
    todo = [tid for tid in track_ids if tid not in cache["tracks"]]
    print(f"Tracks: {len(track_ids):,} total, {len(todo):,} to fetch")

    artist_ids_needed = set()
    for i, batch in enumerate(chunks(todo, 50)):
        res = call("/tracks", {"ids": ",".join(batch)})
        for tr in res.get("tracks", []) or []:
            if not tr:
                continue
            album = tr.get("album") or {}
            imgs = album.get("images") or []
            arts = tr.get("artists") or []
            cache["tracks"][tr["id"]] = {
                "album_id": album.get("id"),
                "img": imgs[-1]["url"] if imgs else None,   # smallest image
                "img_big": imgs[0]["url"] if imgs else None,
                "artist_ids": [a["id"] for a in arts if a.get("id")],
                "popularity": tr.get("popularity"),
                "duration_ms": tr.get("duration_ms"),
                "explicit": tr.get("explicit"),
            }
        if (i + 1) % 10 == 0:
            print(f"    tracks {min((i + 1) * 50, len(todo)):,}/{len(todo):,}")
            _save(cache)

    # Collect every artist id we now know about (from cache, all tracks)
    for tr in cache["tracks"].values():
        for aid in tr.get("artist_ids", []):
            artist_ids_needed.add(aid)

    # --- Step 2: artists -> genres + image + popularity --------------------
    todo_artists = [a for a in artist_ids_needed if a not in cache["artists"]]
    print(f"Artists: {len(artist_ids_needed):,} known, {len(todo_artists):,} to fetch")
    for i, batch in enumerate(chunks(todo_artists, 50)):
        res = call("/artists", {"ids": ",".join(batch)})
        for ar in res.get("artists", []) or []:
            if not ar:
                continue
            imgs = ar.get("images") or []
            cache["artists"][ar["id"]] = {
                "name": ar.get("name"),
                "genres": ar.get("genres", []),
                "img": imgs[-1]["url"] if imgs else None,
                "img_big": imgs[0]["url"] if imgs else None,
                "popularity": ar.get("popularity"),
                "followers": (ar.get("followers") or {}).get("total"),
            }
        if (i + 1) % 10 == 0:
            print(f"    artists {min((i + 1) * 50, len(todo_artists)):,}/{len(todo_artists):,}")
            _save(cache)

    _save(cache)

    # --- Step 3: merge enrichment back into data.json ----------------------
    # Map artist NAME -> best matching enriched record. The history only gives
    # us names, so we match the primary artist of that name via tracks.
    name_to_artistid = {}
    for t in data["tracks"]:
        tid = t.get("id")
        if not tid or tid not in cache["tracks"]:
            continue
        aids = cache["tracks"][tid].get("artist_ids") or []
        if aids:
            name_to_artistid.setdefault(t["artist"], aids[0])

    # Enrich artists
    for a in data["artists"]:
        aid = name_to_artistid.get(a["name"])
        info = cache["artists"].get(aid) if aid else None
        if info:
            a["genres"] = info["genres"]
            a["img"] = info["img"]
            a["popularity"] = info["popularity"]
            a["followers"] = info["followers"]
            a["spotify_id"] = aid

    # Enrich tracks (cover art, popularity, duration) and gather album art
    album_art = {}   # "artist\x01album" -> img
    for t in data["tracks"]:
        info = cache["tracks"].get(t.get("id"))
        if info:
            t["img"] = info["img"]
            t["popularity"] = info["popularity"]
            t["duration_ms"] = info["duration_ms"]
            if info["img"]:
                album_art.setdefault(f"{t['artist']}\x01{t['album']}", info["img_big"] or info["img"])

    # Enrich albums with cover art (from any track on that album) + artist genres
    for al in data["albums"]:
        img = album_art.get(f"{al['artist']}\x01{al['name']}")
        if img:
            al["img"] = img
        aid = name_to_artistid.get(al["artist"])
        info = cache["artists"].get(aid) if aid else None
        if info and info["genres"]:
            al["genres"] = info["genres"]

    # The genre *breakdown* is computed per-window in the browser from each
    # artist's genres, so we only attach genres here.
    data["enriched"] = True

    with open(DATA_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))

    enr_artists = sum(1 for a in data["artists"] if a.get("genres"))
    distinct = len({g for a in data["artists"] for g in (a.get("genres") or [])})
    print(f"Done. Enriched {enr_artists:,} artists across {distinct:,} distinct genres.")
    print(f"Cache: {META_PATH}")


def _save(cache):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(META_PATH, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
