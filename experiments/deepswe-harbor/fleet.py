"""Parent tooling for the four runners (design §9), run by 0c on the dev box. Stdlib only. AWS goes through the aws CLI
with the operator's credentials, and these are the only AWS calls it makes:
- ssm send-command and get-command-invocation, with the AWS-RunShellScript document;
- cloudformation describe-stacks, read-only;
- s3 cp, download only.

  python3 fleet.py --region <r> --stack <prefix>-runner pack
  python3 fleet.py --region <r> --stack <prefix>-runner ship                  # code + driver venv on every runner
  python3 fleet.py … setup                                                    # stage Codex, clone deep-swe at the plan's commit
  python3 fleet.py … prepull | check [--kind both --reps 1] | isolation        # detached systemd units
  python3 fleet.py … isolation --wait                                        # 18's isolation suite: gates per runner, then a light fetch
  python3 fleet.py … isolation --show                                        # the last run's gate lines
  python3 fleet.py … start --pass main --gateway-url <url> [--concurrency 6] [--soft-cap 1000] [--hard-cap 1130]
  python3 fleet.py … status | units | stop [--now] | unstop
  python3 fleet.py … fetch [--mode light|full] [--s3-bucket <name>]           # incremental; sha256-checked
  python3 fleet.py merge [--tasks-dir <deep-swe>/tasks] [--tiers <tiers.jsonl>] [--harvest]
  python3 fleet.py project [--cut-options 7,14,21]                            # §7.5 checkpoint re-projection

`--dataset tb21` (profiles.py) runs every command for Terminal-Bench 2.1: its plan, pack roots (+ experiments/tbench-harbor),
runner dirs ($WORK_DIR/tb21/…), dev-box dirs (experiments/tbench-harbor/results/…), concurrency ≤ 8, the TB isolation
gates, and a pre-flight at `start` (the proxy reserve must stay below hard cap − the largest expected single run).
`archive` freezes a dataset's results on the runners (manifest + chmod a-w; nothing deleted or moved).
`--agent claude-code` (profiles cc-deepswe, cc-tb21; experiments/claude-code-harbor/ORCHESTRATION.md): `start` takes per-runner
caps from `--caps-file` and refuses unless the global budget pre-flight holds (budget.json; every Claude Code ledger's
exposure); `project` is the outcome-blind pilot gate and projection (ccproject.py); `budget [--close]` shows or closes
a benchmark's exposure; `merge --router-logs` joins the router log per trial.
`--runners 0,2` limits a command to some runners. The default is all of them, in RunnerIndex order: the stack output
InstanceIds, or `--instances i-…,i-…`.

What is shipped: experiments/deepswe-harbor, experiments/codex-deepswe (shared modules) and packages/pricing/data.
Each root leaves out its results/, data/, bin/ and caches. The package is a byte-reproducible tarball, sent as base64
parts over send-command, then sha256-checked and member-checked on the runner (regular files and directories only,
under those roots), and unpacked into $WORK_DIR/repo. The runner-local bin/ and results/ dirs are kept. The driver
venv is built from driver-requirements.txt (exported from driver.py.lock, hash-pinned).

What is fetched: `driver.py export` on the runner, which is an allowlist of results files (0d) with secret-shaped
files left out. The light mode goes as chunked base64 over SSM. The full mode goes through the private results
bucket (runs/<i>/<export-id>/), which the runner role can only PutObject to. Every fetch checks the tarball's sha256
and every member's path and type before it is unpacked into results/fleet/runner-<i>/. Never upload or fetch
anything else.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess  # nosec B404 - fixed argv lists (aws, uv)
import sys
import tarfile
import tempfile
import time
from collections.abc import Callable
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import profiles
import shardplan  # noqa: E402

FLEET = HERE / 'results' / 'fleet'
MERGED = HERE / 'results' / 'merged'
PACK = FLEET / 'llmar-harbor.tar.gz'
ROOTS = ('experiments/deepswe-harbor', 'experiments/codex-deepswe', 'packages/pricing/data')
REQUIREMENTS = HERE / 'driver-requirements.txt'
SHIP_PART_CHARS = 40_000
DRIVER = '$WORK_DIR/repo/experiments/deepswe-harbor/driver.py'
PY = '$WORK_DIR/venv/bin/python'
UNITS = ('llmar-driver', 'llmar-check', 'llmar-prepull', 'llmar-isolation')
ISOLATION = '$WORK_DIR/repo/experiments/deepswe-harbor/isolation.py'
_ACCOUNT_RE = re.compile(r'(?<!\d)\d{12}(?!\d)')
_IID = re.compile(r'^i-[0-9a-f]{8,17}$')
_EXPORT_ID = re.compile(r'^[0-9]+-[0-9a-f]{6}$')


def mask(text: str) -> str:
    return _ACCOUNT_RE.sub('<acct>', text)


def say(msg: str) -> None:
    print(mask(msg), flush=True)


# ---------------------------------------------------------------- AWS (CLI)

class Aws:
    """The aws CLI with the operator's credentials. `run` is injectable for tests."""

    def __init__(self, region: str, exe: str = 'aws', run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
                 sleep: Callable[[float], None] = time.sleep):
        if not re.fullmatch(r'[a-z]{2}(-[a-z]+)+-\d', region or ''):
            raise SystemExit(f'not a Region name: {region!r}')
        self.region, self.exe, self._run, self.sleep = region, exe, run, sleep

    def call(self, *args: str, timeout: float = 120) -> str:
        r = self._run([self.exe, *args, '--region', self.region], capture_output=True, text=True, timeout=timeout)  # nosec B603
        if r.returncode != 0:
            raise RuntimeError(mask(f'aws {args[0]} {args[1] if len(args) > 1 else ""}: {r.stderr.strip()[-400:]}'))
        return r.stdout

    def stack_outputs(self, stack: str) -> dict[str, str]:
        out = json.loads(self.call('cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs', '--output', 'json'))
        return {o['OutputKey']: o['OutputValue'] for o in out or []}

    def send(self, iid: str, script: str, timeout_s: int = 600) -> str:
        if not _IID.match(iid):
            raise ValueError(f'bad instance id {iid!r}')
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump({'commands': [script], 'executionTimeout': [str(int(timeout_s))]}, f)
            params = f.name
        try:
            return self.call('ssm', 'send-command', '--instance-ids', iid, '--document-name', 'AWS-RunShellScript',
                             '--comment', 'llmar deepswe-harbor', '--parameters', f'file://{params}',
                             '--timeout-seconds', '600', '--query', 'Command.CommandId', '--output', 'text').strip()
        finally:
            os.unlink(params)

    def wait(self, cid: str, iid: str, max_wait_s: float, poll_s: float = 2.0) -> tuple[str, str, str]:
        t_end = time.time() + max_wait_s
        status = 'Pending'
        while True:
            try:
                out = json.loads(self.call('ssm', 'get-command-invocation', '--command-id', cid, '--instance-id', iid,
                                           '--query', '[Status,StandardOutputContent,StandardErrorContent]', '--output', 'json'))
                status = out[0]
                if status in ('Success', 'Failed', 'Cancelled', 'TimedOut', 'Cancelling'):
                    return status, out[1] or '', out[2] or ''
            except RuntimeError as e:
                if 'InvocationDoesNotExist' not in str(e):
                    raise
            if time.time() > t_end:
                return status, '', 'gave up waiting'
            self.sleep(poll_s)

    def ssm(self, iid: str, script: str, timeout_s: int = 600) -> tuple[str, str, str]:
        cid = self.send(iid, script, timeout_s)
        return self.wait(cid, iid, timeout_s + 120)

    def s3_get(self, bucket: str, key: str, dest: pathlib.Path) -> None:
        self.call('s3', 'cp', '--only-show-errors', f's3://{bucket}/{key}', str(dest), timeout=3600)


PREAMBLE = """set -euo pipefail
export HOME="${HOME:-/root}"
set -a; . "${LLMAR_ENV_FILE:-/etc/llmar-runner.env}"; set +a
cd "$WORK_DIR"
"""


def script(body: str) -> str:
    return PREAMBLE + body


# ---------------------------------------------------------------- pack and ship

def requirements_text() -> str:
    """driver.py's locked dependencies with hashes (uv export --script --frozen); must match the committed file."""
    r = subprocess.run(['uv', 'export', '--script', str(HERE / 'driver.py'), '--frozen', '--no-header', '--quiet'],  # nosec B603 B607
                       capture_output=True, text=True, timeout=120, cwd=HERE)
    if r.returncode != 0:
        raise SystemExit(f'uv export failed: {r.stderr.strip()[-400:]}')
    return r.stdout


def pack(out: pathlib.Path = PACK, check_requirements: bool = True, profile: profiles.Dataset = profiles.DEEPSWE) -> dict[str, Any]:
    sys.path.insert(0, str(REPO / 'experiments' / 'codex-deepswe'))
    import packing  # codex-deepswe: byte-reproducible tarball of repository roots
    if check_requirements and REQUIREMENTS.read_text() != requirements_text():
        raise SystemExit(f'{REQUIREMENTS.name} is stale: regenerate it with `uv export --script driver.py --frozen --no-header > {REQUIREMENTS.name}`')
    plan_issues = shardplan.validate(json.loads(profile.plan.read_text()))
    if plan_issues:
        raise SystemExit(f'plan.json: {plan_issues[:3]}')
    return packing.build(out, REPO, profile.roots)


