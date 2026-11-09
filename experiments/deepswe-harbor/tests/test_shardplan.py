"""Shard plan (design §9, §7.3, §7.6): stratified shards, block and arm order, R1 sample, extra passes, cuts."""
import collections
import hashlib
import json
import pathlib
import random

import pytest

import shardplan as sp

PUBLIC = pathlib.Path('/tmp/deepswe-data')


def synth(n_tasks=40, langs=('go', 'python', 'typescript', 'rust'), seed=1):
    """Synthetic public data in the shape of tasks.json / trials.json (ids, languages, scored attempts)."""
    rng = random.Random(seed)
    rows, trials = [], []
    for i in range(n_tasks):
        tid = f'task-{i:03d}'
        rows.append({'id': tid, 'language': langs[i % len(langs)] if i < n_tasks - 3 else 'javascript'})
        p = rng.random()
        for m in sp.PLAN_MODELS:
            for k in range(4):
                trials.append({'task_name': tid, 'model': m, 'reasoning_effort': 'high', 'included_in_score': True,
                               'passed': rng.random() < p, 'cost_usd': 1.0 + rng.random()})
        trials.append({'task_name': tid, 'model': 'gpt-5-6-sol', 'reasoning_effort': 'high', 'included_in_score': False, 'passed': False})
        trials.append({'task_name': tid, 'model': 'gpt-5-6-sol', 'reasoning_effort': 'low', 'included_in_score': True, 'passed': True})
    return {'n_tasks': n_tasks, 'rows': rows}, {'rows': trials}


def test_public_rates_use_scored_high_effort_attempts_of_the_three_models():
    tj, rj = synth(8)
    rates = sp.public_rates(rj, {r['id'] for r in tj['rows']})
    for t, r in rates.items():
        assert set(r['by_model']) == set(sp.PLAN_MODELS)
        assert r['attempts'] == {m: 4 for m in sp.PLAN_MODELS}   # the excluded and the low-effort rows are left out
        assert r['rate'] == pytest.approx(sum(r['by_model'].values()) / 3)


def test_a_task_without_scored_attempts_is_an_error():
    tj, rj = synth(4)
    rj['rows'] = [r for r in rj['rows'] if not (r['task_name'] == 'task-000' and r['model'] == 'gpt-6-astra')]
    with pytest.raises(sp.PlanError):
        sp.public_rates(rj, {r['id'] for r in tj['rows']})


def test_shards_are_balanced_by_language_and_size_and_deterministic():
    tj, rj = synth(41)
    plan, detail = sp.build(tj, rj, n_shards=4)
    sizes = collections.Counter(m['shard'] for m in plan['tasks'].values())
    assert sorted(sizes.values()) == [10, 10, 10, 11]
    for lang in {r['language'] for r in tj['rows']}:
        per = [sum(1 for m in plan['tasks'].values() if m['shard'] == s and m['language'] == lang) for s in range(4)]
        assert max(per) - min(per) <= 1, (lang, per)
    again, _ = sp.build(tj, rj, n_shards=4)
    assert again == plan
    other, _ = sp.build(tj, rj, n_shards=4, seed=7)
    assert other['tasks'] != plan['tasks']
    assert set(detail['balance']) == {'0', '1', '2', '3', 'all'}


def test_committed_plan_has_no_rates_or_costs():
    tj, rj = synth(12)
    plan, detail = sp.build(tj, rj, n_shards=2)
    text = json.dumps(plan)
    assert 'rate' not in json.dumps(plan['tasks']) and 'cost' not in text
    assert all(set(m) <= {'language', 'difficulty', 'shard', 'task_toml_sha256_b64'} for m in plan['tasks'].values())
    assert 'tasks' in detail and all('rate' in v for v in detail['tasks'].values())


