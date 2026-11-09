"""Known-value tests for stats.py (stdlib only)."""

from __future__ import annotations

import json
import math
import random

import pytest

import stats


def approx(x, rel=1e-6, abs=1e-9):
    return pytest.approx(x, rel=rel, abs=abs)


def rows(arm, resolved, costs=None, cached=None, inp=None, **extra):
    n = len(resolved)
    out = []
    for i in range(n):
        r = {'task_id': f't{i:03d}', 'arm': arm, 'resolved': resolved[i], 'cost_usd': (costs or [1.0] * n)[i],
             'input_tokens': (inp or [100] * n)[i], 'cached_tokens': (cached or [50] * n)[i], 'exit_reason': 'done',
             'cost_source': 'router'}
        for k, v in extra.items():
            r[k] = v[i]
        out.append(r)
    return out


# --- exact / closed form ---------------------------------------------------------------------------------------------

def test_mcnemar_exact_known_values():
    assert stats.mcnemar_exact(0, 0) == 1.0
    assert stats.mcnemar_exact(1, 0) == 1.0
    assert stats.mcnemar_exact(0, 5) == approx(0.0625)  # 2 · (1/2)^5
    assert stats.mcnemar_exact(2, 10) == approx(2 * 79 / 4096)  # 2 · (C(12,0)+C(12,1)+C(12,2)) / 2^12
    assert stats.mcnemar_exact(10, 2) == stats.mcnemar_exact(2, 10)
    assert stats.mcnemar_exact(3, 3) == 1.0


def test_wilson_known_values():
    assert stats.wilson(0, 10) == (0.0, approx(0.277533, rel=1e-5))
    lo, hi = stats.wilson(5, 10)
    assert (lo, hi) == (approx(0.236593, rel=1e-5), approx(0.763407, rel=1e-5))
    assert stats.wilson(0, 0) is None


def test_hybrid_unpaired_matches_newcombe_1998a():
    # Newcombe (1998a) example: 56/70 vs 48/80, method 10 (score, no CC): 0.0524 to 0.3339
    lo, hi = stats._hybrid(56 / 70, stats.wilson(56, 70), 48 / 80, stats.wilson(48, 80))
    assert lo == approx(0.0524, rel=0, abs=5e-5)
    assert hi == approx(0.3339, rel=0, abs=5e-5)


def test_ni_sample_size_and_zero_events():
    assert stats.ni_sample_size(0.2) == 157  # (1.96 + 0.8416)² · 0.2 / 0.01
    assert stats.ni_sample_size(0.2, true_diff=0.05) == 70
    with pytest.raises(ValueError):
        stats.ni_sample_size(0.2, margin=0.05, true_diff=-0.05)
    assert stats.zero_events_upper(100) == approx(1 - 0.05 ** (1 / 100))
    assert 0.0295 < stats.zero_events_upper(100) < 0.03  # "rule of three"
    assert stats.zero_events_upper(0) is None


# --- H2 -----------------------------------------------------------------------------------------------------------------

def paired(e, f, g, h):
    a = [True] * e + [True] * f + [False] * g + [False] * h
    b = [True] * e + [False] * f + [True] * g + [False] * h
    return a, b


def test_paired_diff_counts_point_and_ci():
    a, b = paired(36, 12, 2, 0)  # A 48/50, B 38/50
    r = stats.paired_diff(a, b)
    assert (r['n'], r['both'], r['a_only'], r['b_only'], r['neither']) == (50, 36, 12, 2, 0)
    assert r['diff'] == approx(-0.2)
    assert r['discordance'] == approx(14 / 50)
    assert r['p_mcnemar'] == approx(stats.mcnemar_exact(12, 2))
    lo, hi = r['ci']
    # hand computation of Newcombe's paired method 10 for this table (phi = −24/√43776)
    assert lo == approx(-0.34043, rel=0, abs=5e-5)
    assert hi == approx(-0.05693, rel=0, abs=5e-5)
    # the paired interval reduces to the unpaired one when phi = 0, and is symmetric under swapping arms
    rs = stats.paired_diff(b, a)
    assert rs['diff'] == approx(0.2)
    assert rs['ci'] == (approx(-hi), approx(-lo))


