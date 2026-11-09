"""Per-runner driver (design §9): block scheduling, reruns and re-verifies, caps, checkpoint, crash recovery, stop,
checks, host summaries and exports. A scripted fake `harbor` (tests/fake_harbor.py) and a fake proxy; no Docker,
no AWS, no network."""
import collections
import io
import json
import os
import pathlib
import sys
import tarfile
import threading
import time

import pytest

import classify as clf
import driver as drv
import shardplan as sp
from test_shardplan import synth

FAKE = pathlib.Path(__file__).with_name('fake_harbor.py')


class FakeProxy:
    """register/unregister/summary like hproxy.RunnerProxy; spend grows by `usd` per ended trial."""

    def __init__(self, usd=1.0, summaries=None):
        self.usd, self.summaries = usd, summaries or {}
        self.routes, self.settled, self.max_active, self.stopped = {}, 0.0, 0, None
        self.registered = []
        self.lock = threading.Lock()

    def register_trial(self, tid, arm):
        assert drv.TRIAL_ID_RE.match(tid)
        with self.lock:
            assert tid not in self.routes and tid not in self.registered
            self.routes[tid] = arm
            self.registered.append(tid)
            self.max_active = max(self.max_active, len(self.routes))
        return f'http://172.17.0.1:8088/r/{tid}/v1'

    def unregister_trial(self, tid):
        with self.lock:
            arm = self.routes.pop(tid)
            self.settled += self.usd
        base = {'trial_id': tid, 'arm': arm, 'spent_usd': self.usd, 'calls': 4, 'statuses': {'200': 4}, 'error_origins': {},
                'last_call': {'status': 200, 'origin': None, 'ok': True}, 'throttled': 0, 'cap_stopped': False}
        over = self.summaries.get(arm)
        return {**base, **(over(tid) if callable(over) else (over or {}))}

    def summary(self):
        return {'cap_usd': 1130.0, 'settled_usd': self.settled, 'stopped': self.stopped, 'inflight': len(self.routes)}


def make_plan(tmp_path, n=8, shards=2):
    tj, rj = synth(n)
    plan, _ = sp.build(tj, rj, n_shards=shards)
    p = tmp_path / 'plan.json'
    sp.write_json(p, plan)
    return plan, p


def job_config_factory(behaviours, sleep=0.05, calls=0):
    """behaviours: {(task, arm): [behaviour of attempt 1, attempt 2, …]} (default pass)."""
    counts = collections.Counter()
    lock = threading.Lock()

    def job_config(*, arm, trial_id, task_dir, jobs_dir, job_name, base_url):
        k = (task_dir.name, arm)
        with lock:
            n = counts[k]
            counts[k] += 1
        seq = behaviours.get(k) or behaviours.get(('*', arm)) or ['pass']
        assert f'/r/{trial_id}/' in base_url
        return {'job_name': job_name, 'jobs_dir': str(jobs_dir), 'n_attempts': 1, 'n_concurrent_trials': 1, 'quiet': True,
                'retry': {'max_retries': 0}, 'agents': [{'name': 'codex'}], 'tasks': [{'path': str(task_dir)}],
                'llmar_test': {'behaviour': seq[min(n, len(seq) - 1)], 'arm': arm, 'sleep': sleep, 'calls': calls, 'base_url': base_url}}
    return job_config


def make_driver(tmp_path, plan, *, behaviours=None, proxy=None, passes=('main',), shard=0, gate=False, sleep=0.05, calls=0, **kw):
    env = drv.RunnerEnv(index=shard, count=plan['n_shards'], proxy_addr='172.17.0.1', proxy_port=8088, work_dir=tmp_path / 'work')
    paths = drv.Paths(env.work_dir)
    paths.mkdirs()
    harbor = drv.Harbor(sys.executable, env={**drv.harbor_subprocess_env(), 'FAKE_HARBOR_LOG': str(tmp_path / 'harbor.log'),
                                             **({'FAKE_HARBOR_REGRADE': str(tmp_path / 'regrade.json')} if (tmp_path / 'regrade.json').exists() else {})})
    harbor.run_argv = lambda job: [sys.executable, str(FAKE), 'run', '--config', str(job), '--yes']
    harbor.regrade_argv = lambda src, t, j, n: [sys.executable, str(FAKE), 'jobs', 'regrade', str(src), '--task-path', str(t),
                                               '--jobs-dir', str(j), '--job-name', n, '--n-concurrent', '1', '--yes']
    d = drv.Driver(plan=plan, env=env, paths=paths, passes=list(passes), proxy=proxy or FakeProxy(), harbor=harbor,
                   job_config=job_config_factory(behaviours or {}, sleep, calls), poll_s=0.02, grace_s=1.0, min_free_gb=0.0,
                   disk_paths=[tmp_path], check_gate_on=gate, log=drv.Log(paths.log, echo=False), **kw)
    return d, paths


def events(paths, ev=None):
    es = drv.read_jsonl(paths.events)
    return [e for e in es if ev is None or e.get('ev') == ev]


