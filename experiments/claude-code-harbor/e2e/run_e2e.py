"""Mock end-to-end for Claude Code × Harbor (4f, design-harness §5.2 + §5.4). Dev box only, no AWS, no credentials.

  python3 experiments/claude-code-harbor/e2e/run_e2e.py --claude <pinned binary> [--instruction-file F] [--arms A,B,C,F]

Re-executes itself in a fresh user + network + mount namespace (unshare -rnm): loopback, plus a dummy interface that
every other IPv4/IPv6 destination routes to and that is sniffed (AF_PACKET), and an /etc/resolv.conf pointing there, so
any DNS query, TCP connect or UDP send the pinned Claude Code makes to anything but the proxy is recorded. Inside:
- the REAL router (mock_router.ts: createRouter + policy.experiment-cc, or $LLMAR_E2E_POLICY with
  $LLMAR_E2E_ASSESSOR_MODE, + Bedrock compatibility + sessionTier) behind a gateway shim that enforces the deployed
  gateway's rules (only `auto` / `auto:*` reach the router, else a 403 fallback; header allowlists from stack.ts), in
  front of a scripted fake bedrock-runtime and a fake assessor (tier `frontier`);
- the REAL host proxy (hproxy.RunnerProxy) with each arm's route from arms.json (spec), loopback upstream;
- the pinned Claude Code, with cc_config.agent_env and Harbor's claude-code flags, one session per arm, driven by the
  fake Bedrock through Bash, Explore, general-purpose, Plan, a near-window turn (auto-compaction) and end_turn.
Writes results/e2e/<stamp>/ (gitignored: request bodies hold Claude Code's prompt) and prints the check table.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
DH = REPO / 'experiments' / 'deepswe-harbor'
sys.path.insert(0, str(DH))

import hcommon  # noqa: E402  isort: skip
import auth  # noqa: E402
import cc_config  # noqa: E402
import common  # noqa: E402
import hproxy  # noqa: E402
import proxy as px  # noqa: E402

ARMS = json.loads((REPO / 'experiments' / 'claude-code-harbor' / 'arms.json').read_text())['arms']
INSTR = 'Fix the failing unit test in calc.py so that add(2, 3) returns 5.'
FLAGS = ['--verbose', '--output-format=stream-json', '--effort', 'high', '--disallowedTools', 'WebSearch,WebFetch',
         '--permission-mode=bypassPermissions', '--print']   # Harbor 0.25.0 claude-code's launch (cc_agent keeps it)


# ---------------------------------------------------------------- namespace + catch-all

def enter_namespace(argv: list[str]) -> None:
    if os.environ.get('LLMAR_E2E_NS') == '1':
        return
    env = {**os.environ, 'LLMAR_E2E_NS': '1'}
    sys.exit(subprocess.call(['unshare', '-rnm', sys.executable, *argv], env=env))  # nosec B603: argument list, no shell; arguments are the operator's own


def setup_network(work: pathlib.Path) -> None:
    for cmd in (['ip', 'link', 'set', 'lo', 'up'], ['ip', 'link', 'add', 'd0', 'type', 'dummy'], ['ip', 'link', 'set', 'd0', 'up'],
                ['ip', 'addr', 'add', '10.255.0.1/24', 'dev', 'd0'], ['ip', 'route', 'add', 'default', 'dev', 'd0'],
                ['ip', '-6', 'addr', 'add', 'fd00::1/64', 'dev', 'd0'], ['ip', '-6', 'route', 'add', 'default', 'dev', 'd0']):
        subprocess.run(cmd, check=True, capture_output=True)  # nosec B603: argument list, no shell; arguments are the operator's own
    rc = work / 'resolv.conf'
    rc.write_text('nameserver 10.255.0.53\n')
    subprocess.run(['mount', '--bind', str(rc), '/etc/resolv.conf'], check=True)  # nosec B603: argument list, no shell; arguments are the operator's own


class Sniffer(threading.Thread):
    """Every frame leaving through d0 (anything not loopback): (family, proto, dst, dport)."""

    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
        self.s.bind(('d0', 0))
        self.s.settimeout(0.5)
        self.seen: list[dict[str, object]] = []
        self.stop = False

    def run(self) -> None:
        while not self.stop:
            try:
                f = self.s.recv(65535)
            except TimeoutError:
                continue
            except OSError:
                return
            ip = f[14:] if len(f) > 14 and f[12:14] in (b'\x08\x00', b'\x86\xdd') else f
            if ip and ip[0] >> 4 == 4:
                proto, dst, ihl = ip[9], socket.inet_ntoa(ip[16:20]), (ip[0] & 15) * 4
                dport = int.from_bytes(ip[ihl + 2:ihl + 4], 'big') if proto in (6, 17) else None
                self.seen.append({'v': 4, 'proto': proto, 'dst': dst, 'dport': dport})
            elif ip and ip[0] >> 4 == 6:
                proto, dst = ip[6], socket.inet_ntop(socket.AF_INET6, ip[24:40])
                dport = int.from_bytes(ip[42:44], 'big') if proto in (6, 17) else None
                self.seen.append({'v': 6, 'proto': proto, 'dst': dst, 'dport': dport})


# ---------------------------------------------------------------- pieces

def start_router(out: pathlib.Path) -> tuple[subprocess.Popen, int]:
    p = subprocess.Popen(['node', str(HERE / 'mock_router.ts'), str(out / 'router-logs.jsonl'), str(out / 'bedrock.jsonl'), 'frontier',  # nosec B603: argument list, no shell; arguments are the operator's own
                          str(out / 'assessor-calls.jsonl'), str(out / 'gateway.jsonl')],
                         stdout=subprocess.PIPE, stderr=open(out / 'router.stderr', 'w'), text=True)  # noqa: SIM115  (the router outlives this call)
    line = p.stdout.readline()
    return p, int(json.loads(line)['port'])


def shim_denies_concrete(port: int) -> bool:
    """Negative control: the gateway shim answers a concrete body model with its 403 fallback, as the deployed gateway
    sends it past the router (the A/C pilot failure this e2e must not pass again)."""
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    data = json.dumps({'model': ARMS['A']['client_model'], 'max_tokens': 8, 'messages': [{'role': 'user', 'content': 'x'}]}).encode()
    c.request('POST', '/inference/v1/messages', body=data, headers={'content-type': 'application/json', 'x-router-session': 'shim-check'})
    r = c.getresponse()
    ok = r.status == 403 and not r.getheader('x-router-model')
    r.read()
    c.close()
    return ok


def start_proxy(out: pathlib.Path, router_port: int) -> hproxy.RunnerProxy:
    common.set_region('ap-southeast-1')
    ups = px.Upstreams('https://gateway.test.invalid', 'ap-southeast-1',
                       connect=lambda _h, _ip, t: http.client.HTTPConnection('127.0.0.1', router_port, timeout=t),
                       resolver=lambda *a, **k: [(2, 1, 6, '', ('203.0.113.10', 443))])
    n = {'i': 0}

    def post(_u, _d, _h):
        n['i'] += 1
        return 200, json.dumps({'access_token': f'tok-{n["i"]}', 'expires_in': 3600}).encode()
    minter = auth.TokenMinter({'client_id': 'a', 'client_secret': 'b', 'token_url': 'https://x.invalid/oauth2/token', 'scope': 's'}, post=post)
    ledger = hproxy.make_ledger(out, cap_usd=100.0)
    srv = hproxy.RunnerProxy('127.0.0.1', 0, ups, ledger, hproxy.SharedToken(minter), out, allow_loopback_bind=True, require_host=None)
    hproxy.serve_in_thread(srv)
    return srv


def repo(work: pathlib.Path) -> pathlib.Path:
    r = work / 'repo'
    r.mkdir(parents=True)
    (r / 'calc.py').write_text('def add(a, b):\n    return a - b\n')
    g = ['git', '-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e']
    subprocess.run(['git', 'init', '-q'], cwd=r, check=True)  # nosec B603: argument list, no shell; arguments are the operator's own
    subprocess.run(['git', 'add', '.'], cwd=r, check=True)  # nosec B603: argument list, no shell; arguments are the operator's own
    subprocess.run([*g, 'commit', '-qm', 'init'], cwd=r, check=True)  # nosec B603: argument list, no shell; arguments are the operator's own
    return r


def run_claude(binary: pathlib.Path, base_url: str, model: str, work: pathlib.Path, instruction: str) -> dict[str, object]:
    home = work / 'home'
    home.mkdir(parents=True)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'TERM': 'dumb', 'IS_SANDBOX': '1', 'CLAUDE_CONFIG_DIR': str(work / 'sessions'),
           'ANTHROPIC_MODEL': model, **cc_config.agent_env(base_url)}
    t0 = time.time()
    p = subprocess.run([str(binary), *FLAGS], input=instruction, text=True, capture_output=True, cwd=repo(work), env=env, timeout=300, check=False)  # nosec B603: argument list, no shell; arguments are the operator's own
    (work / 'claude-code.txt').write_text(p.stdout + p.stderr)
    result = next((json.loads(x) for x in reversed(p.stdout.splitlines()) if x.startswith('{') and '"type":"result"' in x), None)
    return {'exit': p.returncode, 'secs': round(time.time() - t0, 1), 'result': {k: (result or {}).get(k) for k in ('subtype', 'is_error', 'num_turns', 'terminal_reason')},
            'subagents': (result or {}).get('subagent_stats', {}).get('by_type') if result else None}


def proc_stats(pid: int) -> dict[str, float]:
    st = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    tick = os.sysconf('SC_CLK_TCK')
    rss = next(int(x.split()[1]) for x in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if x.startswith('VmHWM'))
    return {'cpu_s': round((int(st[11]) + int(st[12])) / tick, 2), 'max_rss_mb': round(rss / 1024, 1)}


# ---------------------------------------------------------------- checks

def checks(out: pathlib.Path, runs: dict[str, dict], sniff: list[dict]) -> dict[str, object]:
    calls = [json.loads(x) for x in (out / 'calls.jsonl').read_text().splitlines()]
    logs = [json.loads(x) for x in (out / 'router-logs.jsonl').read_text().splitlines()]
    consults = (out / 'assessor-calls.jsonl').read_text().splitlines() if (out / 'assessor-calls.jsonl').exists() else []
    gw = [json.loads(x) for x in (out / 'gateway.jsonl').read_text().splitlines()] if (out / 'gateway.jsonl').exists() else []
    label = {arm: hashlib.sha256(r['trial'].encode()).hexdigest()[:16] for arm, r in runs.items()}
    res: dict[str, object] = {}
    for arm, r in runs.items():
        mine = [c for c in calls if c.get('trial_id') == r['trial'] and c.get('leaf') == 'messages']
        rl = [x for x in logs if x.get('session') == label[arm] and x.get('kind') == 'model']
        main_model = 'global.anthropic.claude-opus-5-5' if ARMS[arm]['main_model'] == 'auto' else ARMS[arm]['client_model']
        g = [x for x in gw if x.get('session') == r['trial']]
        pinned = ARMS[arm]['main_model'] != 'auto'
        res[arm] = {
            'claude': {k: r[k] for k in ('exit', 'secs', 'result', 'subagents')},
            'calls': len(mine), 'router_lines': len(rl), 'attributed_1to1': len(mine) == len(rl),
            'statuses': sorted({c['status'] for c in mine}),
            'call_types': dict(sorted({t: sum(1 for c in mine if c['call_type'] == t) for t in {c['call_type'] for c in mine}}.items())),
            'requested_models': sorted({c['requested_model'] for c in mine}),
            'served_by_role': {role: sorted({c['served_model'] for c in mine if c['call_role'] == role}) for role in ('main', 'main_subagent', 'helper')},
            'served_ok': all(c['served_model'] == main_model for c in mine if c['call_role'] in ('main', 'main_subagent'))
                         and all(c['served_model'] == c['requested_model'] for c in mine if c['call_role'] == 'helper'),
            'roles_null': sum(1 for c in mine if c['call_role'] is None),
            'role_agreement': f"{sum(1 for c in mine if c['call_role'] == c['call_role_struct'])}/{len(mine)}",
            'rewritten': sum(1 for c in mine if c.get('rewritten')),
            # The deployed gateway's rule (infra RouteAuto): every call must reach the router as auto, pinned arms with
            # the pin hint of the model the call named, and none may be answered by the fallback.
            'gateway_routed': f"{sum(1 for x in g if x['routed'])}/{len(g)}", 'gateway_fallbacks': sum(1 for x in g if not x['routed']),
            'gateway_fallback_calls': r['summary'].get('gateway_fallback_calls'),
            'via_router_all': bool(mine) and all(c.get('via_router') for c in mine),
            'pins_ok': all(c.get('pin') == c['requested_model'] for c in mine) if pinned
                       else all((c.get('pin') is None) == (c['requested_model'] == ARMS[arm]['client_model']) for c in mine),
            'hints_at_gateway': sorted({str(x.get('hint')) for x in g if x['routed']}),
            'router_pinned': sum(1 for x in rl if (x.get('decision') or {}).get('point') == 'pinned'),
            'sanitized_proxy': sum(1 for c in mine if c.get('sanitized')), 'sanitized_router': sum(1 for x in rl if x.get('sanitized')),
            'proxy_cost': round(sum(c.get('cost_usd') or 0 for c in mine), 6),
            'router_cost': round(sum((x.get('costUsd') or {}).get('total') or 0 for x in rl), 6),
            'decisions': sorted({(x.get('decision') or {}).get('point') for x in rl if x.get('decision')}),
        }
    res['assessor_consults_total'] = len(consults)
    res['non_proxy_traffic'] = sniff
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--claude', required=True)
    ap.add_argument('--instruction-file')
    ap.add_argument('--arms', default='A,B,C,F')
    a = ap.parse_args()
    enter_namespace(sys.argv)
    binary = pathlib.Path(a.claude).resolve()
    plat = hcommon.claude_platform(os.uname().machine)
    want = hcommon.CLAUDE_CODE['sha256'][plat]
    if hashlib.sha256(binary.read_bytes()).hexdigest() != want:
        sys.exit(f'{binary}: not the pinned {plat} build')
    instruction = pathlib.Path(a.instruction_file).read_text() if a.instruction_file else INSTR
    out = REPO / 'experiments' / 'claude-code-harbor' / 'results' / 'e2e' / time.strftime('%Y%m%dT%H%M%S')
    out.mkdir(parents=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix='cc-e2e-'))
    setup_network(work)
    sn = Sniffer()
    sn.start()
    router, port = start_router(out)
    shim_check = shim_denies_concrete(port)
    srv = start_proxy(out, port)
    runs: dict[str, dict] = {}
    try:
        for arm in a.arms.split(','):
            tid = f'e2e{arm.lower()}{os.urandom(6).hex()}'
            url = srv.register_trial(tid, arm, spec=ARMS[arm])
            r = run_claude(binary, url, ARMS[arm]['client_model'], work / arm, instruction)
            time.sleep(0.5)
            r['summary'] = srv.unregister_trial(tid)
            r['trial'] = tid
            runs[arm] = r
            shutil.copytree(work / arm / 'sessions' / 'projects', out / f'sessions-{arm}', dirs_exist_ok=True)
            shutil.copy(work / arm / 'claude-code.txt', out / f'claude-code-{arm}.txt')
        stats = proc_stats(router.pid)
    finally:
        time.sleep(0.5)
        sn.stop = True
        router.terminate()
        srv.shutdown()
    res = checks(out, runs, sn.seen)
    res['shim_denies_concrete'] = shim_check
    res['router_process'] = stats
    (out / 'summaries.json').write_text(json.dumps({arm: r['summary'] for arm, r in runs.items()}, indent=1))
    (out / 'checks.json').write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))
    print('→', out.relative_to(REPO))


if __name__ == '__main__':
    main()
