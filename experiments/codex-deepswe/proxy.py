"""Host-side egress proxy (design D5, review R3): the only way out of the task containers.

Containers reach it at http://<bridge-gateway-ip>:<port>/r/<run-id>/v1/... and nothing else. Per request it:
- allows only POST /r/<run>/v1/responses and GET /r/<run>/v1/models for a registered run (no CONNECT, no absolute
  URIs, no other method or path, no compressed request bodies);
- forwards to exactly one of two upstream hosts: the gateway (inference prefix, `Authorization: Bearer <token>`
  injected from the run's token provider) or bedrock-runtime in the experiment region (arm D: SigV4 with the
  instance credentials, Sol only). The upstream name is resolved once per connection and refused when any address is
  link-local (IMDS), loopback, private, CGNAT, unique-local, multicast or unspecified; the connection goes to the
  vetted address (no DNS rebinding);
- always sets `x-router-session: <run-id>` (A2) and the arm's `x-router-hint`, whatever the client sent;
- streams the response back and records one metadata line per call: status, timings, served model, router headers,
  usage, priced cost. Never a body, a prompt, an Authorization value, a token or a SigV4 header;
- refuses further calls (HTTP 429, code `budget`) once the run has spent its budget.

It listens only on an explicit private address (the --internal network's bridge gateway), never 0.0.0.0.
"""
from __future__ import annotations

import dataclasses
import http.client
import http.server
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
import urllib.parse
from collections.abc import Callable
from typing import Any

import pricing

BEDROCK_HOST_FMT = 'bedrock-runtime.{region}.amazonaws.com'
BEDROCK_RESPONSES_PATH = '/openai/v1/responses'
GATEWAY_INFERENCE_PREFIX = '/inference/v1'
MAX_BODY = 12 * 1024 * 1024
CONNECT_TIMEOUT_S = 10
READ_TIMEOUT_S = 330          # above Codex's 300 s stream idle timeout
HANDLER_TIMEOUT_S = 360       # client-side socket timeout per handler (review L4)
UNPRICED_OUTPUT_TOKENS = 4000
MARGIN_OUTPUT_TOKENS = 16_000
BYTES_PER_TOKEN_FLOOR = 3     # request bytes / 3 bounds the prompt tokens from above for text and code
FORWARD_REQUEST_HEADERS = ('content-type', 'accept', 'user-agent', 'openai-beta')
RETURN_HEADERS = ('content-type', 'x-router-decision', 'x-router-model', 'x-router-reason', 'retry-after',
                  'x-request-id', 'x-amzn-requestid', 'openai-processing-ms')
ROUTER_HEADERS = ('x-router-decision', 'x-router-model', 'x-router-reason')
_RUN_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
_PATH = re.compile(r'^/r/([^/]+)/v1/(responses|models|messages|messages/count_tokens)$')
# (method, leaf) pairs a route of each dialect serves; the Anthropic leaves exist only for anthropic-messages routes
# (deepswe-harbor/hproxy.py, Claude Code). An OpenAI route answers them exactly as before (404 path-not-allowed).
ROUTE_LEAVES = {'openai-responses': (('POST', 'responses'), ('GET', 'models')),
                'anthropic-messages': (('POST', 'messages'), ('POST', 'messages/count_tokens'), ('GET', 'models'))}
ANTHROPIC_LEAVES = ('messages', 'messages/count_tokens')

