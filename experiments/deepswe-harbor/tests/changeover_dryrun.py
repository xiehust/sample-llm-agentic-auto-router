"""Dry run of the TB 2.1 changeover runbook (experiments/tbench-harbor/ORCHESTRATION.md) against four local fake
runners. Every step is the exact `fleet.py` argv 0c runs, executed in-process with a fake SSM that runs the generated
scripts in bash on the local disk; the transcript lists each command with the last line it printed.

  uv run --python 3.12 --with pytest==8.4.2 python tests/changeover_dryrun.py [--keep] [--driver-python /tmp/harbor-venv/bin/python]

Needs the gitignored dev inputs of the llmar-tb21 worktree: experiments/tbench-harbor/results/{plan-detail.json,
tierpass/strata.json} (copied into the run's temp dir), the TB 2.1 checkout at the pin under /tmp/tb-data/tb21 (git
clone target), and a Python with Harbor 0.25.0 for --driver-python / HARBOR_PYTHON. It does not run from a fresh
checkout. Pass --tmp-dir on a disk with ≥ 30 GB free (the driver's disk guard).

Real: fleet.py, driver.py, shardplan/classify/profiles, taskpin (integrity, image pins, network check), the export
(leakscan), the merge, the git clone of terminal-bench-2-1 (redirected to the local checkout), the pack, the ship and
its bootstrap checks, the proxy (bound to a local bridge address, no upstream calls). Fake: AWS (SSM runs locally,
S3 is a directory), systemd (systemd-run/systemctl/journalctl shims), docker (pull/tag/inspect/network shims),
Harbor (tests/fake_harbor.py), the runner secret (auth stub in the shipped copy), the Codex download (stub), a3's
network switch (env-file keys). The driver venv Python has no Harbor, like /srv/runner/venv (checked at start), so
every driver command and the REAL isolation.py run without it: the isolation step passes when each runner's suite
ends with `isolation-exit=`, logs no ImportError/ModuleNotFoundError/traceback and itself reached docker (its gates
FAIL on fake docker by construction). The DeepSWE runners start with the frozen
DeepSWE code (git archive of --deepswe-ref) and a finished DeepSWE results tree. No AWS, no network except the local
git clone and nothing listens beyond the host (the proxies bind to a local bridge address)."""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

TESTS = pathlib.Path(__file__).resolve().parent
HERE = TESTS.parent
REPO = HERE.parents[1]
for p in (str(HERE), str(TESTS)):
    if p not in sys.path:
        sys.path.insert(0, p)

import fleet
import profiles

TB_CHECKOUT = pathlib.Path('/tmp/tb-data/tb21')
IIDS = [f'i-0dryrun00000000{i}' for i in range(4)]
FAKE = TESTS / 'fake_harbor.py'

