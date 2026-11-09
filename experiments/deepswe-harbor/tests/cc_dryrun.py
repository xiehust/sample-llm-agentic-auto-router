"""Dry run of the Claude Code × Harbor runbook (experiments/claude-code-harbor/ORCHESTRATION.md; CC orchestration
design §6) against four local fake runners. Default: 0c's A/C validation, stage 1 only: plans with arms A and C and
passes pilot + main; DeepSWE pilot → main (a changed router policy refused, then a mid-run kill of every runner process
and a resume) → changeover → TB pilot → main. `--full` (and `--only-arms ''`) runs both stages with the whole arm table.
Every step is the exact `fleet.py`
or `shardplan.py` argv 0c runs, executed in-process with tests/changeover_dryrun.py's fake SSM, systemd, docker and
Harbor; the transcript lists each command with the last line it printed.

  uv run --python 3.12 --with pytest==8.4.2 python tests/cc_dryrun.py --codex-dev <main checkout>/experiments \\
      [--tmp-dir /local/tmp] [--keep] [--out transcript.md]

Inputs (gitignored, read-only): the Codex runs' merged attempts.jsonl and checks.json of both benchmarks, and TB's
tierpass/strata.json, under --codex-dev (the plans are derived from them into the temp dir; TB's Codex strata stand in
for 73's Claude Code tier pass); a deep-swe checkout at the plan's commit (--deepswe-checkout) and the TB 2.1 checkout
(/tmp/tb-data/tb21); a Python with Harbor 0.25.0 (--harbor-python; taskpin's digest helper).

Real: fleet.py, driver.py, shardplan (derive), classify, profiles, ccproject (projection, caps, budget pre-flight, the
outcome-blind report and §4.2 checks), 4f's hproxy (bound to a local bridge address; no upstream calls), harbor_job_cc,
taskpin, leakscan, the export (Claude Code session allowlist), the merge, pack/ship and the real isolation.py.
Fake: AWS, systemd, docker (the libc gate's `docker run` passes), Harbor (tests/fake_harbor.py writes Claude Code's
agent dir), the runner secret, the Claude Code and Codex downloads (stubs), a3's egress switch (env-file keys). No model
call is made, so spend is $0 and κ stays at its prior; the cost and failure-mode paths are covered by tests/test_cc.py.
No AWS, no network except local git clones."""
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
import signal
import subprocess
import sys
import tempfile
import time

TESTS = pathlib.Path(__file__).resolve().parent
HERE = TESTS.parent
REPO = HERE.parents[1]
for p in (str(HERE), str(TESTS)):
    if p not in sys.path:
        sys.path.insert(0, p)

import changeover_dryrun as cd

import fleet
import profiles
import shardplan

SCANNER_POOL = 'mailman,make-doom-for-mips,fix-code-vulnerability,pytorch-model-recovery,hf-model-inference'
ROLE_TABLE = profiles.CC_HERE / 'native-roles.json'
ROLE_TABLE_SHA = '89f7e8c0908dd81855ec90f2fb62240cc160499df595d9fa2ae94be84807ba93'   # design-stats §13 (0c, main 9806f00)
CLI_STUB = '''"""dry-run stub of cli.py stage-codex / stage-claude-code (tests/cc_dryrun.py): no download"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import hcommon
if sys.argv[1] == 'stage-codex':
    p = hcommon.codex_bin('x86_64'); p.parent.mkdir(parents=True, exist_ok=True); p.write_text('#!/bin/sh\\necho codex-cli\\n'); p.chmod(0o755)
else:
    import harbor_job_cc
    for plat in ('linux-x64', 'linux-x64-musl'):
        p = hcommon.claude_bin(plat); p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('#!/bin/sh\\necho "2.1.318 (Claude Code)"\\n'); p.chmod(0o755)
    harbor_job_cc.WRAPPER.write_text(harbor_job_cc.WRAPPER_TEXT); harbor_job_cc.WRAPPER.chmod(0o755)
print('ok', p)
'''


