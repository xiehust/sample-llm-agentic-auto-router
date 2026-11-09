"""Claude Code × Harbor, A (pinned Sonnet 5.5) vs C (pinned Opus 5.5), rep 1: the report statistics (0d,
design-stats §15 with Amendments 7–9, §16–§18).

    python3 -I report_stats.py --results experiments/claude-code-harbor/results \
        --codex-deepswe experiments/deepswe-harbor/results/merged/rows.jsonl \
        --codex-tb experiments/tbench-harbor/results/merged/rows.jsonl \
        [--public /path/to/deepswe/v1.1/trials.json] > report-stats.json

Estimators are experiments/codex-deepswe/stats.py's (paired_mean_diff, mcnemar_exact, cost_ratio, usd_per_solved,
usd_per_solved_ratio) with its seed and n_boot. Output: JSON on stdout, aggregates and task ids only (no task text).
The public trials file is third-party data and is never committed; without --public §15.4 is skipped.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import pathlib
import random
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'codex-deepswe'))
import stats  # noqa: E402

EPISODE_SHA = '45d1bd8e5b526f15d0702ccfb056f42e54b44789d6aa88d19c2876b9adb146a1'   # §17
SCANNER = 'f462bb9a58e0e9c2'                                                        # §15.7
CLASSIFIER = '3a18f4db7da1f236046db6e557a099b62f668c016f7baf0468276802ec973078'     # §18 reclass


def jl(p: pathlib.Path) -> list[dict[str, Any]]:
    return [json.loads(l) for l in open(p) if l.strip()]


def load(results: pathlib.Path, ds: str) -> dict[str, Any]:
    m = results / ds / 'merged'
    finals = [r for r in jl(m / 'final.jsonl') if r['pass'] == 'main']
    att = {a['trial_id']: a for a in jl(m / 'attempts.jsonl')}
    allatt = [a for a in att.values() if a['pass'] == 'main']
    calls = [c for c in jl(m / 'calls.jsonl') if c['trial_id'] in {a['trial_id'] for a in allatt}]
    summary = json.load(open(m / 'summary.json'))
    checks = json.load(open(m / 'checks.json'))
    return {'finals': finals, 'att': att, 'allatt': allatt, 'calls': calls, 'summary': summary, 'checks': checks}


def runs(d: dict[str, Any], ds: str, basis: str, override: dict[tuple[str, str], bool] | None = None
         ) -> dict[str, dict[str, tuple[bool, float]]]:
    """arm → task → (resolved, cost) for the scored main finals. TB primary basis: resolved and not lookup-flagged."""
    out: dict[str, dict[str, tuple[bool, float]]] = {'A': {}, 'C': {}}
    for f in d['finals']:
        if f['status'] != 'scored':
            continue
        a = d['att'][f['trial_id']]
        ok = f['score'] == 1.0
        if basis == 'scanner' and ds == 'tb21' and (a.get('lookup') or {}).get('flag'):
            ok = False
        if override and (f['task'], f['arm']) in override:
            ok = override[(f['task'], f['arm'])]
        out[f['arm']][f['task']] = (ok, float(a['spent_usd'] or 0.0))
    return out


def ci(x: Any) -> list[float] | None:
    return [x[0], x[1]] if x else None


def compare(r: dict[str, dict[str, tuple[bool, float]]], drop: set[str] = frozenset()) -> dict[str, Any]:
    T = sorted(t for t in r['A'].keys() & r['C'].keys() if t not in drop)
    a = [r['A'][t][0] for t in T]; c = [r['C'][t][0] for t in T]
    ca = [r['A'][t][1] for t in T]; cc = [r['C'][t][1] for t in T]
    pmd = stats.paired_mean_diff({t: [r['A'][t][0]] for t in T}, {t: [r['C'][t][0]] for t in T})
    both = sum(x and y for x, y in zip(a, c)); conly = sum(y and not x for x, y in zip(a, c))
    aonly = sum(x and not y for x, y in zip(a, c)); neither = len(T) - both - conly - aonly
    cr = stats.cost_ratio(ca, cc)
    out = {
        'n_pairs': len(T), 'rate_A': pmd['rate_a'], 'rate_C': pmd['rate_b'],
        'C_minus_A': pmd['diff'], 'C_minus_A_ci': ci(pmd['ci']), 'p_signflip': pmd['p_signflip'],
        'mcnemar': {'C_only': conly, 'A_only': aonly, 'p_exact': stats.mcnemar_exact(conly, aonly)},
        'counts': {'both': both, 'C_only': conly, 'A_only': aonly, 'neither': neither,
                   'C_only_minus_A_only_share': (conly - aonly) / len(T) if T else None,
                   'rescue_rate_C_on_A_misses': conly / (conly + neither) if conly + neither else None},
        'cost': {'sum_A': cr['sum_a'], 'sum_C': cr['sum_b'], 'per_run_A': cr['sum_a'] / len(T), 'per_run_C': cr['sum_b'] / len(T),
                 'ratio_C_over_A': cr['ratio_of_sums']['point'], 'ratio_ci': ci(cr['ratio_of_sums']['ci']),
                 'share_top5_A': cr['share_top5_a']},
    }
    ps = stats.usd_per_solved_ratio(ca, a, cc, c)
    pa = stats.usd_per_solved(ca, a); pc = stats.usd_per_solved(cc, c)
    out['per_solve'] = {'A': pa['point'], 'A_ci': ci(pa['ci']), 'C': pc['point'], 'C_ci': ci(pc['ci']),
                        'ratio_C_over_A': ps['point'], 'ratio_ci': ci(ps['ci'])}
    out['verdict'] = verdict(out)
    return out


def verdict(o: dict[str, Any]) -> dict[str, Any]:
    """§15.3, per dataset."""
    lo, hi = o['C_minus_A_ci']; clo, chi = o['cost']['ratio_ci']
    res = 'CONFIRMED' if lo > 0 else 'NOT CONFIRMED' if hi < 0.05 else 'INCONCLUSIVE'
    cost = 'CONFIRMED' if chi <= 1.10 else 'NOT CONFIRMED' if clo > 1.10 else 'INCONCLUSIVE'
    pattern = ('same pattern' if res == cost == 'CONFIRMED' else
               'different pattern' if 'NOT CONFIRMED' in (res, cost) else 'inconclusive')
    return {'resolve': res, 'cost_per_run': cost, 'pattern': pattern, 'gap_at_least_10pp': lo > 0.10}


def oom_tasks(d: dict[str, Any]) -> list[str]:
    """§9: tasks with an agent-container OOM in any main attempt of either arm."""
    out = set()
    for a in d['allatt']:
        mem = a.get('mem') or {}
        if (mem.get('oom_kill') or 0) > 0 or a.get('exception_type') in ('SandboxLikelyOutOfMemoryError', 'MemoryLimitExceededError'):
            out.add(a['task'])
    return sorted(out)


def s6(d: dict[str, Any], ds: str) -> dict[str, Any]:
    fin = {f['trial_id'] for f in d['finals'] if f['status'] == 'scored'}
    per: dict[str, Any] = {}
    for arm in 'AC':
        fa = [d['att'][t] for t in fin if d['att'][t]['arm'] == arm]
        aa = [a for a in d['allatt'] if a['arm'] == arm]
        ca = [c for c in d['calls'] if c['arm'] == arm]
        fca = [c for c in ca if c['trial_id'] in fin]
        model_calls = [c for c in fca if c.get('leaf') != 'count_tokens' and c.get('call_type') != 'count_tokens'
                       and c['status'] not in (403, 404)]
        role_n = collections.Counter(c.get('call_role_struct') for c in model_calls)
        role_cost = collections.defaultdict(float)
        for c in model_calls:
            role_cost[c.get('call_role_struct')] += float(c.get('cost_usd') or 0)
        tot = sum(role_cost.values()) or 1.0
        swap = [a for a in fa if (a.get('mem') or {}).get('swap_peak_mb')]
        per[arm] = {
            'scored_finals': len(fa),
            'attempts_all': len(aa),
            'superseded_or_rerun_attempts': len(aa) - len(fa),
            'superseded_cost_usd': round(sum(float(a['spent_usd'] or 0) for a in aa if a['trial_id'] not in fin), 4),
            'agent_timeouts_final': sum(a.get('exception_type') == 'AgentTimeoutError' for a in fa),
            'agent_oom_final': sum(((a.get('mem') or {}).get('oom_kill') or 0) > 0 for a in fa),
            'container_at_limit_final': sorted(a['task'] for a in fa if (a.get('mem') or {}).get('container_mem_peak_mb', 0) >= (a.get('mem') or {}).get('mem_limit_mb', 1e18)),
            'finals_with_swap_peak': len(swap),
            'refusal_calls_final': sum(c.get('stop_reason') == 'refusal' for c in fca),
            'refusal_calls_all_attempts': sum(c.get('stop_reason') == 'refusal' for c in ca),
            'trials_with_refusal_call_final': len({c['trial_id'] for c in fca if c.get('stop_reason') == 'refusal'}),
            'deviation_requests_all_attempts': collections.Counter(c.get('requested_model') for c in ca if c['status'] == 403),
            'count_tokens': {'calls': sum(c['status'] == 404 for c in fca),
                             'got_404': sum(c['status'] == 404 for c in fca),
                             'share_trials_ge1': len({c['trial_id'] for c in fca if c['status'] == 404}) / len(fa) if fa else None},
            'sanitized_requests_final': sum(int(a.get('sanitized_requests') or 0) for a in fa),
            'structural_types': {str(k): {'calls': n, 'call_share': n / len(model_calls), 'cost_share': role_cost[k] / tot}
                                 for k, n in role_n.items()},
            'calls_per_run_mean': len(model_calls) / len(fa) if fa else None,
            'served_models_final': dict(collections.Counter(c.get('served_model') for c in model_calls)),
        }
    if ds == 'tb21':
        per['lookup_scanner'] = {
            'versions': dict(collections.Counter((a.get('lookup') or {}).get('scanner') for a in d['allatt'])),
            'flagged_final': {arm: sorted(d['att'][t]['task'] for t in fin if d['att'][t]['arm'] == arm and (d['att'][t].get('lookup') or {}).get('flag')) for arm in 'AC'},
            'base_flagged_final': {arm: sorted(d['att'][t]['task'] for t in fin if d['att'][t]['arm'] == arm and ((d['att'][t].get('lookup') or {}).get('base') or {}).get('flag')) for arm in 'AC'},
        }
    per['excluded'] = [f['key'] for f in d['finals'] if f['status'] != 'scored']
    per['classes_final'] = dict(collections.Counter(f"{f['arm']}/{f['class']}" for f in d['finals']))
    oom = {arm: sum(((d['att'][t].get('mem') or {}).get('oom_kill') or 0) > 0 for t in fin if d['att'][t]['arm'] == arm) for arm in 'AC'}
    n = {arm: sum(d['att'][t]['arm'] == arm for t in fin) for arm in 'AC'}
    per['agent_oom_wilson'] = {arm: {'k': oom[arm], 'n': n[arm], 'ci': ci(stats.wilson(oom[arm], n[arm]))} for arm in 'AC'}
    return per


def codex_rep1(path: pathlib.Path) -> dict[str, Any]:
    """§6: Codex Astra − Sol (C − A) on rep 1, and on all reps, as graded (scanner v2 flags 0 of the Codex TB runs, §15.7)."""
    rows = [r for r in jl(path) if r['phase'] != 'pilot' and r['final_status'] == 'scored' and r.get('in_comparisons') and r['arm'] in 'AC']
    out = {}
    for label, keep in (('rep1', lambda r: int(r['rep']) == 1), ('all_reps', lambda r: True)):
        by: dict[str, dict[str, list[bool]]] = {'A': collections.defaultdict(list), 'C': collections.defaultdict(list)}
        for r in rows:
            if keep(r):
                by[r['arm']][r['task_id']].append(bool(r['resolved']))
        p = stats.paired_mean_diff(by['A'], by['C'])
        out[label] = {'n': p['n'], 'rate_A': p['rate_a'], 'rate_C': p['rate_b'], 'C_minus_A': p['diff'], 'ci': ci(p['ci'])}
    return out


def public(path: pathlib.Path, cc: dict[str, dict[str, tuple[bool, float]]]) -> dict[str, Any]:
    """§15.4: the public mini-swe-agent Claude 5 C − A, attempt 1 (earliest-started scored attempt, as analyze.py
    --extra) and all attempts, plus per-task agreement with our rep 1."""
    ours_tasks = set(cc['A']) | set(cc['C'])   # our 112 DeepSWE tasks (the public file has more)
    rows = [r for r in json.load(open(path))['rows'] if r['task_name'] in ours_tasks]
    cfg = {'A': 'claude_sonnet_5_high', 'C': 'claude_opus_5_high'}
    first: dict[str, dict[str, Any]] = {'A': {}, 'C': {}}
    allr: dict[str, dict[str, list[bool]]] = {'A': collections.defaultdict(list), 'C': collections.defaultdict(list)}
    for r in rows:
        if not r['included_in_score']:
            continue
        c = r['config'].replace('mini_swe_agent_', '')
        for arm, name in cfg.items():
            if c == name:
                allr[arm][r['task_name']].append(bool(r['passed']))
                cur = first[arm].get(r['task_name'])
                if cur is None or r['started_at'] < cur['started_at']:
                    first[arm][r['task_name']] = r
    a1 = {t: [bool(first['A'][t]['passed'])] for t in first['A']}
    c1 = {t: [bool(first['C'][t]['passed'])] for t in first['C']}
    out = {}
    for label, A, C in (('attempt1', a1, c1), ('all_attempts', allr['A'], allr['C'])):
        p = stats.paired_mean_diff(A, C)
        out[label] = {'n': p['n'], 'rate_A': p['rate_a'], 'rate_C': p['rate_b'], 'C_minus_A': p['diff'], 'ci': ci(p['ci'])}
    # per-task agreement: sign of C − A, ours (rep 1) vs public (all attempts, per-task mean; and attempt 1)
    T = sorted(cc['A'].keys() & cc['C'].keys() & allr['A'].keys() & allr['C'].keys())
    ours = [int(cc['C'][t][0]) - int(cc['A'][t][0]) for t in T]
    sgn = lambda x: (x > 0) - (x < 0)
    for label, A, C in (('vs_public_all_attempts', allr['A'], allr['C']), ('vs_public_attempt1', a1, c1)):
        pub = [sum(C[t]) / len(C[t]) - sum(A[t]) / len(A[t]) for t in T]
        same = sum(sgn(x) == sgn(y) for x, y in zip(ours, pub))
        out[label] = {'n': len(T), 'same_sign_share': same / len(T), 'pearson_r': pearson(ours, pub)}
    return out


def pearson(x: list[float], y: list[float]) -> float | None:
    n = len(x)
    if n < 2:
        return None
    mx = sum(x) / n; my = sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y)); sx = math.sqrt(sum((a - mx) ** 2 for a in x)); sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sxy / (sx * sy) if sx and sy else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--results', required=True, type=pathlib.Path)
    ap.add_argument('--codex-deepswe', required=True, type=pathlib.Path)
    ap.add_argument('--codex-tb', required=True, type=pathlib.Path)
    ap.add_argument('--public', type=pathlib.Path)
    a = ap.parse_args()
    out: dict[str, Any] = {'seed': stats.SEED, 'n_boot': stats.N_BOOT, 'design': 'design-stats §15–§18', 'datasets': {}}

    # ---- DeepSWE
    d = load(a.results, 'deepswe')
    r = runs(d, 'deepswe', 'graded')
    ep_path = a.results / 'deepswe' / 'memory-episode-tasks.json'
    ep_sha = hashlib.sha256(ep_path.read_bytes()).hexdigest()
    if ep_sha != EPISODE_SHA:
        sys.exit(f'memory-episode-tasks.json sha256 {ep_sha} != §17 {EPISODE_SHA}')
    ep = json.load(open(ep_path))
    ep_tasks = set(ep['tasks'] if isinstance(ep.get('tasks'), list) else ep['tasks'].keys())
    oom = oom_tasks(d)
    ds_out = {'primary': compare(r),
              'sensitivities': {
                  's17_memory_episode_drop': {'tasks': sorted(ep_tasks), **compare(r, ep_tasks)},
                  's9_agent_oom_task_drop': {'tasks': oom, **(compare(r, set(oom)) if oom else {'not_triggered': True})},
                  's10_agent_oom_as_unresolved': {'not_triggered': True} if not oom else 'see s9',
                  's13_deviation_task_drop': {'not_triggered': True, 'deviations': 0},
                  's7_excluded_gt3': {'not_triggered': True},
              },
              's6': s6(d, 'deepswe'),
              'cross_agent_codex': codex_rep1(a.codex_deepswe)}
    if a.public:
        ds_out['public_claude5'] = public(a.public, r)
    out['datasets']['deepswe'] = ds_out

    # ---- TB
    d = load(a.results, 'tb21')
    rp = runs(d, 'tb21', 'scanner'); rg = runs(d, 'tb21', 'graded')
    rf = d['summary']['refusal_fallback']
    refusal_pairs = sorted({(f['task'], f['arm']) for f in d['finals'] if f['class'] == 'sut'})
    refusal_tasks = {t for t, _ in refusal_pairs}
    # §18(b): attempt 1 scored by its verifier (reward), the verifier ran on 9/9
    ver = {}
    for t, arm in refusal_pairs:
        f = next(f for f in d['finals'] if f['task'] == t and f['arm'] == arm)
        at = d['att'][f['trial_id']]
        ran = (at.get('verifier') or {}).get('tests_ran')
        ver[(t, arm)] = bool(ran) and at.get('reward') == 1.0
    oom = oom_tasks(d)
    flaky = d['checks'].get('flaky_env') or []
    prim = compare(rp)
    sens = {
        'as_graded_basis': compare(rg),
        's18a_refusal_task_drop': {'tasks': sorted(refusal_tasks), **compare(rp, refusal_tasks)},
        's18b_refusal_verifier_scored': {'pairs_solved_by_verifier': sum(ver.values()), **compare(runs(d, 'tb21', 'scanner', ver))},
        's9_agent_oom_task_drop': {'tasks': oom, **(compare(rp, set(oom)) if oom else {'not_triggered': True})},
        'flaky_env_drop': {'tasks': flaky, **(compare(rp, set(flaky)) if flaky else {'not_triggered': True})},
        's5_2_post_run_oracle': 'not run (0c omission; the runners were destroyed before it)',
    }
    qual = sorted(k for k in ('as_graded_basis', 's18a_refusal_task_drop', 's18b_refusal_verifier_scored')
                  if sens[k]['verdict']['pattern'] != prim['verdict']['pattern'] or sens[k]['verdict']['resolve'] != prim['verdict']['resolve']
                  or sens[k]['verdict']['cost_per_run'] != prim['verdict']['cost_per_run'])
    out['datasets']['tb21'] = {
        'primary': prim, 'verdict_qualified_by': qual, 'sensitivities': sens,
        'refusal_fallback': {'pairs': [f'{t}/{arm}' for t, arm in refusal_pairs], 'summary': rf, 'classifier': CLASSIFIER},
        's6': s6(d, 'tb21'), 'cross_agent_codex': codex_rep1(a.codex_tb)}
    json.dump(out, sys.stdout, indent=1, sort_keys=True, default=lambda o: dict(o) if isinstance(o, collections.Counter) else str(o))
    print()


if __name__ == '__main__':
    main()
