"""Assessor v2.2 harness, scoring side (design §7.4 metrics, on the TUNE split only). Stdlib only; run with -I.

  python3 -I experiments/assessor-v22/score.py --dataset deepswe --split <split.jsonl> --labels <labels-tune.jsonl> \
      --calls v21-base [--calls <label> ...] [--out <name>]

Per tune task of the dataset: the measured per-arm resolve rate and mean cost (F Luna, A Sol, C Astra) from the
experiment's merged rows, on the labels' basis (phase != pilot, scored, in_comparisons; TB as graded). Each pack's
calls route fast→F, standard→A, frontier→C, none→A; a task's simulated outcome is the mean over its calls. Reported:
M1 route-by-pack vs pinned Sol (ΔR, cost ratio, task-bootstrap CIs), M2 vs v2.1 (its tier-pass calls) and vs the
Luna/Astra pins, M3 fast precision / loss / coverage, M4 agreement with target_tier and fast_safe, the call mix and
the run-to-run flip rate. `null` (always standard) and `v2.1-tierpass` (the experiments' own 3 tier passes) are
always included.

Sealing (design §7.3): held-out tasks are dropped before any outcome is aggregated, a labels file named *SEALED* is
refused, and only the requested dataset's labels are kept. Nothing per task is printed or written except to
results/ (gitignored).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys
from collections import Counter, defaultdict
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / 'results'
SEED = 20261107
N_BOOT = 10_000
ROWS = {'deepswe': REPO / 'experiments/deepswe-harbor/results/merged/rows.jsonl',
        'tb21': REPO / 'experiments/tbench-harbor/results/merged/rows.jsonl'}
TIERPASS = {'deepswe': REPO / 'experiments/deepswe-harbor/results/tierpass',
            'tb21': REPO / 'experiments/tbench-harbor/results/tierpass'}
ARM_OF = {'fast': 'F', 'standard': 'A', 'frontier': 'C', 'none': 'A'}   # none → the pool default (Sol)
TIER_ORDER = (('F', 'fast'), ('A', 'standard'), ('C', 'frontier'))     # cheapest first


def read_jsonl(p: pathlib.Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in p.read_text(encoding='utf-8').splitlines() if x.strip()]


def tier_of(v: Any) -> str:
    return v if v in ARM_OF else 'none'


# ---------------------------------------------------------------- inputs

def tune_tasks(split_path: pathlib.Path, dataset: str) -> set[str]:
    return {r['task_id'] for r in read_jsonl(split_path) if r['dataset'] == dataset and r['split'] == 'tune'}


def tune_labels(path: pathlib.Path, dataset: str, tune: set[str]) -> dict[str, dict[str, Any]]:
    if 'SEALED' in path.name:
        sys.exit('refusing a SEALED labels file (design §7.3)')
    out = {}
    for r in read_jsonl(path):
        if r.get('dataset') != dataset:
            continue
        if r.get('split') != 'tune' or r['task_id'] not in tune:
            sys.exit(f'labels file holds a non-tune task ({r.get("split")}); refusing')
        out[r['task_id']] = r
    return out


def outcomes(dataset: str, tune: set[str]) -> dict[str, dict[str, dict[str, float]]]:
    """task → arm → {'p': resolve rate, 'c': mean cost, 'n': runs}, tune tasks only (held-out rows are dropped first)."""
    acc: dict[str, dict[str, list[tuple[bool, float]]]] = defaultdict(lambda: defaultdict(list))
    for r in read_jsonl(ROWS[dataset]):
        if r['task_id'] not in tune:
            continue
        if r['phase'] == 'pilot' or r['final_status'] != 'scored' or not r.get('in_comparisons') or r['arm'] not in ('F', 'A', 'C'):
            continue
        acc[r['task_id']][r['arm']].append((bool(r['resolved']), float(r.get('ledger_usd') or 0.0)))
    out: dict[str, dict[str, dict[str, float]]] = {}
    for t, arms in acc.items():
        if set(arms) != {'F', 'A', 'C'}:
            continue
        out[t] = {a: {'p': sum(x for x, _ in v) / len(v), 'c': sum(c for _, c in v) / len(v), 'n': len(v)} for a, v in arms.items()}
    return out


def target(o: dict[str, dict[str, float]]) -> str:
    best = max(o[a]['p'] for a in 'FAC')
    return next(name for arm, name in TIER_ORDER if o[arm]['p'] >= best - 1e-9)


def load_calls(label: str, dataset: str, tasks: set[str]) -> dict[str, list[str]]:
    """task → the pack's router-acted calls (pred: within the deadline, confidence ≥ threshold), every rep."""
    d = RESULTS / 'calls' / label
    if not d.is_dir():
        sys.exit(f'no calls for {label}')
    by: dict[str, list[str]] = defaultdict(list)
    for f in sorted(d.glob('r*-*.jsonl')):
        for r in read_jsonl(f):
            if r['dataset'] == dataset and r['task_id'] in tasks:
                by[r['task_id']].append(tier_of(r.get('pred')))
    return by