def harbor_log(tmp_path):
    p = tmp_path / 'harbor.log'
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def test_full_shard_runs_blocks_in_order_with_arms_in_plan_order(tmp_path):
    plan, _ = make_plan(tmp_path)
    proxy = FakeProxy()
    d, paths = make_driver(tmp_path, plan, proxy=proxy, concurrency=3)
    out = d.run()
    assert out['state'] == 'done'
    finals = events(paths, 'final')
    items = sp.trials_of(plan, 'main', 0)
    assert len(finals) == len(items) and all(f['status'] == 'scored' and f['score'] == 1.0 for f in finals)
    starts = events(paths, 'start')
    assert [(s['block'], s['arm']) for s in starts] == [(i['block'], i['arm']) for i in items]
    assert proxy.max_active <= 3 and not proxy.routes
    assert len(set(proxy.registered)) == len(items)          # a fresh trial id per attempt
    st = json.loads(paths.status.read_text())
    assert st['state'] == 'done' and st['progress']['passes']['main']['blocks_done'] == len(plan['passes']['main']['shards']['0'])


def test_start_events_carry_the_plan_hash_and_the_plan_shard(tmp_path):
    plan, plan_path = make_plan(tmp_path)
    plan['_sha256'] = sp.sha256_file(plan_path)
    d, paths = make_driver(tmp_path, plan, max_blocks=1)
    d.run()
    starts = events(paths, 'start')
    assert starts and all(s['plan_sha256'] == plan['_sha256'] and s['shard'] == plan['tasks'][s['task']]['shard'] for s in starts)
    assert events(paths, 'run-start')[0]['plan_sha256'] == plan['_sha256']


def test_harbor_gets_an_allowlisted_environment(tmp_path, monkeypatch):
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'x')
    monkeypatch.setenv('OPENAI_API_KEY', 'x')
    monkeypatch.setenv('CODEX_AUTH_JSON_PATH', '/x')
    env = drv.harbor_subprocess_env()
    assert not [k for k in env if k.startswith(('AWS_', 'OPENAI_', 'CODEX_'))]
    assert env['HARBOR_TELEMETRY'] == '0' and str(drv.HERE) in env['PYTHONPATH']
    assert set(env) <= set(drv.HARBOR_ENV_ALLOW) | {'HARBOR_TELEMETRY', 'PYTHONPATH'}


def test_infra_errors_are_rerun_at_most_twice_then_excluded(tmp_path):
    plan, _ = make_plan(tmp_path)
    t0, t1 = [b['task'] for b in plan['passes']['main']['shards']['0'][:2]]
    d, paths = make_driver(tmp_path, plan, behaviours={(t0, 'A'): ['env', 'crash', 'pass'], (t1, 'F'): ['env', 'env', 'env', 'pass']},
                           concurrency=4)
    d.run()
    fin = {f['key']: f for f in events(paths, 'final')}
    a = fin[drv.key_of('main', t0, 'A', 1)]
    assert (a['status'], a['attempts'], a['score']) == ('scored', 3, 1.0)
    f = fin[drv.key_of('main', t1, 'F', 1)]
    assert (f['status'], f['attempts'], f['class']) == ('excluded', 3, 'harness')
    reruns = [s for s in events(paths, 'start') if s['task'] == t0 and s['arm'] == 'A']
    assert [s['attempt'] for s in reruns] == [1, 2, 3] and reruns[1]['rerun_of'] == reruns[0]['trial_id']


def test_agent_outcomes_are_never_rerun(tmp_path):
    plan, _ = make_plan(tmp_path)
    t0 = plan['passes']['main']['shards']['0'][0]['task']
    d, paths = make_driver(tmp_path, plan, behaviours={(t0, 'C'): ['timeout'], (t0, 'B'): ['fail'], (t0, 'F'): ['nonzero']})
    d.run()
    fin = {f['key']: f for f in events(paths, 'final')}
    for arm in ('C', 'B', 'F'):
        f = fin[drv.key_of('main', t0, arm, 1)]
        assert (f['status'], f['class'], f['score'], f['attempts']) == ('scored', 'agent', 0.0, 1)


def test_router_errors_score_zero_and_upstream_errors_rerun(tmp_path):
    plan, _ = make_plan(tmp_path)
    t0 = plan['passes']['main']['shards']['0'][0]['task']
    calls = collections.Counter()

    def upstream_once(tid):
        calls['B'] += 1
        return {'last_call': {'status': 503, 'origin': 'upstream', 'ok': False}} if calls['B'] == 1 else {}
    proxy = FakeProxy(summaries={'C': {'last_call': {'status': 500, 'origin': 'router', 'ok': False}}, 'B': upstream_once})
    d, paths = make_driver(tmp_path, plan, proxy=proxy, behaviours={(t0, 'C'): ['nonzero'], (t0, 'B'): ['nonzero', 'pass']},
                           concurrency=1, max_blocks=1)
    d.run()
    fin = {f['key']: f for f in events(paths, 'final')}
    assert (fin[drv.key_of('main', t0, 'C', 1)]['class'], fin[drv.key_of('main', t0, 'C', 1)]['score']) == ('sut', 0.0)
    b = fin[drv.key_of('main', t0, 'B', 1)]
    assert (b['class'], b['attempts'], b['score']) == ('agent', 2, 1.0)


