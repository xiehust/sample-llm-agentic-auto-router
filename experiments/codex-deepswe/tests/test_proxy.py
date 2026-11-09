"""Egress proxy: every refusal the design review asked for (R3, F2), and a forwarding round trip against a local fake upstream."""
import http.client
import http.server
import json
import socket
import threading

import pytest

import proxy as px

TOKEN = 'tok-SECRET-VALUE-123'  # nosec B105: fake test fixture, not a credential


# ---------------------------------------------------------------- bind and destination checks

@pytest.mark.parametrize('host', ['0.0.0.0', '::', '', '*'])  # nosec B104: this check refuses wildcard hosts; not a bind
def test_bind_unspecified_refused(host):
    with pytest.raises(px.Refused) as e:
        px.check_bind(host)
    assert e.value.code == 'bind-unspecified'


def test_bind_public_and_loopback_refused():
    with pytest.raises(px.Refused):
        px.check_bind('8.8.8.8')
    with pytest.raises(px.Refused):
        px.check_bind('127.0.0.1')
    assert px.check_bind('172.18.0.1') == '172.18.0.1'
    assert px.check_bind('127.0.0.1', allow_loopback=True) == '127.0.0.1'
    with pytest.raises(px.Refused):
        px.EgressProxy('0.0.0.0', 0, px.Upstreams(None, 'ap-southeast-1'), on_call=lambda r: None)  # nosec B104: this check refuses wildcard hosts; not a bind


@pytest.mark.parametrize('ip', ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254', '127.0.0.1', '::1', '10.0.0.5',  # nosec B104: this check refuses wildcard hosts; not a bind
                                '172.16.3.4', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::ffff:169.254.169.254', 'fe80::1', '224.0.0.1'])
def test_denied_addresses(ip):
    assert px.denied_address(ip)


def test_public_address_allowed():
    assert not px.denied_address('52.95.110.1')
    assert not px.denied_address('2600:1f18::1')


def _resolver(*ips):
    return lambda host, port, family=0, type=0: [(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, port)) for ip in ips]


def test_resolve_refuses_any_denied_address():
    assert px.resolve_public('x', 443, _resolver('52.95.110.1')) == '52.95.110.1'
    with pytest.raises(px.Refused) as e:
        px.resolve_public('x', 443, _resolver('52.95.110.1', '169.254.169.254'))
    assert e.value.code == 'upstream-denied-address'
    with pytest.raises(px.Refused):
        px.resolve_public('x', 443, _resolver('10.1.2.3'))


def test_only_two_upstream_hosts():
    u = px.Upstreams('https://gw.example.amazonaws.com/mcp', 'ap-southeast-1', resolver=_resolver('52.95.110.1'),
                     connect=lambda h, ip, t: (h, ip))
    assert u.allowed() == {'gw.example.amazonaws.com', 'bedrock-runtime.ap-southeast-1.amazonaws.com'}
    assert u.target('gateway', 'responses') == ('gw.example.amazonaws.com', '/inference/v1/responses')
    assert u.target('bedrock', 'responses') == ('bedrock-runtime.ap-southeast-1.amazonaws.com', '/openai/v1/responses')
    with pytest.raises(px.Refused):
        u.target('bedrock', 'models')
    with pytest.raises(px.Refused) as e:
        u.open('evil.example.com')
    assert e.value.code == 'upstream-not-allowed'
    assert u.open('gw.example.amazonaws.com') == ('gw.example.amazonaws.com', '52.95.110.1')
    for bad in ('http://gw.example.com', 'https://gw.example.com:8443', 'https://u:p@gw.example.com', 'https://gw.example.com/?a=1'):
        with pytest.raises(ValueError):
            px.Upstreams(bad, 'ap-southeast-1')


# ---------------------------------------------------------------- HTTP behaviour against a fake upstream

class FakeUpstream(http.server.ThreadingHTTPServer):
    def __init__(self):
        self.seen = []
        self.reply = 'sse'
        super().__init__(('127.0.0.1', 0), _Up)


