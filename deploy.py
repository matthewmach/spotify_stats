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
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
DOCS = os.path.join(HERE, "docs")

META = '<meta name="build" content="pages">'


def main():
    os.makedirs(DOCS, exist_ok=True)
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
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write(html)
        else:
            shutil.copy2(src, dst)
        copied.append(name)

    # A .nojekyll file stops GitHub Pages from running Jekyll on the folder.
    open(os.path.join(DOCS, ".nojekyll"), "w").close()

    print(f"Deployed {len(copied)} files to {DOCS}")
    print("  " + ", ".join(sorted(copied)))
    print("Enable GitHub Pages -> Deploy from branch -> /docs.")


if __name__ == "__main__":
    main()