def test_verifier_timeouts_are_reverified_only(tmp_path):
    plan, _ = make_plan(tmp_path)
    t0 = plan['passes']['main']['shards']['0'][0]['task']
    (tmp_path / 'regrade.json').write_text(json.dumps(['verifier_timeout', 'pass']))
    d, paths = make_driver(tmp_path, plan, behaviours={(t0, 'A'): ['verifier_timeout']}, max_blocks=1)
    d.run()
    f = {f['key']: f for f in events(paths, 'final')}[drv.key_of('main', t0, 'A', 1)]
    assert (f['status'], f['class'], f['score'], f['attempts'], f['reverifies']) == ('scored', 'agent', 1.0, 1, 2)
    hl = harbor_log(tmp_path)
    assert sum(1 for r in hl if r['cmd'] == 'run' and r['task'] == t0) == 4          # no agent rerun
    assert [r['job'].split('-rv')[1].split('-')[0] for r in hl if r['cmd'] == 'regrade'] == ['1', '2']


def test_soft_cap_stops_new_blocks_but_finishes_admitted_ones(tmp_path):
    plan, _ = make_plan(tmp_path, n=16)
    proxy = FakeProxy(usd=1.0)
    d, paths = make_driver(tmp_path, plan, proxy=proxy, concurrency=2, soft_cap=5.0)
    out = d.run()
    assert out['state'] == 'paused' and 'soft cap' in out['reason']
    starts = events(paths, 'start')
    blocks = {s['block'] for s in starts}
    finals = events(paths, 'final')
    assert len(finals) == 4 * len(blocks)                   # only complete blocks
    assert 2 <= len(blocks) < len(plan['passes']['main']['shards']['0'])


def test_hard_cap_stop_halts_everything_and_excludes_cap_stopped_trials(tmp_path):
    plan, _ = make_plan(tmp_path)
    proxy = FakeProxy()

    def cap(tid):
        proxy.stopped = 'cap'
        return {'cap_stopped': True}
    proxy.summaries = {'F': cap}
    d, paths = make_driver(tmp_path, plan, proxy=proxy, concurrency=1)
    out = d.run()
    assert out['state'] in ('halted', 'stopped') and 'hard cap' in out['reason']
    f = [x for x in events(paths, 'final') if x['arm'] == 'F']
    assert f and f[0]['status'] == 'excluded' and f[0]['class'] == 'cap_stop'
    assert len(events(paths, 'start')) <= 4


def test_checkpoint_pauses_after_max_blocks_then_resumes(tmp_path):
    plan, _ = make_plan(tmp_path, n=12)
    d, paths = make_driver(tmp_path, plan, concurrency=4, max_blocks=2)
    out = d.run()
    assert out['state'] == 'paused' and 'checkpoint' in out['reason']
    assert len({s['block'] for s in events(paths, 'start')}) == 2
    d2, _ = make_driver(tmp_path, plan, concurrency=4)
    assert d2.run()['state'] == 'done'
    starts = events(paths, 'start')
    assert len(starts) == len(sp.trials_of(plan, 'main', 0)) and len({s['trial_id'] for s in starts}) == len(starts)


def test_crash_recovery_ends_orphans_as_harness_and_reruns_them(tmp_path):
    plan, _ = make_plan(tmp_path)
    d, paths = make_driver(tmp_path, plan, max_blocks=1)
    it = sp.trials_of(plan, 'main', 0)[0]
    k = drv.key_of('main', it['task'], it['arm'], 1)
    drv.append_jsonl(paths.events, {'ev': 'start', 'trial_id': 'a' * 32, 'key': k, 'attempt': 1, 'pid': None,
                                    **{x: it[x] for x in ('pass', 'phase', 'block', 'task', 'arm', 'rep')}})
    d, paths = make_driver(tmp_path, plan, max_blocks=1)
    d.run()
    ends = {e['trial_id']: e for e in events(paths, 'end')}
    assert ends['a' * 32]['killed'] == 'driver-restart' and ends['a' * 32]['classification']['class'] == 'harness'
    f = {f['key']: f for f in events(paths, 'final')}[k]
    assert (f['status'], f['attempts']) == ('scored', 2)


def test_stop_now_cancels_running_trials_and_resume_reruns_them_without_using_reruns(tmp_path):
    plan, _ = make_plan(tmp_path)
    d, paths = make_driver(tmp_path, plan, behaviours={('*', 'A'): ['hang', 'pass'], ('*', 'F'): ['hang', 'pass'],
                                                       ('*', 'C'): ['hang', 'pass'], ('*', 'B'): ['hang', 'pass']},
                           concurrency=2, max_blocks=1)
    th = threading.Thread(target=d.run)
    th.start()
    for _ in range(200):
        if len(d.running) == 2 and len(harbor_log(tmp_path)) >= 2:
            break
        time.sleep(0.05)
    d.stop_now.set()
    th.join(30)
    assert not th.is_alive()
    ends = events(paths, 'end')
    assert len(ends) == 2 and all(e['classification']['class'] == 'cancelled' for e in ends)
    d2, _ = make_driver(tmp_path, plan, concurrency=2, max_blocks=1)
    d2.run()
    fin = events(paths, 'final')
    assert len(fin) == 4 and all(f['status'] == 'scored' for f in fin)


def test_wall_timeout_kills_a_stuck_harbor(tmp_path):
    plan, _ = make_plan(tmp_path)
    t0 = plan['passes']['main']['shards']['0'][0]['task']
    d, paths = make_driver(tmp_path, plan, behaviours={(t0, 'A'): ['hang', 'pass']}, max_blocks=1, wall_timeout_s=1.0)
    d.run()
    ends = [e for e in events(paths, 'end') if e['killed']]
    assert ends and ends[0]['killed'] == 'wall-timeout' and ends[0]['classification']['class'] == 'harness'