def test_paired_diff_identical_arms_and_empty():
    a = [True] * 30 + [False] * 20
    r = stats.paired_diff(a, a)
    assert r['diff'] == 0 and r['p_mcnemar'] == 1.0 and r['discordance'] == 0
    assert r['ci'][0] < 0 < r['ci'][1]
    e = stats.paired_diff([], [])
    assert e['diff'] is None and e['ci'] is None
    with pytest.raises(ValueError):
        stats.paired_diff([True], [True, False])


def test_paired_diff_coverage_is_near_nominal():
    # Monte Carlo check of the paired CI (independent of the formula): n=50, pA=0.6, pB=0.5, 20% discordance
    rng = random.Random(7)
    cells = [(0.45, 'e'), (0.15, 'f'), (0.05, 'g'), (0.35, 'h')]  # pA = .60, pB = .50, discordance .20
    covered = 0
    sims = 2000
    for _ in range(sims):
        a, b = [], []
        for _ in range(50):
            u, acc = rng.random(), 0.0
            for p, c in cells:
                acc += p
                if u < acc:
                    break
            a.append(c in 'ef')
            b.append(c in 'eg')
        lo, hi = stats.paired_diff(a, b)['ci']
        covered += lo <= -0.1 <= hi
    assert 0.93 <= covered / sims <= 0.975


def test_noninferiority():
    assert stats.noninferiority(-0.05) == {'margin': 0.1, 'ci_lo': -0.05, 'noninferior': True}
    assert stats.noninferiority(-0.12)['noninferior'] is False
    assert stats.noninferiority(-0.10)['noninferior'] is False  # strictly above −margin
    assert stats.noninferiority(None)['noninferior'] is None


def test_n50_at_20pct_discordance_cannot_show_ni_when_equal():
    # D8: equal rates, 10 discordant pairs split 5/5 → CI ≈ ±12 pp, NI at 10 pp not shown
    a, b = paired(20, 5, 5, 20)
    r = stats.paired_diff(a, b)
    assert r['diff'] == 0
    assert -0.15 < r['ci'][0] < -0.10 and 0.10 < r['ci'][1] < 0.15
    assert stats.noninferiority(r['ci'][0])['noninferior'] is False


# --- H1 -----------------------------------------------------------------------------------------------------------------

def test_cost_ratio_constant_ratio_collapses_ci():
    a = [0.5, 1.0, 2.0, 4.0, 8.0]
    b = [x * 0.5 for x in a]
    r = stats.cost_ratio(a, b, seed=1, n_boot=500)
    for k in ('ratio_of_sums', 'median_ratio', 'geomean_ratio'):
        assert r[k]['point'] == approx(0.5)
        assert r[k]['ci'] == (approx(0.5), approx(0.5))
    assert r['primary'] == 'ratio_of_sums'
    assert r['sum_a'] == approx(15.5) and r['sum_b'] == approx(7.75)


def test_cost_ratio_minority_saving_median_hides_it():
    # D7 example: 15 of 50 tasks at 1/20 of the cost, 35 unchanged
    a = [1.0] * 50
    b = [0.05] * 15 + [1.0] * 35
    r = stats.cost_ratio(a, b, seed=3, n_boot=2000)
    assert r['median_ratio']['point'] == approx(1.0)
    assert r['ratio_of_sums']['point'] == approx(35.75 / 50)  # 0.715: total spend −28.5%
    assert r['geomean_ratio']['point'] == approx(math.exp(15 * math.log(0.05) / 50))
    lo, hi = r['ratio_of_sums']['ci']
    assert lo < 0.715 < hi < 1.0


def test_cost_ratio_skips_zero_costs_for_per_task_ratios_and_is_seeded():
    a = [1.0, 2.0, 0.0, 4.0]
    b = [2.0, 2.0, 1.0, 0.0]
    r = stats.cost_ratio(a, b, seed=5, n_boot=300)
    assert r['n'] == 4 and r['n_ratio'] == 2
    assert r['ratio_of_sums']['point'] == approx(5 / 7)
    assert r['median_ratio']['point'] == approx(1.5)  # median of 2.0 and 1.0
    assert r == stats.cost_ratio(a, b, seed=5, n_boot=300)
    rng = random.Random(0)
    xa = [rng.uniform(0.2, 3.0) for _ in range(40)]
    xb = [rng.uniform(0.2, 3.0) for _ in range(40)]
    ci5 = stats.cost_ratio(xa, xb, seed=5, n_boot=300)['ratio_of_sums']['ci']
    assert ci5 == stats.cost_ratio(xa, xb, seed=5, n_boot=300)['ratio_of_sums']['ci']
    assert ci5 != stats.cost_ratio(xa, xb, seed=6, n_boot=300)['ratio_of_sums']['ci']


