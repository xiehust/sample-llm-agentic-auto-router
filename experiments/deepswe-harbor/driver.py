# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3==1.40.70"]
# ///
"""Per-runner driver (design §9): runs one shard's blocks through `harbor run`, one Harbor job per trial attempt.

On the runner (root, through SSM; see fleet.py), with the venv the bootstrap builds from driver.py.lock:

  driver.py fetch-tasks                 clone datacurve-ai/deep-swe at the plan's commit, check the shard's task.toml hashes
  driver.py prepull                     docker pull the shard's task images and PREPULL_IMAGES
  driver.py check [--kind oracle|nop|both] [--reps N]
                                        oracle (reference solution) and null (unmodified base) checks, no model calls
  driver.py run --pass main [--pass r1 …] --gateway-url URL [--concurrency 6] [--soft-cap 1000] [--hard-cap 1130]
                                        live trials through the host proxy; resumable; stops at the end of the list
  driver.py status                      one JSON document: progress, classes, spend, 429s, host health
  driver.py stop [--now]                drain (no new blocks) or cancel the running trials
  driver.py export --mode light|full    a tarball of an allowlist of results files (+ sha256 manifest) for fetch

Scheduling (design §7.6, §9). The unit is a block: one task with its arms in the plan's seeded order. Blocks start
in the plan's order. A block is admitted when its first trial starts. After that, all of its trials and their
reruns run, even after a stop condition, so that a soft-cap stop leaves only complete blocks. With S slots: first the
pending reruns and re-verifies of admitted blocks, then the unstarted trials of admitted blocks, then the next block.
New blocks are no longer admitted once the proxy's Bedrock spend reaches the soft cap (`--soft-cap`, default $1,000),
the `--max-blocks` checkpoint is reached, results/STOP exists (`stop`), or the disk runs low. The proxy itself
refuses calls at the hard cap (`--hard-cap`, default $1,130; fail closed). No new trial starts at all after a hard
cap stop or after `--max-consecutive-harness` harness errors in a row.

Per attempt (trial_id = uuid4 hex, never reused; it is the router session): register the proxy route, write the
Harbor job config (harbor_job.job_config, 4f), `HARBOR_TELEMETRY=0 harbor run --config job.json` in its own process
group, unregister (the per-trial proxy summary), remove the trial's leftover compose containers and networks,
classify (classify.py, design §7.4), and append the events to results/attempts.jsonl (fsynced). Reruns get a new
trial_id. Re-verify runs `harbor jobs regrade` on the attempt's job dir. At most 2 reruns and 2 re-verifies per
(pass, task, arm, rep); still errored after that, the key is final `excluded`.

Resume: `run` replays attempts.jsonl. Any attempt with a start but no end was orphaned by a crash: its Harbor
process group is killed, its containers are removed, and it ends as harness `driver-restart` (rerun). Re-running the
same command continues where the shard left off. The concurrency is fixed for the whole run (0d): a resume with a
different value is refused unless --change-concurrency is given.

Host health per attempt (0d §7.7): runner-metrics before and after (CPU steal, load, memory, swap, PSI), plus the
docker events (oom, die exit codes) and kernel OOM kills attributed to the trial's compose projects (global vs
container-limit: classify.host_oom).
Nothing here reads or writes a token: the proxy holds the token in memory (hproxy, 4f). Logs mask 12-digit numbers.

Datasets (profiles.py; `--dataset deepswe` is the default and reproduces the DeepSWE run byte for byte). With
`--dataset tb21` (Terminal-Bench 2.1, TB design §6): the checkout is $WORK_DIR/terminal-bench-2-1 and the results
$WORK_DIR/tb21/results (its own proxy ledger and caps); fetch-tasks and prepull use 4f's taskpin (Harbor content
digests, images pulled by digest and tagged); `run` and `check` need CONTAINER_EGRESS=internet and check the
`llmar-online` network and the image digests after the network prune; admission counts the tasks' declared cpus
(≤ 8) and memory (≤ 48 GB) as well as trials (so a 4-CPU task's arms run two at a time); the watchdog is per task
(agent + verifier + build timeouts + 30 min); every trial is scanned by 4f's lookupscan and classified with TB rules
(a)–(c) (classify.py); checks use §7.5's two counted slots per kind (`check --post`: the post-run oracle re-check).
  driver.py archive [--verify M]        freeze a dataset's results dir in place: sha256 manifest + chmod a-w
"""
from __future__ import annotations

import argparse
import collections
import contextlib
import dataclasses
import fcntl
import gzip
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess  # nosec B404 - fixed argv lists only
import sys
import tarfile
import threading
import time
import tomllib
import uuid
from collections.abc import Callable, Iterable
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import classify as clf  # noqa: E402
import profiles
import shardplan  # noqa: E402

ENV_FILE = pathlib.Path(os.environ.get('LLMAR_ENV_FILE') or '/etc/llmar-runner.env')   # the override is for tests
METRICS_BIN = '/usr/local/bin/runner-metrics'
DEFAULT_CONCURRENCY = 6
MAX_CONCURRENCY = 6               # 0d: ≤ 6 trials (+ their verifiers) per 64 GB runner
DEFAULT_SOFT_CAP = 1000.0
DEFAULT_HARD_CAP = 1130.0
MAX_RERUNS = 2
MAX_REVERIFIES = 2
WALL_TIMEOUT_H = 5.0              # agent 3 h + verifier 0.5 h + build/collect; a stuck Harbor process is killed after this
STOP_GRACE_S = 180                # SIGINT to a Harbor process group, then SIGKILL
MIN_FREE_GB = 30.0
MAX_CONSECUTIVE_HARNESS = 5
STATUS_EVERY_S = 30
METRICS_EVERY_S = 60
PART_CHARS = 20_000               # base64 characters per SSM fetch part (send-command output is cut at 24,000)
LIGHT_MAX_FILE = 1 << 20          # light export: files up to 1 MiB (result, reward, ctrf, patch, logs); larger ones are listed
LIGHT_ALWAYS = ('result.json', 'reward.json', 'reward.txt', 'config.json')
FULL_ONLY = ('lookup-hits.jsonl',)   # TB: lookupscan's hit windows (may carry task text) ship in full exports only
TRIAL_ID_RE = re.compile(r'^[0-9a-f]{32}$')
_ACCOUNT_RE = re.compile(r'(?<!\d)\d{12}(?!\d)')
# Token-shaped content never leaves the runner: a file that matches is left out of every export and listed.
_SECRET_RES = (re.compile(rb'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
               re.compile(rb'(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]{20,}'),
               re.compile(rb'(?i)"client_secret"\s*:\s*"[^"]{8,}"'))


def mask(text: str) -> str:
    return _ACCOUNT_RE.sub('<acct>', text)


def now() -> float:
    return time.time()


def iso(t: float | None = None) -> str:
    import datetime as dt
    return dt.datetime.fromtimestamp(t if t is not None else time.time(), dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


# ---------------------------------------------------------------- runner environment and paths

@dataclasses.dataclass(frozen=True)
class RunnerEnv:
    index: int
    count: int
    proxy_addr: str
    proxy_port: int
    work_dir: pathlib.Path
    results_prefix: str | None = None
    prepull: tuple[str, ...] = ()
    region: str | None = None
    container_egress: str | None = None     # a3: CONTAINER_EGRESS=internet on runners switched for TB (absent: none)
    online_network: str | None = None       # a3: ONLINE_NETWORK (llmar-online), passed to Harbor for llmar_env (4f)
    online_dns: str | None = None           # a3: ONLINE_DNS (the VPC resolver), passed to Harbor for llmar_env (4f)

    @staticmethod
    def parse(text: str) -> dict[str, str]:
        out: dict[str, str] = {}
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                v = v[1:-1]
            out[k.strip()] = v
        return out

    @classmethod
    def load(cls, path: pathlib.Path = ENV_FILE, overrides: dict[str, Any] | None = None) -> 'RunnerEnv':
        kv = cls.parse(path.read_text(encoding='utf-8')) if path.exists() else {}
        o = {k: v for k, v in (overrides or {}).items() if v is not None}
        try:
            env = cls(index=int(o.get('index', kv.get('RUNNER_INDEX', ''))), count=int(o.get('count', kv.get('RUNNER_COUNT', '1'))),
                      proxy_addr=str(o.get('proxy_addr', kv.get('PROXY_ADDR', ''))), proxy_port=int(o.get('proxy_port', kv.get('PROXY_PORT', '8088'))),
                      work_dir=pathlib.Path(o.get('work_dir', kv.get('WORK_DIR', '/srv/runner'))),
                      results_prefix=o.get('results_prefix', kv.get('RESULTS_PREFIX')),
                      prepull=tuple(str(o.get('prepull', kv.get('PREPULL_IMAGES', ''))).split()),
                      region=o.get('region', kv.get('AWS_REGION') or os.environ.get('AWS_REGION')),
                      container_egress=kv.get('CONTAINER_EGRESS') or None, online_network=kv.get('ONLINE_NETWORK') or None,
                      online_dns=kv.get('ONLINE_DNS') or None)
        except ValueError as e:
            raise SystemExit(f'{path}: RUNNER_INDEX/RUNNER_COUNT/PROXY_PORT must be integers ({e})') from None
        if not 0 <= env.index < env.count:
            raise SystemExit(f'runner index {env.index} is outside 0..{env.count - 1}')
        if env.results_prefix is not None and not re.fullmatch(r'runs/\d+/', env.results_prefix):
            raise SystemExit(f'RESULTS_PREFIX {env.results_prefix!r} is not runs/<i>/')
        if env.container_egress not in (None, 'none', 'internet'):
            raise SystemExit(f'CONTAINER_EGRESS {env.container_egress!r} is not none or internet')
        if env.online_network is not None and not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,62}', env.online_network):
            raise SystemExit('ONLINE_NETWORK is not a docker network name')
        if env.online_dns is not None and not re.fullmatch(r'(\d{1,3}\.){3}\d{1,3}', env.online_dns):
            raise SystemExit('ONLINE_DNS is not an IPv4 address')
        return env

    def online_env(self) -> dict[str, str]:
        """The keys llmar_env (4f) needs in the `harbor run` environment in internet mode; empty otherwise."""
        if self.container_egress != 'internet':
            return {}
        if not (self.online_network and self.online_dns):
            raise SystemExit('CONTAINER_EGRESS=internet but ONLINE_NETWORK / ONLINE_DNS are missing (/etc/llmar-runner.env)')
        return {'ONLINE_NETWORK': self.online_network, 'ONLINE_DNS': self.online_dns}


class Paths:
    def __init__(self, work: pathlib.Path, profile: profiles.Dataset = profiles.DEEPSWE):
        self.work = work
        self.results = work / profile.results
        self.jobs = self.results / 'jobs'
        self.attempts = self.results / 'attempts'
        self.events = self.results / 'attempts.jsonl'
        self.checks = self.results / 'checks'
        self.check_events = self.results / 'checks.jsonl'
        self.check_summary = self.checks / 'summary.json'
        self.proxy = self.results / 'proxy'
        self.metrics = self.results / 'host-metrics.jsonl'
        self.docker_events = self.results / 'docker-events.jsonl'
        self.kernel_oom = self.results / 'kernel-oom.jsonl'
        self.status = self.results / 'status.json'
        self.run_config = self.results / 'run-config.json'
        self.prepull = self.results / 'prepull.json'
        self.tasks_meta = self.results / 'tasks.json'
        self.log = self.results / 'driver.log'
        self.stop = self.results / 'STOP'
        self.lock = self.results / 'driver.lock'
        self.exports = work / profile.exports
        self.tasks = work / profile.checkout / 'tasks'
        if not profile.is_default:
            self.checkout = work / profile.checkout

    def mkdirs(self) -> None:
        for d in (self.results, self.jobs, self.attempts, self.checks, self.proxy, self.exports):
            d.mkdir(parents=True, exist_ok=True, mode=0o700)


# ---------------------------------------------------------------- files

_append_lock = threading.Lock()


def append_jsonl(path: pathlib.Path, row: dict[str, Any]) -> None:
    line = json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(',', ':'), default=str) + '\n'
    with _append_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    """Objects of a JSONL file; a torn last line (crash mid-write) is skipped."""
    out: list[dict[str, Any]] = []
    if not path.exists():
        return out
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, dict):
                out.append(o)
    return out


def write_json(path: pathlib.Path, data: Any) -> None:
    shardplan.write_json(path, data)


def read_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding='utf-8'))


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class Log:
    def __init__(self, path: pathlib.Path | None, echo: bool = True):
        self.path, self.echo = path, echo
        self._lock = threading.Lock()

    def __call__(self, msg: str) -> None:
        line = f'{iso()} {mask(msg)}'
        with self._lock:
            if self.echo:
                print(line, flush=True)
            if self.path:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with open(self.path, 'a', encoding='utf-8') as f:
                    f.write(line + '\n')


# ---------------------------------------------------------------- tasks

def task_dir(paths: Paths, task: str) -> pathlib.Path:
    if not re.fullmatch(shardplan.TASK_ID_RE, task):
        raise ValueError(f'bad task id {task!r}')
    return paths.tasks / task


def task_image(tdir: pathlib.Path) -> str:
    cfg = tomllib.loads((tdir / 'task.toml').read_text(encoding='utf-8'))
    img = (cfg.get('environment') or {}).get('docker_image')
    if not isinstance(img, str) or not img:
        raise ValueError(f'{tdir.name}: task.toml has no environment.docker_image')
    return img


def check_task_files(plan: dict[str, Any], paths: Paths, tasks: Iterable[str]) -> list[str]:
    """Problems with the local task checkout: a missing task, or a task.toml whose sha256 is not the plan's."""
    issues = []
    for t in tasks:
        p = task_dir(paths, t) / 'task.toml'
        want = plan['tasks'][t].get('task_toml_sha256_b64')
        if not p.is_file():
            issues.append(f'{t}: missing')
        elif want and shardplan.sha256_b64(p) != want:
            issues.append(f'{t}: task.toml differs from the plan')
    return issues


# ---------------------------------------------------------------- subprocess runner (Harbor)

@dataclasses.dataclass
class Proc:
    argv: list[str]
    log_path: pathlib.Path
    popen: subprocess.Popen | None = None
    killed: str | None = None
    rc: int | None = None


# The only variables of the driver's environment a Harbor subprocess inherits (18's F6: an allowlist, so no API
# key, Codex auth path or AWS credential can reach Harbor's agent setup); harbor_job.harbor_env (4f) then adds
# HARBOR_TELEMETRY=0 and PYTHONPATH and scrubs again.
HARBOR_ENV_ALLOW = ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONFIG',
                    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME')


def harbor_subprocess_env(base: dict[str, str] | None = None, extra: dict[str, str] | None = None) -> dict[str, str]:
    """`extra`: ONLINE_NETWORK and ONLINE_DNS from the runner env file in internet mode (RunnerEnv.online_env), never
    from the driver's own environment."""
    src = os.environ if base is None else base
    env = {k: src[k] for k in HARBOR_ENV_ALLOW if k in src}
    if extra:
        env.update(extra)
    try:
        import harbor_job
        env = harbor_job.harbor_env(env)
    except ImportError:   # 4f's module is not importable (unit tests of the driver alone)
        env.update({'HARBOR_TELEMETRY': '0', 'PYTHONPATH': str(HERE)})
    return env


