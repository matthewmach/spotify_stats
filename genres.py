"""
genres.py — Fetch genres from Last.fm and output data/genres.json.

This is completely separate from data.json — genres are never merged into the
main data file. The browser loads genres.json in the background after the page
renders, so page load speed is unaffected.

Needs a free Last.fm API key in config.json:  { "lastfm_api_key": "..." }
Get one at https://www.last.fm/api/account/create

Run:  python genres.py
Re-running is incremental — already-fetched artists are skipped (cache file).
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
DATA_PATH = os.path.join(DATA_DIR, "data.json")
GENRES_PATH = os.path.join(DATA_DIR, "genres.json")
CACHE_PATH = os.path.join(DATA_DIR, "genres_cache.json")
CONFIG_PATH = os.path.join(HERE, "config.json")

LASTFM_API = "https://ws.audioscrobbler.com/2.0/"
MAX_TAGS = 5
MIN_COUNT = 10

TAG_BLOCKLIST = {
    "seen live", "favorites", "favourites", "favorite", "favourite",
    "favorite songs", "favourite songs", "spotify", "love", "loved",
    "beautiful", "awesome", "amazing", "cool", "good", "great", "nice",
    "sexy", "catchy", "masterpiece", "vinyl", "owned", "albums i own",
    "want to see live", "wishlist", "my music", "music", "all", "favorite artists",
    "female vocalists", "male vocalists", "female vocalist", "male vocalist",
    "female fronted", "male fronted",
    "under 2000 listeners", "banger", "bangers", "vibe", "vibes",
}


def is_decade(tag):
    t = tag.replace(" ", "")
    return (
        (t.endswith("s") and t[:-1].isdigit())
        or (len(t) == 4 and t.isdigit())
    )


def filter_tags(names):
    out = []
    for n in names:
        t = n.strip().lower()
        if not t or t in TAG_BLOCKLIST or is_decade(t):
            continue
        if t not in out:
            out.append(t)
        if len(out) >= MAX_TAGS:
            break
    return out


def lastfm_top_tags(artist, key):
    params = urllib.parse.urlencode({
        "method": "artist.gettoptags", "artist": artist,
        "api_key": key, "format": "json", "autocorrect": "1",
    })
    req = urllib.request.Request(
        LASTFM_API + "?" + params,
        headers={"User-Agent": "spotify-stats/1.0"},
    )
    while True:
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2)
                continue
            return []
        except Exception:
            return []
    tags = (data.get("toptags") or {}).get("tag") or []
    names = [t["name"] for t in tags if (t.get("count") or 0) >= MIN_COUNT] or [t["name"] for t in tags]
    return filter_tags(names)


def main():
    cfg = json.load(open(CONFIG_PATH, encoding="utf-8")) if os.path.exists(CONFIG_PATH) else {}
    key = cfg.get("lastfm_api_key")
    if not key or key.startswith("YOUR_"):
        raise SystemExit(
            "Add your Last.fm API key to config.json (lastfm_api_key). "
            "Get one at https://www.last.fm/api/account/create"
        )

    data = json.load(open(DATA_PATH, encoding="utf-8"))
    cache = json.load(open(CACHE_PATH, encoding="utf-8")) if os.path.exists(CACHE_PATH) else {}

    artists = sorted(data["artists"], key=lambda a: -a.get("plays", 0))
    todo = [a["name"] for a in artists if a["name"] not in cache]
    print(f"Artists: {len(artists):,} total, {len(todo):,} to fetch from Last.fm")

    for i, name in enumerate(todo):
        cache[name] = lastfm_top_tags(name, key)
        time.sleep(0.2)
        if (i + 1) % 50 == 0:
            print(f"    {i + 1:,}/{len(todo):,}")
            json.dump(cache, open(CACHE_PATH, "w", encoding="utf-8"), ensure_ascii=False)
    json.dump(cache, open(CACHE_PATH, "w", encoding="utf-8"), ensure_ascii=False)

    # Output genres.json: { artistName: [tags] } — only artists with tags
    genres = {name: tags for name, tags in cache.items() if tags}
    with open(GENRES_PATH, "w", encoding="utf-8") as fh:
        json.dump(genres, fh, ensure_ascii=False, separators=(",", ":"))

    with_genres = sum(1 for a in artists if cache.get(a["name"]))
    distinct = len({g for tags in genres.values() for g in tags})
    size_kb = os.path.getsize(GENRES_PATH) / 1024
    print(f"Done. {with_genres:,}/{len(artists):,} artists have genres "
          f"({distinct:,} distinct). Output: {GENRES_PATH} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