def test_bootstrap_does_not_touch_global_random_state():
    random.seed(123)
    expected = random.random()
    random.seed(123)
    stats.cost_ratio([1.0, 2.0, 3.0], [1.0, 1.0, 1.0], seed=9, n_boot=200)
    assert random.random() == expected


def test_usd_per_solved():
    r = stats.usd_per_solved([1.0, 2.0, 3.0, 4.0], [True, False, True, False], seed=2, n_boot=1000)
    assert r['point'] == approx(5.0) and r['solved'] == 2
    assert r['ci'][0] <= 5.0
    z = stats.usd_per_solved([1.0, 2.0], [False, False])
    assert z['point'] is None and z['ci'] is None
    # one solved task in 10: many replicates have zero solved → unbounded upper limit
    s = stats.usd_per_solved([1.0] * 10, [True] + [False] * 9, seed=4, n_boot=1000)
    assert s['point'] == approx(10.0) and s['ci'][1] is None and s['undefined_reps'] > 25


def test_usd_per_solved_ratio():
    r = stats.usd_per_solved_ratio([1.0] * 4, [True, True, False, False], [4.0] * 4, [True, True, True, False],
                                   seed=1, n_boot=500)
    assert r['point'] == approx((16 / 3) / (4 / 2))
    assert r['ci'] is not None


# --- H4 -----------------------------------------------------------------------------------------------------------------

def test_cache_hit_diff():
    a = rows('A', [True] * 4, cached=[50] * 4, inp=[100] * 4)
    b = rows('B', [True] * 4, cached=[60] * 4, inp=[100] * 4)
    r = stats.cache_hit_diff(a, b, seed=1, n_boot=200)
    assert (r['rate_a'], r['rate_b'], r['diff']) == (approx(0.5), approx(0.6), approx(0.1))
    assert r['ci'] == (approx(0.1), approx(0.1)) and r['within_margin'] is True
    # weighted by tokens, not by run
    a2 = rows('A', [True] * 2, cached=[0, 900], inp=[100, 1000])
    b2 = rows('B', [True] * 2, cached=[0, 900], inp=[100, 1000])
    assert stats.cache_hit_diff(a2, b2, n_boot=50)['rate_a'] == approx(900 / 1100)
    worse = stats.cache_hit_diff(a, rows('B', [True] * 4, cached=[40] * 4), n_boot=50)
    assert worse['diff'] == approx(-0.1) and worse['within_margin'] is False


def test_rows_must_be_aligned():
    a = rows('A', [True, False])
    b = rows('B', [True, False])
    b[0]['task_id'] = 'other'
    with pytest.raises(ValueError, match='not aligned'):
        stats.cache_hit_diff(a, b)


# --- composite, strata, weighting --------------------------------------------------------------------------------------

def test_compare_arms_is_json_serialisable_and_consistent():
    a = rows('A', [True, True, False, False, True], costs=[1, 2, 3, 4, 5])
    b = rows('B', [True, False, True, False, True], costs=[1, 1, 1, 1, 1])
    r = stats.compare_arms(a, b, seed=1, n_boot=200)
    json.dumps(r, allow_nan=False)
    assert r['resolve']['diff'] == 0
    assert r['cost']['ratio_of_sums']['point'] == approx(5 / 15)
    assert r['noninferiority']['ci_lo'] == r['resolve']['ci'][0]
    assert r['exit_a'] == {'done': 5}


def test_by_stratum_takes_b_value_then_a_and_flags_small_strata():
    n = 12
    a = rows('A', [True] * n, size_bucket=['small'] * 6 + ['large'] * 6, assessor_tier=[None] * n)
    b = rows('B', [True] * n, size_bucket=['small'] * 6 + ['large'] * 6,
             assessor_tier=['fast'] * 3 + ['standard'] * 8 + [None])
    tiers = stats.by_stratum(a, b, 'assessor_tier', fn=lambda xa, xb: {'k': len(xb)})
    assert {k: v['n'] for k, v in tiers.items()} == {'fast': 3, 'none': 1, 'standard': 8}
    assert all(v['descriptive_only'] for v in tiers.values())
    sizes = stats.by_stratum(a, b, 'size_bucket', seed=1, n_boot=50)
    assert sizes['small']['n'] == 6 and sizes['small']['resolve']['diff'] == 0
    json.dumps(sizes, allow_nan=False)


