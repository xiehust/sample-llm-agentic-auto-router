"""Mock gateway/router for the dry run and tests (loopback only): a Responses endpoint that drives Codex through one
tool call and a final message, and imitates the router's response headers.

Behaviour per request, keyed by the router headers the proxy sets:
- `x-router-hint: pin=<model>` → served model = <model>; no hint (arm B) → Sol, decision `auto`;
- a session's first call answers with one function call that commits a file in /app (exec_command when Codex
  offers it, else shell); later calls answer with a final message;
- `--stall-pin <model>`: calls pinned to that model sleep `stall_s` first (forces an agent timeout in the dry run);
- `Authorization: Bearer tok-*` is required (401 otherwise) and every token seen is counted (refresh check).
Never sees real credentials; binds 127.0.0.1 (or an explicit private test-bridge address).
"""
from __future__ import annotations

import http.server
import json
import pathlib
import threading
import time
from collections import Counter
from typing import Any

SOL = 'global.openai.gpt-6.1-sol'
SCRIPT = ('cd /app && git checkout -q -b llmar-dryrun && echo dry-run-ok > DRYRUN.txt && git add -A && '
          'git -c user.name=dryrun -c user.email=dryrun@localhost commit -qm dryrun && git log --oneline -1')


def _sse(events: list[dict[str, Any]]) -> bytes:
    return b''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in events)


def _usage(prompt: int) -> dict[str, Any]:
    return {'input_tokens': prompt, 'input_tokens_details': {'cached_tokens': prompt // 2}, 'output_tokens': 40,
            'output_tokens_details': {'reasoning_tokens': 10}, 'total_tokens': prompt + 40}


def tool_call(tools: list[dict[str, Any]], script: str = SCRIPT) -> dict[str, Any]:
    names = {t.get('name') for t in tools if isinstance(t, dict)}
    if 'exec_command' in names:
        name, args = 'exec_command', {'cmd': script}
    else:
        name, args = 'shell', {'command': ['bash', '-lc', script]}
    return {'type': 'function_call', 'id': 'fc_dryrun', 'call_id': 'call_dryrun', 'name': name,
            'arguments': json.dumps(args), 'status': 'completed'}


def message(text: str) -> dict[str, Any]:
    return {'type': 'message', 'id': 'msg_dryrun', 'role': 'assistant', 'status': 'completed',
            'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}


def events_for(item: dict[str, Any], model: str, prompt: int, rid: str) -> list[dict[str, Any]]:
    resp = {'id': rid, 'object': 'response', 'status': 'completed', 'model': model, 'output': [item], 'usage': _usage(prompt)}
    return [{'type': 'response.created', 'sequence_number': 0, 'response': {**resp, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'sequence_number': 1, 'output_index': 0, 'item': {**item, 'status': 'in_progress'}},
            {'type': 'response.output_item.done', 'sequence_number': 2, 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'sequence_number': 3, 'response': resp}]


class MockRouter(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int = 0, stall_pin: str | None = None, stall_s: float = 0.0, reject_tokens: set[str] | None = None,
                 fail_status: int | None = None, fail_body: bytes = b'{"error": "upstream unavailable"}', fail_router_headers: bool = False,
                 host: str = '127.0.0.1', capture_dir: pathlib.Path | None = None):
        self.stall_pin, self.stall_s = stall_pin, stall_s
        self.reject_tokens = reject_tokens or set()
        self.fail_status, self.fail_body, self.fail_router_headers = fail_status, fail_body, fail_router_headers
        self.script = SCRIPT
        self.capture_dir = capture_dir       # first request body of each session, raw (dry-run capture; gitignored)
        self.anthropic_auto = ANTHROPIC_AUTO
        # The gateway's fallback (infra RouteAuto: only auto / auto:* reach the router): 'deny' answers any other body
        # model 403 without router headers, as the real fallback does for a model its role may not call; 'serve'
        # answers every call 200 without router headers (the fallback serving after a router 5xx).
        self.anthropic_fallback = 'deny'
        self.anthropic_usage: dict[str, Any] = {'input_tokens': 2, 'cache_read_input_tokens': 8000, 'cache_creation_input_tokens': 1500,
                                                'cache_creation': {'ephemeral_5m_input_tokens': 500, 'ephemeral_1h_input_tokens': 1000},
                                                'output_tokens': 1}
        self.lock = threading.Lock()
        self.calls: Counter[str] = Counter()
        self.tokens: Counter[str] = Counter()
        self.seen: list[dict[str, Any]] = []
        super().__init__((host, port), _H)


class _H(http.server.BaseHTTPRequestHandler):
    server: MockRouter
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_: Any) -> None:
        pass

    def _send(self, status: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self._send(200, json.dumps({'object': 'list', 'data': [{'id': 'auto', 'object': 'model'}]}).encode(), 'application/json')

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(n) or b'{}'
        if self.path.split('?', 1)[0].endswith('/messages'):
            self._messages(raw)
            return
        body = json.loads(raw)
        auth = self.headers.get('authorization') or ''
        session = self.headers.get('x-router-session') or ''
        hint = self.headers.get('x-router-hint') or ''
        with self.server.lock:
            self.server.seen.append({'session': session, 'hint': hint, 'auth_ok': auth.startswith('Bearer tok-'),
                                     'leaked': [k for k in self.headers if k.lower().startswith('x-llmar')],
                                     'reasoning': body.get('reasoning'), 'model': body.get('model'),
                                     'body_keys': sorted(body), 'tools': sorted(str(t.get('name') or t.get('type')) for t in body.get('tools') or [] if isinstance(t, dict))})
            if auth.startswith('Bearer tok-'):
                self.server.tokens[auth[7:]] += 1
        if not auth.startswith('Bearer tok-') or auth[7:] in self.server.reject_tokens:
            self._send(401, b'{"message":"Unauthorized"}', 'application/json')
            return
        if self.server.fail_status:
            extra = {'x-router-model': SOL, 'x-router-decision': 'pin', 'x-router-reason': 'mock'} if self.server.fail_router_headers else {}
            self._send(self.server.fail_status, self.server.fail_body, 'application/json', extra)
            return
        model = hint.split('=', 1)[1] if hint.startswith('pin=') else SOL
        if self.server.stall_pin and model == self.server.stall_pin:
            time.sleep(self.server.stall_s)
        with self.server.lock:
            self.server.calls[session] += 1
            k = self.server.calls[session]
        if k == 1 and self.server.capture_dir is not None:
            self.server.capture_dir.mkdir(parents=True, exist_ok=True)
            (self.server.capture_dir / f'first-body-{session}.json').write_text(json.dumps(body, indent=2, ensure_ascii=False))
        inputs = body.get('input') if isinstance(body.get('input'), list) else []
        done_tool = any(isinstance(i, dict) and i.get('type') == 'function_call_output' for i in inputs)
        item = message('Committed DRYRUN.txt.') if done_tool or k > 3 else tool_call(body.get('tools') or [], self.server.script)
        evs = events_for(item, model, prompt=2000 + 500 * k, rid=f'resp_{session[:8]}_{k}')
        self._send(200, _sse(evs), 'text/event-stream',
                   {'x-router-model': model, 'x-router-decision': 'pin' if hint else 'auto', 'x-router-reason': 'mock'})


ANTHROPIC_AUTO = 'global.anthropic.claude-sonnet-5-5'


def anthropic_events(model: str, usage: dict[str, Any], text: str = 'Done.') -> list[dict[str, Any]]:
    return [{'type': 'message_start', 'message': {'id': 'msg_mock', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [],
                                                  'stop_reason': None, 'usage': usage}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}},
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 40, 'input_tokens': None}},
            {'type': 'message_stop'}]


