"""Terminal-Bench 2.1 orchestration (TB design §6): the dataset profile, the TB shard plan (shards, pilot, stratified
long-first passes), classify rules (a)–(c), the §7.5 check slots, resource-budget admission with 4-CPU pairs, the
per-task watchdog, rule (b) with lookupscan, the online-mode environment, exports, the archive command and the fleet
side. A synthetic TB checkout and the scripted fake Harbor; no Docker, no AWS, no network."""
import collections
import dataclasses
import json
import os
import pathlib
import random
import re
import sys
import types

import pytest
from test_driver import FAKE, FakeProxy, job_config_factory

import classify as clf
import driver as drv
import fleet
import profiles
import shardplan as sp

REAL_TASKS = pathlib.Path('/tmp/tb-data/tb21/tasks')
TB_RESULTS = profiles.TB_HERE / 'results'


# ---------------------------------------------------------------- a synthetic TB checkout

def synth_tb(root: pathlib.Path, n: int = 56, seed: int = 3) -> tuple[pathlib.Path, dict, dict, dict]:
    """n task dirs shaped like TB 2.1 (labels and numbers only), plus tiers, weights and pins for them."""
    rng = random.Random(seed)
    cats = ['software-engineering'] * 10 + ['system-administration'] * 5 + ['security'] * 4 + ['data-science'] * 4 + \
           ['debugging'] * 4 + ['games', 'optimization', 'video-processing', 'personal-assistant', 'machine-learning', 'machine-learning',
                                'mathematics', 'mathematics', 'mathematics']
    tasks = root / 'tasks'
    tasks.mkdir(parents=True)
    tiers, weights, pins = {}, {}, {}
    for i in range(n):
        t = f'task-{i:02d}'
        cpus = 4 if i in (3, 17) else (2 if i in (5, 22) else 1)
        mem = 8192 if i in (3, 17, 9) else (4096 if i % 7 == 0 else 2048)
        at = 12000 if i == 11 else (7200 if i == 27 else (3600 if i % 5 == 0 else (1800 if i % 6 == 3 else 900)))
        diff = 'easy' if i in (1, 30) else ('hard' if i % 4 == 3 else 'medium')
        d = tasks / t
        d.mkdir()
        (d / 'task.toml').write_text(
            f'schema_version = "1.1"\n[task]\nname = "terminal-bench/{t}"\n[metadata]\ndifficulty = "{diff}"\ncategory = "{cats[i % len(cats)]}"\n'
            f'[verifier]\ntimeout_sec = {float(at)}\n[agent]\ntimeout_sec = {float(at)}\n[environment]\nbuild_timeout_sec = 600.0\n'
            f'docker_image = "someone/{t}:20251031"\ncpus = {cpus}\nmemory_mb = {mem}\nallow_internet = true\n')
        tiers[t] = 'frontier' if i % 4 == 1 else 'standard'
        weights[t] = round(0.2 + rng.random() * (6 if i in (8, 14) else 1.6), 4)
        pins[t] = {'digest_b64': f'dg{i:02d}', 'image': f'someone/{t}:20251031', 'image_digest_b64': f'im{i:02d}', 'image_bytes': 1000 + i}
    return tasks, tiers, weights, pins


@pytest.fixture
def tb(tmp_path):
    tasks, tiers, weights, pins = synth_tb(tmp_path / 'ck')
    plan, detail = sp.build_tb(tasks, tiers=tiers, weights=weights, pins=pins)
    return types.SimpleNamespace(tasks=tasks, tiers=tiers, weights=weights, pins=pins, plan=plan, detail=detail)


# ---------------------------------------------------------------- profiles

def test_the_deepswe_profile_is_todays_constants():
    p = profiles.DEEPSWE
    assert p.plan == sp.PLAN and p.dev_results / 'plan-detail.json' == sp.DETAIL
    assert p.roots == fleet.ROOTS and p.max_concurrency == drv.MAX_CONCURRENCY and p.wall_timeout_h == drv.WALL_TIMEOUT_H
    assert p.dev_results / 'fleet' == fleet.FLEET and p.dev_results / 'merged' == fleet.MERGED
    assert vars(drv.Paths(pathlib.Path('/w'))) == vars(drv.Paths(pathlib.Path('/w'), p))
    assert profiles.get(None) is p and profiles.of_plan(sp.load_plan()) == 'deepswe'
    with pytest.raises(SystemExit):
        profiles.get('nope')


def test_tb_paths_never_touch_deepswe_results():
    t = drv.Paths(pathlib.Path('/w'), profiles.TB21)
    d = drv.Paths(pathlib.Path('/w'))
    assert t.results == pathlib.Path('/w/tb21/results') and t.tasks == pathlib.Path('/w/terminal-bench-2-1/tasks')
    assert t.exports == pathlib.Path('/w/tb21/exports')
    assert not str(t.results).startswith(str(d.results) + '/') and t.results != d.results and t.proxy != d.proxy


# ---------------------------------------------------------------- shard plan

def test_tb_plan_shards_balance_and_hard_limits(tb):
    plan, det = tb.plan, tb.detail
    assert sp.validate(plan) == [] and plan['schema'] == sp.TB_SCHEMA
    by = sp.shard_tasks(plan)
    sizes = sorted(len(v) for v in by.values())
    assert sizes[-1] - sizes[0] <= 1
    groups = collections.Counter((m['group'], m['shard']) for m in plan['tasks'].values())
    for g in {m['group'] for m in plan['tasks'].values()}:
        per = [groups.get((g, s), 0) for s in range(4)]
        assert max(per) - min(per) <= 1, g
    prof = [det['balance'][str(s)] for s in range(4)]
    assert max(x['first'] for x in prof) <= 1          # the two ≥ 7200 s tasks on different runners
    assert max(x['cpu4'] for x in prof) <= 1 and max(x['top_cost'] for x in prof) <= 2
    assert det['objective'][:4] == [0, 0, 0, 0]