def kill_runners(root: pathlib.Path) -> int:
    """The instance stop: SIGKILL every process whose command line points into the fake runners (drivers, watchers,
    fake Harbor trials, shims). Returns how many were killed."""
    n = 0
    for d in pathlib.Path('/proc').iterdir():
        if not d.name.isdigit() or int(d.name) == os.getpid():
            continue
        try:
            cmd = (d / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
        except OSError:
            continue
        if str(root) in cmd:
            with contextlib.suppress(OSError):
                os.kill(int(d.name), signal.SIGKILL)
                n += 1
    return n


def egress(runners: list[cd.Runner], mode: str) -> None:
    """a3's switch, simulated: the env file's CONTAINER_EGRESS (and TB's online keys)."""
    for r in runners:
        keep = [x for x in r.env_file.read_text().splitlines() if not x.startswith(('CONTAINER_EGRESS=', 'ONLINE_NETWORK=', 'ONLINE_DNS='))]
        extra = ['CONTAINER_EGRESS=internet', 'ONLINE_NETWORK=llmar-online', 'ONLINE_DNS=169.254.169.253'] if mode == 'internet' else ['CONTAINER_EGRESS=none']
        r.env_file.write_text('\n'.join(keep + extra) + '\n')


def cc_brief(out: list[str]) -> str:
    """The last line; for a JSON document its headline (cc project: κ source, stage totals, gate; budget: exposure)."""
    if out and out[-1] == '}':
        try:
            doc = json.loads('\n'.join(out[next(i for i, x in enumerate(out) if x == '{'):]))
        except (StopIteration, ValueError):
            return out[-1]
        if 'ratios' in doc:
            g = doc.get('gate') or {}
            return json.dumps({'kappa': {a: [v['kappa'], v['source']] for a, v in doc['ratios'].items()},
                               'stages_usd': {k: v['remaining_usd'] for k, v in doc['projection']['stages'].items()},
                               'experiment_usd': doc['experiment']['projected_total_usd'], 'within_budget': doc['experiment']['within_budget'],
                               'caps': {r: c['hard'] for r, c in (doc.get('caps') or {}).get('runners', {}).items()},
                               'gate': {k: g.get(k) for k in ('ok', 'preconditions_ok', 'rate_429_ok', 'memory_ok', 'cc_result_missing')}},
                              separators=(',', ':'))
        if 'exposure_usd' in doc:
            return json.dumps({k: doc[k] for k in ('ok', 'exposure_usd', 'outside_usd', 'total_usd', 'headroom_usd')}, separators=(',', ':'))
        if 'plan' in doc and 'pilot' in doc:
            return json.dumps({'tasks': doc['plan']['tasks'], 'trials': {k: v['trials'] for k, v in doc['plan']['passes'].items()}, 'arms': doc['arms']},
                              separators=(',', ':'))
    return cd.brief(out)


def run_cli(argv: list[str], aws: cd.LocalAws) -> list[str]:
    if argv[:1] == ['shardplan']:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            shardplan.main(argv[1:])
        return buf.getvalue().strip().splitlines()
    return cd.run_fleet(argv, aws)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--codex-dev', required=True, help='<checkout with the Codex runs>/experiments (deepswe-harbor/results, tbench-harbor/results)')
    ap.add_argument('--deepswe-checkout', default='/tmp/llmar-73-deepswe/deep-swe')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--driver-python', default=sys.executable)
    ap.add_argument('--harbor-python', default='/tmp/harbor-venv/bin/python')
    ap.add_argument('--proxy-addr', default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--tmp-dir', default=None)
    ap.add_argument('--only-arms', default='A,C', help="the plans' arm subset (0c's validation: A,C); '' for the whole arm table")
    ap.add_argument('--full', action='store_true', help='both stages (pilot, main, rep2, rep3) instead of stage 1 only')
    a = ap.parse_args()
    if subprocess.run([a.driver_python, '-I', '-c', 'import harbor'], capture_output=True, check=False).returncode == 0:  # nosec B603: argument list, no shell; arguments are the operator's own
        raise SystemExit(f'--driver-python {a.driver_python} can import harbor; the runner driver venv cannot')
    if subprocess.run([a.harbor_python, '-I', '-c', 'import harbor'], capture_output=True, check=False).returncode != 0:  # nosec B603: argument list, no shell; arguments are the operator's own
        raise SystemExit(f'--harbor-python {a.harbor_python} cannot import harbor')
    codex = pathlib.Path(a.codex_dev)
    ds_res, tb_res = codex / 'deepswe-harbor' / 'results', codex / 'tbench-harbor' / 'results'
    for p in (ds_res / 'merged' / 'attempts.jsonl', ds_res / 'merged' / 'checks.json', tb_res / 'merged' / 'attempts.jsonl',
              tb_res / 'merged' / 'checks.json', tb_res / 'tierpass' / 'strata.json', tb_res / 'plan-detail.json'):
        if not p.is_file():
            raise SystemExit(f'missing input {p}')
    cd.HARBOR_PYTHON = a.harbor_python
    cd.PROXY_ADDR = a.proxy_addr or subprocess.run(['sh', '-c', "ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1"],  # nosec B603: argument list, no shell; arguments are the operator's own
                                                   capture_output=True, text=True, check=False).stdout.strip() or '240.10.0.1'
    root = pathlib.Path(tempfile.mkdtemp(prefix='llmar-ccdry-', dir=a.tmp_dir))
    cd.BUCKET = root / 'bucket'
    runners = [cd.Runner(root, i, a.driver_python) for i in range(4)]
    for r in runners:
        with open(r.gitconfig, 'a') as f:
            f.write(f'[url "{a.deepswe_checkout}"]\n\tinsteadOf = {profiles.DEEPSWE.repo_url}\n')
    aws = cd.LocalAws(dict(zip(cd.IIDS, runners)))
    # dev box: every profile's outputs (and the Claude Code plans) live in the temp dir
    dev = root / 'dev'
    for name in ('deepswe', 'tb21', 'cc-deepswe', 'cc-tb21'):
        p0 = profiles.PROFILES[name]
        sub = {'deepswe': 'codex-deepswe', 'tb21': 'codex-tb21', 'cc-deepswe': 'cc/deepswe', 'cc-tb21': 'cc/tb21'}[name]
        kw = {'dev_results': dev / sub}
        if p0.agent == 'claude-code':
            kw['plan'] = dev / 'plans' / str(p0.base) / 'plan.json'
        profiles.PROFILES[name] = dataclasses.replace(p0, **kw)
    (dev / 'codex-tb21' / 'tierpass').mkdir(parents=True)
    shutil.copy(tb_res / 'plan-detail.json', dev / 'codex-tb21' / 'plan-detail.json')
    shutil.copy(tb_res / 'tierpass' / 'strata.json', dev / 'codex-tb21' / 'tierpass' / 'strata.json')
    budget = dev / 'cc' / 'budget.json'
    shardplan.write_json(budget, {'schema': 'cc-budget/v1', 'total_usd': 8000,
                                  'outside_usd': {'tier_pass_and_probes': 5.0, 'runner_hours_estimate': 1200.0, 'assessor_estimate': 20.0}})

    class _FastTime:
        def __getattr__(self, k):
            return getattr(time, k)

        @staticmethod
        def sleep(s):
            time.sleep(min(s, 0.5))
    fleet.time = _FastTime()

    def stub(r: cd.Runner) -> None:
        r.stub_shipped()
        (r.work / 'repo' / 'experiments' / 'deepswe-harbor' / 'cli.py').write_text(CLI_STUB)
        for base in ('deepswe', 'tb21'):   # the committed plans (in the real run they are in the pack)
            src = profiles.PROFILES[f'cc-{base}'].plan
            if src.exists():
                dst = r.work / 'repo' / 'experiments' / 'claude-code-harbor' / base / 'plan.json'
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(src, dst)

    # pre-state: the runners run this worktree's code and hold a finished TB (Codex) run, container internet on
    egress(runners, 'internet')
    for argv in (['--dataset', 'tb21', 'pack'], ['--dataset', 'tb21', 'ship']):
        out = cd.run_fleet(argv, aws)
        assert not any('FAILED' in x for x in out), out
    for r in runners:
        stub(r)
        res = r.work / 'tb21' / 'results'
        (res / 'jobs' / 'j1' / 't1').mkdir(parents=True)
        (res / 'jobs' / 'j1' / 't1' / 'result.json').write_text('{"verifier_result": {"rewards": {"reward": 1.0}}}')
        (res / 'attempts.jsonl').write_text(json.dumps({'ev': 'run-start', 'at': 1.0, 'passes': ['main']}) + '\n'
                                            + json.dumps({'ev': 'run-end', 'state': 'done', 'at': 2.0}) + '\n')

    T = ['--dataset', 'tb21']
    D = ['--agent', 'claude-code', '--dataset', 'deepswe']
    B = ['--agent', 'claude-code', '--dataset', 'tb21']
    gw = ['--gateway-url', 'https://gateway.dryrun.invalid', '--router-policy-version', 'experiment-cc-auto-dryrun']
    rl = root / 'router-logs.jsonl'
    rl.write_text('')   # no model calls in the dry run: an empty router log export
    rt = ['--role-table', str(ROLE_TABLE), '--role-table-sha256', ROLE_TABLE_SHA]
    capsf = {('deepswe', p): str(dev / 'cc' / 'deepswe' / f'caps-{p}.json') for p in ('pilot', 'main', 'rep2+rep3')}
    capsf.update({('tb21', p): str(dev / 'cc' / 'tb21' / f'caps-{p}.json') for p in ('pilot', 'main', 'rep2+rep3')})

    pm = ['--prior-m', '3', '--prior-tau', '1.5']   # 0c: about $0.7–1.0k expected, i.e. 0d's m ≈ 3; Claude Code ≈ 1.5× Codex time

    def stage(pre: list[str], base: str, passes: list[str], conc: str, resume: bool = False) -> list[tuple]:
        key = '+'.join(passes)
        pp = [x for p in passes for x in ('--pass', p)]
        start = ['start', *pp, *gw, '--concurrency', conc, '--caps-file', capsf[(base, key)]]
        out: list[tuple] = [(f'{base} {key}: project + caps', ['project', '--caps-for', ','.join(passes), *rt, *pm], pre)]
        if resume:   # a run killed mid-way (an instance stop) and resumed with the same command
            out += [(f'{base} {key}: a changed router policy is refused', [*start[:start.index('--router-policy-version') + 1],
                                                                            'experiment-cc-auto-CHANGED', *start[start.index('--concurrency'):]], pre, 'expect-fail'),
                    (f'{base} {key}: start', start, pre, 'no-wait'), (f'{base} {key}: mid-run instance stop', 'KILL-MID', None),
                    (f'{base} {key}: resume (same command)', start, pre)]
        else:
            out.append((f'{base} {key}: start', start, pre))
        return out + [(f'{base} {key}: status', ['status'], pre), (f'{base} {key}: fetch', ['fetch'], pre),
                      (f'{base} {key}: merge', ['merge', '--router-logs', str(rl)], pre)]

    only = ['--only-arms', a.only_arms] if a.only_arms else []
    passes = ['--passes', 'main'] if not a.full else []
    derive = [
        ('1 derive DeepSWE', ['shardplan', '--agent', 'claude-code', '--dataset', 'deepswe', 'derive', *only, *passes, '--codex-attempts',
                              str(ds_res / 'merged' / 'attempts.jsonl'), '--drops', str(ds_res / 'merged' / 'checks.json')], None),
        ('1 derive TB', ['shardplan', '--agent', 'claude-code', '--dataset', 'tb21', 'derive', *only, *passes, '--codex-attempts',
                         str(tb_res / 'merged' / 'attempts.jsonl'), '--drops', str(tb_res / 'merged' / 'checks.json'),
                         *(['--tiers', str(tb_res / 'tierpass' / 'strata.json')] if a.full else []), '--scanner-cal', SCANNER_POOL], None)]
    changeover_ds = [
        ('1 budget (nothing committed)', ['budget'], D),
        ('2 pack', ['pack'], D), ('2 ship', ['ship'], D), ('3 archive TB (Codex)', ['archive'], T),
        ('4 a3: egress none', 'EGRESS:none', None), ('4 isolation --wait', ['isolation', '--wait'], D),
        ('5 setup', ['setup'], D), ('5 prepull (libc gate)', ['prepull'], D),
        ('6 checks', ['check', '--concurrency', '6'], D), ('6 fetch', ['fetch'], D), ('6 merge', ['merge'], D)]
    changeover_tb = [
        ('8 TB pack', ['pack'], B), ('8 TB ship', ['ship'], B), ('8 a3: egress internet', 'EGRESS:internet', None),
        ('8 isolation --wait', ['isolation', '--wait'], B), ('8 setup', ['setup'], B), ('8 prepull', ['prepull'], B),
        ('8 checks', ['check', '--concurrency', '8'], B), ('8 fetch', ['fetch'], B), ('8 merge', ['merge'], B)]
    S: list[tuple] = [('0 TB (Codex) final full fetch', ['fetch', '--mode', 'full'], T), ('0 stop', ['stop'], T), ('0 status', ['status'], T),
                      *derive, *changeover_ds,
                      *stage(D, 'deepswe', ['pilot'], '6'),
                      *([] if a.full else [   # 0c's pilot reset: void the pilot on every runner, re-run it from scratch, requeue
                          ('6b pilot ids', 'SNAP-PILOT', None),
                          ('6b void the pilot', ['void-pass', '--pass', 'pilot', '--reason', 'dry run: gateway fallback, rerun after the hproxy fix'], D),
                          ('6b fetch', ['fetch'], D), ('6b merge (no pilot attempts left)', ['merge'], D), ('6b pilot forgotten', 'CHECK-EMPTY', None),
                          *stage(D, 'deepswe', ['pilot'], '6'), ('6b re-run pilot: new attempts only', 'CHECK-VOID', None),
                          ('6b requeue (router-short list)', ['requeue'], D)]),
                      *stage(D, 'deepswe', ['main'], '6', resume=not a.full),
                      ('7 DeepSWE closed', ['budget', '--close'], D), *changeover_tb,
                      *stage(B, 'tb21', ['pilot'], '8'), *stage(B, 'tb21', ['main'], '8'),
                      ('9 end of stage 1: full fetch', ['fetch', '--mode', 'full'], B), ('9 merge', ['merge', '--router-logs', str(rl)], B),
                      ('9 TB closed', ['budget', '--close'], B), ('9 budget', ['budget'], B)]
    if a.full:   # stage 2 (not planned for the A/C validation)
        S += [('10 instance stop (every runner process killed) and start', 'KILL', None),
              ('10 on start: isolation --wait', ['isolation', '--wait'], B), ('10 status', ['status'], B),
              *stage(B, 'tb21', ['rep2', 'rep3'], '8', resume=True), ('12 TB closed', ['budget', '--close'], B),
              ('12 DeepSWE pack', ['pack'], D), ('12 DeepSWE ship', ['ship'], D), ('12 a3: egress none', 'EGRESS:none', None),
              ('12 isolation --wait', ['isolation', '--wait'], D), *stage(D, 'deepswe', ['rep2', 'rep3'], '6'),
              ('13 end: full fetch', ['fetch', '--mode', 'full'], D), ('13 merge', ['merge', '--router-logs', str(rl)], D),
              ('13 DeepSWE closed', ['budget', '--close'], D), ('13 budget', ['budget'], D)]
    S += [('final project DeepSWE (outcome-blind)', ['project', *rt, *pm], D), ('final project TB (outcome-blind)', ['project', *rt, *pm], B)]
    lines = [f'# Claude Code × Harbor dry run ({time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())})', '',
             f'Runners: 4 local fakes under {root}; code = this worktree; plans derived from the Codex runs into the temp dir.',
             f'Driver venv Python without Harbor: {a.driver_python}. No model calls (spend $0, κ at its prior).', '',
             '| Step | Command | Last line |', '|---|---|---|']
    ok = True
    first_pilot: set[str] = set()
    for step in S:
        title, argv, pre = step[:3]
        flag = step[3] if len(step) > 3 else ''
        t0 = time.time()
        if isinstance(argv, str):
            if argv.startswith('EGRESS:'):
                egress(runners, argv.split(':')[1])
                lines.append(f"| {title} | (0c applies a3's switch) | env files: CONTAINER_EGRESS={argv.split(':')[1]} |")
            elif argv == 'KILL':
                n = kill_runners(root)
                lines.append(f'| {title} | (simulated) | {n} processes killed; EBS (the runner dirs) kept |')
            elif argv in ('SNAP-PILOT', 'CHECK-VOID', 'CHECK-EMPTY'):
                mdir = dev / 'cc' / 'deepswe' / 'merged'
                rows = [json.loads(x) for x in (mdir / 'attempts.jsonl').read_text().splitlines() if x.strip()]
                ids = {r['trial_id'] for r in rows if r.get('pass') == 'pilot'}
                if argv == 'SNAP-PILOT':
                    first_pilot = ids
                    lines.append(f'| {title} | (merged) | {len(ids)} pilot attempts |')
                elif argv == 'CHECK-EMPTY':
                    ok = ok and not ids
                    lines.append(f"| {title} | (merged) | {len(ids)} pilot attempts after the void{' **FAILED**' if ids else ''} |")
                else:
                    summ = json.loads((mdir / 'summary.json').read_text())
                    voids = sum(len(v) for v in (summ.get('void') or {}).values())
                    bad = not ids or bool(ids & first_pilot) or voids != len(runners)
                    ok = ok and not bad
                    lines.append(f"| {title} | (merged) | {len(ids)} pilot attempts, none of the voided {len(first_pilot)}; void events on "
                                 f"{voids}/{len(runners)} runners; void calls {summ.get('void_calls')}{' **FAILED**' if bad else ''} |")
            elif argv == 'KILL-MID':
                time.sleep(8)
                n = kill_runners(root)
                lines.append(f'| {title} | (simulated, 8 s into the run) | {n} processes killed mid-run |')
            continue
        cmd = argv if argv[:1] == ['shardplan'] else [*pre, *argv]
        shown = ('python3 experiments/deepswe-harbor/shardplan.py ' + ' '.join(argv[1:]) if argv[:1] == ['shardplan']
                 else 'fleet.py ' + ' '.join(cmd))
        shown = shown.replace(str(root), '$TMP').replace(str(codex), '$CODEX_DEV')
        try:
            out = run_cli(cmd, aws)
        except SystemExit as e:
            out = [f'SystemExit: {e}']
        if argv[:1] == ['ship']:
            for r in runners:
                stub(r)
        if argv[:1] in (['prepull'], ['check'], ['start'], ['isolation']) and flag != 'no-wait':
            for r in runners:
                r.wait_units(1800)
        last = cc_brief(out)
        bad = any(re.match(r'runner \d+: FAILED', x) or 'Traceback' in x or '"error":' in x or x.startswith('SystemExit') for x in out)
        if argv[:1] == ['isolation']:
            bad, last = cd.isolation_ran(runners)
        if flag == 'expect-fail':
            refused = [r for r in runners if 'stage continuity' in ((r.state / 'units' / 'llmar-driver.log').read_text(errors='replace')
                                                                    if (r.state / 'units' / 'llmar-driver.log').exists() else '')]
            bad = len(refused) != len(runners)
            last = f'refused on {len(refused)}/4 runners (stage continuity: router_policy_version changed)' + ('' if not bad else f' — {last}')
        ok = ok and not bad
        lines.append(f"| {title} | `{shown[:260]}` | `{last[:300].replace('|', '/')}` ({time.time() - t0:.0f} s){' **FAILED**' if bad else ''} |")
        print(f'[{title}] {shown}\n  ' + '\n  '.join(out[-6:]), flush=True)
    # what was exported from a Claude Code trial dir, and that no reward reached the printed output
    sess = sorted({str(p.relative_to(dev)) for p in dev.glob('cc/*/fleet/runner-*/results/jobs/**/agent/**/*') if p.is_file()})
    leaked = [x for x in sess if '.claude.json' in x or '/statsig/' in x]
    lines += ['', (f'Claude Code agent files fetched (sample): {sess[:3]}; left out by the export allowlist: '
              f'{"none leaked" if not leaked else leaked[:3]}')]
    ok = ok and not leaked
    text = '\n'.join(lines) + '\n'
    printed = text.lower()
    if '"reward"' in printed or '"solved"' in printed:
        ok = False
        text += '\n**FAILED: an outcome field reached the printed output**\n'
    if a.out:
        pathlib.Path(a.out).write_text(text)
    print(text)
    if not a.keep:
        kill_runners(root)
        for dp, _, _ in os.walk(root):
            with contextlib.suppress(OSError):
                os.chmod(dp, 0o700)
        shutil.rmtree(root, ignore_errors=True)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