def test_consecutive_harness_errors_halt_the_runner(tmp_path):
    plan, _ = make_plan(tmp_path, n=12)
    d, paths = make_driver(tmp_path, plan, behaviours={('*', a): ['crash'] for a in 'AFCB'}, concurrency=1, max_consecutive_harness=3)
    out = d.run()
    assert out['state'] == 'halted' and 'harness errors in a row' in out['reason']
    assert len(events(paths, 'start')) == 3


def test_three_passes_in_order_with_a_checkpoint_cut(tmp_path):
    plan, p = make_plan(tmp_path)
    sp.cut_pass(plan, 'rep2', 1, 'C on a subset', ('C',))
    d, paths = make_driver(tmp_path, plan, passes=('main', 'rep2', 'rep3'), concurrency=4)
    assert d.run()['state'] == 'done'
    starts = events(paths, 'start')
    assert [s['pass'] for s in starts] == ['main'] * 16 + ['rep2'] * 13 + ['rep3'] * 8
    assert {(s['phase'], s['rep']) for s in starts if s['pass'] != 'main'} == {('repeat', 2), ('repeat', 3)}
    assert sum(1 for s in starts if s['pass'] == 'rep2' and s['arm'] == 'C') == 1


def test_check_gate_and_dropped_tasks(tmp_path):
    plan, _ = make_plan(tmp_path)
    with pytest.raises(SystemExit):
        make_driver(tmp_path, plan, gate=True)
    env = drv.RunnerEnv(index=0, count=2, proxy_addr='172.17.0.1', proxy_port=8088, work_dir=tmp_path / 'work')
    paths = drv.Paths(env.work_dir)
    tasks = sorted(sp.shard_tasks(plan)[0])
    bad_oracle, base_passes, flaky = tasks[0], tasks[1], tasks[2]
    os.environ['FAKE_HARBOR_CHECKS'] = json.dumps({f'{bad_oracle}/oracle': 'fail', f'{base_passes}/nop': 'pass', f'{flaky}/oracle': 'infra'})
    try:
        h = drv.Harbor(sys.executable, env={**drv.harbor_subprocess_env(), 'FAKE_HARBOR_CHECKS': os.environ['FAKE_HARBOR_CHECKS']})
        h.run_argv = lambda job: [sys.executable, str(FAKE), 'run', '--config', str(job), '--yes']
        summ = drv.run_checks(plan=plan, env=env, paths=paths, harbor=h, environment={'type': 'docker', 'delete': True},
                              kinds=('oracle', 'nop'), reps=1, concurrency=3, docker=None, log=drv.Log(None, echo=False), poll_s=0.02)
    finally:
        del os.environ['FAKE_HARBOR_CHECKS']
    assert summ['dropped'] == sorted([bad_oracle, base_passes])
    assert summ['unresolved'] == [flaky]                     # infra errors never drop a task
    ce = drv.read_jsonl(paths.check_events)
    assert sum(1 for e in ce if e['task'] == flaky and e['kind'] == 'oracle') == 3   # 1 + 2 infra retries
    with pytest.raises(SystemExit):
        make_driver(tmp_path, plan, gate=True)                # unresolved check blocks live runs
    s = json.loads(paths.check_summary.read_text())
    s['tasks'][flaky].update(ok=True)
    sp.write_json(paths.check_summary, s)
    d, paths = make_driver(tmp_path, plan, gate=True)
    assert d.dropped == {bad_oracle, base_passes}
    d.run()
    assert not {s['task'] for s in events(paths, 'start')} & {bad_oracle, base_passes}


def test_check_job_configs_never_call_a_model():
    cfg = drv.check_job_config('oracle', pathlib.Path('/t/x'), pathlib.Path('/j'), 'chk-oracle-1', {'type': 'docker'})
    assert cfg['agents'] == [{'name': 'oracle'}] and cfg['retry']['max_retries'] == 0
    assert drv.check_job_config('nop', pathlib.Path('/t/x'), pathlib.Path('/j'), 'c', {})['agents'] == [{'name': 'nop'}]


def test_job_config_must_be_one_trial_without_harbor_retries(tmp_path):
    plan, _ = make_plan(tmp_path)
    d, paths = make_driver(tmp_path, plan, max_blocks=1, max_consecutive_harness=99)
    good = d.job_config

    def bad(**kw):
        return {**good(**kw), 'retry': {'max_retries': 2}}
    d.job_config = bad
    d.run()
    ends = events(paths, 'end')
    assert ends and all(e['classification']['class'] == 'harness' for e in ends)
    assert not harbor_log(tmp_path)


# ---------------------------------------------------------------- host health

