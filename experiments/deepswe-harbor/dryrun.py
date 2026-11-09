"""Local dry run (design §4.8): the real Harbor 0.25.0 + Codex 0.166.0 + RunnerProxy path against the mock router,
on one stand-in task with DeepSWE's task.toml shape (agent and verifier `no-network`, separate verifier, collect
hook `git diff --binary <base> HEAD`). The 113 DeepSWE images are linux/amd64 only, so on an arm64 dev box the
stand-in is built locally; the same driver runs a real DeepSWE task on the x86 runner (`--task-dir`).

The mock's first answer makes Codex run one command in /app that probes the network from inside the agent
container (proxy port, another host port, an internet address, DNS) and commits the results, so the graded patch
carries them. Arm F's calls stall past the agent timeout, to show that Harbor still collects and verifies after an
AgentTimeoutError.

`profile='tb21'` (Terminal-Bench 2.1, TB design §4.8) uses a TB-shaped stand-in instead: `allow_internet = true`, a
shared verifier (no verifier environment), no collect hook, and a test.sh that installs uv from the internet and
runs pytest with a ctrf report like the real ones. The trial container joins the online network (llmar_env online
mode; ONLINE_NETWORK / ONLINE_DNS from the environment), and the report adds the TB checks: web search disabled in
the request, the container's network record, the verifier's ctrf.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess  # nosec B404 - fixed argv: docker, harbor
import textwrap
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import hcommon
import auth
import harbor_job
import hproxy
import mock_upstream
import proxy as px
from common import write_json

IMAGE = 'llmar-dryrun-task:1'
BASE_BRANCH = 'main'
AGENT_TIMEOUT_S = 150
PROBE = r'''
import json, socket
def exchange(h, p, send=b"HEAD / HTTP/1.0\r\n\r\n"):
    # A transparent egress proxy accepts every TCP connect locally, so only bytes back from the peer count.
    try:
        s = socket.create_connection((h, p), timeout=5)
    except Exception as e:
        return "connect-failed:" + type(e).__name__
    try:
        s.settimeout(5)
        if send:
            s.sendall(send)
        data = s.recv(64)
        return "response" if data else "closed-no-data"
    except Exception as e:
        return "no-response:" + type(e).__name__
    finally:
        s.close()
def dns(n):
    try:
        return "resolved" if socket.getaddrinfo(n, 443) else "empty"
    except Exception as e:
        return "failed:" + type(e).__name__
gw = "@@PROXY@@"
out = {"proxy_port": exchange(gw, @@PORT@@), "host_ssh_via_sidecar": exchange(gw, 22, b"SSH-2.0-llmar-probe\\r\\n"), "internet_http": exchange("1.1.1.1", 80),
       "imds": exchange("169.254.169.254", 80), "dns_external": dns("example.com")}
try:
    import urllib.request
    urllib.request.urlopen("http://1.1.1.1/", timeout=5); out["internet_urlopen"] = "ok"
except Exception as e:
    out["internet_urlopen"] = "failed:" + type(e).__name__
open("/app/DRYRUN.json", "w").write(json.dumps(out, sort_keys=True) + "\n")
print(json.dumps(out))
'''


DOCKERFILE = '''FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git init -q -b main . && printf 'dry run\\n' > README.md && git add -A \\
 && git -c user.name=base -c user.email=base@localhost commit -qm base
CMD ["/bin/bash"]
'''


def build_image() -> str:
    with_ctx = hcommon.RESULTS / 'dryrun' / 'image'
    with_ctx.mkdir(parents=True, exist_ok=True)
    (with_ctx / 'Dockerfile').write_text(DOCKERFILE)
    subprocess.run(['docker', 'build', '-q', '-t', IMAGE, str(with_ctx)], check=True, capture_output=True)  # nosec B603 B607
    r = subprocess.run(['docker', 'run', '--rm', IMAGE, 'git', 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True)  # nosec
    return r.stdout.strip()


def make_task(root: pathlib.Path, base: str, proxy_host: str, proxy_port: int,
              instruction_from: pathlib.Path | None = None) -> pathlib.Path:
    """A task with DeepSWE v1.1's task.toml structure (limits shortened for the dry run). Our own text only."""
    t = root / 'llmar-dryrun'
    if t.exists():
        shutil.rmtree(t)
    (t / 'environment').mkdir(parents=True)
    (t / 'tests').mkdir()
    (t / 'solution').mkdir()
    (t / 'environment' / 'Dockerfile').write_text(DOCKERFILE)
    # instruction_from: a real task's instruction (copied only into results/, gitignored) to capture Codex's
    # session-start body for 73's card comparison; the stand-in's own instruction otherwise.
    (t / 'instruction.md').write_text((instruction_from / 'instruction.md').read_text() if instruction_from else
                                      'Dry run of the experiment harness. Probe the network, record the result in '
                                      'DRYRUN.json, and commit it on a new branch.\n')
    (t / 'tests' / 'Dockerfile').write_text(f'FROM {IMAGE}\nCOPY test.sh /tests/test.sh\nRUN chmod +x /tests/test.sh\n')
    (t / 'tests' / 'test.sh').write_text(textwrap.dedent('''\
        #!/bin/bash
        set -u
        mkdir -p /logs/verifier
        python3 - <<'PY' > /logs/verifier/verifier-probe.json
        import json, socket
        def c(h, p):
            try:
                s = socket.create_connection((h, p), timeout=3); s.close(); return "connected"
            except Exception as e:
                return "failed:" + type(e).__name__
        ifs = sorted(n for _, n in socket.if_nameindex())
        print(json.dumps({"proxy": c("@@PROXY@@", @@PORT@@), "internet": c("1.1.1.1", 443), "interfaces": ifs}))
        PY
        cd /app
        if [ -s /logs/artifacts/model.patch ] && git apply /logs/artifacts/model.patch && [ -f DRYRUN.json ]; then
          cp DRYRUN.json /logs/verifier/dryrun-probe.json
          echo '{"reward": 1}' > /logs/verifier/reward.json
        else
          echo '{"reward": 0}' > /logs/verifier/reward.json
        fi
        ''').replace('@@PROXY@@', proxy_host).replace('@@PORT@@', str(proxy_port)))
    (t / 'solution' / 'solve.sh').write_text('#!/bin/bash\ncd /app && echo "{}" > DRYRUN.json && git add -A && '
                                             'git -c user.name=o -c user.email=o@localhost commit -qm oracle\n')
    (t / 'task.toml').write_text(textwrap.dedent(f'''\
        schema_version = "1.3"
        artifacts = ["/logs/artifacts/model.patch"]
        [task]
        name = "llmar/dryrun"
        description = ""
        [metadata]
        task_id = "llmar-dryrun"
        base_commit_hash = "{base}"
        [verifier]
        network_mode = "no-network"
        environment_mode = "separate"
        timeout_sec = 300.0
        [verifier.environment]
        build_timeout_sec = 600.0
        cpus = 1
        memory_mb = 1024
        storage_mb = 4096
        [[verifier.collect]]
        command = "cd /app && mkdir -p /logs/artifacts && git config --global --add safe.directory /app && git diff --binary {base} HEAD > /logs/artifacts/model.patch"
        timeout_sec = 120.0
        [agent]
        network_mode = "no-network"
        timeout_sec = {float(AGENT_TIMEOUT_S)}
        [environment]
        build_timeout_sec = 600.0
        docker_image = "{IMAGE}"
        os = "linux"
        cpus = 1
        memory_mb = 2048
        storage_mb = 4096
        gpus = 0
        mcp_servers = []
        '''))
    return t


