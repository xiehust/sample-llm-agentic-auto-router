"""Claude Code × Harbor orchestration (CC design): profiles, the data-driven arm table and derive, classify's main
view and OOM tags, the memory sampler, stage continuity, outcome-blind status/projection, per-runner caps and the
global budget pre-flight, the export allowlist. No AWS, no model calls; task costs are synthetic."""
import hashlib
import json
import math
import pathlib
import subprocess

import pytest

import ccproject
import classify as clf
import driver as drv
import fleet
import profiles
import shardplan as sp

HERE = pathlib.Path(__file__).resolve().parents[1]
ARMS_JSON = profiles.CC_HERE / 'arms.json'
SCANNER_POOL = ['mailman', 'make-doom-for-mips', 'fix-code-vulnerability', 'pytorch-model-recovery', 'hf-model-inference']


def _h(*parts) -> float:
    return int(hashlib.sha256(':'.join(map(str, parts)).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def codex_attempts(plan, path, reward_seed=0):
    """Synthetic Codex attempts rows: scored main/repeat finals with costs and walls from a hash of (task, arm);
    rewards from `reward_seed` (they must never matter)."""
    rows = []
    for t in plan['tasks']:
        for arm in sp.ARMS:
            for rep in (1, 2):
                rows.append({'task': t, 'arm': arm, 'phase': 'main' if rep == 1 else 'repeat', 'class': 'agent', 'final_status': 'scored',
                             'is_final': True, 'spent_usd': round(0.05 + 3 * _h(t, arm, rep), 4), 'wall_s': round(200 + 1500 * _h('w', t, arm), 1),
                             'reward': float(_h('r', reward_seed, t, arm, rep) > 0.5)})
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
    return path


def tb_tiers(plan):
    return {t: ('frontier' if _h('tier', t) > 0.6 else 'standard') for t in plan['tasks']}


def derive(base='deepswe', arms_path=ARMS_JSON, tmp=None, drops=(), reward_seed=0):
    prof = profiles.get(base, 'claude-code')
    codex_plan = sp.load_plan(profiles.PROFILES[base].plan)
    order, arms = sp.load_arms(arms_path)
    att = codex_attempts(codex_plan, tmp / f'codex-{base}-{reward_seed}.jsonl', reward_seed)
    plan, detail = sp.derive_cc(codex_plan, name=prof.name, base=base, order=order, arms=arms, drops=set(drops),
                                costs=sp.codex_task_costs(att), walls=sp.codex_task_costs(att, 'wall_s'),
                                tiers=tb_tiers(codex_plan) if base == 'tb21' else None,
                                scanner_pool=SCANNER_POOL if base == 'tb21' else None)
    assert sp.validate(plan) == []
    return plan, detail


# ---------------------------------------------------------------- profiles and the arm table

def test_profiles_agent_by_dataset():
    assert profiles.get('deepswe').name == 'deepswe' and profiles.get(None).agent == 'codex'
    assert profiles.get('deepswe', 'claude-code').name == 'cc-deepswe'
    assert profiles.get('tb21', 'claude-code').name == 'cc-tb21'
    assert profiles.get('cc-tb21').base == 'tb21'
    with pytest.raises(SystemExit):
        profiles.get('cc-deepswe', 'codex')
    cc = profiles.CC_DEEPSWE
    assert cc.results != profiles.DEEPSWE.results and cc.results.startswith('cc-deepswe/')
    assert cc.blind and cc.mem_watch and cc.continuity and cc.stage == 'stage-claude-code'
    assert profiles.DEEPSWE.stage == 'stage-codex' and not profiles.DEEPSWE.blind
    assert 'experiments/claude-code-harbor' in cc.roots and profiles.CC_TB21.online and profiles.CC_TB21.isolation_profile == 'tb21'


def test_committed_arm_table():
    order, arms = sp.load_arms(ARMS_JSON)
    assert order == ['A', 'B', 'C', 'F']
    assert arms['B']['main_model'] == 'auto' and arms['B']['pack'] == 'v2.2' and arms['B']['client_model'] == arms['A']['client_model']
    assert arms['B']['worst_model'] == 'global.anthropic.claude-opus-5-5'
    assert all(v['hint'] is None for v in arms.values())   # 4f: a pin hint would pin helper calls too; the body model is the pin
    for a, m in (('A', 'sonnet'), ('C', 'opus'), ('F', 'haiku')):
        assert m in arms[a]['main_model'] and arms[a]['client_model'] == arms[a]['main_model'] == arms[a]['worst_model']
    assert {a: v['planning_usd']['deepswe'] for a, v in arms.items()} == {'A': 0.71, 'B': 0.68, 'C': 1.35, 'F': 0.13}


@pytest.mark.parametrize('edit, msg', [
    (lambda d: d['order'].pop(), 'order'),
    (lambda d: d['arms']['A'].update(codex_ref='Z'), 'codex_ref'),
    (lambda d: d['arms']['A'].pop('planning_usd'), 'planning_usd'),
    (lambda d: d['arms']['A'].update(hint='pin=has space'), 'hint'),
    (lambda d: d['arms']['A'].update(worst_model=''), 'worst_model'),
    (lambda d: d['arms']['B'].pop('client_model'), 'client_model'),
])
def test_arm_table_validation(tmp_path, edit, msg):
    d = json.loads(ARMS_JSON.read_text())
    edit(d)
    p = tmp_path / 'arms.json'
    p.write_text(json.dumps(d))
    with pytest.raises(sp.PlanError, match=msg):
        sp.load_arms(p)


# ---------------------------------------------------------------- derive

def test_derive_deepswe_keeps_codex_shards_and_preregisters_both_stages(tmp_path):
    codex = sp.load_plan(profiles.DEEPSWE.plan)
    drop = min(codex['tasks'])
    plan, detail = derive('deepswe', tmp=tmp_path, drops=[drop])
    assert plan['schema'] == sp.CC_SCHEMA and plan['dataset']['agent'] == 'claude-code' and plan['seed'] == sp.CC_SEED
    assert len(plan['tasks']) == len(codex['tasks']) - 1 and drop not in plan['tasks'] and plan['dataset']['dropped'] == [drop]
    assert all(plan['tasks'][t]['shard'] == codex['tasks'][t]['shard'] for t in plan['tasks'])
    assert list(plan['passes']) == ['pilot', 'main', 'rep2', 'rep3'] and plan['arm_order'] == ['A', 'B', 'C', 'F']
    for name in ('main', 'rep2', 'rep3'):
        keys = [(it['task'], it['arm']) for s in range(plan['n_shards']) for it in sp.trials_of(plan, name, s)]
        assert sorted(keys) == sorted((t, a) for t in plan['tasks'] for a in 'ABCF')
    pilot = detail['pilot']
    assert all(len(ts) == 2 for ts in pilot.values()) and 'labels' not in plan['passes']['pilot']
    for s, (lo, hi) in pilot.items():   # q25 below q75 in Codex mean cost, both on their shard
        mean = {t: sum(c.values()) / len(c) for t, c in detail['codex_costs'].items()}
        assert plan['tasks'][lo]['shard'] == plan['tasks'][hi]['shard'] == int(s) and mean[lo] <= mean[hi]
    assert set(plan['arms']['A']) == set(sp.ARM_FIELDS)
    text = json.dumps(plan)
    assert 'spent_usd' not in text and 'codex_costs' not in text   # costs stay in the gitignored detail


def test_derive_is_deterministic_and_outcome_blind(tmp_path):
    p1, d1 = derive('deepswe', tmp=tmp_path, reward_seed=1)
    p2, d2 = derive('deepswe', tmp=tmp_path, reward_seed=2)   # different Codex rewards, same costs
    assert json.dumps(p1, sort_keys=True) == json.dumps(p2, sort_keys=True) and d1 == d2


def test_derive_tb_scanner_cal_and_long_tasks_first(tmp_path):
    plan, detail = derive('tb21', tmp=tmp_path)
    scanner = plan['passes']['pilot']['labels']['scanner-cal']
    assert len(scanner) == sp.CC_SCANNER_CAL_N and set(scanner) <= set(SCANNER_POOL) and detail['scanner_cal'] == scanner
    pilot_tasks = {it['task'] for s in range(plan['n_shards']) for it in sp.trials_of(plan, 'pilot', s)}
    assert set(scanner) <= pilot_tasks
    first = sp.tb_first(plan)
    assert first
    for s in range(plan['n_shards']):
        order = [b['task'] for b in sp.blocks_of(plan, 'main', s)]
        n = sum(1 for t in order if t in first)
        assert all(t in first for t in order[:n])


def test_a_fifth_arm_is_a_config_change(tmp_path):
    d = json.loads(ARMS_JSON.read_text())
    d['order'].append('E')
    d['arms']['E'] = {'client_model': 'global.anthropic.claude-sonnet-5-5', 'main_model': 'auto', 'hint': None, 'pack': 'v2.1', 'worst_model': 'global.anthropic.claude-opus-5-5',
                      'codex_ref': 'B', 'planning_usd': {'deepswe': 0.68, 'tb21': 0.19}}
    p = tmp_path / 'arms5.json'
    p.write_text(json.dumps(d))
    four, _ = derive('deepswe', tmp=tmp_path)
    five, detail = derive('deepswe', arms_path=p, tmp=tmp_path)
    assert five['arm_order'] == ['A', 'B', 'C', 'F', 'E'] and five['arms']['E']['pack'] == 'v2.1'
    assert all(p_['arms'] == ['A', 'B', 'C', 'F', 'E'] for p_ in five['passes'].values())
    assert sum(p_['n_trials'] for p_ in five['passes'].values()) == sum(p_['n_trials'] for p_ in four['passes'].values()) * 5 // 4
    assert drv.continuity_changes({'arms': four['arms']}, {'arms': five['arms']}) == {'arms': 'arm table'}
    rat = ccproject.ratios(five, detail, [], [])
    assert rat['E']['source'] == 'prior' and rat['E']['kappa'] > 0


# ---------------------------------------------------------------- classify (CC design §4)

def _proxy(main_last_ok=True, last_ok=False):
    last = {'ok': last_ok, 'origin': 'upstream', 'status': None if last_ok else 529}
    main = {'calls': 40, 'statuses': {'200': 40}, 'error_origins': {}, 'last_call': {'ok': main_last_ok, 'origin': 'upstream',
                                                                                      'status': None if main_last_ok else 529}}
    return {'calls': 52, 'statuses': {'200': 51, '529': 1}, 'error_origins': {'upstream': 1}, 'last_call': last,
            'calls_by_role': {'main': main, 'main_subagent': {'calls': 4}, 'helper': {'calls': 8}}}


def _result(exc=None, reward=1.0):
    return {'exception_info': {'exception_type': exc} if exc else None, 'verifier_result': {'rewards': {'reward': reward}}}


def test_main_view_reads_calls_by_role_and_falls_back():
    px = _proxy()
    v = clf.main_view(px)
    assert v['calls'] == 40 and v['last_call']['ok'] and v['calls_by_role'] is px['calls_by_role']
    legacy = {'calls': 3, 'last_call': {'ok': False}, 'main': {'calls': 2, 'last_call': {'ok': True}}}
    assert clf.main_view(legacy)['last_call'] == {'ok': True}
    plain = {'calls': 3, 'last_call': {'ok': False}}
    assert clf.main_view(plain) is plain and clf.main_view(None) is None


def test_a_failed_trailing_helper_call_is_never_a_rerun():
    c = clf.classify(_result(), _proxy(main_last_ok=True, last_ok=False), agent='claude-code', cc={'result': 'present'})
    assert c['action'] != 'rerun' and c['class'] == 'agent'
    c2 = clf.classify(_result('ApiOverloadedError', 0.0), _proxy(main_last_ok=False, last_ok=False), agent='claude-code', cc={'result': 'present'})
    assert c2['class'] == 'upstream' and c2['action'] == 'rerun'


def test_codex_path_is_unchanged_by_the_new_keys():
    px = _proxy(main_last_ok=True, last_ok=False)
    a = clf.classify(_result(), px)
    b = clf.classify(_result(), {k: v for k, v in px.items() if k != 'calls_by_role'})
    assert a == b and 'tags' not in a


def test_missing_result_event_counts_as_a_nonzero_exit():
    assert clf.CC_NO_RESULT in clf.NONZERO_EXIT
    c = clf.classify(_result(), _proxy(), agent='claude-code', cc={'result': 'missing'})
    assert c['exception_type'] == clf.CC_NO_RESULT and c['tags'] == []


@pytest.mark.parametrize('host, tags', [
    ({}, []),
    ({'oom_memcg_trial': 1, 'oom_victims': ['node']}, ['oom-container', 'victim:agent']),
    ({'mem': {'oom_kill': 1}, 'oom_victims': ['python3']}, ['oom-container', 'victim:workload']),
    ({'docker_oom': 1}, ['oom-container', 'victim:unknown']),
    ({'oom_global_trial': 1, 'oom_memcg_trial': 1, 'oom_victims': ['node']}, []),   # host OOM: a harness rerun, untagged
])
def test_oom_tags_never_change_the_class(host, tags):
    assert clf.oom_tags(_result(), host) == tags
    c = clf.classify(_result(reward=1.0), _proxy(), agent='claude-code', cc={'result': 'present'}, host=host)
    assert c['tags'] == tags
    if tags:
        assert c['class'] == 'agent' and c['action'] == 'score'


# ---------------------------------------------------------------- memory sampler, OOM victim

def test_journal_victim_parse():
    cid = 'c' * 64
    j = drv.parse_journal_line_victim(f'1700000000.5 host kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),'
                                      f'oom_memcg=/system.slice/docker-{cid}.scope,task_memcg=/system.slice/docker-{cid}.scope,task=node,pid=7,uid=0')
    assert j['task'] == 'node' and j['container_id'] == cid
    assert drv.parse_journal_line_victim('not a kernel line') is None


def test_mem_sampler_records_peaks_per_trial():
    cid = 'a' * 64
    files = {'/proc/42/cgroup': '0::/system.slice/docker-x.scope\n',
             '/sys/fs/cgroup/system.slice/docker-x.scope/memory.peak': str(3 * 2**30),
             '/sys/fs/cgroup/system.slice/docker-x.scope/memory.max': str(8 * 2**30),
             '/sys/fs/cgroup/system.slice/docker-x.scope/memory.swap.peak': str(2**29),
             '/sys/fs/cgroup/system.slice/docker-x.scope/memory.events': 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n',
             '/sys/fs/cgroup/system.slice/docker-x.scope/memory.stat': f'anon {2 * 2**30}\nfile 5\n'}

    def read(p):
        if p not in files:
            raise OSError(p)
        return files[p]

    def run(argv, **kw):
        out = {'ps': f'{cid} trial-abc__x\n{"b" * 64} other\n', 'inspect': '42\n',
               'top': 'PID RSS COMMAND\n1 1000 /bin/sh\n2 1572864 /usr/local/bin/claude\n3 2000 python3\n'}[argv[1]]
        return subprocess.CompletedProcess(argv, 0, out, '')
    m = drv.MemSampler(lambda: {'t1': 'trial-abc'}, run=run, read=read)
    m.sample()
    rec = m.take('t1')
    assert rec == {'container_mem_peak_mb': 3072, 'agent_rss_peak_mb': 1536, 'anon_peak_mb': 2048, 'swap_peak_mb': 512,
                   'mem_limit_mb': 8192, 'oom': 1, 'oom_kill': 1, 'containers': 1}
    assert m.take('t1') is None


# ---------------------------------------------------------------- continuity, blind status, exports

def test_continuity_changes():
    prev = {'plan_sha256': 'a', 'agent_pin': {'version': '1'}, 'router_policy_version': 'p1', 'concurrency': 6, 'arms': {'A': 1}}
    assert drv.continuity_changes(prev, dict(prev)) == {}
    ch = drv.continuity_changes(prev, {**prev, 'plan_sha256': 'b', 'concurrency': 4, 'router_policy_version': None})
    assert set(ch) == {'plan_sha256', 'concurrency'}


def test_blind_progress_strips_solved():
    p = {'passes': {'pilot': {'trials': 4, 'scored': 4, 'solved': 3}}, 'attempts': 4}
    assert drv.blind_progress(p) == {'passes': {'pilot': {'trials': 4, 'scored': 4}}, 'attempts': 4}


@pytest.mark.parametrize('rel, ok', [
    ('jobs/x/t/agent/claude-code.txt', True),
    ('jobs/x/t/agent/sessions/projects/-app/abc.jsonl', True),
    ('jobs/x/t/agent/sessions/.claude.json', False),
    ('jobs/x/t/agent/sessions/statsig/x', False),
    ('jobs/x/t/agent/sessions/todos/a.json', False),
    ('jobs/x/t/agent/sessions/projects/-app/notes.txt', False),
    ('jobs/x/t/result.json', True),
])
def test_cc_export_allowlist(rel, ok):
    assert drv.cc_export_ok(rel) is ok


# ---------------------------------------------------------------- projection and caps (outcome-blind)

def _merged(tmp, plan, reward=1.0, mult=None):
    """A merged dir with the pilot finished: spend = mult[arm] × the Codex cost of the paired arm."""
    mult = mult or {'A': 2.0, 'B': 1.5, 'C': 3.0, 'F': 0.5}
    out = tmp / f'merged-{reward}'
    out.mkdir(exist_ok=True)
    att, fin = [], []
    for s in range(plan['n_shards']):
        for it in sp.trials_of(plan, 'pilot', s):
            key = f"pilot/{it['task']}/{it['arm']}/r1"
            att.append({'runner': s, 'key': key, 'pass': 'pilot', 'task': it['task'], 'arm': it['arm'], 'trial_id': key.replace('/', '-'),
                        'spent_usd': None, 'wall_s': 600.0, 'calls': 50, 'throttled': 1, 'class': 'agent', 'reward': reward, 'score': reward,
                        'calls_by_role': {'main': {'calls': 40, 'cost_usd': 0.0, 'served_models': {plan['arms'][it['arm']]['main_model']: 40}
                                                   if plan['arms'][it['arm']]['main_model'] != 'auto' else {'global.anthropic.claude-sonnet-5-5': 40}},
                                          'main_subagent': {'calls': 2, 'cost_usd': 0.0}, 'helper': {'calls': 8, 'cost_usd': 0.0}},
                        'assessor_consults': 1 if it['arm'] == 'B' else 0, 'tags': [], 'cc': {'result': 'present'},
                        'host': {'mem': {'agent_rss_peak_mb': 900, 'container_mem_peak_mb': 2500}, 'psi_memory_some': 0.01}})
            fin.append({'runner': s, 'key': key, 'pass': 'pilot', 'task': it['task'], 'arm': it['arm'], 'rep': 1, 'status': 'scored', 'score': reward})
    return out, att, fin, mult


def _fill(detail, plan, att, mult):
    for r in att:
        c = detail['codex_costs'][r['task']][plan['arms'][r['arm']]['codex_ref']] * mult[r['arm']]
        r['spent_usd'] = round(c, 6)
        roles = r['calls_by_role']
        roles['main']['cost_usd'], roles['main_subagent']['cost_usd'], roles['helper']['cost_usd'] = round(0.8 * c, 6), round(0.1 * c, 6), round(0.1 * c, 6)


def _write(out, att, fin, dropped=()):
    (out / 'attempts.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in att))
    (out / 'final.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in fin))
    (out / 'checks.json').write_text(json.dumps({'dropped': list(dropped)}))


def test_kappa_from_the_pilot_and_projection(tmp_path):
    plan, detail = derive('deepswe', tmp=tmp_path)
    out, att, fin, mult = _merged(tmp_path, plan)
    _fill(detail, plan, att, mult)
    _write(out, att, fin)
    doc = ccproject.project_cc(plan, detail, out, concurrency=6, reserve=10.0, caps_for=['pilot', 'main'])
    for arm, m in mult.items():
        r = doc['ratios'][arm]
        assert r['source'] == 'measured' and r['n'] == 8 and r['kappa'] == pytest.approx(m, rel=1e-3)
        assert set(r['pilot_by_pick']) == {'q25', 'q75'}
    proj = doc['projection']
    assert proj['settled_usd'] == pytest.approx(sum(r['spent_usd'] for r in att), abs=0.05)
    assert all(v['remaining_trials']['pilot'] == 0 for v in proj['runners'].values())
    main_left = sum(v['remaining_trials']['main'] for v in proj['runners'].values())
    assert main_left == len(plan['tasks']) * 4
    expect_main = sum(mult[a] * detail['codex_costs'][t][plan['arms'][a]['codex_ref']] for t in plan['tasks'] for a in 'ABCF')
    assert proj['stages']['stage1']['remaining_usd'] == pytest.approx(expect_main, rel=1e-3)
    for r, c in doc['caps']['runners'].items():
        d = proj['runners'][r]
        assert c['hard'] >= d['settled_usd'] + 1.4 * d['remaining_usd']['main'] + 10 - 1e-6
        assert c['soft'] <= c['hard'] - 10 - d['largest_block_usd']['main'] + 1e-6
    rep = doc['report']
    assert rep['B']['attribution']['assessor_consult_violations'] == 0 and rep['A']['attribution']['served_model_violations'] == []
    assert rep['A']['helper_share'] == pytest.approx(0.1, abs=1e-3) and rep['A']['attribution']['unattributed_calls'] == 0
    assert rep['A']['attribution']['role_cost_gap_trials'] == [] and rep['A']['rate_429'] == pytest.approx(1 / 50)
    assert rep['C']['memory_mb']['agent_rss_peak_mb']['max'] == 900 and rep['C']['psi_max'] == {'psi_memory_some': 0.01}


def test_project_output_is_outcome_blind(tmp_path):
    plan, detail = derive('deepswe', tmp=tmp_path)
    docs = []
    for reward in (0.0, 1.0):
        out, att, fin, mult = _merged(tmp_path, plan, reward=reward)
        _fill(detail, plan, att, mult)
        _write(out, att, fin)
        docs.append(json.dumps(ccproject.project_cc(plan, detail, out, concurrency=6, reserve=10.0, caps_for=['main']), sort_keys=True))
    assert docs[0] == docs[1]
    assert not any(k in docs[0] for k in ('"reward"', '"score"', '"solved"'))


def test_attribution_violations_are_reported(tmp_path):
    plan, detail = derive('deepswe', tmp=tmp_path)
    _out, att, _fin, mult = _merged(tmp_path, plan)
    _fill(detail, plan, att, mult)
    a = next(r for r in att if r['arm'] == 'A')
    a['calls_by_role']['main']['served_models'] = {'global.anthropic.claude-opus-5-5': 1}
    b = next(r for r in att if r['arm'] == 'B')
    b['assessor_consults'] = 2
    c = next(r for r in att if r['arm'] == 'C')
    c['spent_usd'] += 1.0
    f = next(r for r in att if r['arm'] == 'F')
    f['calls'] += 3
    rep = ccproject.report(plan, att)
    assert rep['A']['attribution']['served_model_violations'] == [a['trial_id']]
    assert rep['B']['attribution']['assessor_consult_violations'] == 1
    assert rep['C']['attribution']['role_cost_gap_trials'] == [c['trial_id']]
    assert rep['F']['attribution']['unattributed_calls'] == 3


def test_prior_and_borrowed_kappa(tmp_path):
    plan, detail = derive('deepswe', tmp=tmp_path)
    rat = ccproject.ratios(plan, detail, [], [])
    mean_a = sum(c['A'] for c in detail['codex_costs'].values()) / len(detail['codex_costs'])
    assert rat['A']['source'] == 'prior' and rat['A']['kappa'] == pytest.approx(0.71 / mean_a, rel=1e-3)
    borrowed = ccproject.ratios(plan, detail, [], [], borrow={'A': {'source': 'measured', 'kappa': 2.5, 'tau': 1.6}})
    assert borrowed['A'] == {**borrowed['A'], 'source': 'borrowed', 'kappa': 2.5, 'tau': 1.6} and borrowed['B']['source'] == 'prior'


# ---------------------------------------------------------------- budget and caps files

def test_global_preflight_counts_every_ledger_and_outside_spend():
    budget = {'schema': ccproject.BUDGET_SCHEMA, 'total_usd': 8000, 'outside_usd': {'tier_pass': 40, 'runner_hours': 900}}
    committed = {'cc-deepswe': {'runners': {'0': {'hard': 500, 'closed': True, 'settled_usd': 310.5}, '1': {'hard': 520, 'closed': False}}},
                 'cc-tb21': {'runners': {}}}
    g = ccproject.global_preflight(budget, 'cc-tb21', {str(i): {'soft': 100, 'hard': 150} for i in range(4)}, committed)
    assert g['ok'] and g['exposure_usd'] == {'cc-deepswe': 830.5, 'cc-tb21': 600.0} and g['outside_usd'] == 940
    assert g['total_usd'] == 2370.5 and g['headroom_usd'] == 5629.5
    over = ccproject.global_preflight(budget, 'cc-tb21', {str(i): {'soft': 1500, 'hard': 1600} for i in range(4)}, committed)
    assert not over['ok']
    # re-starting a runner replaces its old hard cap rather than adding to it
    again = ccproject.global_preflight(budget, 'cc-deepswe', {'1': {'soft': 100, 'hard': 200}}, committed)
    assert again['exposure_usd']['cc-deepswe'] == 510.5


def test_commit_close_and_caps_file(tmp_path):
    doc = ccproject.commit_caps({}, {'0': {'soft': 90, 'hard': 120}}, ['pilot'], 't0')
    assert ccproject.exposure(doc) == 120
    closed = ccproject.close_caps(doc, {'0': 33.25}, 't1')
    assert ccproject.exposure(closed) == 33.25 and closed['runners']['0']['hard'] == 120
    p = tmp_path / 'caps.json'
    sp.write_json(p, ccproject.caps_doc('cc-deepswe', ['pilot', 'main'], {'0': {'soft': 90.0, 'hard': 120.0}}))
    assert ccproject.load_caps(p, 'cc-deepswe', ['main', 'pilot']) == {'0': {'soft': 90.0, 'hard': 120.0}}
    with pytest.raises(SystemExit, match='passes'):
        ccproject.load_caps(p, 'cc-deepswe', ['rep2'])
    with pytest.raises(SystemExit, match='written for'):
        ccproject.load_caps(p, 'cc-tb21', ['pilot', 'main'])


class _FakeFleet:
    """fleet.Fleet's interface for cc_start: `status` answers from `ledgers`, unit starts are recorded."""

    def __init__(self, profile, ledgers, fail=()):
        self.profile, self.runners, self.instances, self.ledgers, self.fail, self.bodies = profile, sorted(ledgers), [f'i-{i:08x}' for i in sorted(ledgers)], ledgers, fail, {}

    def each(self, fn, parallel=True):
        return {i: fn(i, self.instances[i]) for i in self.runners}

    def run(self, i, iid, body, timeout_s=600):
        if ' status' in body and 'systemd-run' not in body:
            return 'Success', json.dumps({'proxy_state': {'settled_usd': self.ledgers[i]}, 'driver_alive': False}) + '\n', ''
        self.bodies[i] = body
        return ('Failed', '', 'boom') if i in self.fail else ('Success', 'active\n', '')


def _cc_env(tmp_path, monkeypatch):
    plan, detail = derive('deepswe', tmp=tmp_path)
    prof = profiles.dataclasses.replace(profiles.CC_DEEPSWE, plan=tmp_path / 'cc' / 'deepswe' / 'plan.json', dev_results=tmp_path / 'cc' / 'results' / 'deepswe')
    other = profiles.dataclasses.replace(profiles.CC_TB21, plan=tmp_path / 'cc' / 'tb21' / 'plan.json', dev_results=tmp_path / 'cc' / 'results' / 'tb21')
    sp.write_json(prof.plan, plan)
    sp.write_json(prof.dev_results / 'plan-detail.json', detail)
    monkeypatch.setattr(profiles, 'PROFILES', {**profiles.PROFILES, prof.name: prof, other.name: other})
    sp.write_json(fleet.cc_budget_path(prof), {'schema': ccproject.BUDGET_SCHEMA, 'total_usd': 8000, 'outside_usd': {'tier_pass': 40}})
    return prof, plan, detail


def _start_ns(prof, caps_file, passes=('pilot',)):
    import argparse
    return argparse.Namespace(profile=prof, caps_file=str(caps_file), passes=list(passes), gateway_url='https://gw.example', region='ap-southeast-1',  # nosec B106: a Secrets Manager name or test argument, not a credential
                              concurrency=6, soft_cap=0, hard_cap=0, secret_id='llmar-runner/client', max_blocks=None, change_concurrency=False,
                              unstop_cap=False, token_max_age_s=None, router_policy_version='pv-1', shards=[0, 1, 2, 3])


def test_cc_start_runs_per_runner_caps_and_commits(tmp_path, monkeypatch):
    prof, _plan, _detail = _cc_env(tmp_path, monkeypatch)
    caps = {str(i): {'soft': 40.0 + i, 'hard': 120.0 + i} for i in range(4)}   # hard − reserve − soft ≥ 6 × $10.56 in flight
    cf = tmp_path / 'caps.json'
    sp.write_json(cf, ccproject.caps_doc(prof.name, ['pilot'], caps))
    fl = _FakeFleet(prof, {0: 0.0, 1: 0.0, 2: 0.0, 3: 0.0}, fail=(3,))
    res = fleet.cc_start(fl, _start_ns(prof, cf))
    assert res[3].startswith('FAILED') and all(res[i] == 'active' for i in range(3))
    for i in range(4):
        b = fl.bodies[i]
        assert f'--hard-cap {120 + i:g}' in b and f'--soft-cap {40 + i:g}' in b and '--dataset cc-deepswe' in b and '--router-policy-version pv-1' in b
    committed = json.loads(fleet.cc_committed_path(prof).read_text())
    assert sorted(committed['runners']) == ['0', '1', '2'] and committed['runners']['1']['hard'] == 121.0


def test_cc_start_refuses_over_budget_or_no_room(tmp_path, monkeypatch):
    prof, _plan, _detail = _cc_env(tmp_path, monkeypatch)
    cf = tmp_path / 'caps.json'
    sp.write_json(cf, ccproject.caps_doc(prof.name, ['pilot'], {str(i): {'soft': 2000.0, 'hard': 2100.0} for i in range(4)}))
    with pytest.raises(SystemExit, match='budget'):
        fleet.cc_start(_FakeFleet(prof, {i: 0.0 for i in range(4)}), _start_ns(prof, cf))
    sp.write_json(cf, ccproject.caps_doc(prof.name, ['pilot'], {str(i): {'soft': 40.0, 'hard': 120.0} for i in range(4)}))
    with pytest.raises(SystemExit, match='largest expected run') as e:   # runner 2 has already settled most of its cap
        fleet.cc_start(_FakeFleet(prof, {0: 0.0, 1: 0.0, 2: 49.9, 3: 0.0}), _start_ns(prof, cf))
    assert 'runner 2:' in str(e.value) and 'runner 0:' not in str(e.value)
    # the TB pilot's caps (no in-flight term): hard − reserve = $6 cannot hold six in-flight reservations
    sp.write_json(cf, ccproject.caps_doc(prof.name, ['pilot'], {str(i): {'soft': 5.0, 'hard': 16.0} for i in range(4)}))
    with pytest.raises(SystemExit, match=r'in-flight allowance \$63\.36 \(concurrency 6\).*soft \$5 leaves less than the in-flight'):
        fleet.cc_start(_FakeFleet(prof, {i: 0.0 for i in range(4)}), _start_ns(prof, cf))
    # caps written for concurrency 6 are refused for a start at 8
    sp.write_json(cf, ccproject.caps_doc(prof.name, ['pilot'], {str(i): {'soft': 40.0, 'hard': 120.0} for i in range(4)}))
    with pytest.raises(SystemExit, match=r'soft \$40 leaves less than the in-flight allowance \$84\.48'):
        import argparse
        fleet.cc_start(_FakeFleet(prof, {i: 0.0 for i in range(4)}), argparse.Namespace(**{**vars(_start_ns(prof, cf)), 'concurrency': 8}))
    import argparse
    with pytest.raises(SystemExit, match='--caps-file'):
        fleet.cc_start(_FakeFleet(prof, {0: 0.0}), argparse.Namespace(**{**vars(_start_ns(prof, cf)), 'caps_file': None}))
    assert not fleet.cc_committed_path(prof).exists()


def test_isolation_for_cc_deepswe_writes_into_its_own_results():
    assert '--out $WORK_DIR/results/isolation' in fleet.isolation_cmd('ap-southeast-1', profiles.DEEPSWE)
    assert '--out $WORK_DIR/cc-deepswe/results/isolation' in fleet.isolation_cmd('ap-southeast-1', profiles.CC_DEEPSWE)
    assert '--profile tb21' in fleet.isolation_cmd('ap-southeast-1', profiles.CC_TB21)


# ---------------------------------------------------------------- libc gate (a3; prepull and run)

def test_libc_gate_tries_glibc_then_musl_offline(tmp_path):
    seen = []

    def run(argv, timeout=None):
        seen.append(argv)
        img, build = argv[-2], argv[argv.index('--entrypoint') + 1].rsplit('/', 1)[-1]
        ok = {'deb:1': 'glibc', 'alpine:1': 'musl'}.get(img) == build
        return subprocess.CompletedProcess(argv, 0 if ok else 1, '', '')
    builds = {'glibc': tmp_path / 'claude-x64', 'musl': tmp_path / 'claude-x64-musl'}
    got = drv.claude_libc_gate({'t1': 'deb:1', 't2': 'alpine:1', 't3': 'old:1', 't4': 'deb:1'}, builds, run=run)
    assert got == {'t1': 'glibc', 't2': 'musl', 't3': None, 't4': 'glibc'}
    assert all(a[:8] == ['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint'] and a[-1] == '--version'
               and any(x.endswith(':ro') for x in a) for a in seen)
    assert len([a for a in seen if a[-2] == 'deb:1']) == 1   # one probe per image
    assert drv.claude_gate_issues({'claude_build': got}, ['t1', 't2', 't3', 't5']) == [
        't3: no pinned Claude Code build runs in its image', 't5: not libc-gated (run prepull)']
    assert drv.claude_gate_issues({'claude_build': got}, ['t1', 't2']) == []


def test_agent_pin_records_version_and_both_builds():
    pin = drv.agent_pin(profiles.CC_DEEPSWE)
    assert pin is not None and pin['version'] and set(pin['sha256']) == {'linux-x64', 'linux-x64-musl'}


# ---------------------------------------------------------------- §4.2 per call (design-stats §11–§13)

OPUS, SONNET, HAIKU = (ccproject.CC_TIER_MODEL[t] for t in ('frontier', 'standard', 'fast'))


def _role_table(tmp_path, explore='M'):
    doc = {'schema': ccproject.ROLE_TABLE_SCHEMA, 'claude_code': {'version': '2.1.318'},
           'roles': {'main': {'requested': 'M'}, 'task': {'requested': 'M'}, 'plan': {'requested': 'M'}, 'explore': {'requested': explore},
                     'compaction': {'requested': 'M'}, 'background': {'requested': None}}}
    p = tmp_path / 'role-table.json'
    p.write_text(json.dumps(doc))
    return ccproject.load_role_table(p, hashlib.sha256(p.read_bytes()).hexdigest())


def _pilot_calls(plan, att, explore_model=None):
    """Per trial: 3 main calls, 1 Task subagent, 1 Explore; served and requested as the arm's policy says."""
    calls = []
    for r in att:
        spec = plan['arms'][r['arm']]
        M = spec['main_model'] if spec['main_model'] != 'auto' else SONNET
        helper = explore_model or M
        for role, st, req in (('main', 'main', M), ('main', 'main', M), ('main', 'compaction', M), ('main_subagent', 'task', M),
                              ('helper' if helper != M else 'main_subagent', 'explore', helper)):
            calls.append({'trial_id': r['trial_id'], 'call_role': role, 'call_role_struct': st, 'requested_model': req, 'served_model': req})
        r['calls'] = 5
        r['router'] = {'complete': True, 'assessor_tier': 'standard' if spec['main_model'] == 'auto' else None,
                       'assessor_consults': 1 if spec['main_model'] == 'auto' else 0}
    return calls


def test_preconditions_pass_on_a_clean_pilot(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    calls = _pilot_calls(plan, att)
    pc = ccproject.precondition_checks(plan, att, calls, _role_table(tmp_path))
    assert pc['ok'] and pc['missing'] == [] and pc['unattributed_calls'] == 0
    assert pc['arms']['A']['calls'] == 5 * 8 and pc['arms']['A']['struct_role_agreement'] == 1.0
    assert not ccproject.precondition_checks(plan, att, calls, None)['ok']   # no role table: the gate cannot pass


def test_preconditions_catch_each_violation(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    table = _role_table(tmp_path, explore=HAIKU)   # the native table says Explore requests Haiku
    calls = _pilot_calls(plan, att)                # … but every call requested M (Harbor's alias override)
    pc = ccproject.precondition_checks(plan, att, calls, table)
    assert not pc['ok'] and pc['arms']['A']['requested_wrong']['n'] == 8 and pc['arms']['F']['requested_wrong']['n'] == 0
    calls = _pilot_calls(plan, att, explore_model=HAIKU)
    assert ccproject.precondition_checks(plan, att, calls, table)['ok']
    a = [c for c in calls if c['trial_id'] == next(r['trial_id'] for r in att if r['arm'] == 'A')]
    a[0]['served_model'] = OPUS                                     # (3) pinned main call served by another model
    a[1]['call_role_struct'] = 'mystery'                            # (2)/§13 a type not in the table
    a[2]['call_role'] = None                                        # (2) null role outside F
    a[4]['served_model'] = SONNET                                   # (5) helper not served as requested
    b = next(r for r in att if r['arm'] == 'B')
    b['router']['assessor_consults'] = 2                            # (4) one consult per root session
    b2 = [r for r in att if r['arm'] == 'B'][1]
    b2_calls = [c for c in calls if c['trial_id'] == b2['trial_id']]
    b2['router']['assessor_tier'] = 'frontier'                      # (4) B served on Sonnet but its tier maps to Opus
    c_row = next(r for r in att if r['arm'] == 'C')
    c_row['router']['complete'] = False                             # (1) router missed calls
    c_row['calls'] = 6                                              # (1) proxy count ≠ per-call records
    calls.append({'trial_id': None, 'call_role': 'main'})           # (1) an unattributed call
    pc = ccproject.precondition_checks(plan, att, calls, table)
    arms = pc['arms']
    assert not pc['ok'] and pc['unattributed_calls'] == 1
    assert arms['A']['main_served_wrong']['n'] == 1 and arms['A']['null_or_unknown_struct']['n'] == 1
    assert arms['A']['null_role']['n'] == 1 and arms['A']['helper_served_wrong']['n'] == 1
    assert arms['B']['consults_not_one']['trial_ids'] == [b['trial_id']]
    assert arms['B']['main_served_wrong']['n'] == len([c for c in b2_calls if c['call_role'] in ('main', 'main_subagent')])
    assert arms['B']['requested_wrong']['n'] >= 1                   # M_arm in B is the tier's model
    assert arms['C']['router_incomplete']['n'] == 1 and arms['C']['calls_count_mismatch']['n'] == 1


def test_null_role_in_f_is_allowed_if_served_by_the_pin(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    calls = _pilot_calls(plan, att)
    for c in calls:
        if by := next((r for r in att if r['trial_id'] == c['trial_id'] and r['arm'] == 'F'), None):
            c['call_role'] = None
            del by
    assert ccproject.precondition_checks(plan, att, calls, _role_table(tmp_path))['ok']
    next(c for c in calls if c['call_role'] is None)['served_model'] = SONNET
    assert not ccproject.precondition_checks(plan, att, calls, _role_table(tmp_path))['ok']


def test_role_table_is_loaded_by_its_recorded_hash(tmp_path):
    t = _role_table(tmp_path)
    assert ccproject.expected_model(t, 'explore', OPUS) == OPUS and ccproject.expected_model(t, 'nope', OPUS) is None
    with pytest.raises(SystemExit, match='sha256'):
        ccproject.load_role_table(tmp_path / 'role-table.json', '0' * 64)
    assert ccproject.expected_model(t, 'background', OPUS) is None   # never observed: any such call is a violation
    assert ccproject.expected_model(_role_table(tmp_path, explore=HAIKU), 'explore', OPUS) == HAIKU


def test_the_committed_native_role_table_loads():
    p = profiles.CC_HERE / 'native-roles.json'
    if not p.exists():
        pytest.skip("4f's native-roles.json is not in this checkout")
    t = ccproject.load_role_table(p, hashlib.sha256(p.read_bytes()).hexdigest())
    for typ in ('main', 'task', 'plan', 'explore', 'compaction'):
        assert ccproject.expected_model(t, typ, OPUS) == OPUS
    assert ccproject.expected_model(t, 'background', OPUS) is None
    assert ccproject.call_type({'call_type': 'explore'}) == 'explore' and ccproject.call_type({'call_role_struct': 'plan', 'call_type': 'x'}) == 'plan'


def test_merge_joins_router_logs_for_assessor_consults(tmp_path, monkeypatch):
    calls = []

    def fake_join(records, proxy_calls):
        calls.append(proxy_calls)
        return {tid: {'model_requests': n, 'expected_model_requests': n, 'complete': True, 'assessor_tier': 'standard', 'assessor_consults': 1,
                      'served_models': {SONNET: n}, 'lineages': 1, 'statuses': {'200': n}, 'assessor_status': 'ok', 'extra': 'dropped'}
                for tid, n in proxy_calls.items()}
    monkeypatch.setattr(fleet, 'cc_router_join', fake_join)
    plan, _detail = derive('deepswe', tmp=tmp_path)
    pp = tmp_path / 'plan.json'
    sp.write_json(pp, plan)
    res = tmp_path / 'fleet' / 'runner-0' / 'results'
    res.mkdir(parents=True)
    it = sp.trials_of(plan, 'pilot', 0)[0]
    key = drv.key_of('pilot', it['task'], it['arm'], 1)
    ev = [{'ev': 'start', 'key': key, 'trial_id': 't-1', 'attempt': 1, 'plan_sha256': 'x', 'at': '2026-11-07T00:00:00Z'},
          {'ev': 'end', 'key': key, 'trial_id': 't-1', 'classification': {'class': 'agent', 'action': 'score', 'score': 1.0, 'reward': 1.0, 'tags': []},
           'proxy': {'calls': 7, 'spent_usd': 0.5, 'calls_by_role': {'main': {'calls': 7}}, 'sanitized_requests': 2}, 'host': {'mem': {'agent_rss_peak_mb': 10}},
           'cc': {'result': 'present'}}]
    (res / 'attempts.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in ev))
    fleet.merge(tmp_path / 'fleet', tmp_path / 'merged', pp, router_records=[])
    row = json.loads((tmp_path / 'merged' / 'attempts.jsonl').read_text().splitlines()[0])
    assert calls == [{'t-1': 7}] and row['assessor_consults'] == 1 and 'extra' not in row['router']
    assert row['calls_by_role'] == {'main': {'calls': 7}} and row['sanitized_requests'] == 2 and row['mem'] == {'agent_rss_peak_mb': 10}
    assert row['cc'] == {'result': 'present'} and row['started_at'] == '2026-11-07T00:00:00Z'
    fleet.merge(tmp_path / 'fleet', tmp_path / 'merged2', pp)
    row2 = json.loads((tmp_path / 'merged2' / 'attempts.jsonl').read_text().splitlines()[0])
    assert row2['router'] is None and row2['assessor_consults'] is None


def test_taskpin_accepts_a_derived_plans_recorded_drops(tmp_path):
    import test_taskpin as ttp

    import taskpin as tp
    root = ttp._checkout(tmp_path)
    plan = ttp._plan(root)
    cc = {**plan, 'tasks': {k: v for k, v in plan['tasks'].items() if k != 'a-task'}, 'dataset': {**plan.get('dataset', {})}}
    assert any(i.startswith('task set: plan') for i in tp.verify(cc, root, ['b-task']))       # a silent drop is refused
    cc['dataset']['dropped'] = ['a-task']
    assert tp.verify(cc, root, ['b-task']) == []                                              # a recorded drop is not


# ---------------------------------------------------------------- 0c's A/C validation (stage 1 only)

def test_derive_an_arm_subset_and_stage_1_only(tmp_path):
    prof = profiles.get('tb21', 'claude-code')
    codex_plan = sp.load_plan(profiles.TB21.plan)
    _order, arms = sp.load_arms(ARMS_JSON)
    arms = {k: arms[k] for k in ('A', 'C')}
    att = codex_attempts(codex_plan, tmp_path / 'codex.jsonl')
    plan, detail = sp.derive_cc(codex_plan, name=prof.name, base='tb21', order=['A', 'C'], arms=arms, drops=set(),
                                costs=sp.codex_task_costs(att), walls=sp.codex_task_costs(att, 'wall_s'), tiers=None,
                                scanner_pool=SCANNER_POOL, passes=('main',))
    assert sp.validate(plan) == [] and list(plan['passes']) == ['pilot', 'main'] and plan['arm_order'] == ['A', 'C']
    assert plan['passes']['main']['n_trials'] == 2 * len(plan['tasks']) and 'category group' in plan['stratification']['blocks']
    assert set(sp.task_strata(plan)) == set(plan['tasks'])   # no tier pass needed with pinned arms only
    with pytest.raises(sp.PlanError, match='passes'):
        sp.derive_cc(codex_plan, name=prof.name, base='tb21', order=['A', 'C'], arms=arms, drops=set(), costs=sp.codex_task_costs(att),
                     passes=('rep9',))
    rat = ccproject.ratios(plan, detail, [], [], prior_m=3.0, prior_tau=1.5)
    base = ccproject.ratios(plan, detail, [], [])
    assert rat['A']['kappa'] == pytest.approx(3 * base['A']['kappa'], rel=1e-3) and rat['C']['tau'] == 1.5


OPUS, SONNET = 'global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5'
# 0c's TB pilot caps: κ borrowed from the DeepSWE pilot, 0d's m = 3, Claude Code ≈ 1.5× Codex time.
TB_BORROWED = {'A': {'source': 'measured', 'kappa': 1.3192, 'tau': 1.5}, 'C': {'source': 'measured', 'kappa': 0.5498, 'tau': 1.5}}


def _tb_ac(tmp_path):
    prof = profiles.get('tb21', 'claude-code')
    codex_plan = sp.load_plan(profiles.TB21.plan)
    _order, arms = sp.load_arms(ARMS_JSON)
    att = codex_attempts(codex_plan, tmp_path / 'codex.jsonl')
    return sp.derive_cc(codex_plan, name=prof.name, base='tb21', order=['A', 'C'], arms={k: arms[k] for k in ('A', 'C')}, drops=set(),
                        costs=sp.codex_task_costs(att), walls=sp.codex_task_costs(att, 'wall_s'), tiers=None,
                        scanner_pool=SCANNER_POOL, passes=('main',))


def test_call_ceiling_and_the_inflight_allowance(tmp_path):
    import cc_pricing
    ceiling = fleet.cc_call_ceiling('ap-southeast-1')
    assert ceiling(OPUS) == pytest.approx(cc_pricing.worst(OPUS, 1_000_000, 128_000)) == pytest.approx(10.56)
    assert ceiling(SONNET) == pytest.approx(5.28) and cc_pricing.body_max_tokens({'max_tokens': 10**9}) == cc_pricing.MAX_OUTPUT_TOKENS
    plan, _detail = _tb_ac(tmp_path)
    infl = ccproject.inflight_allowance(plan, ['pilot'], 8, ceiling)
    assert infl == {'concurrency': 8, 'calls_per_slot': 1, 'call_ceiling_usd': {OPUS: 10.56, SONNET: 5.28}, 'usd': 84.48}
    full, _ = derive('deepswe', tmp=tmp_path)    # B's rewritten calls are reserved at its worst-case model (Opus)
    assert ccproject.pass_models(full, ['main']) == sorted({OPUS, SONNET, 'global.anthropic.claude-haiku-5-5'})
    assert ccproject.inflight_allowance(full, ['main'], 6, ceiling)['usd'] == 63.36
    with pytest.raises(SystemExit, match='--region'):
        fleet.cc_call_ceiling(None)


@pytest.mark.parametrize('source', ['synthetic', 'committed'])
def test_tb_pilot_caps_admit_every_first_call(tmp_path, source):
    """The TB pilot's cap stops (0c, 2026-11-07): hard 16/16/17/16 with the $10 reserve left $6–7 for the in-flight
    reservations of 8 trials' first calls (~20k-token prompts, max_tokens 128000). With the allowance every first call
    is admitted, soft is unchanged, and at soft every slot can still hold a call at the ceiling."""
    import cc_pricing
    import hproxy
    if source == 'committed':
        dp = profiles.CC_TB21.dev_results / 'plan-detail.json'
        if not dp.exists():
            pytest.skip(f'{dp} is not on this machine (gitignored; copied from llmar-cc on deploy day)')
        plan, detail = sp.load_plan(profiles.CC_TB21.plan), json.loads(dp.read_text())
    else:
        plan, detail = _tb_ac(tmp_path)
    merged = tmp_path / 'merged'
    merged.mkdir()
    _write(merged, [], [])
    reserve = hproxy.DEFAULT_RESERVE_USD
    infl = ccproject.inflight_allowance(plan, ['pilot'], 8, fleet.cc_call_ceiling('ap-southeast-1'))
    doc = ccproject.project_cc(plan, detail, merged, concurrency=8, reserve=reserve, caps_for=['pilot'], borrow=TB_BORROWED,
                               prior_m=3.0, prior_tau=1.5, inflight=infl)
    assert doc['caps']['inflight'] == infl
    old = ccproject.suggest_caps(doc['projection'], ['pilot'], reserve)
    first = max(cc_pricing.worst(m, 20_000, cc_pricing.body_max_tokens({'max_tokens': 128_000})) for m in (OPUS, SONNET))
    ceiling = max(infl['call_ceiling_usd'].values())

    def ledger(name, cap):
        return hproxy.CapLedger(tmp_path / f'{name}.jsonl', tmp_path / f'{name}.json', cap_usd=cap, reserve_usd=reserve)

    for r, c in doc['caps']['runners'].items():
        block = doc['projection']['runners'][r]['largest_block_usd']['pilot']
        assert c['soft'] == old[r]['soft'] and c['hard'] == old[r]['hard'] + math.ceil(infl['usd'])
        assert c['hard'] - reserve - c['soft'] >= infl['usd'] + block
        led = ledger(f'new-{r}', c['hard'])
        assert all(led.admit(f'trial-{k}', first) for k in range(8)) and led.stopped is None
        before = ledger(f'old-{r}', old[r]['hard'])                   # the regression: no in-flight term
        assert not all(before.admit(f'trial-{k}', first) for k in range(8)) and before.stopped.startswith('cap: projected')
        at_soft = ledger(f'soft-{r}', c['hard'])                      # settled = soft: the driver admits no new block
        at_soft.settle(at_soft.admit('done', 0.0).call_id, c['soft'])
        assert all(at_soft.admit(f'slot-{k}', ceiling) for k in range(8)) and at_soft.stopped is None
    issues = [x for c in doc['caps']['runners'].values() for x in drv.check_caps(c['hard'], reserve, c['soft'])]
    assert issues == []


def test_voided_spend_stays_in_settled(tmp_path):
    plan, detail = _tb_ac(tmp_path)
    merged = tmp_path / 'merged'
    merged.mkdir()
    _write(merged, [], [])
    plain = ccproject.project_cc(plan, detail, merged, concurrency=8, reserve=10.0, caps_for=['pilot'], borrow=TB_BORROWED)
    (merged / 'summary.json').write_text(json.dumps({'void': {'3': [{'passes': ['pilot'], 'spent_usd': 0.4}, {'passes': ['pilot'], 'spent_usd': 0.35}]}}))
    assert ccproject.void_spend(merged) == {'3': 0.75}
    doc = ccproject.project_cc(plan, detail, merged, concurrency=8, reserve=10.0, caps_for=['pilot'], borrow=TB_BORROWED)
    r3, p3 = doc['projection']['runners']['3'], plain['projection']['runners']['3']
    assert r3['settled_usd'] == p3['settled_usd'] + 0.75 and r3['void_usd'] == 0.75 and doc['projection']['runners']['0']['void_usd'] == 0.0
    assert doc['caps']['runners']['3']['hard'] >= doc['caps']['runners']['3']['soft'] + 10 and doc['caps']['inflight'] is None


def test_pilot_caps_leave_the_soft_cap_above_the_slice_projection(tmp_path):
    proj = {'runners': {'0': {'settled_usd': 0.0, 'remaining_usd': {'pilot': 10.0}, 'largest_block_usd': {'pilot': 7.0},
                              'largest_run_usd': {'pilot': 4.0}},
                        '1': {'settled_usd': 50.0, 'remaining_usd': {'main': 200.0}, 'largest_block_usd': {'main': 8.0},
                              'largest_run_usd': {'main': 4.0}}}}
    pilot = ccproject.suggest_caps(proj, ['pilot'], 10.0)['0']
    assert pilot['soft'] >= 10.0 and pilot['hard'] == 27.0        # max(1.4 × 10, 10 + 7) + 10
    main = ccproject.suggest_caps(proj, ['main'], 10.0)['1']
    assert main['hard'] == 50 + 280 + 10 and main['soft'] == main['hard'] - 10 - 8
    with_inflight = ccproject.suggest_caps(proj, ['pilot', 'main'], 10.0, inflight=84.48)   # additive; soft unchanged
    assert with_inflight == {r: {**c, 'hard': c['hard'] + 85} for r, c in ccproject.suggest_caps(proj, ['pilot', 'main'], 10.0).items()}


# ---------------------------------------------------------------- calls that never reached the router (0c, 2026-11-07)

def _fallback_proxy(n_fallback, last_status=400, last_origin='gateway-fallback', top=True):
    """The failed DeepSWE pilot: every call answered by the gateway's Bedrock fallback (A: 400, C: 403)."""
    main = {'calls': 3, 'statuses': {str(last_status): 3}, 'error_origins': {last_origin: 3},
            'last_call': {'ok': False, 'origin': last_origin, 'status': last_status, 'code': 'invalid_request_error'}}
    px = {'calls': 3, 'statuses': {str(last_status): 3}, 'last_call': main['last_call'], 'calls_by_role': {'main': main},
          'calls_summary': {'gateway_fallback_calls': 0}}
    if top:
        px['gateway_fallback_calls'] = n_fallback
    return px


@pytest.mark.parametrize('status,origin', [(400, 'upstream'), (403, 'gateway'), (400, 'gateway-fallback'), (200, None)])
def test_a_call_that_never_reached_the_router_is_a_harness_rerun(status, origin):
    res = _result('NonZeroAgentExitCodeError' if status != 200 else None, 0.0)
    before = clf.classify(res, _fallback_proxy(0, status, origin), agent='claude-code', cc={'result': 'present'})
    c = clf.classify(res, _fallback_proxy(3, status, origin), agent='claude-code', cc={'result': 'present'})
    assert c['class'] == 'harness' and c['action'] == 'rerun' and c['score'] is None
    assert c['reason'].startswith('3 of 3 model calls never reached the router')
    if status == 400 and origin == 'upstream':
        assert before['class'] == 'agent'   # what the A pilot got: scored
    assert clf.classify(res, _fallback_proxy(3, status, origin), agent='claude-code', killed='operator')['class'] == 'cancelled'
    cap = {**_fallback_proxy(3, status, origin), 'cap_stopped': True}
    assert clf.classify(res, cap, agent='claude-code')['class'] == 'cap_stop'


def test_fallback_count_reads_4fs_key_and_the_200_floor():
    assert clf.fallback_calls(None) == 0 and clf.fallback_calls({'calls': 2}) == 0
    assert clf.fallback_calls({'gateway_fallback_calls': 2, 'calls_summary': {'gateway_fallback_calls': 1}}) == 2
    assert clf.fallback_calls({'calls_summary': {'gateway_fallback_calls': 1}}) == 1
    assert clf.fallback_calls({'gateway_fallback_calls': True}) == 0
    c = clf.classify(_result(), {'calls': 9, 'last_call': {'ok': True}, 'calls_summary': {'gateway_fallback_calls': 1}}, agent='claude-code')
    assert c['class'] == 'harness'


def test_codex_classify_ignores_the_fallback_keys():
    px = _fallback_proxy(3, 200, None)
    assert clf.classify(_result(), px) == clf.classify(_result(), {k: v for k, v in px.items() if k != 'gateway_fallback_calls'})


# ---------------------------------------------------------------- void-pass and requeue (append-only operator events)

def _tid(n):
    return f'{n:032x}'


def _ev_attempt(key, tid, n, cls='agent', action='score', spent=0.0, final=None):
    out = [{'ev': 'start', 'key': key, 'trial_id': tid, 'attempt': n, **dict(zip(('pass', 'task', 'arm', 'rep'), key.split('/'))), 'at': 1.0},
           {'ev': 'pid', 'key': key, 'trial_id': tid, 'pid': 1},
           {'ev': 'end', 'key': key, 'trial_id': tid, 'classification': {'class': cls, 'action': action, 'reward': 0.0, 'score': 0.0, 'reason': 'r'},
            'proxy': {'calls': 3, 'spent_usd': spent}}]
    if final:
        out.append({'ev': 'final', 'key': key, 'trial_id': tid, 'status': final, 'phase': key.split('/')[0], 'block': 0,
                    **dict(zip(('pass', 'task', 'arm', 'rep'), key.split('/')))})
    return out


def _pilot_log(paths):
    """Two pilot keys: A scored (the fallback 400s), C excluded after 3 harness attempts (the 403s)."""
    ka, kc = 'pilot/t1/A/r1', 'pilot/t1/C/r1'
    ev = [{'ev': 'run-start', 'passes': ['pilot'], 'at': 0.5}, *_ev_attempt(ka, _tid(1), 1, final='scored')]
    for n in (1, 2, 3):
        ev += _ev_attempt(kc, _tid(10 + n), n, 'harness', 'rerun', spent=0.25, final='excluded' if n == 3 else None)
    ev.append({'ev': 'run-end', 'at': 9.0})
    paths.events.write_text(''.join(json.dumps(e) + '\n' for e in ev))
    drv.write_json(paths.run_config, {'concurrency': 6, 'plan_sha256': 'p' * 64, 'arms': {'A': {}}, 'history': [{'at': 'x'}]})
    return ka, kc


def _paths(tmp_path):
    p = drv.Paths(tmp_path, profiles.CC_DEEPSWE)
    p.mkdirs()
    return p


def test_void_pass_forgets_the_pilot_append_only(tmp_path):
    paths = _paths(tmp_path)
    ka, kc = _pilot_log(paths)
    before = paths.events.read_bytes()
    out = drv.void_pass(paths, ['pilot'], 'gateway fallback; rerun after the hproxy fix')
    assert out['keys'] == 2 and out['attempts'] == 4 and out['spent_usd'] == 0.75 and out['passes'] == ['pilot']
    assert paths.events.read_bytes().startswith(before)            # nothing rewritten: the old events and rewards stay
    assert not paths.run_config.exists() and (paths.results / out['run_config_moved_to']).exists()
    ev = drv.read_jsonl(paths.events)
    assert ev[-1]['ev'] == 'void' and ev[-1]['events_sha256'] == hashlib.sha256(before).hexdigest()
    assert ev[-1]['run_config']['concurrency'] == 6 and sorted(drv.voided(ev)) == sorted([_tid(1), _tid(11), _tid(12), _tid(13)])
    items = [{'pass': 'pilot', 'phase': 'pilot', 'block': 0, 'task': 't1', 'arm': a, 'rep': 1} for a in ('A', 'C')]
    st = drv.replay(ev, items)
    assert all(not ks.attempts and ks.final is None and ks.next_action() == ('start', None) for ks in st.values())
    ev += _ev_attempt(ka, _tid(20), 1, final='scored')             # the re-run pilot: attempt numbers start at 1 again
    st = drv.replay(ev, items)
    assert [a.trial_id for a in st[ka].attempts] == [_tid(20)] and st[ka].final['trial_id'] == _tid(20) and not st[kc].attempts
    with pytest.raises(SystemExit, match='no attempts'):
        drv.void_pass(_paths(tmp_path / 'empty'), ['pilot'], 'nothing here')


def test_void_pass_refuses_other_passes_and_orphans(tmp_path):
    paths = _paths(tmp_path)
    _pilot_log(paths)
    with open(paths.events, 'a') as f:
        f.write(json.dumps({'ev': 'start', 'key': 'main/t2/A/r1', 'trial_id': _tid(30), 'attempt': 1, 'pass': 'main'}) + '\n')
    with pytest.raises(SystemExit, match=r"also has attempts of \['main'\]"):
        drv.void_pass(paths, ['pilot'], 'reset')
    paths2 = _paths(tmp_path / 'b')
    _pilot_log(paths2)
    with open(paths2.events, 'a') as f:
        f.write(json.dumps({'ev': 'start', 'key': 'pilot/t3/A/r1', 'trial_id': _tid(40), 'attempt': 1, 'pass': 'pilot'}) + '\n')
    with pytest.raises(SystemExit, match='no end event'):
        drv.void_pass(paths2, ['pilot'], 'reset')
    assert paths2.run_config.exists()                               # refused before anything moved
    with pytest.raises(SystemExit, match='--reason'):
        drv.plain_reason('acct ' + '7' * 12)   # N5: built at runtime


def test_requeue_turns_a_scored_attempt_into_a_harness_rerun(tmp_path):
    paths = _paths(tmp_path)
    ka, kc = _pilot_log(paths)
    out = drv.requeue(paths, [_tid(1), _tid(13), _tid(11), _tid(99)], 'router-short')
    assert out['requeued'] == 1
    assert out['skipped'] == {_tid(13): 'its key is not scored (excluded)', _tid(11): "not its key's last attempt",
                              _tid(99): 'not in the event log (or voided)'}
    ev = drv.read_jsonl(paths.events)
    assert ev[-1]['ev'] == 'reclass' and ev[-1]['from'] == {'class': 'agent', 'action': 'score'}
    items = [{'pass': 'pilot', 'phase': 'pilot', 'block': 0, 'task': 't1', 'arm': a, 'rep': 1} for a in ('A', 'C')]
    st = drv.replay(ev, items)
    assert st[ka].final is None and st[ka].attempts[0].outcome['class'] == 'harness' and st[ka].next_action() == ('rerun', None)
    assert st[ka].reruns == 1 and st[kc].final['status'] == 'excluded'
    assert drv.requeue(paths, [_tid(1)], 'router-short')['skipped'] == {_tid(1): 'already requeued'}
    with pytest.raises(SystemExit, match='bad trial id'):
        drv.requeue(paths, ['../x'], 'router-short')


def _merge_fixture(tmp_path, plan, ev, calls):
    pp = tmp_path / 'plan.json'
    sp.write_json(pp, plan)
    res = tmp_path / 'fleet' / 'runner-0' / 'results'
    (res / 'proxy').mkdir(parents=True)
    (res / 'attempts.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in ev))
    (res / 'proxy' / 'calls.jsonl').write_text(''.join(json.dumps(c) + '\n' for c in calls))
    return pp


def test_merge_keeps_voided_calls_out_of_the_gates(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    it = sp.trials_of(plan, 'pilot', 0)[0]
    key = drv.key_of('pilot', it['task'], it['arm'], 1)
    ev = _ev_attempt(key, _tid(1), 1, final='scored')
    ev.append({'ev': 'void', 'passes': ['pilot'], 'trial_ids': [_tid(1)], 'reason': 'x', 'keys': 1, 'attempts': 1, 'spent_usd': 0.0, 'at': 2.0})
    ev += _ev_attempt(key, _tid(2), 1, final='scored')
    pp = _merge_fixture(tmp_path, plan, ev, [{'trial_id': _tid(1), 'seq': 1}, {'trial_id': _tid(2), 'seq': 1}])
    summ = fleet.merge(tmp_path / 'fleet', tmp_path / 'merged', pp)
    att = drv.read_jsonl(tmp_path / 'merged' / 'attempts.jsonl')
    assert [r['trial_id'] for r in att] == [_tid(2)]
    assert [c['trial_id'] for c in drv.read_jsonl(tmp_path / 'merged' / 'calls.jsonl')] == [_tid(2)]
    assert [c['trial_id'] for c in drv.read_jsonl(tmp_path / 'merged' / 'calls-void.jsonl')] == [_tid(1)]
    assert summ['void_calls'] == 1 and summ['void']['0'][0]['passes'] == ['pilot']


def test_merge_reclassifies_router_short_attempts_and_lists_requeues(tmp_path, monkeypatch):
    seen = []

    def fake_join(records, proxy_calls):
        seen.append(dict(proxy_calls))
        return {_tid(1): {'model_requests': 2, 'expected_model_requests': 3, 'complete': False},
                _tid(2): {'model_requests': 5, 'expected_model_requests': 5, 'complete': True}}
    monkeypatch.setattr(fleet, 'cc_router_join', fake_join)
    plan, _detail = derive('deepswe', tmp=tmp_path)
    its = sp.trials_of(plan, 'pilot', 0)
    k = [drv.key_of('pilot', i['task'], i['arm'], 1) for i in its[:3]]
    ev = _ev_attempt(k[0], _tid(1), 1, final='scored') + _ev_attempt(k[1], _tid(2), 1, final='scored')
    ev += _ev_attempt(k[2], _tid(3), 1, 'harness', 'rerun')
    ev[-1]['proxy'] = {'calls': 2, 'refused': {'budget': 2}}       # nothing forwarded: the router owes no record
    pp = _merge_fixture(tmp_path, plan, ev, [])
    summ = fleet.merge(tmp_path / 'fleet', tmp_path / 'merged', pp, router_records=[])
    rows = {r['trial_id']: r for r in drv.read_jsonl(tmp_path / 'merged' / 'attempts.jsonl')}
    assert seen == [{_tid(1): 3, _tid(2): 3, _tid(3): 0}]
    short = rows[_tid(1)]
    assert short['router_short'] and short['class'] == 'harness' and short['action'] == 'rerun' and short['score'] is None
    assert short['reclassified_from'] == {'class': 'agent', 'action': 'score'} and 'router log saw 2 of 3' in short['reason']
    assert not rows[_tid(2)]['router_short'] and rows[_tid(2)]['class'] == 'agent'
    assert rows[_tid(3)]['router'] == {'complete': True, 'model_requests': 0, 'expected_model_requests': 0}
    rq = json.loads((tmp_path / 'merged' / 'requeue.json').read_text())
    assert rq == {'schema': 'cc-requeue/v1', 'why': 'router-short', 'runners': {'0': [{'trial_id': _tid(1), 'key': k[0]}]}}
    assert summ['requeue'] == {'0': 1} and summ['router_short_attempts'] == 1


def test_cc_requeue_sends_the_list_per_runner(tmp_path):
    (tmp_path / 'requeue.json').write_text(json.dumps({'schema': 'cc-requeue/v1', 'why': 'router-short',
                                                       'runners': {'1': [{'trial_id': _tid(5), 'key': 'k'}]}}))
    sent = []

    class FL:
        profile = profiles.CC_DEEPSWE

        def run(self, i, iid, body, timeout):
            sent.append((i, body))
            return 'Success', '{"requeued": 1, "skipped": {}}\n', ''

        def each(self, fn):
            return {i: fn(i, f'i-{i}') for i in (0, 1)}
    res = fleet.cc_requeue(FL(), tmp_path / 'requeue.json')
    assert res == {0: 'nothing to requeue', 1: '{"requeued": 1, "skipped": {}}'}
    assert len(sent) == 1 and f'requeue --why router-short --trial-id {_tid(5)}' in sent[0][1]
    with pytest.raises(SystemExit, match='merge --router-logs'):
        fleet.cc_requeue(FL(), tmp_path / 'nope.json')


def test_preconditions_gate_fallback_pins_and_superseded_short_attempts(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    calls = _pilot_calls(plan, att)
    table = _role_table(tmp_path)
    assert ccproject.precondition_checks(plan, att, calls, table)['ok']
    a = next(r for r in att if r['arm'] == 'A')
    a['gateway_fallback_calls'] = 2
    c = next(r for r in att if r['arm'] == 'C')
    c['pin_served_other'] = 1
    pc = ccproject.precondition_checks(plan, att, calls, table)
    assert not pc['ok'] and pc['arms']['A']['gateway_fallback']['n'] == 1 and pc['arms']['C']['pin_served_other']['n'] == 1
    a['gateway_fallback_calls'], c['pin_served_other'] = 0, 0
    old = {**a, 'trial_id': a['trial_id'] + '-old', 'attempt': 1, 'router': {'complete': False}, 'calls': 0}
    a['attempt'] = 2                                               # the short attempt was requeued and rerun
    pc = ccproject.precondition_checks(plan, [*att, old], calls, table)
    assert pc['ok'] and pc['router_short_superseded']['n'] == 1 and pc['arms']['A']['router_incomplete']['n'] == 0


def _ct(trial_id, **kw):
    """A count_tokens record as hproxy writes it (the DeepSWE pilot re-run): answered locally with 404, no seq."""
    return {'trial_id': trial_id, 'leaf': 'messages/count_tokens', 'method': 'POST', 'status': 404, 'origin': 'gateway', 'local': True,
            'call_role': None, 'call_role_struct': None, 't_start': 12.5, 'runner': 0, **kw}


def test_count_tokens_calls_meeting_the_predicate_are_exempt_and_listed(tmp_path):
    """0d §16: one count_tokens 404 per trial in 4 trials (2 A, 2 C), null role, not in the proxy's model-call count."""
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    calls = _pilot_calls(plan, att)
    for r in att:
        r['router'].update({'requests': 5, 'model_requests': 5, 'expected_model_requests': 5})
    table = _role_table(tmp_path)
    picked = [r for r in att if r['arm'] == 'A'][:2] + [r for r in att if r['arm'] == 'C'][:2]
    cts = [_ct(r['trial_id']) for r in picked[:3]]
    cts.append(_ct(picked[3]['trial_id'], call_role='non_model', call_role_struct='non_model', call_type='count_tokens'))  # 4f's tag
    pc = ccproject.precondition_checks(plan, att, [*calls, *cts], table)
    assert pc['ok'], {a: {k: v['n'] for k, v in x.items() if isinstance(v, dict) and v.get('n')} for a, x in pc['arms'].items()}
    assert pc['arms']['A']['count_tokens'] == {'n': 2, 'n_404': 2, 'trials_with': 2} == pc['arms']['C']['count_tokens']
    assert pc['arms']['B']['count_tokens'] == {'n': 0, 'n_404': 0, 'trials_with': 0}
    assert pc['arms']['A']['calls'] == 5 * 8 and pc['arms']['A']['calls_count_mismatch']['n'] == 0
    assert sorted(x['trial_id'] for x in pc['count_tokens_exempt']) == sorted(r['trial_id'] for r in picked)
    assert pc['count_tokens_exempt'][0] == {'trial_id': pc['count_tokens_exempt'][0]['trial_id'], 'seq': None, 't_start': 12.5, 'runner': 0}
    del att[0]['router']['requests']   # rows from a merge before the join kept `requests`: the router-event leg is unverifiable
    pc = ccproject.precondition_checks(plan, att, [*calls, *cts], table)
    assert not pc['ok'] and pc['missing'] == ['router requests on 1 attempts (re-merge --router-logs with this fleet.py)']


@pytest.mark.parametrize('edit', [{'status': 200}, {'status': 400}, {'method': 'GET'}, {'origin': 'upstream'}, {'cost_usd': 0.01},
                                  {'unpriced_estimate_usd': 0.002}, {'usage': {'prompt': 10}}, {'router': {'x-router-model': 'm'}},
                                  {'via_router': True}, {'leaf': 'messages', 'call_type': 'count_tokens'}, 'router-event',
                                  {'call_type': 'count_tokens'}, {'call_type': 'models'}, {'call_role': 'main'},
                                  {'call_type': 'count_tokens', 'call_role': 'non_model', 'call_role_struct': 'non_model', 'status': 200}])
def test_a_count_tokens_call_breaking_the_predicate_stops_the_run(tmp_path, edit):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    calls = _pilot_calls(plan, att)
    a = next(r for r in att if r['arm'] == 'A')
    a['router'].update({'requests': 5, 'model_requests': 5, 'expected_model_requests': 5})
    ct = _ct(a['trial_id'])
    if edit == 'router-event':   # a router log event joined to the trial beyond its forwarded model calls
        a['router']['requests'] = 6
    else:
        ct.update(edit)
    if ct['leaf'] == 'messages':
        ct.update(call_role='non_model', call_role_struct='non_model')
        a['calls'] += 1          # tagged count_tokens but on the model path: hproxy counted it as a model call
    pc = ccproject.precondition_checks(plan, att, [*calls, ct], _role_table(tmp_path))
    assert not pc['ok'] and pc['arms']['A']['count_tokens_predicate_broken']['trial_ids'] == [a['trial_id']]
    assert pc['count_tokens_exempt'] == []


def test_other_calls_still_fail_next_to_count_tokens(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    calls = _pilot_calls(plan, att)
    table = _role_table(tmp_path)
    a, a2 = [r for r in att if r['arm'] == 'A'][:2]
    base = [*calls, _ct(a['trial_id'])]
    other = {'trial_id': a['trial_id'], 'leaf': 'messages', 'method': 'POST', 'status': 200, 'call_role': None,
             'call_role_struct': None, 'requested_model': SONNET, 'served_model': SONNET}
    pc = ccproject.precondition_checks(plan, att, [*base, other], table)   # any other null-role call still fails
    assert not pc['ok'] and pc['arms']['A']['null_role']['n'] == 1 and pc['arms']['A']['null_or_unknown_struct']['n'] == 1
    assert pc['arms']['A']['calls_count_mismatch']['n'] == 1             # and is a model call the proxy did not count
    models = {'trial_id': a['trial_id'], 'leaf': 'models', 'method': 'GET', 'status': 200, 'local': True,
              'call_role': 'non_model', 'call_role_struct': 'non_model', 'call_type': 'models'}
    pc = ccproject.precondition_checks(plan, att, [*base, models], table)  # another path: fails, but is no model call
    assert not pc['ok'] and pc['arms']['A']['null_role']['n'] == 1 and pc['arms']['A']['calls_count_mismatch']['n'] == 0
    pc = ccproject.precondition_checks(plan, att, [*base, _ct(None)], table)
    assert not pc['ok'] and pc['unattributed_calls'] == 1                  # an orphan count_tokens call
    a2['router'].update({'requests': 6, 'model_requests': 6, 'expected_model_requests': 5})
    pc = ccproject.precondition_checks(plan, att, base, table)             # router events the proxy never forwarded
    assert not pc['ok'] and pc['arms']['A']['calls_count_mismatch']['trial_ids'] == [a2['trial_id']]


# ---------------------------------------------------------------- refusals whose fallback the pin blocks (0d §18, Amendment 9)

def _refusal_calls(tid, m, n_refusals=2, served=None, refused='model-not-allowed', after=()):
    """The TB main pattern: the pinned model refuses (stop_reason refusal) twice, Claude Code switches the session to its
    built-in fallback model, hproxy's pool check refuses that request (no body fields recorded) and the session ends."""
    calls = [{'trial_id': tid, 'seq': s, 't_start': 10.0 + s, 'method': 'POST', 'leaf': 'messages', 'status': 200, 'origin': None,
              'stop_reason': 'refusal', 'requested_model': m, 'served_model': served or m, 'call_role': 'main', 'call_role_struct': 'main',
              'cost_usd': 0.05, 'usage': {'prompt': 100}, 'via_router': True, 'router': {'x-router-model': served or m}, 'runner': 0}
             for s in range(1, n_refusals + 1)]
    calls.append({'trial_id': tid, 'seq': n_refusals + 1, 't_start': 20.0, 'method': 'POST', 'leaf': 'messages', 'status': 403,
                  'origin': 'proxy', 'refused': refused, 'model_not_found': False, 'runner': 0})
    return calls + list(after)


def test_refusal_fallback_predicate_from_call_records_and_from_the_summary():
    ok = clf.refusal_evidence(_refusal_calls('t', OPUS))
    assert clf.refusal_fallback_blocked(ok, OPUS) and ok['refusals'] == {OPUS: 2}
    assert not clf.refusal_fallback_blocked(ok, SONNET) and not clf.refusal_fallback_blocked(ok, None)   # served by M_arm only
    assert not clf.refusal_fallback_blocked(clf.refusal_evidence(_refusal_calls('t', OPUS, n_refusals=0)), OPUS)
    assert not clf.refusal_fallback_blocked(clf.refusal_evidence(_refusal_calls('t', OPUS, refused='budget')), OPUS)
    went_on = _refusal_calls('t', OPUS, after=[{'trial_id': 't', 'seq': 9, 't_start': 30.0, 'leaf': 'messages', 'status': 200, 'origin': None}])
    assert not clf.refusal_fallback_blocked(clf.refusal_evidence(went_on), OPUS)          # not the terminal API error
    local = _refusal_calls('t', OPUS, after=[{'trial_id': 't', 'seq': None, 't_start': 30.0, 'leaf': 'messages/count_tokens', 'status': 404}])
    assert clf.refusal_fallback_blocked(clf.refusal_evidence(local), OPUS)               # count_tokens is not a model call
    deepswe = [{**_refusal_calls('t', OPUS, n_refusals=1)[0]}, {'trial_id': 't', 'seq': 2, 't_start': 12.0, 'leaf': 'messages', 'status': 200}]
    assert not clf.refusal_fallback_blocked(clf.refusal_evidence(deepswe), OPUS)          # DeepSWE: one refusal, then it went on
    px = {'refusals': {OPUS: 2}, 'last_call': {'status': 403, 'origin': 'proxy', 'ok': False},
          'last_failure': {'status': 403, 'origin': 'proxy', 'refused': 'model-not-allowed'}}
    assert clf.refusal_fallback_blocked(clf.summary_refusal_evidence(px), OPUS)
    assert not clf.refusal_fallback_blocked(clf.summary_refusal_evidence({**px, 'last_call': {'status': 200, 'origin': None}}), OPUS)


def test_hproxy_summary_counts_refusals_for_the_run_time_rule():
    import hproxy
    fleet.set_experiment_region('ap-southeast-1')
    recs = [{k: v for k, v in c.items() if k not in ('trial_id', 'runner')} for c in _refusal_calls('t', OPUS)]
    s = hproxy.trial_summary('t', None, recs, None)
    assert s['refusals'] == {OPUS: 2} and s['last_failure']['refused'] == 'model-not-allowed'
    assert clf.refusal_fallback_blocked(clf.summary_refusal_evidence(s), OPUS)


def test_classify_scores_a_blocked_refusal_fallback_as_sut():
    px = {**_proxy(), 'calls': 3, 'refusals': {OPUS: 2}, 'last_call': {'status': 403, 'origin': 'proxy', 'ok': False},
          'last_failure': {'status': 403, 'origin': 'proxy', 'refused': 'model-not-allowed'}, 'refused': {'model-not-allowed': 1}}
    res, cc = _result('UnknownApiError', 0.0), {'result': 'present', 'is_error': True}
    old = clf.classify(res, px, agent='claude-code', cc=cc)
    assert old['class'] == 'upstream' and old['action'] == 'rerun'                       # what TB main recorded
    c = clf.classify(res, px, agent='claude-code', cc=cc, m_arm=OPUS)
    assert (c['class'], c['action'], c['reason'], c['score']) == ('sut', 'score_zero', clf.REFUSAL_FALLBACK, 0.0)
    assert c['reclassified_from'] == {'class': 'upstream', 'action': 'rerun', 'reason': old['reason']}
    assert clf.classify(res, px, agent='claude-code', cc=cc, m_arm=SONNET)['class'] == 'upstream'
    assert clf.classify(res, {**px, 'gateway_fallback_calls': 1}, agent='claude-code', cc=cc, m_arm=OPUS)['class'] == 'harness'
    assert clf.classify(res, px, agent='claude-code', cc=cc, m_arm=OPUS, killed='wall-timeout')['class'] == 'harness'
    assert clf.classify(res, {**px, 'cap_stopped': True}, agent='claude-code', cc=cc, m_arm=OPUS)['class'] == 'cap_stop'
    assert clf.classify(res, px)['class'] != 'sut'                                        # the Codex path has no such rule
    assert drv.pinned_model({'arms': {'C': {'main_model': OPUS}, 'B': {'main_model': 'auto'}}}, 'C') == OPUS
    assert drv.pinned_model({'arms': {'B': {'main_model': 'auto'}}}, 'B') is None and drv.pinned_model({'arms': ['A']}, 'A') is None


def test_merge_reclasses_refusal_fallback_attempts_and_supersedes_the_reruns(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    its = sp.trials_of(plan, 'pilot', 0)
    kc = next(drv.key_of('pilot', i['task'], 'C', 1) for i in its if i['arm'] == 'C')
    ka = next(drv.key_of('pilot', i['task'], 'A', 1) for i in its if i['arm'] == 'A')
    ev, calls = [], []
    for n in (1, 2, 3):
        tid = _tid(20 + n)
        one = _ev_attempt(kc, tid, n, 'upstream', 'rerun', spent=0.1, final='excluded' if n == 3 else None)
        next(e for e in one if e['ev'] == 'end')['proxy'] = {'calls': 3, 'spent_usd': 0.1, 'refused': {'model-not-allowed': 1}}
        ev += one
        calls += _refusal_calls(tid, OPUS)
    ends = [e for e in ev if e['ev'] == 'end']
    ends[0].update({'trial_dir': 'jobs/a1/t', 'verifier_s': 11.0})
    ends[1].update({'trial_dir': 'jobs/a2/t'})
    ev += _ev_attempt(ka, _tid(30), 1, final='scored')
    calls += _refusal_calls(_tid(30), SONNET, n_refusals=1)[:1] + [{'trial_id': _tid(30), 'seq': 2, 't_start': 12.0, 'leaf': 'messages', 'status': 200}]
    pp = _merge_fixture(tmp_path, plan, ev, calls)
    res = tmp_path / 'fleet' / 'runner-0' / 'results'
    for d, model in (('a1', 'claude-opus-4-8'), ('a2', 'not a model id')):
        (res / 'jobs' / d / 't' / 'agent').mkdir(parents=True)
        (res / 'jobs' / d / 't' / 'agent' / 'claude-code.txt').write_text(
            json.dumps({'type': 'assistant'}) + '\n'
            + json.dumps({'type': 'system', 'subtype': 'model_refusal_fallback', 'fallback_model': model, 'api_refusal_category': 'cyber'}) + '\n')
    summ = fleet.merge(tmp_path / 'fleet', tmp_path / 'merged', pp)
    rows = {r['trial_id']: r for r in drv.read_jsonl(tmp_path / 'merged' / 'attempts.jsonl')}
    a1, a2, a3 = (rows[_tid(20 + n)] for n in (1, 2, 3))
    for r in (a1, a2, a3):
        assert (r['class'], r['action'], r['reason'], r['score']) == ('sut', 'score_zero', clf.REFUSAL_FALLBACK, 0.0)
        assert r['reclassified_from'] == {'class': 'upstream', 'action': 'rerun', 'reason': 'r'} and r['final_status'] == 'scored'
    assert a1['is_final'] and not a2['is_final'] and a2['superseded_by'] == a3['superseded_by'] == _tid(21) and 'superseded_by' not in a1
    assert (a1['refusal_fallback_model'], a1['refusal_category']) == ('claude-opus-4-8', 'cyber') and a2['refusal_fallback_model'] is None
    assert a3['refusal_fallback_model'] is None                                           # no transcript exported
    assert rows[_tid(30)]['class'] == 'agent' and 'refusal_fallback' not in rows[_tid(30)]  # one refusal, then it went on
    fin = {f['key']: f for f in drv.read_jsonl(tmp_path / 'merged' / 'final.jsonl')}
    f = fin[kc]
    assert (f['status'], f['trial_id'], f['class'], f['score'], f['attempts'], f['reruns']) == ('scored', _tid(21), 'sut', 0.0, 1, 0)
    assert f['superseded'] == [_tid(22), _tid(23)] and f['verifier_ran'] is True
    assert f['reclassified_from'] == {'status': 'excluded', 'trial_id': _tid(23), 'class': None, 'reason': None, 'attempts': None}
    assert fin[ka]['status'] == 'scored' and 'reclassified_from' not in fin[ka]
    rf = summ['refusal_fallback']
    assert summ['excluded'] == [] and rf['attempts'] == 3 and rf['keys'] == [kc] and rf['keys_by_arm'] == {'C': 1}
    assert rf['superseded_attempts'] == 2 and rf['superseded_spent_usd'] == 0.2 and rf['classify_version'] == clf.VERSION
    assert rf['fallback_model_by_arm'] == {'C': {'claude-opus-4-8 (cyber)': 1}}
    assert rf['finals'] == [{'key': kc, 'trial_id': _tid(21), 'verifier_ran': True, 'tests_ran': None}]
    assert not any(k in json.dumps(rf) for k in ('"reward"', '"score"'))


def test_gate_reports_refusal_fallback_requests_as_deviations(tmp_path):
    plan, _detail = derive('deepswe', tmp=tmp_path)
    _, att, _, _ = _merged(tmp_path, plan)
    calls = _pilot_calls(plan, att)
    table = _role_table(tmp_path)
    c = next(r for r in att if r['arm'] == 'C')
    calls += [{**x, 'trial_id': c['trial_id'], 'seq': 100 + x['seq'], 't_start': 100.0 + x['t_start']} for x in _refusal_calls('x', OPUS)]
    c['calls'] = 5 + 3
    for r in att:
        r['pass'] = 'main'  # nosec B105: pass name, not a credential
    pc = ccproject.precondition_checks(plan, att, calls, table)
    assert pc['ok'], {a: {k: v['n'] for k, v in x.items() if isinstance(v, dict) and v.get('n')} for a, x in pc['arms'].items()}
    assert pc['arms']['C']['deviations'] == {'n': 1, 'by_type': {clf.REFUSAL_FALLBACK: 1}, 'trials_with': 1, 'tasks': [c['task']]}
    d = pc['deviations']
    assert len(d) == 1 and d[0]['role'] == 'deviation' and d[0]['type'] == clf.REFUSAL_FALLBACK and d[0]['requested_model'] is None
    assert pc['arms']['C']['calls_count_mismatch']['n'] == 0 and pc['arms']['C']['null_role']['n'] == 0
    c['pass'] = 'pilot'                                                                   # a pilot deviation still fails the gate  # nosec B105: pass name, not a credential
    pc = ccproject.precondition_checks(plan, att, calls, table)
    assert not pc['ok'] and pc['arms']['C']['deviation_in_pilot']['n'] == 1
    c['pass'] = 'main'  # nosec B105: pass name, not a credential
    a = next(r for r in att if r['arm'] == 'A')                                           # no refusal before it: not a deviation
    calls.append({'trial_id': a['trial_id'], 'seq': 50, 't_start': 50.0, 'method': 'POST', 'leaf': 'messages', 'status': 403,
                  'origin': 'proxy', 'refused': 'model-not-allowed'})
    a['calls'] = 6
    pc = ccproject.precondition_checks(plan, att, calls, table)
    assert not pc['ok'] and pc['arms']['A']['null_role']['n'] == 1 and pc['arms']['A']['deviations']['n'] == 0
    assert pc['arms']['C']['deviations']['n'] == 1
