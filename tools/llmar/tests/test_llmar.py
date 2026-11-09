"""llmar CLI tests (17 §3.9): the CLI runs as a subprocess against a fake IdP on 127.0.0.1. No AWS, no network
beyond loopback, no real tokens (the fake IdP mints them at runtime)."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import stat
import subprocess  # nosec B404 - fixed argv: this interpreter + the llmar script
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest

HERE = pathlib.Path(__file__).resolve().parent
LLMAR = HERE.parent / 'llmar'
sys.path.insert(0, str(HERE))
from fake_idp import FakeIdP  # noqa: E402

_loader = importlib.machinery.SourceFileLoader('llmar_mod', str(LLMAR))
_spec = importlib.util.spec_from_loader('llmar_mod', _loader)
llmar = importlib.util.module_from_spec(_spec)
_loader.exec_module(llmar)

NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_ports(n: int) -> list:
    socks = [socket.socket() for _ in range(n)]
    for s in socks:
        s.bind(('127.0.0.1', 0))
    ports = [s.getsockname()[1] for s in socks]
    for s in socks:
        s.close()
    return ports


class Env:
    def __init__(self, tmp: pathlib.Path, idp: FakeIdP, ports: list):
        self.tmp, self.idp, self.ports = tmp, idp, ports
        self.cfg = tmp / 'cfg' / 'llmar'
        self.env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(tmp), 'LLMAR_CONFIG_DIR': str(self.cfg),
                    'NO_PROXY': '*', 'no_proxy': '*'}
        self.settings = {'cognitoDomain': idp.url, 'clientId': idp.client_id, 'scope': idp.scope,
                         'redirectPorts': ports, 'gatewayUrl': 'https://gw.example.com', 'refreshDays': 30}

    def run(self, *args, script=LLMAR, input=None, timeout=30):
        return subprocess.run([sys.executable, '-I', str(script), *args], env=self.env, input=input, text=True,  # nosec B603: argument list, no shell; arguments are the operator's own
                              capture_output=True, timeout=timeout)

    def configure(self, **over):
        r = self.run('configure', '--from', json.dumps({**self.settings, **over}))
        assert r.returncode == 0, r.stderr
        return r

    def start_login(self, *args):
        p = subprocess.Popen([sys.executable, '-I', str(LLMAR), 'login', '--no-browser', *args], env=self.env,  # nosec B603: argument list, no shell; arguments are the operator's own
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        lines = []
        url = None
        for line in p.stderr:
            lines.append(line)
            if line.strip().startswith('http') and '/oauth2/authorize?' in line:
                url = line.strip()
            if line.startswith('Waiting for the sign-in'):
                break
        return p, url, lines

    def finish(self, p, lines):
        out, err = p.communicate(timeout=30)
        return p.returncode, out, ''.join(lines) + err

    def browse(self, url):
        """The browser: follow the IdP's 302 to the CLI's loopback callback."""
        try:
            with NOPROXY.open(url, timeout=10) as r:
                return r.status, dict(r.headers), r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read().decode()

    def login(self):
        p, url, lines = self.start_login()
        assert url, ''.join(lines)
        status, _, _ = self.browse(url)
        rc, out, err = self.finish(p, lines)
        assert rc == 0 and status == 200, err
        return out, err

    def creds(self) -> dict:
        return json.loads((self.cfg / 'credentials-default.json').read_text())

    def set_creds(self, **kv):
        path = self.cfg / 'credentials-default.json'
        c = {**self.creds(), **kv}
        path.write_text(json.dumps(c))  # keeps the file's 0600 mode

    def expire_in(self, left: float, life: float = 1800):
        """Cached token with `left` seconds to go out of a `life`-second lifetime (margin 300 s for 1800)."""
        now = time.time()
        self.set_creds(expiresAt=now + left, obtainedAt=now + left - life)

    def assert_no_secret(self, *texts):
        for t in texts:
            for v in self.idp.issued:
                assert v not in t


@pytest.fixture
def env(tmp_path):
    ports = free_ports(2)
    idp = FakeIdP(ports=tuple(ports)).start()
    try:
        yield Env(tmp_path, idp, ports)
    finally:
        idp.stop()


@pytest.fixture
def signed_in(env):
    env.configure()
    env.login()
    return env


# ---------------------------------------------------------------- unit

def test_pkce_rfc7636_vector():
    assert llmar.pkce_challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') == 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'


def test_endpoint_rules():
    assert llmar.endpoint('https://x.auth.example.com/', 'e') == 'https://x.auth.example.com'
    assert llmar.endpoint('http://127.0.0.1:9/oauth2/token', 'e') == 'http://127.0.0.1:9/oauth2/token'
    for bad in ('http://idp.example.com', 'ftp://x', 'https://u:p@x.example.com', 'https://x.example.com/?a=1', ''):
        with pytest.raises(llmar.CliError):
            llmar.endpoint(bad, 'e')


def test_margin_short_lived_tokens_refresh_at_half_life():
    assert llmar.margin({'obtainedAt': 0, 'expiresAt': 1800}) == 300
    assert llmar.margin({'obtainedAt': 0, 'expiresAt': 100}) == 50


# ---------------------------------------------------------------- configure

def test_configure_writes_private_files_and_fills_endpoints(env):
    r = env.configure(codexOauthPort=52820, schemaVersion=1, colour='blue')
    assert 'ignoring unknown setting(s): colour' in r.stderr
    cfg = json.loads((env.cfg / 'config.json').read_text())
    s = cfg['profiles']['default']
    assert s['tokenEndpoint'] == env.idp.url + '/oauth2/token' and s['identityHeader'] == 'x-api-key'
    assert stat.S_IMODE((env.cfg / 'config.json').stat().st_mode) == 0o600
    assert stat.S_IMODE(env.cfg.stat().st_mode) == 0o700
    shown = env.run('configure', '--show')
    assert shown.returncode == 0 and json.loads(shown.stdout)['clientId'] == env.idp.client_id


@pytest.mark.parametrize('over', [
    {'cognitoDomain': 'http://idp.example.com'},          # plain http off loopback
    {'clientId': 'bad id'},
    {'scope': 'openid'},                                  # no router scope
    {'redirectPorts': []}, {'redirectPorts': [80]}, {'redirectPorts': ['52817']},
    {'identityHeader': 'authorization'},
])
def test_configure_rejects(env, over):
    r = env.run('configure', '--from', json.dumps({**env.settings, **over}))
    assert r.returncode == 4 and r.stdout == ''


def test_configure_from_stdin_and_file(env, tmp_path):
    assert env.run('configure', '--from', '-', input=json.dumps(env.settings)).returncode == 0
    f = tmp_path / 's.json'
    f.write_text(json.dumps({**env.settings, 'identityHeader': None}))
    assert env.run('configure', '--profile', 'other', '--from', f'@{f}').returncode == 0
    assert json.loads(env.run('configure', '--profile', 'other', '--show').stdout)['identityHeader'] is None


def test_usage_errors_exit_4_not_2(env):
    assert env.run('frobnicate').returncode == 4
    assert env.run('token', '--profile', '../x').returncode == 4


# ---------------------------------------------------------------- login

def test_login_happy_path(env):
    env.configure()
    p, url, lines = env.start_login()
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
    assert q['code_challenge_method'] == 'S256' and q['redirect_uri'] == f'http://127.0.0.1:{env.ports[0]}/callback'
    assert set(q['scope'].split()) == {'openid', 'llmar/invoke'} and q['state'] and q['nonce']
    status, headers, body = env.browse(url)
    rc, out, err = env.finish(p, lines)
    assert rc == 0 and status == 200 and 'Signed in' in body and '已登录' in body
    assert headers.get('Cache-Control') == 'no-store' and headers.get('Referrer-Policy') == 'no-referrer'
    assert 'Signed in as alice' in err
    c = env.creds()
    assert stat.S_IMODE((env.cfg / 'credentials-default.json').stat().st_mode) == 0o600
    assert c['refreshToken'] in env.idp.refresh_tokens and c['username'] == 'alice' and c['groups'] == ['member']
    assert 'idToken' not in c and not any(k.lower().startswith('id_token') for k in c)
    # token exchange was a public-client PKCE exchange
    assert ('authorization_code', ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']) in env.idp.grants
    env.assert_no_secret(out, err, body)


def test_login_ignores_forged_callback_then_completes(env):
    env.configure()
    p, url, lines = env.start_login()
    forged = f'http://127.0.0.1:{env.ports[0]}/callback?code=x&state=not-the-state'
    assert env.browse(forged)[0] == 400
    assert env.browse(f'http://127.0.0.1:{env.ports[0]}/favicon.ico')[0] == 404
    assert p.poll() is None   # still waiting
    assert env.browse(url)[0] == 200
    assert env.finish(p, lines)[0] == 0


def test_login_port_fallback(env):
    env.configure()
    s = socket.socket()
    s.bind(('127.0.0.1', env.ports[0]))
    s.listen(1)
    try:
        p, url, lines = env.start_login()
        assert f'127.0.0.1%3A{env.ports[1]}%2Fcallback' in url
        env.browse(url)
        assert env.finish(p, lines)[0] == 0
    finally:
        s.close()


def test_login_all_ports_busy(env):
    env.configure()
    socks = []
    for port in env.ports:
        s = socket.socket()
        s.bind(('127.0.0.1', port))
        s.listen(1)
        socks.append(s)
    try:
        r = env.run('login', '--no-browser')
        assert r.returncode == 4 and 'all in use' in r.stderr
    finally:
        for s in socks:
            s.close()


def test_login_port_must_be_registered(env):
    env.configure()
    assert env.run('login', '--no-browser', '--port', '1234').returncode == 4


@pytest.mark.parametrize('knob,expect', [
    ({'authorize_error': 'access_denied'}, 'access_denied'),
    ({'wrong_nonce': True}, 'nonce'),
    ({'no_id_token': True}, 'nonce'),
    ({'no_refresh_token': True}, 'no refresh token'),
])
def test_login_failures_store_nothing(env, knob, expect):
    env.configure()
    env.idp.mode.update(knob)
    p, url, lines = env.start_login()
    env.browse(url)
    rc, out, err = env.finish(p, lines)
    assert rc == 2 and expect in err and out == ''
    assert not (env.cfg / 'credentials-default.json').exists()


@pytest.mark.parametrize('knob,expect', [
    ({'at_scope': 'openid'}, 'does not grant llmar/invoke'),
    ({'at_client_id': 'otherclient'}, 'another app client'),
    ({'at_token_use': 'id'}, 'did not return an access token'),
])
def test_login_checks_access_token_claims(env, knob, expect):
    env.configure()
    env.idp.mode.update(knob)
    p, url, lines = env.start_login()
    env.browse(url)
    rc, out, err = env.finish(p, lines)
    assert rc == 2 and expect in err and out == ''
    assert not (env.cfg / 'credentials-default.json').exists()
    env.assert_no_secret(err)


def test_parent_dir_writable_by_others_refused(env, tmp_path):
    shared = tmp_path / 'shared'
    shared.mkdir()
    os.chmod(shared, 0o777)
    env.env['LLMAR_CONFIG_DIR'] = str(shared / 'llmar')
    r = env.run('configure', '--from', json.dumps(env.settings))
    assert r.returncode == 4 and 'sticky' in r.stderr
    os.chmod(shared, 0o1777)   # sticky, like /tmp: allowed
    assert env.run('configure', '--from', json.dumps(env.settings)).returncode == 0
    os.chmod(shared, 0o700)


def test_login_timeout(env):
    env.configure()
    r = env.run('login', '--no-browser', '--timeout', '1')
    assert r.returncode == 2 and 'timed out' in r.stderr


# ---------------------------------------------------------------- token

def test_token_fast_path_no_network(signed_in):
    env = signed_in
    env.idp.stop()   # nothing to talk to
    r = env.run('token')
    assert r.returncode == 0 and r.stdout == env.creds()['accessToken'] + '\n'
    alias_dir = env.tmp / 'bin'
    alias_dir.mkdir()
    (alias_dir / 'llmar-token').symlink_to(LLMAR)
    r2 = env.run(script=alias_dir / 'llmar-token')
    assert r2.returncode == 0 and r2.stdout == r.stdout and r2.stderr == ''
    j = json.loads(env.run('token', '--json').stdout)
    assert j['access_token'] == r.stdout.strip() and j['expires_at'] == int(env.creds()['expiresAt'])


def test_token_refreshes_within_margin_without_rotation(signed_in):
    env = signed_in
    old = env.creds()
    env.expire_in(100)
    r = env.run('token')
    c = env.creds()
    assert r.returncode == 0 and r.stdout.strip() == c['accessToken'] != old['accessToken']
    assert env.idp.counts['refresh'] == 1 and c['refreshToken'] == old['refreshToken'] and c['refreshCount'] == 1
    assert ('refresh_token', ['client_id', 'grant_type', 'refresh_token']) in env.idp.grants
    env.assert_no_secret(r.stderr)


def test_token_refresh_with_rotation_stores_new_refresh_token(signed_in):
    env = signed_in
    env.idp.mode['rotation'] = True
    old_rt = env.creds()['refreshToken']
    env.expire_in(10)
    assert env.run('token').returncode == 0
    new_rt = env.creds()['refreshToken']
    assert new_rt != old_rt and env.idp.refresh_tokens[new_rt]['valid'] and not env.idp.refresh_tokens[old_rt]['valid']
    env.expire_in(10)
    assert env.run('token').returncode == 0 and env.idp.counts['refresh'] == 2


def test_token_invalid_grant_signs_out(signed_in):
    env = signed_in
    env.idp.mode['refresh_fail'] = 'invalid_grant'
    env.expire_in(10)
    r = env.run('token')
    assert r.returncode == 2 and r.stdout == '' and 'run llmar login' in r.stderr and 'invalid_grant' in r.stderr
    assert 'Refresh Token has been revoked' not in r.stderr   # only the error code, never the description
    c = env.creds()
    assert 'refreshToken' not in c and 'accessToken' not in c and c['revokedAt']
    st = env.run('status')
    assert st.returncode == 2 and 'refused' in st.stdout
    assert env.run('token').returncode == 2


def test_token_idp_down_uses_cached_token_until_expiry(signed_in):
    env = signed_in
    env.idp.mode['refresh_fail'] = 500
    env.expire_in(120)
    r = env.run('token')
    assert r.returncode == 0 and r.stdout.strip() == env.creds()['accessToken'] and 'using the cached token' in r.stderr
    env.expire_in(-5)
    r = env.run('token')
    assert r.returncode == 3 and r.stdout == ''


def test_token_unreachable_idp_exit_3(signed_in):
    env = signed_in
    env.idp.stop()
    env.expire_in(-5)
    r = env.run('token')
    assert r.returncode == 3 and r.stdout == '' and 'unreachable' in r.stderr


def test_token_concurrent_callers_refresh_once(signed_in):
    env = signed_in
    env.idp.mode['refresh_delay_s'] = 0.5
    env.expire_in(10)
    procs = [subprocess.Popen([sys.executable, '-I', str(LLMAR), 'token'], env=env.env, stdout=subprocess.PIPE,  # nosec B603: argument list, no shell; arguments are the operator's own
                              stderr=subprocess.PIPE, text=True) for _ in range(20)]
    outs = [p.communicate(timeout=60) for p in procs]
    assert all(p.returncode == 0 for p in procs), [o[1] for o in outs]
    assert env.idp.counts['refresh'] == 1
    assert len({o[0] for o in outs}) == 1 and outs[0][0].strip() == env.creds()['accessToken']


def test_token_refuses_readable_credentials(signed_in):
    env = signed_in
    os.chmod(env.cfg / 'credentials-default.json', 0o644)
    r = env.run('token')
    assert r.returncode == 4 and r.stdout == '' and 'chmod 600' in r.stderr


def test_token_bound_to_the_settings_it_signed_in_with(signed_in):
    env = signed_in
    other = FakeIdP(ports=tuple(env.ports)).start()
    try:
        env.configure(cognitoDomain=other.url)
        env.expire_in(10)
        r = env.run('token')
        assert r.returncode == 2 and 'settings changed' in r.stderr
        assert other.counts['refresh'] == 0 and env.idp.counts['refresh'] == 0   # refresh token sent nowhere
    finally:
        other.stop()


def test_token_not_signed_in(env):
    env.configure()
    r = env.run('token')
    assert r.returncode == 2 and r.stdout == '' and 'not signed in' in r.stderr


def test_token_not_configured(env):
    r = env.run('token')
    assert r.returncode == 4 and 'llmar configure' in r.stderr


# ---------------------------------------------------------------- headers, status, logout

def test_headers_follow_identity_header_setting(signed_in):
    env = signed_in
    t = env.creds()['accessToken']
    assert env.run('headers').stdout == f'authorization: Bearer {t}\nx-api-key: {t}\n'
    env.configure(identityHeader='x-router-identity')
    assert env.run('headers').stdout == f'authorization: Bearer {t}\nx-router-identity: {t}\n'
    env.configure(identityHeader=None)
    assert env.run('headers').stdout == f'authorization: Bearer {t}\n'


def test_status_shows_no_token_values(signed_in):
    env = signed_in
    r = env.run('status')
    assert r.returncode == 0 and 'alice' in r.stdout and 'groups:    member' in r.stdout and 'sign in again by' in r.stdout
    env.assert_no_secret(r.stdout, r.stderr)


def test_logout_revokes_and_deletes(signed_in):
    env = signed_in
    rt = env.creds()['refreshToken']
    r = env.run('logout')
    assert r.returncode == 0 and env.idp.revoked == [rt]
    assert not (env.cfg / 'credentials-default.json').exists()
    assert env.run('token').returncode == 2
    assert env.run('logout').returncode == 0


def test_logout_idp_down_still_deletes_locally(signed_in):
    env = signed_in
    env.idp.stop()
    r = env.run('logout')
    assert r.returncode == 3 and 'could not be revoked' in r.stderr
    assert not (env.cfg / 'credentials-default.json').exists()


def test_world_writable_config_dir_refused(signed_in):
    env = signed_in
    os.chmod(env.cfg, 0o777)
    try:
        assert env.run('token').returncode == 4
    finally:
        os.chmod(env.cfg, 0o700)


def test_existing_readable_config_dir_is_tightened(env):
    env.cfg.mkdir(parents=True, mode=0o755)
    os.chmod(env.cfg, 0o755)
    env.configure()
    assert stat.S_IMODE(env.cfg.stat().st_mode) == 0o700


def test_symlinked_credentials_refused(signed_in):
    env = signed_in
    real = env.cfg / 'credentials-default.json'
    moved = env.tmp / 'elsewhere.json'
    real.rename(moved)
    real.symlink_to(moved)
    r = env.run('token')
    assert r.returncode == 4 and r.stdout == ''


def test_callback_listener_is_loopback_only(env):
    env.configure()
    p, url, lines = env.start_login()
    try:
        ss = shutil.which('ss')
        out = subprocess.run([ss, '-ltnH'], capture_output=True, text=True).stdout if ss else ''  # nosec B603
        if out:
            mine = [line for line in out.splitlines() if f':{env.ports[0]} ' in line]
            assert mine and all('127.0.0.1:' in line for line in mine)
    finally:
        env.browse(url)
        env.finish(p, lines)