def test_main_pass_blocks_follow_design_seed_and_arm_order_is_a_seeded_permutation():
    tj, rj = synth(20)
    plan, _ = sp.build(tj, rj, n_shards=2)
    for s in (0, 1):
        tasks = sorted(t for t, m in plan['tasks'].items() if m['shard'] == s)
        want = list(tasks)
        random.Random(sp.SEED + s).shuffle(want)
        blocks = plan['passes']['main']['shards'][str(s)]
        assert [b['task'] for b in blocks] == want
        assert [b['block'] for b in blocks] == list(range(1, len(tasks) + 1))
        for b in blocks:
            assert sorted(b['arms']) == sorted(sp.ARMS)
            assert b['arms'] == sp.arm_order('main', b['task'], sp.ARMS)
    orders = {tuple(b['arms']) for bs in plan['passes']['main']['shards'].values() for b in bs}
    assert len(orders) > 1


def test_trials_of_flattens_blocks_in_launch_order():
    tj, rj = synth(8)
    plan, _ = sp.build(tj, rj, n_shards=2)
    tr = sp.trials_of(plan, 'main', 0)
    assert len(tr) == 4 * 4
    assert [t['block'] for t in tr] == sorted(t['block'] for t in tr)
    assert all(t['phase'] == 'main' and t['rep'] == 1 for t in tr)


def test_tier_sample_is_per_shard_stratified_and_seeded():
    tj, rj = synth(41)
    plan, _ = sp.build(tj, rj, n_shards=4)
    tiers = {t: ('fast', 'standard', 'standard', 'frontier')[i % 4] for i, t in enumerate(sorted(plan['tasks']))}
    by = sp.tier_sample(plan, tiers, 4)
    for s, ts in by.items():
        assert len(ts) == 4 and len(set(ts)) == 4
        assert all(plan['tasks'][t]['shard'] == s for t in ts)
    assert sp.tier_sample(plan, tiers, 4) == by
    sp.add_pass(plan, 'rep4', 'repeat', ('A',), 4, by, ordered=True)
    assert plan['passes']['rep4']['order'] == 'given'
    assert [b['task'] for b in plan['passes']['rep4']['shards']['0']] == by[0]
    with pytest.raises(sp.PlanError):
        sp.tier_sample(plan, {}, 4)


def test_default_passes_are_main_rep2_rep3():
    tj, rj = synth(20)
    plan, _ = sp.build(tj, rj, n_shards=2)
    assert list(plan['passes']) == ['main', 'rep2', 'rep3']
    p = plan['passes']
    assert (p['main']['arms'], p['main']['rep'], p['main']['order']) == (list(sp.ARMS), 1, 'random')
    assert (p['rep2']['arms'], p['rep2']['rep'], p['rep2']['order'], p['rep2']['phase']) == (list(sp.ARMS), 2, 'stratified', 'repeat')
    assert (p['rep3']['arms'], p['rep3']['rep'], p['rep3']['order']) == (['A', 'B'], 3, 'stratified')
    for name in p:
        for s in ('0', '1'):
            assert sorted(b['task'] for b in p[name]['shards'][s]) == sorted(t for t, m in plan['tasks'].items() if m['shard'] == int(s))
    assert [b['task'] for b in p['rep2']['shards']['0']] != [b['task'] for b in p['main']['shards']['0']]
    assert sp.validate(plan) == []


def test_b_is_costed_at_its_tier_pass_model():
    tj, rj = synth(8)
    tiers = {r['id']: 'frontier' for r in tj['rows']}
    _, d0 = sp.build(tj, rj, n_shards=2)
    _, d1 = sp.build(tj, rj, n_shards=2, tiers=tiers)
    assert d0['balance']['all']['public_cost_usd_one_pass']['B'] == d0['balance']['all']['public_cost_usd_one_pass']['A']
    assert d1['balance']['all']['public_cost_usd_one_pass']['B'] == d1['balance']['all']['public_cost_usd_one_pass']['C']


def test_arm_level_cut_keeps_other_arms_of_later_blocks():
    tj, rj = synth(20)
    plan, _ = sp.build(tj, rj, n_shards=2)
    n = len(plan['passes']['rep2']['shards']['0'])
    sp.cut_pass(plan, 'rep2', 3, 'checkpoint: C on a subset', ('C',))
    bs = sp.blocks_of(plan, 'rep2', 0)
    assert len(bs) == n
    assert all('C' in b['arms'] for b in bs[:3]) and not any('C' in b['arms'] for b in bs[3:])
    assert sum(1 for t in sp.trials_of(plan, 'rep2', 0) if t['arm'] == 'C') == 3
    with pytest.raises(sp.PlanError):
        sp.cut_pass(plan, 'rep3', 2, '', ('C',))