def test_weighted_estimates_reweight_to_the_population_mix():
    # sample: 10 fast (B much cheaper, resolves 2 fewer), 10 standard (identical)
    pt = ['fast'] * 10 + ['standard'] * 10
    a = rows('A', [True] * 20, costs=[1.0] * 20, pred_tier=pt)
    b = rows('B', [False] * 2 + [True] * 18, costs=[0.1] * 10 + [1.0] * 10, pred_tier=pt)
    # population: 10% fast, 90% standard
    w = {'fast': 50, 'standard': 450, 'frontier': 0}
    rd = stats.weighted_resolve_diff(a, b, w, seed=1, n_boot=500)
    assert rd['diff'] == approx(0.1 * -0.2)  # sample estimate would be −0.1
    assert rd['weights'] == {'fast': 0.1, 'standard': 0.9, 'frontier': 0.0}
    assert rd['n_by_stratum'] == {'fast': 10, 'standard': 10}
    assert rd['ci'][0] <= rd['diff'] <= rd['ci'][1]
    cr = stats.weighted_cost_ratio(a, b, w, seed=1, n_boot=500)
    assert cr['ratio'] == approx(0.1 * 0.1 + 0.9 * 1.0)  # 0.91; the sample ratio of sums is 0.55
    assert cr['ci'] == (approx(0.91), approx(0.91))  # constant costs within strata
    assert stats.cost_ratio([r['cost_usd'] for r in a], [r['cost_usd'] for r in b], n_boot=10)['ratio_of_sums']['point'] == approx(0.55)


def test_weighted_estimates_reject_unestimable_strata():
    pt = ['standard'] * 4
    a = rows('A', [True] * 4, pred_tier=pt)
    b = rows('B', [True] * 4, pred_tier=pt)
    with pytest.raises(ValueError, match='no sampled tasks'):
        stats.weighted_resolve_diff(a, b, {'standard': 9, 'fast': 1})
    with pytest.raises(ValueError, match='without a population weight'):
        stats.weighted_cost_ratio(a, b, {'fast': 1})
    with pytest.raises(ValueError, match='non-negative'):
        stats.weighted_cost_ratio(a, b, {'standard': 0})


def test_arm_summary():
    r = stats.arm_summary(rows('D', [True, False, True, True, False], costs=[1, 1, 1, 1, 1],
                               served_model=['global.openai.gpt-6.1-sol'] * 5))
    assert r['rate'] == approx(0.6) and r['usd_per_solved'] == approx(5 / 3)
    assert r['served_model'] == {'global.openai.gpt-6.1-sol': 5}
    json.dumps(r, allow_nan=False)


# --- §11: ideal per-task router ------------------------------------------------------------------------------------------

def _arm(arm, spec):
    """spec: list of (task_id, resolved, cost)."""
    return [{'task_id': t, 'arm': arm, 'resolved': ok, 'cost_usd': c} for t, ok, c in spec]


F4 = _arm('F', [('t0', True, 0.05), ('t1', False, 0.10), ('t2', False, 0.02), ('t3', True, 0.03)])
A4 = _arm('A', [('t0', True, 1.0), ('t1', True, 1.0), ('t2', False, 1.0), ('t3', False, 2.0)])


def test_ideal_router_known_values():
    r = stats.ideal_router({'F': F4, 'A': A4}, order=('F', 'A'), baselines={'always_sol': 'A', 'assessor_choice': 'A'},
                           seed=1, n_boot=500)
    assert r['n'] == 4 and r['choice_counts'] == {'F': 3, 'A': 1} and r['unsolved_tasks'] == 1
    assert [p['choice'] for p in r['per_task']] == ['F', 'A', 'F', 'F']  # t2 unsolved → cheapest arm run (F)
    assert r['ideal'] == {'solved': 3, 'rate': 0.75, 'cost': approx(1.10)}
    v = r['vs']['always_sol']
    assert (v['arm'], v['solved'], v['cost']) == ('A', 2, approx(5.0))
    assert v['resolve_diff']['diff'] == approx(0.25)
    assert v['cost_ratio']['point'] == approx(1.10 / 5.0)
    lo, hi = v['resolve_diff']['ci']
    assert 0.0 <= lo <= 0.25 <= hi  # ≥ 0 by construction when the baseline arm is in order
    assert r['vs']['assessor_choice'] == v  # the assessor chose standard (= A) on every task
    json.dumps(r, allow_nan=False)


