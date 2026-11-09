"""Parent tooling (design §9): pack and ship with on-runner checks, light (SSM) and full (S3) fetch with sha256
and member checks, merge into one dataset, systemd unit commands. The "runner" is a temp dir. The SSM fake runs
the generated bash scripts locally, so the real driver export runs too. No AWS."""
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile

import pytest

import fleet
import shardplan as sp
from test_driver import FakeProxy, make_driver, make_plan

REPO = pathlib.Path(__file__).resolve().parents[3]
ACCT = ''.join(str(i % 10) for i in range(1, 13))   # an account-shaped number built at run time (N5)


class LocalRunner:
    """A runner on the local disk: WORK_DIR, an env file, a venv python and the repo checkout (symlinked)."""

    def __init__(self, tmp: pathlib.Path, index: int = 0, count: int = 2, link_repo: bool = True):
        self.work = tmp / f'runner{index}'
        (self.work / 'venv' / 'bin').mkdir(parents=True)
        os.symlink(sys.executable, self.work / 'venv' / 'bin' / 'python')
        if link_repo:
            (self.work / 'repo' / 'experiments').mkdir(parents=True)
            os.symlink(REPO / 'experiments' / 'deepswe-harbor', self.work / 'repo' / 'experiments' / 'deepswe-harbor')
        self.env_file = tmp / f'runner{index}.env'
        self.env_file.write_text(f'RUNNER_INDEX={index}\nRUNNER_COUNT={count}\nPROXY_ADDR=172.17.0.1\nPROXY_PORT=8088\n'
                                 f'WORK_DIR={self.work}\nRESULTS_PREFIX=runs/{index}/\nDRIVER_PYTHON={sys.executable}\n')
        self.bin = tmp / f'bin{index}'
        self.bin.mkdir()

    def bash(self, script: str, extra_env: dict | None = None) -> tuple[str, str, str]:
        env = {'PATH': f'{self.bin}:{os.environ["PATH"]}', 'HOME': str(self.work), 'LLMAR_ENV_FILE': str(self.env_file), 'LLMAR_NO_IMDS': '1',
               **(extra_env or {})}
        r = subprocess.run(['bash', '-c', script], capture_output=True, text=True, env=env, timeout=300)  # nosec B603: argument list, no shell; arguments are the operator's own
        return ('Success' if r.returncode == 0 else 'Failed'), r.stdout, r.stderr


class FakeAws(fleet.Aws):
    def __init__(self, runners: dict[str, LocalRunner], bucket_dir: pathlib.Path | None = None, extra_env=None):
        super().__init__('ap-southeast-1', run=None)
        self.runners, self.bucket_dir, self.extra_env, self.calls = runners, bucket_dir, extra_env or {}, []

    def ssm(self, iid, script, timeout_s=600):
        self.calls.append((iid, script))
        return self.runners[iid].bash(script, self.extra_env)

    def s3_get(self, bucket, key, dest):
        shutil.copy(self.bucket_dir / bucket / key, dest)


def test_aws_cli_wrapper_builds_send_command_and_waits():
    seen = []

    def run(argv, **kw):
        seen.append(argv)
        if argv[1:3] == ['ssm', 'send-command']:
            params = json.loads(pathlib.Path(argv[argv.index('--parameters') + 1][len('file://'):]).read_text())
            assert params['commands'] == ['echo hi'] and params['executionTimeout'] == ['60']
            return subprocess.CompletedProcess(argv, 0, 'cmd-1\n', '')
        if len([a for a in seen if a[1:3] == ['ssm', 'get-command-invocation']]) == 1:
            return subprocess.CompletedProcess(argv, 255, '', 'An error occurred (InvocationDoesNotExist)')
        return subprocess.CompletedProcess(argv, 0, json.dumps(['Success', f'hi {ACCT}\n', '']), '')
    aws = fleet.Aws('ap-southeast-1', run=run, sleep=lambda s: None)
    st, out, err = aws.ssm('i-0123456789abcdef0', 'echo hi', 60)
    assert st == 'Success' and out.startswith('hi')
    assert all(a[-2:] == ['--region', 'ap-southeast-1'] for a in seen)
    assert fleet.mask(out) == 'hi <acct>\n'
    with pytest.raises(ValueError):
        aws.send('not-an-id', 'x')
    with pytest.raises(SystemExit):
        fleet.Aws('nowhere')