def test_add_pass_refuses_duplicate_keys_and_foreign_tasks():
    tj, rj = synth(12)
    plan, _ = sp.build(tj, rj, n_shards=2)
    with pytest.raises(sp.PlanError):   # (task, A, 1) already belongs to main
        sp.add_pass(plan, 'again', 'repeat', ('A',), 1, sp.shard_tasks(plan), ordered=False)
    t1 = next(t for t, m in plan['tasks'].items() if m['shard'] == 1)
    with pytest.raises(sp.PlanError):
        sp.add_pass(plan, 'bad', 'repeat', ('A',), 2, {0: [t1]}, ordered=False)
    sp.add_pass(plan, 'pilot', 'pilot', ('A', 'F', 'C', 'B'), 1, sp.sample_tasks(plan, 3, 0), ordered=True)   # pilot may repeat main
    sp.add_pass(plan, 'ab4', 'repeat', ('A', 'B'), 4, sp.shard_tasks(plan), ordered=False)
    assert sp.validate(plan) == []
    with pytest.raises(sp.PlanError):   # (task, A, 2) belongs to rep2
        sp.add_pass(plan, 'x', 'repeat', ('A',), 2, {0: [next(t for t, m in plan['tasks'].items() if m['shard'] == 0)]}, ordered=True)


def test_stratified_order_prefixes_are_stratified_and_cut_limits_blocks():
    tj, rj = synth(41)
    plan, _ = sp.build(tj, rj, n_shards=2)
    sp.add_pass(plan, 'c2', 'repeat', ('C',), 5, sp.shard_tasks(plan), ordered=False, order='stratified')
    strata = sp.task_strata(plan)
    for s in ('0', '1'):
        order = [b['task'] for b in plan['passes']['c2']['shards'][s]]
        n = len(order)
        totals = collections.Counter(strata[t] for t in order)
        for k in range(1, n + 1):
            got = collections.Counter(strata[t] for t in order[:k])
            for st, tot in totals.items():
                assert abs(got[st] - k * tot / n) <= 1.0 + 1e-9, (s, k, st)
    sp.cut_pass(plan, 'c2', 5, 'checkpoint')
    assert len(sp.blocks_of(plan, 'c2', 0)) == 5 and len(sp.trials_of(plan, 'c2', 0)) == 5
    sp.cut_pass(plan, 'c2', None, '')
    assert len(sp.blocks_of(plan, 'c2', 0)) == len(plan['passes']['c2']['shards']['0'])
    with pytest.raises(sp.PlanError):
        sp.cut_pass(plan, 'main', 3, '')


def test_systematic_sample_spreads_over_the_order():
    xs = [f'x{i}' for i in range(30)]
    got = sp.systematic_sample(xs, 10, 'seed')
    idx = [xs.index(g) for g in got]
    assert idx == sorted(idx) and all(b - a == 3 for a, b in zip(idx, idx[1:]))


@pytest.mark.skipif(not (PUBLIC / 'tasks.json').exists(), reason='public DeepSWE artifacts not on this machine')
def test_real_public_data_gives_four_balanced_shards():
    tj = json.loads((PUBLIC / 'tasks.json').read_text())
    rj = json.loads((PUBLIC / 'trials.json').read_text())
    plan, detail = sp.build(tj, rj)
    assert len(plan['tasks']) == 113
    assert sorted(collections.Counter(m['shard'] for m in plan['tasks'].values()).values()) == [28, 28, 28, 29]
    rates = [b['mean_rate'] for k, b in detail['balance'].items() if k != 'all']
    overall = sum(v['rate'] for v in detail['tasks'].values()) / 113
    assert max(abs(r - overall) for r in rates) < 0.05
    assert plan['passes']['main']['n_trials'] == 452 and plan['passes']['rep2']['n_trials'] == 452 and plan['passes']['rep3']['n_trials'] == 226