def test_tb_plan_holds_no_tiers_costs_or_12_digit_runs(tb):
    text = json.dumps(tb.plan)
    assert not re.search(r'\d{12}', text)
    for m in tb.plan['tasks'].values():
        assert set(m) == {'group', 'category', 'difficulty', 'agent_timeout_s', 'verifier_timeout_s', 'build_timeout_s', 'cpus',
                          'memory_mb', 'shard', 'digest_b64', 'image', 'image_digest_b64', 'image_bytes'}
    assert sp.commit_hex(tb.plan)[:8] == '12b75656' and len(sp.commit_hex(tb.plan)) == 40
    assert tb.plan['dataset']['name'] == 'tb21' and profiles.of_plan(tb.plan) == 'tb21'


def test_tb_passes_are_stratified_long_first_and_all_arms(tb):
    plan = tb.plan
    assert list(plan['passes']) == ['pilot', 'main', 'rep2', 'rep3']
    first = sp.tb_first(plan)
    assert first == {'task-11', 'task-27'}
    for name in ('main', 'rep2', 'rep3'):
        p = plan['passes'][name]
        assert p['order'] == 'stratified' and p['arms'] == list(sp.ARMS) and p['first'] == sorted(first)
        for s, bs in p['shards'].items():
            ts = [b['task'] for b in bs]
            assert sorted(ts) == sorted(sp.shard_tasks(plan)[int(s)])
            mine = [t for t in ts if t in first]
            assert ts[:len(mine)] == mine          # the long tasks' blocks lead every pass
            assert [b['block'] for b in bs] == list(range(1, len(bs) + 1))
    assert {p['rep'] for n, p in plan['passes'].items() if n != 'pilot'} == {1, 2, 3}


def test_tb_pilot_rule(tb):
    plan, tiers = tb.plan, tb.tiers
    pilot = {int(s): [b['task'] for b in bs] for s, bs in plan['passes']['pilot']['shards'].items()}
    assert all(len(v) == 2 for v in pilot.values()) and plan['passes']['pilot']['phase'] == 'pilot'
    picks = [t for v in pilot.values() for t in v]
    assert all(plan['tasks'][t]['agent_timeout_s'] < sp.TB_FIRST_S for t in picks)
    assert any(plan['tasks'][t]['cpus'] >= 2 for t in picks)            # admission is exercised
    g1 = [plan['tasks'][v[0]]['group'] for v in pilot.values()]
    assert len(set(g1)) == 4
    for v in pilot.values():
        m = plan['tasks'][v[0]]
        assert tiers[v[0]] == 'standard' and m['cpus'] == 1 and m['memory_mb'] == 2048 and m['agent_timeout_s'] <= 900
        assert plan['tasks'][v[1]]['cpus'] >= 2 or tiers[v[1]] == 'frontier'


def test_tb_build_is_deterministic_and_seeded(tb):
    again, _ = sp.build_tb(tb.tasks, tiers=tb.tiers, weights=tb.weights, pins=tb.pins)
    assert again == tb.plan
    other, _ = sp.build_tb(tb.tasks, tiers=tb.tiers, weights=tb.weights, pins=tb.pins, seed=7)
    assert other['passes']['main'] != tb.plan['passes']['main']


def test_tb_task_strata_need_the_tiers(tb):
    with pytest.raises(sp.PlanError):
        sp.task_strata(tb.plan)
    st = sp.task_strata(tb.plan, tb.tiers)
    assert set(st.values()) <= {(t, d) for t in ('standard', 'frontier') for d in ('hard', 'easy+medium')}


def test_tb_loaders_check_their_schemas(tmp_path):
    p = tmp_path / 's.json'
    p.write_text(json.dumps({'schema': 'other', 'tasks': {}}))
    with pytest.raises(sp.PlanError):
        sp.load_tb_strata(p)
    p.write_text(json.dumps({'schema': sp.TB_STRATA_SCHEMA, 'tasks': {'a': {'stratum': 'frontier'}}}))
    assert sp.load_tb_strata(p) == {'a': 'frontier'}
    w = tmp_path / 'w.json'
    w.write_text(json.dumps({'schema': sp.TB_WEIGHTS_SCHEMA, 'weights': {'a': 1.5}}))
    assert sp.load_tb_weights(w) == {'a': 1.5}


def test_max_run_usd_uses_the_tier_model_for_b(tb):
    big = sp.max_run_usd(tb.plan, tb.detail, ['main'], tiers=tb.tiers)
    want = max(sp.planning_cost(tb.detail['tasks'], t, a, tb.tiers) for t in tb.plan['tasks'] for a in sp.ARMS)
    assert big == pytest.approx(want, abs=1e-4)


@pytest.mark.skipif(not (REAL_TASKS.is_dir() and (TB_RESULTS / 'tierpass' / 'strata.json').exists()
                         and (TB_RESULTS / 'inputs' / 'tb-cost-weights.json').exists()), reason='real TB inputs not on this box')
def test_real_tb_inputs_meet_every_constraint():
    ids = sorted(p.name for p in REAL_TASKS.iterdir() if (p / 'task.toml').is_file())
    pins = {t: {'digest_b64': 'x', 'image': 'a/b:c', 'image_digest_b64': 'y', 'image_bytes': 1} for t in ids}
    tiers = sp.load_tb_strata(TB_RESULTS / 'tierpass' / 'strata.json')
    plan, det = sp.build_tb(REAL_TASKS, tiers=tiers, weights=sp.load_tb_weights(TB_RESULTS / 'inputs' / 'tb-cost-weights.json'), pins=pins)
    assert len(plan['tasks']) == 89 and det['objective'][:4] == [0, 0, 0, 0]
    assert sorted(len(v) for v in sp.shard_tasks(plan).values()) == [22, 22, 22, 23]
    assert {plan['tasks'][t]['shard'] for t in sp.tb_first(plan)} == {2, 3} or len({plan['tasks'][t]['shard'] for t in sp.tb_first(plan)}) == 2
    assert sum(p['n_trials'] for n, p in plan['passes'].items() if n != 'pilot') == 1068
    assert plan['passes']['pilot']['n_trials'] == 32


