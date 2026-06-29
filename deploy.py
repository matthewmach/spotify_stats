"""
deploy.py — Generate the GitHub Pages copy of the site in ./docs from ./web.

The only difference between web/ (local) and docs/ (hosted) is a
  <meta name="build" content="pages">
tag injected into docs/index.html. That tag makes the app skip the local
data.json fetch and show the "Pages" badge — so the hosted site is always the
in-browser upload experience.

Run this whenever you change anything in web/:
    python deploy.py

Then commit ./docs and enable GitHub Pages -> Deploy from branch -> /docs.
"""

import os
import re
import shutil
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
DOCS = os.path.join(HERE, "docs")
DATA_DIR = os.path.join(HERE, "data")

META = '<meta name="build" content="pages">'

# Local assets to cache-bust so browsers (and the Pages CDN) always fetch the
# latest after a deploy — otherwise a stale app.js can show old behaviour.
ASSETS = ("styles.css", "shared-build.js", "spotify.js", "lastfm.js", "app.js")


def cache_bust(html, version):
    for a in ASSETS:
        html = re.sub(r'(["\'])' + re.escape(a) + r'(["\'])',
                      r'\g<1>' + a + "?v=" + version + r'\g<2>', html)
    return html


def main():
    os.makedirs(DOCS, exist_ok=True)
    version = str(int(time.time()))
    copied = []
    for name in os.listdir(WEB):
        src = os.path.join(WEB, name)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(DOCS, name)
        if name == "index.html":
            html = open(src, encoding="utf-8").read()
            if META not in html:
                html = html.replace("<head>", "<head>\n  " + META, 1)
            html = cache_bust(html, version)
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write(html)
        else:
            shutil.copy2(src, dst)
        copied.append(name)

    # Bundle genres.json if available (so Pages loads genres instantly)
    genres_src = os.path.join(DATA_DIR, "genres.json")
    if os.path.exists(genres_src):
        shutil.copy2(genres_src, os.path.join(DOCS, "genres.json"))
        copied.append("genres.json")

    # A .nojekyll file stops GitHub Pages from running Jekyll on the folder.
    open(os.path.join(DOCS, ".nojekyll"), "w").close()

    print(f"Deployed {len(copied)} files to {DOCS} (cache-bust v={version})")
    print("  " + ", ".join(sorted(copied)))
    print("Enable GitHub Pages -> Deploy from branch -> /docs.")


if __name__ == "__main__":
    main()