class _Up(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        self.server.seen.append({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': self.rfile.read(n)})
        if self.server.reply in ('gateway-octet-crlf', 'no-ctype-sse', 'linger-after-terminal'):
            usage = {'input_tokens': 2000, 'input_tokens_details': {'cached_tokens': 1500}, 'output_tokens': 100}
            evs = [{'type': 'response.created', 'response': {'id': 'r1'}},
                   {'type': 'response.completed', 'response': {'id': 'r1', 'status': 'completed', 'model': 'gpt-6-luna', 'usage': usage}}]
            sep = '\r\n' if self.server.reply == 'gateway-octet-crlf' else '\n'
            data = ''.join(f"event: {e['type']}{sep}data: {json.dumps(e)}{sep}{sep}" for e in evs).encode()
            self.send_response(200)
            if self.server.reply == 'gateway-octet-crlf':
                self.send_header('content-type', 'application/octet-stream')
            self.send_header('x-router-model', 'global.openai.gpt-6-luna')
            self.send_header('transfer-encoding', 'chunked')
            self.end_headers()
            try:
                for i in range(0, len(data), 97):        # odd chunking: CRLF pairs split across chunks
                    part = data[i:i + 97]
                    self.wfile.write(f'{len(part):x}\r\n'.encode() + part + b'\r\n')
                    self.wfile.flush()
                if self.server.reply == 'linger-after-terminal':
                    import time
                    for _ in range(20):                     # Bedrock-like: the stream stays open after completed
                        time.sleep(0.05)
                        self.wfile.write(b'8\r\n: ping\n\n\r\n')
                        self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')
            except OSError:
                pass
            return
        if self.server.reply == 'json-ok-no-usage':
            data = json.dumps({'id': 'r1', 'status': 'completed', 'model': 'gpt-6.1-sol'}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.server.reply == 'sse':
            usage = {'input_tokens': 2000, 'input_tokens_details': {'cached_tokens': 1500}, 'output_tokens': 100}
            evs = [{'type': 'response.created', 'response': {'id': 'r1'}},
                   {'type': 'response.completed', 'response': {'id': 'r1', 'status': 'completed', 'model': 'gpt-6.1-sol', 'usage': usage}}]
            data = b''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in evs)
            ct = 'text/event-stream'
        else:
            data = json.dumps({'error': {'code': 'bad_request'}}).encode()
            ct = 'application/json'
        self.send_response(200 if self.server.reply == 'sse' else 400)
        self.send_header('content-type', ct)
        self.send_header('x-router-decision', 'pin;pinned;auto')
        self.send_header('x-router-model', 'global.openai.gpt-6.1-sol')
        self.send_header('set-cookie', 'should-not-pass=1')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture()
def rig():
    up = FakeUpstream()
    threading.Thread(target=up.serve_forever, daemon=True).start()
    calls = []
    ups = px.Upstreams('https://gw.example.amazonaws.com', 'ap-southeast-1', resolver=_resolver('52.95.110.1'),
                       connect=lambda h, ip, t: http.client.HTTPConnection('127.0.0.1', up.server_address[1], timeout=t),
                       signer=lambda m, url, body, h: {**h, 'authorization': 'AWS4-HMAC-SHA256 Credential=FAKE', 'x-amz-date': '20261105T000000Z',
                                                       'x-amz-security-token': 'SESSION-TOKEN-XYZ'})
    srv = px.EgressProxy('127.0.0.1', 0, ups, on_call=calls.append, allow_loopback_bind=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv, up, calls
    srv.shutdown()
    up.shutdown()


def _req(srv, method, path, body=None, headers=None, raw=None):
    c = http.client.HTTPConnection(*srv.server_address[:2], timeout=10)
    if raw is not None:
        s = socket.create_connection(srv.server_address[:2], timeout=5)
        s.sendall(raw)
        data = b''
        while chunk := s.recv(65536):
            data += chunk
        s.close()
        return int(data.split(b' ')[1]), data
    c.request(method, path, body=body, headers=headers or {})
    r = c.getresponse()
    return r.status, r.read(), dict(r.getheaders())


def _wait(calls, n=1):
    """The proxy writes its call record after the last body byte, so the client can finish first."""
    import time
    for _ in range(200):
        if len(calls) >= n:
            return calls[-1]
        time.sleep(0.01)
    raise AssertionError('no call record')


def _route(srv, **kw):
    r = px.Route(run_id=kw.pop('run_id', 'r-abc'), arm=kw.pop('arm', 'A'), kind=kw.pop('kind', 'gateway'),
                 hint=kw.pop('hint', 'pin=global.openai.gpt-6.1-sol'), budget_usd=kw.pop('budget_usd', 1.0),
                 token=kw.pop('token', lambda: TOKEN), **kw)
    srv.register(r)
    return r


BODY = json.dumps({'model': 'auto', 'stream': True, 'input': [{'role': 'user', 'content': 'hi'}]}).encode()


def test_forward_gateway_injects_session_hint_and_bearer(rig):
    srv, up, calls = rig
    _route(srv)
    st, data, hdrs = _req(srv, 'POST', '/r/r-abc/v1/responses', BODY,
                          {'content-type': 'application/json', 'authorization': 'Bearer not-a-credential',
                           'x-router-session': 'spoofed', 'x-router-hint': 'pin=evil', 'cookie': 'c=1', 'x-codex-turn-metadata': '{}'})
    assert st == 200 and b'response.completed' in data
    assert 'set-cookie' not in {k.lower() for k in hdrs}
    seen = up.seen[0]
    assert seen['path'] == '/inference/v1/responses'
    h = seen['headers']
    assert h['x-router-session'] == 'r-abc' and h['x-router-hint'] == 'pin=global.openai.gpt-6.1-sol'
    assert h['authorization'] == f'Bearer {TOKEN}'
    assert 'cookie' not in h and 'x-codex-turn-metadata' not in h and h['accept-encoding'] == 'identity'
    rec = _wait(calls)
    assert rec['status'] == 200 and rec['served_model'] == 'global.openai.gpt-6.1-sol' and rec['via_router']
    assert rec['usage'] == {'prompt': 2000, 'uncached': 500, 'read': 1500, 'write': 0, 'output': 100, 'reasoning': 0}
    assert rec['cost_usd'] == pytest.approx((500 * 2 + 1500 * 0.1 + 100 * 10) / 1e6)
    assert TOKEN not in json.dumps(calls) and 'Bearer' not in json.dumps(calls)


def test_session_header_added_when_codex_sends_none(rig):
    srv, up, _ = rig
    _route(srv, arm='B', hint=None)
    _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})
    h = up.seen[0]['headers']
    assert h['x-router-session'] == 'r-abc' and 'x-router-hint' not in h


def test_bedrock_route_signs_and_never_logs_sigv4(rig):
    srv, up, calls = rig
    _route(srv, arm='D', kind='bedrock', hint=None, token=None, allowed_model='global.openai.gpt-6.1-sol')
    body = json.dumps({'model': 'global.openai.gpt-6.1-sol', 'stream': True, 'input': []}).encode()
    st, *_ = _req(srv, 'POST', '/r/r-abc/v1/responses', body, {'content-type': 'application/json'})
    assert st == 200
    _wait(calls)
    h = up.seen[0]['headers']
    assert up.seen[0]['path'] == '/openai/v1/responses' and h['authorization'].startswith('AWS4-HMAC-SHA256') and 'x-router-session' not in h
    dumped = json.dumps(calls)
    assert 'SESSION-TOKEN-XYZ' not in dumped and 'AWS4-HMAC' not in dumped and 'Credential' not in dumped


def test_bedrock_route_refuses_other_models(rig):
    srv, up, calls = rig
    _route(srv, arm='D', kind='bedrock', hint=None, token=None, allowed_model='global.openai.gpt-6.1-sol')
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', json.dumps({'model': 'global.openai.gpt-6-astra'}).encode(),
                       {'content-type': 'application/json'})
    assert st == 403 and b'model-not-allowed' in data and not up.seen
    st, data, _ = _req(srv, 'GET', '/r/r-abc/v1/models')
    assert st == 200 and b'gpt-6.1-sol' in data and not up.seen   # answered locally, nothing forwarded


@pytest.mark.parametrize('method,path,code,status', [
    ('GET', '/r/r-abc/v1/responses', 'method-not-allowed', 405),
    ('POST', '/r/r-abc/v1/models', 'method-not-allowed', 405),
    ('POST', '/r/r-abc/v1/chat/completions', 'path-not-allowed', 404),
    ('POST', '/r/r-abc/v2/responses', 'path-not-allowed', 404),
    ('POST', '/v1/responses', 'path-not-allowed', 404),
    ('POST', '/r/unknown/v1/responses', 'unknown-run', 404),
    ('POST', '/r/r-abc/v1/responses/../../latest/meta-data', 'path-not-allowed', 404),
])
def test_paths_and_methods_refused(rig, method, path, code, status):
    srv, up, _ = rig
    _route(srv)
    st, data, _ = _req(srv, method, path, BODY if method == 'POST' else None, {'content-type': 'application/json'})
    assert st == status and code.encode() in data and not up.seen


@pytest.mark.parametrize('method', ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE'])
def test_other_methods_refused(rig, method):
    srv, up, _ = rig
    _route(srv)
    st, data, _ = _req(srv, method, '/r/r-abc/v1/responses', b'{}')
    assert st == 405 and not up.seen


def test_connect_and_absolute_uri_refused(rig):
    srv, up, _ = rig
    _route(srv)
    st, data = _req(srv, None, None, raw=b'CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n')
    assert st == 405 and b'method-not-allowed' in data
    st, data = _req(srv, None, None, raw=b'GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: x\r\n\r\n')
    assert st == 405 and b'absolute-uri' in data
    assert not up.seen


def test_compressed_and_oversize_bodies_refused(rig):
    srv, up, _ = rig
    _route(srv)
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json', 'content-encoding': 'zstd'})
    assert st == 415 and b'compressed-body' in data
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', b'', {'content-type': 'application/json'})
    assert st == 413
    assert not up.seen


def test_budget_stop(rig):
    srv, up, calls = rig
    r = _route(srv, budget_usd=1.0)
    assert _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})[0] == 200
    _wait(calls)
    r.spent_usd = 0.95          # the next call's worst case (Sol, 16k output) no longer fits budget + margin (0)
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})
    assert st == 429 and b'budget' in data and r.budget_stopped and len(up.seen) == 1
    assert calls[-1]['refused'] == 'budget'