BOOTSTRAP = r"""
SHA={sha}
T=/tmp/llmar-harbor.tgz
tr -d '\n' < "$T.b64" | base64 -d > "$T"
echo "$SHA  $T" | sha256sum -c - >/dev/null || {{ echo "sha256 mismatch" >&2; exit 1; }}
bad=$(tar -tvzf "$T" | awk '{{print substr($1,1,1)}}' | grep -v '^[-d]$' || true)
[ -z "$bad" ] || {{ echo "tarball contains links or special files" >&2; exit 1; }}
if tar -tzf "$T" | grep -Ev '^({roots})(/|$)' | grep -q .; then echo "paths outside the packed roots" >&2; exit 1; fi
if tar -tzf "$T" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then echo "absolute or parent paths" >&2; exit 1; fi
umask 077
stage=$(mktemp -d "$WORK_DIR/stage.XXXXXX")
tar -xzf "$T" -C "$stage" --no-same-owner --no-same-permissions
for r in {roots_sp}; do
  mkdir -p "$WORK_DIR/repo/$r"
  find "$WORK_DIR/repo/$r" -mindepth 1 -maxdepth 1 ! -name results ! -name data ! -name bin -exec rm -rf {{}} +
  cp -a "$stage/$r/." "$WORK_DIR/repo/$r/"
done
rm -rf "$stage" "$T.b64"
UV="${{LLMAR_UV:-/usr/local/bin/uv}}"
"$UV" venv --quiet --allow-existing --python "$DRIVER_PYTHON" "$WORK_DIR/venv"
"$UV" pip sync --quiet --python "$WORK_DIR/venv/bin/python" --require-hashes "$WORK_DIR/repo/experiments/deepswe-harbor/driver-requirements.txt"
echo "$SHA" > "$WORK_DIR/repo/.llmar-tarball-sha256"
"$WORK_DIR/venv/bin/python" -I "$WORK_DIR/repo/experiments/deepswe-harbor/driver.py" --help >/dev/null
echo "ready ${{SHA:0:12}} runner $RUNNER_INDEX"
"""


def bootstrap_script(sha: str, roots: tuple[str, ...] = ROOTS) -> str:
    if not re.fullmatch(r'[0-9a-f]{64}', sha):
        raise ValueError('sha256')
    return script(BOOTSTRAP.format(sha=sha, roots='|'.join(re.escape(r) for r in roots), roots_sp=' '.join(roots)))


def ship_scripts(blob: bytes, sha: str, roots: tuple[str, ...] = ROOTS) -> list[str]:
    """The send-command scripts that rebuild the tarball on the runner, then the bootstrap."""
    b64 = base64.b64encode(blob).decode()
    parts = [b64[i:i + SHIP_PART_CHARS] for i in range(0, len(b64), SHIP_PART_CHARS)]
    out = ['rm -f /tmp/llmar-harbor.tgz.b64 /tmp/llmar-harbor.tgz\n']
    out += [f"cat >> /tmp/llmar-harbor.tgz.b64 <<'LLMAR_EOF'\n{p}\nLLMAR_EOF\n" for p in parts]
    out.append(bootstrap_script(sha, roots))
    return out


# ---------------------------------------------------------------- runner commands

def driver_cmd(*args: str, profile: profiles.Dataset | None = None) -> str:
    pre = ('--dataset', profile.name) if profile is not None and not profile.is_default else ()
    return f'{PY} -I {DRIVER} ' + ' '.join(shlex.quote(a) for a in (*pre, *args))


def probe_image(path: pathlib.Path = HERE / 'isolation.py') -> str:
    """isolation.PROBE_IMAGE, read from the source that is shipped (fleet.py stays stdlib-only), pinned by digest."""
    m = re.search(r"^PROBE_IMAGE = '([^']+)'", path.read_text(encoding='utf-8'), re.M)
    if not m or not re.fullmatch(r'[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}', m.group(1)):
        raise SystemExit('isolation.py: PROBE_IMAGE missing or not pinned by digest')
    return m.group(1)


def isolation_cmd(region: str, profile: profiles.Dataset | None = None) -> str:
    """18's isolation suite (4f's isolation.py) on a runner: one real Harbor oracle trial on a probe task, docker
    probes on docker0 and a temporary network, listening sockets, leakscan over its own outputs. No AWS or model
    calls (--region selects the price catalog only). It reuses a running driver's proxy, else starts its own (no
    routes, no token). Exit 0 iff every gate passes; the unit's journal ends with `isolation-exit=<code>`."""
    if not re.fullmatch(r'[a-z]{2}(-[a-z]+)+-\d', region):
        raise ValueError(region)
    if profile is not None and profile.isolation_profile:   # TB: 4f/18's guardrail gates (online mode)
        inner = (f'{PY} -I {ISOLATION} run --where runner --profile {profile.isolation_profile} --env llmar --harbor harbor '
                 f'--region {region} --out $WORK_DIR/{profile.results}/isolation')
    else:   # DeepSWE's suite; a non-default profile (cc-deepswe) writes into its own results dir, never DeepSWE's
        out = 'results' if profile is None or profile.is_default else profile.results
        inner = (f'{PY} -I {ISOLATION} run --where runner --env llmar --harbor harbor --region {region} '
                 f'--out $WORK_DIR/{out}/isolation')
    return f'/bin/sh -c "{inner}; echo isolation-exit=\\$?"'


ISOLATION_SHOW = ('journalctl -u llmar-isolation --no-pager -o cat 2>/dev/null | tail -60 | cut -c1-240 || true\n'
                  'echo "unit: $(systemctl is-active llmar-isolation 2>/dev/null || true)"\n')


def isolation_verdict(journal: str) -> str:
    """PASS / FAIL from the last `isolation-exit=` line of the unit's journal; RUNNING or UNKNOWN otherwise."""
    codes = re.findall(r'^isolation-exit=(\d+)$', journal, re.M)
    if codes:
        return 'PASS' if codes[-1] == '0' else f'FAIL (exit {codes[-1]})'
    return 'RUNNING' if re.search(r'^unit: (active|activating)$', journal, re.M) else 'UNKNOWN'


def unit_cmd(unit: str, *args: str, stop_timeout_s: int = 420, command: str | None = None, profile: profiles.Dataset | None = None) -> str:
    """A detached systemd unit running a driver command, or `command` (survives the SSM command; one per name at a
    time)."""
    if unit not in UNITS:
        raise ValueError(unit)
    return (f'if systemctl is-active --quiet {unit}; then echo "{unit} is already running" >&2; exit 3; fi\n'
            f'systemctl reset-failed {unit} 2>/dev/null || true\n'
            f'systemd-run --unit={unit} --collect --quiet --property=KillMode=mixed --property=TimeoutStopSec={stop_timeout_s} '
            f'--property=LimitCORE=0 --working-directory="$WORK_DIR" --setenv=HOME=/root '
            f'--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin '
            f'{command or driver_cmd(*args, profile=profile)}\n'
            f'sleep 3; systemctl is-active {unit} || {{ journalctl -u {unit} -n 30 --no-pager -o cat; exit 1; }}\n')


def proxy_reserve(path: pathlib.Path = HERE / 'hproxy.py') -> float:
    """hproxy.DEFAULT_RESERVE_USD, read from the source that is shipped (fleet.py stays stdlib-only)."""
    m = re.search(r'^DEFAULT_RESERVE_USD = ([0-9.]+)', path.read_text(encoding='utf-8'), re.M)
    if not m:
        raise SystemExit('hproxy.py: DEFAULT_RESERVE_USD not found')
    return float(m.group(1))


def tb_preflight_caps(profile: profiles.Dataset, passes: list[str], hard_cap: float, reserve: float,
                      shards: list[int] | None = None) -> dict[str, Any]:
    """0d (TB): refuse a start unless, on every runner being started, the proxy reserve < hard cap − the largest
    expected single run of the passes on that runner's shard, so a cap stop can only come from a real overrun. The
    run's planning cost comes from the gitignored plan detail (public weight × the arm's per-run cost at s = 1; B at
    its tier-pass tier). Runners may be started with different caps (`--runners`; 0d's pilot: runner 1 $50/$65)."""
    detail_p = profile.dev_results / 'plan-detail.json'
    strata_p = profile.dev_results / 'tierpass' / 'strata.json'
    if not detail_p.exists() or not strata_p.exists():
        raise SystemExit(f'pre-flight: {detail_p.name} and tierpass/strata.json are needed under {profile.dev_results} (shardplan build-tb)')
    plan = shardplan.load_plan(profile.plan)
    detail, tiers = json.loads(detail_p.read_text()), shardplan.load_tiers(strata_p)
    per = {}
    for s in (shards if shards is not None else range(plan['n_shards'])):
        biggest = shardplan.max_run_usd(plan, detail, passes, shard=s, tiers=tiers)
        if not reserve < hard_cap - biggest:
            raise SystemExit(f'pre-flight: runner {s}: proxy reserve ${reserve:g} is not below hard cap ${hard_cap:g} − the largest '
                             f'expected run ${biggest:.2f} of {passes}: raise --hard-cap')
        per[str(s)] = biggest
    return {'largest_run_usd': per, 'reserve_usd': reserve, 'hard_cap_usd': hard_cap}


def start_args(a: argparse.Namespace) -> list[str]:
    if not a.gateway_url.startswith('https://'):
        raise SystemExit('--gateway-url must be https://')
    import driver
    issues = driver.check_caps(a.hard_cap, proxy_reserve(), a.soft_cap)
    if issues:
        raise SystemExit('caps: ' + '; '.join(issues))
    prof = getattr(a, 'profile', None)
    if prof is not None and not prof.is_default and prof.agent == 'codex':
        say('pre-flight: ' + json.dumps(tb_preflight_caps(prof, a.passes, a.hard_cap, proxy_reserve(), getattr(a, 'shards', None))))
    args = ['run', '--gateway-url', a.gateway_url, '--region', a.region, '--concurrency', str(a.concurrency),
            '--soft-cap', f'{a.soft_cap:g}', '--hard-cap', f'{a.hard_cap:g}', '--secret-id', a.secret_id]
    for p in a.passes:
        args += ['--pass', p]
    if a.max_blocks is not None:
        args += ['--max-blocks', str(a.max_blocks)]
    if a.change_concurrency:
        args.append('--change-concurrency')
    if a.unstop_cap:
        args.append('--unstop-cap')
    if getattr(a, 'token_max_age_s', None):
        args += ['--token-max-age-s', f'{a.token_max_age_s:g}']
    return args


# ---------------------------------------------------------------- Claude Code: caps, budget (CC design §3)

def cc_budget_path(profile: profiles.Dataset) -> pathlib.Path:
    """budget.json, shared by both Claude Code benchmarks (gitignored): schema cc-budget/v1, total_usd, outside_usd."""
    return profile.dev_results.parent / 'budget.json'


def cc_committed_path(profile: profiles.Dataset) -> pathlib.Path:
    return profile.dev_results / 'caps-committed.json'


def cc_profiles() -> list[profiles.Dataset]:
    return [p for p in profiles.PROFILES.values() if p.agent == 'claude-code']


def cc_committed_all() -> dict[str, dict[str, Any]]:
    import ccproject
    return {p.name: ccproject.load_committed(cc_committed_path(p)) for p in cc_profiles()}


