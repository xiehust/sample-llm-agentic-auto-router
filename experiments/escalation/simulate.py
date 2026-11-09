"""Retrospective escalation simulation (design §3, method §7.2, gate §7.3). Stdlib only; run with -I.

  python3 -I experiments/escalation/simulate.py freeze      # outcome-free: resolve thresholds, write FROZEN.json
  python3 -I experiments/escalation/simulate.py run         # verify FROZEN.json, join outcomes, write results/sim-*.json

`freeze` reads only the text-free signal extracts (signals.py) and the v2.2 split; it never opens rows.jsonl.
`run` refuses to start unless signals.py, simulate.py, rules.json and both extracts still have the frozen hashes.
Every number is a task-level mean (equal task weight); CIs are task bootstraps and cover task sampling only, not the
scenario (an escalated session is neither a fresh target run nor the source run continued).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
import statistics
import sys
from collections import defaultdict
from collections.abc import Callable
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
RESULTS = HERE / 'results'
FROZEN = HERE / 'FROZEN.json'
SPLIT = ROOT / 'assessor-v22' / 'heldout' / 'split.jsonl'
SPLIT_SHA = 'daac972f3906fe2308c71922e9ad2e7e2ff1d27ccbe7f4b75d4d75922948aa2a'
BENCHES = {'deepswe': ('deepswe', ROOT / 'deepswe-harbor'), 'tbench': ('tb21', ROOT / 'tbench-harbor')}
# $/M tokens, packages/pricing catalog (global endpoint scope, below the 272k long-context step; Codex compacts at 200k).
PRICES = {'A': {'input': 2.0, 'read': 0.1, 'write': 2.5, 'output': 10.0},       # global.openai.gpt-6.1-sol
          'C': {'input': 10.0, 'read': 1.0, 'write': 12.5, 'output': 50.0},     # global.openai.gpt-6-astra
          'F': {'input': 0.1, 'read': 0.01, 'write': 0.125, 'output': 0.5}}     # global.openai.gpt-6-luna
ROUTER_SIGNALS = ('k', 'prompt_tokens', 'spend_usd', 'compactions')
SHRINK = 0.6
LATE = 0.15
SCEN = ('M0', 'M1', 'M2', 'M2_self')
COSTS = ('high', 'splice', 'tail')
AUC_KS = (5, 10, 20, 40)
AUC_SIGNALS = ('prompt_tokens', 'spend_usd', 'compactions', 'tool_calls', 'exec_nonzero', 'consec_nonzero', 'test_runs',
               'test_fail', 'consec_test_fail', 'repeat_cmd', 'no_progress')


def sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load_extract(bench: str) -> list[dict[str, Any]]:
    p = RESULTS / f'signals-{bench}.jsonl'
    return [json.loads(x) for x in p.read_text(encoding='utf-8').splitlines() if x.strip()]


def load_split(bench: str) -> dict[str, str]:
    if sha(SPLIT) != SPLIT_SHA:
        sys.exit('split.jsonl differs from the recorded hash')
    ds = BENCHES[bench][0]
    out = {}
    for x in SPLIT.read_text(encoding='utf-8').splitlines():
        j = json.loads(x)
        if j['dataset'] == ds:
            out[j['task_id']] = j['split']
    return out


# ---------------------------------------------------------------- per-request state


def router_state(run: dict[str, Any], k: int) -> dict[str, float]:
    """What the router knows before request k (1-based), from the proxy call log."""
    prompts = run['call_prompt']
    comp, peak = 0, 0
    for p in prompts[:k - 1]:
        if peak and p < SHRINK * peak:
            comp += 1
            peak = p
        else:
            peak = max(peak, p)
    return {'k': k, 'prompt_tokens': prompts[k - 2] if k >= 2 else 0, 'spend_usd': sum(run['call_cost'][:k - 1]), 'compactions': comp}


def body_state(run: dict[str, Any], k: int) -> dict[str, Any] | None:
    s = run['series']
    if not run['has_rollout'] or not s:
        return None
    return s[min(k, len(s)) - 1]


def cond_value(run: dict[str, Any], k: int, signal: str, rs: dict[str, float] | None = None) -> float | None:
    if signal in ROUTER_SIGNALS:
        return (rs or router_state(run, k))[signal]
    b = body_state(run, k)
    return None if b is None else b.get(signal)


def threshold(c: dict[str, Any], frozen_bench: dict[str, Any], esc: str) -> float:
    if 'ge' in c:
        return float(c['ge'])
    if 'ge_kq' in c:
        return float(frozen_bench['kq'][esc][str(c['ge_kq'])])
    return float(frozen_bench['constants'][c['ge_const']])


def fire_k(run: dict[str, Any], rule: dict[str, Any], frozen_bench: dict[str, Any], esc: str) -> int | None:
    conds = [(c['signal'], threshold(c, frozen_bench, esc)) for c in rule['any']]
    for k in range(1, len(run['call_cost']) + 1):
        rs = router_state(run, k)
        for sig, thr in conds:
            v = cond_value(run, k, sig, rs)
            if v is not None and v >= thr:
                return k
    return None


# ---------------------------------------------------------------- freeze (outcome-free)


def quantile_ceil(xs: list[float], q: float) -> int:
    xs = sorted(xs)
    i = q * (len(xs) - 1)
    lo, hi = math.floor(i), math.ceil(i)
    return math.ceil(xs[lo] + (xs[hi] - xs[lo]) * (i - lo))


def freeze() -> None:
    rules = json.loads((HERE / 'rules.json').read_text(encoding='utf-8'))
    out: dict[str, Any] = {'schema': 'escalation-frozen/v1', 'rules_sha256': sha(HERE / 'rules.json'),
                           'signals_py_sha256': sha(HERE / 'signals.py'), 'simulate_py_sha256': sha(HERE / 'simulate.py'),
                           'split_sha256': SPLIT_SHA, 'benches': {}}
    for bench in BENCHES:
        runs, split = load_extract(bench), load_split(bench)
        fb: dict[str, Any] = {'extract_sha256': sha(RESULTS / f'signals-{bench}.jsonl'), 'kq': {}, 'constants': {}}
        for esc, e in rules['escalations'].items():
            src = [r for r in runs if r['arm'] == e['source'] and split.get(r['task_id']) == 'tune']
            qs = sorted({c['ge_kq'] for rl in e['rules'].values() for c in rl['any'] if 'ge_kq' in c})
            fb['kq'][esc] = {str(q): quantile_ceil([len(r['call_cost']) for r in src], q) for q in qs}
            if any('ge_const' in c for rl in e['rules'].values() for c in rl['any']):
                fb['constants']['R8_spend'] = round(2 * statistics.median(float(r['ledger_usd'] or 0) for r in src), 6)
        out['benches'][bench] = fb
    FROZEN.write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(out, indent=2))
    print('FROZEN.json sha256', sha(FROZEN), file=sys.stderr)


def check_frozen() -> dict[str, Any]:
    f = json.loads(FROZEN.read_text(encoding='utf-8'))
    want = {'rules_sha256': HERE / 'rules.json', 'signals_py_sha256': HERE / 'signals.py', 'simulate_py_sha256': HERE / 'simulate.py'}
    bad = [k for k, p in want.items() if sha(p) != f[k]]
    bad += [f'{b}.extract' for b in BENCHES if sha(RESULTS / f'signals-{b}.jsonl') != f['benches'][b]['extract_sha256']]
    if bad:
        sys.exit(f'frozen inputs changed: {bad}')
    return f


# ---------------------------------------------------------------- outcomes (run only)


def outcomes(bench: str) -> dict[str, dict[str, bool]]:
    base = BENCHES[bench][1] / 'results' / 'merged' / 'rows.jsonl'
    out = {}
    for x in base.read_text(encoding='utf-8').splitlines():
        r = json.loads(x)
        g = bool(r.get('resolved'))
        out[r['run_id']] = {'graded': g, 'primary': g and not bool((r.get('lookup') or {}).get('flag'))}
    return out


def reprice(usage: list[int], arm: str) -> float:
    p = PRICES[arm]
    unc, read, write, outp = usage
    return (unc * p['input'] + read * p['read'] + write * p['write'] + outp * p['output']) / 1e6


def simulate_rule(src_runs: list[dict[str, Any]], tgt_by_task: dict[str, list[dict[str, Any]]], fire: Callable[[dict[str, Any]], int | None],
                  y_of: Callable[[dict[str, Any]], bool], tgt_arm: str) -> dict[str, list[dict[str, Any]]]:
    """Per task: one record per source run with the outcome under each scenario and the cost under each model."""
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in src_runs:
        by_task[r['task_id']].append(r)
    out: dict[str, list[dict[str, Any]]] = {}
    for t, runs in by_task.items():
        tg = tgt_by_task.get(t, [])
        if not tg:
            continue
        p_t = sum(y_of(x) for x in tg) / len(tg)
        c_t = sum(float(x['ledger_usd'] or 0) for x in tg) / len(tg)
        ys = [float(y_of(r)) for r in runs]
        recs = []
        for i, r in enumerate(runs):
            y = ys[i]
            others = ys[:i] + ys[i + 1:]
            p_self = sum(others) / len(others) if others else y
            c = float(r['ledger_usd'] or 0)
            k = fire(r)
            rec = {'y': y, 'c': c, 'k': k, 'n': len(r['call_cost']), 'p_t': p_t, 'p_self': p_self, 'late': False}
            if k is None:
                rec.update({s: y for s in SCEN}, **{m: c for m in COSTS})
            else:
                tot = sum(r['call_cost']) or 1.0
                pi = sum(r['call_cost'][:k - 1]) * (c / tot if c else 1.0)
                u = r['call_prompt'][k - 1] * PRICES[tgt_arm]['write'] / 1e6
                left = (r['agent_timeout_s'] or math.inf) - r['call_t'][k - 1]
                late = r['agent_timeout_s'] is not None and left < LATE * r['agent_timeout_s']
                rec['late'] = late
                rec['M0'] = y
                rec['M1'] = y if late else p_t
                rec['M2'] = y if late else y + (1 - y) * p_t
                rec['M2_self'] = y if late else y + (1 - y) * p_self
                rec['high'] = pi + u + c_t
                rec['splice'] = pi + u + r['call_usage'][k - 1][3] * PRICES[tgt_arm]['output'] / 1e6 + sum(reprice(x, tgt_arm) for x in r['call_usage'][k:])
                rec['tail'] = pi + u + sum(sum(x['call_cost'][k:]) for x in tg) / len(tg)
            recs.append(rec)
        out[t] = recs
    return out


def task_rows(sim: dict[str, list[dict[str, Any]]], ref: dict[str, dict[str, float]], src_is_sol: bool) -> list[dict[str, float]]:
    """Per task means: scenario outcomes, costs, and the pinned-Sol and pinned-target references."""
    rows = []
    for t, recs in sorted(sim.items()):
        if t not in ref:
            continue
        n = len(recs)
        m = {s: sum(r[s] for r in recs) / n for s in SCEN}
        m.update({c: sum(r[c] for r in recs) / n for c in COSTS})
        m['y'] = sum(r['y'] for r in recs) / n
        m['sol_p'] = m['y'] if src_is_sol else ref[t]['sol_p']
        m['sol_c'] = sum(r['c'] for r in recs) / n if src_is_sol else ref[t]['sol_c']
        m['tgt_p'] = recs[0]['p_t']
        m['tgt_c'] = ref[t]['tgt_c']
        rows.append(m)
    return rows


def estimands(rows: list[dict[str, float]]) -> dict[str, float | None]:
    n = len(rows)
    if n == 0:
        return {}
    out: dict[str, float | None] = {}
    sol_p = sum(r['sol_p'] for r in rows) / n
    tgt_p = sum(r['tgt_p'] for r in rows) / n
    sol_c = sum(r['sol_c'] for r in rows)
    tgt_c = sum(r['tgt_c'] for r in rows)
    for s in SCEN:
        v = sum(r[s] for r in rows) / n
        out[f'{s}_vs_sol_pp'] = 100 * (v - sol_p)
        out[f'{s}_vs_target_pp'] = 100 * (v - tgt_p)
    out['spec_pp'] = (out['M2_vs_sol_pp'] or 0) - (out['M2_self_vs_sol_pp'] or 0)
    for c in COSTS:
        tot = sum(r[c] for r in rows)
        out[f'cost_{c}_vs_sol'] = tot / sol_c if sol_c else None
        out[f'cost_{c}_vs_target'] = tot / tgt_c if tgt_c else None
    return out


_IDX: dict[tuple[int, int, int], list[list[int]]] = {}


def boot(rows: list[dict[str, float]], keys: list[str], seed: int, n_boot: int) -> dict[str, list[float] | None]:
    """Task bootstrap (percentile 95%). The same resampled task sets serve every rule (common random numbers)."""
    n = len(rows)
    if n == 0:
        return {}
    idx = _IDX.get((n, seed, n_boot))
    if idx is None:
        rng = random.Random(seed)
        idx = _IDX[(n, seed, n_boot)] = [[rng.randrange(n) for _ in range(n)] for _ in range(n_boot)]
    cols = {c: [r[c] for r in rows] for c in (*SCEN, *COSTS, 'sol_p', 'tgt_p', 'sol_c', 'tgt_c')}
    reps: dict[str, list[float]] = {k: [] for k in keys}
    for ix in idx:
        s = {c: sum(v[i] for i in ix) for c, v in cols.items()}
        e: dict[str, float | None] = {}
        for sc in SCEN:
            e[f'{sc}_vs_sol_pp'] = 100 * (s[sc] - s['sol_p']) / n
            e[f'{sc}_vs_target_pp'] = 100 * (s[sc] - s['tgt_p']) / n
        e['spec_pp'] = e['M2_vs_sol_pp'] - e['M2_self_vs_sol_pp']  # type: ignore[operator]
        for c in COSTS:
            e[f'cost_{c}_vs_sol'] = s[c] / s['sol_c'] if s['sol_c'] else None
            e[f'cost_{c}_vs_target'] = s[c] / s['tgt_c'] if s['tgt_c'] else None
        for k in keys:
            if e.get(k) is not None:
                reps[k].append(e[k])  # type: ignore[arg-type]
    out: dict[str, list[float] | None] = {}
    for k, v in reps.items():
        v.sort()
        out[k] = [v[int(0.025 * (len(v) - 1))], v[math.ceil(0.975 * (len(v) - 1))]] if v else None
    return out


def describe(sim: dict[str, list[dict[str, Any]]], tasks: set[str]) -> dict[str, Any]:
    recs = [r for t, rr in sim.items() if t in tasks for r in rr]
    fired = [r for r in recs if r['k'] is not None]
    ok = [r for r in recs if r['y'] == 1]
    bad = [r for r in recs if r['y'] == 0]
    w = sum(r['p_t'] for r in bad)
    ws = sum(max(0.0, r['p_t'] - r['p_self']) for r in bad)
    return {'runs': len(recs), 'fired': len(fired), 'fire_rate': len(fired) / len(recs) if recs else None,
            'fire_rate_on_resolved': sum(r['k'] is not None for r in ok) / len(ok) if ok else None,
            'fire_rate_on_failed': sum(r['k'] is not None for r in bad) / len(bad) if bad else None,
            'late_fires': sum(r['late'] for r in fired),
            'rescue_weighted_recall': sum(r['p_t'] for r in bad if r['k'] is not None) / w if w else None,
            'target_specific_recall': sum(max(0.0, r['p_t'] - r['p_self']) for r in bad if r['k'] is not None) / ws if ws else None,
            'fire_k_median': statistics.median(r['k'] for r in fired) if fired else None,
            'fire_frac_median': statistics.median(r['k'] / r['n'] for r in fired) if fired else None}


def auc(pos: list[tuple[float, float]], neg: list[tuple[float, float]]) -> float | None:
    """Weighted AUC: P(score_pos > score_neg) + ½·P(tie); items are (score, weight). One sort, O(n log n)."""
    wp, wn = sum(w for _, w in pos), sum(w for _, w in neg)
    if not wp or not wn:
        return None
    items = sorted([(v, 1, w) for v, w in pos] + [(v, 0, w) for v, w in neg])
    tot, below, i = 0.0, 0.0, 0
    while i < len(items):
        j, tie_neg, tie_pos = i, 0.0, 0.0
        while j < len(items) and items[j][0] == items[i][0]:
            if items[j][1]:
                tie_pos += items[j][2]
            else:
                tie_neg += items[j][2]
            j += 1
        tot += tie_pos * (below + 0.5 * tie_neg)
        below += tie_neg
        i = j
    return tot / (wp * wn)


def auc_table(src: list[dict[str, Any]], y_of: Callable[[dict[str, Any]], bool], p_t: dict[str, float], seed: int, n_boot: int) -> dict[str, Any]:
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in src:
        by_task[r['task_id']].append(r)
    tasks = sorted(by_task)
    out: dict[str, Any] = {}
    for k in AUC_KS:
        alive = [r for r in src if len(r['call_cost']) >= k]
        out[str(k)] = {'alive_share': len(alive) / len(src) if src else None}
        vals = {id(r): {s: cond_value(r, k, s) for s in AUC_SIGNALS} for r in alive}
        for s in AUC_SIGNALS:
            def stat(task_list: list[str], weighted: bool, k: int = k, s: str = s, vals: dict[int, Any] = vals) -> float | None:
                pos, neg = [], []
                for t in task_list:
                    for r in by_task[t]:
                        if len(r['call_cost']) < k:
                            continue
                        v = vals[id(r)][s]
                        if v is None:
                            continue
                        if y_of(r):
                            neg.append((v, 1.0))
                        else:
                            pos.append((v, p_t.get(t, 0.0) if weighted else 1.0))
                return auc(pos, neg)
            pt, pw = stat(tasks, False), stat(tasks, True)
            rng = random.Random(seed)
            reps = []
            for _ in range(n_boot):
                v = stat([tasks[rng.randrange(len(tasks))] for _ in tasks], False)
                if v is not None:
                    reps.append(v)
            reps.sort()
            ci = [reps[int(0.025 * (len(reps) - 1))], reps[math.ceil(0.975 * (len(reps) - 1))]] if reps else None
            out[str(k)][s] = {'auc_failed_vs_resolved': pt, 'ci': ci, 'auc_rescue_weighted': pw}
    return out


def run() -> None:
    frozen = check_frozen()
    rules = json.loads((HERE / 'rules.json').read_text(encoding='utf-8'))
    bs = rules['bootstrap']
    for bench in BENCHES:
        fb = frozen['benches'][bench]
        runs, split, oc = load_extract(bench), load_split(bench), outcomes(bench)
        result: dict[str, Any] = {'bench': bench, 'frozen_sha256': sha(FROZEN), 'bases': {}}
        bases = {'primary': 'primary', 'graded': 'graded'} if bench == 'tbench' else {'primary': 'graded'}
        for basis, key in bases.items():
            def y_of(r: dict[str, Any], key: str = key, oc: dict[str, dict[str, bool]] = oc) -> bool:
                return oc[r['run_id']][key]
            by_arm: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
            for r in runs:
                by_arm[r['arm']][r['task_id']].append(r)

            def mean_p(arm: str, t: str, by_arm: dict[str, Any] = by_arm) -> float:
                xs = by_arm[arm][t]
                return sum(y_of(x) for x in xs) / len(xs)

            def mean_c(arm: str, t: str, by_arm: dict[str, Any] = by_arm) -> float:
                xs = by_arm[arm][t]
                return sum(float(x['ledger_usd'] or 0) for x in xs) / len(xs)
            res: dict[str, Any] = {}
            for esc, e in rules['escalations'].items():
                s_arm, t_arm = e['source'], e['target']
                src = [r for r in runs if r['arm'] == s_arm]
                ref = {t: {'sol_p': mean_p('A', t), 'sol_c': mean_c('A', t), 'tgt_c': mean_c(t_arm, t)}
                       for t in by_arm[s_arm] if by_arm['A'].get(t) and by_arm[t_arm].get(t)}
                er: dict[str, Any] = {'rules': {}}
                # perfect-signal, optimistic: fire at k = 1 on every failing source run, M2
                oracle = simulate_rule(src, by_arm[t_arm], lambda r: 1 if not y_of(r) else None, y_of, t_arm)
                er['perfect_signal_optimistic'] = {sp: estimands(task_rows({t: v for t, v in oracle.items() if sp == 'all' or split.get(t) == sp}, ref, s_arm == 'A'))
                                                   for sp in ('all', 'tune', 'heldout')}
                for rid, rule in e['rules'].items():
                    fk = {r['run_id']: fire_k(r, rule, fb, esc) for r in src}
                    sim = simulate_rule(src, by_arm[t_arm], lambda r, fk=fk: fk[r['run_id']], y_of, t_arm)
                    rr: dict[str, Any] = {}
                    for sp in ('all', 'tune', 'heldout'):
                        tasks = {t for t in sim if sp == 'all' or split.get(t) == sp}
                        rows = task_rows({t: v for t, v in sim.items() if t in tasks}, ref, s_arm == 'A')
                        est = estimands(rows)
                        keys = [k for k in est if k.endswith('_pp') or k.startswith('cost_')]
                        rr[sp] = {'n_tasks': len(rows), **est, 'ci': boot(rows, keys, bs['seed'], bs['n_boot'] if sp != 'tune' else bs['n_boot_tune']),
                                  **describe(sim, tasks)}
                    body = any(c['signal'] not in ROUTER_SIGNALS for c in rule['any'])
                    if body:   # sensitivity: runs without a rollout excluded (they never fire on body signals)
                        keep = [r for r in src if r['has_rollout']]
                        sim2 = simulate_rule(keep, by_arm[t_arm], lambda r, fk=fk: fk[r['run_id']], y_of, t_arm)
                        rr['all_excl_no_rollout'] = {**estimands(task_rows(sim2, ref, s_arm == 'A')),
                                                     'excluded_runs': len(src) - len(keep)}
                    er['rules'][rid] = rr
                # selection on tune, the gate once on heldout (§7.3)
                cands = []
                for rid, rr in er['rules'].items():
                    tu = rr['tune']
                    okc = (tu['fire_rate_on_resolved'] or 0) <= 0.25 if esc == 'SA' else (tu['cost_high_vs_sol'] or math.inf) <= 0.60
                    if okc:
                        cands.append((-tu['M2_vs_sol_pp'], tu['fire_rate'], rid))
                sel = min(cands)[2] if cands else None
                er['selected'] = sel
                if sel:
                    h = er['rules'][sel]['heldout']
                    if esc == 'SA':
                        conds = {'a_M2_ge_3pp': h['M2_vs_sol_pp'] >= 3.0, 'b_spec_ge_1pp': h['spec_pp'] >= 1.0, 'c_cost_high_le_2': (h['cost_high_vs_sol'] or math.inf) <= 2.0}
                    else:
                        lo = (h['ci'].get('M2_vs_sol_pp') or [-math.inf])[0]
                        conds = {'a_M2_ge_0pp': h['M2_vs_sol_pp'] >= 0.0, 'b_M2_lo_gt_-5pp': lo > -5.0, 'c_cost_high_le_0.60': (h['cost_high_vs_sol'] or math.inf) <= 0.60}
                    er['gate'] = {'conditions': conds, 'pass': all(conds.values())}
                else:
                    er['gate'] = {'conditions': {}, 'pass': False, 'note': 'no rule meets the selection constraint on tune'}
                er['auc'] = auc_table(src, y_of, {t: mean_p(t_arm, t) for t in by_arm[t_arm]}, bs['seed'], bs['auc_n_boot'])
                res[esc] = er
            result['bases'][basis] = res
        dst = RESULTS / f'sim-{bench}.json'
        dst.write_text(json.dumps(result, indent=1) + '\n', encoding='utf-8')
        print(f'{bench} → {dst.relative_to(ROOT.parent)}', file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=('freeze', 'run'))
    a = ap.parse_args()
    freeze() if a.cmd == 'freeze' else run()


if __name__ == '__main__':
    main()