def test_pack_ship_and_bootstrap_on_a_local_runner(tmp_path):
    info = fleet.pack(tmp_path / 'pack.tgz')
    blob = (tmp_path / 'pack.tgz').read_bytes()
    assert info['sha256'] == hashlib.sha256(blob).hexdigest()
    with tarfile.open(tmp_path / 'pack.tgz') as t:
        names = t.getnames()
    assert 'experiments/deepswe-harbor/driver.py' in names and 'experiments/codex-deepswe/proxy.py' in names
    assert not any('/results/' in n or n.endswith('/results') or '/bin/' in n for n in names)
    r = LocalRunner(tmp_path, link_repo=False)
    keep = r.work / 'repo' / 'experiments' / 'deepswe-harbor' / 'bin' / 'codex-staged'
    keep.parent.mkdir(parents=True)
    keep.write_text('runner-local')
    fake_uv = r.bin / 'uv'
    fake_uv.write_text('#!/bin/bash\nif [ "$1" = venv ]; then mkdir -p "${@: -1}/bin"; ln -sf "$DRIVER_PYTHON" "${@: -1}/bin/python"; fi\nexit 0\n')
    fake_uv.chmod(0o755)
    shutil.rmtree(r.work / 'venv')
    fl = fleet.Fleet(FakeAws({'i-00000000000000000': r}, extra_env={'LLMAR_UV': str(fake_uv)}), ['i-00000000000000000'])
    out = fl.ship(blob, info['sha256'])
    assert out[0].startswith('ready '), out
    assert (r.work / 'repo' / 'experiments' / 'deepswe-harbor' / 'driver.py').is_file()
    assert (r.work / 'repo' / '.llmar-tarball-sha256').read_text().strip() == info['sha256']
    assert keep.read_text() == 'runner-local'
    out = fl.ship(blob, '0' * 64)
    assert 'FAILED' in out[0] and 'sha256 mismatch' in out[0]


@pytest.mark.parametrize('bad', ['symlink', 'outside', 'parent'])
def test_bootstrap_refuses_bad_tarballs(tmp_path, bad):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        ti = tarfile.TarInfo('experiments/deepswe-harbor/x.py')
        ti.size = 1
        t.addfile(ti, io.BytesIO(b'x'))
        if bad == 'symlink':
            ti = tarfile.TarInfo('experiments/deepswe-harbor/link')
            ti.type, ti.linkname = tarfile.SYMTYPE, '/etc/passwd'
            t.addfile(ti)
        else:
            ti = tarfile.TarInfo('elsewhere/evil.sh' if bad == 'outside' else 'experiments/deepswe-harbor/../../evil.sh')
            ti.size = 1
            t.addfile(ti, io.BytesIO(b'x'))
    blob = buf.getvalue()
    r = LocalRunner(tmp_path, link_repo=False)
    fl = fleet.Fleet(FakeAws({'i-00000000000000000': r}), ['i-00000000000000000'])
    out = fl.ship(blob, hashlib.sha256(blob).hexdigest())
    assert out[0].startswith('FAILED bootstrap')
    assert not (tmp_path / 'evil.sh').exists() and not (r.work / 'repo' / 'experiments' / 'deepswe-harbor' / 'x.py').exists()


def _run_shard(tmp_path, runner: LocalRunner, plan):
    """A driver run whose results land in the local runner's WORK_DIR."""
    d, paths = make_driver(tmp_path, plan, max_blocks=2, concurrency=4)
    shutil.copytree(paths.results, runner.work / 'results', dirs_exist_ok=True)
    return paths


