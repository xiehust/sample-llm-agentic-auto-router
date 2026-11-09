"""Gateway access tokens (design §5, D5): a fresh Cognito client-credentials token per run.

The client secret is read from Secrets Manager (`llmar-runner/client`, created by the parent; the runner role may
read exactly that secret) and kept in memory only. Tokens live in the proxy's route table for one run and are never
printed, logged or written. Expected secret value (JSON):

  {"client_id": "...", "client_secret": "...", "token_url": "https://<domain>/oauth2/token", "scope": "<prefix>/invoke"}
"""
from __future__ import annotations

import base64
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

SECRET_ID = 'llmar-runner/client'  # nosec B105: a Secrets Manager name or test argument, not a credential
REQUIRED = ('client_id', 'client_secret', 'token_url', 'scope')


class AuthError(Exception):
    """Message never contains the secret, the token or a response body."""


def parse_secret(secret_string: str) -> dict[str, str]:
    try:
        s = json.loads(secret_string)
    except ValueError as e:
        raise AuthError('secret value is not JSON') from e
    missing = [k for k in REQUIRED if not isinstance(s.get(k), str) or not s.get(k)]
    if missing:
        raise AuthError(f'secret value is missing {missing}')
    u = urllib.parse.urlsplit(s['token_url'])
    if u.scheme != 'https' or not u.hostname or not u.path.endswith('/oauth2/token'):
        raise AuthError('token_url must be the https Cognito /oauth2/token endpoint')
    return {k: s[k] for k in REQUIRED}


def read_secret(region: str, secret_id: str) -> dict[str, str]:
    import boto3  # lazy: only the live commands need it

    v = boto3.client('secretsmanager', region_name=region).get_secret_value(SecretId=secret_id)
    return parse_secret(v['SecretString'])


class TokenMinter:
    """mint() → (access_token, expires_at). One HTTPS POST per call; nothing cached across runs."""

    def __init__(self, secret: dict[str, str], post: Callable[[str, bytes, dict[str, str]], tuple[int, bytes]] | None = None,
                 clock: Callable[[], float] = time.time):
        self._secret = secret
        self._post = post or _https_post
        self._clock = clock
        self._lock = threading.Lock()

    def mint(self) -> tuple[str, float]:
        s = self._secret
        basic = base64.b64encode(f"{s['client_id']}:{s['client_secret']}".encode()).decode()
        data = urllib.parse.urlencode({'grant_type': 'client_credentials', 'scope': s['scope']}).encode()
        with self._lock:
            status, body = self._post(s['token_url'], data, {'authorization': f'Basic {basic}',
                                                             'content-type': 'application/x-www-form-urlencoded'})
        if status != 200:
            raise AuthError(f'token endpoint HTTP {status}')
        try:
            j: dict[str, Any] = json.loads(body)
            token = j['access_token']
            ttl = int(j.get('expires_in', 3600))
        except (ValueError, KeyError, TypeError) as e:
            raise AuthError('token endpoint returned an unexpected body') from e
        if not isinstance(token, str) or not token:
            raise AuthError('token endpoint returned no access token')
        return token, self._clock() + ttl


class RunToken:
    """The token provider handed to one proxy route. Re-mints if the run outlives the token (minus 2 minutes)."""

    def __init__(self, minter: TokenMinter, clock: Callable[[], float] = time.time):
        self._minter = minter
        self._clock = clock
        self._lock = threading.Lock()
        self._token, self._exp = minter.mint()
        self.mints = 1

    def __call__(self) -> str:
        with self._lock:
            if self._clock() > self._exp - 120:
                self._token, self._exp = self._minter.mint()
                self.mints += 1
            return self._token

    def __repr__(self) -> str:  # never show the token
        return f'RunToken(mints={self.mints})'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Review L6: a redirect from the token endpoint is answered as its own status, never followed (the Basic
    credentials must not be replayed to another URL)."""

    def redirect_request(self, *args, **kwargs):  # noqa: ANN002, ANN003
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _https_post(url: str, data: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
    if not url.startswith('https://'):
        raise AuthError('token_url must be https')
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    try:
        with _OPENER.open(req, timeout=30) as r:  # nosec B310 - https token endpoint from the secret
            return r.status, r.read(65536)
    except urllib.error.HTTPError as e:
        return e.code, b''