class Harbor:
    """Launches Harbor in its own process group (so a stop or a watchdog can signal the whole tree), with the
    allowlisted environment of harbor_subprocess_env."""

    def __init__(self, exe: str = 'harbor', env: dict[str, str] | None = None):
        self.exe = exe
        self.env = env if env is not None else harbor_subprocess_env()

    def run_argv(self, job_json: pathlib.Path) -> list[str]:
        return [self.exe, 'run', '--config', str(job_json), '--yes']

    def regrade_argv(self, source_job_dir: pathlib.Path, tdir: pathlib.Path, jobs_dir: pathlib.Path, job_name: str) -> list[str]:
        return [self.exe, 'jobs', 'regrade', str(source_job_dir), '--task-path', str(tdir), '--jobs-dir', str(jobs_dir),
                '--job-name', job_name, '--n-concurrent', '1', '--yes']

    def start(self, argv: list[str], log_path: pathlib.Path, cwd: pathlib.Path) -> Proc:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        f = open(log_path, 'ab')
        try:
            p = subprocess.Popen(argv, cwd=cwd, env=self.env, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,  # nosec B603
                                 start_new_session=True)
        finally:
            f.close()
        return Proc(argv, log_path, p)

    @staticmethod
    def signal_group(pgid: int, sig: int) -> bool:
        try:
            os.killpg(pgid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def wait(self, proc: Proc, deadline: float, stop: threading.Event, grace_s: float = STOP_GRACE_S,
             poll_s: float = 1.0) -> Proc:
        """Waits for the process; at the deadline (watchdog) or when `stop` is set, SIGINT to its group, then SIGKILL
        after the grace period."""
        p = proc.popen
        assert p is not None
        while True:
            try:
                proc.rc = p.wait(timeout=poll_s)
                return proc
            except subprocess.TimeoutExpired:
                pass
            why = 'operator' if stop.is_set() else ('wall-timeout' if now() > deadline else None)
            if why:
                proc.killed = why
                self.signal_group(p.pid, signal.SIGINT)
                try:
                    proc.rc = p.wait(timeout=grace_s)
                except subprocess.TimeoutExpired:
                    self.signal_group(p.pid, signal.SIGKILL)
                    proc.rc = p.wait()
                return proc


def pid_alive(pid: int | None, must_contain: str = 'harbor') -> bool:
    if not pid:
        return False
    try:
        cmd = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
    except OSError:
        return False
    return must_contain.encode() in cmd


def kill_group(pid: int, grace_s: float = 30.0) -> None:
    Harbor.signal_group(pid, signal.SIGINT)
    t_end = now() + grace_s
    while now() < t_end and pid_alive(pid, ''):
        time.sleep(0.5)
    Harbor.signal_group(pid, signal.SIGKILL)


# ---------------------------------------------------------------- Harbor outputs

def compose_prefix(trial_name: str) -> str:
    """Harbor 0.25.0's compose project names for a trial all start with its sanitized trial name
    (environments/docker/docker.py: lowercase, [^a-z0-9_-] → '-')."""
    name = trial_name.lower()
    if not re.match(r'^[a-z0-9]', name):
        name = '0' + name
    return re.sub(r'[^a-z0-9_-]', '-', name)


def trial_dir_of(job_dir: pathlib.Path) -> pathlib.Path | None:
    """The single trial directory of a one-trial job (the subdir with config.json or result.json)."""
    if not job_dir.is_dir():
        return None
    dirs = sorted(d for d in job_dir.iterdir() if d.is_dir() and not d.name.startswith('.') and
                  ((d / 'result.json').exists() or (d / 'config.json').exists()))
    return dirs[-1] if dirs else None


def load_result(tdir: pathlib.Path | None) -> dict[str, Any] | None:
    if tdir is None or not (tdir / 'result.json').is_file():
        return None
    try:
        r = read_json(tdir / 'result.json')
    except (OSError, ValueError):
        return None
    return r if isinstance(r, dict) else None


def task_watchdog_s(task_meta: dict[str, Any]) -> float:
    """TB: the task's own agent + verifier + build timeouts + profiles.WATCHDOG_MARGIN_S (build-pov-ray: 7.3 h)."""
    return (float(task_meta['agent_timeout_s']) + float(task_meta['verifier_timeout_s']) + float(task_meta.get('build_timeout_s') or 600)
            + profiles.WATCHDOG_MARGIN_S)


def cc_result(tdir: pathlib.Path | None, tail_bytes: int = 1 << 20) -> dict[str, Any]:
    """Claude Code (4f): the stream-json `result` event of agent/claude-code.txt (Harbor pipes `claude --print` into
    tee without pipefail, so the exit status can be 0 on failure). {'result': 'present'|'missing', 'subtype',
    'is_error'}; codes only, never text."""
    out: dict[str, Any] = {'result': 'missing', 'subtype': None, 'is_error': None}
    p = tdir / 'agent' / 'claude-code.txt' if tdir is not None else None
    if p is None or not p.is_file():
        return out
    with open(p, 'rb') as f:
        f.seek(max(0, p.stat().st_size - tail_bytes))
        lines = f.read().decode('utf-8', errors='replace').splitlines()
    for ln in reversed(lines):
        ln = ln.strip()
        if not ln.startswith('{'):
            continue
        try:
            e = json.loads(ln)
        except ValueError:
            continue
        if isinstance(e, dict) and e.get('type') == 'result':
            sub = e.get('subtype')
            return {'result': 'present', 'subtype': sub if isinstance(sub, str) and re.fullmatch(r'[a-z_]{1,40}', sub) else None,
                    'is_error': bool(e.get('is_error'))}
    return out


def verifier_evidence(tdir: pathlib.Path | None, tail_bytes: int = 512 << 10) -> dict[str, Any]:
    """TB rule (b) inputs from the trial dir (Harbor 0.25.0: verifier/ctrf.json, verifier/test-stdout.txt): whether
    pytest's CTRF report exists and counts tests, and the first network-error pattern in the stdout's last
    `tail_bytes`. Pattern names only; no text."""
    out: dict[str, Any] = {'ctrf': False, 'tests_ran': False, 'net_error': None}
    if tdir is None:
        return out
    cp = tdir / 'verifier' / 'ctrf.json'
    if cp.is_file():
        out['ctrf'] = True
        try:
            out['tests_ran'] = clf.tests_ran(json.loads(cp.read_text(encoding='utf-8', errors='replace')))
        except ValueError:
            out['tests_ran'] = False
    sp = tdir / 'verifier' / 'test-stdout.txt'
    if sp.is_file():
        with open(sp, 'rb') as f:
            f.seek(max(0, sp.stat().st_size - tail_bytes))
            out['net_error'] = clf.net_error(f.read().decode('utf-8', errors='replace'))
    return out


def patch_bytes(tdir: pathlib.Path | None) -> int | None:
    if tdir is None:
        return None
    p = tdir / 'artifacts' / 'model.patch'
    return p.stat().st_size if p.is_file() else None


def timing_s(result: dict[str, Any] | None, phase: str) -> float | None:
    import datetime as dt
    t = (result or {}).get(phase) or {}
    try:
        a = dt.datetime.fromisoformat(str(t['started_at']).replace('Z', '+00:00'))
        b = dt.datetime.fromisoformat(str(t['finished_at']).replace('Z', '+00:00'))
    except (KeyError, TypeError, ValueError):
        return None
    return round((b - a).total_seconds(), 1)


# ---------------------------------------------------------------- host health

class Metrics:
    """runner-metrics readings (a3): cumulative counters, diffed per trial; a sampler every 60 s."""

    def __init__(self, exe: str | None = METRICS_BIN, out: pathlib.Path | None = None):
        self.exe = exe if exe and os.path.exists(exe) else None
        self.out = out
        self.samples: collections.deque[dict[str, Any]] = collections.deque(maxlen=24 * 60 * 3)
        self._lock = threading.Lock()

    def read(self) -> dict[str, Any] | None:
        if not self.exe:
            return None
        try:
            r = subprocess.run([self.exe], capture_output=True, text=True, timeout=20)  # nosec B603
            m = json.loads(r.stdout.strip().splitlines()[-1])
            return m if isinstance(m, dict) else None
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            return None

    def sample(self) -> dict[str, Any] | None:
        m = self.read()
        if m:
            with self._lock:
                self.samples.append(m)
            if self.out:
                append_jsonl(self.out, m)
        return m

    def window(self, t0: float, t1: float) -> list[dict[str, Any]]:
        with self._lock:
            return [s for s in self.samples if t0 <= float(s.get('ts') or 0) <= t1]


def metrics_delta(m0: dict[str, Any] | None, m1: dict[str, Any] | None, samples: list[dict[str, Any]] = ()) -> dict[str, Any]:
    """Host health over a trial: CPU steal and iowait share, load, memory and swap, PSI stall shares, the kernel's
    oom_kill delta, and the extremes of the 60 s samples in the window."""
    if not m0 or not m1:
        return {}
    out: dict[str, Any] = {'wall_s': round(float(m1.get('ts', 0)) - float(m0.get('ts', 0)), 1)}
    c0, c1 = m0.get('cpu_jiffies') or {}, m1.get('cpu_jiffies') or {}
    d = {k: int(c1.get(k, 0)) - int(c0.get(k, 0)) for k in c1}
    total = sum(v for v in d.values() if v > 0)
    if total > 0:
        out['cpu_steal'] = round(d.get('steal', 0) / total, 4)
        out['cpu_iowait'] = round(d.get('iowait', 0) / total, 4)
        out['cpu_busy'] = round(1 - (d.get('idle', 0) + d.get('iowait', 0)) / total, 4)
    for k in ('oom_kill', 'pswpin', 'pswpout'):
        if isinstance(m0.get(k), int) and isinstance(m1.get(k), int):
            out[k] = m1[k] - m0[k]
    wall_us = max(1.0, out['wall_s'] * 1e6)
    for res in ('cpu', 'memory', 'io'):
        p0, p1 = (m0.get('psi') or {}).get(res) or {}, (m1.get('psi') or {}).get(res) or {}
        for kind in ('some', 'full'):
            a, b = p0.get(f'{kind}_total_us'), p1.get(f'{kind}_total_us')
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                out[f'psi_{res}_{kind}'] = round((b - a) / wall_us, 4)
    ss = [s for s in (m0, *samples, m1) if s]
    loads = [s['load'][0] for s in ss if isinstance(s.get('load'), list) and s['load']]
    mem = [s['mem_available_kb'] for s in ss if isinstance(s.get('mem_available_kb'), int)]
    swap = [s['swap_total_kb'] - s['swap_free_kb'] for s in ss if isinstance(s.get('swap_total_kb'), int) and isinstance(s.get('swap_free_kb'), int)]
    free = [s['docker_free_bytes'] for s in ss if isinstance(s.get('docker_free_bytes'), int)]
    if loads:
        out['load1_max'] = max(loads)
    if mem:
        out['mem_available_kb_min'] = min(mem)
    if swap:
        out['swap_used_kb_max'] = max(swap)
    if free:
        out['docker_free_gb_min'] = round(min(free) / 1e9, 1)
    out['ncpu'] = m1.get('ncpu')
    return out


_OOM_LINE = re.compile(r'oom-kill:constraint=(CONSTRAINT_[A-Z_]+).*?task_memcg=([^,\s]+)')
_MEMCG_ID = re.compile(r'(?:docker-|/docker/)([0-9a-f]{64})')


def parse_kernel_oom(line: str, ts: float) -> dict[str, Any] | None:
    m = _OOM_LINE.search(line)
    if not m:
        return None
    cid = _MEMCG_ID.search(m.group(2))
    return {'ts': ts, 'constraint': m.group(1), 'container_id': cid.group(1) if cid else None}


class Watcher:
    """A long-running reader of a line stream (docker events, kernel log) that keeps parsed records in memory and
    appends them to a file. Restarts the stream if it ends."""

    def __init__(self, argv: list[str], parse: Callable[[str], dict[str, Any] | None], out: pathlib.Path | None, log: Log):
        self.argv, self.parse, self.out, self.log = argv, parse, out, log
        self.records: collections.deque[dict[str, Any]] = collections.deque(maxlen=200_000)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.proc: subprocess.Popen | None = None
        self.thread = threading.Thread(target=self._loop, name=f'watch-{argv[0]}', daemon=True)

    def start(self) -> 'Watcher':
        self.thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.proc = subprocess.Popen(self.argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)  # nosec B603
                assert self.proc.stdout is not None
                for line in self.proc.stdout:
                    rec = self.parse(line)
                    if rec:
                        with self._lock:
                            self.records.append(rec)
                        if self.out:
                            append_jsonl(self.out, rec)
            except OSError as e:
                self.log(f'watcher {self.argv[0]}: {e}')
            if self._stop.wait(5):
                return

    def window(self, t0: float, t1: float) -> list[dict[str, Any]]:
        with self._lock:
            return [r for r in self.records if t0 - 1 <= float(r.get('ts') or 0) <= t1 + 1]


def parse_docker_event(line: str) -> dict[str, Any] | None:
    try:
        e = json.loads(line)
    except ValueError:
        return None
    if not isinstance(e, dict) or e.get('Type') != 'container':
        return None
    attrs = (e.get('Actor') or {}).get('Attributes') or {}
    ts = e.get('timeNano')
    return {'ts': (int(ts) / 1e9) if ts else float(e.get('time') or 0), 'action': e.get('Action') or e.get('status'),
            'id': e.get('id') or (e.get('Actor') or {}).get('ID'), 'name': attrs.get('name'),
            'project': attrs.get('com.docker.compose.project'), 'exit_code': attrs.get('exitCode')}


def parse_journal_line(line: str) -> dict[str, Any] | None:
    """`journalctl -k -o short-unix`: '<epoch.usec> <host> kernel: <message>'."""
    parts = line.split(' ', 1)
    try:
        ts = float(parts[0])
    except (ValueError, IndexError):
        return None
    return parse_kernel_oom(line, ts)


_OOM_TASK = re.compile(r'\btask=([^,\s]+)')
_OOM_KILLED = re.compile(r'Killed process \d+ \(([^)]+)\)')


def parse_journal_line_victim(line: str) -> dict[str, Any] | None:
    """parse_journal_line plus the OOM victim's process name (`task=<comm>` on the oom-kill line; Claude Code §2.4)."""
    rec = parse_journal_line(line)
    if rec is not None:
        m = _OOM_TASK.search(line) or _OOM_KILLED.search(line)
        rec['task'] = m.group(1) if m else None
    return rec


class MemSampler:
    """Claude Code §2.4 (a3): every `every_s`, for each running trial's compose containers, the cgroup v2 counters
    (memory.peak, memory.events oom/oom_kill, memory.stat anon, memory.swap.current/peak, memory.max) and the agent
    process's RSS from `docker top <cid> -eo pid,rss,comm` (host-side reads; nothing is exec'd in a container). The
    last sample before Harbor deletes a container is its record; the kernel log stays the OOM backstop.
    `prefixes()` returns {trial_id: compose prefix} of the running trials."""

    AGENT = ('claude', 'bun', 'node')

    def __init__(self, prefixes: Callable[[], dict[str, str]], run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
                 read: Callable[[str], str] | None = None, every_s: float = 10.0, root: str = '/sys/fs/cgroup'):
        self.prefixes, self._run, self.every_s, self.root = prefixes, run, every_s, root
        self._read = read or (lambda p: pathlib.Path(p).read_text())
        self.peaks: dict[str, dict[str, Any]] = {}
        self._taken: set[str] = set()   # trials whose record was taken: never sampled again (no stale entries)
        self._pids: dict[str, int | None] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, name='mem-sampler', daemon=True)

    def _out(self, *argv: str) -> str:
        try:
            r = self._run(list(argv), capture_output=True, text=True, timeout=30)  # nosec B603 - fixed argv
        except (OSError, subprocess.TimeoutExpired):
            return ''
        return r.stdout if r.returncode == 0 else ''

    def cgroup_dir(self, cid: str) -> str | None:
        """The container's cgroup: from /proc/<its pid>/cgroup (`0::/system.slice/docker-<id>.scope`), else the
        systemd-driver default path."""
        if cid not in self._pids:
            out = self._out('docker', 'inspect', '-f', '{{.State.Pid}}', cid).strip()
            self._pids[cid] = int(out) if out.isdigit() and int(out) > 0 else None
        pid = self._pids[cid]
        if pid:
            try:
                for line in self._read(f'/proc/{pid}/cgroup').splitlines():
                    if line.startswith('0::'):
                        return self.root + line[3:].strip()
            except OSError:
                pass
        return f'{self.root}/system.slice/docker-{cid}.scope'

    def _num(self, path: str) -> int | None:
        try:
            v = self._read(path).strip()
        except OSError:
            return None
        return int(v) if v.isdigit() else None

    def _kv(self, path: str) -> dict[str, int]:
        try:
            return {k: int(v) for k, v in (ln.split() for ln in self._read(path).splitlines() if len(ln.split()) == 2) if v.isdigit()}
        except OSError:
            return {}

    def sample(self) -> None:
        pre = self.prefixes()
        if not pre:
            return
        fmt = '{{.ID}} {{.Label "com.docker.compose.project"}}'
        rows = [ln.split(' ', 1) for ln in self._out('docker', 'ps', '--no-trunc', '--format', fmt).splitlines() if ' ' in ln]
        for tid, prefix in pre.items():
            if tid in self._taken:
                continue
            for cid, project in rows:
                if not project.startswith(prefix):
                    continue
                d = self.cgroup_dir(cid)
                rec = {'mem_peak': self._num(f'{d}/memory.peak'), 'mem_max': self._num(f'{d}/memory.max'),
                       'swap_peak': self._num(f'{d}/memory.swap.peak'), 'swap_current': self._num(f'{d}/memory.swap.current')}
                ev = self._kv(f'{d}/memory.events')
                anon = self._kv(f'{d}/memory.stat').get('anon')
                rss = 0
                for ln in self._out('docker', 'top', cid, '-eo', 'pid,rss,comm').splitlines()[1:]:
                    parts = ln.split(None, 2)
                    if len(parts) == 3 and parts[1].isdigit() and parts[2].strip().split('/')[-1] in self.AGENT:
                        rss = max(rss, int(parts[1]))
                with self._lock:
                    p = self.peaks.setdefault(tid, {'containers': set(), 'container_mem_peak_mb': 0, 'agent_rss_peak_mb': 0,
                                                    'anon_peak_mb': 0, 'swap_peak_mb': 0, 'mem_limit_mb': None, 'oom': 0, 'oom_kill': 0})
                    p['containers'].add(cid)
                    p['container_mem_peak_mb'] = max(p['container_mem_peak_mb'], round((rec['mem_peak'] or 0) / 2**20))
                    p['agent_rss_peak_mb'] = max(p['agent_rss_peak_mb'], round(rss / 1024))
                    p['anon_peak_mb'] = max(p['anon_peak_mb'], round((anon or 0) / 2**20))
                    p['swap_peak_mb'] = max(p['swap_peak_mb'], round((rec['swap_peak'] or rec['swap_current'] or 0) / 2**20))
                    if rec['mem_max']:
                        p['mem_limit_mb'] = round(rec['mem_max'] / 2**20)
                    p['oom'] = max(p['oom'], ev.get('oom', 0))
                    p['oom_kill'] = max(p['oom_kill'], ev.get('oom_kill', 0))

    def take(self, trial_id: str) -> dict[str, Any] | None:
        """The trial's record (one last sample first), removed from the sampler."""
        with contextlib.suppress(Exception):
            self.sample()
        with self._lock:
            p = self.peaks.pop(trial_id, None)
            self._taken.add(trial_id)
        if p is None:
            return None
        return {**{k: v for k, v in p.items() if k != 'containers'}, 'containers': len(p['containers'])}

    def start(self) -> MemSampler:
        self.thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(self.every_s):
            with contextlib.suppress(Exception):   # telemetry never fails a trial
                self.sample()


def host_oom_summary(trial_name: str | None, t0: float, t1: float, docker: Watcher | None, kernel: Watcher | None,
                     victims: bool = False) -> dict[str, Any]:
    """Per trial: OOM kills of its containers (kernel log, global vs container limit), all global kills in the
    window, its containers' docker oom events and exit-137 deaths."""
    out: dict[str, Any] = {'oom_global_trial': 0, 'oom_memcg_trial': 0, 'oom_global_window': 0, 'docker_oom': 0, 'exit137': 0,
                           'containers': 0, 'observed': docker is not None and kernel is not None}
    ids: set[str] = set()
    if docker is not None and trial_name:
        pre = compose_prefix(trial_name)
        evs = [e for e in docker.window(t0, t1) if str(e.get('project') or '').startswith(pre)]
        ids = {str(e['id']) for e in evs if e.get('id')}
        out['containers'] = len(ids)
        out['docker_oom'] = sum(1 for e in evs if e.get('action') == 'oom')
        out['exit137'] = sum(1 for e in evs if e.get('action') == 'die' and str(e.get('exit_code')) == '137')
    if kernel is not None:
        names: list[str] = []
        for k in kernel.window(t0, t1):
            glob = k.get('constraint') != 'CONSTRAINT_MEMCG'
            out['oom_global_window'] += int(glob)
            if k.get('container_id') in ids:
                out['oom_global_trial' if glob else 'oom_memcg_trial'] += 1
                if k.get('task'):
                    names.append(str(k['task']))
        if victims:
            out['oom_victims'] = names
    return out