def test_light_fetch_is_sha_checked_incremental_and_safe(tmp_path, monkeypatch):
    plan, plan_path = make_plan(tmp_path)
    r = LocalRunner(tmp_path)
    d, paths = make_driver(tmp_path, plan, max_blocks=2, concurrency=4)
    d.run()
    shutil.copytree(paths.results, r.work / 'results')
    leak = r.work / 'results' / 'jobs' / 'leaky.txt'
    leak.write_text('authorization: Bearer ' + 'Z' * 40)
    out_dir = tmp_path / 'fleet'
    fl = fleet.Fleet(FakeAws({'i-00000000000000000': r}), ['i-00000000000000000'], out=out_dir)
    res = fl.fetch('light')[0]
    assert 'error' not in res, res
    mirror = out_dir / 'runner-0' / 'results'
    assert (mirror / 'attempts.jsonl').read_text() == (r.work / 'results' / 'attempts.jsonl').read_text()
    assert res['blocked'] == ['jobs/leaky.txt'] and not (mirror / 'jobs' / 'leaky.txt').exists()
    again = fl.fetch('light')[0]
    assert again['files'] == 0
    with open(r.work / 'results' / 'attempts.jsonl', 'a') as f:
        f.write('{"ev":"note"}\n')
    third = fl.fetch('light')[0]
    assert third['files'] == 1 and (mirror / 'attempts.jsonl').read_text().endswith('{"ev":"note"}\n')
    state = json.loads((out_dir / 'runner-0' / 'fetch-state.json').read_text())
    assert state['light']['last'] == third['export_id']


def test_full_fetch_goes_through_the_bucket(tmp_path):
    plan, _ = make_plan(tmp_path)
    r = LocalRunner(tmp_path)
    d, paths = make_driver(tmp_path, plan, max_blocks=1)
    d.run()
    shutil.copytree(paths.results, r.work / 'results')
    bucket = tmp_path / 's3'
    fake_aws = r.bin / 'aws'   # the runner's `aws s3 cp <file> s3://<bucket>/<key>`
    fake_aws.write_text(f'#!/bin/bash\n[ "$1 $2" = "s3 cp" ] || exit 9\nsrc="${{@: -2:1}}"; dst="${{@: -1}}"; '
                        f'p="{bucket}/${{dst#s3://}}"; mkdir -p "$(dirname "$p")"; cp "$src" "$p"\n')
    fake_aws.chmod(0o755)
    fl = fleet.Fleet(FakeAws({'i-00000000000000000': r}, bucket_dir=bucket), ['i-00000000000000000'], bucket='llmar-runner-results-x',
                     out=tmp_path / 'fleet')
    res = fl.fetch('full')[0]
    assert 'error' not in res, res
    keys = [str(p.relative_to(bucket)) for p in bucket.rglob('*') if p.is_file()]
    assert all(k.startswith('llmar-runner-results-x/runs/0/') for k in keys) and len(keys) == 2
    assert (tmp_path / 'fleet' / 'runner-0' / 'results' / 'attempts.jsonl').exists()
    assert list((tmp_path / 'fleet' / 'runner-0' / 'exports').glob('*.json'))