def test_committed_plan_file_is_valid_and_matches_the_rebuild():
    if not sp.PLAN.exists():
        pytest.skip('plan.json not built yet')
    plan = sp.load_plan()
    assert sp.validate(plan) == []
    assert len(plan['tasks']) == 113 and plan['n_shards'] == 4
    if (PUBLIC / 'tasks.json').exists():
        tj = json.loads((PUBLIC / 'tasks.json').read_text())
        rj = json.loads((PUBLIC / 'trials.json').read_text())
        rebuilt, _ = sp.build(tj, rj)
        assert {t: m['shard'] for t, m in rebuilt['tasks'].items()} == {t: m['shard'] for t, m in plan['tasks'].items()}
        assert rebuilt['passes']['main']['shards'] == plan['passes']['main']['shards']


def test_pilot_sample_one_task_per_shard_in_distinct_languages():
    tj, rj = synth(41)
    plan, detail = sp.build(tj, rj, n_shards=4)
    by = sp.pilot_sample(plan, detail['tasks'])
    assert sorted(by) == [0, 1, 2, 3] and all(len(v) == 1 for v in by.values())
    assert all(plan['tasks'][v[0]]['shard'] == s for s, v in by.items())
    assert len({plan['tasks'][v[0]]['language'] for v in by.values()}) == 4
    assert sp.pilot_sample(plan, detail['tasks']) == by
    sp.add_pass(plan, 'pilot', 'pilot', sp.ARMS, 1, by, ordered=True)
    assert sp.validate(plan) == [] and plan['passes']['pilot']['n_trials'] == 16


def test_committed_plan_has_the_four_passes_and_a_one_task_per_runner_pilot():
    if not sp.PLAN.exists():
        pytest.skip('plan.json not built yet')
    plan = sp.load_plan()
    # rep4, rep3c and rep5: the headroom extension added at the checkpoint under design §7.5.1 (block lists match the
    # pre-registered sha256 prefixes 601119d55872a290, e20dd41b9921c197 and b00727866ecc3fa3); rep4c and rep5c: C and F
    # to 5 runs after the user's budget increase (design §11).
    assert set(plan['passes']) == {'main', 'rep2', 'rep3', 'pilot', 'pilot2', 'rep4', 'rep3c', 'rep5', 'rep4c', 'rep5c'}
    for name, rep in (('rep4c', 4), ('rep5c', 5)):
        p = plan['passes'][name]
        assert (p['arms'], p['rep'], p['order'], p['phase']) == (['C', 'F'], rep, 'stratified', 'repeat')
        assert sorted(b['task'] for bs in p['shards'].values() for b in bs) == sorted(plan['tasks'])
    for name, pre in (('rep4', '601119d55872a290'), ('rep3c', 'e20dd41b9921c197'), ('rep5', 'b00727866ecc3fa3')):
        blocks = {s: [b['task'] for b in bs] for s, bs in plan['passes'][name]['shards'].items()}
        assert hashlib.sha256(json.dumps(blocks, sort_keys=True).encode()).hexdigest()[:16] == pre
    pil = plan['passes']['pilot']
    assert pil['phase'] == 'pilot' and sorted(pil['shards']) == ['0', '1', '2', '3']
    tasks = [b['task'] for bs in pil['shards'].values() for b in bs]
    assert len(tasks) == 4 and len({plan['tasks'][t]['language'] for t in tasks}) == 4
    # pilot2: the re-run of the cap-stopped pilot, the same task on every shard, phase pilot (outside the analysis)
    p2 = plan['passes']['pilot2']
    assert p2['phase'] == 'pilot' and p2['arms'] == list(sp.ARMS) and p2['rep'] == 1
    assert {s: [b['task'] for b in bs] for s, bs in p2['shards'].items()} == {s: [b['task'] for b in bs] for s, bs in pil['shards'].items()}
    assert all(p['cut'] is None for p in plan['passes'].values())