def tierpass_calls(dataset: str, tasks: set[str]) -> dict[str, list[str]]:
    by: dict[str, list[str]] = defaultdict(list)
    for f in sorted(TIERPASS[dataset].glob('tiers-r*.jsonl')):
        for r in read_jsonl(f):
            if r['task_id'] in tasks:
                by[r['task_id']].append(tier_of(r.get('pred_tier')))
    return by


# ---------------------------------------------------------------- metrics

def boot(tasks: list[str], stat, n: int = N_BOOT, seed: int = SEED) -> list[float] | None:
    if len(tasks) < 2:
        return None
    rnd = random.Random(seed)
    vals = []
    for _ in range(n):
        s = [tasks[rnd.randrange(len(tasks))] for _ in tasks]
        v = stat(s)
        if v is not None:
            vals.append(v)
    vals.sort()
    return [round(vals[int(0.025 * len(vals))], 4), round(vals[int(0.975 * len(vals)) - 1], 4)] if vals else None


def simulate(calls: dict[str, list[str]], o: dict[str, dict[str, dict[str, float]]], tasks: list[str]) -> tuple[dict[str, float], dict[str, float]]:
    R = {t: sum(o[t][ARM_OF[c]]['p'] for c in calls[t]) / len(calls[t]) for t in tasks}
    K = {t: sum(o[t][ARM_OF[c]]['c'] for c in calls[t]) / len(calls[t]) for t in tasks}
    return R, K


def versus(R: dict[str, float], K: dict[str, float], R0: dict[str, float], K0: dict[str, float], tasks: list[str]) -> dict[str, Any]:
    dR = lambda s: sum(R[t] - R0[t] for t in s) / len(s)  # noqa: E731
    ratio = lambda s: (sum(K[t] for t in s) / sum(K0[t] for t in s)) if sum(K0[t] for t in s) > 0 else None  # noqa: E731
    lo_hi = boot(tasks, dR)
    r_ci = boot(tasks, ratio)
    return {'dR_pp': round(100 * dR(tasks), 2), 'dR_ci95_pp': [round(100 * x, 2) for x in lo_hi] if lo_hi else None,
            'cost_ratio': round(ratio(tasks), 4) if ratio(tasks) is not None else None, 'cost_ratio_ci95': r_ci}


def kappa(pairs: list[tuple[str, str]]) -> float | None:
    if not pairs:
        return None
    n = len(pairs)
    po = sum(1 for a, b in pairs if a == b) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return round((po - pe) / (1 - pe), 4) if pe < 1 else None


def score_pack(name: str, calls: dict[str, list[str]], o, labels, tasks: list[str], refs: dict[str, tuple[dict, dict]]) -> dict[str, Any]:
    missing = [t for t in tasks if not calls.get(t)]
    if missing:
        return {'error': f'{len(missing)} tune tasks have no calls'}
    R, K = simulate(calls, o, tasks)
    res: dict[str, Any] = {
        'tasks': len(tasks), 'calls_per_task': sorted({len(calls[t]) for t in tasks}),
        'mix': dict(Counter(c for t in tasks for c in calls[t])),
        'resolve': round(sum(R.values()) / len(tasks), 4), 'cost_usd': round(sum(K.values()), 2),
        'flip_rate': round(sum(1 for t in tasks if len(set(calls[t])) > 1) / len(tasks), 4),
    }
    res['vs'] = {ref: versus(R, K, r0, k0, tasks) for ref, (r0, k0) in refs.items() if ref != name}
    keep = [t for t in tasks if not labels[t].get('unsolved')]
    res['vs_sol_excl_unsolved'] = versus(R, K, refs['sol'][0], refs['sol'][1], keep)
    # M3: fast calls (call-weighted)
    fast = [(t, c) for t in tasks for c in calls[t] if c == 'fast']
    n_calls = sum(len(calls[t]) for t in tasks)
    res['fast'] = {'calls': len(fast), 'coverage': round(len(fast) / n_calls, 4),
                   'precision': round(sum(1 for t, _ in fast if labels[t]['fast_safe']) / len(fast), 4) if fast else None,
                   'loss_pp': round(100 * sum(o[t]['A']['p'] - o[t]['F']['p'] for t, _ in fast) / len(fast), 2) if fast else None}
    if fast:
        def prec(s):
            fs = [(t, c) for t in s for c in calls[t] if c == 'fast']
            return sum(1 for t, _ in fs if labels[t]['fast_safe']) / len(fs) if fs else None
        res['fast']['precision_ci95'] = boot(tasks, prec)
    # M4: agreement per call (none counted as standard, as the router serves it)
    pairs = [(c if c != 'none' else 'standard', labels[t]['target_tier']) for t in tasks for c in calls[t]]
    res['agreement'] = {'accuracy': round(sum(1 for a, b in pairs if a == b) / len(pairs), 4), 'kappa': kappa(pairs),
                        'confusion_call_x_target': {k: dict(v) for k, v in sorted(_xt(pairs).items())},
                        'fast_safe_accuracy': round(sum(1 for t in tasks for c in calls[t] if (c == 'fast') == bool(labels[t]['fast_safe'])) / n_calls, 4)}
    return res