def _tar(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        for name, kind in members:
            ti = tarfile.TarInfo(name)
            if kind == 'file':
                ti.size = 1
                t.addfile(ti, io.BytesIO(b'x'))
            elif kind == 'link':
                ti.type, ti.linkname = tarfile.SYMTYPE, '/etc/passwd'
                t.addfile(ti)
            else:
                ti.type = tarfile.DIRTYPE
                t.addfile(ti)
    return buf.getvalue()


@pytest.mark.parametrize('members', [
    [('results/ok', 'file'), ('results/x', 'link')],
    [('results/../../evil', 'file')],
    [('/etc/evil', 'file')],
    [('elsewhere/evil', 'file')],
    [('results/dir', 'dir')],
])
def test_safe_extract_refuses_unsafe_members(tmp_path, members):
    dest = tmp_path / 'mirror'
    dest.mkdir()
    with pytest.raises((ValueError, tarfile.TarError)):
        fleet.safe_extract(_tar(members), dest)
    assert not any(dest.rglob('*'))


def test_merge_builds_one_dataset(tmp_path):
    plan, plan_path = make_plan(tmp_path)
    fleet_dir = tmp_path / 'fleet'
    for shard in (0, 1):
        proxy = FakeProxy(usd=2.0)
        d, paths = make_driver(tmp_path / f's{shard}', plan, shard=shard, proxy=proxy, max_blocks=2, concurrency=4,
                               behaviours={('*', 'C'): ['env', 'pass']})
        d.run()
        shutil.copytree(paths.results, fleet_dir / f'runner-{shard}' / 'results')
    summ = fleet.merge(fleet_dir, tmp_path / 'merged', plan_path, tasks_dir=tmp_path / 'tasks', tiers={t: 'frontier' for t in plan['tasks']})
    att = [json.loads(x) for x in (tmp_path / 'merged' / 'attempts.jsonl').read_text().splitlines()]
    fin = [json.loads(x) for x in (tmp_path / 'merged' / 'final.jsonl').read_text().splitlines()]
    assert summ['runners'] == [0, 1] and len(fin) == 2 * 2 * 4 and len(att) == len(fin) + 4   # each C had one rerun
    assert {r['runner'] for r in fin} == {0, 1}
    assert all(r['pred_tier'] == 'frontier' and r['job_name'] == r['trial_id'] for r in att)
    meta = [json.loads(x) for x in (tmp_path / 'merged' / 'harvest-meta.jsonl').read_text().splitlines()]
    assert all(m['jobs_dir'].endswith('/results/jobs') and m['task_dir'].startswith(str(tmp_path / 'tasks')) for m in meta)
    assert sum(1 for r in att if r['is_final']) == len(fin)
    assert summ['spent_usd'] == pytest.approx(2.0 * len(att))
    assert summ['classes'] == {'agent': len(fin), 'harness': 4}


def test_unit_and_start_commands():
    import argparse
    a = argparse.Namespace(gateway_url='https://gw.example/x', region='ap-southeast-1', concurrency=6, soft_cap=1000.0, hard_cap=1130.0,  # nosec B106: a Secrets Manager name or test argument, not a credential
                           secret_id='llmar-runner/client', passes=['main', 'rep2'], max_blocks=7, change_concurrency=False, unstop_cap=False)
    args = fleet.start_args(a)
    assert args[:3] == ['run', '--gateway-url', 'https://gw.example/x'] and args.count('--pass') == 2 and '--max-blocks' in args
    assert '--token-max-age-s' not in args
    a.token_max_age_s = 600.0
    assert fleet.start_args(a)[-2:] == ['--token-max-age-s', '600']
    a.token_max_age_s = None
    cmd = fleet.unit_cmd('llmar-driver', *args)
    assert 'systemd-run --unit=llmar-driver' in cmd and 'LimitCORE=0' in cmd and 'KillMode=mixed' in cmd
    assert 'is-active --quiet llmar-driver' in cmd
    a.gateway_url = 'http://plain'
    with pytest.raises(SystemExit):
        fleet.start_args(a)
    with pytest.raises(ValueError):
        fleet.unit_cmd('something-else')
    iso = fleet.unit_cmd('llmar-isolation', command=fleet.isolation_cmd('ap-southeast-1'))
    assert 'systemd-run --unit=llmar-isolation' in iso and 'isolation.py run --where runner --env llmar --harbor harbor' in iso
    assert '--out $WORK_DIR/results/isolation' in iso and 'driver.py' not in iso and 'isolation-exit=' in iso
    with pytest.raises(ValueError):
        fleet.isolation_cmd('x; rm -rf /')
    assert fleet.probe_image().split('@sha256:')[1].isalnum()
    assert fleet.isolation_verdict('PASS gate a\nreport: /x\nisolation-exit=0\nunit: inactive\n') == 'PASS'
    assert fleet.isolation_verdict('FAIL gate b\nisolation-exit=1\nunit: inactive\n') == 'FAIL (exit 1)'
    assert fleet.isolation_verdict('PASS gate a\nunit: active\n') == 'RUNNING'


def test_isolation_unit_command_runs_in_a_shell_and_reports_its_exit_code(tmp_path):
    """The generated systemd-run line, with systemd-run replaced by a stub that execs its command: $WORK_DIR is
    expanded in the outer script and the inner shell prints the suite's exit code."""
    r = LocalRunner(tmp_path)
    (r.bin / 'systemctl').write_text('#!/bin/bash\n[ "$1" = is-active ] && { [ "$2" = --quiet ] && exit 3; echo inactive; exit 0; }\nexit 0\n')
    (r.bin / 'systemd-run').write_text('#!/bin/bash\nwhile [ "${1#--}" != "$1" ]; do shift; done\nexec "$@" > "$WORK_DIR/unit.out" 2>&1\n')
    (r.bin / 'journalctl').write_text('#!/bin/bash\nexit 0\n')
    for f in ('systemctl', 'systemd-run', 'journalctl'):
        (r.bin / f).chmod(0o755)
    cmd = fleet.isolation_cmd('ap-southeast-1')
    run_args = 'run --where runner --env llmar --harbor harbor --region ap-southeast-1 --out $WORK_DIR/results/isolation'
    assert run_args in cmd
    cmd = cmd.replace(run_args, '--help')
    st, out, err = r.bash(fleet.script(fleet.unit_cmd('llmar-isolation', command=cmd)), {'WORK_DIR': str(r.work)})
    text = (r.work / 'unit.out').read_text()
    assert 'isolation-exit=0' in text and 'usage' in text.lower(), (st, err, text)
    assert "'--x y'" in fleet.driver_cmd('--x y')


def test_status_line():
    doc = {'state': 'running', 'driver_alive': True, 'progress': {'passes': {'main': {'blocks': 28, 'admitted': 5, 'blocks_done': 3, 'scored': 12, 'excluded': 0}},
                                                                    'attempts': 21, 'reruns': 1, 'classes': {'agent': 12, 'harness': 1}, 'throttled_429': 4},
           'proxy_state': {'settled_usd': 41.5, 'cap_usd': 1130.0}, 'in_flight': [{}, {}], 'free_gb': 120.0}
    line = fleet.status_line(2, doc)
    assert 'runner 2: running' in line and 'main:3/5/28b' in line and '429=4' in line and 'spend=$41.50/1130.0' in line
    assert fleet.status_line(1, {'error': 'Failed: x'}) == 'runner 1: Failed: x'


def test_requirements_file_matches_the_lock():
    assert fleet.REQUIREMENTS.read_text() == fleet.requirements_text()


def test_projection_uses_measured_kappa_and_prices_cut_options(tmp_path):
    tj, rj = __import__('test_shardplan').synth(8)
    plan, detail = sp.build(tj, rj, n_shards=2)
    plan_path = tmp_path / 'plan.json'
    sp.write_json(plan_path, plan)
    fleet_dir = tmp_path / 'fleet'
    d, paths = make_driver(tmp_path / 's0', plan, shard=0, proxy=FakeProxy(usd=3.0), concurrency=4)
    d.run()
    shutil.copytree(paths.results, fleet_dir / 'runner-0' / 'results')
    fleet.merge(fleet_dir, tmp_path / 'merged', plan_path)
    out = fleet.project(plan, detail, tmp_path / 'merged', min_n=2, cut_options=(1,))
    pub = detail['tasks']
    for arm in sp.ARMS:
        k = out['kappa'][arm]
        assert k['n'] == 4 and k['kappa'] == pytest.approx(12.0 / sum(sp.planning_cost(pub, t, arm) for t in sp.shard_tasks(plan)[0]), rel=1e-2)
    assert out['spent_usd']['0'] == pytest.approx(3.0 * 16)          # the main pass of shard 0 ran
    rem0 = sum(out['kappa'][t['arm']]['kappa'] * sp.planning_cost(pub, t['task'], t['arm'])
               for name in ('rep2', 'rep3') for t in sp.trials_of(plan, name, 0))
    assert out['remaining_usd']['0'] == pytest.approx(rem0, rel=1e-3)
    assert out['remaining_usd']['1'] > 0
    assert out['options']['cut rep3 to 1 blocks/shard']['projected_total_usd'] < out['projected_total_usd']
    assert out['options']['cut rep2 C to 1 blocks/shard']['projected_total_usd'] < out['projected_total_usd']


def test_start_refuses_caps_the_proxy_reserve_would_swallow():
    import argparse
    import hproxy
    assert fleet.proxy_reserve() == hproxy.DEFAULT_RESERVE_USD
    a = argparse.Namespace(gateway_url='https://gw.example/x', region='ap-southeast-1', concurrency=6, soft_cap=12.5, hard_cap=12.5,  # nosec B106: a Secrets Manager name or test argument, not a credential
                           secret_id='llmar-runner/client', passes=['pilot2'], max_blocks=None, change_concurrency=False, unstop_cap=True,
                           token_max_age_s=600.0)
    with pytest.raises(SystemExit, match='leaves'):
        fleet.start_args(a)                       # 0c's pilot: $12.50 − $10 reserve = $2.50
    a.hard_cap = 22.5
    args = fleet.start_args(a)
    assert args[args.index('--hard-cap') + 1] == '22.5' and '--unstop-cap' in args
    a.soft_cap = 15.0
    with pytest.raises(SystemExit, match='above the effective hard cap'):
        fleet.start_args(a)
    a.soft_cap, a.hard_cap = 1000.0, 1130.0
    fleet.start_args(a)


def _merged_fleet(tmp_path):
    plan, plan_path = make_plan(tmp_path)
    fleet_dir = tmp_path / 'fleet'
    d, paths = make_driver(tmp_path / 's0', plan, shard=0, max_blocks=1)
    d.run()
    shutil.copytree(paths.results, fleet_dir / 'runner-0' / 'results')
    return plan, plan_path, fleet_dir


def test_merge_takes_strata_json_for_tiers(tmp_path):
    """0c bug 1: --tiers with 73's strata.json (one JSON document, not JSON lines)."""
    plan, plan_path, fleet_dir = _merged_fleet(tmp_path)
    strata = tmp_path / 'strata.json'
    strata.write_text(json.dumps({'schema': 'deepswe-harbor-strata/v1', 'tasks': {t: {'stratum': 'frontier', 'stable': True} for t in plan['tasks']}},
                                 indent=1))
    fleet.merge_cli(tiers_path=str(strata), tasks_dir=None, run_harvest=False, region=None, fleet_dir=fleet_dir,
                    out=tmp_path / 'merged', plan_path=plan_path)
    att = [json.loads(x) for x in (tmp_path / 'merged' / 'attempts.jsonl').read_text().splitlines()]
    assert att and all(r['pred_tier'] == 'frontier' for r in att)
    jl = tmp_path / 'tiers.jsonl'
    jl.write_text(''.join(json.dumps({'task_id': t, 'pred_tier': 'standard'}) + '\n' for t in plan['tasks']))
    fleet.merge_cli(tiers_path=str(jl), tasks_dir=None, run_harvest=False, region=None, fleet_dir=fleet_dir,
                    out=tmp_path / 'merged', plan_path=plan_path)
    att = [json.loads(x) for x in (tmp_path / 'merged' / 'attempts.jsonl').read_text().splitlines()]
    assert all(r['pred_tier'] == 'standard' for r in att)


def test_merge_harvest_sets_the_region_first(tmp_path):
    """0c bug 2: harvest prices calls through codex-deepswe's pricing, which needs the experiment Region."""
    import hcommon  # noqa: F401
    import common
    plan, plan_path, fleet_dir = _merged_fleet(tmp_path)
    saved = list(common._REGION)   # noqa: SLF001
    try:
        common._REGION[:] = []     # noqa: SLF001
        with pytest.raises(SystemExit, match='--region'):
            fleet.merge_cli(tiers_path=None, tasks_dir=None, run_harvest=True, region=None, fleet_dir=fleet_dir,
                            out=tmp_path / 'merged', plan_path=plan_path)
        summ = fleet.merge_cli(tiers_path=None, tasks_dir=None, run_harvest=True, region='ap-southeast-1', fleet_dir=fleet_dir,
                               out=tmp_path / 'merged', plan_path=plan_path)
        assert common.region() == 'ap-southeast-1'
        rows = [json.loads(x) for x in (tmp_path / 'merged' / 'rows.jsonl').read_text().splitlines()]
        assert summ['harvested'] == len(rows) == summ['finals'] == 4
    finally:
        common._REGION[:] = saved   # noqa: SLF001