def test_ideal_router_unsolved_baseline_rule():
    r = stats.ideal_router({'F': F4, 'A': A4}, order=('F', 'A'), unsolved='baseline', n_boot=50)
    assert r['choice_counts'] == {'F': 2, 'A': 2}
    assert r['ideal']['cost'] == approx(0.05 + 1.0 + 1.0 + 0.03)
    assert r['vs']['always_sol']['cost_ratio']['point'] == approx(2.08 / 5.0)


def test_ideal_router_subset_arms_and_task_set():
    c = _arm('C', [('t1', True, 5.0), ('t2', True, 4.0)])  # C run on two tasks only
    # all four tasks: C is considered only where it was run
    r = stats.ideal_router({'F': F4, 'A': A4, 'C': c}, order=('F', 'A', 'C'), n_boot=50)
    assert [(p['task_id'], p['choice'], p['arms_run']) for p in r['per_task']] == [
        ('t0', 'F', ['F', 'A']), ('t1', 'A', ['F', 'A', 'C']), ('t2', 'C', ['F', 'A', 'C']), ('t3', 'F', ['F', 'A'])]
    # C's subset only (the pre-registered {F, A, C} set)
    s = stats.ideal_router({'F': F4, 'A': A4, 'C': c}, order=('F', 'A', 'C'), tasks=['t1', 't2'], n_boot=50)
    assert s['n'] == 2 and s['ideal'] == {'solved': 2, 'rate': 1.0, 'cost': approx(5.0)}
    assert s['vs']['always_sol']['solved'] == 1 and s['vs']['always_sol']['cost_ratio']['point'] == approx(2.5)


def test_ideal_router_on_two_sol_runs_measures_noise():
    b = _arm('B', [('t0', True, 1.1), ('t1', False, 0.9), ('t2', True, 1.0), ('t3', False, 2.1)])
    r = stats.ideal_router({'A': A4, 'B': b}, order=('A', 'B'), n_boot=50)
    # only t2 flips (A fails, B solves): one solve gained purely by run-to-run variance
    assert r['vs']['always_sol']['resolve_diff']['diff'] == approx(0.25)


def test_ideal_router_validation_and_seed():
    with pytest.raises(ValueError, match='distinct'):
        stats.ideal_router({'F': F4, 'A': A4}, order=('F', 'F'))
    with pytest.raises(ValueError, match='without rows'):
        stats.ideal_router({'A': A4}, order=('F', 'A'))
    with pytest.raises(ValueError, match='no row for'):
        stats.ideal_router({'F': F4, 'A': A4[:3]}, order=('F', 'A'), tasks=['t0', 't1', 't2', 't3'])
    with pytest.raises(ValueError, match='duplicate'):
        stats.ideal_router({'F': F4 + F4[:1], 'A': A4}, order=('F', 'A'))
    with pytest.raises(ValueError, match='unsolved'):
        stats.ideal_router({'F': F4, 'A': A4}, order=('F', 'A'), unsolved='other')
    one = stats.ideal_router({'F': F4, 'A': A4}, order=('F', 'A'), seed=3, n_boot=300)
    assert one == stats.ideal_router({'F': F4, 'A': A4}, order=('F', 'A'), seed=3, n_boot=300)


def test_docstring_limitations_parse_as_bullets():
    doc = stats.__doc__ or ''
    assert 'can and cannot show' in doc
    part = doc.split('can and cannot show', 1)[1]
    bullets = [line for line in part.splitlines() if line.startswith('- ')]
    assert len(bullets) >= 8
    assert any('ideal per-task router is an upper bound' in b for b in bullets)
    assert any(b.startswith('- B (30 tasks) and D (10 tasks)') for b in bullets)
    assert '±6 pp (1.96·√(0.2/200))' in part


# --- §12: run-to-run noise --------------------------------------------------------------------------------------------