DENIED_NETS = [ipaddress.ip_network(n) for n in (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
    '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
    '::/96', '::1/128', '::ffff:0:0/96', '64:ff9b::/96', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8', 'fd00:ec2::254/128')]


class Refused(Exception):
    """A request or destination the proxy will not serve. `status` is the HTTP status answered to the client."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def denied_address(ip: str) -> bool:
    a = ipaddress.ip_address(ip)
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return any(a in n for n in DENIED_NETS if n.version == a.version)


def check_bind(host: str, allow_loopback: bool = False) -> str:
    """The listen address must be an explicit private IPv4 (the bridge gateway); never unspecified or public."""
    if host in ('', '0.0.0.0', '::', '*'):  # nosec B104: this check refuses wildcard hosts; not a bind
        raise Refused(0, 'bind-unspecified')
    a = ipaddress.ip_address(host)
    if a.is_unspecified:
        raise Refused(0, 'bind-unspecified')
    if a.is_loopback:
        if allow_loopback:
            return host
        raise Refused(0, 'bind-loopback')
    if not (isinstance(a, ipaddress.IPv4Address) and a.is_private):
        raise Refused(0, 'bind-not-private')
    return host


def resolve_public(host: str, port: int = 443, resolver: Callable[..., list] = socket.getaddrinfo) -> str:
    """First IPv4 address of `host` (AF_INET only), after refusing the name when ANY of its addresses is in a denied
    range."""
    try:
        infos = resolver(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except OSError as e:
        raise Refused(502, 'upstream-dns') from e
    ips = [i[4][0] for i in infos if i[0] == socket.AF_INET]
    if not ips:
        raise Refused(502, 'upstream-dns')
    if any(denied_address(ip) for ip in ips):
        raise Refused(502, 'upstream-denied-address')
    return ips[0]


def tls_context() -> ssl.SSLContext:
    """System trust store, hostname checked, certificate required, TLS 1.2 or later."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS to a pre-vetted IP, with SNI and certificate checks against the host name."""

    def __init__(self, host: str, ip: str, timeout: float):
        super().__init__(host, 443, timeout=timeout, context=tls_context())
        self._ip = ip

    def connect(self) -> None:
        sock = socket.create_connection((self._ip, 443), timeout=CONNECT_TIMEOUT_S)  # an IPv4 literal: no DNS here
        sock.settimeout(self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]


@dataclasses.dataclass
class Route:
    run_id: str
    arm: str
    kind: str                      # 'gateway' | 'bedrock'
    hint: str | None               # x-router-hint value (A: pin=Sol, C: pin=Astra), None for B and D
    budget_usd: float
    token: Callable[[], str] | None = None      # gateway bearer provider (never stored as a string here)
    allowed_model: str | None = None            # the only model id the body may name ('auto' on the gateway, Sol for D)
    margin_usd: float = 0.0                     # the ledger's one-call margin: the last admitted call must fit in it
    worst_model: str = 'global.openai.gpt-6-astra'  # pricing for calls before the served model is known
    dialect: str = 'openai-responses'           # 'anthropic-messages': Claude Code routes (hproxy); hooks below dispatch on it
    agent: dict[str, Any] | None = None         # per-route agent state (hproxy, Claude Code: arm spec, role tracking)
    last_bytes: int | None = None
    spent_usd: float = 0.0
    calls: int = 0
    blocked: int = 0
    budget_stopped: bool = False
    last_prompt: int | None = None
    last_model: str | None = None
    seq: int = 0


class Upstreams:
    """Exactly two allowed upstream hosts: the gateway's and bedrock-runtime's in `region`."""

    def __init__(self, gateway_url: str | None, region: str, connect: Callable[[str, str, float], http.client.HTTPConnection] | None = None,
                 resolver: Callable[..., list] = socket.getaddrinfo, signer: Callable[[str, str, bytes, dict[str, str]], dict[str, str]] | None = None):
        self.gateway_host: str | None = None
        self.gateway_base = ''
        if gateway_url:
            # The stack output GatewayUrl may carry a path (e.g. /mcp); only its host is used, the inference prefix
            # is fixed (same as the E2E runner's gateway()).
            u = urllib.parse.urlsplit(gateway_url)
            if u.scheme != 'https' or not u.hostname or u.port not in (None, 443) or u.query or u.fragment or u.username:
                raise ValueError('gateway URL must be https://<host>[/<path>] with no port, query or credentials')
            self.gateway_host = u.hostname
        self.bedrock_host = BEDROCK_HOST_FMT.format(region=region)
        self.region = region
        self._connect = connect or (lambda host, ip, timeout: PinnedHTTPSConnection(host, ip, timeout))
        self._resolver = resolver
        self._signer = signer

    def allowed(self) -> set[str]:
        return {h for h in (self.gateway_host, self.bedrock_host) if h}

    def target(self, kind: str, leaf: str) -> tuple[str, str]:
        if kind == 'gateway':
            if not self.gateway_host:
                raise Refused(503, 'no-gateway')
            return self.gateway_host, f'{self.gateway_base}{GATEWAY_INFERENCE_PREFIX}/{leaf}'
        if kind == 'bedrock':
            if leaf != 'responses':
                raise Refused(404, 'path-not-allowed')
            return self.bedrock_host, BEDROCK_RESPONSES_PATH
        raise Refused(500, 'bad-route')

    def open(self, host: str) -> http.client.HTTPConnection:
        if host not in self.allowed():
            raise Refused(502, 'upstream-not-allowed')
        ip = resolve_public(host, 443, self._resolver)
        return self._connect(host, ip, READ_TIMEOUT_S)

    def sign(self, method: str, url: str, body: bytes, headers: dict[str, str]) -> dict[str, str]:
        if self._signer is None:
            self._signer = sigv4_signer(self.region)
        return self._signer(method, url, body, headers)


def sigv4_signer(region: str) -> Callable[[str, str, bytes, dict[str, str]], dict[str, str]]:
    """botocore SigV4 (service `bedrock`) with the default credential chain (the instance role on the runner)."""
    import botocore.session  # lazy: only arm D needs it
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = botocore.session.get_session()

    def sign(method: str, url: str, body: bytes, headers: dict[str, str]) -> dict[str, str]:
        creds = session.get_credentials()
        if creds is None:
            raise Refused(502, 'no-credentials')
        req = AWSRequest(method=method, url=url, data=body, headers=dict(headers))
        SigV4Auth(creds.get_frozen_credentials(), 'bedrock', region).add_auth(req)
        return dict(req.headers.items())

    return sign


SSE_PREFIXES = (b'event:', b'data:', b':', b'id:', b'retry:')
CLIENT_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


def looks_like_sse(content_type: str | None, request_stream: bool, first: bytes) -> bool:
    """SSE when the first bytes are SSE fields, when the upstream says text/event-stream, or when the request asked for
    a stream and the content type is not JSON (the gateway's streaming content type differs from bedrock-runtime's;
    an error reply to a streaming request is still JSON)."""
    ct = (content_type or '').lower()
    if first.lstrip().startswith(SSE_PREFIXES) or ct.startswith('text/event-stream'):
        return True
    return request_stream and 'json' not in ct


class SseTap:
    """Incremental SSE parser over the response bytes: keeps only the terminal response's metadata."""

    TERMINAL = ('response.completed', 'response.incomplete', 'response.failed')

    def __init__(self) -> None:
        self.buf = b''
        self.out: dict[str, Any] = {}

    def feed(self, chunk: bytes) -> None:
        # CRLF framing is valid SSE too; normalising the whole buffer also handles a CRLF split across chunks.
        self.buf = (self.buf + chunk).replace(b'\r\n', b'\n')
        while b'\n\n' in self.buf:
            ev, self.buf = self.buf.split(b'\n\n', 1)
            self._event(ev)
        if len(self.buf) > 4 * 1024 * 1024:   # an unterminated giant event: drop it, keep streaming
            self.buf = b''

    def close(self) -> None:
        if self.buf.strip():
            self._event(self.buf)
        self.buf = b''

    def _event(self, raw: bytes) -> None:
        data = b'\n'.join(line[5:].lstrip() for line in raw.split(b'\n') if line.startswith(b'data:'))
        if not data or data == b'[DONE]':
            return
        try:
            e = json.loads(data)
        except ValueError:
            return
        if not isinstance(e, dict):
            return
        t = e.get('type')
        if t in self.TERMINAL and isinstance(e.get('response'), dict):
            r = e['response']
            self.out.update(terminal=t, status=r.get('status'), model=r.get('model'), usage=r.get('usage'), response_id=r.get('id'))
            inc = r.get('incomplete_details') or {}
            err = r.get('error') or {}
            if isinstance(inc, dict) and inc.get('reason'):
                self.out['incomplete_reason'] = str(inc['reason'])[:40]
            if isinstance(err, dict) and err.get('code'):
                self.out['error_code'] = str(err['code'])[:60]
        elif t == 'error':
            self.out['error_code'] = str(e.get('code') or (e.get('error') or {}).get('code') or 'error')[:60]


class EgressProxy(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str, port: int, upstreams: Upstreams, on_call: Callable[[dict[str, Any]], None],
                 strip_body_keys: tuple[str, ...] = (), allow_loopback_bind: bool = False, clock=time.time):
        check_bind(host, allow_loopback=allow_loopback_bind)
        self.upstreams = upstreams
        self.on_call = on_call
        self.strip_body_keys = strip_body_keys
        self.clock = clock
        self.routes: dict[str, Route] = {}
        self.lock = threading.Lock()
        self.unrouted = 0
        super().__init__((host, port), _Handler)

    def register(self, route: Route) -> None:
        if not _RUN_ID.match(route.run_id):
            raise ValueError('run id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}')
        if route.kind not in ('gateway', 'bedrock'):
            raise ValueError('route kind must be gateway or bedrock')
        if route.kind == 'gateway' and route.token is None:
            raise ValueError('a gateway route needs a token provider')
        with self.lock:
            self.routes[route.run_id] = route

    def unregister(self, run_id: str) -> Route | None:
        with self.lock:
            return self.routes.pop(run_id, None)

    def base_url(self, run_id: str) -> str:
        h, p = self.server_address[:2]
        return f'http://{h}:{p}/r/{run_id}/v1'


class _Handler(http.server.BaseHTTPRequestHandler):
    server: EgressProxy
    protocol_version = 'HTTP/1.1'
    timeout = HANDLER_TIMEOUT_S     # idle client sockets are closed (StreamRequestHandler applies it to the connection)

    def log_message(self, *_: Any) -> None:  # never log request lines or headers
        pass

    # Everything except GET and POST is refused, CONNECT included.
    def do_CONNECT(self) -> None:  # noqa: N802
        self._refuse(Refused(405, 'method-not-allowed'), None)

    do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT  # noqa: N815

    def do_GET(self) -> None:  # noqa: N802
        self._serve('GET')

    def do_POST(self) -> None:  # noqa: N802
        self._serve('POST')

    # ------------------------------------------------------------ helpers
    def _reply_json(self, status: int, obj: dict[str, Any], close: bool = False) -> None:
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        if close:
            self.send_header('connection', 'close')
            self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def _refuse(self, r: Refused, route: Route | None, rec: dict[str, Any] | None = None) -> None:
        if route is not None:
            with self.server.lock:
                route.blocked += 1
        else:
            with self.server.lock:
                self.server.unrouted += 1
        if rec is not None:
            rec.update(status=r.status, refused=r.code)
            self.server.on_call(rec)
        msg = 'experiment budget exhausted' if r.code == 'budget' else f'proxy refused: {r.code}'
        self._reply_json(r.status, {'error': {'message': msg, 'type': 'proxy', 'code': r.code}}, close=True)

    def _route(self, method: str) -> tuple[Route, str]:
        if not self.path.startswith('/'):
            raise Refused(405, 'absolute-uri')
        path = urllib.parse.urlsplit(self.path).path
        m = _PATH.match(path)
        if not m:
            raise Refused(404, 'path-not-allowed')
        run_id, leaf = m.group(1), m.group(2)
        with self.server.lock:
            route = self.server.routes.get(run_id)
        if leaf in ANTHROPIC_LEAVES and (route is None or route.dialect != 'anthropic-messages'):
            raise Refused(404, 'path-not-allowed')
        if (method, leaf) not in ROUTE_LEAVES.get(route.dialect if route else 'openai-responses', ()):
            raise Refused(405, 'method-not-allowed')
        if route is None:
            raise Refused(404, 'unknown-run')
        return route, leaf

    def _serve(self, method: str) -> None:
        t0 = self.server.clock()
        self._streaming = False
        route: Route | None = None
        rec: dict[str, Any] | None = None
        try:
            route, leaf = self._route(method)
            with self.server.lock:
                route.seq += 1
                route.calls += 1
                seq = route.seq
            rec = {'run_id': route.run_id, 'arm': route.arm, 'seq': seq, 'method': method, 'leaf': leaf,
                   't_start': round(t0, 3)}
            if self.headers.get('content-encoding', 'identity').lower() != 'identity':
                raise Refused(415, 'compressed-body')
            body = b''
            if method == 'POST':
                if self.headers.get('transfer-encoding'):
                    raise Refused(411, 'chunked-body')
                try:
                    n = int(self.headers.get('content-length') or 0)
                except ValueError:
                    n = -1
                if n <= 0 or n > MAX_BODY:
                    raise Refused(413, 'body-size')
                body = self.rfile.read(n)
            if route.budget_stopped or route.spent_usd >= route.budget_usd:
                route.budget_stopped = True
                raise Refused(429, 'budget')
            if route.kind == 'bedrock' and leaf == 'models':
                self._models_local(route, rec)
                return
            body, req_meta = self._check_body(route, body) if method == 'POST' else (body, {})
            rec.update(req_meta)
            if method == 'POST':
                self._admit(route, len(body), rec)
            self._forward(route, method, leaf, body, rec, t0)
        except Refused as r:
            self._refuse(r, route, rec)
        except Exception as e:  # noqa: BLE001 - catch-all (review L3): record, answer 502 if nothing was sent yet
            streaming = getattr(self, '_streaming', False)
            if rec is not None and route is not None and streaming and rec.get('status') == 200:
                est = pricing.cost(route.last_model or route.worst_model,
                                   {'input_tokens': route.last_prompt or 0, 'output_tokens': UNPRICED_OUTPUT_TOKENS})['usd']
                with self.server.lock:
                    route.spent_usd += est
                rec['unpriced_estimate_usd'] = round(est, 6)
            if rec is not None:
                rec.update(status=rec.get('status') or 502, error=type(e).__name__, mid_stream=streaming,
                           dur_ms=round((self.server.clock() - t0) * 1000))
                self.server.on_call(rec)
            self.close_connection = True
            if not streaming:
                try:
                    self._reply_json(502, {'error': {'message': 'proxy: upstream error', 'type': 'proxy', 'code': 'upstream'}}, close=True)
                except OSError:
                    pass

    def _check_body(self, route: Route, body: bytes) -> tuple[bytes, dict[str, Any]]:
        try:
            j = json.loads(body)
        except ValueError as e:
            raise Refused(400, 'body-not-json') from e
        if not isinstance(j, dict):
            raise Refused(400, 'body-not-object')
        model = j.get('model')
        if route.allowed_model is not None and model != route.allowed_model:
            raise Refused(403, 'model-not-allowed')
        meta = {'requested_model': model if isinstance(model, str) and len(model) < 80 else 'other',
                'stream': bool(j.get('stream')), 'req_bytes': len(body),
                'input_items': len(j['input']) if isinstance(j.get('input'), list) else None}
        if self.server.strip_body_keys and any(k in j for k in self.server.strip_body_keys):
            for k in self.server.strip_body_keys:
                j.pop(k, None)
            body = json.dumps(j, separators=(',', ':'), ensure_ascii=False).encode()
            meta['stripped'] = list(self.server.strip_body_keys)
        return body, meta

    def _admit(self, route: Route, n_bytes: int, rec: dict[str, Any]) -> None:
        """Review L5: the ledger reserves budget + one-call margin per run, so a call is admitted only if its worst case
        (prompt estimated from the previous call's actual size plus the new bytes / 3, all uncached, at the price for
        that size, + 16k output tokens) fits in what is left of budget + margin. Near the end of the budget this is the
        budget stop; early in a run it refuses only an implausibly large request."""
        with self.server.lock:
            prev, prev_bytes, spent = route.last_prompt, route.last_bytes, route.spent_usd
        grow = max(0, n_bytes - (prev_bytes or 0)) // BYTES_PER_TOKEN_FLOOR
        est_prompt = (prev or 0) + grow if prev is not None else n_bytes // BYTES_PER_TOKEN_FLOOR
        if route.arm == 'B':
            model = route.worst_model   # review F1: the router may switch the auto lineage (e.g. Luna → Astra at compaction)
        elif route.allowed_model not in (None, 'auto'):
            model = route.allowed_model
        else:
            model = route.last_model or route.worst_model
        worst = pricing.cost(model, {'input_tokens': est_prompt, 'output_tokens': MARGIN_OUTPUT_TOKENS})['usd']
        rec['est_prompt_tokens'] = est_prompt
        if spent + worst > route.budget_usd + route.margin_usd:
            route.budget_stopped = True
            raise Refused(429, 'budget')
        with self.server.lock:
            route.last_bytes = n_bytes

    def _models_local(self, route: Route, rec: dict[str, Any]) -> None:
        self._reply_json(200, {'object': 'list', 'data': [{'id': route.allowed_model, 'object': 'model', 'owned_by': 'bedrock'}]})
        rec.update(status=200, local=True)
        self.server.on_call(rec)

    # ------------------------------------------------------------ dialect hooks (defaults: the Responses behaviour)
    def _forward_headers(self, route: Route) -> tuple[str, ...]:
        return FORWARD_REQUEST_HEADERS

    def _new_tap(self, route: Route) -> SseTap:
        return SseTap()

    def _json_meta(self, route: Route, raw: bytes) -> dict[str, Any]:
        return _json_meta(raw)

    def _price(self, route: Route, model: str | None, usage: dict[str, Any]) -> dict[str, Any]:
        return pricing.cost(model, usage)

    def _normalize(self, route: Route, usage: dict[str, Any]) -> dict[str, int]:
        return pricing.normalize(usage)

    def _extra_meta(self, route: Route, meta: dict[str, Any]) -> dict[str, Any]:
        return {}

    def _hint(self, route: Route, rec: dict[str, Any]) -> str | None:
        return route.hint

    def _forward(self, route: Route, method: str, leaf: str, body: bytes, rec: dict[str, Any], t0: float) -> None:
        ups = self.server.upstreams
        host, upath = ups.target(route.kind, leaf)
        headers = {k: self.headers[k] for k in self._forward_headers(route) if self.headers.get(k)}
        headers['accept-encoding'] = 'identity'
        headers['host'] = host
        if route.kind == 'gateway':
            headers['x-router-session'] = route.run_id
            hint = self._hint(route, rec)
            if hint:
                headers['x-router-hint'] = hint
            headers['authorization'] = f'Bearer {route.token()}'  # type: ignore[misc]
        else:
            headers = ups.sign(method, f'https://{host}{upath}', body, headers)
        conn = ups.open(host)
        try:
            conn.request(method, upath, body=body if method == 'POST' else None, headers=headers)
            resp = conn.getresponse()
            ttfb = self.server.clock()
            self._streaming = True
            rec['status'] = resp.status
            # Known as soon as the headers arrive, so a call that fails mid-stream still records who served it.
            rec['router'] = {k: resp.getheader(k) for k in ROUTER_HEADERS if resp.getheader(k) is not None}
            rec['via_router'] = bool(rec['router'])
            if rec['router'].get('x-router-model'):
                rec['served_model'] = rec['router']['x-router-model']
            self.send_response(resp.status)
            for k in RETURN_HEADERS:
                v = resp.getheader(k)
                if v is not None:
                    self.send_header(k, v)
            self.send_header('transfer-encoding', 'chunked')
            self.end_headers()
            tap = self._new_tap(route)
            ctype = resp.getheader('content-type')
            rec['upstream_content_type'] = (ctype or '')[:100]
            sse: bool | None = None
            raw = bytearray()
            total = 0
            client_gone = False
            while True:
                chunk = resp.read1(65536) if hasattr(resp, 'read1') else resp.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if sse is None:
                    sse = looks_like_sse(ctype, bool(rec.get('stream')), chunk)
                if sse:
                    tap.feed(chunk)
                elif len(raw) < MAX_BODY:
                    raw += chunk
                if not client_gone:
                    try:
                        self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                        self.wfile.flush()
                    except CLIENT_GONE:
                        # Codex closed its side (it stops reading once it has response.completed). Not an upstream
                        # error: stop writing; keep reading only until the terminal event, for its usage.
                        client_gone = True
                        rec['client_closed'] = 'after-terminal' if tap.out.get('terminal') else 'before-terminal'
                if client_gone and (tap.out.get('terminal') or not sse):
                    break
            if not client_gone:
                try:
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                except CLIENT_GONE:
                    client_gone = True
                    rec['client_closed'] = 'after-terminal' if tap.out.get('terminal') else 'before-terminal'
            if client_gone:
                self.close_connection = True
            sse = bool(sse)
        finally:
            conn.close()   # self._streaming stays True: the except path in _serve must know headers were sent
        if sse:
            tap.close()
        meta = tap.out if sse else self._json_meta(route, bytes(raw))
        router = {k: resp.getheader(k) for k in ROUTER_HEADERS if resp.getheader(k) is not None}
        served = router.get('x-router-model') or meta.get('model')
        usage = meta.get('usage') if isinstance(meta.get('usage'), dict) else None
        priced = self._price(route, served if isinstance(served, str) else None, usage) if usage else None
        n = self._normalize(route, usage) if usage else None
        unpriced = None
        if not priced and resp.status == 200:
            # Billed but no terminal usage (e.g. cut stream): estimate from the previous prompt (review L5).
            unpriced = self._price(route, served if isinstance(served, str) else route.last_model or route.worst_model,
                                   {'input_tokens': route.last_prompt or 0, 'output_tokens': UNPRICED_OUTPUT_TOKENS})['usd']
        with self.server.lock:
            if priced:
                route.spent_usd += priced['usd']
            elif unpriced:
                route.spent_usd += unpriced
            prev_prompt, prev_model = route.last_prompt, route.last_model
            if n:
                route.last_prompt, route.last_model = n['prompt'], (priced or {}).get('model')
        rec.update({
            'status': resp.status, 'ttfb_ms': round((ttfb - t0) * 1000), 'dur_ms': round((self.server.clock() - t0) * 1000),
            'resp_bytes': total, 'sse': sse, 'router': router, 'via_router': bool(router), 'served_model': served,
            'response_status': meta.get('status'), 'terminal': meta.get('terminal'), 'error_code': meta.get('error_code'),
            'incomplete_reason': meta.get('incomplete_reason'), 'error_shape': meta.get('error_shape'), 'usage': n,
            'cost_usd': round(priced['usd'], 6) if priced else None, 'priced_as': (priced or {}).get('priced_as'),
            'unpriced_estimate_usd': round(unpriced, 6) if unpriced else None,
            'prev_prompt': prev_prompt, 'prev_model': prev_model,
            'upstream_request_id': resp.getheader('x-amzn-requestid') or resp.getheader('x-request-id'),
            'run_spent_usd': round(route.spent_usd, 6),
        })
        rec.update(self._extra_meta(route, meta))
        self.server.on_call(rec)


def _json_meta(raw: bytes) -> dict[str, Any]:
    try:
        j = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(j, dict):
        return {}
    err = j.get('error') if isinstance(j.get('error'), dict) else {}
    # Shape of an error body, no text (deepswe-harbor's error origin): the router's own errors are {"error": "<str>"},
    # Bedrock's are {"error": {...}}, others (e.g. a gateway's) {"message": ...}.
    shape = ('error-object' if err else 'error-string' if isinstance(j.get('error'), str)
             else 'message' if 'message' in j or 'Message' in j else None)
    return {'status': j.get('status'), 'model': j.get('model'), 'usage': j.get('usage'), 'response_id': j.get('id'),
            'error_code': (str(err.get('code') or err.get('type'))[:60] if err else None), 'error_shape': shape}
