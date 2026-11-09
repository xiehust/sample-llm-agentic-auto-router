"""Capture mock (dev box, 127.0.0.1 only): records every Claude Code request (method, path, headers, body) to a JSONL
file and answers /v1/messages with an immediate end_turn, so a session ends after its first main-loop request."""
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = sys.argv[1]
PORT = int(sys.argv[2])
SCRIPT = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
lock = threading.Lock()
n = [0]


def sse(ev, data):
    return f'event: {ev}\ndata: {json.dumps(data)}\n\n'.encode()


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _rec(self, body):
        with lock:
            n[0] += 1
            k = n[0]
            with open(OUT, 'a') as f:
                f.write(json.dumps({'seq': k, 't': time.time(), 'method': self.command, 'path': self.path,
                                    'headers': {k2.lower(): v for k2, v in self.headers.items()},
                                    'body': body}) + '\n')
        return k

    def do_GET(self):
        self._rec(None)
        b = json.dumps({'data': [], 'has_more': False}).encode()
        self.send_response(404 if 'models' not in self.path else 200)
        self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)

    do_HEAD = do_GET

    def do_POST(self):
        ln = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(ln)
        try:
            body = json.loads(raw)
        except ValueError:
            body = raw.decode('utf-8', 'replace')
        self._rec(body)
        if 'count_tokens' in self.path:
            b = json.dumps({'type': 'error', 'error': {'type': 'not_found_error', 'message': 'not found'}}).encode()
            self.send_response(404); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        model = body.get('model') if isinstance(body, dict) else 'x'
        text = SCRIPT.get('text', 'Done.')
        usage = {'input_tokens': 10, 'output_tokens': 5, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0}
        if not (isinstance(body, dict) and body.get('stream')):
            b = json.dumps({'id': f'msg_{uuid.uuid4().hex[:20]}', 'type': 'message', 'role': 'assistant', 'model': model,
                            'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': usage}).encode()
            self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream'); self.send_header('transfer-encoding', 'chunked'); self.end_headers()
        parts = [sse('message_start', {'type': 'message_start', 'message': {'id': f'msg_{uuid.uuid4().hex[:20]}', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}}),
                 sse('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                 sse('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
                 sse('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                 sse('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 5}}),
                 sse('message_stop', {'type': 'message_stop'})]
        for p in parts:
            self.wfile.write(f'{len(p):x}\r\n'.encode() + p + b'\r\n')
        self.wfile.write(b'0\r\n\r\n')


ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