def _fake_minter(ttl_s: int) -> auth.TokenMinter:
    n = {'i': 0}

    def post(_url: str, _data: bytes, _headers: dict[str, str]) -> tuple[int, bytes]:
        n['i'] += 1
        return 200, json.dumps({'access_token': f'tok-dryrun-{n["i"]}', 'expires_in': ttl_s}).encode()

    return auth.TokenMinter({'client_id': 'x', 'client_secret': 'y', 'token_url': 'https://auth.dryrun.invalid/oauth2/token',
                             'scope': 's'}, post=post)


def _timing(res: dict[str, Any], calls: pathlib.Path, tid: str) -> dict[str, Any]:
    """Agent start → first model call and last call → agent end (seconds): where a startup DNS stall would show."""
    from datetime import datetime

    ae = res.get('agent_execution') or {}
    if not ae.get('started_at') or not calls.exists():
        return {}
    t0 = datetime.fromisoformat(ae['started_at'].replace('Z', '+00:00')).timestamp()
    t1 = datetime.fromisoformat(ae['finished_at'].replace('Z', '+00:00')).timestamp()
    ts = sorted(c['t_start'] for c in map(json.loads, calls.read_text().splitlines()) if c.get('trial_id') == tid and c.get('t_start'))
    return {'agent_s': round(t1 - t0, 2), 'start_to_first_call_s': round(ts[0] - t0, 2) if ts else None,
            'last_call_to_end_s': round(t1 - ts[-1], 2) if ts else None, 'calls': len(ts)}


TB_TEST_PY = '''import json, pathlib

def test_dryrun_probe_written():
    assert json.loads(pathlib.Path("/app/DRYRUN.json").read_text())["proxy_port"] == "response"
'''


TB_TEST_SH = '''#!/bin/bash
apt-get update
apt-get install -y curl
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env
cd /app
uvx -p 3.12 -w pytest==8.4.1 -w pytest-json-ctrf==0.3.5 pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
if [ $? -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
'''