# ---------------------------------------------------------------- classify (TB rules a–c)

def _res(reward=None, exc=None):
    return {'exception_info': {'exception_type': exc} if exc else None, 'verifier_result': {'rewards': {'reward': reward}} if reward is not None else None,
            'agent_execution': {'finished_at': 'x'}}


V_NET = {'tests_ran': False, 'net_error': 'curl', 'net_config_touched': False}


def test_rule_b_reruns_a_verifier_that_never_started_on_the_network():
    c = clf.classify(_res(0.0), {'calls': 5}, verifier=V_NET)
    assert (c['class'], c['action']) == ('verifier_infra', 'rerun') and 'curl' in c['reason']
    for v in ({**V_NET, 'net_config_touched': True}, {**V_NET, 'net_config_touched': None}, {**V_NET, 'tests_ran': True},
              {**V_NET, 'net_error': None}):
        c = clf.classify(_res(0.0), {'calls': 5}, verifier=v)
        assert (c['class'], c['action'], c['score']) == ('agent', 'score', 0.0), v
    assert clf.classify(_res(1.0), {'calls': 5}, verifier=V_NET)['score'] == 1.0     # a pass is never touched
    c = clf.classify(_res(0.0, 'AgentTimeoutError'), {'calls': 5}, verifier=V_NET)   # applies after an agent timeout too
    assert c['class'] == 'verifier_infra'


def test_rules_a_and_c_rerun_because_nothing_can_be_reverified():
    v = {'tests_ran': False, 'net_error': None, 'net_config_touched': False}
    assert clf.classify(_res(None, 'VerifierTimeoutError'), {'calls': 3}, verifier=v)['action'] == 'rerun'
    c = clf.classify(_res(None, 'AgentTimeoutError'), {'calls': 3}, verifier=v)
    assert (c['class'], c['action']) == ('verifier_infra', 'rerun')                   # DeepSWE: score_zero
    assert clf.classify(_res(None, 'AgentTimeoutError'), {'calls': 3})['action'] == 'score_zero'
    assert clf.classify(_res(-1.0), {'calls': 3}, verifier=v)['action'] == 'rerun'


def test_rule_b_in_checks_needs_no_lookupscan():
    v = {'tests_ran': False, 'net_error': 'apt-resolve'}
    for kind in ('oracle', 'nop'):
        assert clf.check_verdict(kind, _res(0.0), verifier=v)['ok'] is None
    assert clf.check_verdict('nop', _res(0.0), verifier={'tests_ran': True, 'net_error': 'curl'})['ok'] is True
    assert clf.check_verdict('nop', _res(0.0))['ok'] is True                            # DeepSWE unchanged


@pytest.mark.parametrize('text', ['curl: (6) Could not resolve host: astral.sh', 'curl: (7) Failed to connect', 'Err:1 http://deb.debian.org x',
                                  'Temporary failure resolving \'deb.debian.org\'', 'E: Unable to fetch some archives', 'error: Failed to fetch: `https://pypi.org`',
                                  'Caused by: dns error: failed to lookup', 'Max retries exceeded with url: /simple/', 'Connection refused',
                                  'Temporary failure in name resolution', 'No route to host', 'Connection reset by peer', 'error sending request for url'])
def test_network_patterns_match(text):
    assert clf.net_error('x\n' + text + '\n') is not None


def test_network_patterns_ignore_ordinary_output():
    assert clf.net_error('collected 3 items\nFAILED test_outputs.py::test_x - AssertionError\n1 failed\n') is None
    assert clf.tests_ran({'results': {'summary': {'tests': 3}}}) and not clf.tests_ran({'results': {'summary': {'tests': 0}}})
    assert not clf.tests_ran(None)


def test_verifier_evidence_reads_the_trial_dir(tmp_path):
    t = tmp_path / 'trial'
    assert drv.verifier_evidence(None) == {'ctrf': False, 'tests_ran': False, 'net_error': None}
    (t / 'verifier').mkdir(parents=True)
    (t / 'verifier' / 'test-stdout.txt').write_text('x' * 2_000_000 + '\ncurl: (6) Could not resolve host: astral.sh\n')
    assert drv.verifier_evidence(t) == {'ctrf': False, 'tests_ran': False, 'net_error': 'curl'}
    (t / 'verifier' / 'ctrf.json').write_text(json.dumps({'results': {'summary': {'tests': 2}}}))
    assert drv.verifier_evidence(t)['tests_ran'] is True


# ---------------------------------------------------------------- §7.5 check slots

def _v(ok):
    return {'verdict': {'ok': ok, 'reward': None if ok is None else 1.0, 'reason': 'x'}}


def _events(seq):
    """seq: {(task, kind): [ok values in log order]}."""
    return [{'ev': 'check-end', 'task': t, 'kind': k, **_v(ok)} for (t, k), oks in seq.items() for ok in oks]


def test_three_consecutive_infra_attempts_are_one_counted_failure():
    assert drv.slot_walk([_v(None)['verdict']] * 3) == (['exhausted'], 0)
    assert drv.slot_walk([_v(None)['verdict']] * 2 + [_v(True)['verdict']]) == (['good'], 0)
    assert drv.slot_walk([_v(None)['verdict']] * 7) == (['exhausted', 'exhausted'], 0)    # ≤ 6 attempts count