# ---------------------------------------------------------------- docker hygiene

class Docker:
    """The few docker commands the driver runs on the host: pulls, and removing a finished trial's leftover compose
    containers and networks (Harbor deletes them; a crashed trial can leak them)."""

    def __init__(self, exe: str = 'docker', run: Callable[..., subprocess.CompletedProcess] = subprocess.run):
        self.exe, self._run = exe, run

    def _out(self, *args: str, timeout: float = 120) -> str:
        r = self._run([self.exe, *args], capture_output=True, text=True, timeout=timeout)  # nosec B603
        return r.stdout if r.returncode == 0 else ''

    def projects(self, kind: str) -> list[tuple[str, str]]:
        """(id, compose project) of every container ('ps') or network ('network') with a compose project label."""
        fmt = '{{.ID}} {{.Label "com.docker.compose.project"}}'
        out = self._out('ps', '-a', '--format', fmt) if kind == 'ps' else self._out('network', 'ls', '--format', fmt)
        return [(a, b) for a, _, b in (line.partition(' ') for line in out.splitlines()) if a and b]

    def cleanup(self, prefixes: list[str]) -> dict[str, int]:
        """Removes containers, then networks, whose compose project starts with one of the prefixes."""
        if not prefixes:
            return {'containers': 0, 'networks': 0}
        cs = [i for i, p in self.projects('ps') if any(p.startswith(x) for x in prefixes)]
        if cs:
            self._out('rm', '-f', *cs)
        ns = [i for i, p in self.projects('network') if any(p.startswith(x) for x in prefixes)]
        if ns:
            self._out('network', 'rm', *ns)
        return {'containers': len(cs), 'networks': len(ns)}

    def prune_networks(self) -> str:
        """Unused compose networks only (0d: crashed trials leak them)."""
        return self._out('network', 'prune', '-f', '--filter', 'label=com.docker.compose.project')

    def pull(self, image: str, timeout: float = 3600) -> tuple[bool, str]:
        r = self._run([self.exe, 'pull', '-q', image], capture_output=True, text=True, timeout=timeout)  # nosec B603
        return r.returncode == 0, (r.stdout + r.stderr).strip()[-300:]

    def tag(self, src: str, dst: str) -> tuple[bool, str]:
        r = self._run([self.exe, 'tag', src, dst], capture_output=True, text=True, timeout=120)  # nosec B603
        return r.returncode == 0, (r.stdout + r.stderr).strip()[-300:]

    def repo_digests(self, image: str) -> list[str]:
        out = self._out('image', 'inspect', '--format', '{{json .RepoDigests}}', image).strip()
        try:
            v = json.loads(out or '[]')
        except ValueError:
            return []
        return sorted(str(x) for x in v) if isinstance(v, list) else []

    def image_size(self, image: str) -> int | None:
        out = self._out('image', 'inspect', '--format', '{{.Size}}', image)
        return int(out.strip()) if out.strip().isdigit() else None


def free_gb(paths: list[pathlib.Path]) -> float:
    vals = [shutil.disk_usage(p).free / 1e9 for p in paths if p.exists()]
    return min(vals) if vals else float('inf')


# ---------------------------------------------------------------- state from the event log

def key_of(pass_name: str, task: str, arm: str, rep: int) -> str:
    return f'{pass_name}/{task}/{arm}/r{rep}'


@dataclasses.dataclass
class Attempt:
    trial_id: str
    n: int
    start: dict[str, Any]
    end: dict[str, Any] | None = None
    reverifies: list[dict[str, Any]] = dataclasses.field(default_factory=list)   # reverify-end events
    reclass: dict[str, Any] | None = None   # Claude Code: a `reclass` event (driver.py requeue, from the router-log join)

    @property
    def outcome(self) -> dict[str, Any] | None:
        """The attempt's latest classification (a reclass's, else a re-verify's, if any)."""
        if self.reclass:
            return self.reclass['classification']
        if self.reverifies:
            return self.reverifies[-1]['classification']
        return self.end['classification'] if self.end else None


@dataclasses.dataclass
class KeyState:
    key: str
    item: dict[str, Any]
    attempts: list[Attempt] = dataclasses.field(default_factory=list)
    final: dict[str, Any] | None = None
    reverify_running: bool = False

    @property
    def reruns(self) -> int:
        return sum(1 for a in self.attempts if a.end and (a.reclass or a.end)['classification']['class'] in clf.RERUN_CLASSES
                   and a.outcome and a.outcome['action'] == 'rerun')

    def next_action(self) -> tuple[str, dict[str, Any] | None]:
        """('done'|'start'|'running'|'rerun'|'reverify', final-record-if-decided-now)."""
        if self.final:
            return 'done', None
        if not self.attempts:
            return 'start', None
        last = self.attempts[-1]
        if last.end is None or self.reverify_running:
            return 'running', None
        out = last.outcome or {}
        act = out.get('action')
        if act in ('score', 'score_zero'):
            return 'done', self._final('scored', last, out)
        if act == 'exclude':
            return 'done', self._final('excluded', last, out)
        if act == 'reverify':
            if len(last.reverifies) >= MAX_REVERIFIES:
                return 'done', self._final('excluded', last, {**out, 'reason': f"{out.get('reason')}; still errored after {MAX_REVERIFIES} re-verifies"})
            return 'reverify', None
        if act == 'rerun':
            infra = sum(1 for a in self.attempts if a.end and (a.outcome or {}).get('class') in clf.RERUN_CLASSES)
            if infra > MAX_RERUNS:
                return 'done', self._final('excluded', last, {**out, 'reason': f"{out.get('reason')}; still errored after {MAX_RERUNS} reruns"})
            return 'rerun', None
        return 'done', self._final('excluded', last, {**out, 'reason': f'unknown action {act!r}'})

    def _final(self, status: str, last: Attempt, out: dict[str, Any]) -> dict[str, Any]:
        return {'ev': 'final', 'key': self.key, 'status': status, 'trial_id': last.trial_id, 'class': out.get('class'),
                'score': out.get('score') if status == 'scored' else None, 'reason': out.get('reason'),
                'attempts': len(self.attempts), 'reruns': max(0, len(self.attempts) - 1),
                'reverifies': sum(len(a.reverifies) for a in self.attempts), **{k: self.item[k] for k in ('pass', 'phase', 'block', 'task', 'arm', 'rep')}}


def pinned_model(plan: dict[str, Any], arm: str | None) -> str | None:
    """Claude Code: the arm's pinned main model (M_arm, 0d §13) from the plan's arm table; None for an auto arm (its M
    is the router's assessed tier, known only from the router logs) or a plan without an arm table (Codex)."""
    spec = (plan.get('arms') or {}).get(str(arm)) if isinstance(plan.get('arms'), dict) else None
    m = (spec or {}).get('main_model')
    return m if m and m != 'auto' else None


def replay(events: list[dict[str, Any]], items: list[dict[str, Any]]) -> dict[str, KeyState]:
    """Rebuild the state of every planned key from the event log (events of keys not in `items` are kept too,
    so a status of a different pass list still sees them). Claude Code operator events (append-only, written with the
    driver stopped): `void` (driver.py void-pass) forgets every earlier attempt and final of its passes, so they run
    again from scratch; `reclass` (driver.py requeue) replaces an attempt's classification and drops its key's final."""
    st: dict[str, KeyState] = {}
    for it in items:
        k = key_of(it['pass'], it['task'], it['arm'], it['rep'])
        st[k] = KeyState(k, it)
    by_tid: dict[str, Attempt] = {}
    for e in events:
        ev = e.get('ev')
        if ev == 'start':
            k = e['key']
            if k not in st:
                st[k] = KeyState(k, {x: e.get(x) for x in ('pass', 'phase', 'block', 'task', 'arm', 'rep')})
            a = Attempt(e['trial_id'], int(e.get('attempt') or len(st[k].attempts) + 1), e)
            st[k].attempts.append(a)
            by_tid[a.trial_id] = a
        elif ev == 'pid' and e.get('trial_id') in by_tid:
            a = by_tid[e['trial_id']]
            a.start = {**a.start, 'pid': e.get('pid')}
        elif ev == 'end' and e.get('trial_id') in by_tid:
            by_tid[e['trial_id']].end = e
        elif ev == 'reverify-end' and e.get('trial_id') in by_tid:
            by_tid[e['trial_id']].reverifies.append(e)
        elif ev == 'final' and e.get('key') in st:
            st[e['key']].final = e
        elif ev == 'void':
            vp = set(e.get('passes') or [])
            for ks in st.values():
                if ks.item.get('pass') in vp:
                    for a in ks.attempts:
                        by_tid.pop(a.trial_id, None)
                    ks.attempts, ks.final, ks.reverify_running = [], None, False
        elif ev == 'reclass' and e.get('trial_id') in by_tid:
            a = by_tid[e['trial_id']]
            a.reclass = e
            ks = st.get(str(e.get('key')))
            if ks and ks.final and ks.final.get('trial_id') == a.trial_id:
                ks.final = None
    return st