def test_replicate_noise_known_values():
    runs = {'t0': [True, True], 't1': [True, False], 't2': [False, False], 't3': [True, False, False], 't4': [True]}
    r = stats.replicate_noise(runs, seed=1, n_boot=500)
    assert (r['tasks'], r['single_run_tasks'], r['runs_per_task']) == (4, 1, {'2': 3, '3': 1})
    assert r['mixed_tasks'] == 2 and r['task_flip_rate'] == approx(0.5)
    assert r['task_flip_ci'] == stats.wilson(2, 4)
    # pairs disagreeing per task: 0/1, 1/1, 0/1, 2/3 → equal-weight mean
    assert r['pair_disagreement'] == approx((0 + 1 + 0 + 2 / 3) / 4)
    lo, hi = r['pair_disagreement_ci']
    assert 0.0 <= lo <= r['pair_disagreement'] <= hi <= 1.0
    assert r['mean_resolve_rate'] == approx((1 + 0.5 + 0 + 1 / 3) / 4)
    assert r == stats.replicate_noise(runs, seed=1, n_boot=500)
    json.dumps(r, allow_nan=False)


def test_replicate_noise_pair_disagreement_estimates_two_p_one_minus_p():
    # every task solves with p = 0.3: two independent runs differ with probability 2·0.3·0.7 = 0.42, whatever k is
    rng = random.Random(11)
    for k in (2, 3):
        runs = {f't{i}': [rng.random() < 0.3 for _ in range(k)] for i in range(4000)}
        assert stats.replicate_noise(runs, n_boot=20)['pair_disagreement'] == approx(0.42, rel=0, abs=0.02)


def test_replicate_noise_empty_and_no_noise():
    e = stats.replicate_noise({'t0': [True]})
    assert e['tasks'] == 0 and e['pair_disagreement'] is None and e['task_flip_ci'] is None
    json.dumps(e, allow_nan=False)
    z = stats.replicate_noise({'t0': [True, True], 't1': [False, False]}, n_boot=50)
    assert z['pair_disagreement'] == 0 and z['pair_disagreement_ci'] == (0.0, 0.0) and z['task_flip_rate'] == 0


# --- DeepSWE §7: several runs per (task, arm) ------------------------------------------------------------------------

def test_paired_mean_diff_one_run_matches_mcnemar_and_paired_diff():
    a, b = paired(36, 12, 2, 0)
    runs_a = {f't{i}': [x] for i, x in enumerate(a)}
    runs_b = {f't{i}': [x] for i, x in enumerate(b)}
    r = stats.paired_mean_diff(runs_a, runs_b, seed=1, n_boot=2000)
    assert r['diff'] == approx(stats.paired_diff(a, b)['diff']) == approx(-0.2)
    assert r['p_signflip'] == approx(stats.mcnemar_exact(12, 2))  # exact: 14 non-zero differences
    assert r['discordant_tasks'] == 14 and (r['rate_a'], r['rate_b']) == (approx(0.96), approx(0.76))
    lo, hi = r['ci']
    assert lo < -0.2 < hi < 0 and r['noninferiority']['noninferior'] is False
    assert r == stats.paired_mean_diff(runs_a, runs_b, seed=1, n_boot=2000)
    json.dumps(r, allow_nan=False)


def test_paired_mean_diff_weights_tasks_equally_and_counts_runs():
    runs_a = {'t0': [True, True, True], 't1': [False], 't2': [True, False], 'only_a': [True]}
    runs_b = {'t0': [True, False, False], 't1': [True, True], 't2': [True, False], 'only_b': [False], 'empty': []}
    runs_a['empty'] = [True]
    r = stats.paired_mean_diff(runs_a, runs_b, n_boot=200)
    assert r['n'] == 3 and r['unpaired_tasks'] == 3
    assert r['diff'] == approx(((1 / 3 - 1) + (1 - 0) + 0) / 3)
    assert r['runs_a'] == {'1': 1, '2': 1, '3': 1} and r['runs_b'] == {'2': 2, '3': 1}
    assert r['ci_degenerate'] is False


def test_paired_mean_diff_degenerate_and_empty():
    same = {'t0': [True, True], 't1': [False, False]}
    z = stats.paired_mean_diff(same, same, n_boot=50)
    assert z['diff'] == 0 and z['ci'] == (0.0, 0.0) and z['ci_degenerate'] is True and z['p_signflip'] == 1.0
    e = stats.paired_mean_diff({'t0': [True]}, {'t1': [True]})
    assert e['n'] == 0 and e['diff'] is None and e['noninferiority']['noninferior'] is None
    json.dumps(e, allow_nan=False)