def test_oracle_slots_drop_or_flag():
    s = drv.summarize_checks_slots(_events({('a', 'oracle'): [None] * 6, ('a', 'nop'): [True, True],
                                            ('b', 'oracle'): [None, None, None, True], ('b', 'nop'): [True, True],
                                            ('c', 'oracle'): [None, None, True, True], ('c', 'nop'): [True, True],
                                            ('d', 'oracle'): [False, False], ('d', 'nop'): [True, True]}), ['a', 'b', 'c', 'd'], ('oracle', 'nop'))
    assert s['dropped'] == ['a', 'd'] and s['flaky_env'] == ['b'] and s['unresolved'] == []
    assert s['tasks']['c']['ok'] is True and not s['tasks']['c']['flaky_env'] and s['tasks']['c']['oracle']['infra'] == 2


def test_nop_unverified_slots():
    s = drv.summarize_checks_slots(_events({('a', 'oracle'): [True, True], ('a', 'nop'): [None, None, None, True],
                                            ('b', 'oracle'): [True, True], ('b', 'nop'): [None] * 6,
                                            ('c', 'oracle'): [True, True], ('c', 'nop'): [True, False],
                                            ('e', 'oracle'): [True, False], ('e', 'nop'): [None, None, None, True]}), ['a', 'b', 'c', 'e'], ('oracle', 'nop'))
    assert s['tasks']['a']['flaky_env'] and not s['tasks']['a']['drop']          # unverified + clean fail → kept, flaky
    assert s['tasks']['b']['drop'] and 'unverified twice' in s['tasks']['b']['reason']
    assert s['tasks']['c']['drop']                                                # the base passes once
    assert s['tasks']['e']['flaky_env'] and len(s['tasks']['e']['flaky_reasons']) == 2   # flagged once, both reasons


def test_incomplete_slots_are_unresolved_and_gate_the_run():
    s = drv.summarize_checks_slots(_events({('a', 'oracle'): [True], ('a', 'nop'): [True, True]}), ['a'], ('oracle', 'nop'))
    assert s['unresolved'] == ['a'] and s['tasks']['a']['ok'] is None


def _tb_profile(**kw):
    return dataclasses.replace(profiles.TB21, **kw)


def test_run_checks_tb_slots_with_the_fake_harbor(tmp_path, tb):
    prof = _tb_profile()
    env = drv.RunnerEnv(index=0, count=4, proxy_addr='172.17.0.1', proxy_port=8088, work_dir=tmp_path / 'w')
    paths = drv.Paths(env.work_dir, prof)
    ts = sorted(sp.shard_tasks(tb.plan)[0])
    a, b, c, d = ts[:4]
    checks = {f'{a}/oracle': ['netfail', 'netfail', 'netfail', 'netfail', 'netfail', 'netfail'],   # never verifiable → dropped
              f'{b}/oracle': ['netfail', 'netfail', 'netfail', 'tb_pass'],                       # 1 of 2 → flaky_env
              f'{c}/nop': ['netfail', 'netfail', 'netfail', 'tb_fail'],                          # unverified + clean fail → flaky
              f'{d}/nop': ['tb_pass']}
    env_h = {**drv.harbor_subprocess_env(), 'FAKE_HARBOR_CHECKS': json.dumps(checks), 'FAKE_HARBOR_STATE': str(tmp_path / 'state')}
    default = {f'{t}/{k}': ['tb_pass' if k == 'oracle' else 'tb_fail'] for t in ts for k in ('oracle', 'nop')}
    env_h['FAKE_HARBOR_CHECKS'] = json.dumps({**default, **checks})
    h = drv.Harbor(sys.executable, env=env_h)
    h.run_argv = lambda job: [sys.executable, str(FAKE), 'run', '--config', str(job), '--yes']
    summ = drv.run_checks(plan=tb.plan, env=env, paths=paths, harbor=h, environment={'type': 'docker'}, kinds=('oracle', 'nop'), reps=1,
                          concurrency=8, docker=None, log=drv.Log(None, echo=False), poll_s=0.02, profile=prof, tasks=ts)
    assert summ['dropped'] == sorted([a, d]) and summ['flaky_env'] == sorted([b, c]) and summ['unresolved'] == []
    ce = drv.read_jsonl(paths.check_events)
    n = collections.Counter((e['task'], e['kind']) for e in ce)
    assert n[(a, 'oracle')] == 6 and n[(b, 'oracle')] == 4 and max(n.values()) <= 6   # both slots are tried in each round
    assert all('verifier' in e and 'admission' in e for e in ce)
    gate_drop, unresolved = drv.check_gate(paths, ts)
    assert gate_drop == {a, d} and unresolved == []


# ---------------------------------------------------------------- the driver with the TB profile

def tb_driver(tmp_path, plan, *, behaviours=None, passes=('main',), shard=0, concurrency=8, sleep=0.05, profile=None, **kw):
    prof = profile or _tb_profile()
    env = drv.RunnerEnv(index=shard, count=plan['n_shards'], proxy_addr='172.17.0.1', proxy_port=8088, work_dir=tmp_path / 'work',
                        container_egress='internet', online_network='llmar-online', online_dns='169.254.169.253')
    paths = drv.Paths(env.work_dir, prof)
    paths.mkdirs()
    harbor = drv.Harbor(sys.executable, env={**drv.harbor_subprocess_env(extra=env.online_env()), 'FAKE_HARBOR_LOG': str(tmp_path / 'harbor.log')})
    harbor.run_argv = lambda job: [sys.executable, str(FAKE), 'run', '--config', str(job), '--yes']
    d = drv.Driver(plan=plan, env=env, paths=paths, passes=list(passes), proxy=FakeProxy(), harbor=harbor,
                   job_config=job_config_factory(behaviours or {}, sleep), poll_s=0.02, grace_s=1.0, min_free_gb=0.0, disk_paths=[tmp_path],
                   check_gate_on=False, log=drv.Log(paths.log, echo=False), profile=prof, concurrency=concurrency, **kw)
    return d, paths