def voided(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """{trial_id: the void event that forgot it} for every attempt dropped by a `void` event."""
    out: dict[str, dict[str, Any]] = {}
    for e in events:
        if e.get('ev') == 'void':
            for tid in e.get('trial_ids') or []:
                out.setdefault(str(tid), e)
    return out


# ---------------------------------------------------------------- checks gate

def check_gate(paths: Paths, tasks: list[str]) -> tuple[set[str], list[str]]:
    """(tasks dropped by the oracle/null checks, tasks whose checks are missing or unresolved)."""
    if not paths.check_summary.exists():
        return set(), sorted(tasks)
    summ = read_json(paths.check_summary).get('tasks', {})
    dropped = {t for t in tasks if (summ.get(t) or {}).get('drop')}
    unresolved = sorted(t for t in tasks if not (summ.get(t) or {}).get('drop') and (summ.get(t) or {}).get('ok') is not True)
    return dropped, unresolved


# ---------------------------------------------------------------- the live scheduler

@dataclasses.dataclass
class Running:
    kind: str                  # 'trial' | 'reverify'
    key: str
    trial_id: str
    started: float
    thread: threading.Thread
    item: dict[str, Any]


class Driver:
    def __init__(self, *, plan: dict[str, Any], env: RunnerEnv, paths: Paths, passes: list[str], proxy: Any, harbor: Harbor,
                 job_config: Callable[..., dict[str, Any]], concurrency: int = DEFAULT_CONCURRENCY, soft_cap: float = DEFAULT_SOFT_CAP,
                 max_blocks: int | None = None, wall_timeout_s: float = WALL_TIMEOUT_H * 3600, min_free_gb: float = MIN_FREE_GB,
                 max_consecutive_harness: int = MAX_CONSECUTIVE_HARNESS, metrics: Metrics | None = None, docker: Docker | None = None,
                 docker_watch: Watcher | None = None, kernel_watch: Watcher | None = None, log: Log | None = None,
                 grace_s: float = STOP_GRACE_S, poll_s: float = 1.0, check_gate_on: bool = True,
                 disk_paths: list[pathlib.Path] | None = None, profile: profiles.Dataset = profiles.DEEPSWE,
                 preflight: Callable[[], None] | None = None,
                 lookup: Callable[[pathlib.Path, pathlib.Path], tuple[dict[str, Any], list[dict[str, Any]]]] | None = None,
                 mem: MemSampler | None = None):
        if not 1 <= concurrency <= profile.max_concurrency:
            raise ValueError(f'concurrency must be 1..{profile.max_concurrency}')
        self.profile, self.preflight, self.lookup, self.mem = profile, preflight, lookup, mem
        self.plan, self.env, self.paths, self.passes = plan, env, paths, passes
        self.proxy, self.harbor, self.job_config = proxy, harbor, job_config
        self.concurrency, self.soft_cap, self.max_blocks = concurrency, soft_cap, max_blocks
        self.wall_timeout_s, self.min_free_gb, self.max_cons = wall_timeout_s, min_free_gb, max_consecutive_harness
        self.metrics = metrics or Metrics(None)
        self.docker = docker
        self.docker_watch, self.kernel_watch = docker_watch, kernel_watch
        self.log = log or Log(None)
        self.grace_s, self.poll_s = grace_s, poll_s
        self.disk_paths = disk_paths if disk_paths is not None else [paths.results, pathlib.Path('/var/lib/docker')]
        self.shard = env.index
        self.stop_now = threading.Event()     # cancel running trials (SIGTERM, `stop --now`)
        self.lock = threading.Lock()
        self.running: dict[str, Running] = {}
        self.no_new_blocks: str | None = None   # soft cap, checkpoint, STOP, disk
        self.halt: str | None = None            # no new trials at all: hard cap, harness errors, proxy down
        self.consecutive_harness = 0
        self.recent_errors: collections.deque[str] = collections.deque(maxlen=8)
        for p in passes:
            if p not in plan['passes']:
                raise ValueError(f'no pass {p!r} in the plan')
        self.items = [it for p in passes for it in shardplan.trials_of(plan, p, self.shard)]
        self.plan_sha256 = plan.get('_sha256')
        tasks = sorted({it['task'] for it in self.items})
        self.dropped, unresolved = check_gate(paths, tasks)
        if check_gate_on and unresolved:
            raise SystemExit(f'oracle/null checks missing or unresolved for {len(unresolved)} tasks (e.g. {unresolved[:3]}): run `driver.py check`')
        self.items = [it for it in self.items if it['task'] not in self.dropped]
        self.blocks: list[tuple[str, int]] = []
        for it in self.items:
            b = (it['pass'], it['block'])
            if b not in self.blocks:
                self.blocks.append(b)
        self.state = replay(read_jsonl(paths.events), self.items)
        self.block_keys: dict[tuple[str, int], list[str]] = collections.defaultdict(list)
        for it in self.items:
            self.block_keys[(it['pass'], it['block'])].append(key_of(it['pass'], it['task'], it['arm'], it['rep']))
        self.admitted_blocks: set[tuple[str, int]] = set()
        self.t_status = 0.0
        self.t_metrics = 0.0

    # ------------------------------------------------------------ events
    def emit(self, ev: dict[str, Any]) -> None:
        ev.setdefault('at', round(now(), 3))
        append_jsonl(self.paths.events, ev)
        with self.lock:
            k = ev.get('key')
            if ev['ev'] == 'start':
                ks = self.state.setdefault(k, KeyState(k, {x: ev.get(x) for x in ('pass', 'phase', 'block', 'task', 'arm', 'rep')}))
                ks.attempts.append(Attempt(ev['trial_id'], ev['attempt'], ev))
            elif ev['ev'] == 'pid':
                for ks in self.state.values():
                    for a in ks.attempts:
                        if a.trial_id == ev['trial_id']:
                            a.start = {**a.start, 'pid': ev.get('pid')}
            elif ev['ev'] in ('end', 'reverify-end'):
                for ks in self.state.values():
                    for a in ks.attempts:
                        if a.trial_id == ev['trial_id']:
                            if ev['ev'] == 'end':
                                a.end = ev
                            else:
                                a.reverifies.append(ev)
                                ks.reverify_running = False
            elif ev['ev'] == 'final' and k in self.state:
                self.state[k].final = ev

    def settle_finals(self) -> None:
        """Writes the final record of every key whose outcome is decided but not yet recorded."""
        for ks in list(self.state.values()):
            act, fin = ks.next_action()
            if fin:
                self.emit(fin)

    # ------------------------------------------------------------ orphans (crash recovery)
    def recover_orphans(self) -> int:
        n = 0
        for ks in list(self.state.values()):
            for a in ks.attempts:
                if a.end is None:
                    pid = a.start.get('pid')
                    if pid_alive(pid):
                        self.log(f'orphan {a.trial_id}: killing harbor process group {pid}')
                        kill_group(int(pid))
                    tdir = trial_dir_of(self.paths.jobs / a.trial_id)
                    if self.docker and tdir is not None:
                        self.docker.cleanup([compose_prefix(tdir.name)])
                    c = clf.classify(load_result(tdir), None, killed='driver-restart', patch_bytes=patch_bytes(tdir))
                    self.emit({'ev': 'end', 'trial_id': a.trial_id, 'key': ks.key, 'rc': None, 'killed': 'driver-restart',
                               'trial_dir': self._rel(tdir), 'classification': c, 'proxy': None, 'host': {}})
                    n += 1
        # A re-verify that started but never ended: kill its process group and remove its containers. It does not count
        # as a re-verify (it has no reverify-end), so it runs again.
        done_jobs = {e.get('job_name') for e in read_jsonl(self.paths.events) if e.get('ev') == 'reverify-end'}
        for e in read_jsonl(self.paths.events):
            if e.get('ev') == 'reverify-start' and e.get('job_name') not in done_jobs:
                if pid_alive(e.get('pid')):
                    kill_group(int(e['pid']))
                rdir = trial_dir_of(self.paths.jobs / str(e.get('job_name')))
                if self.docker and rdir is not None:
                    self.docker.cleanup([compose_prefix(rdir.name)])
                self.log(f"orphaned re-verify {e.get('job_name')} recovered")
        for ks in self.state.values():
            ks.reverify_running = False
        return n

    def _rel(self, p: pathlib.Path | None) -> str | None:
        if p is None:
            return None
        try:
            return str(p.relative_to(self.paths.results))
        except ValueError:
            return str(p)

    # ------------------------------------------------------------ stop conditions
    def spend(self) -> dict[str, Any]:
        try:
            return self.proxy.summary()
        except Exception as e:  # noqa: BLE001 - the proxy is gone: halt
            return {'error': type(e).__name__}

    def refresh_stops(self) -> None:
        sp = self.spend()
        if 'error' in sp:
            self.halt = self.halt or f"proxy summary failed: {sp['error']}"
        elif sp.get('stopped'):
            self.halt = self.halt or f"hard cap: proxy stopped ({sp['stopped']})"
        if float(sp.get('settled_usd') or 0.0) >= self.soft_cap:
            self.no_new_blocks = self.no_new_blocks or f"soft cap: ${float(sp.get('settled_usd') or 0):.2f} ≥ ${self.soft_cap:.0f}"
        if self.paths.stop.exists():
            self.no_new_blocks = self.no_new_blocks or 'stop requested (results/STOP)'
        gb = free_gb(self.disk_paths)
        if gb < self.min_free_gb:
            self.halt = self.halt or f'disk: {gb:.1f} GB free < {self.min_free_gb:.0f} GB'
        if self.max_blocks is not None and self.admitted_count() >= self.max_blocks:
            self.no_new_blocks = self.no_new_blocks or f'checkpoint: {self.max_blocks} blocks admitted (--max-blocks)'
        th = getattr(self.proxy, 'thread_alive', None)
        if callable(th) and not th():
            self.halt = self.halt or 'proxy thread died'

    def admitted(self, b: tuple[str, int]) -> bool:
        """A block is admitted once one of its trials has been handed to a worker (the worker logs the start event a
        moment later) or has an attempt in the log."""
        return b in self.admitted_blocks or any(self.state[k].attempts for k in self.block_keys[b])

    def admitted_count(self) -> int:
        return sum(1 for b in self.blocks if self.admitted(b))

    def block_done(self, b: tuple[str, int]) -> bool:
        return all(self.state[k].final for k in self.block_keys[b])

    # ------------------------------------------------------------ choosing work
    def next_work(self) -> tuple[str, str] | None:
        """(kind, key) of the next thing to start, or None."""
        if self.halt or self.stop_now.is_set():
            return None
        busy = {r.key for r in self.running.values()}
        admitted = [b for b in self.blocks if self.admitted(b)]
        for b in admitted:     # reruns and re-verifies first: complete the admitted blocks
            for k in self.block_keys[b]:
                if k in busy:
                    continue
                act, _ = self.state[k].next_action()
                if act in ('rerun', 'reverify'):
                    return (('reverify' if act == 'reverify' else 'trial'), k) if self.fits(k) else None
        for b in admitted:
            for k in self.block_keys[b]:
                if k not in busy and self.state[k].next_action()[0] == 'start':
                    return ('trial', k) if self.fits(k) else None
        if self.no_new_blocks:
            return None
        if self.max_blocks is not None and self.admitted_count() >= self.max_blocks:
            self.no_new_blocks = f'checkpoint: {self.max_blocks} blocks admitted (--max-blocks)'
            return None
        for b in self.blocks:
            if not self.admitted(b):
                if not self.fits(self.block_keys[b][0]):
                    return None
                self.on_admit(b)
                return 'trial', self.block_keys[b][0]
        return None

    # ------------------------------------------------------------ resources (TB: declared cpus and memory)
    def weight(self, item: dict[str, Any]) -> tuple[float, float]:
        m = self.plan['tasks'].get(item['task']) or {}
        return float(m.get('cpus') or 0.0), float(m.get('memory_mb') or 0.0) / 1024

    def in_use(self) -> tuple[float, float]:
        ws = [self.weight(r.item) for r in self.running.values()]
        return sum(w[0] for w in ws), sum(w[1] for w in ws)

    def fits(self, key: str) -> bool:
        """The admission budget (TB design §6.3): Σ declared cpus ≤ cpu_budget and Σ declared memory ≤ mem_budget_gb
        over the running trials, plus the trial count (the caller's `concurrency`). Head-of-line: the scheduler waits
        while the next candidate does not fit, so small blocks never starve a heavy one; on an empty host anything
        fits. No budget (DeepSWE): always True."""
        p = self.profile
        if (p.cpu_budget is None and p.mem_budget_gb is None) or not self.running:
            return True
        c, m = self.weight(self.state[key].item)
        uc, um = self.in_use()
        return (p.cpu_budget is None or uc + c <= p.cpu_budget + 1e-9) and (p.mem_budget_gb is None or um + m <= p.mem_budget_gb + 1e-9)

    def running_prefixes(self) -> dict[str, str]:
        """{trial_id: compose project prefix} of the running trials whose trial dir exists (the memory sampler)."""
        out = {}
        for r in list(self.running.values()):
            if r.kind == 'trial':
                tdir = trial_dir_of(self.paths.jobs / r.trial_id)
                if tdir is not None:
                    out[r.trial_id] = compose_prefix(tdir.name)
        return out

    def admission(self, item: dict[str, Any]) -> dict[str, Any]:
        c, m = self.weight(item)
        uc, um = self.in_use()
        return {'cpus': c, 'mem_gb': round(m, 3), 'in_flight_cpus': uc, 'in_flight_mem_gb': round(um, 3), 'in_flight_trials': len(self.running)}

    def watchdog_s(self, task: str) -> float:
        """DeepSWE: --wall-timeout-h. TB: the task's own agent + verifier + build timeouts + a margin."""
        if self.profile.wall_timeout_h is not None:
            return self.wall_timeout_s
        return task_watchdog_s(self.plan['tasks'][task])

    def on_admit(self, b: tuple[str, int]) -> None:
        if self.docker:
            self.docker.prune_networks()
        self.log(f'admit block {b[0]}#{b[1]} ({self.state[self.block_keys[b][0]].item["task"]}): '
                 f'{", ".join(self.state[k].item["arm"] for k in self.block_keys[b])}')

    # ------------------------------------------------------------ one trial
    def run_trial(self, key: str, trial_id: str) -> None:
        """One attempt; its start event was logged by start_work (dispatch order)."""
        ks = self.state[key]
        it = ks.item
        tdir_task = task_dir(self.paths, it['task'])
        adir = self.paths.attempts / trial_id
        adir.mkdir(parents=True, exist_ok=True)
        t0 = now()
        m0 = self.metrics.sample()
        base_url = None
        summary: dict[str, Any] | None = None
        proc: Proc | None = None
        try:
            if isinstance(self.plan.get('arms'), dict):   # Claude Code: the plan's frozen arm table (hint, pack, worst model)
                base_url = self.proxy.register_trial(trial_id, it['arm'], spec=self.plan['arms'][it['arm']])
            else:
                base_url = self.proxy.register_trial(trial_id, it['arm'])
            cfg = self.job_config(arm=it['arm'], trial_id=trial_id, task_dir=tdir_task, jobs_dir=self.paths.jobs,
                                  job_name=trial_id, base_url=base_url)
            if cfg.get('n_concurrent_trials') != 1 or (cfg.get('retry') or {}).get('max_retries', 0) != 0:
                raise ValueError('job config must have n_concurrent_trials=1 and retry.max_retries=0')
            write_json(adir / 'job.json', cfg)
            proc = self.harbor.start(self.harbor.run_argv(adir / 'job.json'), adir / 'harbor.log', adir)
            self.emit({'ev': 'pid', 'trial_id': trial_id, 'key': key, 'pid': proc.popen.pid if proc.popen else None})
            self.harbor.wait(proc, t0 + self.watchdog_s(it['task']), self.stop_now, self.grace_s, self.poll_s)
        except Exception as e:  # noqa: BLE001 - recorded as a harness error of this attempt
            self.log(f'{key} {trial_id}: {type(e).__name__}: {e}')
        finally:
            if base_url is not None:
                try:
                    summary = self.proxy.unregister_trial(trial_id)
                except Exception as e:  # noqa: BLE001
                    self.log(f'{trial_id}: unregister failed: {type(e).__name__}')
        t1 = now()
        m1 = self.metrics.sample()
        tdir = trial_dir_of(self.paths.jobs / trial_id)
        result = load_result(tdir)
        host = {**metrics_delta(m0, m1, self.metrics.window(t0, t1)),
                **host_oom_summary(tdir.name if tdir else None, t0, t1, self.docker_watch, self.kernel_watch, victims=self.profile.mem_watch)}
        if self.mem is not None:
            host['mem'] = self.mem.take(trial_id)
        cleaned = self.docker.cleanup([compose_prefix(tdir.name)]) if (self.docker and tdir) else None
        killed = proc.killed if proc else 'launch-error'
        ver, lk = None, None
        if self.profile.verifier_net_rule:   # TB: rule (b) evidence, with lookupscan's net_config_touched
            lk = self.scan_lookup(trial_id, tdir, tdir_task)
            ver = {**verifier_evidence(tdir), 'net_config_touched': (lk or {}).get('net_config_touched')}
        agent = self.profile.agent if self.profile.agent != 'codex' else None
        cc = cc_result(tdir) if agent == 'claude-code' else None
        c = clf.classify(result, summary, killed=killed, patch_bytes=patch_bytes(tdir), host=host, rc=proc.rc if proc else None,
                         verifier=ver, **({'agent': agent, 'cc': cc, 'm_arm': pinned_model(self.plan, it['arm'])} if agent else {}))
        self.emit({'ev': 'end', 'trial_id': trial_id, 'key': key, 'rc': proc.rc if proc else None, 'killed': killed,
                   'trial_dir': self._rel(tdir), 'trial_name': tdir.name if tdir else None, 'classification': c,
                   'proxy': summary, 'host': host, 'cleanup': cleaned, 'wall_s': round(t1 - t0, 1),
                   'agent_s': timing_s(result, 'agent_execution'), 'verifier_s': timing_s(result, 'verifier'),
                   'patch_bytes': patch_bytes(tdir), **({'verifier': ver, 'lookup': lk} if ver is not None else {}),
                   **({'cc': cc} if cc is not None else {})})
        self.after_end(key, c)

    def scan_lookup(self, trial_id: str, tdir: pathlib.Path | None, task: pathlib.Path) -> dict[str, Any] | None:
        """4f's lookupscan over the trial's rollout (TB §7.7; never sees rewards): the text-free record goes into the
        end event and attempts/<id>/lookup.json, the hits (short windows, may carry task text) into
        attempts/<id>/lookup-hits.jsonl, which only the full export ships (through leakscan). None without the
        scanner; {'error': …} if it failed (then rule (b) does not apply)."""
        if not self.profile.lookupscan or self.lookup is None or tdir is None:
            return None
        try:
            rec, hits = self.lookup(tdir, task)
        except Exception as e:  # noqa: BLE001 - a scanner failure never fails the trial
            self.log(f'{trial_id}: lookupscan failed: {type(e).__name__}')
            return {'error': type(e).__name__}
        adir = self.paths.attempts / trial_id
        write_json(adir / 'lookup.json', rec)
        with open(adir / 'lookup-hits.jsonl', 'w', encoding='utf-8') as f:
            f.writelines(json.dumps(h, ensure_ascii=False, default=str) + '\n' for h in hits)
        return rec

    def run_reverify(self, key: str) -> None:
        ks = self.state[key]
        last = ks.attempts[-1]
        k = len(last.reverifies) + 1
        job_name = f'{last.trial_id}-rv{k}-{uuid.uuid4().hex[:6]}'   # unique: an orphaned regrade may have left a job dir
        src = self.paths.jobs / last.trial_id
        t0 = now()
        proc = None
        try:
            argv = self.harbor.regrade_argv(src, task_dir(self.paths, ks.item['task']), self.paths.jobs, job_name)
            proc = self.harbor.start(argv, self.paths.attempts / last.trial_id / f'regrade-{k}.log', self.paths.attempts / last.trial_id)
            append_jsonl(self.paths.events, {'ev': 'reverify-start', 'trial_id': last.trial_id, 'key': key, 'k': k, 'job_name': job_name,
                                             'pid': proc.popen.pid if proc.popen else None, 'at': round(t0, 3)})
            self.harbor.wait(proc, t0 + 2 * 3600, self.stop_now, self.grace_s, self.poll_s)
        except Exception as e:  # noqa: BLE001
            self.log(f'{key} regrade {k}: {type(e).__name__}: {e}')
        rdir = trial_dir_of(self.paths.jobs / job_name)
        if self.docker and rdir:
            self.docker.cleanup([compose_prefix(rdir.name)])
        if proc and proc.killed:
            c = clf._out('cancelled' if proc.killed == 'operator' else 'verifier_infra', 'reverify', f're-verify killed: {proc.killed}', None, None)
            if proc.killed == 'operator':
                # an operator stop does not use up a re-verify: drop the record so it runs again on resume
                with self.lock:
                    ks.reverify_running = False
                return
        else:
            c = clf.classify_reverify(load_result(rdir), last.outcome or {}, rc=proc.rc if proc else None)
        self.emit({'ev': 'reverify-end', 'trial_id': last.trial_id, 'key': key, 'k': k, 'job_name': job_name, 'trial_dir': self._rel(rdir),
                   'rc': proc.rc if proc else None, 'classification': c, 'wall_s': round(now() - t0, 1)})
        self.after_end(key, c)

    def after_end(self, key: str, c: dict[str, Any]) -> None:
        it = self.state[key].item
        if c['class'] == 'harness':
            self.consecutive_harness += 1
            if self.consecutive_harness >= self.max_cons:
                self.halt = self.halt or f'{self.consecutive_harness} harness errors in a row (last: {c["reason"]})'
        elif c['class'] != 'cancelled':
            self.consecutive_harness = 0
        if c['class'] not in ('agent',):
            self.recent_errors.append(f"{it['task']}/{it['arm']}: {c['class']} {c['reason']}"[:200])
        act, fin = self.state[key].next_action()
        if fin:
            self.emit(fin)
        self.log(f"{key}: {c['class']}/{c['action']} {c['reason']}" + (f" → final {fin['status']}" if fin else f' → {act}'))

    # ------------------------------------------------------------ main loop
    def start_work(self, kind: str, key: str) -> None:
        ks = self.state[key]
        it = ks.item
        self.admitted_blocks.add((it['pass'], it['block']))
        tid = uuid.uuid4().hex if kind == 'trial' else ks.attempts[-1].trial_id
        admit = self.admission(it) if self.profile.cpu_budget is not None else None
        if admit:   # 0d: the declared cpus and memory in flight at each admission (TB)
            self.log(f"admit {key}: cpus {admit['cpus']:g} + in flight {admit['in_flight_cpus']:g}/{self.profile.cpu_budget:g}, "
                     f"mem {admit['mem_gb']:g} + {admit['in_flight_mem_gb']:g}/{self.profile.mem_budget_gb:g} GB, {admit['in_flight_trials']} running")
        if kind == 'reverify':
            ks.reverify_running = True
        else:   # logged here, in dispatch order, so the log shows the launch order and a crash leaves an orphan record
            self.emit({'ev': 'start', 'trial_id': tid, 'key': key, 'attempt': len(ks.attempts) + 1,
                       'rerun_of': ks.attempts[-1].trial_id if ks.attempts else None, 'pid': None,
                       'runner': self.env.index, 'shard': self.plan['tasks'][it['task']]['shard'], 'plan_sha256': self.plan_sha256,
                       **{x: it[x] for x in ('pass', 'phase', 'block', 'task', 'arm', 'rep')},
                       'job_dir': self._rel(self.paths.jobs / tid), **({'admission': admit} if admit else {})})
        th = threading.Thread(target=self._guard, args=(kind, key, tid), name=f'{kind}-{tid[:8]}', daemon=True)
        self.running[tid if kind == 'trial' else f'{tid}-rv'] = Running(kind, key, tid, now(), th, self.state[key].item)
        th.start()

    def _guard(self, kind: str, key: str, tid: str) -> None:
        try:
            if kind == 'trial':
                self.run_trial(key, tid)
            else:
                self.run_reverify(key)
        except Exception as e:  # noqa: BLE001 - never lose a slot silently
            self.log(f'{kind} {key}: driver error {type(e).__name__}: {e}')
            self.halt = self.halt or f'driver error in {kind} {key}: {type(e).__name__}'

    def reap(self) -> None:
        for rid, r in list(self.running.items()):
            if not r.thread.is_alive():
                del self.running[rid]

    def run(self) -> dict[str, Any]:
        self.paths.mkdirs()
        n_orphans = self.recover_orphans()
        self.settle_finals()
        if self.docker:
            self.docker.prune_networks()
        if self.preflight:   # TB: llmar-online and the pinned images, checked after the prune (4f's invariant)
            self.preflight()
        if self.mem is not None:
            self.mem.start()
        self.emit({'ev': 'run-start', 'plan_sha256': self.plan_sha256, 'passes': self.passes, 'concurrency': self.concurrency, 'soft_cap': self.soft_cap,
                   'max_blocks': self.max_blocks, 'pid': os.getpid(), 'orphans': n_orphans, 'dropped': sorted(self.dropped),
                   'runner': self.env.index})
        self.log(f'runner {self.env.index}: passes {self.passes}, {len(self.items)} trials in {len(self.blocks)} blocks, '
                 f'{len(self.dropped)} tasks dropped by checks, {n_orphans} orphans recovered')
        while True:
            self.reap()
            self.refresh_stops()
            while len(self.running) < self.concurrency:
                w = self.next_work()
                if w is None:
                    break
                self.start_work(*w)
            if not self.running:
                break
            self.tick()
            time.sleep(self.poll_s)
        if self.mem is not None:
            self.mem.stop()
        self.write_status(final=True)
        out = {'ev': 'run-end', 'state': self.state_name(), 'reason': self.halt or self.no_new_blocks, 'progress': self.progress()}
        self.emit(dict(out))
        return out

    def tick(self) -> None:
        t = now()
        if t - self.t_metrics >= METRICS_EVERY_S:
            self.t_metrics = t
            self.metrics.sample()
        if t - self.t_status >= STATUS_EVERY_S:
            self.t_status = t
            self.write_status()

    # ------------------------------------------------------------ status
    def state_name(self) -> str:
        if self.running:
            return 'draining' if (self.halt or self.no_new_blocks or self.stop_now.is_set()) else 'running'
        if all(ks.final for k, ks in self.state.items() if k in {key for b in self.blocks for key in self.block_keys[b]}):
            return 'done'
        if self.halt:
            return 'halted'
        return 'paused' if self.no_new_blocks else 'stopped'

    def progress(self) -> dict[str, Any]:
        return progress(self.state, self.items, self.blocks, self.block_keys)

    def write_status(self, final: bool = False) -> None:
        sp = self.spend()
        doc = {
            'schema': 'deepswe-harbor-status/v1', 'updated': iso(), 'runner': self.env.index, 'shard': self.shard,
            'state': self.state_name(), 'reason': self.halt or self.no_new_blocks, 'passes': self.passes,
            'concurrency': self.concurrency, 'soft_cap_usd': self.soft_cap,
            'spend': {k: sp.get(k) for k in ('cap_usd', 'settled_usd', 'committed_usd', 'inflight', 'inflight_worst_usd', 'calls', 'stopped', 'crash_charged_usd') if k in sp},
            'token': {k: sp.get(k) for k in ('token_mints', 'token_remints', 'token_max_age_s') if k in sp},
            'progress': blind_progress(self.progress()) if self.profile.blind else self.progress(),
            'in_flight': [{'kind': r.kind, 'task': r.item['task'], 'arm': r.item['arm'], 'pass': r.item['pass'],
                           'trial_id': r.trial_id, 'elapsed_min': round((now() - r.started) / 60, 1)} for r in self.running.values()],
            'recent_errors': list(self.recent_errors), 'consecutive_harness': self.consecutive_harness,
            'dropped_tasks': sorted(self.dropped), 'host': host_now(self.metrics),
        }
        if self.profile.cpu_budget is not None:
            uc, um = self.in_use()
            doc.update({'dataset': self.profile.name, 'budget': {'cpus': uc, 'cpu_budget': self.profile.cpu_budget,
                                                                 'mem_gb': round(um, 1), 'mem_budget_gb': self.profile.mem_budget_gb}})
        write_json(self.paths.status, doc)


def blind_progress(p: dict[str, Any]) -> dict[str, Any]:
    """Outcome-blind status (Claude Code: pilot and interim, 0d §4): no solved counts."""
    return {**p, 'passes': {k: {f: v for f, v in d.items() if f != 'solved'} for k, d in p.get('passes', {}).items()}}


def progress(state: dict[str, KeyState], items: list[dict[str, Any]], blocks: list[tuple[str, int]],
             block_keys: dict[tuple[str, int], list[str]]) -> dict[str, Any]:
    """Counts for status: per pass blocks (total/admitted/done), trials final by status, ended attempts by class,
    reruns, spend and 429s summed over the ended attempts' proxy summaries."""
    per: dict[str, dict[str, Any]] = {}
    for p in dict.fromkeys(it['pass'] for it in items):
        bs = [b for b in blocks if b[0] == p]
        keys = [k for b in bs for k in block_keys[b]]
        per[p] = {'blocks': len(bs), 'admitted': sum(1 for b in bs if any(state[k].attempts for k in block_keys[b])),
                  'blocks_done': sum(1 for b in bs if all(state[k].final for k in block_keys[b])),
                  'trials': len(keys), 'scored': sum(1 for k in keys if (state[k].final or {}).get('status') == 'scored'),
                  'excluded': sum(1 for k in keys if (state[k].final or {}).get('status') == 'excluded'),
                  'solved': sum(1 for k in keys if (state[k].final or {}).get('score') == 1.0)}
    classes: collections.Counter[str] = collections.Counter()
    throttled = spent = 0.0
    statuses: collections.Counter[str] = collections.Counter()
    attempts = reruns = 0
    for ks in state.values():
        for a in ks.attempts:
            attempts += 1
            reruns += int(a.n > 1)
            if a.end:
                classes[(a.outcome or {}).get('class') or '?'] += 1
                px = a.end.get('proxy') or {}
                throttled += float(px.get('throttled') or 0)
                spent += float(px.get('spent_usd') or 0)
                statuses.update({str(k): int(v) for k, v in (px.get('statuses') or {}).items()})
    return {'passes': per, 'attempts': attempts, 'reruns': reruns, 'classes': dict(classes), 'throttled_429': int(throttled),
            'statuses': dict(statuses), 'ended_spend_usd': round(spent, 2)}


def host_now(metrics: Metrics) -> dict[str, Any]:
    with metrics._lock:   # noqa: SLF001
        ss = list(metrics.samples)[-2:]
    if not ss:
        return {}
    m = ss[-1]
    out = {'load': m.get('load'), 'mem_available_gb': round((m.get('mem_available_kb') or 0) / 1e6, 1),
           'docker_free_gb': round((m.get('docker_free_bytes') or 0) / 1e9, 1), 'oom_kill': m.get('oom_kill')}
    if len(ss) == 2:
        out.update({k: v for k, v in metrics_delta(ss[0], ss[1]).items() if k.startswith(('cpu_', 'psi_', 'pswp'))})
    return out


# ---------------------------------------------------------------- checks (oracle / null), no model calls

def check_job_config(kind: str, tdir: pathlib.Path, jobs_dir: pathlib.Path, job_name: str, environment: dict[str, Any]) -> dict[str, Any]:
    return {'job_name': job_name, 'jobs_dir': str(jobs_dir), 'n_attempts': 1, 'n_concurrent_trials': 1, 'quiet': True,
            'retry': {'max_retries': 0}, 'environment': environment, 'verifier': {},
            'agents': [{'name': 'oracle' if kind == 'oracle' else 'nop'}], 'tasks': [{'path': str(tdir)}]}


def summarize_checks(events: list[dict[str, Any]], tasks: list[str], kinds: tuple[str, ...], reps: int) -> dict[str, Any]:
    """Per task and kind: the verdicts of its completed reps. A task is dropped if any oracle rep failed (the
    reference solution does not pass) or any null rep passed (the unmodified base passes); `ok` is True when every
    kind has `reps` good verdicts, None while some are missing or only infra errors."""
    by: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for e in events:
        if e.get('ev') == 'check-end':
            by[(e['task'], e['kind'])].append(e)
    out: dict[str, Any] = {}
    for t in tasks:
        rec: dict[str, Any] = {}
        drop, ok = False, True
        reasons = []
        for k in kinds:
            vs = [e['verdict'] for e in by.get((t, k), [])]
            good = [v for v in vs if v['ok'] is True]
            bad = [v for v in vs if v['ok'] is False]
            rec[k] = {'ok': len(good), 'failed': len(bad), 'infra': sum(1 for v in vs if v['ok'] is None),
                      'rewards': [v['reward'] for v in vs if v['ok'] is not None]}
            if bad:
                drop = True
                reasons.append(bad[0]['reason'])
            if len(good) < reps:
                ok = False
        rec.update({'drop': drop, 'ok': (False if drop else (True if ok else None)), 'reason': '; '.join(reasons) or None})
        out[t] = rec
    return {'kinds': list(kinds), 'reps': reps, 'tasks': out, 'dropped': sorted(t for t, r in out.items() if r['drop']),
            'unresolved': sorted(t for t, r in out.items() if r['ok'] is None)}


CHECK_SLOTS = 2                 # TB §7.5: two counted attempts per (task, kind)
CHECK_INFRA_PER_SLOT = 2        # TB §7.5: infra retries per slot; the next infra fills the slot as `exhausted`


def slot_walk(verdicts: list[dict[str, Any]], n_slots: int = CHECK_SLOTS) -> tuple[list[str], int]:
    """TB §7.5 (0d): a (task, kind)'s check verdicts in log order → (filled slots, infra count of the open slot). A
    pass/fail verdict fills the current slot ('good' = the expected reward, 'bad' = the other one); an infra verdict
    retries it; the 3rd consecutive infra in a slot fills it as 'exhausted'. At most CHECK_SLOTS slots, so at most
    CHECK_SLOTS × (1 + CHECK_INFRA_PER_SLOT) attempts per (task, kind)."""
    slots: list[str] = []
    infra = 0
    for v in verdicts:
        if len(slots) >= n_slots:
            break
        if v['ok'] is None:
            infra += 1
            if infra > CHECK_INFRA_PER_SLOT:
                slots.append('exhausted')
                infra = 0
        else:
            slots.append('good' if v['ok'] else 'bad')
            infra = 0
    return slots, infra


def summarize_checks_slots(events: list[dict[str, Any]], tasks: list[str], kinds: tuple[str, ...], n_slots: int = CHECK_SLOTS) -> dict[str, Any]:
    """TB §7.5 (0d) per task:
    - oracle: an `exhausted` slot is a counted failure; both slots failed → drop; 1 of 2 → kept, flaky_env;
    - nop: a pass in any slot → drop; an `exhausted` slot is UNVERIFIED; both unverified → drop (no evidence the
      tests reject an unmodified task); one clean fail + one unverified → kept, flaky_env;
    - a task flagged by either kind is flaky_env once, with every reason.
    `ok` is None only while a kind has fewer than CHECK_SLOTS filled slots (an interrupted check run; the run gate
    refuses it)."""
    by: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for e in events:
        if e.get('ev') == 'check-end':
            by[(e['task'], e['kind'])].append(e)
    out: dict[str, Any] = {}
    for t in tasks:
        rec: dict[str, Any] = {}
        drop, complete = False, True
        reasons: list[str] = []
        flaky: list[str] = []
        for k in kinds:
            vs = [e['verdict'] for e in by.get((t, k), [])]
            slots, open_infra = slot_walk(vs, n_slots)
            rec[k] = {'slots': slots, 'attempts': len(vs), 'infra': sum(1 for v in vs if v['ok'] is None), 'open_infra': open_infra,
                      'rewards': [v['reward'] for v in vs if v['ok'] is not None]}
            if k == 'nop' and 'bad' in slots:
                drop = True
                reasons.append('unmodified base passes')
                continue
            if len(slots) < n_slots:
                complete = False
                continue
            if k == 'oracle':
                failed = sum(1 for x in slots if x != 'good')
                if failed == n_slots:
                    drop = True
                    reasons.append('reference solution fails both attempts' + (' (verifier unreachable)' if 'exhausted' in slots else ''))
                elif failed:
                    flaky.append('oracle passed 1 of 2' + (' (one attempt infra-exhausted)' if 'exhausted' in slots else ''))
            else:
                unverified = slots.count('exhausted')
                if unverified == n_slots:
                    drop = True
                    reasons.append('null check unverified twice (verifier unreachable)')
                elif unverified:
                    flaky.append('null check unverified once')
        rec.update({'drop': drop, 'ok': False if drop else (True if complete else None), 'reason': '; '.join(reasons) or None,
                    'flaky_env': bool(flaky) and not drop, 'flaky_reasons': flaky if not drop else []})
        out[t] = rec
    return {'kinds': list(kinds), 'slots': n_slots, 'tasks': out, 'dropped': sorted(t for t, r in out.items() if r['drop']),
            'unresolved': sorted(t for t, r in out.items() if r['ok'] is None),
            'flaky_env': sorted(t for t, r in out.items() if r['flaky_env'])}


def run_checks(*, plan: dict[str, Any], env: RunnerEnv, paths: Paths, harbor: Harbor, environment: dict[str, Any], kinds: tuple[str, ...],
               reps: int, concurrency: int, docker: Docker | None, log: Log, max_infra: int = 2, poll_s: float = 1.0,
               timeout_s: float = 2 * 3600, tasks: list[str] | None = None, profile: profiles.Dataset = profiles.DEEPSWE,
               n_slots: int = CHECK_SLOTS) -> dict[str, Any]:
    """Oracle and null checks of the shard's tasks. DeepSWE: `reps` verdicts per kind, infra retried while ≤
    max_infra (summarize_checks). TB (profile.check_slots): §7.5's two counted slots per kind (slot_walk,
    summarize_checks_slots), the per-task watchdog, the resource budget, and classify rule (b) for verifiers whose
    test runner never started."""
    paths.mkdirs()
    tasks = tasks or sorted(shardplan.shard_tasks(plan)[env.index])
    events = read_jsonl(paths.check_events)
    stop = threading.Event()
    slots_mode = profile.check_slots

    def todo_slots(busy: set[tuple[str, str]]) -> list[tuple[str, str]]:
        """One attempt at a time per (task, kind), so the log order is the attempt order and the slot outcome does
        not depend on which of two concurrent attempts ended first."""
        with lock:
            summ = summarize_checks_slots(events, tasks, kinds, n_slots)['tasks']
        out = []
        for t in tasks:
            if summ[t]['drop']:
                continue   # already decided (e.g. the base passes): no more attempts
            for k in kinds:
                if (t, k) not in busy and len(summ[t][k]['slots']) < n_slots:
                    out.append((t, k))
        return out

    def todo() -> list[tuple[str, str]]:
        cnt: collections.Counter[tuple[str, str]] = collections.Counter()
        infra: collections.Counter[tuple[str, str]] = collections.Counter()
        for e in events:
            if e.get('ev') == 'check-end':
                (cnt if e['verdict']['ok'] is not None else infra)[(e['task'], e['kind'])] += 1
        out = []
        for t in tasks:
            for k in kinds:
                need = reps - cnt[(t, k)]
                if need > 0 and infra[(t, k)] <= max_infra:
                    out += [(t, k)] * need
        return out

    def one(t: str, k: str, admit: dict[str, Any] | None = None) -> None:
        cid = f'chk-{k}-{uuid.uuid4().hex[:12]}'
        adir = paths.checks / cid
        cfg = check_job_config(k, task_dir(paths, t), paths.jobs, cid, environment)
        write_json(adir / 'job.json', cfg)
        t0 = now()
        proc = harbor.start(harbor.run_argv(adir / 'job.json'), adir / 'harbor.log', adir)
        deadline = timeout_s if profile.wall_timeout_h is not None else task_watchdog_s(plan['tasks'][t])
        harbor.wait(proc, t0 + deadline, stop, 60, poll_s)
        tdir = trial_dir_of(paths.jobs / cid)
        if docker and tdir:
            docker.cleanup([compose_prefix(tdir.name)])
        ver = verifier_evidence(tdir) if profile.verifier_net_rule else None
        v = clf.check_verdict(k, load_result(tdir), killed=proc.killed, rc=proc.rc, verifier=ver)
        e = {'ev': 'check-end', 'task': t, 'kind': k, 'check_id': cid, 'verdict': v, 'wall_s': round(now() - t0, 1),
             'trial_dir': str(tdir.relative_to(paths.results)) if tdir else None, 'at': round(now(), 3),
             **({'verifier': ver} if ver is not None else {}), **({'admission': admit} if admit else {})}
        with lock:
            append_jsonl(paths.check_events, e)
            events.append(e)
        log(f"check {k} {t}: {'ok' if v['ok'] else ('FAIL' if v['ok'] is False else 'infra')} {v['reason']}")

    lock = threading.Lock()

    def weight(t: str) -> tuple[float, float]:
        m = plan['tasks'].get(t) or {}
        return float(m.get('cpus') or 0.0), float(m.get('memory_mb') or 0.0) / 1024

    def fits(running: list[tuple[threading.Thread, str]], t: str) -> bool:
        live = [x for th, x in running if th.is_alive()]
        if len(live) >= concurrency:
            return False
        if not live or (profile.cpu_budget is None and profile.mem_budget_gb is None):
            return True
        c, m = weight(t)
        uc, um = sum(weight(x)[0] for x in live), sum(weight(x)[1] for x in live)
        return (profile.cpu_budget is None or uc + c <= profile.cpu_budget + 1e-9) and (profile.mem_budget_gb is None or um + m <= profile.mem_budget_gb + 1e-9)

    if slots_mode:   # a continuous scheduler: each (task, kind) is a sequential chain of attempts
        running: list[tuple[threading.Thread, str, str]] = []
        while True:
            running = [x for x in running if x[0].is_alive()]
            busy = {(t, k) for _, t, k in running}
            work = todo_slots(busy)
            if not work and not running:
                break
            started = False
            for t, k in work:
                if not fits([(th, x) for th, x, _ in running], t):
                    break   # head-of-line, as in the live scheduler
                live = [x for th, x, _ in running if th.is_alive()]
                c, m = weight(t)
                admit = {'cpus': c, 'mem_gb': round(m, 3), 'in_flight_cpus': sum(weight(x)[0] for x in live),
                         'in_flight_mem_gb': round(sum(weight(x)[1] for x in live), 3), 'in_flight_trials': len(live)}
                log(f"admit check {k} {t}: cpus {c:g} + in flight {admit['in_flight_cpus']:g}/{profile.cpu_budget}, "
                    f"mem {admit['mem_gb']:g} + {admit['in_flight_mem_gb']:g}/{profile.mem_budget_gb} GB, {len(live)} running")
                th = threading.Thread(target=one, args=(t, k, admit), daemon=True)
                th.start()
                running.append((th, t, k))
                started = True
            if not started:
                time.sleep(poll_s)
        if docker:
            docker.prune_networks()
    while not slots_mode:
        work = todo()
        if not work:
            break
        threads: list[tuple[threading.Thread, str]] = []
        for t, k in work:
            while not fits(threads, t):
                time.sleep(poll_s)
            th = threading.Thread(target=one, args=(t, k), daemon=True)
            th.start()
            threads.append((th, t))
        for th, _ in threads:
            th.join()
        if docker:
            docker.prune_networks()
    if slots_mode:
        summ = summarize_checks_slots(events, tasks, kinds, n_slots)
        summ.update({'runner': env.index, 'updated': iso(), 'dataset': profile.name})
        write_json(paths.check_summary, summ)
        return summ
    summ = summarize_checks(events, tasks, kinds, reps)
    summ.update({'runner': env.index, 'updated': iso()})
    write_json(paths.check_summary, summ)
    return summ


# ---------------------------------------------------------------- export (fetch support)

EXPORT_FILES = ('attempts.jsonl', 'checks.jsonl', 'checks/summary.json', 'run-config.json', 'status.json', 'prepull.json', 'tasks.json',
                'driver.log', 'host-metrics.jsonl', 'docker-events.jsonl', 'kernel-oom.jsonl',
                'proxy/calls.jsonl', 'proxy/alerts.jsonl', 'proxy/proxy-state.json', 'proxy/cap-events.jsonl')
EXPORT_DIRS = ('jobs', 'attempts', 'checks', 'isolation')   # Harbor job dirs, per-attempt configs and logs, 18's isolation reports
# Matched against the file's own name only (export_never). A directory component never matches: Harbor's trial dirs
# carry the task name (TB: count-dataset-tokens, vulnerable-secret), and the old whole-path search dropped those
# trials from every export without a trace (0c, 2026-11-07). Content is still scanned (scan_secret, leakscan).
EXPORT_NEVER = re.compile(r'(^|/)(\.env|[^/]*token[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*)$', re.I)   # 4f's form


def export_never(rel: str) -> bool:
    """True if the file's name (the last path component) says it may hold a credential: .env, or a name with token,
    secret or credential in it."""
    return bool(EXPORT_NEVER.search(rel))
# Claude Code (4f): of agent/sessions/ only projects/**/*.jsonl (main and subagent transcripts) and agent/claude-code.txt
# ship; .claude.json holds a random user id, and statsig/, todos/, shell-snapshots/, debug/ are client state.
_CC_SESSIONS = re.compile(r'(^|/)agent/sessions/')
_CC_SESSIONS_KEEP = re.compile(r'(^|/)agent/sessions/projects/.+\.jsonl$')


def cc_export_ok(rel: str) -> bool:
    return not _CC_SESSIONS.search(rel) or bool(_CC_SESSIONS_KEEP.search(rel))


def _classify_jwt() -> Callable[[bytes], str | None] | None:
    """leakscan.classify_jwt (18/4f), or None if leakscan cannot be imported (then every JWT-shaped value blocks)."""
    try:
        import leakscan
    except ImportError:
        return None
    return leakscan.classify_jwt


def scan_secret(path: pathlib.Path, limit: int = 64 << 20) -> bool:
    """The driver's own backstop: True if the file holds a token-shaped string (JWT, bearer header, client
    secret). Files over `limit` are scanned in their first `limit` bytes. A JWT-shaped value whose payload leakscan
    classifies as 'encrypted-reasoning' (Bedrock reasoning `encrypted_content`: payload keys exactly {ciphertext,
    protected}) is not a credential and does not block; without leakscan every JWT-shaped value blocks."""
    with open(path, 'rb') as f:
        data = f.read(limit)
    if _SECRET_RES[1].search(data) or _SECRET_RES[2].search(data):
        return True
    classify = None
    for m in _SECRET_RES[0].finditer(data):
        if classify is None:
            classify = _classify_jwt() or (lambda _p: 'unknown')
        if classify(m.group(0).split(b'.')[1]) != 'encrypted-reasoning':
            return True
    return False


def make_scanner(account_from_imds: bool, log: Callable[[str], None] = print, fixtures: list[pathlib.Path] | None = None) -> Any:
    """18's leakscan.Scanner for one export (fingerprints group within its manifest). On the runner it also
    matches the instance's own account id exactly (IMDS); off the runner that lookup is skipped. `fixtures` (TB: the
    shard's task dirs): findings whose value occurs in the public task files are counted, not reported (4f/18's
    fixture allowance; exact values are always reported). A leakscan without the allowance is used without it,
    which only blocks more."""
    try:
        import leakscan
    except ImportError:
        return None
    exact: list[str] = []
    if account_from_imds:
        try:
            exact.append(leakscan.imds_account_id())
        except Exception as e:  # noqa: BLE001 - no IMDS: the account-shaped patterns still apply
            log(f'leakscan: no account id from IMDS ({type(e).__name__})')
    if fixtures:
        try:
            return leakscan.Scanner(exact, fixtures=[pathlib.Path(p) for p in fixtures])
        except TypeError:
            log('leakscan: no fixture allowance in this version; scanning without it')
    return leakscan.Scanner(exact)


def leak_findings(path: pathlib.Path, scanner: Any) -> list[dict[str, Any]] | None:
    """leakscan's high-confidence findings in a file (kinds, positions and fingerprints, never the value), or None
    without a scanner. A file it cannot scan counts as a finding."""
    if scanner is None:
        return None
    import leakscan
    try:
        found = leakscan.scan_file(path, scanner)
    except (ValueError, OSError) as e:
        return [{'kind': 'unscannable', 'reason': type(e).__name__}]
    return [{k: v for k, v in dataclasses.asdict(f).items() if k != 'path'} for f in found]


def export_candidates(results: pathlib.Path, agent: str = 'codex', excluded: dict[str, list[str]] | None = None) -> list[pathlib.Path]:
    """The allowlist (0d): named files plus regular files under the Harbor job dirs, the per-attempt dirs and the
    check dirs. Never symlinks, nothing outside results/, no file named like a token or secret (export_never), and
    for Claude Code only the transcripts of agent/sessions/ (cc_export_ok). `excluded`, when given, receives the
    relative path of every candidate left out, under 'name' (export_never) or 'cc_client_state' (cc_export_ok)."""
    out: list[pathlib.Path] = []
    for rel in EXPORT_FILES:
        p = results / rel
        if p.is_file() and not p.is_symlink():
            out.append(p)
    for d in EXPORT_DIRS:
        base = results / d
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            dirnames[:] = sorted(x for x in dirnames if not (pathlib.Path(dirpath) / x).is_symlink())
            for fn in sorted(filenames):
                p = pathlib.Path(dirpath) / fn
                if p.is_file() and not p.is_symlink():
                    out.append(p)
    keep = []
    for p in dict.fromkeys(out):
        rel = str(p.relative_to(results))
        rule = 'name' if export_never(rel) else ('cc_client_state' if agent == 'claude-code' and not cc_export_ok(rel) else None)
        if rule:
            if excluded is not None:
                excluded.setdefault(rule, []).append(rel)
            continue
        keep.append(p)
    return keep


def file_sha256(p: pathlib.Path) -> str:
    return shardplan.sha256_file(p)


def build_export(paths: Paths, *, mode: str, runner: int, base: dict[str, Any] | None = None, max_file: int = LIGHT_MAX_FILE,
                 export_id: str | None = None, scanner: Any = None, dataset: str | None = None, agent: str = 'codex') -> dict[str, Any]:
    """A gzip tarball of the allowlisted results files that changed since `base` (a previous manifest), with a
    sha256 manifest. Light mode leaves out files over `max_file` bytes (listed with size and hash), except result,
    reward and config JSON. A file with token- or account-shaped content (18's leakscan with `scanner`, plus the
    driver's own patterns) is never included: it is listed under `blocked`, with leakscan's findings (kinds,
    positions and fingerprints only) under `findings`."""
    if mode not in ('light', 'full'):
        raise ValueError(mode)
    eid = export_id or f'{int(now())}-{uuid.uuid4().hex[:6]}'
    if not re.fullmatch(r'[0-9]+-[0-9a-f]{6}', eid):
        raise ValueError('export id')
    prev = (base or {}).get('files', {})
    files: dict[str, list[Any]] = {}
    skipped: dict[str, list[Any]] = {}
    blocked: list[str] = []
    findings: dict[str, list[dict[str, Any]]] = {}
    unchanged = 0
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for p in export_candidates(paths.results, agent):
            rel = str(p.relative_to(paths.results))
            size = p.stat().st_size
            digest = file_sha256(p)
            if prev.get(rel) == [size, digest] or (base or {}).get('skipped', {}).get(rel) == [size, digest]:
                unchanged += 1
                continue
            if mode == 'light' and ((size > max_file and p.name not in LIGHT_ALWAYS) or p.name in FULL_ONLY):
                skipped[rel] = [size, digest]
                continue
            lf = leak_findings(p, scanner)
            if lf or scan_secret(p):
                blocked.append(rel)
                if lf:
                    findings[rel] = lf
                continue
            ti = tarfile.TarInfo(f'results/{rel}')
            ti.size, ti.mode, ti.mtime = size, 0o600, int(p.stat().st_mtime)
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ''
            with open(p, 'rb') as f:
                tar.addfile(ti, f)
            files[rel] = [size, digest]
    raw = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=6) as gz:
        gz.write(buf.getvalue())
    blob = raw.getvalue()
    edir = paths.exports / eid
    edir.mkdir(parents=True, exist_ok=False, mode=0o700)
    (edir / 'payload.tar.gz').write_bytes(blob)
    full_files = {**{k: v for k, v in prev.items()}, **files}
    manifest = {'schema': 'deepswe-harbor-export/v1', 'export_id': eid, 'runner': runner, 'mode': mode, 'created': iso(),
                'base': (base or {}).get('export_id'), 'files': files, 'all_files': full_files, 'skipped': skipped,
                'blocked': blocked, 'findings': findings, 'scanner': 'leakscan' if scanner is not None else 'driver patterns only',
                'unchanged': unchanged, 'tar_sha256': sha256_bytes(blob), 'tar_bytes': len(blob),
                **({'dataset': dataset} if dataset and dataset != 'deepswe' else {})}
    b64 = __import__('base64').b64encode(blob).decode()
    parts = [b64[i:i + PART_CHARS] for i in range(0, len(b64), PART_CHARS)] or ['']
    (edir / 'parts').mkdir(mode=0o700)
    for i, part in enumerate(parts):
        (edir / 'parts' / f'p{i:05d}').write_text(part)
    manifest['parts'] = len(parts)
    write_json(edir / 'manifest.json', manifest)
    return manifest