def test_metrics_delta():
    m0 = {'ts': 0, 'cpu_jiffies': {'user': 0, 'idle': 0, 'steal': 0, 'iowait': 0}, 'oom_kill': 2, 'pswpin': 10, 'pswpout': 0,
          'psi': {'memory': {'some_total_us': 0, 'full_total_us': 0}}, 'load': [1.0, 1, 1], 'mem_available_kb': 9_000_000,
          'swap_total_kb': 100, 'swap_free_kb': 100, 'docker_free_bytes': 100e9, 'ncpu': 8}
    m1 = {**m0, 'ts': 100, 'cpu_jiffies': {'user': 80, 'idle': 10, 'steal': 5, 'iowait': 5}, 'oom_kill': 3, 'pswpin': 30,
          'psi': {'memory': {'some_total_us': 5e6, 'full_total_us': 1e6}}, 'load': [6.0, 3, 2], 'mem_available_kb': 1_000_000, 'swap_free_kb': 40}
    d = drv.metrics_delta(m0, m1)
    assert d['cpu_steal'] == 0.05 and d['oom_kill'] == 1 and d['pswpin'] == 20
    assert d['psi_memory_some'] == 0.05 and d['psi_memory_full'] == 0.01
    assert d['load1_max'] == 6.0 and d['mem_available_kb_min'] == 1_000_000 and d['swap_used_kb_max'] == 60
    assert drv.metrics_delta(None, m1) == {}


class FakeWatch:
    def __init__(self, recs):
        self.recs = recs

    def window(self, t0, t1):
        return [r for r in self.recs if t0 - 1 <= r['ts'] <= t1 + 1]


def test_host_oom_attribution_global_vs_container_limit():
    trial = 'my-task__AbC1234'
    pre = drv.compose_prefix(trial)
    assert pre == 'my-task__abc1234'
    cid, other = 'a' * 64, 'b' * 64
    dw = FakeWatch([{'ts': 10, 'action': 'start', 'id': cid, 'project': pre + '__env'},
                    {'ts': 20, 'action': 'oom', 'id': cid, 'project': pre + '__env'},
                    {'ts': 21, 'action': 'die', 'id': cid, 'project': pre + '__env', 'exit_code': '137'},
                    {'ts': 22, 'action': 'die', 'id': other, 'project': 'another__x__env', 'exit_code': '137'}])
    kw = FakeWatch([drv.parse_kernel_oom(f'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),oom_memcg=/system.slice/docker-{cid}.scope,'
                                         f'task_memcg=/system.slice/docker-{cid}.scope,task=python3,pid=1,uid=0', 20),
                    drv.parse_kernel_oom(f'oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),task_memcg=/system.slice/docker-{other}.scope,'
                                         'task=node,pid=2,uid=0', 22)])
    h = drv.host_oom_summary(trial, 0, 30, dw, kw)
    assert h == {**h, 'oom_memcg_trial': 1, 'oom_global_trial': 0, 'oom_global_window': 1, 'docker_oom': 1, 'exit137': 1, 'containers': 1}
    assert not clf.host_oom(h)              # this trial hit its own limit; another container was the global victim
    h2 = drv.host_oom_summary('another__x', 0, 30, FakeWatch([{'ts': 22, 'action': 'die', 'id': other, 'project': 'another__x__env', 'exit_code': '137'}]), kw)
    assert clf.host_oom(h2)


def test_docker_event_and_journal_parsing():
    line = json.dumps({'Type': 'container', 'Action': 'die', 'id': 'c' * 64, 'timeNano': 1_700_000_000_123_000_000,
                       'Actor': {'ID': 'c' * 64, 'Attributes': {'name': 'n', 'com.docker.compose.project': 'p', 'exitCode': '137'}}})
    e = drv.parse_docker_event(line)
    assert e['action'] == 'die' and e['exit_code'] == '137' and e['project'] == 'p' and abs(e['ts'] - 1_700_000_000.123) < 1e-3
    assert drv.parse_docker_event('{"Type":"network"}') is None
    j = drv.parse_journal_line('1700000000.5 host kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),task_memcg=/docker/' + 'd' * 64 + ',task=x,pid=1,uid=0')
    assert j == {'ts': 1700000000.5, 'constraint': 'CONSTRAINT_NONE', 'container_id': 'd' * 64}
    assert drv.parse_journal_line('1700000000.5 host kernel: something else') is None


class FakeRun:
    def __init__(self, outputs):
        self.outputs, self.calls = outputs, []

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        import subprocess
        key = ' '.join(argv[1:3])
        return subprocess.CompletedProcess(argv, 0, self.outputs.get(key, ''), '')


def test_docker_cleanup_only_touches_the_trials_projects():
    fr = FakeRun({'ps -a': 'c1 mytask__abc__env\nc2 other__x__env\nc3 mytask__abc__verifier__trial\n',
                  'network ls': 'n1 mytask__abc__env\nn2 other__x__env\n'})
    out = drv.Docker('docker', run=fr).cleanup(['mytask__abc'])
    assert out == {'containers': 2, 'networks': 1}
    assert ['docker', 'rm', '-f', 'c1', 'c3'] in fr.calls and ['docker', 'network', 'rm', 'n1'] in fr.calls
    drv.Docker('docker', run=fr).prune_networks()
    assert fr.calls[-1] == ['docker', 'network', 'prune', '-f', '--filter', 'label=com.docker.compose.project']


# ---------------------------------------------------------------- env file, lock, status, export

