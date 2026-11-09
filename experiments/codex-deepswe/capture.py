"""D2: capture Codex's real first Responses request offline, then build per-task session-start bodies from it.

`cli.py capture` runs the pinned Codex (the same config.toml the runs use, `--strict-config`) against a mock
Responses endpoint on 127.0.0.1 inside a loopback-only network namespace (`unshare -rn`), so nothing leaves the
machine. The mock records each request body and answers with a minimal completed response. The recorded first body
has Codex's instructions, tools, environment context and our prompt with a placeholder issue; `task_bodies`
substitutes each task's issue text, which is what the router sees on the session-start call.
"""
from __future__ import annotations

import copy
import http.server
import json
import pathlib
import subprocess  # nosec B404 - fixed argv: the pinned Codex binary
import threading
from typing import Any

import codex_setup
from common import ARM_PIN

PLACEHOLDER = '@@LLMAR_TASK_ISSUE@@'
CAPTURE_CWD_NAME = 'testbed'


def _sse(events: list[dict[str, Any]]) -> bytes:
    return b''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in events)


def mock_events(model: str) -> list[dict[str, Any]]:
    msg = {'type': 'message', 'id': 'msg_capture', 'role': 'assistant', 'status': 'completed',
           'content': [{'type': 'output_text', 'text': 'No change needed.', 'annotations': []}]}
    resp = {'id': 'resp_capture', 'object': 'response', 'status': 'completed', 'model': model, 'output': [msg],
            'usage': {'input_tokens': 1, 'input_tokens_details': {'cached_tokens': 0}, 'output_tokens': 1,
                      'output_tokens_details': {'reasoning_tokens': 0}, 'total_tokens': 2}}
    return [{'type': 'response.created', 'sequence_number': 0, 'response': {**resp, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'sequence_number': 1, 'output_index': 0, 'item': {**msg, 'status': 'in_progress', 'content': []}},
            {'type': 'response.output_item.done', 'sequence_number': 2, 'output_index': 0, 'item': msg},
            {'type': 'response.completed', 'sequence_number': 3, 'response': resp}]


class MockResponses(http.server.ThreadingHTTPServer):
    """Records (method, path, headers without credentials, body) and serves a completed response."""

    def __init__(self, addr: tuple[str, int]):
        self.records: list[dict[str, Any]] = []
        super().__init__(addr, _MockHandler)


class _MockHandler(http.server.BaseHTTPRequestHandler):
    server: MockResponses

    def log_message(self, *_: Any) -> None:  # quiet
        pass

    def _record(self, body: bytes | None) -> None:
        hdrs = {k.lower(): v for k, v in self.headers.items() if k.lower() not in ('authorization', 'cookie')}
        rec: dict[str, Any] = {'method': self.command, 'path': self.path, 'headers': hdrs}
        if body is not None:
            try:
                rec['body'] = json.loads(body)
            except ValueError:
                rec['body_bytes'] = len(body)
        self.server.records.append(rec)

    def do_GET(self) -> None:  # noqa: N802
        self._record(None)
        data = json.dumps({'object': 'list', 'data': []}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n) if n else b''
        self._record(body)
        model = 'auto'
        try:
            model = json.loads(body).get('model', model)
        except ValueError:
            pass
        data = _sse(mock_events(model))
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run_capture(codex_bin: pathlib.Path, workdir: pathlib.Path, arm: str = 'A', run_id: str = 'capture-0',
                timeout_s: int = 120) -> dict[str, Any]:
    """Runs inside the loopback-only namespace (see cli.py). Returns the records, Codex's exit code and its JSONL."""
    srv = MockResponses(('127.0.0.1', 0))
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    home = workdir / 'codex-home'
    cwd = workdir / CAPTURE_CWD_NAME
    home.mkdir(parents=True, exist_ok=True)
    cwd.mkdir(parents=True, exist_ok=True)
    subprocess.run(['git', 'init', '-q', str(cwd)], check=True)  # nosec B603 B607
    pin = ARM_PIN.get(arm)
    toml = codex_setup.config_toml(f'http://127.0.0.1:{port}/r/{run_id}/v1', arm, run_id, pin, 'global.openai.gpt-6.1-sol')
    (home / 'config.toml').write_text(toml)
    argv = [str(codex_bin), *codex_setup.exec_argv(codex_setup.prompt(PLACEHOLDER), timeout_s)[7:]]
    argv[argv.index('/testbed')] = str(cwd)
    env = {**codex_setup.exec_env('/usr/local/bin:/usr/bin:/bin'), 'CODEX_HOME': str(home), 'HOME': str(workdir)}
    p = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout_s + 30)  # nosec B603
    srv.shutdown()
    return {'records': srv.records, 'exit_code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr[-4000:],
            'config_toml': toml, 'cwd': str(cwd)}


def first_responses_body(records: list[dict[str, Any]]) -> dict[str, Any]:
    for r in records:
        if r['method'] == 'POST' and r['path'].endswith('/responses') and isinstance(r.get('body'), dict):
            return r['body']
    raise ValueError('no POST /responses body was captured')


def _walk(x: Any, fn) -> Any:
    if isinstance(x, str):
        return fn(x)
    if isinstance(x, list):
        return [_walk(v, fn) for v in x]
    if isinstance(x, dict):
        return {k: _walk(v, fn) for k, v in x.items()}
    return x


def template(body: dict[str, Any], captured_cwd: str) -> dict[str, Any]:
    """The captured body with the capture directory rewritten to /testbed (where the task repo lives)."""
    if PLACEHOLDER not in json.dumps(body):
        raise ValueError('the captured body does not contain the issue placeholder')
    return _walk(copy.deepcopy(body), lambda s: s.replace(captured_cwd, '/testbed'))


def task_body(tmpl: dict[str, Any], issue_text: str) -> dict[str, Any]:
    """The session-start body for one task: the template with the issue text in place of the placeholder (the
    prompt is built by codex_setup.prompt, so the substitution reproduces it exactly)."""
    return _walk(copy.deepcopy(tmpl), lambda s: s.replace(PLACEHOLDER, issue_text.strip()))