def latest_manifest(paths: Paths, export_id: str | None) -> dict[str, Any] | None:
    if not export_id:
        return None
    if not re.fullmatch(r'[0-9]+-[0-9a-f]{6}', export_id):
        raise SystemExit('bad --base')
    p = paths.exports / export_id / 'manifest.json'
    if not p.exists():
        return None
    m = read_json(p)
    return {**m, 'files': m.get('all_files', m.get('files', {}))}


# ---------------------------------------------------------------- commands

def _env_and_paths(a: argparse.Namespace) -> tuple[RunnerEnv, Paths]:
    env = RunnerEnv.load(pathlib.Path(a.env_file), {'work_dir': a.work, 'index': a.shard})
    paths = Paths(env.work_dir, a.profile)
    paths.mkdirs()
    if a.profile.online and env.container_egress != 'internet' and a.cmd in ('run', 'check'):
        raise SystemExit(f'--dataset {a.profile.name} needs CONTAINER_EGRESS=internet on this runner (a3\'s switch)')
    return env, paths


def _plan(a: argparse.Namespace, env: RunnerEnv) -> dict[str, Any]:
    """The plan, with its file's sha256 under `_sha256` (recorded in run-config.json and every start event)."""
    path = pathlib.Path(a.plan)
    plan = shardplan.load_plan(path)
    profiles.check_plan(a.profile, plan)
    if plan['n_shards'] != env.count:
        raise SystemExit(f"the plan has {plan['n_shards']} shards but this fleet has {env.count} runners")
    plan['_sha256'] = shardplan.sha256_file(path)
    return plan