def test_upstream_error_body_is_relayed_and_coded(rig):
    srv, up, calls = rig
    up.reply = 'json-error'
    _route(srv)
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})
    rec = _wait(calls)
    assert st == 400 and rec['error_code'] == 'bad_request' and rec['cost_usd'] is None


def test_register_validates():
    srv = px.EgressProxy('127.0.0.1', 0, px.Upstreams(None, 'ap-southeast-1'), on_call=lambda r: None, allow_loopback_bind=True)
    try:
        with pytest.raises(ValueError):
            srv.register(px.Route('bad id!', 'A', 'gateway', None, 1.0, token=lambda: 'x'))
        with pytest.raises(ValueError):
            srv.register(px.Route('r-1', 'A', 'gateway', None, 1.0, token=None))
        assert srv.base_url('r-1').startswith('http://127.0.0.1:') and srv.base_url('r-1').endswith('/r/r-1/v1')
    finally:
        srv.server_close()


def test_sse_tap_handles_split_events():
    tap = px.SseTap()
    ev = json.dumps({'type': 'response.completed', 'response': {'status': 'completed', 'model': 'm', 'usage': {'input_tokens': 5}}})
    raw = f'event: response.completed\ndata: {ev}\n\n'.encode()
    for i in range(0, len(raw), 7):
        tap.feed(raw[i:i + 7])
    tap.close()
    assert tap.out['terminal'] == 'response.completed' and tap.out['usage'] == {'input_tokens': 5}