def _intervals(tmp_path, paths):
    tid_task = {e['trial_id']: e['task'] for e in drv.read_jsonl(paths.events) if e['ev'] == 'start'}
    log = [json.loads(x) for x in (tmp_path / 'harbor.log').read_text().splitlines()]
    t0 = {r['job']: r['t0'] for r in log if r['cmd'] == 'run'}
    t1 = {r['job']: r['t1'] for r in log if r['cmd'] == 'end'}
    return [(t0[j], t1[j], tid_task[j]) for j in t0 if j in t1]


def _peak(intervals, w):
    pts = sorted({a for a, _, _ in intervals})
    return max(sum(w(t) for a, b, t in intervals if a <= x < b) for x in pts)


def test_admission_budget_runs_4cpu_arms_in_pairs_and_never_overcommits(tmp_path, tb):
    plan = tb.plan
    s4 = next(s for s in range(4) if any(plan['tasks'][t]['cpus'] == 4 for t in sp.shard_tasks(plan)[s]))
    d, paths = tb_driver(tmp_path, plan, shard=s4, sleep=0.25)
    out = d.run()
    assert out['state'] == 'done'
    iv = _intervals(tmp_path, paths)
    assert _peak(iv, lambda t: plan['tasks'][t]['cpus']) <= 8
    assert _peak(iv, lambda t: plan['tasks'][t]['memory_mb'] / 1024) <= 48
    four = {t for t in sp.shard_tasks(plan)[s4] if plan['tasks'][t]['cpus'] == 4}
    for t in four:
        assert _peak([x for x in iv if x[2] == t], lambda _t: 1) == 2      # pairs: two arms at a time, never four
    assert _peak(iv, lambda t: 1) > 4                                     # 1-CPU blocks still run side by side


def test_status_reports_the_budget_and_the_dataset(tmp_path, tb):
    d, paths = tb_driver(tmp_path, tb.plan, max_blocks=1)
    d.run()
    st = json.loads(paths.status.read_text())
    assert st['dataset'] == 'tb21' and st['budget']['cpu_budget'] == 8.0 and st['budget']['mem_budget_gb'] == 48.0


def test_per_task_watchdog(tmp_path, tb, monkeypatch):
    plan = json.loads(json.dumps(tb.plan))
    t = plan['passes']['main']['shards']['0'][0]['task']
    plan['tasks'][t].update(agent_timeout_s=1, verifier_timeout_s=1, build_timeout_s=1)
    monkeypatch.setattr(profiles, 'WATCHDOG_MARGIN_S', 0.0)
    d, paths = tb_driver(tmp_path, plan, behaviours={(t, 'A'): ['hang', 'pass']}, max_blocks=1)
    assert d.watchdog_s(t) == 3.0 and d.watchdog_s(plan['passes']['main']['shards']['0'][1]['task']) > 3600
    d.run()
    ends = [e for e in drv.read_jsonl(paths.events) if e['ev'] == 'end' and e['key'].startswith(f'main/{t}/A/')]
    assert ends[0]['killed'] == 'wall-timeout'


def test_tb_preflight_is_per_runner(tmp_path, tb, monkeypatch):
    prof = dataclasses.replace(profiles.TB21, plan=tmp_path / 'plan.json', dev_results=tmp_path / 'res')
    sp.write_json(prof.plan, tb.plan)
    sp.write_json(prof.dev_results / 'plan-detail.json', tb.detail)
    sp.write_json(prof.dev_results / 'tierpass' / 'strata.json',
                  {'schema': sp.TB_STRATA_SCHEMA, 'tasks': {t: {'stratum': v} for t, v in tb.tiers.items()}})
    per = {s: sp.max_run_usd(tb.plan, tb.detail, ['pilot'], shard=s, tiers=tb.tiers) for s in range(4)}
    lo, hi = min(per, key=per.get), max(per, key=per.get)
    cap = 10 + (per[lo] + per[hi]) / 2
    if per[lo] < per[hi]:
        assert fleet.tb_preflight_caps(prof, ['pilot'], cap, 10.0, [lo])['largest_run_usd'] == {str(lo): per[lo]}
        with pytest.raises(SystemExit, match=f'runner {hi}'):
            fleet.tb_preflight_caps(prof, ['pilot'], cap, 10.0, [lo, hi])


def test_admissions_record_the_resources_in_flight(tmp_path, tb):
    d, paths = tb_driver(tmp_path, tb.plan, max_blocks=2)
    d.run()
    starts = [e for e in drv.read_jsonl(paths.events) if e['ev'] == 'start']
    assert all({'cpus', 'mem_gb', 'in_flight_cpus', 'in_flight_mem_gb', 'in_flight_trials'} <= set(e['admission']) for e in starts)
    assert starts[0]['admission']['in_flight_trials'] == 0 and max(e['admission']['in_flight_trials'] for e in starts) > 0
    assert all(e['admission']['in_flight_cpus'] + e['admission']['cpus'] <= 8 or e['admission']['in_flight_trials'] == 0 for e in starts)
    assert 'admit main/' in paths.log.read_text()


def test_rule_b_with_lookupscan_reruns_and_records_the_evidence(tmp_path, tb):
    calls = []

    def lookup(tdir, task):
        calls.append((tdir.name, task.name))
        return {'scanner': 'v', 'flag': False, 'net_config_touched': False}, [{'i': 0, 'window': 'x'}]
    d, paths = tb_driver(tmp_path, tb.plan, behaviours={('*', 'B'): ['netfail', 'tb_pass']}, max_blocks=1, lookup=lookup)
    d.run()
    es = drv.read_jsonl(paths.events)
    bends = [e for e in es if e['ev'] == 'end' and e['key'].split('/')[2] == 'B']
    assert [e['classification']['class'] for e in bends] == ['verifier_infra', 'agent']
    assert bends[0]['verifier'] == {'ctrf': False, 'tests_ran': False, 'net_error': 'curl', 'net_config_touched': False}
    assert bends[0]['lookup']['net_config_touched'] is False and len(calls) == 5
    tid = bends[0]['trial_id']
    assert json.loads((paths.attempts / tid / 'lookup.json').read_text())['scanner'] == 'v'
    assert (paths.attempts / tid / 'lookup-hits.jsonl').read_text().strip()


