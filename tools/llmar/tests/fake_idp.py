"""A fake Cognito-style OAuth server for the llmar tests: /oauth2/authorize, /oauth2/token, /oauth2/revoke on
127.0.0.1 (ephemeral port). Checks what Cognito checks for a public client: registered redirect URI (exact port),
PKCE S256, single-use codes, refresh-token validity. Tokens are unsigned JWT-shaped strings minted at runtime.
Knobs in `mode`: rotation, refresh_fail ('invalid_grant' | 500), refresh_delay_s, authorize_error, wrong_nonce,
no_id_token, no_refresh_token, expires_in."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.parse
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def jwt(claims: dict) -> str:
    head = b64url(json.dumps({'alg': 'none', 'kid': 'test'}).encode())
    return f'{head}.{b64url(json.dumps(claims).encode())}.{b64url(secrets.token_bytes(16))}'


class FakeIdP:
    def __init__(self, client_id: str = 'testclient', ports: tuple = (), scope: str = 'llmar/invoke'):
        self.client_id, self.ports, self.scope = client_id, set(ports), scope
        self.mode: dict = {'expires_in': 1800}
        self.codes: dict = {}
        self.refresh_tokens: dict = {}     # token -> {'valid': bool}
        self.issued: list = []             # every secret value handed out (leak checks)
        self.counts: Counter = Counter()
        self.grants: list = []             # form field names + grant type per token call (no values)
        self.revoked: list = []
        self.lock = threading.Lock()
        idp = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                if u.path != '/oauth2/authorize':
                    return self._json(404, {})
                idp.counts['authorize'] += 1
                q = dict(urllib.parse.parse_qsl(u.query))
                ru = urllib.parse.urlsplit(q.get('redirect_uri', ''))
                ok = (q.get('response_type') == 'code' and q.get('client_id') == idp.client_id
                      and ru.scheme == 'http' and ru.hostname == '127.0.0.1' and ru.port in idp.ports
                      and ru.path == '/callback' and q.get('code_challenge_method') == 'S256'
                      and len(q.get('code_challenge', '')) == 43 and q.get('state') and q.get('nonce')
                      and set(q.get('scope', '').split()) == {'openid', idp.scope})
                if not ok:
                    return self._json(400, {'error': 'invalid_request'})
                idp.last_authorize = q
                if idp.mode.get('authorize_error'):
                    err = {'error': idp.mode['authorize_error'], 'state': q['state']}
                    loc = q['redirect_uri'] + '?' + urllib.parse.urlencode(err)
                else:
                    code = secrets.token_urlsafe(24)
                    idp.codes[code] = {k: q[k] for k in ('code_challenge', 'redirect_uri', 'nonce', 'client_id')}
                    loc = q['redirect_uri'] + '?' + urllib.parse.urlencode({'code': code, 'state': q['state']})
                self.send_response(302)
                self.send_header('Location', loc)
                self.send_header('Content-Length', '0')
                self.end_headers()

            def do_POST(self):
                n = int(self.headers.get('Content-Length') or 0)
                f = dict(urllib.parse.parse_qsl(self.rfile.read(n).decode()))
                path = urllib.parse.urlsplit(self.path).path
                if path == '/oauth2/revoke':
                    idp.counts['revoke'] += 1
                    with idp.lock:
                        if f.get('token') in idp.refresh_tokens and f.get('client_id') == idp.client_id:
                            idp.refresh_tokens[f['token']]['valid'] = False
                            idp.revoked.append(f['token'])
                    return self._json(200, {})
                if path != '/oauth2/token':
                    return self._json(404, {})
                g = f.get('grant_type')
                idp.grants.append((g, sorted(f)))
                if f.get('client_id') != idp.client_id or 'client_secret' in f:
                    return self._json(400, {'error': 'invalid_client'})
                if g == 'authorization_code':
                    idp.counts['code'] += 1
                    c = idp.codes.pop(f.get('code', ''), None)   # single use
                    if (not c or c['redirect_uri'] != f.get('redirect_uri')
                            or b64url(hashlib.sha256(f.get('code_verifier', '').encode()).digest()) != c['code_challenge']):
                        return self._json(400, {'error': 'invalid_grant'})
                    return self._json(200, idp.tokens(nonce=c['nonce'], with_refresh=not idp.mode.get('no_refresh_token'),
                                                      with_id=not idp.mode.get('no_id_token')))
                if g == 'refresh_token':
                    idp.counts['refresh'] += 1
                    time.sleep(idp.mode.get('refresh_delay_s', 0))
                    fail = idp.mode.get('refresh_fail')
                    if fail == 500:
                        return self._json(500, {'error': 'internal'})
                    with idp.lock:
                        rt = idp.refresh_tokens.get(f.get('refresh_token', ''))
                        if fail == 'invalid_grant' or not rt or not rt['valid']:
                            return self._json(400, {'error': 'invalid_grant',
                                                    'error_description': 'Refresh Token has been revoked'})
                        out = idp.tokens(nonce=None, with_refresh=bool(idp.mode.get('rotation')), with_id=True)
                        if idp.mode.get('rotation'):
                            rt['valid'] = False
                    return self._json(200, out)
                return self._json(400, {'error': 'unsupported_grant_type'})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.last_authorize: dict = {}
        self.stopped = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def tokens(self, nonce, with_refresh: bool, with_id: bool) -> dict:
        now = int(time.time())
        exp = int(self.mode.get('expires_in', 1800))
        sub = 'a1b2c3d4-0000-4000-8000-00000000test'
        at = jwt({'sub': sub, 'client_id': self.mode.get('at_client_id', self.client_id),
                  'scope': self.mode.get('at_scope', self.scope), 'token_use': self.mode.get('at_token_use', 'access'),
                  'username': 'alice', 'cognito:groups': ['member'], 'iat': now, 'exp': now + exp})
        out = {'access_token': at, 'token_type': 'Bearer', 'expires_in': exp}
        self.issued.append(at)
        if with_id:
            claims = {'sub': sub, 'aud': self.client_id, 'token_use': 'id', 'cognito:username': 'alice',
                      'iat': now, 'exp': now + exp}
            if nonce is not None:
                claims['nonce'] = 'wrong' if self.mode.get('wrong_nonce') else nonce
            out['id_token'] = jwt(claims)
            self.issued.append(out['id_token'])
        if with_refresh:
            rt = secrets.token_urlsafe(48)
            self.refresh_tokens[rt] = {'valid': True}
            out['refresh_token'] = rt
            self.issued.append(rt)
        return out

    def start(self) -> 'FakeIdP':
        self.thread.start()
        return self

    def stop(self) -> None:   # idempotent: tests stop it early to simulate an unreachable IdP
        if not self.stopped:
            self.stopped = True
            self.server.shutdown()
            self.server.server_close()