def cc_load(profile: profiles.Dataset) -> tuple[dict[str, Any], dict[str, Any]]:
    detail_p = profile.dev_results / 'plan-detail.json'
    if not detail_p.exists():
        raise SystemExit(f'{detail_p} is needed (shardplan.py --agent claude-code --dataset {profile.base} derive)')
    return shardplan.load_plan(profile.plan), json.loads(detail_p.read_text())


CC_PRIOR = {'m': 1.0, 'tau': 1.0}   # `project --prior-m/--prior-tau` (0d's m; Claude Code vs Codex time) until a pilot is measured


def cc_borrow(profile: profiles.Dataset) -> dict[str, Any] | None:
    """The other Claude Code benchmark's own κ/τ (no borrowing), if its plan and detail exist."""
    import ccproject
    for other in cc_profiles():
        if other.name != profile.name and (other.dev_results / 'plan-detail.json').exists() and other.plan.exists():
            op, od = cc_load(other)
            oa, of, _ = ccproject.load_merged(other.dev_results / 'merged')
            return ccproject.ratios(op, od, oa, of, prior_m=CC_PRIOR['m'], prior_tau=CC_PRIOR['tau'])
    return None


def cc_ratios(profile: profiles.Dataset, plan: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any]:
    """κ/τ for a benchmark; an arm without enough of its own runs borrows the other benchmark's measured value."""
    import ccproject
    att, finals, _ = ccproject.load_merged(profile.dev_results / 'merged')
    return ccproject.ratios(plan, detail, att, finals, borrow=cc_borrow(profile), prior_m=CC_PRIOR['m'], prior_tau=CC_PRIOR['tau'])


def cc_settled(fl: Fleet) -> dict[str, Any]:
    """Live per-runner ledger state from `driver.py status` (read-only): settled spend, cap, driver alive."""
    def one(i: int, iid: str) -> dict[str, Any]:
        st, out, err = fl.run(i, iid, driver_cmd('status', profile=fl.profile), 120)
        if st != 'Success':
            raise SystemExit(f'runner {i}: status {st}: {(err or out).strip()[-300:]}')
        doc = json.loads(out.strip().splitlines()[-1])
        ps = doc.get('proxy_state') or {}
        return {'settled_usd': float(ps.get('settled_usd') or 0.0), 'cap_usd': ps.get('cap_usd'), 'driver_alive': bool(doc.get('driver_alive')),
                'state': doc.get('state')}
    return {str(i): v for i, v in fl.each(one).items()}


def cc_call_ceiling(region: str | None) -> Callable[[str], float]:
    """cc_pricing.call_ceiling on the Region's bundled price catalog (the one hproxy prices with on the runners)."""
    if not region:
        raise SystemExit('--region <region> (or AWS_REGION) is needed: the in-flight allowance is priced from the Region\'s catalog')
    set_experiment_region(region)
    import cc_pricing
    return cc_pricing.call_ceiling


def cc_preflight(profile: profiles.Dataset, passes: list[str], caps: dict[str, dict[str, float]], live: dict[str, Any],
                 reserve: float, budget: dict[str, Any], committed: dict[str, dict[str, Any]], *, concurrency: int,
                 call_ceiling: Callable[[str], float]) -> dict[str, Any]:
    """Refuses a Claude Code start unless, for every runner being started, the caps pass the driver's checks,
    hard − settled − reserve > the in-flight allowance at this start's concurrency + the largest κ-priced single run
    of the passes on its shard, and soft ≤ hard − reserve − the in-flight allowance (ccproject.inflight_allowance:
    hproxy reserves every in-flight call's worst case against hard − reserve); and the global budget holds with the
    new hard caps (ccproject.global_preflight). Caps written without the in-flight term are refused here."""
    import ccproject
    import driver
    plan, detail = cc_load(profile)
    rat = cc_ratios(profile, plan, detail)
    infl = ccproject.inflight_allowance(plan, passes, concurrency, call_ceiling)
    issues, per = [], {}
    for r in sorted(live, key=int):
        c = caps.get(r)
        if c is None:
            issues.append(f'runner {r}: not in the caps file')
            continue
        issues += [f'runner {r}: {x}' for x in driver.check_caps(c['hard'], reserve, c['soft'])]
        biggest = max((trial_usd for p in passes for it in shardplan.trials_of(plan, p, int(r))
                       for trial_usd in [ccproject.trial_usd(plan, detail, rat, it['task'], it['arm'])]), default=0.0)
        room = c['hard'] - float(live[r]['settled_usd']) - reserve
        if not room > biggest + infl['usd']:
            issues.append(f'runner {r}: hard ${c["hard"]:g} − settled ${live[r]["settled_usd"]:.2f} − reserve ${reserve:g} = ${room:.2f} '
                          f'is not above the largest expected run ${biggest:.2f} + the in-flight allowance ${infl["usd"]:.2f} '
                          f'(concurrency {concurrency})')
        if c['soft'] > c['hard'] - reserve - infl['usd'] + 1e-9:
            issues.append(f'runner {r}: soft ${c["soft"]:g} leaves less than the in-flight allowance ${infl["usd"]:.2f} below hard '
                          f'${c["hard"]:g} − reserve ${reserve:g} (re-run `project --caps-for`)')
        per[r] = {'settled_usd': round(float(live[r]['settled_usd']), 2), 'largest_run_usd': round(biggest, 2), **c}
    g = ccproject.global_preflight(budget, profile.name, {r: caps[r] for r in live if r in caps}, committed)
    if not g['ok']:
        issues.append(f"budget: exposure ${g['total_usd']:.2f} (ledgers {g['exposure_usd']} + outside ${g['outside_usd']:.2f}) "
                      f"> ${g['budget_usd']:.2f}")
    if issues:
        raise SystemExit('pre-flight: ' + '; '.join(issues))
    return {'runners': per, 'budget': g, 'kappa_source': {a: v['source'] for a, v in rat.items()}, 'inflight': infl}