# ---------------------------------------------------------------- review fixes (M1, L2, L3, L5, L9)

def test_gateway_route_allows_only_auto(rig):
    srv, up, _ = rig
    _route(srv, allowed_model='auto')
    for model in ('auto:frontier', 'global.openai.gpt-6-astra', 'AUTO', None):
        st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', json.dumps({'model': model, 'input': []}).encode(),
                           {'content-type': 'application/json'})
        assert st == 403 and b'model-not-allowed' in data
    assert not up.seen
    assert _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})[0] == 200


@pytest.mark.parametrize('ip', ['64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '::a9fe:a9fe'])
def test_translated_and_compat_ipv6_denied(ip):
    assert px.denied_address(ip)


def test_resolver_ipv4_only():
    seen = {}

    def res(host, port, family=0, type=0):
        seen['family'] = family
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, '', ('2600:1f18::1', port, 0, 0)), (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('52.95.110.1', port))]
    assert px.resolve_public('x', 443, res) == '52.95.110.1' and seen['family'] == socket.AF_INET


def test_handler_exception_is_recorded_and_502(rig, monkeypatch):
    srv, up, calls = rig
    _route(srv)
    monkeypatch.setattr(px._Handler, '_forward', lambda *a, **k: (_ for _ in ()).throw(KeyError('boom')))
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})
    assert st == 502 and _wait(calls)['error'] == 'KeyError'