def test_runner_env_file(tmp_path):
    f = tmp_path / 'env'
    f.write_text('RUNNER_INDEX=2\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nPROXY_PORT=8088\nWORK_DIR=/srv/runner\nRESULTS_PREFIX=runs/2/\n'
                 'PREPULL_IMAGES="alpine:3@sha256:aa gogost/gost:3@sha256:bb"\nDRIVER_PYTHON=/opt/uv/python/x/bin/python3.13\n')
    e = drv.RunnerEnv.load(f)
    assert (e.index, e.count, e.proxy_addr, e.results_prefix) == (2, 4, '172.17.0.1', 'runs/2/')
    assert e.prepull == ('alpine:3@sha256:aa', 'gogost/gost:3@sha256:bb')
    f.write_text('RUNNER_INDEX=4\nRUNNER_COUNT=4\n')
    with pytest.raises(SystemExit):
        drv.RunnerEnv.load(f)


def test_proxy_bind_assertion():
    e = drv.RunnerEnv(index=0, count=1, proxy_addr='172.17.0.1', proxy_port=8088, work_dir=pathlib.Path('/x'))
    drv.assert_proxy_bind(('172.17.0.1', 8088), e)
    for addr in (('0.0.0.0', 8088), ('172.17.0.1', 9000), ('127.0.0.1', 8088)):  # nosec B104: test data, the wildcard host must be refused
        with pytest.raises(SystemExit):
            drv.assert_proxy_bind(addr, e)
    with pytest.raises(SystemExit):
        drv.assert_proxy_bind(('0.0.0.0', 8088), drv.RunnerEnv(index=0, count=1, proxy_addr='0.0.0.0', proxy_port=8088, work_dir=pathlib.Path('/x')))  # nosec B104: test data, the wildcard host must be refused


def test_run_lock_is_exclusive(tmp_path):
    paths = drv.Paths(tmp_path)
    with drv.run_lock(paths):
        assert drv.lock_holder(paths) == os.getpid()
        with pytest.raises(SystemExit):
            with drv.run_lock(paths):
                pass
    assert drv.lock_holder(paths) is None


def test_status_command_reads_events_and_fits_one_ssm_read(tmp_path, capsys):
    plan, plan_path = make_plan(tmp_path)
    d, paths = make_driver(tmp_path, plan, max_blocks=1)
    d.run()
    envf = tmp_path / 'env'
    envf.write_text(f'RUNNER_INDEX=0\nRUNNER_COUNT=2\nPROXY_ADDR=172.17.0.1\nWORK_DIR={tmp_path / "work"}\n')
    drv.main(['--env-file', str(envf), '--plan', str(plan_path), 'status'])
    doc = json.loads(capsys.readouterr().out)
    assert doc['progress']['passes']['main']['blocks_done'] == 1 and doc['driver_alive'] is False
    assert len(json.dumps(doc)) < 20_000


def _results_tree(paths):
    paths.mkdirs()
    (paths.results / 'attempts.jsonl').write_text('{"ev":"start"}\n')
    tdir = paths.jobs / ('f' * 32) / 'task__abc1234'
    (tdir / 'verifier').mkdir(parents=True)
    (tdir / 'result.json').write_text(json.dumps({'big': 'x' * 3_000_000}))
    (tdir / 'verifier' / 'reward.json').write_text('{"reward": 1}')
    (tdir / 'agent').mkdir()
    (tdir / 'agent' / 'codex.txt').write_text('y' * 2_000_000)
    (tdir / 'agent' / 'leak.txt').write_text('authorization: Bearer ' + 'A' * 40)
    # A JWT-shaped string, joined at run time so this file itself scans clean (it is in the commit set).
    (tdir / 'agent' / 'jwt.txt').write_text('.'.join(['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlc2lnbmF0dXJl']))
    (paths.results / 'proxy').mkdir(exist_ok=True)
    (paths.results / 'proxy' / 'calls.jsonl').write_text('{"trial_id":"x"}\n')
    (paths.results / 'proxy' / 'token-cache.json').write_text('{}')
    (paths.work / 'secret-elsewhere.txt').write_text('nope')
    os.symlink('/etc/passwd', tdir / 'agent' / 'link')
    return tdir


def test_export_allowlist_blocks_secrets_skips_big_files_and_is_incremental(tmp_path):
    paths = drv.Paths(tmp_path / 'work')
    tdir = _results_tree(paths)
    m = drv.build_export(paths, mode='light', runner=1)
    rel = lambda p: str(p.relative_to(paths.results))  # noqa: E731
    assert rel(tdir / 'result.json') in m['files']                      # always included despite its size
    assert rel(tdir / 'agent' / 'codex.txt') in m['skipped']
    assert sorted(m['blocked']) == sorted([rel(tdir / 'agent' / 'leak.txt'), rel(tdir / 'agent' / 'jwt.txt')])
    assert not any('token' in k or 'link' in k for k in m['files'])
    assert 'proxy/calls.jsonl' in m['files'] and 'attempts.jsonl' in m['files']
    blob = (paths.exports / m['export_id'] / 'payload.tar.gz').read_bytes()
    assert drv.sha256_bytes(blob) == m['tar_sha256']
    with tarfile.open(fileobj=io.BytesIO(blob)) as t:
        names = t.getnames()
    assert all(n.startswith('results/') for n in names) and not any('secret-elsewhere' in n for n in names)
    parts = sorted((paths.exports / m['export_id'] / 'parts').iterdir())
    assert len(parts) == m['parts'] and all(len(p.read_text()) <= drv.PART_CHARS for p in parts)
    (paths.results / 'attempts.jsonl').write_text('{"ev":"start"}\n{"ev":"end"}\n')
    m2 = drv.build_export(paths, mode='light', runner=1, base=drv.latest_manifest(paths, m['export_id']))
    assert list(m2['files']) == ['attempts.jsonl'] and m2['base'] == m['export_id']
    iso = paths.results / 'isolation' / '20261105T140000Z' / 'llmar' / 'report.json'
    iso.parent.mkdir(parents=True)
    iso.write_text('{"gates": []}')
    m3 = drv.build_export(paths, mode='light', runner=1, base=drv.latest_manifest(paths, m2['export_id']))
    assert 'isolation/20261105T140000Z/llmar/report.json' in m3['files']
    full = drv.build_export(paths, mode='full', runner=1)
    assert rel(tdir / 'agent' / 'codex.txt') in full['files'] and full['blocked']