def test_paired_mean_diff_signflip_monte_carlo_is_seeded():
    rng = random.Random(3)
    runs_a = {f't{i}': [rng.random() < 0.6 for _ in range(2)] for i in range(80)}
    runs_b = {f't{i}': [rng.random() < 0.5 for _ in range(2)] for i in range(80)}
    p1 = stats.paired_mean_diff(runs_a, runs_b, seed=4, n_boot=500)['p_signflip']
    assert p1 == stats.paired_mean_diff(runs_a, runs_b, seed=4, n_boot=500)['p_signflip']
    assert 0 < p1 <= 1


def test_paired_mean_diff_coverage_is_near_nominal():
    # 60 tasks with heterogeneous p, 2 runs per arm, B = A − 0.1 on every task
    rng = random.Random(8)
    pa = [rng.uniform(0.2, 0.95) for _ in range(60)]
    true = -0.1
    covered, sims = 0, 300
    for _ in range(sims):
        ra = {f't{i}': [rng.random() < p for _ in range(2)] for i, p in enumerate(pa)}
        rb = {f't{i}': [rng.random() < p + true for _ in range(2)] for i, p in enumerate(pa)}
        lo, hi = stats.paired_mean_diff(ra, rb, n_boot=400, seed=rng.randrange(10**6))['ci']
        covered += lo <= true <= hi
    assert 0.90 <= covered / sims <= 0.985


def test_ideal_router_heldout_known_values():
    runs = {
        'F': {'t0': [(True, 0.1), (True, 0.1)], 't1': [(True, 0.1), (False, 0.2)], 't2': [(False, 0.1), (False, 0.1)]},
        'A': {'t0': [(True, 1.0), (True, 1.0)], 't1': [(True, 1.0), (True, 1.0)], 't2': [(False, 1.0), (True, 2.0)],
              't3': [(True, 1.0)]},
    }
    r = stats.ideal_router_heldout(runs, order=('F', 'A'), seed=1, n_boot=300)
    assert r['n'] == 3 and r['skipped_tasks'] == 1  # t3: one run only, and no F
    # t0: F both folds → solved, 0.1. t1: fold 0 picks F (run 0 solved), scored on F run 1 (fail, 0.2);
    # fold 1: F run 1 failed → A run 1 solved → pick A, scored on A run 0 (solved, 1.0) → 0.5 solved, 0.6 cost.
    # t2: fold 0 F run 0 fails, A run 0 fails → F (cheapest), scored on F run 1 (fail, 0.1);
    # fold 1: F run 1 fails, A run 1 solved → A, scored on A run 0 (fail, 1.0) → 0 solved, 0.55 cost.
    assert r['ideal']['rate'] == approx((1 + 0.5 + 0) / 3)
    assert r['ideal']['cost'] == approx(0.1 + 0.6 + 0.55)
    assert r['choice_share'] == {'F': approx((2 + 1 + 1) / 2 / 3), 'A': approx((0 + 1 + 1) / 2 / 3)}
    v = r['vs_baseline']
    assert (v['arm'], v['rate'], v['cost']) == ('A', approx((1 + 1 + 0.5) / 3), approx(1.0 + 1.0 + 1.5))
    assert v['resolve_diff']['diff'] == approx(r['ideal']['rate'] - v['rate'])
    assert v['cost_ratio']['point'] == approx(1.25 / 3.5)
    json.dumps(r, allow_nan=False)


def test_ideal_router_heldout_removes_noise_gain_on_identical_arms():
    # two copies of one arm: in-sample oracle gains from lucky runs, the held-out one does not (in expectation)
    rng = random.Random(12)
    ps = [rng.uniform(0.1, 0.9) for _ in range(3000)]
    mk = lambda: {f't{i}': [(rng.random() < p, 1.0) for _ in range(2)] for i, p in enumerate(ps)}
    r = stats.ideal_router_heldout({'X': mk(), 'A': mk()}, order=('X', 'A'), n_boot=20)
    assert r['vs_baseline']['resolve_diff']['diff'] == approx(0.0, rel=0, abs=0.02)


def test_ideal_router_heldout_validation_and_empty():
    with pytest.raises(ValueError, match='distinct'):
        stats.ideal_router_heldout({'A': {}}, order=('A', 'A'))
    with pytest.raises(ValueError, match='without runs'):
        stats.ideal_router_heldout({'A': {}}, order=('F', 'A'))
    e = stats.ideal_router_heldout({'F': {'t0': [(True, 1.0)]}, 'A': {'t0': [(True, 1.0)]}}, order=('F', 'A'))
    assert e['n'] == 0 and e['vs_baseline'] is None
    json.dumps(e, allow_nan=False)