SYSTEMD_RUN = r'''#!/usr/bin/env python3
import os, subprocess, sys, pathlib
args, unit, cwd, env = sys.argv[1:], None, None, dict(os.environ)
while args and args[0].startswith('--'):
    a = args.pop(0)
    if a.startswith('--unit='): unit = a.split('=', 1)[1]
    elif a.startswith('--working-directory='): cwd = a.split('=', 1)[1]
    elif a.startswith('--setenv='):
        k, v = a.split('=', 1)[1].split('=', 1)
        if k != 'PATH': env[k] = v
d = pathlib.Path(os.environ['SHIM_STATE']) / 'units'; d.mkdir(parents=True, exist_ok=True)
log = open(d / f'{unit}.log', 'ab')
p = subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
(d / f'{unit}.pid').write_text(str(p.pid))
'''
SYSTEMCTL = r'''#!/usr/bin/env python3
import os, sys, pathlib
args = [a for a in sys.argv[1:] if a != '--quiet']
if args[0] != 'is-active': sys.exit(0)
p = pathlib.Path(os.environ['SHIM_STATE']) / 'units' / f'{args[1]}.pid'
alive = False
import time
if p.exists() and time.time() - p.stat().st_mtime < 4:
    alive = True        # a unit is active for at least its first seconds, as real ones are (fleet checks after 3 s)
elif p.exists():
    pid = int(p.read_text())
    try:
        os.kill(pid, 0)
        st = open(f'/proc/{pid}/stat').read().split()[2]
        alive = st != 'Z'
    except OSError:
        alive = False
if '--quiet' not in sys.argv[1:]: print('active' if alive else 'inactive')
sys.exit(0 if alive else 3)
'''
JOURNALCTL = r'''#!/usr/bin/env python3
import os, sys, time, pathlib
a = sys.argv[1:]
if '-f' in a:
    time.sleep(10**6)
if '-u' in a:
    p = pathlib.Path(os.environ['SHIM_STATE']) / 'units' / f"{a[a.index('-u') + 1]}.log"
    if p.exists(): sys.stdout.write(p.read_text(errors='replace'))
'''
DOCKER = r'''#!/usr/bin/env python3
import fcntl, json, os, sys, time, pathlib
a = sys.argv[1:]
st = pathlib.Path(os.environ['SHIM_STATE']) / 'docker.json'
def load():
    return json.loads(st.read_text()) if st.exists() else {'tags': {}, 'pulled': []}
def save(d):
    st.write_text(json.dumps(d))
lockf = open(str(st) + '.lock', 'a'); fcntl.flock(lockf, fcntl.LOCK_EX)
try:
    caller = open(f'/proc/{os.getppid()}/cmdline', 'rb').read().replace(b'\0', b' ').decode(errors='replace')[:200]
except OSError:
    caller = '?'
with open(st.parent / 'docker-calls.log', 'a') as lf:
    lf.write(json.dumps({'argv': a, 'caller': caller}) + '\n')
if a[0] == 'pull':
    d = load(); d['pulled'].append(a[-1]); save(d); print(a[-1])
elif a[0] == 'tag':
    d = load(); d['tags'][a[2]] = a[1]; save(d)
elif a[:2] == ['image', 'inspect']:
    ref, d = a[-1], load()
    fmt = a[a.index('--format') + 1] if '--format' in a else None
    if fmt is None:
        if ref in d['pulled'] or ref in d['tags']: print('[{}]')
        else: sys.exit(1)
    elif '.Size' in fmt: print(1000)
    elif '@sha256:' in d['tags'].get(ref, ''): print(json.dumps([d['tags'][ref]]))
    else: sys.exit(1)
elif a[0] in ('run', 'create'):
    print('c0ffee' * 11)   # a container id
elif a[0] == 'inspect':
    print(json.dumps([{'Id': 'c0ffee', 'NetworkSettings': {'Networks': {}}, 'State': {'Running': True}}]))
elif a[:2] == ['network', 'inspect']:
    print(json.dumps([{'Name': a[2], 'Id': 'n1', 'Driver': 'bridge', 'Internal': False, 'EnableIPv6': False,
                       'IPAM': {'Config': [{'Subnet': '10.201.0.0/24', 'Gateway': '10.201.0.1'}]},
                       'Options': {'com.docker.network.bridge.name': 'br-llmon', 'com.docker.network.bridge.enable_icc': 'false',
                                   'com.docker.network.bridge.enable_ip_masquerade': 'true'}}]))
elif a[0] == 'events':
    lockf.close(); time.sleep(10**6)
'''
AWS = r'''#!/bin/bash
# aws s3 cp --only-show-errors SRC s3://bucket/key
src="${@: -2:1}"; dst="${@: -1}"; rel="${dst#s3://}"
mkdir -p "$SHIM_BUCKET/$(dirname "$rel")"; cp "$src" "$SHIM_BUCKET/$rel"
'''
UV = '#!/bin/bash\nif [ "$1" = venv ]; then mkdir -p "${@: -1}/bin"; ln -sf "$DRIVER_PYTHON" "${@: -1}/bin/python"; fi\nexit 0\n'
AUTH_STUB = '''

# ---- dry run (tests/changeover_dryrun.py): no runner secret, no Cognito ----
def read_secret(region, secret_id):  # noqa: F811
    return {'client_id': 'dryrun', 'client_secret': 'dryrun', 'token_url': 'https://dryrun.invalid/oauth2/token'}


class TokenMinter:  # noqa: F811
    def __init__(self, secret, post=None, clock=None):
        pass

    def mint(self):
        return 'dryrun-not-a-credential', time.time() + 3600
'''
CLI_STUB = '''"""dry-run stub of cli.py stage-codex (tests/changeover_dryrun.py)"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import hcommon
p = hcommon.codex_bin('x86_64'); p.parent.mkdir(parents=True, exist_ok=True); p.write_text('#!/bin/sh\\necho codex-cli 0.166.0\\n'); p.chmod(0o755)
print('ok', p)
'''


