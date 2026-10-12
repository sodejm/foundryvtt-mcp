"""Synthetic REST API for SSH qualification; no licensed Foundry or credentials."""
from http.server import BaseHTTPRequestHandler, HTTPServer


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        authorized = self.headers.get('x-api-key') == 'remote-stdio-fixture-key'
        self.send_response(200 if authorized else 401)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"world":"remote-stdio-fixture"}' if authorized else b'{"error":"Unauthorized"}')

    def log_message(self, *_args):
        pass


HTTPServer(('127.0.0.1', 30000), Fixture).serve_forever()