def _xt(pairs: list[tuple[str, str]]) -> dict[str, Counter]:
    xt: dict[str, Counter] = defaultdict(Counter)
    for a, b in pairs:
        xt[a][b] += 1
    return xt


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dataset', required=True, choices=sorted(ROWS))
    ap.add_argument('--split', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--calls', action='append', default=[], help='a results/calls/<label> to score (repeatable)')
    ap.add_argument('--out', help='write results/scores/<out>.json')
    a = ap.parse_args()
    tune = tune_tasks(pathlib.Path(a.split), a.dataset)
    labels = tune_labels(pathlib.Path(a.labels), a.dataset, tune)
    o = outcomes(a.dataset, tune)
    tasks = sorted(t for t in tune if t in o and t in labels)
    # Self-check: the outcomes reproduce 0d's labels on every tune task (same basis as make_labels.py).
    mism = sum(1 for t in tasks if target(o[t]) != labels[t]['target_tier'] or (o[t]['F']['p'] >= o[t]['A']['p']) != bool(labels[t]['fast_safe']))
    if mism:
        sys.exit(f'{mism} tune tasks: outcomes do not reproduce the labels; check the basis')
    pin = {arm: ({t: o[t][arm]['p'] for t in tasks}, {t: o[t][arm]['c'] for t in tasks}) for arm in 'FAC'}
    refs = {'sol': pin['A'], 'luna': pin['F'], 'astra': pin['C']}
    v21 = tierpass_calls(a.dataset, set(tasks))
    refs['v2.1-tierpass'] = simulate(v21, o, tasks)
    packs = {'null': {t: ['standard'] for t in tasks}, 'v2.1-tierpass': v21}
    packs.update({lab: load_calls(lab, a.dataset, set(tasks)) for lab in a.calls})
    res: dict[str, Any] = {
        'schema': 'assessor-v22-score/v1', 'dataset': a.dataset, 'split': 'tune', 'tasks': len(tasks),
        'labels': dict(Counter(labels[t]['target_tier'] for t in tasks)), 'fast_safe': sum(1 for t in tasks if labels[t]['fast_safe']),
        'unsolved': sum(1 for t in tasks if labels[t].get('unsolved')),
        'pins': {k: {'resolve': round(sum(r.values()) / len(tasks), 4), 'cost_usd': round(sum(c.values()), 2)} for k, (r, c) in refs.items() if k in ('sol', 'luna', 'astra')},
        'packs': {name: score_pack(name, calls, o, labels, tasks, refs) for name, calls in packs.items()},
    }
    if a.out:
        p = RESULTS / 'scores' / f'{a.out}.json'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(res, indent=1) + '\n', encoding='utf-8')
    print(f"{a.dataset} tune: {len(tasks)} tasks, labels {res['labels']}, fast_safe {res['fast_safe']}, unsolved {res['unsolved']}")
    print(f"pins: " + ', '.join(f"{k} {v['resolve']:.1%} ${v['cost_usd']:.0f}" for k, v in res['pins'].items()))
    print(f"{'pack':<22}{'mix':<34}{'resolve':>8}{'ΔR vs Sol [CI]':>24}{'cost×Sol [CI]':>22}{'fast prec':>10}{'acc':>7}{'κ':>7}{'flip':>6}")
    for name, s in res['packs'].items():
        if 'error' in s:
            print(f'{name:<22}{s["error"]}')
            continue
        v = s['vs']['sol']
        ci = v['dR_ci95_pp'] or [float('nan')] * 2
        cr = v['cost_ratio_ci95'] or [float('nan')] * 2
        mix = ' '.join(f'{k[:2]}{n}' for k, n in sorted(s['mix'].items()))
        fp = s['fast']['precision']
        print(f"{name:<22}{mix:<34}{s['resolve']:>8.1%}{v['dR_pp']:>+8.1f} [{ci[0]:+.1f},{ci[1]:+.1f}]"
              f"{v['cost_ratio']:>8.2f} [{cr[0]:.2f},{cr[1]:.2f}]{'—' if fp is None else format(fp, '.0%'):>10}"
              f"{s['agreement']['accuracy']:>7.0%}{s['agreement']['kappa'] if s['agreement']['kappa'] is not None else float('nan'):>7.2f}{s['flip_rate']:>6.0%}")


if __name__ == '__main__':
    main()