class Runner:
    def __init__(self, root: pathlib.Path, i: int, driver_python: str):
        self.i, self.work, self.bin, self.state = i, root / f'runner{i}', root / f'bin{i}', root / f'state{i}'
        for d in (self.work, self.bin, self.state):
            d.mkdir(parents=True)
        self.env_file = root / f'runner{i}.env'
        self.env_file.write_text(f'RUNNER_INDEX={i}\nRUNNER_COUNT=4\nPROXY_ADDR={PROXY_ADDR}\nPROXY_PORT={18088 + i}\nWORK_DIR={self.work}\n'
                                 f'RESULTS_PREFIX=runs/{i}/\nDRIVER_PYTHON={driver_python}\nAWS_REGION=ap-southeast-1\n')
        for name, body in (('systemd-run', SYSTEMD_RUN), ('systemctl', SYSTEMCTL), ('journalctl', JOURNALCTL), ('docker', DOCKER),
                           ('aws', AWS), ('uv', UV), ('harbor', f'#!/bin/bash\nexec {sys.executable} {FAKE} "$@"\n')):
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        self.gitconfig = root / f'gitconfig{i}'
        self.gitconfig.write_text(f'[url "{TB_CHECKOUT}"]\n\tinsteadOf = {profiles.TB21.repo_url}\n[safe]\n\tdirectory = *\n')

    def bash(self, script: str) -> tuple[str, str, str]:
        # the units' PATH (fleet.unit_cmd), with the shims first
        env = {'PATH': f'{self.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(self.work), 'LLMAR_ENV_FILE': str(self.env_file), 'LLMAR_NO_IMDS': '1',
               'LLMAR_UV': str(self.bin / 'uv'), 'SHIM_STATE': str(self.state), 'SHIM_BUCKET': str(BUCKET), 'GIT_CONFIG_GLOBAL': str(self.gitconfig),
               'FAKE_HARBOR_LOG': str(self.state / 'harbor.log'), 'HARBOR_PYTHON': HARBOR_PYTHON}
        script = script.replace('/tmp/llmar-harbor', f'{self.state}/llmar-harbor')   # 4 fakes share this host's /tmp; real runners don't
        r = subprocess.run(['bash', '-c', script], capture_output=True, text=True, env=env, timeout=1800, check=False)  # nosec B603: argument list, no shell; arguments are the operator's own
        return ('Success' if r.returncode == 0 else 'Failed'), r.stdout, r.stderr

    def wait_units(self, timeout: float = 900) -> None:
        t_end = time.time() + timeout
        while time.time() < t_end:
            if all(self.bash(f'systemctl is-active --quiet {u}')[0] != 'Success' for u in fleet.UNITS):
                return
            time.sleep(0.5)
        raise SystemExit(f'runner {self.i}: units still active after {timeout} s')

    def stub_shipped(self) -> None:
        repo = self.work / 'repo' / 'experiments'
        with open(repo / 'codex-deepswe' / 'auth.py', 'a') as f:
            f.write(AUTH_STUB)
        (repo / 'deepswe-harbor' / 'cli.py').write_text(CLI_STUB)
        if ISOLATION_REF:   # regression check: ship an older isolation.py (e.g. the one before 8e9ebe7) and see this run catch it
            src = subprocess.run(['git', '-C', str(REPO), 'show', f'{ISOLATION_REF}:experiments/deepswe-harbor/isolation.py'],  # nosec B603: argument list, no shell; arguments are the operator's own
                                 capture_output=True, check=True).stdout
            (repo / 'deepswe-harbor' / 'isolation.py').write_bytes(src)
        with open(repo / 'deepswe-harbor' / 'hcommon.py', 'a') as f:   # the proxy's fixed docker0 address, here a local bridge
            f.write(f"\nPROXY_HOST = '{PROXY_ADDR}'   # dry run (tests/changeover_dryrun.py)\nPROXY_PORT = {18088 + self.i}\n")


class LocalAws(fleet.Aws):
    def __init__(self, runners: dict[str, Runner]):
        super().__init__('ap-southeast-1', run=None)
        self.runners = runners

    def ssm(self, iid: str, script: str, timeout_s: int = 600) -> tuple[str, str, str]:
        return self.runners[iid].bash(script)

    def s3_get(self, bucket: str, key: str, dest: pathlib.Path) -> None:
        shutil.copy(BUCKET / bucket / key, dest)