@pytest.mark.parametrize('agent', ['codex', 'claude-code'])
def test_export_name_rule_reads_the_file_name_not_its_directories(tmp_path, agent):
    """0c (TB main, 2026-11-07): the old whole-path search matched the trial dirs of count-dataset-tokens and
    vulnerable-secret and dropped those trials from every export. Only a file's own name counts now."""
    paths = drv.Paths(tmp_path / 'work')
    paths.mkdirs()
    kept, dropped = [], []
    for task in ('count-dataset-tokens', 'vulnerable-secret', 'rotate-credentials'):
        t = paths.jobs / ('a' * 32) / f'{task}__Ab12Cd3'
        for f in ('result.json', 'verifier/ctrf.json', 'verifier/test-stdout.txt', 'agent/claude-code.txt', 'agent/codex.txt'):
            (t / f).parent.mkdir(parents=True, exist_ok=True)
            (t / f).write_text('{}')
            kept.append(t / f)
        for f in ('agent/token-cache.json', 'agent/.env', 'agent/my_SECRET.txt', 'agent/credentials.json'):
            (t / f).write_text('{}')
            dropped.append(t / f)
    chk = paths.results / 'checks' / 'oracle' / 'count-dataset-tokens' / 'result.json'
    chk.parent.mkdir(parents=True)
    chk.write_text('{}')
    kept.append(chk)
    (paths.results / 'proxy' / 'token-cache.json').write_text('{}')     # not an allowlisted file at all
    excluded: dict[str, list[str]] = {}
    got = set(drv.export_candidates(paths.results, agent, excluded))
    assert set(kept) <= got and not set(dropped) & got and paths.results / 'proxy' / 'token-cache.json' not in got
    assert sorted(excluded['name']) == sorted(str(p.relative_to(paths.results)) for p in dropped)
    assert paths.jobs / ('a' * 32) / 'vulnerable-secret__Ab12Cd3' / 'agent' / 'codex.txt' in got
    assert drv.export_never('jobs/x/vulnerable-secret__a/agent/.env') and not drv.export_never('jobs/x/vulnerable-secret__a/result.json')
    assert not drv.export_never('a.env.json') and drv.export_never('Token') and not drv.export_never('jobs/x-secret__x/agent/codex.txt')


def test_archive_reports_files_left_out_by_name(tmp_path, capsys):
    work = tmp_path / 'w'
    f = tmp_path / 'r.env'
    f.write_text(f'RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR={work}\n')
    paths = drv.Paths(work)
    paths.mkdirs()
    (paths.results / 'attempts.jsonl').write_text('{"ev": "start"}\n')
    t = paths.jobs / 'j' / 'count-dataset-tokens__x'
    t.mkdir(parents=True)
    (t / 'result.json').write_text('{}')
    (t / 'token-cache.json').write_text('{}')
    drv.build_export(paths, mode='full', runner=0)
    capsys.readouterr()
    drv.main(['--env-file', str(f), 'archive'])
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out['excluded_by_name'] == 1 and out['excluded_by_name_dirs'] == {'jobs/j/count-dataset-tokens__x': 1}
    assert out['matched_last_full_export'] == out['allowlisted'] == 2 and out['excluded_cc_client_state'] == 0
    man = json.loads(pathlib.Path(out['archive']).read_text())
    assert man['excluded_by_name'] == ['jobs/j/count-dataset-tokens__x/token-cache.json']
    for dp, _dn, _fn in os.walk(work):   # let pytest clean up
        os.chmod(dp, 0o700)


def test_export_blocks_leakscan_findings(tmp_path):
    import leakscan
    paths = drv.Paths(tmp_path / 'work')
    tdir = _results_tree(paths)
    acct = ''.join(str((i * 7 + 3) % 10) for i in range(12))
    (tdir / 'agent' / 'arn.txt').write_text(f'arn:aws:bedrock:ap-southeast-1:{acct}:inference-profile/x\n')
    (tdir / 'agent' / 'clean.txt').write_text('nothing to see\n')
    m = drv.build_export(paths, mode='full', runner=0, scanner=leakscan.Scanner())
    rel = str((tdir / 'agent' / 'arn.txt').relative_to(paths.results))
    assert rel in m['blocked'] and m['findings'][rel] and acct not in json.dumps(m)
    assert str((tdir / 'agent' / 'clean.txt').relative_to(paths.results)) in m['files'] and m['scanner'] == 'leakscan'