@contextlib.contextmanager
def run_lock(paths: Paths):
    paths.results.mkdir(parents=True, exist_ok=True)
    f = open(paths.lock, 'a+')
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        raise SystemExit('another driver is running on this runner (results/driver.lock)') from None
    f.seek(0)
    f.truncate()
    f.write(str(os.getpid()))
    f.flush()
    try:
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def lock_holder(paths: Paths) -> int | None:
    """The pid of a live driver holding the lock, else None."""
    if not paths.lock.exists():
        return None
    with open(paths.lock, 'a+') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            f.seek(0)
            txt = f.read().strip()
            return int(txt) if txt.isdigit() else -1
        fcntl.flock(f, fcntl.LOCK_UN)
    return None


def run_cmd(argv: list[str], timeout: float = 1800) -> subprocess.CompletedProcess:
    """The `run` taskpin (4f) gets for its git and docker calls."""
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)  # nosec B603 - fixed argv lists


def tb_preflight(plan: dict[str, Any], env: RunnerEnv, tasks: list[str], log: Callable[[str], None], images: bool = True) -> None:
    """TB, at the start of `run` and `check` (after prune_networks): infra's `llmar-online` network with the
    contract's options, and every shard image carrying its pinned digest (4f's taskpin). Refuses on any mismatch."""
    if env.container_egress != 'internet' and not images:
        return
    import taskpin
    if env.container_egress == 'internet':
        try:
            net = taskpin.check_online_network(run_cmd, env.online_network or taskpin.ONLINE_NETWORK['name'])
        except taskpin.NetworkMismatch as e:
            raise SystemExit(f'online network: {e}') from None
        log(f"online network {net.get('name')} ok ({net.get('subnet')}, bridge {net.get('bridge')})")
    issues = taskpin.check_images(plan, tasks, run_cmd) if images else []
    if issues:
        raise SystemExit(f'images: {len(issues)} not at the pinned digest (e.g. {issues[:3]}): run `driver.py prepull`')