def deepswe_state(r: Runner) -> None:
    """A finished DeepSWE runner: results with a completed run, one trial dir and its proxy log."""
    res = r.work / 'results'
    (res / 'jobs' / 'j1' / 't1').mkdir(parents=True)
    (res / 'jobs' / 'j1' / 't1' / 'result.json').write_text('{"verifier_result": {"rewards": {"reward": 1.0}}}')
    (res / 'proxy').mkdir()
    (res / 'proxy' / 'calls.jsonl').write_text('{"status": 200}\n')
    (res / 'attempts.jsonl').write_text(json.dumps({'ev': 'run-start', 'at': 1.0, 'passes': ['main']}) + '\n'
                                        + json.dumps({'ev': 'run-end', 'state': 'done', 'at': 2.0}) + '\n')


def frozen_pack(ref: str, out: pathlib.Path) -> bytes:
    """The DeepSWE code the runners still run: `git archive <ref>` of DeepSWE's pack roots, packed the same way."""
    sys.path.insert(0, str(REPO / 'experiments' / 'codex-deepswe'))
    import packing
    with tempfile.TemporaryDirectory() as td:
        arc = subprocess.run(['git', '-C', str(REPO), 'archive', ref, *profiles.DEEPSWE.roots], capture_output=True, check=True).stdout  # nosec B603: argument list, no shell; arguments are the operator's own
        with tarfile.open(fileobj=io.BytesIO(arc)) as t:
            t.extractall(td, filter='data')
        packing.build(out, pathlib.Path(td), profiles.DEEPSWE.roots)
    return out.read_bytes()


def isolation_ran(runners: list[Runner]) -> tuple[bool, str]:
    """(bad, summary): every runner's llmar-isolation unit ended with `isolation-exit=`, logged no ImportError,
    ModuleNotFoundError or traceback, and isolation.py itself made docker calls."""
    notes, bad = [], False
    for r in runners:
        log = (r.state / 'units' / 'llmar-isolation.log').read_text(errors='replace') if (r.state / 'units' / 'llmar-isolation.log').exists() else ''
        calls = [json.loads(x) for x in (r.state / 'docker-calls.log').read_text().splitlines()] if (r.state / 'docker-calls.log').exists() else []
        mine = [c for c in calls if 'isolation.py' in c['caller']]
        code = re.findall(r'isolation-exit=(\d+)', log)
        err = next((x for x in reversed(log.splitlines()) if re.match(r'\w*(Error|Exception)\b.*:', x)), None)   # the raised exception
        if err is None and 'Traceback' in log:
            err = 'Traceback'
        ok = bool(code) and err is None and bool(mine)
        bad = bad or not ok
        notes.append(f"runner {r.i}: {'ran' if ok else 'BROKEN'} (exit {code[-1] if code else '?'}, {len(mine)} docker calls"
                     + (f', {err.strip()[:80]}' if err else '') + ')')
    return bad, 'isolation.py ran Harbor-free to its gates (fake docker → gates FAIL): ' + '; '.join(notes)


def brief(out: list[str]) -> str:
    """The last line, or for a JSON document (merge, project) its headline keys."""
    if out and out[-1] == '}':
        try:
            doc = json.loads('\n'.join(out[next(i for i, x in enumerate(out) if x == '{'):]))
        except (StopIteration, ValueError):
            return out[-1]
        keys = ('attempts', 'finals', 'classes', 'checks_dropped', 'spent_usd', 'projected_total_usd')
        return json.dumps({k: doc[k] for k in keys if k in doc}, separators=(',', ':'))
    return out[-1] if out else ''


def run_fleet(argv: list[str], aws: LocalAws) -> list[str]:
    real_resolve = fleet.resolve
    fleet.resolve = lambda a: (aws, IIDS, 'llmar-runner-results-dryrun')
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            fleet.main(['--region', 'ap-southeast-1', '--instances', ','.join(IIDS), *argv])
    finally:
        fleet.resolve = real_resolve
    return buf.getvalue().strip().splitlines()


PROXY_ADDR = '240.10.0.1'      # set from the host's docker0 in main()
HARBOR_PYTHON = '/tmp/harbor-venv/bin/python'
ISOLATION_REF: str | None = None   # taskpin's out-of-process digest helper (the runner: the harbor tool's python)
BUCKET = pathlib.Path('/nonexistent')


