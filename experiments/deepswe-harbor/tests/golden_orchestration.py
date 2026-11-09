"""DeepSWE byte-identity goldens for the TB 2.1 refactor (design §6.2). `capture()` records what the orchestration
code produces for the DeepSWE profile: every fleet command line and script body, the driver's paths, the Harbor
subprocess environment, check job configs and summaries, event and status key sets from a fake-Harbor run, the
export manifest's keys, the classifier on a grid of inputs, and the committed plan's launch lists. The golden file
was written from main@7ced27d before the refactor; test_golden_orchestration.py requires the same output afterwards.

  python3 tests/golden_orchestration.py --write      # only to re-record on purpose (never during the TB refactor)

Hashes are stored as unpadded base64url (N5: no 12-digit runs in committed files); absolute paths of this checkout
are replaced by <HERE>."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import pathlib
import sys
import tempfile
from contextlib import redirect_stdout
from typing import Any

TESTS = pathlib.Path(__file__).resolve().parent
HERE = TESTS.parent
GOLDEN = TESTS / 'golden' / 'deepswe_orchestration.json'
for p in (str(HERE), str(TESTS)):
    if p not in sys.path:
        sys.path.insert(0, p)


def b64sha(obj: Any) -> str:
    raw = json.dumps(obj, sort_keys=True, separators=(',', ':'), default=str).encode()
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip('=')


def norm(x: Any, tmp: str | None = None) -> Any:
    if isinstance(x, str):
        x = x.replace(str(HERE), '<HERE>')
        return x.replace(tmp, '<TMP>') if tmp else x
    if isinstance(x, list | tuple):
        return [norm(v, tmp) for v in x]
    if isinstance(x, dict):
        return {k: norm(v, tmp) for k, v in x.items()}
    return x


class RecordingAws:
    region = 'ap-southeast-1'

    def __init__(self) -> None:
        self.scripts: list[str] = []

    def ssm(self, iid: str, script: str, timeout_s: int = 600) -> tuple[str, str, str]:
        self.scripts.append(script)
        return 'Success', '{}\n', ''


def fleet_bodies() -> dict[str, list[str]]:
    import fleet
    out: dict[str, list[str]] = {}
    cmds = {
        'setup': ['setup'], 'prepull': ['prepull'], 'check': ['check', '--kind', 'both', '--reps', '1', '--concurrency', '6'],
        'start': ['start', '--pass', 'main', '--pass', 'rep2', '--gateway-url', 'https://gw.example', '--concurrency', '6',
                  '--soft-cap', '1000', '--hard-cap', '1130', '--max-blocks', '7'],
        'start-pilot': ['start', '--pass', 'pilot', '--gateway-url', 'https://gw.example', '--concurrency', '6', '--soft-cap', '35',
                        '--hard-cap', '50', '--token-max-age-s', '600'],
        'status': ['status'], 'isolation': ['isolation'], 'isolation-show': ['isolation', '--show'], 'units': ['units'],
        'stop': ['stop'], 'stop-now': ['stop', '--now'], 'unstop': ['unstop'],
    }
    real = fleet.resolve
    for name, argv in cmds.items():
        rec = RecordingAws()
        fleet.resolve = lambda a, rec=rec: (rec, ['i-0a0b0c0d0e0f0a0b0'], None)
        try:
            with redirect_stdout(io.StringIO()):
                fleet.main(['--region', 'ap-southeast-1', '--instances', 'i-0a0b0c0d0e0f0a0b0', *argv])
        finally:
            fleet.resolve = real
        out[name] = rec.scripts
    return out


def fleet_strings() -> dict[str, Any]:
    import fleet
    ns = argparse.Namespace(gateway_url='https://gw.example', region='ap-southeast-1', concurrency=6, soft_cap=1000.0, hard_cap=1130.0,  # nosec B106: a Secrets Manager name or test argument, not a credential
                            secret_id='llmar-runner/client', passes=['main', 'rep2'], max_blocks=7, change_concurrency=True,
                            unstop_cap=True, token_max_age_s=600.0)
    sha = 'ab' * 32
    return {
        'consts': {k: str(getattr(fleet, k)) for k in ('ROOTS', 'DRIVER', 'PY', 'UNITS', 'ISOLATION', 'SHIP_PART_CHARS', 'PREAMBLE',
                                                         'ISOLATION_SHOW', 'BOOTSTRAP')},
        'dirs': {k: str(getattr(fleet, k).relative_to(HERE)) for k in ('FLEET', 'MERGED', 'PACK', 'REQUIREMENTS')},
        'driver_cmd': [fleet.driver_cmd(), fleet.driver_cmd('status'), fleet.driver_cmd('export', '--mode', 'light', '--base', '1-abcdef'),
                       fleet.driver_cmd('export-part', '--id', '1-abcdef', '--part', '0')],
        'unit_cmd': {u: fleet.unit_cmd(u, 'check', '--kind', 'both') for u in ('llmar-driver', 'llmar-check', 'llmar-prepull')},
        'isolation_cmd': fleet.isolation_cmd('ap-southeast-1'),
        'isolation_unit': fleet.unit_cmd('llmar-isolation', command=fleet.isolation_cmd('ap-southeast-1'), stop_timeout_s=300),
        'bootstrap': fleet.bootstrap_script(sha),
        'ship': fleet.ship_scripts(b'hello world' * 10, sha),
        'start_args': fleet.start_args(ns),
        'bodies': fleet_bodies(),
    }


def driver_strings(tmp: pathlib.Path) -> dict[str, Any]:
    import dataclasses

    import driver as drv
    env_file = tmp / 'runner.env'
    env_file.write_text('RUNNER_INDEX=1\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nPROXY_PORT=8088\nWORK_DIR=/srv/runner\n'
                        'RESULTS_PREFIX=runs/1/\nPREPULL_IMAGES="a:1 b:2"\nAWS_REGION=ap-southeast-1\n')
    env = drv.RunnerEnv.load(env_file)
    base = {'PATH': '/usr/bin', 'HOME': '/root', 'LANG': 'C', 'AWS_SECRET_ACCESS_KEY': 'x', 'OPENAI_API_KEY': 'y', 'CODEX_HOME': '/c',
            'DOCKER_HOST': 'unix:///var/run/docker.sock', 'ONLINE_NETWORK': 'llmar-online', 'ONLINE_DNS': '169.254.169.253'}
    return {
        'consts': {k: str(getattr(drv, k)) for k in ('DEFAULT_CONCURRENCY', 'MAX_CONCURRENCY', 'DEFAULT_SOFT_CAP', 'DEFAULT_HARD_CAP', 'MAX_RERUNS',
                                                       'MAX_REVERIFIES', 'WALL_TIMEOUT_H', 'STOP_GRACE_S', 'MIN_FREE_GB', 'MAX_CONSECUTIVE_HARNESS',
                                                       'PART_CHARS', 'LIGHT_MAX_FILE', 'LIGHT_ALWAYS', 'EXPORT_FILES', 'EXPORT_DIRS',
                                                       'HARBOR_ENV_ALLOW')},
        'paths': {k: str(v) for k, v in vars(drv.Paths(pathlib.Path('/srv/runner'))).items()},
        'runner_env': {k: str(v) for k, v in dataclasses.asdict(env).items() if v is not None},   # TB's optional keys are None here
        'harbor_env': norm(drv.harbor_subprocess_env(base)),
        'harbor_argv': drv.Harbor('harbor', env={}).run_argv(pathlib.Path('/w/attempts/x/job.json')),
        'regrade_argv': drv.Harbor('harbor', env={}).regrade_argv(pathlib.Path('/w/jobs/t'), pathlib.Path('/w/deep-swe/tasks/x'),
                                                                   pathlib.Path('/w/jobs'), 't-rv1-abcdef'),
        'check_job_config': {k: drv.check_job_config(k, pathlib.Path('/srv/runner/deep-swe/tasks/x'), pathlib.Path('/srv/runner/results/jobs'),
                                                     f'chk-{k}-abc', {'import_path': 'llmar_env:LlmarDockerEnvironment', 'delete': True})
                             for k in ('oracle', 'nop')},
    }


def fake_run(tmp: pathlib.Path) -> dict[str, Any]:
    """A two-shard synthetic plan run end to end with the fake Harbor: event and status key sets, the attempt
    classes in launch order, check summaries, and the export manifest keys."""
    from test_driver import FAKE, make_driver, make_plan

    import driver as drv
    import shardplan as sp
    plan, _ = make_plan(tmp)
    d, paths = make_driver(tmp, plan, behaviours={('*', 'C'): ['env', 'pass'], ('*', 'F'): ['verifier_timeout']}, max_blocks=3,
                           passes=('main',), concurrency=1)
    d.run()
    es = drv.read_jsonl(paths.events)
    keys: dict[str, list[str]] = {}
    for e in es:
        keys.setdefault(e['ev'], sorted(set(keys.get(e['ev'], [])) | set(e)))
    order = [(e['task'], e['arm'], e['attempt']) for e in es if e['ev'] == 'start']
    classes = [(e['key'], e['classification']['class'], e['classification']['action'], e['classification']['reason']) for e in es if e['ev'] == 'end']
    finals = [(e['key'], e['status'], e['score'], e['reruns']) for e in es if e['ev'] == 'final']
    d.write_status()
    status = json.loads(paths.status.read_text())
    tasks = sorted(sp.shard_tasks(plan)[0])
    checks = {tasks[0] + '/oracle': 'fail', tasks[1] + '/nop': 'pass', tasks[2] + '/oracle': 'infra'}
    os.environ['FAKE_HARBOR_CHECKS'] = json.dumps(checks)
    try:
        h = drv.Harbor(sys.executable, env={**drv.harbor_subprocess_env(), 'FAKE_HARBOR_CHECKS': os.environ['FAKE_HARBOR_CHECKS']})
        h.run_argv = lambda job: [sys.executable, str(FAKE), 'run', '--config', str(job), '--yes']
        env = drv.RunnerEnv(index=0, count=2, proxy_addr='172.17.0.1', proxy_port=8088, work_dir=tmp / 'chk')
        cp = drv.Paths(env.work_dir)
        summ = drv.run_checks(plan=plan, env=env, paths=cp, harbor=h, environment={'type': 'docker', 'delete': True},
                              kinds=('oracle', 'nop'), reps=1, concurrency=3, docker=None, log=drv.Log(None, echo=False), poll_s=0.02)
    finally:
        del os.environ['FAKE_HARBOR_CHECKS']
    summ.pop('updated', None)
    m = drv.build_export(paths, mode='light', runner=0, scanner=None)
    return {
        'event_keys': keys, 'launch_order': order, 'classes': classes, 'finals': finals,
        'status_keys': sorted(status), 'status_spend_keys': sorted(status['spend']), 'status_progress': status['progress'],
        'checks_summary': summ, 'check_event_keys': sorted({k for e in drv.read_jsonl(cp.check_events) for k in e}),
        'export_manifest_keys': sorted(m), 'export_top_level': sorted({f.split('/')[0] for f in m['files']}),
    }


def classify_grid() -> str:
    import classify as clf
    excs = [None, 'AgentTimeoutError', 'NonZeroAgentExitCodeError', 'EnvironmentStartTimeoutError', 'VerifierTimeoutError',
            'AddTestsDirError', 'ApiRateLimitError', 'ModelNotFoundError', 'AuthenticationError', 'WeirdError', 'CancelledError',
            'SandboxLikelyOutOfMemoryError']
    rewards = [None, 1.0, 0.0, -1.0]
    proxies = [None, {'calls': 0}, {'calls': 3, 'last_call': {'ok': False, 'origin': 'router', 'status': 500}},
               {'calls': 3, 'last_call': {'ok': False, 'origin': 'upstream', 'status': 400}},
               {'calls': 3, 'last_call': {'ok': False, 'origin': 'gateway', 'status': 503}}, {'cap_stopped': True}]
    out = []
    for e in excs:
        for r in rewards:
            res = {'exception_info': {'exception_type': e} if e else None,
                   'verifier_result': {'rewards': {'reward': r}} if r is not None else None,
                   'agent_execution': {'finished_at': 'x'}}
            for px in proxies:
                for pb in (None, 10):
                    for killed in (None, 'operator', 'wall-timeout'):
                        out.append(clf.classify(res, px, killed=killed, patch_bytes=pb, host={'oom_global_trial': 0}, rc=0))
            for k in ('oracle', 'nop'):
                out.append(clf.check_verdict(k, res, killed=None, rc=0))
    out.append(clf.classify(None, None, rc=1))
    return b64sha(out)


def plan_lists() -> dict[str, Any]:
    from test_shardplan import synth

    import shardplan as sp
    plan = sp.load_plan()
    lists = {f'{p}/{s}': sp.trials_of(plan, p, s) for p in plan['passes'] for s in range(plan['n_shards'])}
    tj, rj = synth(40)
    built, detail = sp.build(tj, rj, n_shards=4)
    return {'trials_of': b64sha(lists), 'n_trials': {k: len(v) for k, v in lists.items()}, 'task_strata': b64sha(sp.task_strata(plan)),
            'summary': sp.summary(plan), 'validate': sp.validate(plan), 'synthetic_build': b64sha(built),
            'synthetic_detail': b64sha(detail), 'block_order': sp.block_order('main', 1, [f't{i}' for i in range(20)]),
            'arm_order': sp.arm_order('rep2', 'x', sp.ARMS)}


def capture() -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        return norm({'fleet': fleet_strings(), 'driver': driver_strings(tmp), 'fake_run': fake_run(tmp / 'run'),
                     'classify_grid': classify_grid(), 'plan': plan_lists()}, td)


def canonical(x: Any) -> str:
    return json.dumps(x, indent=1, sort_keys=True, ensure_ascii=False) + '\n'


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    a = ap.parse_args()
    text = canonical(capture())
    if a.write:
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(text)
        print(f'wrote {GOLDEN} ({len(text)} bytes)')
    else:
        print('identical' if GOLDEN.exists() and GOLDEN.read_text() == text else 'DIFFERS')
