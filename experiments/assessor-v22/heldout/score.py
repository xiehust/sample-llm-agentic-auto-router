"""v2.2 scoring (design §7.4, 0d): simulated route-by-pack vs pinned arms, fast-call quality, label agreement.

    python3 -I score.py --repo <root> --labels <labels jsonl> --split tune|heldout|all --dataset deepswe|tb21
                        --pack NAME=calls1.jsonl,calls2.jsonl,calls3.jsonl [--pack ...] [--tb-basis graded|primary]
                        [--exclude unsolved,flaky] [--majority] [--n-boot 10000]

Call files: tier-pass format (one JSON per line with task_id and pred_tier). The call the router acts on is
`pred_tier` (none / missing → standard = Sol). A task's simulated outcome is the mean over its passes of the called
tier's measured per-task rate and mean cost (--majority: the majority call instead). `NAME=null` is the all-standard
reference (= pinned Sol). Output: JSON on stdout; task ids and aggregates only.
"""
import argparse, collections, json, math, random, statistics as S, sys

TIER_ARM = {'fast': 'F', 'standard': 'A', 'frontier': 'C'}
ROWS = {'deepswe': 'experiments/deepswe-harbor/results/merged/rows.jsonl', 'tb21': 'experiments/tbench-harbor/results/merged/rows.jsonl'}
FLAKY = {'tb21': {'portfolio-optimization', 'tune-mjcf'}}
SEED = 20261107


def outcomes(repo, ds, basis):
    by = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in map(json.loads, open(f'{repo}/{ROWS[ds]}')):
        if r['phase'] == 'pilot' or r['final_status'] != 'scored' or not r.get('in_comparisons') or r['arm'] not in 'FAC':
            continue
        ok = bool(r['resolved'])
        if basis == 'primary' and ds == 'tb21' and (r.get('lookup') or {}).get('flag'):
            ok = False
        by[r['task_id']][r['arm']].append((ok, float(r['ledger_usd'] or 0)))
    return {t: {a: (S.mean(x for x, _ in v), S.mean(c for _, c in v)) for a, v in arms.items()} for t, arms in by.items()}


def load_calls(paths):
    passes = []
    for p in paths:
        passes.append({(d := json.loads(l))['task_id']: (d.get('pred_tier') or 'none') for l in open(p) if l.strip()})
    return passes