def main() -> int:
    global PROXY_ADDR, BUCKET
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--driver-python', default=sys.executable,
                    help="the fake runners' driver venv Python: must NOT have Harbor, like /srv/runner/venv (checked)")
    ap.add_argument('--harbor-python', default='/tmp/harbor-venv/bin/python',
                    help="a Python with Harbor 0.25.0: taskpin's digest helper (HARBOR_PYTHON; on a runner, the harbor tool's python)")
    ap.add_argument('--deepswe-ref', default='7ced27d', help='the frozen DeepSWE commit the runners run before the changeover')
    ap.add_argument('--proxy-addr', default=None, help='a private, non-loopback local bridge address (default: docker0)')
    ap.add_argument('--out', default=None, help='write the transcript (markdown) here')
    ap.add_argument('--isolation-ref', help='ship isolation.py from this git ref instead (shows the run catching an old bug)')
    ap.add_argument('--tmp-dir', default=None, help='where the fake runners live: a disk with ≥ 30 GB free (the driver halts below that)')
    a = ap.parse_args()
    global HARBOR_PYTHON, ISOLATION_REF
    HARBOR_PYTHON, ISOLATION_REF = a.harbor_python, a.isolation_ref
    if subprocess.run([a.driver_python, '-I', '-c', 'import harbor'], capture_output=True, check=False).returncode == 0:  # nosec B603: argument list, no shell; arguments are the operator's own
        raise SystemExit(f'--driver-python {a.driver_python} can import harbor; the runner driver venv cannot (pick one without it)')
    if subprocess.run([a.harbor_python, '-I', '-c', 'import harbor'], capture_output=True, check=False).returncode != 0:  # nosec B603: argument list, no shell; arguments are the operator's own
        raise SystemExit(f'--harbor-python {a.harbor_python} cannot import harbor')
    PROXY_ADDR = a.proxy_addr or subprocess.run(['sh', '-c', "ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1"],  # nosec B603: argument list, no shell; arguments are the operator's own
                                                capture_output=True, text=True, check=False).stdout.strip() or '240.10.0.1'
    root = pathlib.Path(tempfile.mkdtemp(prefix='llmar-dryrun-', dir=a.tmp_dir))
    BUCKET = root / 'bucket'
    runners = [Runner(root, i, a.driver_python) for i in range(4)]
    aws = LocalAws(dict(zip(IIDS, runners)))
    # dev-box outputs go to the temp dir, never to the experiment's results
    dev = {'deepswe': root / 'dev-deepswe', 'tb21': root / 'dev-tb21'}
    for name, d in dev.items():
        profiles.PROFILES[name] = dataclasses.replace(profiles.PROFILES[name], dev_results=d)
    (dev['tb21'] / 'tierpass').mkdir(parents=True)
    shutil.copy(profiles.TB21.dev_results / 'plan-detail.json', dev['tb21'] / 'plan-detail.json')
    shutil.copy(profiles.TB21.dev_results / 'tierpass' / 'strata.json', dev['tb21'] / 'tierpass' / 'strata.json')
    class _FastTime:   # fleet's 30 s isolation poll, shortened (fleet's own module reference only)
        def __getattr__(self, k):
            return getattr(time, k)

        @staticmethod
        def sleep(s):
            time.sleep(min(s, 0.5))
    fleet.time = _FastTime()

    # pre-state: the runners run the frozen DeepSWE code and hold a finished DeepSWE run
    blob = frozen_pack(a.deepswe_ref, root / 'deepswe-pack.tgz')
    import hashlib
    for r in runners:
        out = fleet.Fleet(aws, IIDS, [r.i]).ship(blob, hashlib.sha256(blob).hexdigest())
        assert out[r.i].startswith('ready'), out
        deepswe_state(r)

    F = ['--dataset', 'deepswe']
    T = ['--dataset', 'tb21']
    gw = ['--gateway-url', 'https://gateway.dryrun.invalid']
    steps: list[tuple[str, list[str], str]] = [
        ('0 DeepSWE final full fetch', ['fetch', '--mode', 'full'], 'F'),
        ('1 stop', ['stop'], 'F'), ('1 units', ['units'], 'F'), ('1 status', ['status'], 'F'),
        ('2 TB pack', ['pack'], 'T'), ('2 TB ship', ['ship'], 'T'),
        ('3 archive DeepSWE (new driver, default profile)', ['archive'], 'F'),
        ('4 a3 switch (simulated: env keys)', [], 'A3'),
        ('4 isolation --wait', ['isolation', '--wait'], 'T'),
        ('5 setup', ['setup'], 'T'), ('5 prepull', ['prepull'], 'T'), ('5 units (prepull done)', ['units'], 'T'),
        ('6 checks', ['check', '--concurrency', '8'], 'T'), ('6 status', ['status'], 'T'), ('6 fetch', ['fetch'], 'T'), ('6 merge', ['merge'], 'L'),
        ('7 pilot', ['start', '--pass', 'pilot', *gw, '--concurrency', '8', '--soft-cap', '45', '--hard-cap', '65', '--token-max-age-s', '600'], 'T'),
        ('7 status', ['status'], 'T'), ('7 fetch', ['fetch'], 'T'), ('7 merge', ['merge', '--tasks-dir', str(TB_CHECKOUT / 'tasks')], 'L'),
        ('8 main to the checkpoint', ['start', '--pass', 'main', '--pass', 'rep2', '--pass', 'rep3', *gw, '--concurrency', '8', '--soft-cap', '800',
                                      '--hard-cap', '900', '--max-blocks', '6'], 'T'),
        ('8 status', ['status'], 'T'), ('8 fetch', ['fetch'], 'T'), ('8 merge', ['merge'], 'L'), ('8 project', ['project'], 'L'),
        ('8 main, rest', ['start', '--pass', 'main', '--pass', 'rep2', '--pass', 'rep3', *gw, '--concurrency', '8', '--soft-cap', '800',
                          '--hard-cap', '900'], 'T'),
        ('8 status', ['status'], 'T'),
        ('9 post-run oracle re-check', ['check', '--concurrency', '8', '--post'], 'T'),
        ('9 full fetch', ['fetch', '--mode', 'full'], 'T'), ('9 merge', ['merge'], 'L'),
    ]
    lines = [f'# Changeover dry run ({time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())})', '',
             f'Runners: 4 local fakes under {root}; DeepSWE pre-state from {a.deepswe_ref}; TB code = this worktree.',
             f'Driver venv Python without Harbor: {a.driver_python} (`import harbor` fails there, as in /srv/runner/venv).', '',
             '| Step | Command | Last line |', '|---|---|---|']
    ok = True
    for title, argv, who in steps:
        t0 = time.time()
        if who == 'A3':
            for r in runners:
                with open(r.env_file, 'a') as f:
                    f.write('CONTAINER_EGRESS=internet\nONLINE_NETWORK=llmar-online\nONLINE_DNS=169.254.169.253\n')
            lines.append(f'| {title} | (0c applies a3\'s switch) | env files: CONTAINER_EGRESS=internet |')
            continue
        pre = F if who == 'F' else T
        shown = ('$F ' if who == 'F' else '$T ' if who == 'T' else 'python3 experiments/deepswe-harbor/fleet.py --dataset tb21 ') + ' '.join(argv)
        try:
            out = run_fleet([*pre, *argv], aws)
        except SystemExit as e:
            out, ok = [f'SystemExit: {e}'], False
        if argv[:1] == ['ship'] and who == 'T':
            for r in runners:
                r.stub_shipped()
        if argv[:1] in (['prepull'], ['check'], ['start'], ['isolation']):
            for r in runners:
                r.wait_units()
        last = brief(out)
        bad = any(re.match(r'runner \d+: FAILED', x) or 'Traceback' in x or '"error":' in x or x.startswith('SystemExit') for x in out)
        if argv[:1] == ['isolation']:   # the real suite on fake docker: its gates FAIL by construction; what must hold is that it
            bad, last = isolation_ran(runners)   # ran in the Harbor-free driver venv without an import error and reached docker
        ok = ok and not bad
        lines.append(f"| {title} | `{shown}` | `{last[:220].replace('|', '/')}` ({time.time() - t0:.0f} s){' **FAILED**' if bad else ''} |")
        print(f'[{title}] {shown}\n  ' + '\n  '.join(out[-6:]), flush=True)
    # the units' own logs (driver.log lines) for the record
    for r in runners:
        log = r.work / 'tb21' / 'results' / 'driver.log'
        if log.exists():
            tail = log.read_text().strip().splitlines()[-1:]
            lines.append(f'\nrunner {r.i} driver.log: `{tail[0][:200] if tail else ""}`')
    text = '\n'.join(lines) + '\n'
    if a.out:
        pathlib.Path(a.out).write_text(text)
    print(text)
    if not a.keep:
        for dp, _, _ in os.walk(root):
            with contextlib.suppress(OSError):
                os.chmod(dp, 0o700)
        shutil.rmtree(root, ignore_errors=True)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