def test_oversized_call_refused_by_margin(rig):
    srv, up, calls = rig
    _route(srv, budget_usd=1.0, margin_usd=0.5, worst_model='global.openai.gpt-6-astra')
    big = json.dumps({'model': 'auto', 'input': [{'role': 'user', 'content': 'x' * 900_000}]}).encode()  # ~300k tokens at 3 B/token
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', big, {'content-type': 'application/json'})
    assert st == 429 and b'budget' in data and not up.seen
    assert _wait(calls)['est_prompt_tokens'] >= 300_000


def test_unpriced_call_counts_against_budget(rig):
    srv, up, calls = rig
    up.reply = 'json-ok-no-usage'
    r = _route(srv, budget_usd=5.0)
    r.last_prompt, r.last_model = 100_000, 'global.openai.gpt-6.1-sol'
    _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})
    rec = _wait(calls)
    assert rec['cost_usd'] is None and rec['unpriced_estimate_usd'] == pytest.approx((100_000 * 2 + 4000 * 10) / 1e6)
    assert r.spent_usd == pytest.approx(rec['unpriced_estimate_usd'])


def test_tls_settings():
    import ssl
    ctx = px.tls_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname and ctx.minimum_version >= ssl.TLSVersion.TLSv1_2
    conn = px.PinnedHTTPSConnection('bedrock-runtime.ap-southeast-1.amazonaws.com', '52.95.110.1', 5)
    calls = {}

    class FakeCtx:
        def wrap_socket(self, sock, server_hostname=None):
            calls['sni'] = server_hostname
            return sock
    conn._context = FakeCtx()
    import unittest.mock as um
    with um.patch.object(px.socket, 'create_connection', lambda addr, timeout=None: calls.setdefault('addr', addr) and um.MagicMock()):
        conn.connect()
    assert calls['addr'] == ('52.95.110.1', 443) and calls['sni'] == 'bedrock-runtime.ap-southeast-1.amazonaws.com'