def cmd_fetch_tasks(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    plan = _plan(a, env)
    if a.profile.taskpin:   # TB: 4f's fetch sequence and the three integrity checks
        import taskpin
        mine = sorted(shardplan.shard_tasks(plan)[env.index])
        head = taskpin.fetch(paths.tasks.parent, a.repo_url or a.profile.repo_url, shardplan.commit_hex(plan), run_cmd)
        issues = taskpin.verify(plan, paths.tasks.parent, mine)
        write_json(paths.tasks_meta, {'commit_b64': plan['dataset']['commit_b64'], 'shard': env.index, 'tasks': mine, 'issues': issues, 'at': iso()})
        print(json.dumps({'commit_b64': plan['dataset']['commit_b64'], 'head_ok': head == shardplan.commit_hex(plan), 'tasks': len(mine),
                          'issues': issues}))
        if issues:
            sys.exit(1)
        return
    a.repo_url = a.repo_url or a.profile.repo_url
    commit = plan['dataset']['commit']
    root = paths.tasks.parent
    if not (root / '.git').is_dir():
        subprocess.run(['git', 'clone', '--quiet', '--no-checkout', a.repo_url, str(root)], check=True, timeout=1800)  # nosec B603 B607
    subprocess.run(['git', '-C', str(root), 'fetch', '--quiet', 'origin', commit], check=True, timeout=1800)  # nosec B603 B607
    subprocess.run(['git', '-C', str(root), 'checkout', '--quiet', '--detach', commit], check=True, timeout=600)  # nosec B603 B607
    head = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()  # nosec B603: argument list, no shell; arguments are the operator's own
    if head != commit:
        raise SystemExit(f'deep-swe HEAD {head} != plan commit {commit}')
    mine = sorted(shardplan.shard_tasks(plan)[env.index])
    issues = check_task_files(plan, paths, mine)
    write_json(paths.tasks_meta, {'commit': head, 'shard': env.index, 'tasks': mine, 'issues': issues, 'at': iso()})
    print(json.dumps({'commit': head, 'tasks': len(mine), 'issues': issues}))
    if issues:
        sys.exit(1)


CC_BUILDS = ('glibc', 'musl')


def claude_libc_gate(images: dict[str, str], builds: dict[str, pathlib.Path], run: Callable[..., subprocess.CompletedProcess] = run_cmd,
                     parallel: int = 4) -> dict[str, str | None]:
    """a3's libc gate (CC runner design; 17/4f): per task image, `claude --version` of the pinned glibc build, then the
    musl build, in a throwaway container with no network and the binary mounted read-only (no task code runs, nothing
    is pulled). {task: 'glibc' | 'musl' | None}; None refuses the task before any spend."""
    import concurrent.futures as cf

    def one(img: str) -> str | None:
        for b in CC_BUILDS:
            target = f'/opt/llmar/claude/{b}'
            r = run(['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', target,
                     '-v', f'{builds[b]}:{target}:ro', img, '--version'], timeout=120)
            if r.returncode == 0:
                return b
        return None
    uniq = sorted(set(images.values()))
    with cf.ThreadPoolExecutor(max_workers=max(1, parallel)) as pool:
        got = dict(zip(uniq, pool.map(one, uniq)))
    return {t: got[img] for t, img in sorted(images.items())}


def claude_gate_issues(prepull: dict[str, Any], tasks: Iterable[str]) -> list[str]:
    """`run` refuses (before the proxy starts) any task the libc gate did not pass: no build recorded, or none ran."""
    got = prepull.get('claude_build') or {}
    return [f'{t}: ' + ('no pinned Claude Code build runs in its image' if t in got else 'not libc-gated (run prepull)')
            for t in sorted(set(tasks)) if got.get(t) not in CC_BUILDS]


def claude_builds() -> dict[str, pathlib.Path]:
    import hcommon
    return {'glibc': hcommon.claude_bin('linux-x64'), 'musl': hcommon.claude_bin('linux-x64-musl')}


def cmd_prepull(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    plan = _plan(a, env)
    d = Docker()
    mine = sorted(shardplan.shard_tasks(plan)[env.index])
    probe: list[str] = []
    try:   # 18's isolation suite needs its probe image on the host (pinned by digest in isolation.py; not in PREPULL_IMAGES)
        import isolation
        probe = [isolation.PROBE_IMAGE]
    except ImportError:
        pass
    pinned: dict[str, str] = {}   # TB: pull repo@digest, then tag it repo:tag (4f's taskpin.image_pull_args)
    if a.profile.taskpin:
        import taskpin
        for t in mine:
            ref, tag = taskpin.image_pull_args(plan['tasks'][t])
            pinned[ref] = tag
        images = list(dict.fromkeys([*env.prepull, *probe, *pinned]))
    else:
        images = list(dict.fromkeys([*env.prepull, *probe, *(task_image(task_dir(paths, t)) for t in mine)]))
    out: dict[str, Any] = {}
    import concurrent.futures as cf

    def pull(img: str) -> tuple[str, bool, str]:
        for _ in range(3):
            ok, msg = d.pull(img)
            if ok and img in pinned:
                ok, msg = d.tag(img, pinned[img])
            if ok:
                return img, True, msg
            time.sleep(10)
        return img, False, msg

    with cf.ThreadPoolExecutor(max_workers=a.parallel) as pool:
        for img, ok, msg in pool.map(pull, images):
            out[img] = {'ok': ok, 'size': d.image_size(img) if ok else None, **({} if ok else {'error': mask(msg)})}
            print(('ok  ' if ok else 'FAIL'), img, flush=True)
    summ = {'images': out, 'n': len(images), 'failed': sorted(i for i, r in out.items() if not r['ok']),
            'bytes': sum(r['size'] or 0 for r in out.values()), 'docker_free_gb': round(free_gb([pathlib.Path('/var/lib/docker')]), 1), 'at': iso()}
    if a.profile.record_digests:   # Claude Code DeepSWE: tags are mutable; record what was pulled, report drift (0d §10)
        prev = (read_json(paths.prepull) if paths.prepull.exists() else {}).get('digests') or {}
        summ['digests'] = {img: d.repo_digests(img) for img in images if out.get(img, {}).get('ok')}
        summ['digest_changes'] = sorted(i for i, v in summ['digests'].items() if i in prev and prev[i] != v)
    if a.profile.taskpin and not summ['failed']:
        import taskpin
        summ['digest_issues'] = taskpin.check_images(plan, mine, run_cmd)
        summ['failed'] = sorted(summ['digest_issues'])
    if a.profile.agent == 'claude-code' and not summ['failed']:   # a3's libc gate: which pinned build runs in each task image
        task_imgs = {t: (pinned[taskpin.image_pull_args(plan['tasks'][t])[0]] if a.profile.taskpin else task_image(task_dir(paths, t))) for t in mine}
        builds = claude_builds()
        missing = [str(b) for b in builds.values() if not b.is_file()]
        if missing:
            summ['failed'] = [f'claude build not staged: {pathlib.Path(m).name} (fleet.py setup)' for m in missing]
        else:
            summ['claude_build'] = claude_libc_gate(task_imgs, builds, parallel=a.parallel)
            summ['claude_refused'] = sorted(t for t, b in summ['claude_build'].items() if b is None)
            summ['failed'] = summ['claude_refused']
    write_json(paths.prepull, summ)
    print(json.dumps({k: summ[k] for k in ('n', 'failed', 'bytes', 'docker_free_gb', 'claude_refused') if k in summ}))
    if summ['failed']:
        sys.exit(1)


def cmd_check(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    plan = _plan(a, env)
    kinds = ('oracle', 'nop') if a.kind == 'both' else (a.kind,)
    log = Log(paths.log)
    if not a.profile.check_slots:
        with run_lock(paths):
            summ = run_checks(plan=plan, env=env, paths=paths, harbor=Harbor(a.harbor), environment=profiles.load_attr(a.profile.environment_config)(),
                              kinds=kinds, reps=a.reps, concurrency=a.concurrency, docker=Docker(), log=log)
        print(json.dumps({k: summ[k] for k in ('kinds', 'reps', 'dropped', 'unresolved')}))
        return
    # TB (§7.5): two counted slots per kind; `--post` is the post-run oracle re-check of every kept task (one slot,
    # into results/checks/post/, a sensitivity only: it never changes the drop list).
    if not 1 <= a.concurrency <= a.profile.max_concurrency:
        raise SystemExit(f'--concurrency must be 1..{a.profile.max_concurrency}')
    mine = sorted(shardplan.shard_tasks(plan)[env.index])
    n_slots, tasks = CHECK_SLOTS, mine
    if a.post:
        dropped, unresolved = check_gate(paths, mine)
        if unresolved:
            raise SystemExit(f'--post needs the main checks resolved ({len(unresolved)} are not)')
        kinds, n_slots, tasks = ('oracle',), 1, [t for t in mine if t not in dropped]
        paths.checks = paths.checks / 'post'
        paths.check_events, paths.check_summary = paths.checks / 'checks.jsonl', paths.checks / 'summary.json'
    docker = Docker()
    with run_lock(paths):
        docker.prune_networks()
        tb_preflight(plan, env, tasks, log)
        summ = run_checks(plan=plan, env=env, paths=paths, harbor=Harbor(a.harbor, env=harbor_subprocess_env(extra=env.online_env())),
                          environment=profiles.load_attr(a.profile.environment_config)(), kinds=kinds, reps=1, concurrency=a.concurrency, docker=docker,
                          log=log, tasks=tasks, profile=a.profile, n_slots=n_slots)
    print(json.dumps({k: summ[k] for k in ('kinds', 'slots', 'dropped', 'unresolved', 'flaky_env')}))


CONTINUITY_FIELDS = ('plan_sha256', 'agent_pin', 'router_policy_version', 'concurrency', 'arms')


def agent_pin(profile: profiles.Dataset) -> dict[str, Any] | None:
    """Claude Code (4f): hcommon.CLAUDE_CODE (version and per-platform sha256) and the staged binary's sha256, for
    the stage-continuity check. None if 4f's pin is not present (dry runs without it)."""
    try:
        import hcommon
    except ImportError:
        return None
    pin = getattr(hcommon, 'CLAUDE_CODE', None)
    if not isinstance(pin, dict):
        return None
    out: dict[str, Any] = {'version': pin.get('version'), 'sha256': {k: (pin.get('sha256') or {}).get(k) for k in ('linux-x64', 'linux-x64-musl')}}
    binf = getattr(hcommon, 'claude_bin', None)
    if callable(binf):
        for plat in ('linux-x64', 'linux-x64-musl'):
            with contextlib.suppress(Exception):
                p = pathlib.Path(binf(plat))
                if p.is_file():
                    out.setdefault('binary_sha256', {})[plat] = shardplan.sha256_file(p)
    return out


def continuity_changes(prev: dict[str, Any], cfg: dict[str, Any]) -> dict[str, str]:
    """Fields of CONTINUITY_FIELDS that differ from the previous run-config (Claude Code stages: stage 2 must continue
    stage 1). A field missing on either side is not compared."""
    out = {}
    for k in CONTINUITY_FIELDS:
        if k in prev and k in cfg and prev[k] is not None and cfg[k] is not None and prev[k] != cfg[k]:
            out[k] = 'plan file' if k == 'plan_sha256' else ('arm table' if k == 'arms' else f'{prev[k]!r} → {cfg[k]!r}')
    return out


MIN_EFFECTIVE_CAP_USD = 5.0


def check_caps(hard_cap: float, reserve: float, soft_cap: float) -> list[str]:
    """The proxy refuses calls once spend + in-flight reservations reach hard cap − reserve. Refuses an effective cap
    below MIN_EFFECTIVE_CAP_USD (0c's pilot: --hard-cap 12.5 with the $10 reserve stopped every trial within 90 s)
    and a soft cap above the effective hard cap (the hard stop would come first and leave incomplete blocks)."""
    eff = hard_cap - reserve
    issues = []
    if eff < MIN_EFFECTIVE_CAP_USD:
        issues.append(f'--hard-cap ${hard_cap:g} minus the proxy reserve ${reserve:g} leaves ${eff:g} of Bedrock spend '
                      f'(< ${MIN_EFFECTIVE_CAP_USD:g}); pass --hard-cap ≥ <wanted effective cap> + {reserve:g}')
    if soft_cap > eff:
        issues.append(f'--soft-cap ${soft_cap:g} is above the effective hard cap ${eff:g} (hard cap − ${reserve:g} reserve)')
    return issues


def make_proxy(a: argparse.Namespace, env: RunnerEnv, paths: Paths) -> Any:
    """4f's in-process RunnerProxy: shared refreshing token minted from the runner secret, hard-cap ledger on
    Bedrock spend only (runner hours are outside the proxy's cap; design §9)."""
    import auth
    import hproxy
    import proxy as px
    region = a.region or env.region
    if not region:
        raise SystemExit('--region (or AWS_REGION) is required')
    if not env.proxy_addr:
        raise SystemExit('PROXY_ADDR is not set (/etc/llmar-runner.env)')
    ledger = hproxy.make_ledger(paths.proxy, cap_usd=a.hard_cap)
    issues = check_caps(ledger.cap, ledger.reserve, a.soft_cap)
    if issues:
        raise SystemExit('caps: ' + '; '.join(issues))
    if a.unstop_cap:
        ledger.unstop(f'operator resume after a cap change to ${a.hard_cap:.0f}')
    minter = auth.TokenMinter(auth.read_secret(region, a.secret_id))
    # 0c: the pilot forces a real re-mint mid-session (token older than N s); the main passes use expiry − 120 s.
    token = hproxy.SharedToken(minter, token_max_age_s=a.token_max_age_s or None)
    srv = hproxy.RunnerProxy(env.proxy_addr, env.proxy_port, px.Upstreams(a.gateway_url, region), ledger, token, paths.proxy)
    assert_proxy_bind(srv.server_address, env)
    th = hproxy.serve_in_thread(srv)
    srv.thread_alive = th.is_alive   # type: ignore[attr-defined]
    return srv


def assert_proxy_bind(addr: tuple[Any, ...], env: RunnerEnv) -> None:
    """18's F7: the proxy listens on exactly PROXY_ADDR:PROXY_PORT from the runner env file, a private,
    non-wildcard IPv4 (docker0's address)."""
    import ipaddress
    ip = ipaddress.ip_address(env.proxy_addr)
    if ip.version != 4 or ip.is_unspecified or ip.is_loopback or not ip.is_private:
        raise SystemExit(f'PROXY_ADDR {env.proxy_addr} must be a private, non-wildcard IPv4')
    if (str(addr[0]), int(addr[1])) != (env.proxy_addr, env.proxy_port):
        raise SystemExit(f'the proxy is bound to {addr[0]}:{addr[1]}, not PROXY_ADDR {env.proxy_addr}:{env.proxy_port}')


def cmd_run(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    plan = _plan(a, env)
    log = Log(paths.log)
    if a.soft_cap > a.hard_cap:
        raise SystemExit('--soft-cap must not exceed --hard-cap')
    if paths.stop.exists():
        raise SystemExit('results/STOP exists (a drain was requested): run `driver.py unstop` first')
    with run_lock(paths):
        prev = read_json(paths.run_config) if paths.run_config.exists() else None
        if prev and prev.get('concurrency') != a.concurrency and not a.change_concurrency:
            raise SystemExit(f"this runner ran at concurrency {prev['concurrency']}; it is fixed for the whole run "
                             f"(pass --change-concurrency to change it on purpose)")
        if prev and prev.get('plan_sha256') and prev['plan_sha256'] != plan['_sha256']:
            log(f"plan.json changed since the last run on this runner: {prev['plan_sha256'][:12]} → {plan['_sha256'][:12]} (a cut?)")
        cfg = {'concurrency': a.concurrency, 'soft_cap_usd': a.soft_cap, 'hard_cap_usd': a.hard_cap, 'passes': a.passes,
               'max_blocks': a.max_blocks, 'runner': env.index, 'plan_sha256': plan['_sha256'], 'token_max_age_s': a.token_max_age_s,
               'updated': iso(),
               'history': (prev or {}).get('history', []) + [
                   {'at': iso(), 'concurrency': a.concurrency, 'soft_cap_usd': a.soft_cap, 'hard_cap_usd': a.hard_cap, 'passes': a.passes,
                    'max_blocks': a.max_blocks, 'plan_sha256': plan['_sha256'], 'token_max_age_s': a.token_max_age_s}]}
        lookup = None
        if not a.profile.is_default:   # TB: the dataset, budgets, network keys and rule versions (§7.4: hashes in run-config)
            if not 1 <= a.concurrency <= a.profile.max_concurrency:
                raise SystemExit(f'--concurrency must be 1..{a.profile.max_concurrency}')
            lookup_version = None
            if a.profile.lookupscan:
                try:
                    import lookupscan
                    lookup = lookupscan.scan_trial
                    lookup_version = lookupscan.VERSION
                except ImportError:
                    if not a.allow_no_lookupscan:
                        raise SystemExit("lookupscan.py (4f) is not importable: rule (b) and §7.7 need it (--allow-no-lookupscan for dry runs)") from None
            cfg.update({'dataset': a.profile.name, 'cpu_budget': a.profile.cpu_budget, 'mem_budget_gb': a.profile.mem_budget_gb,
                        'container_egress': env.container_egress, **env.online_env(), 'classify_version': clf.VERSION,
                        'lookupscan_version': lookup_version, 'watchdog': 'per task: agent + verifier + build timeouts + '
                                                                       f'{profiles.WATCHDOG_MARGIN_S:g} s'})
            if a.profile.wall_timeout_h is not None:
                cfg['watchdog'] = f'{a.wall_timeout_h:g} h'
        if a.profile.agent != 'codex':   # Claude Code: the agent pin and the router policy, for the stage-continuity check
            cfg.update({'agent': a.profile.agent, 'agent_pin': agent_pin(a.profile), 'router_policy_version': a.router_policy_version,
                        'arms': plan.get('arms')})
        if a.profile.continuity and prev:
            changed = continuity_changes(prev, cfg)
            refused = sorted(set(changed) - set(a.allow_change or []))
            if refused:
                raise SystemExit(f'stage continuity: {", ".join(f"{k} changed ({changed[k]})" for k in refused)} since the last run '
                                 f'on this runner; pass --allow-change <field> to change one on purpose')
            if changed:
                log(f'stage continuity: allowed changes {sorted(changed)}')
        if a.profile.agent == 'claude-code':   # a3's libc gate, from the last prepull: refuse before any spend
            gate = claude_gate_issues(read_json(paths.prepull) if paths.prepull.exists() else {},
                                      [it['task'] for p in a.passes for it in shardplan.trials_of(plan, p, env.index)])
            if gate:
                raise SystemExit(f'libc gate: {"; ".join(gate[:5])}' + (f' (+{len(gate) - 5} more)' if len(gate) > 5 else ''))
        write_json(paths.run_config, cfg)
        job_config = profiles.load_attr(a.profile.job_config)
        srv = make_proxy(a, env, paths)
        docker = Docker()
        dw = Watcher(['docker', 'events', '--format', '{{json .}}', '--filter', 'type=container', '--filter', 'event=start',
                      '--filter', 'event=die', '--filter', 'event=oom'], parse_docker_event, paths.docker_events, log).start()
        kw = Watcher(['journalctl', '-k', '-f', '-n', '0', '-o', 'short-unix', '--no-pager'],
                     parse_journal_line_victim if a.profile.mem_watch else parse_journal_line, paths.kernel_oom, log).start()
        tb: dict[str, Any] = {}
        if not a.profile.is_default:
            mine = sorted({it['task'] for p in a.passes for it in shardplan.trials_of(plan, p, env.index)})
            tb = {'profile': a.profile, 'lookup': lookup,
                  'preflight': lambda: tb_preflight(plan, env, mine, log, images=a.profile.taskpin)}
        harbor = Harbor(a.harbor, env=harbor_subprocess_env(extra=env.online_env())) if tb else Harbor(a.harbor)
        d = Driver(plan=plan, env=env, paths=paths, passes=a.passes, proxy=srv, harbor=harbor, job_config=job_config,
                   concurrency=a.concurrency, soft_cap=a.soft_cap, max_blocks=a.max_blocks, wall_timeout_s=a.wall_timeout_h * 3600,
                   metrics=Metrics(METRICS_BIN, paths.metrics), docker=docker, docker_watch=dw, kernel_watch=kw, log=log,
                   check_gate_on=not a.no_check_gate, **tb)
        if a.profile.mem_watch:
            d.mem = MemSampler(d.running_prefixes)

        def on_term(signum: int, _frame: Any) -> None:
            log(f'signal {signum}: cancelling running trials')
            d.stop_now.set()
        signal.signal(signal.SIGTERM, on_term)
        signal.signal(signal.SIGINT, on_term)
        try:
            out = d.run()
        finally:
            dw.stop()
            kw.stop()
            srv.shutdown()
    print(json.dumps(out))


def cmd_status(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    doc = read_json(paths.status) if paths.status.exists() else {}
    holder = lock_holder(paths)
    events = read_jsonl(paths.events)
    plan = shardplan.load_plan(pathlib.Path(a.plan)) if pathlib.Path(a.plan).exists() else None
    passes = a.passes or doc.get('passes') or (['main'] if plan else [])
    if plan:
        items = [it for p in passes if p in plan['passes'] for it in shardplan.trials_of(plan, p, env.index)]
        dropped, unresolved = check_gate(paths, sorted({it['task'] for it in items}))
        items = [it for it in items if it['task'] not in dropped]
        st = replay(events, items)
        blocks = list(dict.fromkeys((it['pass'], it['block']) for it in items))
        bk: dict[tuple[str, int], list[str]] = collections.defaultdict(list)
        for it in items:
            bk[(it['pass'], it['block'])].append(key_of(it['pass'], it['task'], it['arm'], it['rep']))
        doc['progress'] = blind_progress(progress(st, items, blocks, bk)) if a.profile.blind else progress(st, items, blocks, bk)
        doc['checks'] = {'dropped': sorted(dropped), 'unresolved': len(unresolved)}
    spend = read_json(paths.proxy / 'proxy-state.json') if (paths.proxy / 'proxy-state.json').exists() else {}
    doc.update({'driver_pid': holder, 'driver_alive': holder is not None, 'stop_file': paths.stop.exists(),
                'proxy_state': {k: spend.get(k) for k in ('cap_usd', 'settled_usd', 'inflight', 'stopped')},
                'free_gb': round(free_gb([paths.results, pathlib.Path('/var/lib/docker')]), 1), 'now': iso()})
    text = json.dumps(doc, separators=(',', ':'))
    if len(text) > 20_000:   # one SSM read (24,000 characters)
        doc.pop('recent_errors', None)
        doc['in_flight'] = doc.get('in_flight', [])[:6]
        text = json.dumps(doc, separators=(',', ':'))
    print(mask(text))


def cmd_stop(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    paths.stop.write_text(iso() + '\n')
    holder = lock_holder(paths)
    if a.now and holder and holder > 0:
        os.kill(holder, signal.SIGTERM)
    print(json.dumps({'stop_file': True, 'signalled': bool(a.now and holder and holder > 0), 'driver_pid': holder}))


def cmd_unstop(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    paths.stop.unlink(missing_ok=True)
    print(json.dumps({'stop_file': False}))


# ---------------------------------------------------------------- operator resets (Claude Code; driver stopped)

_REASON_RE = re.compile(r'[A-Za-z0-9 .,:;()/+=_-]{3,200}')
REQUEUE_REASONS = {'router-short': 'the router log saw fewer model calls than the proxy forwarded (merge-time join)'}


def _cc_only(a: argparse.Namespace) -> None:
    if a.profile.agent != 'claude-code':
        raise SystemExit(f'{a.cmd} is for the Claude Code profiles only (--agent claude-code)')


def plain_reason(text: str) -> str:
    """An operator note for the event log: plain text, 3–200 characters, no account-shaped digit run."""
    if not _REASON_RE.fullmatch(text or '') or _ACCOUNT_RE.search(text):
        raise SystemExit('--reason: 3-200 characters of letters, digits, spaces and .,:;()/+=_- (no 12-digit runs)')
    return text


def void_pass(paths: Paths, passes: list[str], reason: str) -> dict[str, Any]:
    """Forget every attempt of `passes` on this runner so they run again from scratch (0c: the DeepSWE pilot whose calls
    all went to the gateway's fallback). Append-only: one `void` event (replay drops the earlier attempts and finals of
    those passes; the events themselves, with their rewards, stay in attempts.jsonl for the record). Harbor job dirs
    and per-attempt dirs stay where they are (new attempts get new trial ids); the proxy ledger and calls.jsonl are not
    touched (the spend is real and stays on the runner's cap); run-config.json moves to run-config.void-<t>.json, so the
    next run starts the continuity baseline afresh. Refused while another pass has attempts here, or while an attempt or
    re-verify of the passes has no end (an orphan: start the driver once so it recovers them)."""
    raw = paths.events.read_bytes() if paths.events.exists() else b''
    events = read_jsonl(paths.events)
    st = replay(events, [])
    vp = set(passes)
    mine = [ks for ks in st.values() if ks.attempts and ks.item.get('pass') in vp]
    others = sorted({str(ks.item.get('pass')) for ks in st.values() if ks.attempts and ks.item.get('pass') not in vp})
    if others:
        raise SystemExit(f'void-pass: this runner also has attempts of {others}; a pass can be voided only while it is the only one run here')
    if not mine:
        raise SystemExit(f'void-pass: no attempts of {sorted(vp)} on this runner')
    atts = [a for ks in mine for a in ks.attempts]
    tids = {a.trial_id for a in atts}
    open_ = sorted(a.trial_id for a in atts if a.end is None)
    rv_done = {e.get('job_name') for e in events if e.get('ev') == 'reverify-end'}
    open_ += sorted(str(e.get('job_name')) for e in events if e.get('ev') == 'reverify-start' and e.get('trial_id') in tids
                    and e.get('job_name') not in rv_done)
    if open_:
        raise SystemExit(f'void-pass: {len(open_)} attempts or re-verifies have no end event (e.g. {open_[0]}): start the driver once '
                         f'so it recovers them, stop it, then void')
    rc = read_json(paths.run_config) if paths.run_config.exists() else None
    moved = None
    if rc is not None:
        dst = paths.results / f'run-config.void-{int(now())}.json'
        os.replace(paths.run_config, dst)
        moved = dst.name
    ev = {'ev': 'void', 'passes': sorted(vp), 'reason': reason, 'keys': len(mine), 'attempts': len(atts), 'trial_ids': sorted(tids),
          'spent_usd': round(sum(float(((a.end or {}).get('proxy') or {}).get('spent_usd') or 0.0) for a in atts), 6),
          'events_sha256': sha256_bytes(raw), 'events_lines': len(events),
          'run_config': {k: rc.get(k) for k in (*CONTINUITY_FIELDS, 'soft_cap_usd', 'hard_cap_usd', 'passes', 'history')} if rc else None,
          'run_config_moved_to': moved, 'at': round(now(), 3)}
    append_jsonl(paths.events, ev)
    return {k: ev[k] for k in ('passes', 'keys', 'attempts', 'spent_usd', 'run_config_moved_to')}


def requeue(paths: Paths, trial_ids: list[str], why: str) -> dict[str, Any]:
    """Reclassify scored attempts as harness reruns after the fact (0c: a call that never reached the router is never
    scored; the merge-time router-log join finds them, fleet.py `requeue` sends them here). One `reclass` event per
    attempt: replay uses its classification and drops the key's final, so the next `run` of the pass reruns the key
    (counted toward the rerun limit). Only the last attempt of a key whose final is `scored` is requeued; anything else is
    skipped with the reason. Prints no outcome."""
    reason = REQUEUE_REASONS[why]
    st = replay(read_jsonl(paths.events), [])
    by_tid = {a.trial_id: (ks, a) for ks in st.values() for a in ks.attempts}
    done: list[str] = []
    skipped: dict[str, str] = {}
    for tid in dict.fromkeys(trial_ids):
        if not TRIAL_ID_RE.fullmatch(tid):
            raise SystemExit(f'requeue: bad trial id {tid[:40]!r}')
        ks, a = by_tid.get(tid, (None, None))
        if ks is None or a is None:
            skipped[tid] = 'not in the event log (or voided)'
        elif a.reclass:
            skipped[tid] = 'already requeued'
        elif ks.attempts[-1] is not a:
            skipped[tid] = "not its key's last attempt"
        elif (ks.final or {}).get('status') != 'scored':
            skipped[tid] = f"its key is not scored ({(ks.final or {}).get('status') or 'open'})"
        else:
            out = a.outcome or {}
            c = {'class': 'harness', 'action': 'rerun', 'reason': f"{reason} (was {out.get('class')}/{out.get('action')})",
                 'reward': out.get('reward'), 'score': None, 'exception_type': out.get('exception_type'), 'tags': out.get('tags') or []}
            append_jsonl(paths.events, {'ev': 'reclass', 'trial_id': tid, 'key': ks.key, 'why': why, 'classification': c,
                                        'from': {'class': out.get('class'), 'action': out.get('action')}, 'at': round(now(), 3)})
            done.append(tid)
    return {'requeued': len(done), 'skipped': skipped}


def cmd_void_pass(a: argparse.Namespace) -> None:
    _cc_only(a)
    _, paths = _env_and_paths(a)
    reason = plain_reason(a.reason)
    with run_lock(paths):
        out = void_pass(paths, a.passes, reason)
    Log(paths.log, echo=False)(f'void-pass {json.dumps(out)}: {reason}')
    print(json.dumps(out))


def cmd_requeue(a: argparse.Namespace) -> None:
    _cc_only(a)
    _, paths = _env_and_paths(a)
    with run_lock(paths):
        out = requeue(paths, a.trial_ids, a.why)
    Log(paths.log, echo=False)(f'requeue ({a.why}): {out["requeued"]} requeued, {len(out["skipped"])} skipped')
    print(json.dumps(out))


def cmd_export(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    base = latest_manifest(paths, a.base)
    fixtures = None
    if a.profile.taskpin and pathlib.Path(a.plan).exists():   # TB: the shard's own task dirs (4f: one Scanner per export)
        plan = shardplan.load_plan(pathlib.Path(a.plan))
        fixtures = [task_dir(paths, t) for t in sorted(shardplan.shard_tasks(plan)[env.index]) if task_dir(paths, t).is_dir()] or None
    scanner = make_scanner(not (a.no_imds_account or os.environ.get('LLMAR_NO_IMDS')), Log(paths.log, echo=False), fixtures)
    if scanner is None and not a.allow_no_leakscan:
        raise SystemExit('leakscan.py is not importable: refusing to export without it (--allow-no-leakscan for tests)')
    m = build_export(paths, mode=a.mode, runner=env.index, base=base, max_file=a.max_file_mb << 20, scanner=scanner, dataset=a.profile.name,
                     agent=a.profile.agent)
    edir = paths.exports / m['export_id']
    out = {k: m[k] for k in ('export_id', 'mode', 'base', 'parts', 'tar_sha256', 'tar_bytes', 'unchanged', 'dataset') if k in m}
    out.update({'files': len(m['files']), 'skipped': len(m['skipped']), 'blocked': m['blocked'],
                'finding_kinds': sorted({f.get('kind') for fs in m['findings'].values() for f in fs})})
    if a.s3_bucket:
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', a.s3_bucket):
            raise SystemExit('bad bucket name')
        if not env.results_prefix:
            raise SystemExit('RESULTS_PREFIX is not set (/etc/llmar-runner.env)')
        key = f"{env.results_prefix}{m['export_id']}"
        for name in ('payload.tar.gz', 'manifest.json'):
            subprocess.run(['aws', 's3', 'cp', '--only-show-errors', str(edir / name), f's3://{a.s3_bucket}/{key}/{name}'],  # nosec B603 B607
                           check=True, timeout=3600)
        out['s3_key'] = key
    print(json.dumps(out))


def tree_manifest(root: pathlib.Path) -> dict[str, list[Any]]:
    """rel path → [size, sha256] of every regular file under `root` (symlinks are listed, never followed)."""
    out: dict[str, list[Any]] = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for fn in sorted(filenames):
            p = pathlib.Path(dirpath) / fn
            rel = str(p.relative_to(root))
            if p.is_symlink():
                out[rel] = ['symlink', None]
            elif p.is_file():
                out[rel] = [p.stat().st_size, file_sha256(p)]
    return out


def last_full_export(paths: Paths) -> dict[str, Any] | None:
    best = None
    if paths.exports.is_dir():
        for mp in paths.exports.glob('*/manifest.json'):
            try:
                m = read_json(mp)
            except (OSError, ValueError):
                continue
            if m.get('mode') == 'full' and (best is None or int(m['export_id'].split('-')[0]) > int(best['export_id'].split('-')[0])):
                best = m
    return best


def b64(hexdigest: str) -> str:
    import base64
    return base64.urlsafe_b64encode(bytes.fromhex(hexdigest)).decode().rstrip('=')


def cmd_archive(a: argparse.Namespace) -> None:
    """The changeover (TB §6.4 step 2): freeze a dataset's results dir in place. Writes
    $WORK_DIR/archive/<dataset>-<ts>.manifest.json (size and sha256 of every results file), checks that every
    allowlisted file is the one the last full export shipped (the dev box verified that export's sha256s), then
    removes write permission from the results tree (chmod a-w; root can still write, so the manifest and
    `--verify` are what detect a change). Files the allowlist leaves out by name are listed (`excluded_by_name`, with
    per-directory counts) so a directory dropped whole is visible. Nothing is deleted or moved. `--verify <manifest>` re-hashes against an
    earlier archive manifest."""
    env, paths = _env_and_paths(a)
    if a.verify:
        old = read_json(pathlib.Path(a.verify))
        now_files = tree_manifest(paths.results)
        changed = sorted(k for k in old['files'] if k in now_files and now_files[k] != old['files'][k])
        missing = sorted(k for k in old['files'] if k not in now_files)
        new = sorted(k for k in now_files if k not in old['files'])
        print(json.dumps({'verify': pathlib.Path(a.verify).name, 'files': len(old['files']), 'same': len(old['files']) - len(changed) - len(missing),
                          'changed': changed[:20], 'missing': missing[:20], 'new': new[:20], 'ok': not (changed or missing or new)}))
        if changed or missing or new:
            sys.exit(1)
        return
    holder = lock_holder(paths)
    if holder:
        raise SystemExit(f'a driver holds {paths.lock} (pid {holder}): stop it first')
    files = tree_manifest(paths.results)
    excluded: dict[str, list[str]] = {}
    allow = {str(p.relative_to(paths.results)) for p in export_candidates(paths.results, a.profile.agent, excluded)}
    by_name = excluded.get('name', [])
    # Files left out by the credential-name rule, per directory (up to 3 levels: jobs/<job>/<trial dir>), so a trial
    # dir left out whole is visible here instead of silently missing from the allowlist.
    by_dir = collections.Counter('/'.join(x.split('/')[:-1][:3]) or '.' for x in by_name)
    full = last_full_export(paths)
    shipped = (full or {}).get('all_files', {})
    differs = sorted(k for k in allow if k in shipped and files.get(k) != shipped[k])
    not_shipped = sorted(k for k in allow if k not in shipped)
    adir = paths.work / 'archive'
    adir.mkdir(parents=True, exist_ok=True, mode=0o700)
    ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    man = {'schema': 'llmar-archive/v1', 'dataset': a.profile.name, 'runner': env.index, 'created': iso(), 'results': str(paths.results),
           'files': files, 'n_files': len(files), 'bytes': sum(v[0] for v in files.values() if isinstance(v[0], int)),
           'last_full_export': (full or {}).get('export_id'), 'allowlisted': len(allow), 'matched_last_full_export': len(allow) - len(differs) - len(not_shipped),
           'differs_from_export': differs, 'not_in_export': not_shipped, 'excluded_by_name': sorted(by_name),
           'excluded_by_name_dirs': dict(sorted(by_dir.items())), 'excluded_cc_client_state': len(excluded.get('cc_client_state', []))}
    mp = adir / f'{a.profile.name}-{ts}.manifest.json'
    write_json(mp, man)
    os.chmod(mp, 0o400)
    for dirpath, dirnames, filenames in os.walk(paths.results, topdown=False, followlinks=False):
        for fn in filenames:
            p = pathlib.Path(dirpath) / fn
            if not p.is_symlink():
                os.chmod(p, p.stat().st_mode & ~0o222)
        os.chmod(dirpath, os.stat(dirpath).st_mode & ~0o222)
    print(json.dumps({'archive': str(mp), 'manifest_sha256_b64': b64(file_sha256(mp)), 'n_files': man['n_files'], 'bytes': man['bytes'],
                      'last_full_export': man['last_full_export'], 'allowlisted': man['allowlisted'],
                      'matched_last_full_export': man['matched_last_full_export'], 'differs_from_export': differs[:20],
                      'not_in_export': len(not_shipped), 'excluded_by_name': len(by_name),
                      'excluded_by_name_dirs': dict(sorted(by_dir.items(), key=lambda x: (-x[1], x[0]))[:20]),
                      'excluded_cc_client_state': man['excluded_cc_client_state'], 'read_only': True}))


def cmd_export_part(a: argparse.Namespace) -> None:
    env, paths = _env_and_paths(a)
    if not re.fullmatch(r'[0-9]+-[0-9a-f]{6}', a.id):
        raise SystemExit('bad export id')
    sys.stdout.write((paths.exports / a.id / 'parts' / f'p{int(a.part):05d}').read_text())


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--env-file', default=str(ENV_FILE))
    ap.add_argument('--work', help='override WORK_DIR (tests, dry runs)')
    ap.add_argument('--shard', type=int, help='override RUNNER_INDEX (tests, dry runs)')
    ap.add_argument('--dataset', default='deepswe', help='deepswe (default) or tb21 (profiles.py): plan, checkout and results dirs')
    ap.add_argument('--agent', default=None, help='codex (default) or claude-code (profiles.py)')
    ap.add_argument('--plan', help="the plan file (default: the dataset's committed plan)")
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('fetch-tasks')
    p.add_argument('--repo-url', help="the dataset repository (default: the dataset's)")
    p.set_defaults(fn=cmd_fetch_tasks)
    p = sub.add_parser('prepull')
    p.add_argument('--parallel', type=int, default=4)
    p.set_defaults(fn=cmd_prepull)
    p = sub.add_parser('check')
    p.add_argument('--kind', choices=('oracle', 'nop', 'both'), default='both')
    p.add_argument('--reps', type=int, default=1)
    p.add_argument('--concurrency', type=int, default=DEFAULT_CONCURRENCY)
    p.add_argument('--harbor', default='harbor')
    p.add_argument('--post', action='store_true', help='TB: the post-run oracle re-check of every kept task (results/checks/post/)')
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser('run')
    p.add_argument('--pass', dest='passes', action='append', required=True, help='plan pass to run (repeatable, in order)')
    p.add_argument('--gateway-url', required=True, help='router stack output GatewayUrl (pass at run time; never committed)')
    p.add_argument('--region', default=os.environ.get('AWS_REGION'))
    p.add_argument('--secret-id', default='llmar-runner/client')
    p.add_argument('--concurrency', type=int, default=DEFAULT_CONCURRENCY)
    p.add_argument('--change-concurrency', action='store_true')
    p.add_argument('--soft-cap', type=float, default=DEFAULT_SOFT_CAP, help='stop admitting new blocks at this Bedrock spend (USD)')
    p.add_argument('--hard-cap', type=float, default=DEFAULT_HARD_CAP, help="the proxy's fail-closed cap (USD)")
    p.add_argument('--unstop-cap', action='store_true', help='clear a sticky proxy cap stop (after 0c raised --hard-cap)')
    p.add_argument('--max-blocks', type=int, help='checkpoint: admit at most this many blocks over the listed passes')
    p.add_argument('--token-max-age-s', type=float, help='re-mint the gateway token once it is this old (pilot: 600); default: expiry - 120 s')
    p.add_argument('--wall-timeout-h', type=float, default=WALL_TIMEOUT_H)
    p.add_argument('--no-check-gate', action='store_true', help='run without the oracle/null check summary (dry runs only)')
    p.add_argument('--allow-no-lookupscan', action='store_true', help='TB dry runs only: run without 4f\'s lookupscan')
    p.add_argument('--allow-change', action='append', choices=CONTINUITY_FIELDS,
                   help='Claude Code stages: allow this continuity field to differ from the last run (logged)')
    p.add_argument('--router-policy-version', help="Claude Code: the router's decision.policyVersion (0c reads it from the router logs)")
    p.add_argument('--harbor', default='harbor')
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser('status')
    p.add_argument('--pass', dest='passes', action='append')
    p.set_defaults(fn=cmd_status)
    p = sub.add_parser('stop')
    p.add_argument('--now', action='store_true', help='also cancel the running trials (SIGTERM to the driver)')
    p.set_defaults(fn=cmd_stop)
    p = sub.add_parser('unstop', help='remove results/STOP (then start `run` again)')
    p.set_defaults(fn=cmd_unstop)
    p = sub.add_parser('void-pass', help='Claude Code: forget every attempt of a pass so it runs again from scratch (driver stopped)')
    p.add_argument('--pass', dest='passes', action='append', required=True)
    p.add_argument('--reason', required=True, help='plain-text note for the event log')
    p.set_defaults(fn=cmd_void_pass)
    p = sub.add_parser('requeue', help="Claude Code: reclassify scored attempts as harness reruns (driver stopped)")
    p.add_argument('--trial-id', dest='trial_ids', action='append', required=True)
    p.add_argument('--why', choices=sorted(REQUEUE_REASONS), required=True)
    p.set_defaults(fn=cmd_requeue)
    p = sub.add_parser('export')
    p.add_argument('--mode', choices=('light', 'full'), default='light')
    p.add_argument('--base', help='a previous export id: include only files changed since it')
    p.add_argument('--max-file-mb', type=int, default=1)
    p.add_argument('--s3-bucket', help='also upload to s3://<bucket>/<RESULTS_PREFIX><export id>/')
    p.add_argument('--no-imds-account', action='store_true', help='do not look up the account id (off the runner)')
    p.add_argument('--allow-no-leakscan', action='store_true')
    p.set_defaults(fn=cmd_export)
    p = sub.add_parser('export-part')
    p.add_argument('--id', required=True)
    p.add_argument('--part', type=int, required=True)
    p.set_defaults(fn=cmd_export_part)
    p = sub.add_parser('archive', help="freeze a dataset's results dir: sha256 manifest + chmod a-w (no deletes, no moves)")
    p.add_argument('--verify', help='re-hash against this archive manifest instead')
    p.set_defaults(fn=cmd_archive)
    a = ap.parse_args(argv)
    a.profile = profiles.get(a.dataset, a.agent)
    a.plan = a.plan or str(a.profile.plan)
    os.umask(0o077)
    no_core_dumps()
    a.fn(a)


def no_core_dumps() -> None:
    """18's F6: a crash must not write the in-memory token or client secret to a core file."""
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


if __name__ == '__main__':
    main()