def _messages(self: _H, raw: bytes) -> None:
    """Anthropic Messages (Claude Code routes): records the request and answers an end_turn stream. Like the gateway, only
    `auto` / `auto:*` reach the "router" (x-router-* headers; served model: the hint's pin, else `anthropic_auto`);
    any other body model gets the fallback (`anthropic_fallback`)."""
    body = json.loads(raw)
    auth = self.headers.get('authorization') or ''
    with self.server.lock:
        self.server.seen.append({'path': self.path, 'session': self.headers.get('x-router-session') or '', 'hint': self.headers.get('x-router-hint') or '',
                                 'auth_ok': auth.startswith('Bearer tok-'), 'model': body.get('model'), 'raw': raw,
                                 'beta': self.headers.get('anthropic-beta'), 'version': self.headers.get('anthropic-version'),
                                 'leaked': [k for k in self.headers if k.lower().startswith(('x-llmar', 'x-api-key', 'x-claude-code'))]})
    if not auth.startswith('Bearer tok-'):
        self._send(401, b'{"message":"Unauthorized"}', 'application/json')
        return
    if self.server.fail_status:
        extra = {'x-router-model': ANTHROPIC_AUTO, 'x-router-decision': 'pin', 'x-router-reason': 'mock'} if self.server.fail_router_headers else {}
        self._send(self.server.fail_status, self.server.fail_body, 'application/json', extra)
        return
    routed = isinstance(body.get('model'), str) and (body['model'] == 'auto' or body['model'].startswith('auto:'))
    if not routed or self.server.anthropic_fallback == 'serve':
        if self.server.anthropic_fallback == 'deny' and not routed:
            self._send(403, b'{"message":"not authorized to invoke this model"}', 'application/json')
            return
        events = anthropic_events(ANTHROPIC_AUTO, dict(self.server.anthropic_usage))
        self._send(200, _sse(events) if body.get('stream') else json.dumps(events[0]['message']).encode(),
                   'text/event-stream' if body.get('stream') else 'application/json')
        return
    hint = self.headers.get('x-router-hint') or ''
    pin = next((p.split('=', 1)[1] for p in hint.split(';') if p.strip().startswith('pin=')), None)
    model = pin or self.server.anthropic_auto
    usage = dict(self.server.anthropic_usage)
    if body.get('stream'):
        self._send(200, _sse(anthropic_events(model, usage)), 'text/event-stream',
                   {'x-router-model': model, 'x-router-decision': 'pin' if pin else 'auto', 'x-router-reason': 'mock'})
    else:
        self._send(200, json.dumps({'id': 'msg_mock', 'type': 'message', 'role': 'assistant', 'model': model, 'stop_reason': 'end_turn',
                                    'content': [{'type': 'text', 'text': 'Done.'}], 'usage': {**usage, 'output_tokens': 40}}).encode(),
                   'application/json', {'x-router-model': model, 'x-router-decision': 'pin', 'x-router-reason': 'mock'})


_H._messages = _messages  # type: ignore[attr-defined]


def serve(port: int = 0, **kw: Any) -> tuple[MockRouter, threading.Thread]:
    srv = MockRouter(port, **kw)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t
