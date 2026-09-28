#!/usr/bin/env python3
"""Memoria CRM · servidor local (macOS / Linux / Windows con Python).
Sirve esta carpeta en http://localhost:8765 para que el navegador pueda cargar
los modelos de IA. No se conecta a internet ni acepta conexiones de otros equipos."""
import functools, http.server, os, socket, sys, threading, webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
TYPES = {".wasm": "application/wasm", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json",
         ".onnx": "application/octet-stream", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".woff2": "font/woff2"}

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}
    def log_message(self, *args):
        pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

def free_port(start):
    for p in range(start, start + 20):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise SystemExit("No hay puertos libres entre %d y %d" % (start, start + 19))

def main():
    port = free_port(int(os.environ.get("MEMORIA_PORT", "8765")))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=HERE))
    url = "http://localhost:%d/index.html" % port
    print("Memoria CRM abierta en %s\nDeja esta ventana abierta mientras la usas. Ctrl+C para cerrar." % url)
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