def boot(tasks, fn, n_boot, seed=SEED):
    """Percentile CI over task resamples; resamples where fn is undefined (NaN, e.g. no fast call) are dropped
    (fix 2026-11-07: NaN in the sort corrupted the fast-precision CI)."""
    rng = random.Random(seed)
    reps = sorted(x for x in (fn([rng.choice(tasks) for _ in tasks]) for _ in range(n_boot)) if not math.isnan(x))
    if not reps:
        return None
    m = len(reps)
    return [reps[int(0.025 * m)], reps[min(m - 1, int(0.975 * m))]]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True); ap.add_argument('--labels', required=True)
    ap.add_argument('--split', choices=('tune', 'heldout', 'all'), required=True)
    ap.add_argument('--dataset', choices=sorted(ROWS), required=True)
    ap.add_argument('--pack', action='append', required=True, help='NAME=f1,f2,f3 or NAME=null')
    ap.add_argument('--tb-basis', choices=('graded', 'primary'), default='graded')
    ap.add_argument('--exclude', default='')
    ap.add_argument('--majority', action='store_true')
    ap.add_argument('--n-boot', type=int, default=10000)
    a = ap.parse_args(argv)
    labels = {d['task_id']: d for d in map(json.loads, open(a.labels)) if d['dataset'] == a.dataset}
    out = outcomes(a.repo, a.dataset, a.tb_basis)
    ex = set(x for x in a.exclude.split(',') if x)
    tasks = sorted(t for t, d in labels.items() if (a.split == 'all' or d['split'] == a.split) and t in out
                   and not ('unsolved' in ex and d['unsolved']) and not ('flaky' in ex and t in FLAKY.get(a.dataset, ())))
    res = {'dataset': a.dataset, 'split': a.split, 'tb_basis': a.tb_basis, 'exclude': sorted(ex), 'majority': a.majority,
           'n_tasks': len(tasks), 'seed': SEED, 'n_boot': a.n_boot,
           'pinned': {arm: {'rate': S.mean(out[t][arm][0] for t in tasks), 'cost': sum(out[t][arm][1] for t in tasks)} for arm in 'FAC'},
           'packs': {}}
    for spec in a.pack:
        name, _, files = spec.partition('=')
        if files == 'null':
            calls = {t: ['standard'] for t in tasks}
        else:
            ps = load_calls(files.split(','))
            calls = {t: [p.get(t, 'none') for p in ps] for t in tasks}
        if a.majority:
            calls = {t: [collections.Counter(TIER_ARM.get(c, 'A') for c in cs).most_common(1)[0][0]] for t, cs in calls.items()}
            arm_calls = calls
        else:
            arm_calls = {t: [TIER_ARM.get(c, 'A') for c in cs] for t, cs in calls.items()}
        R = {t: S.mean(out[t][x][0] for x in arm_calls[t]) for t in tasks}
        K = {t: S.mean(out[t][x][1] for x in arm_calls[t]) for t in tasks}
        def dR(ts, ref='A'):
            return S.mean(R[t] - out[t][ref][0] for t in ts)
        def cr(ts, ref='A'):
            s = sum(out[t][ref][1] for t in ts)
            return sum(K[t] for t in ts) / s if s else float('nan')
        m1 = {'rate': S.mean(R.values()), 'cost': sum(K.values()), 'dR_vs_A': dR(tasks), 'dR_vs_A_ci': boot(tasks, dR, a.n_boot),
              'cost_ratio_vs_A': cr(tasks), 'cost_ratio_vs_A_ci': boot(tasks, cr, a.n_boot)}
        lo, hi = m1['dR_vs_A_ci']; clo, chi = m1['cost_ratio_vs_A_ci']
        m1['reading'] = ('beats Sol' if lo > 0 and chi <= 1 else 'cheaper near-Sol' if lo > -0.05 and chi < 1 else 'point + CIs only')
        others = {ref: {'dR': dR(tasks, ref), 'dR_ci': boot(tasks, lambda ts, ref=ref: dR(ts, ref), a.n_boot),
                        'cost_ratio': cr(tasks, ref), 'cost_ratio_ci': boot(tasks, lambda ts, ref=ref: cr(ts, ref), a.n_boot)} for ref in 'FC'}
        flat = [(t, x) for t in tasks for x in arm_calls[t]]
        fast = [(t, x) for t, x in flat if x == 'F']
        def prec(ts):
            f = [(t, x) for t in ts for x in arm_calls[t] if x == 'F']
            return sum(labels[t]['fast_safe'] for t, _ in f) / len(f) if f else float('nan')
        m3 = {'fast_calls': len(fast), 'fast_coverage': len(fast) / len(flat) if flat else None,
              'fast_precision': prec(tasks) if fast else None, 'fast_precision_ci': boot(tasks, prec, a.n_boot) if fast else None,
              'fast_loss_pp': 100 * S.mean(out[t]['A'][0] - out[t]['F'][0] for t, _ in fast) if fast else None}
        inv = {v: k for k, v in TIER_ARM.items()}
        pairs = [(labels[t]['target_tier'], inv[x]) for t, x in flat]
        acc = S.mean(g == p for g, p in pairs)
        pg = collections.Counter(g for g, _ in pairs); pp = collections.Counter(p for _, p in pairs); n = len(pairs)
        pe = sum(pg[k] * pp[k] for k in TIER_ARM) / (n * n)
        m4 = {'accuracy': acc, 'kappa': (acc - pe) / (1 - pe) if pe < 1 else None,
              'confusion': {g: {p: sum(1 for x, y in pairs if x == g and y == p) for p in TIER_ARM} for g in TIER_ARM},
              'fast_safe_agreement': S.mean((x == 'F') == labels[t]['fast_safe'] for t, x in flat)}
        res['packs'][name] = {'calls_per_task': len(next(iter(arm_calls.values()))) if arm_calls else 0,
                              'call_share': {k: sum(1 for _, x in flat if x == v) / len(flat) for k, v in TIER_ARM.items()},
                              'M1_vs_Sol': m1, 'M2_vs_pinned': others, 'M3_fast': m3, 'M4_agreement': m4}
    json.dump(res, sys.stdout, indent=1, sort_keys=True)
    print()


if __name__ == '__main__':
    main()