def make_task_tb(root: pathlib.Path, instruction_from: pathlib.Path | None = None) -> pathlib.Path:
    """A task with Terminal-Bench 2.1's task.toml structure (limits shortened). Our own text only."""
    t = root / 'llmar-dryrun-tb'
    if t.exists():
        shutil.rmtree(t)
    for d in ('environment', 'tests', 'solution'):
        (t / d).mkdir(parents=True)
    (t / 'environment' / 'Dockerfile').write_text(DOCKERFILE)
    (t / 'instruction.md').write_text((instruction_from / 'instruction.md').read_text() if instruction_from else
                                      'Dry run of the experiment harness. Probe the network and record the result in '
                                      '/app/DRYRUN.json.\n')
    (t / 'tests' / 'test_outputs.py').write_text(TB_TEST_PY)
    (t / 'tests' / 'test.sh').write_text(TB_TEST_SH)
    (t / 'solution' / 'solve.sh').write_text('#!/bin/bash\necho \'{"proxy_port": "response"}\' > /app/DRYRUN.json\n')
    (t / 'task.toml').write_text(textwrap.dedent(f'''\
        schema_version = "1.1"
        artifacts = []
        [task]
        name = "llmar/dryrun-tb"
        description = ""
        [metadata]
        difficulty = "medium"
        category = "software-engineering"
        [verifier]
        timeout_sec = 600.0
        [agent]
        timeout_sec = {float(AGENT_TIMEOUT_S)}
        [environment]
        build_timeout_sec = 600.0
        docker_image = "{IMAGE}"
        cpus = 1
        memory_mb = 2048
        storage_mb = 4096
        gpus = 0
        allow_internet = true
        mcp_servers = []
        '''))
    return t


def harbor_bin() -> str:
    exe = os.environ.get('HARBOR_BIN') or shutil.which('harbor')
    if not exe:
        raise SystemExit('harbor not found: set HARBOR_BIN or install harbor==' + hcommon.HARBOR_VERSION)
    return exe


def run_trial(harbor: str, job: dict[str, Any], work: pathlib.Path) -> dict[str, Any]:
    path = work / f"{job['job_name']}.json"
    write_json(path, job)
    env = harbor_job.harbor_env(dict(os.environ))
    t0 = time.time()
    r = subprocess.run([harbor, 'run', '--config', str(path)], env=env, capture_output=True, text=True, timeout=1800)  # nosec B603
    (work / f"{job['job_name']}.log").write_text(r.stdout + '\n--- stderr ---\n' + r.stderr)
    return {'job': job['job_name'], 'exit': r.returncode, 'wall_s': round(time.time() - t0, 1)}