def test_auto_route_admission_prices_arm_b_at_worst_model(rig):
    srv, up, calls = rig
    big = json.dumps({'model': 'auto', 'input': [{'role': 'user', 'content': 'x' * 300_000}]}).encode()   # ~100k tokens
    # Arm B served by Luna so far: admission still assumes Astra (the router may switch at compaction).
    rb = _route(srv, run_id='r-b', arm='B', hint=None, allowed_model='auto', budget_usd=0.5, margin_usd=0.0, worst_model='global.openai.gpt-6-astra')
    rb.last_model, rb.last_prompt, rb.last_bytes = 'global.openai.gpt-6-luna', 1000, 1000
    st, data, _ = _req(srv, 'POST', '/r/r-b/v1/responses', big, {'content-type': 'application/json'})
    assert st == 429 and b'budget' in data           # Astra: ~100k × $10/M + 16k × $50/M ≈ $1.8 > $0.5
    # Arm A on Sol: priced at its last (pinned) model, admitted.
    ra = _route(srv, run_id='r-a', arm='A', allowed_model='auto', budget_usd=0.5, margin_usd=0.0, worst_model='global.openai.gpt-6.1-sol')
    ra.last_model, ra.last_prompt, ra.last_bytes = 'global.openai.gpt-6.1-sol', 1000, 1000
    st, *_ = _req(srv, 'POST', '/r/r-a/v1/responses', big, {'content-type': 'application/json'})
    assert st == 200



# ---------------------------------------------------------------- pilot fixes: gateway SSE detection, client close

def test_gateway_stream_with_octet_stream_and_crlf_is_priced(rig):
    srv, up, calls = rig
    up.reply = 'gateway-octet-crlf'
    _route(srv, arm='F', hint='pin=global.openai.gpt-6-luna')
    st, data, _ = _req(srv, 'POST', '/r/r-abc/v1/responses', BODY, {'content-type': 'application/json'})
    rec = _wait(calls)
    assert st == 200 and b'response.completed' in data
    assert rec['sse'] and rec['upstream_content_type'] == 'application/octet-stream' and rec['terminal'] == 'response.completed'
    assert rec['usage']['read'] == 1500 and rec['cost_usd'] == pytest.approx((500 * 0.1 + 1500 * 0.01 + 100 * 0.5) / 1e6)
    assert rec['unpriced_estimate_usd'] is None and 'error' not in rec


def test_sse_sniffed_without_content_type_or_stream_flag(rig):
    srv, up, calls = rig
    up.reply = 'no-ctype-sse'
    _route(srv)
    body = json.dumps({'model': 'auto', 'input': []}).encode()          # no "stream": true
    assert _req(srv, 'POST', '/r/r-abc/v1/responses', body, {'content-type': 'application/json'})[0] == 200
    rec = _wait(calls)
    assert rec['sse'] and rec['usage'] and rec['cost_usd']


def test_client_closing_after_terminal_is_not_an_error(rig):
    srv, up, calls = rig
    up.reply = 'linger-after-terminal'
    _route(srv)
    s = socket.create_connection(srv.server_address[:2], timeout=5)
    s.sendall(b'POST /r/r-abc/v1/responses HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: '
              + str(len(BODY)).encode() + b'\r\n\r\n' + BODY)
    got = b''
    while b'response.completed' not in got:
        got += s.recv(65536)
    s.close()                                                        # Codex stops reading once it has the terminal event
    rec = _wait(calls)
    assert rec['status'] == 200 and 'error' not in rec and rec['client_closed'] == 'after-terminal'
    assert rec['usage'] and rec['cost_usd'] and rec['unpriced_estimate_usd'] is None


def test_looks_like_sse():
    assert px.looks_like_sse('text/event-stream; charset=utf-8', False, b'{')
    assert px.looks_like_sse(None, True, b'{')
    assert px.looks_like_sse('application/octet-stream', False, b'\nevent: x\n')
    assert not px.looks_like_sse('application/json', False, b'{"id": 1}')
    assert not px.looks_like_sse('application/json', True, b'{"error": {}}')       # error reply to a stream request
    assert px.looks_like_sse('application/octet-stream', True, b'{')