def cc_start(fl: Fleet, a: argparse.Namespace) -> dict[int, str]:
    """Claude Code `start`: per-runner caps from --caps-file, the per-runner and global pre-flight on live ledger
    state, one unit command per runner, then the started runners' caps recorded as committed (budget exposure)."""
    import ccproject
    prof = a.profile
    if not a.caps_file:
        raise SystemExit('--caps-file is required for Claude Code (write one with `fleet.py --agent claude-code project --caps-for …`)')
    caps = ccproject.load_caps(pathlib.Path(a.caps_file), prof.name, a.passes)
    basis = json.loads(pathlib.Path(a.caps_file).read_text()).get('basis') or {}
    CC_PRIOR.update(m=float(basis.get('prior_m') or 1.0), tau=float(basis.get('prior_tau') or 1.0))   # the caps' own prior
    live = cc_settled(fl)
    pf = cc_preflight(prof, a.passes, caps, live, proxy_reserve(), ccproject.load_budget(cc_budget_path(prof)), cc_committed_all(),
                      concurrency=a.concurrency, call_ceiling=cc_call_ceiling(a.region))
    say('pre-flight: ' + json.dumps(pf))

    def one(i: int, iid: str) -> str:
        ai = argparse.Namespace(**{**vars(a), 'soft_cap': caps[str(i)]['soft'], 'hard_cap': caps[str(i)]['hard']})
        extra = ['--router-policy-version', a.router_policy_version] if a.router_policy_version else []
        st, out, err = fl.run(i, iid, unit_cmd('llmar-driver', *start_args(ai), *extra, profile=prof))
        return (out.strip().splitlines() or [''])[-1] if st == 'Success' else f'FAILED ({st}): {(err or out).strip()[-500:]}'
    res = fl.each(one)
    started = {str(i): caps[str(i)] for i, r in res.items() if not str(r).startswith('FAILED')}
    path = cc_committed_path(prof)
    path.parent.mkdir(parents=True, exist_ok=True)
    shardplan.write_json(path, ccproject.commit_caps(ccproject.load_committed(path), started, a.passes, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
    return res


def cc_requeue(fl: Fleet, path: pathlib.Path) -> dict[int, str]:
    """Claude Code `requeue`: merged/requeue.json (written by `merge --router-logs`) → `driver.py requeue` on each
    runner it names. Counts only; no outcome."""
    if not path.exists():
        raise SystemExit(f'{path}: run `merge --router-logs …` first')
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema') != 'cc-requeue/v1':
        raise SystemExit(f'{path.name}: schema {doc.get("schema")!r}')

    def one(i: int, iid: str) -> str:
        ids = [str(x['trial_id']) for x in (doc.get('runners') or {}).get(str(i), [])]
        if not ids:
            return 'nothing to requeue'
        st, out, err = fl.run(i, iid, driver_cmd('requeue', '--why', str(doc['why']), *[y for t in ids for y in ('--trial-id', t)],
                                                 profile=fl.profile), 300)
        return (out.strip().splitlines() or [''])[-1] if st == 'Success' else f'FAILED ({st}): {(err or out).strip()[-500:]}'
    return fl.each(one)


def cc_project_cli(prof: profiles.Dataset, a: argparse.Namespace) -> dict[str, Any]:
    """Claude Code `project` (outcome-blind): this benchmark's κ/τ, projection, pilot report and (with --caps-for) a
    caps file; plus the whole experiment's projection against budget.json (stop and ask if it is over)."""
    import ccproject
    plan, detail = cc_load(prof)
    CC_PRIOR.update(m=a.prior_m, tau=a.prior_tau)
    role_table = None
    if a.role_table:
        if not a.role_table_sha256:
            raise SystemExit('--role-table needs --role-table-sha256 (the hash recorded in design-stats §13)')
        role_table = ccproject.load_role_table(pathlib.Path(a.role_table), a.role_table_sha256)
    caps_for = [x for x in (a.caps_for or '').split(',') if x]
    unknown = [x for x in caps_for if x not in plan['passes']]
    if unknown:
        raise SystemExit(f'--caps-for: unknown passes {unknown}')
    conc = a.concurrency or prof.max_concurrency
    infl = ccproject.inflight_allowance(plan, caps_for, conc, cc_call_ceiling(a.region)) if caps_for else None
    doc = ccproject.project_cc(plan, detail, prof.dev_results / 'merged', concurrency=conc,
                               reserve=proxy_reserve(), caps_for=caps_for or None, borrow=cc_borrow(prof),
                               report_passes=[x for x in (a.report_passes or '').split(',') if x] or None,
                               plan_sha256=hashlib.sha256(prof.plan.read_bytes()).hexdigest(), role_table=role_table,
                               prior_m=a.prior_m, prior_tau=a.prior_tau, inflight=infl)
    total = 0.0
    per: dict[str, float | None] = {}
    for p in cc_profiles():
        if not ((p.dev_results / 'plan-detail.json').exists() and p.plan.exists()):
            per[p.name] = None
            continue
        pp, pd = cc_load(p)
        att, finals, dropped = ccproject.load_merged(p.dev_results / 'merged')
        rat = cc_ratios(p, pp, pd)
        v = ccproject.projection(pp, pd, att, finals, dropped, rat, p.max_concurrency)['projected_usd']
        per[p.name], total = v, total + v
    bp = cc_budget_path(prof)
    budget = ccproject.load_budget(bp) if bp.exists() else None
    outside = round(sum(float(v) for v in ((budget or {}).get('outside_usd') or {}).values()), 2)
    doc['experiment'] = {'projected_usd_by_benchmark': per, 'outside_usd': outside, 'projected_total_usd': round(total + outside, 2),
                         'budget_usd': (budget or {}).get('total_usd'),
                         'within_budget': None if budget is None else total + outside <= float(budget['total_usd']),
                         'note': 'over budget: stop and ask 0c (do not cut runs)' if budget and total + outside > float(budget['total_usd']) else None}
    rep, pre = doc['report'], doc['preconditions']
    rate = max((v['rate_429'] or 0.0 for v in rep.values()), default=0.0)
    psi = max((float(v['psi_max'].get('psi_memory_some') or 0.0) for v in rep.values()), default=0.0)
    host_oom = sum(v['oom']['host_oom_trials'] for v in rep.values())
    doc['gate'] = {   # CC design §1.3/§2.3 and 0d §4.2: every item must hold before main; the numbers, never an outcome
        'preconditions_ok': pre['ok'], 'preconditions_missing': pre['missing'],
        'rate_429_max': rate, 'rate_429_ok': rate <= 0.01, 'psi_memory_some_max': psi, 'host_oom_trials': host_oom,
        'memory_ok': psi <= 0.05 and host_oom == 0, 'within_budget': doc['experiment']['within_budget'],
        'cc_result_missing': sum(v['cc_result_missing'] for v in rep.values())}
    doc['gate']['ok'] = bool(pre['ok'] and doc['gate']['rate_429_ok'] and doc['gate']['memory_ok'] and doc['gate']['within_budget'])
    if caps_for:
        out = prof.dev_results / f"caps-{'+'.join(caps_for)}.json"
        shardplan.write_json(out, ccproject.caps_doc(prof.name, caps_for, {r: {'soft': c['soft'], 'hard': c['hard']} for r, c in doc['caps']['runners'].items()},
                                                      basis={'kappa': {k: [v['kappa'], v['source']] for k, v in doc['ratios'].items()},
                                                             'margin': ccproject.CAP_MARGIN, 'reserve_usd': proxy_reserve(),
                                                             'prior_m': a.prior_m, 'prior_tau': a.prior_tau,
                                                             'concurrency': conc, 'inflight_usd': infl['usd'] if infl else 0.0,
                                                             'call_ceiling_usd': infl['call_ceiling_usd'] if infl else {}}))
        doc['caps']['file'] = str(out)
    return doc


def cc_budget_cli(prof: profiles.Dataset, fl: Fleet | None, close: bool) -> dict[str, Any]:
    """Claude Code `budget`: every ledger's exposure against budget.json; --close records this benchmark's live
    settled spend as final (every runner's driver must be stopped)."""
    import ccproject
    if close:
        assert fl is not None
        live = cc_settled(fl)
        alive = [r for r, v in live.items() if v['driver_alive']]
        if alive:
            raise SystemExit(f'budget --close: the driver still runs on runners {alive}; stop and wait for run-end first')
        path = cc_committed_path(prof)
        shardplan.write_json(path, ccproject.close_caps(ccproject.load_committed(path), {r: v['settled_usd'] for r, v in live.items()},
                                                        time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
    committed = cc_committed_all()
    g = ccproject.global_preflight(ccproject.load_budget(cc_budget_path(prof)), prof.name, {}, committed)
    return {**g, 'committed': committed}


# ---------------------------------------------------------------- fetch

def safe_extract(blob: bytes, dest: pathlib.Path) -> list[str]:
    """Unpacks an export tarball into `dest`. Only regular files under results/, with no absolute paths, no '..',
    no links or devices. The data filter also refuses anything unsafe. Extraction goes to a fresh staging dir
    first, then the files are moved into place."""
    stage = pathlib.Path(tempfile.mkdtemp(prefix='.fetch-', dir=dest.parent))
    names: list[str] = []
    try:
        import io
        with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as tar:
            members = tar.getmembers()
            for m in members:
                n = m.name
                if not m.isfile() or n.startswith('/') or '..' in pathlib.PurePosixPath(n).parts or not n.startswith('results/'):
                    raise ValueError(f'refusing tar member {n!r}')
            tar.extractall(stage, members=members, filter='data')
            names = [m.name for m in members]
        for n in names:
            src, dst = stage / n, dest / n
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return names


class Fleet:
    def __init__(self, aws: Aws | None, instances: list[str], runners: list[int] | None = None, bucket: str | None = None,
                 out: pathlib.Path = FLEET, profile: profiles.Dataset = profiles.DEEPSWE):
        self.aws, self.instances, self.bucket, self.out, self.profile = aws, instances, bucket, out, profile
        self.runners = runners if runners is not None else list(range(len(instances)))
        for i in self.runners:
            if not 0 <= i < len(instances):
                raise SystemExit(f'runner {i} is not in 0..{len(instances) - 1}')

    def each(self, fn: Callable[[int, str], Any], parallel: bool = True) -> dict[int, Any]:
        if not parallel:
            return {i: fn(i, self.instances[i]) for i in self.runners}
        with cf.ThreadPoolExecutor(max_workers=max(1, len(self.runners))) as pool:
            futs = {i: pool.submit(fn, i, self.instances[i]) for i in self.runners}
            return {i: f.result() for i, f in futs.items()}

    def run(self, i: int, iid: str, body: str, timeout_s: int = 600) -> tuple[str, str, str]:
        assert self.aws is not None
        return self.aws.ssm(iid, script(body), timeout_s)

    # ------------------------------------------------------------ ship
    def ship(self, blob: bytes, sha: str) -> dict[int, str]:
        steps = ship_scripts(blob, sha, self.profile.roots)

        def one(i: int, iid: str) -> str:
            assert self.aws is not None
            for s in steps[:-1]:
                st, _, err = self.aws.ssm(iid, s, 120)
                if st != 'Success':
                    return f'FAILED upload ({st}): {err[-300:]}'
            st, out, err = self.aws.ssm(iid, steps[-1], 1800)
            return out.strip().splitlines()[-1] if st == 'Success' and out.strip() else f'FAILED bootstrap ({st}): {(err or out)[-600:]}'
        return self.each(one)

    # ------------------------------------------------------------ fetch
    def state_path(self, i: int) -> pathlib.Path:
        return self.out / f'runner-{i}' / 'fetch-state.json'

    def fetch(self, mode: str, full_refetch: bool = False) -> dict[int, Any]:
        def one(i: int, iid: str) -> dict[str, Any]:
            assert self.aws is not None
            sp = self.state_path(i)
            state = json.loads(sp.read_text()) if sp.exists() else {}
            base = None if full_refetch else (state.get(mode) or {}).get('last')
            args = ['export', '--mode', mode] + (['--base', base] if base else []) + (['--s3-bucket', self.bucket] if mode == 'full' else [])
            if mode == 'full' and not self.bucket:
                raise SystemExit('--mode full needs --s3-bucket (or the stack output ResultsBucketName)')
            st, out, err = self.run(i, iid, driver_cmd(*args, profile=self.profile), 3600)
            if st != 'Success':
                return {'error': f'export {st}: {(err or out)[-400:]}'}
            info = json.loads(out.strip().splitlines()[-1])
            eid = info['export_id']
            if not _EXPORT_ID.match(eid):
                raise ValueError('bad export id from runner')
            if manifest_dataset(info) != self.profile.name:
                return {'error': f'export {eid} is for dataset {manifest_dataset(info)!r}, not {self.profile.name}'}
            dest = self.out / f'runner-{i}'
            dest.mkdir(parents=True, exist_ok=True)
            if mode == 'full':
                with tempfile.TemporaryDirectory(dir=dest) as td:
                    self.aws.s3_get(self.bucket or '', f"{info['s3_key']}/payload.tar.gz", pathlib.Path(td) / 'p.tgz')
                    self.aws.s3_get(self.bucket or '', f"{info['s3_key']}/manifest.json", pathlib.Path(td) / 'm.json')
                    blob = (pathlib.Path(td) / 'p.tgz').read_bytes()
                    manifest = json.loads((pathlib.Path(td) / 'm.json').read_text())
            else:
                chunks = []
                for n in range(int(info['parts'])):
                    st, part, err = self.run(i, iid, driver_cmd('export-part', '--id', eid, '--part', str(n), profile=self.profile), 120)
                    if st != 'Success':
                        return {'error': f'part {n}: {st} {err[-200:]}'}
                    chunks.append(part.strip())
                blob = base64.b64decode(''.join(chunks))
                manifest = None
            got = hashlib.sha256(blob).hexdigest()
            if got != info['tar_sha256'] or (manifest and manifest.get('tar_sha256') != got):
                return {'error': f'sha256 mismatch for export {eid}'}
            names = safe_extract(blob, dest)
            if manifest:
                (dest / 'exports').mkdir(exist_ok=True)
                (dest / 'exports' / f'{eid}.json').write_text(json.dumps(manifest))
            state[mode] = {'last': eid, 'at': time.time(), 'files': len(names)}
            sp.write_text(json.dumps(state, indent=1))
            return {'export_id': eid, 'files': len(names), 'bytes': len(blob), 'skipped': info.get('skipped'), 'blocked': info.get('blocked')}
        return self.each(one)


def manifest_dataset(info: dict[str, Any]) -> str:
    return str(info.get('dataset') or 'deepswe')


# ---------------------------------------------------------------- merge

TB_ROW_META = ('group', 'category', 'difficulty', 'agent_timeout_s', 'verifier_timeout_s', 'cpus', 'memory_mb')
CC_ROUTER_KEYS = ('requests', 'model_requests', 'expected_model_requests', 'complete', 'served_models', 'lineages', 'statuses', 'assessor_tier',
                  'assessor_consults', 'assessor_status')


def _routerlogs() -> Any:
    """codex-deepswe's routerlogs (hcommon puts codex-deepswe on sys.path)."""
    import importlib
    importlib.import_module('hcommon')
    return importlib.import_module('routerlogs')


def cc_router_join(records: list[dict[str, Any]], proxy_calls: dict[str, int]) -> dict[str, dict[str, Any]]:
    """routerlogs.join (x-router-session = trial id) over the fetched router log records."""
    return _routerlogs().join(records, list(proxy_calls), proxy_gateway_calls=proxy_calls)


def load_router_logs(path: pathlib.Path) -> list[dict[str, Any]]:
    return _routerlogs().parse(path.read_text(encoding='utf-8'))


def cc_refusal_evidence(calls: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """classify.refusal_evidence per trial id, from one runner's proxy call records."""
    import classify as clf
    by: dict[str, list[dict[str, Any]]] = {}
    for c in calls:
        by.setdefault(str(c.get('trial_id')), []).append(c)
    return {t: clf.refusal_evidence(cs) for t, cs in by.items()}


_FALLBACK_MODEL_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,79}')
_REFUSAL_CATEGORY_RE = re.compile(r'[a-z][a-z_-]{0,23}')


def cc_fallback_event(trial_dir: str | None) -> dict[str, Any]:
    """S6 descriptives (0d §18 item 7), never part of the rule: Claude Code's stream-json `system`/`model_refusal_fallback`
    event in agent/claude-code.txt, when the transcript was exported (a leakscan-blocked one is not): its fallback_model
    and api_refusal_category, each kept only if it is a plain identifier. None when absent."""
    out: dict[str, Any] = {'refusal_fallback_model': None, 'refusal_category': None}
    p = pathlib.Path(trial_dir) / 'agent' / 'claude-code.txt' if trial_dir else None
    if p is None or not p.is_file():
        return out
    with open(p, encoding='utf-8', errors='replace') as f:
        for line in f:
            if 'model_refusal_fallback' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict) and e.get('type') == 'system' and e.get('subtype') == 'model_refusal_fallback':
                fm, cat = e.get('fallback_model'), e.get('api_refusal_category')
                out['refusal_fallback_model'] = fm if isinstance(fm, str) and _FALLBACK_MODEL_RE.fullmatch(fm) else None
                out['refusal_category'] = cat if isinstance(cat, str) and _REFUSAL_CATEGORY_RE.fullmatch(cat) else None
                break
    return out


def cc_refusal_rows(rows: list[dict[str, Any]], ends: list[dict[str, Any]], final: dict[str, Any] | None,
                    evidence: dict[str, dict[str, Any]], runner: int) -> dict[str, Any] | None:
    """0d design-stats §18 (Amendment 9), post hoc for one key (`rows` in attempt order, `ends` their end events).
    An attempt meeting classify.refusal_fallback_blocked (its call records; M_arm = the arm's pinned main model) is
    reclassed sut / score_zero, reason refusal_fallback_blocked (classify.refusal_fallback_outcome; the recorded
    classification under `reclassified_from`). The first such attempt reached through reruns only is the key's final,
    scored; every later attempt is superseded (`superseded_by`): never scored, its cost in total spend only, never in
    a per-run estimand. Returns the key's final record: the driver's, or the rewritten one (the replaced final under
    `reclassified_from`). Reward-blind: the reward is carried, never read."""
    import classify as clf
    first = None
    for n, (row, end) in enumerate(zip(rows, ends)):
        m = row.get('main_model') if row.get('main_model') not in (None, 'auto') else None
        if not clf.refusal_fallback_blocked(evidence.get(str(row.get('trial_id'))), m):
            continue
        if not (row.get('class') == 'sut' and row.get('reason') == clf.REFUSAL_FALLBACK):
            rf = clf.refusal_fallback_outcome({k: row.get(k) for k in ('class', 'action', 'reason', 'reward', 'exception_type', 'tags')},
                                              killed=end.get('killed'), host=end.get('host'), fallback=int(row.get('gateway_fallback_calls') or 0))
            if rf is None:
                row['refusal_fallback'] = 'matched, not reclassed'
                continue
            row.update({k: rf[k] for k in ('class', 'action', 'reason', 'score', 'reclassified_from')})
        row['refusal_fallback'] = 'sut'
        row.update(cc_fallback_event(row.get('trial_dir')))
        if first is None and all(r.get('action') == 'rerun' for r in rows[:n]):
            first = n
    if first is None:
        return final
    j = rows[first]
    later = rows[first + 1:]
    for r in later:
        r['superseded_by'] = j['trial_id']
    for r in rows:
        r['is_final'], r['final_status'] = r['trial_id'] == j['trial_id'], 'scored'
    ver = ends[first].get('verifier')
    new = {'runner': runner, **(final or {'ev': 'final'}), 'key': j['key'], **{x: j.get(x) for x in ('pass', 'phase', 'block', 'task', 'arm', 'rep')},
           'status': 'scored', 'trial_id': j['trial_id'], 'class': j['class'], 'score': j['score'], 'reason': j['reason'],
           'attempts': first + 1, 'reruns': first, 'reverifies': sum(int(r.get('reverifies') or 0) for r in rows[:first + 1]),
           'verifier_ran': j.get('verifier_s') is not None, 'tests_ran': (ver or {}).get('tests_ran') if isinstance(ver, dict) else None}
    if final and (final.get('trial_id'), final.get('status'), final.get('class')) != (new['trial_id'], new['status'], new['class']):
        new['reclassified_from'] = {k: final.get(k) for k in ('status', 'trial_id', 'class', 'reason', 'attempts')}
    if later:
        new['superseded'] = [r['trial_id'] for r in later]
    return new


def cc_refusal_summary(attempts: list[dict[str, Any]], finals: list[dict[str, Any]]) -> dict[str, Any]:
    """merged summary.json `refusal_fallback` (0d §18): counts, keys, superseded attempts and their spend, and per
    scored final whether its verifier ran (yes/no; sensitivity b). Never a reward or a score."""
    import classify as clf
    sut = [r for r in attempts if r.get('refusal_fallback') == 'sut']
    sup = [r for r in attempts if r.get('superseded_by')]
    fin = [f for f in finals if f.get('class') == 'sut' and f.get('reason') == clf.REFUSAL_FALLBACK]
    by_arm: dict[str, int] = {}
    for f in fin:
        by_arm[str(f.get('arm'))] = by_arm.get(str(f.get('arm')), 0) + 1
    per_key: dict[str, dict[str, Any]] = {}
    for r in sut:   # per (task, arm) pair: the first exported transcript among its attempts
        k = per_key.setdefault(str(r['key']), {'arm': str(r.get('arm')), 'model': None, 'category': None})
        k['model'] = k['model'] or r.get('refusal_fallback_model')
        k['category'] = k['category'] or r.get('refusal_category')
    fallback: dict[str, dict[str, int]] = {}
    for k in per_key.values():
        d = fallback.setdefault(k['arm'], {})
        name = f"{k['model'] or 'not exported'} ({k['category'] or '?'})"
        d[name] = d.get(name, 0) + 1
    return {'rule': 'design-stats §18 (Amendment 9)', 'classify_version': clf.VERSION, 'attempts': len(sut),
            'matched_not_reclassed': sum(1 for r in attempts if r.get('refusal_fallback') == 'matched, not reclassed'),
            'keys': sorted(f['key'] for f in fin), 'keys_by_arm': by_arm,
            'fallback_model_by_arm': fallback, 'superseded_attempts': len(sup), 'superseded_spent_usd': round(sum(float(r.get('spent_usd') or 0.0) for r in sup), 6),
            'finals': [{'key': f['key'], 'trial_id': f['trial_id'], 'verifier_ran': f.get('verifier_ran'), 'tests_ran': f.get('tests_ran')}
                       for f in sorted(fin, key=lambda x: x['key'])]}


def merge(fleet_dir: pathlib.Path = FLEET, out: pathlib.Path = MERGED, plan_path: pathlib.Path = shardplan.PLAN,
          tasks_dir: pathlib.Path | None = None, tiers: dict[str, str] | None = None,
          router_records: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """One dataset from the fetched runner mirrors:
    - attempts.jsonl: one row per attempt, with plan metadata, class and proxy summary;
    - final.jsonl: one row per (pass, task, arm, rep) with its final status;
    - harvest-meta.jsonl and calls.jsonl: the input of 4f's harvest;
    - checks.json: oracle/null verdicts and the drop list;
    - summary.json."""
    import driver as drv
    plan = shardplan.load_plan(plan_path)
    cc = (plan.get('dataset') or {}).get('agent') == 'claude-code'
    tb = plan.get('schema') == shardplan.TB_SCHEMA or (cc and plan['dataset'].get('base') == 'tb21')
    cc_labels = {(pn, t): sorted(lab for lab, ts in (pp.get('labels') or {}).items() if t in ts)
                 for pn, pp in plan['passes'].items() for ts in (pp.get('labels') or {}).values() for t in ts} if cc else {}
    tb_states: list[dict[str, Any]] = []
    out.mkdir(parents=True, exist_ok=True)
    attempts, finals, meta, calls = [], [], [], []
    calls_void: list[dict[str, Any]] = []
    voids: dict[str, list[dict[str, Any]]] = {}
    checks: dict[str, Any] = {'tasks': {}, 'dropped': [], 'unresolved': []}
    per_runner: dict[str, Any] = {}
    for rdir in sorted(fleet_dir.glob('runner-*')):
        m = re.fullmatch(r'runner-(\d+)', rdir.name)
        if not m:
            continue
        i = int(m.group(1))
        res = rdir / 'results'
        events = drv.read_jsonl(res / 'attempts.jsonl')
        passes = list(plan['passes'])
        items = [it for p in passes for it in shardplan.trials_of(plan, p, i)]
        st = drv.replay(events, items)
        if tb:
            tb_states.append(st)
        vd = drv.voided(events) if cc else {}
        if vd:   # driver.py void-pass: the forgotten attempts' calls go to calls-void.jsonl, not to the gates or harvest
            voids.setdefault(str(i), []).extend({k: e.get(k) for k in ('passes', 'reason', 'keys', 'attempts', 'spent_usd', 'at')}
                                                for e in events if e.get('ev') == 'void')
        for ev in events:
            if ev.get('ev') == 'run-start':
                per_runner.setdefault(str(i), {}).setdefault('runs', []).append({k: ev.get(k) for k in ('at', 'passes', 'concurrency', 'soft_cap', 'max_blocks')})
        if cc and (res / 'run-config.json').exists():   # the stage-continuity fields of the runner's last run
            rc = json.loads((res / 'run-config.json').read_text())
            per_runner.setdefault(str(i), {})['run_config'] = {k: rc.get(k) for k in ('plan_sha256', 'agent_pin', 'router_policy_version', 'concurrency',
                                                                                      'soft_cap_usd', 'hard_cap_usd', 'passes')}
        runner_calls = drv.read_jsonl(res / 'proxy' / 'calls.jsonl')
        evidence = cc_refusal_evidence(runner_calls) if cc else {}
        for k, ks in st.items():
            if not ks.attempts:
                continue
            key_rows: list[dict[str, Any]] = []
            for a in ks.attempts:
                outc = a.outcome or {}
                end = a.end or {}
                px = end.get('proxy') or {}
                last_rv = a.reverifies[-1] if a.reverifies else None
                row = {'runner': i, 'shard': plan['tasks'].get(str(ks.item.get('task')), {}).get('shard'), 'key': k,
                       'plan_sha256': a.start.get('plan_sha256'), **{x: ks.item.get(x) for x in ('pass', 'phase', 'block', 'task', 'arm', 'rep')},
                       'attempt': a.n, 'trial_id': a.trial_id, 'rerun_of': a.start.get('rerun_of'),
                       'class': outc.get('class'), 'action': outc.get('action'), 'reason': outc.get('reason'), 'score': outc.get('score'),
                       'reward': outc.get('reward'), 'exception_type': outc.get('exception_type'), 'killed': end.get('killed'),
                       'reverifies': len(a.reverifies), 'is_final': bool(ks.final and ks.final.get('trial_id') == a.trial_id),
                       'final_status': (ks.final or {}).get('status'),
                       'spent_usd': px.get('spent_usd'), 'calls': px.get('calls'), 'throttled': px.get('throttled'),
                       'statuses': px.get('statuses'), 'error_origins': px.get('error_origins'), 'last_call': px.get('last_call'),
                       'cap_stopped': px.get('cap_stopped'), 'served_models': px.get('served_models'),
                       'token_remints': px.get('token_remints'),
                       'wall_s': end.get('wall_s'), 'agent_s': end.get('agent_s'), 'verifier_s': end.get('verifier_s'),
                       'patch_bytes': end.get('patch_bytes'), 'host': end.get('host'),
                       'job_name': (last_rv or {}).get('job_name') or a.trial_id, 'agent_job_name': a.trial_id,
                       'trial_dir': str(res / end['trial_dir']) if end.get('trial_dir') else None,
                       'pred_tier': (tiers or {}).get(ks.item.get('task') or '')}
                if cc:   # CC design §2.3/§2.4, 0d design-stats §11 (Amendment 2): call classes, memory, OOM tags, the result event
                    row.update({'calls_by_role': px.get('calls_by_role'), 'sanitized_requests': px.get('sanitized_requests'), 'tags': outc.get('tags') or [], 'cc': end.get('cc'),
                                'gateway_fallback_calls': px.get('gateway_fallback_calls'), 'pinned_calls': px.get('pinned_calls'),
                                'pin_served_other': px.get('pin_served_other'),
                                'forwarded_calls': int(px.get('calls') or 0) - sum(int(v or 0) for v in (px.get('refused') or {}).values()),
                                'reclass': (a.reclass or {}).get('why'),
                                'mem': (end.get('host') or {}).get('mem'), 'started_at': a.start.get('at'),
                                'main_model': (plan['arms'].get(str(ks.item.get('arm'))) or {}).get('main_model'),
                                'labels': cc_labels.get((str(ks.item.get('pass')), str(ks.item.get('task'))), [])})
                key_rows.append(row)
            final = {'runner': i, **ks.final} if ks.final else None
            if cc:
                final = cc_refusal_rows(key_rows, [a.end or {} for a in ks.attempts], final, evidence, i)
            for row in key_rows:
                attempts.append(row)
                meta.append({**row, 'jobs_dir': str(res / 'jobs'),
                             **({'task_dir': str(tasks_dir / str(ks.item['task']))} if tasks_dir else {})})
            if final:
                finals.append(final)
        for c in runner_calls:
            (calls_void if str(c.get('trial_id')) in vd else calls).append({**c, 'runner': i})
        cs = res / 'checks' / 'summary.json'
        if cs.exists():
            s = json.loads(cs.read_text())
            checks['tasks'].update({t: {**v, 'runner': i} for t, v in s.get('tasks', {}).items()})
            checks['dropped'] += s.get('dropped', [])
            checks['unresolved'] += s.get('unresolved', [])
            if tb:
                checks.setdefault('flaky_env', []).extend(s.get('flaky_env', []))
                post = res / 'checks' / 'post' / 'summary.json'
                if post.exists():
                    ps = json.loads(post.read_text())
                    checks.setdefault('post', {'tasks': {}, 'failed': []})
                    checks['post']['tasks'].update({t: {**v, 'runner': i} for t, v in ps.get('tasks', {}).items()})
                    checks['post']['failed'] += ps.get('dropped', [])
    checks['dropped'].sort()
    checks['unresolved'].sort()
    requeue: dict[str, list[dict[str, Any]]] = {}
    if cc:   # 0d §12.2: assessor_consults per root session from the router logs (cached reuse not counted), joined here
        joined = cc_router_join(router_records, {r['trial_id']: max(0, int(r.get('forwarded_calls') or 0)) for r in attempts}) if router_records is not None else {}
        for r in [*attempts, *meta]:
            j = joined.get(r['trial_id'])
            if j:
                r['router'] = {k: j.get(k) for k in CC_ROUTER_KEYS}
            elif router_records is not None:   # no router record: complete only if the proxy forwarded nothing
                r['router'] = {'complete': int(r.get('forwarded_calls') or 0) <= 0, 'model_requests': 0,
                               'expected_model_requests': max(0, int(r.get('forwarded_calls') or 0))}
            else:
                r['router'] = None
            r['assessor_consults'] = j.get('assessor_consults') if j else None
            # 0c: a call that never reached the router is a harness rerun, never scored; post hoc from the router log.
            r['router_short'] = bool(r['router'] is not None and not r['router'].get('complete'))
            if r['router_short'] and r.get('class') not in ('harness', 'cap_stop', 'cancelled'):
                r['reclassified_from'] = {'class': r.get('class'), 'action': r.get('action')}
                r.update({'class': 'harness', 'action': 'rerun', 'score': None,
                          'reason': f"router log saw {r['router'].get('model_requests')} of {r['router'].get('expected_model_requests')} "
                                    f"forwarded calls; was {r['reclassified_from']['class']}/{r['reclassified_from']['action']}"})
        for r in attempts:
            if r['router_short'] and r.get('is_final') and r.get('final_status') == 'scored':
                requeue.setdefault(str(r['runner']), []).append({'trial_id': r['trial_id'], 'key': r['key']})
    if tb:   # TB (§7.5, §7.7, 0d S6): task facts, flaky_env, rule (b) evidence, lookupscan record, start time per attempt
        checks.setdefault('flaky_env', []).sort()
        flaky = set(checks['flaky_env'])
        for r in [*attempts, *meta]:
            m = plan['tasks'].get(str(r.get('task')), {})
            r.update({'task_meta': {k: m.get(k) for k in TB_ROW_META}, 'flaky_env': r.get('task') in flaky})
        ends = {a.trial_id: (a.end or {}, a.start) for i_st in tb_states for ks in i_st.values() for a in ks.attempts}
        for r in [*attempts, *meta]:
            end, start = ends.get(r['trial_id'], ({}, {}))
            r.update({'started_at': start.get('at'), 'verifier': end.get('verifier'), 'lookup': end.get('lookup')})
    from collections import Counter
    summary = {
        'runners': sorted({r['runner'] for r in attempts}), 'attempts': len(attempts), 'finals': len(finals),
        'final_by_pass_arm': {f'{p}/{a}': dict(Counter(f['status'] for f in finals if f['pass'] == p and f['arm'] == a))
                              for p, a in sorted({(f['pass'], f['arm']) for f in finals})},
        'classes': dict(Counter(r['class'] for r in attempts)), 'excluded': [f['key'] for f in finals if f['status'] == 'excluded'],
        'spent_usd': round(sum(float(r.get('spent_usd') or 0) for r in attempts), 2),
        'spent_usd_by_runner': {str(i): round(sum(float(r.get('spent_usd') or 0) for r in attempts if r['runner'] == i), 2)
                                for i in sorted({r['runner'] for r in attempts})},
        'throttled_429': sum(int(r.get('throttled') or 0) for r in attempts), 'checks_dropped': checks['dropped'], 'runs': per_runner,
    }
    if cc:
        summary['refusal_fallback'] = cc_refusal_summary(attempts, finals)
        summary.update({'void': voids, 'void_calls': len(calls_void),
                        'gateway_fallback_attempts': sum(1 for r in attempts if int(r.get('gateway_fallback_calls') or 0) > 0),
                        'router_short_attempts': sum(1 for r in attempts if r.get('router_short')),
                        'requeue': {k: len(v) for k, v in requeue.items()}})
        (out / 'requeue.json').write_text(json.dumps({'schema': 'cc-requeue/v1', 'why': 'router-short', 'runners': requeue}, indent=1))
        with open(out / 'calls-void.jsonl', 'w', encoding='utf-8') as f:
            for c in calls_void:
                f.write(json.dumps(c, separators=(',', ':'), default=str) + '\n')
    for name, rows in (('attempts.jsonl', attempts), ('final.jsonl', finals), ('harvest-meta.jsonl', meta), ('calls.jsonl', calls)):
        with open(out / name, 'w', encoding='utf-8') as f:
            for r in rows:
                f.write(json.dumps(r, separators=(',', ':'), default=str) + '\n')
    (out / 'checks.json').write_text(json.dumps(checks, indent=1))
    (out / 'summary.json').write_text(json.dumps(summary, indent=1))
    return summary


# ---------------------------------------------------------------- spend projection (design §7.5 checkpoint)

def project(plan: dict[str, Any], detail: dict[str, Any], merged: pathlib.Path = MERGED, tiers: dict[str, str] | None = None,
            min_n: int = 10, cut_options: tuple[int, ...] = ()) -> dict[str, Any]:
    """Re-projects Bedrock spend (what the proxies see) from the merged dataset:
    - κ per arm = measured spend ÷ public planning cost over that arm's final main-pass trials (κ = 1 below `min_n`
      of them; B's planning cost is its tier-pass model, as in plan-detail);
    - remaining = κ × planning cost of every planned trial that has no final record yet, after the plan's cuts and
      without tasks dropped by the checks;
    - plus, for each N in `cut_options`, the totals if rep2's C, or rep3, were cut to the first N blocks per shard.
    Runner hours and assessor calls are outside this figure (the $4,800 ceiling covers them separately)."""
    pub = detail['tasks']
    finals = [json.loads(x) for x in (merged / 'final.jsonl').read_text().splitlines() if x.strip()] if (merged / 'final.jsonl').exists() else []
    att = [json.loads(x) for x in (merged / 'attempts.jsonl').read_text().splitlines() if x.strip()] if (merged / 'attempts.jsonl').exists() else []
    checks = json.loads((merged / 'checks.json').read_text()) if (merged / 'checks.json').exists() else {}
    dropped = set(checks.get('dropped') or [])
    spent_by_key: dict[str, float] = {}
    for r in att:
        spent_by_key[r['key']] = spent_by_key.get(r['key'], 0.0) + float(r.get('spent_usd') or 0.0)
    kappa: dict[str, Any] = {}
    for arm in shardplan.ARMS:
        ks = [f for f in finals if f['pass'] == 'main' and f['arm'] == arm and f['status'] == 'scored']
        plan_cost = sum(shardplan.planning_cost(pub, f['task'], arm, tiers) for f in ks)
        got = sum(spent_by_key.get(f['key'], 0.0) for f in ks)
        kappa[arm] = {'n': len(ks), 'measured_usd': round(got, 2), 'planning_usd': round(plan_cost, 2),
                      'kappa': round(got / plan_cost, 3) if len(ks) >= min_n and plan_cost > 0 else 1.0}
    done = {f['key'] for f in finals}

    def remaining(p: dict[str, Any]) -> dict[str, float]:
        out: dict[str, float] = {}
        for name in p['passes']:
            for s in range(p['n_shards']):
                for t in shardplan.trials_of(p, name, s):
                    if t['task'] in dropped or f"{name}/{t['task']}/{t['arm']}/r{t['rep']}" in done:
                        continue
                    k = kappa[t['arm']]['kappa']
                    out[str(s)] = out.get(str(s), 0.0) + k * shardplan.planning_cost(pub, t['task'], t['arm'], tiers)
        return out

    spent = {}
    for r in att:
        spent[str(r['runner'])] = spent.get(str(r['runner']), 0.0) + float(r.get('spent_usd') or 0.0)
    rem = remaining(plan)
    runners = sorted(set(spent) | set(rem), key=int)
    res = {'kappa': kappa, 'spent_usd': {r: round(spent.get(r, 0.0), 2) for r in runners},
           'remaining_usd': {r: round(rem.get(r, 0.0), 2) for r in runners},
           'projected_usd': {r: round(spent.get(r, 0.0) + rem.get(r, 0.0), 2) for r in runners},
           'projected_total_usd': round(sum(spent.values()) + sum(rem.values()), 2), 'dropped_tasks': sorted(dropped), 'options': {}}
    import copy
    for n in cut_options:
        for label, name, arms in (('cut rep2 C', 'rep2', ('C',)), ('cut rep3', 'rep3', None)):
            if name not in plan['passes']:
                continue
            alt = copy.deepcopy(plan)
            shardplan.cut_pass(alt, name, n, 'projection', arms)
            r2 = remaining(alt)
            res['options'][f'{label} to {n} blocks/shard'] = {
                'projected_total_usd': round(sum(spent.values()) + sum(r2.values()), 2),
                'projected_usd': {r: round(spent.get(r, 0.0) + r2.get(r, 0.0), 2) for r in runners}}
    return res


def set_experiment_region(region: str | None) -> None:
    """The price catalog's Region for codex-deepswe's common/pricing (harvest prices calls through
    results.calls_summary). From --region or AWS_REGION; there is no default Region."""
    if not region:
        raise SystemExit('merge --harvest needs --region <region> (or AWS_REGION): the price catalog is per Region')
    import hcommon  # noqa: F401  (puts codex-deepswe on sys.path, as harvest does)
    import common
    common.set_region(region)


def merge_cli(*, tiers_path: str | None, tasks_dir: str | None, run_harvest: bool, region: str | None,
              fleet_dir: pathlib.Path = FLEET, out: pathlib.Path = MERGED, plan_path: pathlib.Path = shardplan.PLAN,
              router_logs: str | None = None) -> dict[str, Any]:
    """`fleet.py merge`: --tiers takes 73's strata.json or a tier-pass jsonl (shardplan.load_tiers, as `project`);
    --harvest sets the experiment Region first, then runs 4f's harvest over the merged files."""
    if run_harvest:
        set_experiment_region(region)
    tiers = shardplan.load_tiers(pathlib.Path(tiers_path)) if tiers_path else None
    summ = merge(fleet_dir, out, plan_path, tasks_dir=pathlib.Path(tasks_dir).resolve() if tasks_dir else None, tiers=tiers,
                 **({'router_records': load_router_logs(pathlib.Path(router_logs))} if router_logs else {}))
    if run_harvest:
        import harvest
        rows = out / 'rows.jsonl'
        rows.unlink(missing_ok=True)
        summ['harvested'] = harvest.harvest(out / 'harvest-meta.jsonl', out / 'calls.jsonl', rows)
    return summ


# ---------------------------------------------------------------- status

def status_line(i: int, doc: dict[str, Any]) -> str:
    if 'error' in doc:
        return f'runner {i}: {doc["error"]}'
    pr = doc.get('progress') or {}
    passes = ' '.join(f"{p}:{v.get('blocks_done', 0)}/{v.get('admitted', 0)}/{v.get('blocks', 0)}b {v.get('scored', 0)}s{v.get('excluded', 0)}x"
                      for p, v in (pr.get('passes') or {}).items())
    sp = doc.get('proxy_state') or doc.get('spend') or {}
    cls = ','.join(f'{k}={v}' for k, v in sorted((pr.get('classes') or {}).items()))
    return (f"runner {i}: {doc.get('state', '?')}{' (' + str(doc['reason']) + ')' if doc.get('reason') else ''} "
            f"alive={doc.get('driver_alive')} {passes} attempts={pr.get('attempts', 0)} reruns={pr.get('reruns', 0)} "
            f"[{cls}] spend=${float(sp.get('settled_usd') or 0):.2f}/{sp.get('cap_usd')} 429={pr.get('throttled_429', 0)} "
            f"in-flight={len(doc.get('in_flight') or [])} free={doc.get('free_gb')}GB")


# ---------------------------------------------------------------- CLI

def resolve(a: argparse.Namespace) -> tuple[Aws, list[str], str | None]:
    aws = Aws(a.region)
    bucket = getattr(a, 's3_bucket', None)
    if a.instances:
        ids = [x.strip() for x in a.instances.split(',') if x.strip()]
    elif a.stack:
        outs = aws.stack_outputs(a.stack)
        ids = [x.strip() for x in outs.get('InstanceIds', '').split(',') if x.strip()]
        bucket = bucket or outs.get('ResultsBucketName')
    else:
        raise SystemExit('--stack or --instances is required')
    if not ids or not all(_IID.match(x) for x in ids):
        raise SystemExit('no valid instance ids')
    return aws, ids, bucket


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--region', default=os.environ.get('AWS_REGION'))
    ap.add_argument('--stack', help='runner stack name (outputs InstanceIds, ResultsBucketName)')
    ap.add_argument('--instances', help='comma list of instance ids in runner-index order (instead of --stack)')
    ap.add_argument('--runners', help='comma list of runner indexes (default: all)')
    ap.add_argument('--dataset', default='deepswe', help='deepswe (default) or tb21 (profiles.py): plan, roots, runner dirs, dev-box dirs')
    ap.add_argument('--agent', choices=profiles.AGENTS, help='codex (default) or claude-code (profiles.py: cc-deepswe, cc-tb21)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('pack')
    sub.add_parser('ship')
    sub.add_parser('setup')
    sub.add_parser('prepull')
    p = sub.add_parser('check')
    p.add_argument('--kind', choices=('oracle', 'nop', 'both'), default='both')
    p.add_argument('--reps', type=int, default=1)
    p.add_argument('--concurrency', type=int, default=6)
    p.add_argument('--post', action='store_true', help='TB: the post-run oracle re-check of every kept task')
    p = sub.add_parser('start')
    p.add_argument('--pass', dest='passes', action='append', required=True)
    p.add_argument('--gateway-url', required=True)
    p.add_argument('--secret-id', default='llmar-runner/client')
    p.add_argument('--concurrency', type=int, default=6)
    p.add_argument('--soft-cap', type=float, default=1000.0)
    p.add_argument('--hard-cap', type=float, default=1130.0)
    p.add_argument('--max-blocks', type=int)
    p.add_argument('--change-concurrency', action='store_true')
    p.add_argument('--unstop-cap', action='store_true')
    p.add_argument('--token-max-age-s', type=float, help='pilot only: force a token re-mint once it is this old (e.g. 600)')
    p.add_argument('--caps-file', help='Claude Code: per-runner soft/hard caps (cc-caps/v1; `project --caps-for`)')
    p.add_argument('--router-policy-version', help="Claude Code: the router's policyVersion, recorded for the stage-continuity check")
    p = sub.add_parser('status')
    p.add_argument('--pass', dest='passes', action='append')
    p.add_argument('--json', action='store_true')
    p = sub.add_parser('isolation', help="18's isolation suite on each runner (detached unit llmar-isolation)")
    p.add_argument('--show', action='store_true', help="print the last run's gate lines (the unit's journal) instead of starting it")
    p.add_argument('--wait', action='store_true', help='start, wait for every runner to finish, show the gates, then fetch (light)')
    sub.add_parser('units')
    p = sub.add_parser('stop')
    p.add_argument('--now', action='store_true')
    sub.add_parser('unstop')
    p = sub.add_parser('fetch')
    p.add_argument('--mode', choices=('light', 'full'), default='light')
    p.add_argument('--s3-bucket')
    p.add_argument('--full-refetch', action='store_true')
    p = sub.add_parser('archive', help="freeze the dataset's results dir on every runner: manifest + chmod a-w (no deletes)")
    p.add_argument('--verify', help='re-hash against this archive manifest (a path on the runner)')
    p = sub.add_parser('project', help='re-project Bedrock spend from the merged dataset (design §7.5 checkpoint)')
    p.add_argument('--tiers', help="73's strata.json (default: the dataset's results/tierpass/strata.json)")
    p.add_argument('--cut-options', default='7,14,21', help='blocks per shard to price for the two cut options')
    p.add_argument('--caps-for', help='Claude Code: write caps-<passes>.json for these passes (comma list), from the measured κ')
    p.add_argument('--report-passes', help='Claude Code: the pilot/interim report over these passes only (default: all)')
    p.add_argument('--concurrency', type=int, help="Claude Code: runner concurrency for runner hours and the caps' in-flight allowance (default: the profile's maximum)")
    p.add_argument('--role-table', help="Claude Code: 4f's frozen native role table (design-stats §13), for the §4.2 per-call checks")
    p.add_argument('--role-table-sha256', help='its sha256 as recorded in design-stats §13 (required with --role-table)')
    p.add_argument('--prior-m', type=float, default=1.0, help="Claude Code: 0d's m for the prior κ (an arm with no measured runs yet)")
    p.add_argument('--prior-tau', type=float, default=1.0, help='Claude Code: Claude Code ÷ Codex wall time for an arm with no measured runs')
    p = sub.add_parser('budget', help='Claude Code: exposure of every ledger vs budget.json; --close records a stopped benchmark')
    p.add_argument('--close', action='store_true', help="record this benchmark's live settled spend as final (drivers must be stopped)")
    p = sub.add_parser('void-pass', help='Claude Code: forget every attempt of a pass on each runner so it runs again from scratch '
                                         '(drivers stopped; append-only; spend stays on the ledgers)')
    p.add_argument('--pass', dest='passes', action='append', required=True)
    p.add_argument('--reason', required=True, help='plain-text note recorded in each runner\'s event log')
    sub.add_parser('requeue', help="Claude Code: send merged/requeue.json (scored attempts the router log saw short) to the runners "
                                   "as harness reruns (drivers stopped); then `start` the pass again")
    p = sub.add_parser('merge')
    p.add_argument('--tasks-dir')
    p.add_argument('--tiers', help="73's strata.json or tier-pass rows (jsonl): adds pred_tier")
    p.add_argument('--harvest', action='store_true', help="also run 4f's harvest → merged/rows.jsonl")
    p.add_argument('--router-logs', help="Claude Code: the router log events fetched for the run (routerlogs.parse): router join, assessor_consults")
    a = ap.parse_args(argv)
    prof = a.profile = profiles.get(a.dataset, a.agent)
    if a.cmd in ('budget', 'void-pass', 'requeue') and prof.agent != 'claude-code':
        raise SystemExit(f'{a.cmd} is for --agent claude-code')
    if a.cmd == 'void-pass':
        import driver as drv
        drv.plain_reason(a.reason)
    fleet_dir, merged_dir = prof.dev_results / 'fleet', prof.dev_results / 'merged'   # DeepSWE: FLEET, MERGED
    pack_path = fleet_dir / PACK.name

    if a.cmd == 'pack':
        info = pack(pack_path, profile=prof)
        say(json.dumps(info))
        return
    if a.cmd == 'project' and prof.agent == 'claude-code':
        say(json.dumps(cc_project_cli(prof, a), indent=1))
        return
    if a.cmd == 'budget' and not a.close:
        say(json.dumps(cc_budget_cli(prof, None, False), indent=1))
        return
    if a.cmd == 'project':
        tiers_p = pathlib.Path(a.tiers) if a.tiers else prof.dev_results / 'tierpass' / 'strata.json'
        tiers = shardplan.load_tiers(tiers_p) if tiers_p.exists() else None
        out = project(shardplan.load_plan(prof.plan), json.loads((prof.dev_results / 'plan-detail.json').read_text()), merged_dir, tiers,
                      cut_options=tuple(int(x) for x in a.cut_options.split(',') if x))
        say(json.dumps(out, indent=1))
        return
    if a.cmd == 'merge':
        summ = merge_cli(tiers_path=a.tiers, tasks_dir=a.tasks_dir, run_harvest=a.harvest, region=a.region,
                         fleet_dir=fleet_dir, out=merged_dir, plan_path=prof.plan, router_logs=a.router_logs)
        say(json.dumps(summ, indent=1))
        return

    aws, ids, bucket = resolve(a)
    runners = [int(x) for x in a.runners.split(',')] if a.runners else None
    fl = Fleet(aws, ids, runners, bucket, out=fleet_dir, profile=prof)

    def report(res: dict[int, Any]) -> None:
        for i, r in sorted(res.items()):
            say(f'runner {i}: {r if isinstance(r, str) else json.dumps(r)}')

    def simple(body: str, timeout_s: int = 600) -> dict[int, str]:
        def one(i: int, iid: str) -> str:
            st, out, err = fl.run(i, iid, body, timeout_s)
            return (out.strip().splitlines() or [''])[-1] if st == 'Success' else f'FAILED ({st}): {(err or out).strip()[-500:]}'
        return fl.each(one)

    if a.cmd == 'ship':
        if not pack_path.exists():
            raise SystemExit('run `fleet.py pack` first')
        blob = pack_path.read_bytes()
        report(fl.ship(blob, hashlib.sha256(blob).hexdigest()))
    elif a.cmd == 'setup':
        report(simple(f'cd "$WORK_DIR/repo/experiments/deepswe-harbor" && "$WORK_DIR/venv/bin/python" cli.py {prof.stage} --arch x86_64 >/dev/null\n'
                      + driver_cmd('fetch-tasks', profile=prof) + '\n', 1800))
    elif a.cmd == 'prepull':
        report(simple(unit_cmd('llmar-prepull', 'prepull', profile=prof)))
    elif a.cmd == 'check':
        report(simple(unit_cmd('llmar-check', 'check', '--kind', a.kind, '--reps', str(a.reps), '--concurrency', str(a.concurrency),
                               *(['--post'] if a.post else []), profile=prof)))
    elif a.cmd == 'start':
        if not 1 <= a.concurrency <= prof.max_concurrency:
            raise SystemExit(f'--concurrency must be 1..{prof.max_concurrency}')
        a.shards = fl.runners
        if prof.agent == 'claude-code':
            report(cc_start(fl, a))
        else:
            report(simple(unit_cmd('llmar-driver', *start_args(a), profile=prof)))
    elif a.cmd == 'budget':
        say(json.dumps(cc_budget_cli(prof, fl, True), indent=1))
    elif a.cmd == 'archive':
        report(simple(driver_cmd('archive', *(['--verify', a.verify] if a.verify else []), profile=prof), 1800))
    elif a.cmd == 'status':
        args = ['status'] + [x for p in (a.passes or []) for x in ('--pass', p)]

        def one(i: int, iid: str) -> dict[str, Any]:
            st, out, err = fl.run(i, iid, driver_cmd(*args, profile=prof), 120)
            if st != 'Success':
                return {'error': f'{st}: {(err or out).strip()[-300:]}'}
            try:
                return json.loads(out.strip().splitlines()[-1])
            except (ValueError, IndexError):
                return {'error': 'unparsable status'}
        res = fl.each(one)
        fleet_dir.mkdir(parents=True, exist_ok=True)
        (fleet_dir / f'status-{int(time.time())}.json').write_text(mask(json.dumps(res, indent=1)))
        for i, doc in sorted(res.items()):
            say(json.dumps(doc) if a.json else status_line(i, doc))
    elif a.cmd == 'isolation':
        def show() -> dict[int, str]:
            res = fl.each(lambda i, iid: fl.run(i, iid, ISOLATION_SHOW, 120))
            verdicts = {}
            for i, (st, out, err) in sorted(res.items()):
                verdicts[i] = isolation_verdict(out) if st == 'Success' else f'SSM {st}'
                say(f'--- runner {i}: {verdicts[i]}\n{out.strip()}')
            return verdicts
        if a.show:
            show()
            return
        # The probe image is pulled on the host first (pinned by digest; not in PREPULL_IMAGES: the infra is frozen).
        body = f'docker pull -q {shlex.quote(probe_image())} >/dev/null\n' + unit_cmd('llmar-isolation', command=isolation_cmd(a.region, prof), stop_timeout_s=300)
        report(simple(body))
        if a.wait:
            t_end = time.time() + 45 * 60
            while time.time() < t_end:
                time.sleep(30)
                act = simple('systemctl is-active llmar-isolation 2>/dev/null || true\n', 120)
                if not any(v.strip() in ('active', 'activating') for v in act.values()):
                    break
            verdicts = show()
            report(fl.fetch('light'))
            say('isolation: ' + ', '.join(f'runner {i} {v}' for i, v in sorted(verdicts.items())))
    elif a.cmd == 'units':
        body = ''.join(f'echo "{u}: $(systemctl is-active {u} 2>/dev/null || true)"; journalctl -u {u} -n 3 --no-pager -o cat 2>/dev/null | cut -c1-200 || true\n'
                       for u in UNITS)
        res = fl.each(lambda i, iid: fl.run(i, iid, body, 120))
        for i, (st, out, err) in sorted(res.items()):
            say(f'--- runner {i} ({st})\n{out.strip()}')
    elif a.cmd == 'stop':
        report(simple(driver_cmd('stop', *(['--now'] if a.now else []), profile=prof)))
    elif a.cmd == 'unstop':
        report(simple(driver_cmd('unstop', profile=prof)))
    elif a.cmd == 'fetch':
        report(fl.fetch(a.mode, a.full_refetch))
    elif a.cmd == 'void-pass':
        report(simple(driver_cmd('void-pass', *[x for p in a.passes for x in ('--pass', p)], '--reason', a.reason, profile=prof), 300))
    elif a.cmd == 'requeue':
        report(cc_requeue(fl, merged_dir / 'requeue.json'))


if __name__ == '__main__':
    main()