def test_driver_with_the_real_runner_proxy_and_mock_router(tmp_path):
    """The driver against 4f's RunnerProxy (loopback, 4f's mock router behind it): per-trial routes, unique
    sessions, spend in the ledger, the summary keys the classifier reads, and the soft cap from the ledger."""
    import http.client
    import hcommon  # noqa: F401
    import auth
    import hproxy
    import mock_upstream
    import proxy as px
    mock, _ = mock_upstream.serve(0)
    port = mock.server_address[1]
    ups = px.Upstreams('https://gateway.test.invalid', 'ap-southeast-1',
                       connect=lambda _h, _ip, t: http.client.HTTPConnection('127.0.0.1', port, timeout=t),
                       resolver=lambda *a, **k: [(2, 1, 6, '', ('203.0.113.10', 443))])
    minter = auth.TokenMinter({'client_id': 'a', 'client_secret': 'b', 'token_url': 'https://x.invalid/oauth2/token', 'scope': 's'},
                              post=lambda u, d, h: (200, json.dumps({'access_token': 'tok-1', 'expires_in': 3600}).encode()))
    out = tmp_path / 'proxy'
    clock = [1000.0]
    tok = hproxy.SharedToken(minter, clock=lambda: clock[0], token_max_age_s=600)
    srv = hproxy.RunnerProxy('127.0.0.1', 0, ups, hproxy.make_ledger(out, cap_usd=50.0), tok, out,
                             allow_loopback_bind=True, require_host=None)
    hproxy.serve_in_thread(srv)
    try:
        plan, _ = make_plan(tmp_path)
        d, paths = make_driver(tmp_path, plan, proxy=srv, calls=2, concurrency=4, max_blocks=1)
        res = d.run()
    finally:
        srv.shutdown()
        srv.server_close()
        mock.shutdown()
    assert res['state'] == 'paused', res
    ends = events(paths, 'end')
    assert len(ends) == 4 and all(e['classification']['class'] == 'agent' for e in ends)
    for e in ends:
        px_ = e['proxy']
        assert px_['calls'] == 2 and px_['statuses'] == {'200': 2} and px_['last_call']['ok'] is True and px_['cap_stopped'] is False
        assert px_['spent_usd'] > 0 and 'throttled' in px_
    assert srv.summary()['settled_usd'] == pytest.approx(sum(e['proxy']['spent_usd'] for e in ends), rel=1e-6)
    assert srv.summary()['token_max_age_s'] == 600 and srv.summary()['token_remints'] == 0   # the fake clock never aged it
    clock[0] += 601
    assert tok() and tok.stats()['remints'] == {'age': 1}   # the pilot setting re-mints once the token is 10 min old
    sessions = {r.get('session') or r.get('trial_id') for r in drv.read_jsonl(out / 'calls.jsonl')}
    assert sessions == {e['trial_id'] for e in ends}
    assert not srv.summary()['active_trials']


def test_check_caps():
    assert drv.check_caps(1130, 10, 1000) == []
    assert drv.check_caps(22.5, 10, 12.5) == []
    assert len(drv.check_caps(12.5, 10, 12.5)) == 2
    assert 'leaves' in drv.check_caps(14, 10, 1)[0]


def test_scan_secret_lets_encrypted_reasoning_through_but_blocks_real_jwts(tmp_path, monkeypatch):
    """Codex rollouts carry Bedrock reasoning `encrypted_content` (JWT-shaped, payload {ciphertext, protected}): not a
    credential. Real JWTs (any other payload, Cognito included) still block, and so does everything without leakscan."""
    import base64
    from test_leakscan import fake_encrypted_reasoning, rollout_line

    def b64u(o):
        return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
    rollout = tmp_path / 'rollout.jsonl'
    rollout.write_text(rollout_line(fake_encrypted_reasoning()) + '\n' + rollout_line(fake_encrypted_reasoning()) + '\n')
    assert drv.scan_secret(rollout) is False
    cognito = tmp_path / 'cognito.txt'
    cognito.write_text('x ' + '.'.join([b64u({'alg': 'RS256', 'kid': 'k'}), b64u({'iss': 'https://cognito-idp.region.amazonaws.com/pool', 'sub': 'abcdefgh'}),
                                        'c2lnbmF0dXJlLXBhcnQtZm9yLXRlc3Rz']) + '\n')
    assert drv.scan_secret(cognito) is True
    mixed = tmp_path / 'mixed.jsonl'
    mixed.write_text(rollout_line(fake_encrypted_reasoning()) + '\n' + cognito.read_text())
    assert drv.scan_secret(mixed) is True                     # one real token among reasoning blobs still blocks
    extra = tmp_path / 'extra.jsonl'
    extra.write_text(rollout_line(fake_encrypted_reasoning(sub='someone')) + '\n')
    assert drv.scan_secret(extra) is True                     # payload keys not exactly {ciphertext, protected}
    paths = drv.Paths(tmp_path / 'work')
    tdir = _results_tree(paths)
    shutil_copy = tdir / 'agent' / 'rollout.jsonl'
    shutil_copy.write_text(rollout.read_text())
    m = drv.build_export(paths, mode='full', runner=0)
    rel = lambda p: str(p.relative_to(paths.results))  # noqa: E731
    assert rel(shutil_copy) in m['files'] and rel(tdir / 'agent' / 'jwt.txt') in m['blocked']
    monkeypatch.setattr(drv, '_classify_jwt', lambda: None)   # leakscan not importable: keep blocking
    assert drv.scan_secret(rollout) is True