def test_rule_b_does_not_apply_when_the_agent_touched_its_network_config(tmp_path, tb):
    d, paths = tb_driver(tmp_path, tb.plan, behaviours={('*', 'B'): ['netfail']}, max_blocks=1,
                         lookup=lambda tdir, task: ({'net_config_touched': True}, []))
    d.run()
    bend = [e for e in drv.read_jsonl(paths.events) if e['ev'] == 'end' and e['key'].split('/')[2] == 'B']
    assert len(bend) == 1 and (bend[0]['classification']['class'], bend[0]['classification']['score']) == ('agent', 0.0)


def test_preflight_runs_after_the_network_prune(tmp_path, tb):
    order = []

    class Dk(drv.Docker):
        def __init__(self):
            super().__init__(run=lambda argv, **kw: types.SimpleNamespace(returncode=0, stdout='', stderr=''))

        def prune_networks(self):
            order.append('prune')
            return ''

        def cleanup(self, prefixes):
            return {'containers': 0, 'networks': 0}
    d, _ = tb_driver(tmp_path, tb.plan, max_blocks=1, docker=Dk(), preflight=lambda: order.append('preflight'))
    d.run()
    assert order[:2] == ['prune', 'preflight']


def test_harbor_gets_the_online_keys_from_the_env_file_only(tmp_path, monkeypatch):
    monkeypatch.setenv('ONLINE_NETWORK', 'evil')
    assert 'ONLINE_NETWORK' not in drv.harbor_subprocess_env()
    f = tmp_path / 'r.env'
    f.write_text('RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR=/w\nCONTAINER_EGRESS=internet\n'
                 'ONLINE_NETWORK=llmar-online\nONLINE_DNS=169.254.169.253\n')
    env = drv.RunnerEnv.load(f)
    e = drv.harbor_subprocess_env(extra=env.online_env())
    assert e['ONLINE_NETWORK'] == 'llmar-online' and e['ONLINE_DNS'] == '169.254.169.253'
    f.write_text('RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR=/w\nCONTAINER_EGRESS=internet\n')
    with pytest.raises(SystemExit):
        drv.RunnerEnv.load(f).online_env()
    f.write_text('RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR=/w\nONLINE_DNS=8.8.8.8;rm\n')
    with pytest.raises(SystemExit):
        drv.RunnerEnv.load(f)
    assert drv.RunnerEnv.load(tmp_path / 'missing.env', {'index': 0, 'count': 1, 'proxy_addr': 'x'}).online_env() == {}


def test_tb_runs_and_checks_refuse_a_runner_without_internet_mode(tmp_path):
    f = tmp_path / 'r.env'
    f.write_text(f'RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR={tmp_path}/w\n')
    with pytest.raises(SystemExit, match='CONTAINER_EGRESS=internet'):
        drv.main(['--env-file', str(f), '--dataset', 'tb21', 'check'])
    drv.main(['--env-file', str(f), '--dataset', 'tb21', 'unstop'])     # bookkeeping commands still work


def test_tb_preflight_checks_the_network_and_the_images(monkeypatch, tb):
    calls = []
    fake = types.SimpleNamespace(
        ONLINE_NETWORK={'name': 'llmar-online'}, NetworkMismatch=ValueError,
        check_online_network=lambda run, name: calls.append(('net', name)) or {'name': name, 'subnet': 's', 'bridge': 'b'},
        check_images=lambda plan, tasks, run: calls.append(('img', len(list(tasks)))) or [])
    monkeypatch.setitem(sys.modules, 'taskpin', fake)
    env = drv.RunnerEnv(index=0, count=4, proxy_addr='x', proxy_port=1, work_dir=pathlib.Path('/w'), container_egress='internet',
                        online_network='llmar-online', online_dns='1.2.3.4')
    drv.tb_preflight(tb.plan, env, ['a', 'b'], lambda m: None)
    assert calls == [('net', 'llmar-online'), ('img', 2)]
    fake.check_images = lambda plan, tasks, run: ['a: local image is not the pinned digest']
    with pytest.raises(SystemExit, match='pinned digest'):
        drv.tb_preflight(tb.plan, env, ['a'], lambda m: None)

    def bad(run, name):
        raise ValueError('network llmar-online: icc is True, expected False')
    fake.check_online_network = bad
    with pytest.raises(SystemExit, match='icc'):
        drv.tb_preflight(tb.plan, env, ['a'], lambda m: None)


def test_tb_prepull_pulls_by_digest_and_tags(tmp_path, monkeypatch, tb):
    plan_p = tmp_path / 'plan.json'
    sp.write_json(plan_p, tb.plan)
    f = tmp_path / 'r.env'
    f.write_text(f'RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR={tmp_path}/w\n')
    pulled, tagged = [], []

    class Dk:
        def pull(self, img):
            pulled.append(img)
            return True, ''

        def tag(self, a, b):
            tagged.append((a, b))
            return True, ''

        def image_size(self, img):
            return 10
    monkeypatch.setattr(drv, 'Docker', Dk)
    fake = types.SimpleNamespace(image_pull_args=lambda m: (m['image'].split(':')[0] + '@sha256:' + m['image_digest_b64'], m['image']),
                                 check_images=lambda plan, tasks, run: [])
    monkeypatch.setitem(sys.modules, 'taskpin', fake)
    monkeypatch.setitem(sys.modules, 'isolation', types.SimpleNamespace(PROBE_IMAGE='python@sha256:' + 'ab' * 32))
    drv.main(['--env-file', str(f), '--dataset', 'tb21', '--plan', str(plan_p), 'prepull'])
    mine = sorted(sp.shard_tasks(tb.plan)[0])
    assert len(tagged) == len(mine) and all('@sha256:' in a for a, _ in tagged)
    assert sorted(b for _, b in tagged) == sorted(tb.plan['tasks'][t]['image'] for t in mine)
    summ = json.loads((tmp_path / 'w' / 'tb21' / 'results' / 'prepull.json').read_text())
    assert summ['failed'] == [] and summ['digest_issues'] == []


