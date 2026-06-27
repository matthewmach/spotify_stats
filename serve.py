"""
serve.py — Tiny local web server for the stats site.

Serves the stats/ folder so web/index.html can load ../data/data.json, then
opens your browser. Nothing leaves your machine.

Run:  python serve.py   (optionally:  python serve.py 9000)
"""

import http.server
import os
import socketserver
import sys
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/web/index.html")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        # data.json changes between builds — don't let the browser cache it
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass  # quiet


def main():
    if not os.path.exists(os.path.join(HERE, "data", "data.json")):
        print("data/data.json not found — run 'python build.py' first.")
    url = f"http://localhost:{PORT}/web/index.html"
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving at {url}")
        print("Press Ctrl+C to stop.")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