def main(proxy_host: str, proxy_port: int, codex_bin: pathlib.Path, task_dir: pathlib.Path | None = None,
         arms: tuple[str, ...] = hcommon.ARMS, token_ttl_s: int = 125, blackhole_dns: str | None = None,
         instruction_from: pathlib.Path | None = None, region: str | None = None, profile: str = 'deepswe') -> dict[str, Any]:
    region = region or os.environ.get('AWS_REGION')
    if not region:
        raise SystemExit('dryrun: --region (or $AWS_REGION) is required: it selects the price catalog')
    out = hcommon.RESULTS / 'dryrun' / time.strftime('%Y%m%dT%H%M%S')
    out.mkdir(parents=True)
    if task_dir is None:
        base = build_image()
        task_dir = (make_task_tb(out / 'tasks', instruction_from) if profile == 'tb21' else
                    make_task(out / 'tasks', base, proxy_host, proxy_port, instruction_from))
    mock, _ = mock_upstream.serve(0, stall_pin=hcommon.ARM_PIN['F'], stall_s=AGENT_TIMEOUT_S + 60, capture_dir=out / 'capture')
    probe = PROBE.replace('@@PROXY@@', proxy_host).replace('@@PORT@@', str(proxy_port))
    if blackhole_dns:
        # Timed, after Codex's first model call: shows the override took effect (a lookup that times out).
        probe = probe.replace('"dns_external": dns("example.com")',
                              '"dns_external": (lambda t: (dns("example.com"), round(__import__("time").time() - t, 1)))(__import__("time").time())')
    mock.script = ('cd /app && git checkout -q -b llmar-dryrun && python3 - <<\'PY\'\n' + probe + 'PY\n'
                   'git add -A && git -c user.name=dryrun -c user.email=dryrun@localhost commit -qm dryrun && git log --oneline -1')
    if profile == 'tb21':      # the work is the container state: no branch, no commit
        mock.script = "cd /app && python3 - <<'PY'\n" + probe + 'PY\n'
    mport = mock.server_address[1]
    ups = px.Upstreams('https://gateway.dryrun.invalid', region,
                       connect=lambda _h, _ip, t: px.http.client.HTTPConnection('127.0.0.1', mport, timeout=t),
                       resolver=lambda *a, **k: [(2, 1, 6, '', ('203.0.113.10', 443))])
    ledger = hproxy.make_ledger(out, cap_usd=5.0, reserve_usd=0.5)
    srv = hproxy.RunnerProxy(proxy_host, proxy_port, ups, ledger, hproxy.SharedToken(_fake_minter(token_ttl_s)), out,
                             require_host=proxy_host)
    hproxy.serve_in_thread(srv)
    harbor = harbor_bin()
    trials = []
    for arm in arms:
        tid = uuid.uuid4().hex
        url = srv.register_trial(tid, arm)
        job = harbor_job.job_config(arm=arm, trial_id=tid, task_dir=task_dir, jobs_dir=out / 'trials', job_name=f'{arm}-{tid[:8]}',
                                    base_url=url, codex_bin=codex_bin)
        if blackhole_dns:
            # The runner's container DNS (an unanswered TEST-NET address): every external lookup times out. Applied
            # to the sidecar, whose netns (and resolv.conf) the agent's main service shares.
            ov = out / 'dns-blackhole.json'
            write_json(ov, {'services': {'harbor-docker-egress-control-sidecar': {'dns': [blackhole_dns]}}})
            job['environment']['extra_docker_compose'] = [str(ov)]
        trials.append((arm, tid, job))
    with ThreadPoolExecutor(max_workers=len(trials)) as pool:
        runs = list(pool.map(lambda x: run_trial(harbor, x[2], out), trials))
    summaries = {arm: srv.unregister_trial(tid) for arm, tid, _ in trials}
    srv.shutdown()
    srv.server_close()
    mock.shutdown()
    report = {'out': str(out), 'runs': runs, 'proxy': srv.summary(), 'trials': {}, 'mock': {
        'calls_by_session': dict(mock.calls), 'tokens_seen': len(mock.tokens), 'leaked_llmar_headers': sum(len(s['leaked']) for s in mock.seen),
        'hints': sorted({s['hint'] for s in mock.seen}), 'sessions_seen': sorted({s['session'] for s in mock.seen}),
        'first_request': ({k: mock.seen[0][k] for k in ('reasoning', 'model', 'body_keys', 'tools')} if mock.seen else None)}}
    for (arm, tid, job), run in zip(trials, runs, strict=True):
        tdirs = sorted(p for p in (out / 'trials' / job['job_name']).glob('*/result.json'))
        res = json.loads(tdirs[0].read_text()) if tdirs else {}
        tdir = tdirs[0].parent if tdirs else None
        probe_file = tdir / 'verifier' / 'dryrun-probe.json' if tdir else None
        vprobe = tdir / 'verifier' / 'verifier-probe.json' if tdir else None
        report['trials'][arm] = {
            'trial_id': tid, 'harbor_exit': run['exit'], 'wall_s': run['wall_s'],
            'reward': ((res.get('verifier_result') or {}).get('rewards') or {}).get('reward'),
            'exception': (res.get('exception_info') or {}).get('exception_type'),
            'agent_version': (res.get('agent_info') or {}).get('version'),
            'patch_bytes': next((p.stat().st_size for p in (tdir / 'artifacts').rglob('model.patch')), None) if tdir else None,
            'probe': json.loads(probe_file.read_text()) if probe_file and probe_file.exists() else None,
            'verifier_probe': json.loads(vprobe.read_text()) if vprobe and vprobe.exists() and vprobe.stat().st_size else None,
            'proxy': {k: summaries[arm].get(k) for k in ('calls', 'statuses', 'served_models', 'spent_usd', 'origins', 'refused')},
            'session_matches_router_header': tid in report['mock']['sessions_seen'],
            'timing': _timing(res, out / 'calls.jsonl', tid),
        }
        if profile == 'tb21' and tdir:
            nr = tdir / hcommon.NET_RECORD
            ctrf = tdir / 'verifier' / 'ctrf.json'
            rtxt = tdir / 'verifier' / 'reward.txt'
            report['trials'][arm]['tb'] = {
                'net_record': json.loads(nr.read_text()) if nr.exists() else None,
                'ctrf_tests': ((json.loads(ctrf.read_text()).get('results') or {}).get('summary') or {}).get('tests') if ctrf.exists() else None,
                'reward_txt': rtxt.read_text().strip() if rtxt.exists() else None,
                'web_search_tool': any('web_search' in str(t) for t in (report['mock']['first_request'] or {}).get('tools') or []),
                'job_disable_web_search': job['agents'][0]['kwargs'].get('disable_web_search')}
    write_json(out / 'dryrun-report.json', report)
    return report