def test_a_deepswe_plan_is_refused_under_the_tb_profile(tmp_path):
    f = tmp_path / 'r.env'
    f.write_text(f'RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR={tmp_path}/w\nCONTAINER_EGRESS=internet\n'
                 'ONLINE_NETWORK=llmar-online\nONLINE_DNS=1.2.3.4\n')
    with pytest.raises(SystemExit, match='dataset'):
        drv.main(['--env-file', str(f), '--dataset', 'tb21', '--plan', str(sp.PLAN), 'check'])


# ---------------------------------------------------------------- export and archive

def test_tb_export_keeps_lookup_hits_for_full_mode_and_names_the_dataset(tmp_path):
    paths = drv.Paths(tmp_path / 'w', profiles.TB21)
    paths.mkdirs()
    a = paths.attempts / ('ab' * 16)
    a.mkdir()
    (a / 'lookup.json').write_text('{"flag": false}')
    (a / 'lookup-hits.jsonl').write_text('{"i": 1}\n')
    light = drv.build_export(paths, mode='light', runner=0, dataset='tb21')
    assert f"attempts/{'ab' * 16}/lookup.json" in light['files'] and f"attempts/{'ab' * 16}/lookup-hits.jsonl" in light['skipped']
    assert light['dataset'] == 'tb21'
    full = drv.build_export(paths, mode='full', runner=0, dataset='tb21')
    assert f"attempts/{'ab' * 16}/lookup-hits.jsonl" in full['files']
    assert 'dataset' not in drv.build_export(paths, mode='full', runner=0, dataset='deepswe')


def test_archive_writes_a_manifest_freezes_the_tree_and_verifies(tmp_path, capsys):
    work = tmp_path / 'w'
    f = tmp_path / 'r.env'
    f.write_text(f'RUNNER_INDEX=0\nRUNNER_COUNT=4\nPROXY_ADDR=172.17.0.1\nWORK_DIR={work}\n')
    paths = drv.Paths(work)
    paths.mkdirs()
    (paths.results / 'attempts.jsonl').write_text('{"ev": "start"}\n')
    (paths.jobs / 'j').mkdir()
    (paths.jobs / 'j' / 'result.json').write_text('{}')
    m = drv.build_export(paths, mode='full', runner=0)
    assert m['files']
    capsys.readouterr()
    drv.main(['--env-file', str(f), 'archive'])
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out['read_only'] and out['matched_last_full_export'] == out['allowlisted'] and out['differs_from_export'] == []
    assert out['last_full_export'] == m['export_id'] and '=' not in out['manifest_sha256_b64']
    assert not os.stat(paths.results / 'attempts.jsonl').st_mode & 0o222 and not os.stat(paths.jobs).st_mode & 0o222
    man = pathlib.Path(out['archive'])
    assert man.parent == work / 'archive' and json.loads(man.read_text())['n_files'] == out['n_files']
    drv.main(['--env-file', str(f), 'archive', '--verify', str(man)])
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])['ok'] is True
    os.chmod(paths.results, 0o700)
    os.chmod(paths.results / 'attempts.jsonl', 0o600)
    (paths.results / 'attempts.jsonl').write_text('changed\n')
    with pytest.raises(SystemExit):
        drv.main(['--env-file', str(f), 'archive', '--verify', str(man)])
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])['changed'] == ['attempts.jsonl']
    for dp, dn, fn in os.walk(work):   # let pytest clean up
        os.chmod(dp, 0o700)


# ---------------------------------------------------------------- fleet

def test_fleet_commands_carry_the_dataset_for_tb_only():
    assert '--dataset' not in fleet.driver_cmd('status') and '--dataset' not in fleet.driver_cmd('status', profile=profiles.DEEPSWE)
    assert fleet.driver_cmd('status', profile=profiles.TB21).endswith('driver.py --dataset tb21 status')
    assert '--dataset tb21 prepull' in fleet.unit_cmd('llmar-prepull', 'prepull', profile=profiles.TB21)
    iso = fleet.isolation_cmd('ap-southeast-1', profiles.TB21)
    assert '--profile tb21 --env llmar' in iso and '--out $WORK_DIR/tb21/results/isolation' in iso
    assert fleet.isolation_cmd('ap-southeast-1', profiles.DEEPSWE) == fleet.isolation_cmd('ap-southeast-1')
    assert 'experiments/tbench-harbor' in fleet.bootstrap_script('ab' * 32, profiles.TB21.roots)


class RecAws:
    region = 'ap-southeast-1'

    def __init__(self):
        self.scripts = []

    def ssm(self, iid, script, timeout_s=600):
        self.scripts.append(script)
        return 'Success', '{}\n', ''


def _fleet(argv, monkeypatch):
    rec = RecAws()
    monkeypatch.setattr(fleet, 'resolve', lambda a: (rec, ['i-0a0b0c0d0e0f0a0b0'], None))
    fleet.main(['--region', 'ap-southeast-1', '--instances', 'i-0a0b0c0d0e0f0a0b0', *argv])
    return rec.scripts


def test_fleet_start_limits_and_tb_preflight(monkeypatch, tmp_path, tb):
    with pytest.raises(SystemExit, match='1..6'):
        _fleet(['start', '--pass', 'main', '--gateway-url', 'https://g', '--concurrency', '8'], monkeypatch)
    prof = dataclasses.replace(profiles.TB21, plan=tmp_path / 'plan.json', dev_results=tmp_path / 'res')
    sp.write_json(prof.plan, tb.plan)
    sp.write_json(prof.dev_results / 'plan-detail.json', tb.detail)
    sp.write_json(prof.dev_results / 'tierpass' / 'strata.json',
                  {'schema': sp.TB_STRATA_SCHEMA, 'tasks': {t: {'stratum': v} for t, v in tb.tiers.items()}})
    monkeypatch.setitem(profiles.PROFILES, 'tb21', prof)
    biggest = sp.max_run_usd(tb.plan, tb.detail, ['main'], shard=0, tiers=tb.tiers)   # the one runner of this fleet
    assert biggest > 6
    with pytest.raises(SystemExit, match='pre-flight: runner 0'):
        _fleet(['--dataset', 'tb21', 'start', '--pass', 'main', '--gateway-url', 'https://g', '--concurrency', '8',
                '--soft-cap', '1', '--hard-cap', f'{10 + biggest - 0.01:.2f}'], monkeypatch)
    sc = _fleet(['--dataset', 'tb21', 'start', '--pass', 'pilot', '--gateway-url', 'https://g', '--concurrency', '8', '--soft-cap', '45',
                 '--hard-cap', '65', '--token-max-age-s', '600'], monkeypatch)
    assert '--dataset tb21 run --gateway-url https://g' in sc[0] and '--concurrency 8' in sc[0]


def test_fleet_archive_and_tb_check_post(monkeypatch):
    sc = _fleet(['archive'], monkeypatch)
    assert 'driver.py archive' in sc[0]
    sc = _fleet(['--dataset', 'tb21', 'check', '--concurrency', '8', '--post'], monkeypatch)
    assert '--dataset tb21 check --kind both --reps 1 --concurrency 8 --post' in sc[0]


def test_fleet_fetch_refuses_another_datasets_export(monkeypatch, tmp_path):
    class A(RecAws):
        def ssm(self, iid, script, timeout_s=600):
            return 'Success', json.dumps({'export_id': '1-abcdef', 'parts': 0, 'tar_sha256': 'x'}) + '\n', ''
    fl = fleet.Fleet(A(), ['i-0a0b0c0d0e0f0a0b0'], out=tmp_path, profile=profiles.TB21)
    assert 'not tb21' in fl.fetch('light')[0]['error']


def test_fleet_merge_adds_tb_fields(tmp_path, tb):
    d, paths = tb_driver(tmp_path / 'r0', tb.plan, max_blocks=1)
    d.run()
    fdir = tmp_path / 'fleet'
    (fdir / 'runner-0').mkdir(parents=True)
    os.symlink(paths.results, fdir / 'runner-0' / 'results')
    s = {'tasks': {}, 'dropped': [], 'unresolved': [], 'flaky_env': [d.items[0]['task']]}
    sp.write_json(paths.check_summary, s)
    plan_p = tmp_path / 'plan.json'
    sp.write_json(plan_p, tb.plan)
    fleet.merge(fdir, tmp_path / 'merged', plan_p)
    rows = [json.loads(x) for x in (tmp_path / 'merged' / 'attempts.jsonl').read_text().splitlines()]
    assert rows and all({'task_meta', 'flaky_env', 'started_at', 'verifier', 'lookup'} <= set(r) for r in rows)
    assert any(r['flaky_env'] for r in rows) and rows[0]['task_meta']['cpus'] in (1, 2, 4)
    assert json.loads((tmp_path / 'merged' / 'checks.json').read_text())['flaky_env'] == [d.items[0]['task']]


@pytest.mark.skipif(not (REAL_TASKS / 'sanitize-git-repo').is_dir(), reason='the TB checkout is not on this box')
def test_tb_export_lets_a_tasks_own_fixture_values_through(tmp_path):
    """sanitize-git-repo ships AWS-shaped fixture values; a trial log that repeats one must not be blocked when the
    shard's task dirs are the export's fixtures (4f/18), and is blocked without them. The value is read from the
    public task files at run time and never written into this file."""
    import inspect
    import shutil

    import leakscan
    if 'fixtures' not in inspect.signature(leakscan.Scanner).parameters:
        pytest.skip('leakscan without the fixture allowance')
    rx = next(r for k, _s, r in leakscan.PATTERNS if k == 'account-in-arn')
    hit = None
    for p in sorted((REAL_TASKS / 'sanitize-git-repo').rglob('*')):
        if p.is_file() and not p.is_symlink():
            m = rx.search(p.read_bytes())
            if m:
                hit = m.group(0)
                break
    assert hit, 'the task no longer carries an account-shaped fixture'
    paths = drv.Paths(tmp_path / 'w', profiles.TB21)
    paths.mkdirs()
    task = paths.tasks / 'sanitize-git-repo'
    shutil.copytree(REAL_TASKS / 'sanitize-git-repo', task, symlinks=True)
    tid = 'cd' * 16
    (paths.attempts / tid).mkdir()
    (paths.attempts / tid / 'harbor.log').write_bytes(b'agent printed: ' + hit + b'\n')
    rel = f'attempts/{tid}/harbor.log'
    with_fx = drv.build_export(paths, mode='full', runner=0, scanner=drv.make_scanner(False, lambda m: None, [task]), dataset='tb21')
    assert rel in with_fx['files'] and rel not in with_fx['blocked']
    without = drv.build_export(paths, mode='full', runner=0, scanner=drv.make_scanner(False, lambda m: None), dataset='tb21')
    assert rel in without['blocked']
