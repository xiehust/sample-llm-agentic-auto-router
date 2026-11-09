"""v2.2 target-tier labels and split (design §7.2–7.3, 0d). Deterministic; task ids and aggregates only.

    python3 -I make_labels.py <repo root> <out dir>
"""
import collections, hashlib, json, random, sys
REPO, OUT = sys.argv[1], sys.argv[2]
SEED = 20261107
TIERS = (('F', 'fast'), ('A', 'standard'), ('C', 'frontier'))   # cheapest first
SRC = {'deepswe': ('experiments/deepswe-harbor/results/merged/rows.jsonl', 'experiments/deepswe-harbor/results/tierpass/strata.json'),
       'tb21': ('experiments/tbench-harbor/results/merged/rows.jsonl', 'experiments/tbench-harbor/results/tierpass/strata.json')}

def label(p):
    best = max(p.values())
    return next(name for arm, name in TIERS if p[arm] >= best - 1e-9)

def per_task(ds):
    rows, strata = SRC[ds]
    by = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in map(json.loads, open(f'{REPO}/{rows}')):
        if r['phase'] == 'pilot' or r['final_status'] != 'scored' or not r.get('in_comparisons') or r['arm'] not in 'FAC':
            continue
        by[r['task_id']][r['arm']].append(bool(r['resolved']))       # as graded (TB: §7.7 flags ignored, see design §7.2)
    st = json.load(open(f'{REPO}/{strata}'))['tasks']
    return by, {t: st[t]['stratum'] for t in by}

out = []
for ds in SRC:
    by, stratum = per_task(ds)
    rng = random.Random(f'{SEED}:{ds}:stability')
    for t in sorted(by):
        p = {a: sum(v) / len(v) for a, v in by[t].items()}
        lab = label(p)
        hits = 0
        for _ in range(2000):                                         # within-task run bootstrap
            q = {a: sum(rng.choice(v) for _ in v) / len(v) for a, v in by[t].items()}
            hits += label(q) == lab
        out.append({'dataset': ds, 'task_id': t, 'target_tier': lab, 'fast_safe': p['F'] >= p['A'] - 1e-9,
                    'stability': round(hits / 2000, 3), 'ambiguous': hits / 2000 < 0.6, 'unsolved': max(p.values()) == 0,
                    'runs': {a: len(v) for a, v in by[t].items()}, 'tierpass_stratum': stratum[t]})
# split: per dataset, stratified by (target_tier, tierpass_stratum); 40% held out, systematic over a seeded order
for ds in SRC:
    cells = collections.defaultdict(list)
    for r in out:
        if r['dataset'] == ds:
            cells[(r['target_tier'], r['tierpass_stratum'])].append(r)
    i = 0
    for key in sorted(cells):
        rs = sorted(cells[key], key=lambda r: hashlib.sha256(f"{SEED}:{ds}:{r['task_id']}".encode()).hexdigest())
        for r in rs:
            r['split'] = 'heldout' if (i % 5) in (1, 3) else 'tune'   # 2 of every 5 → 40%, continuing across cells
            i += 1
full = [json.dumps(r, sort_keys=True) for r in sorted(out, key=lambda r: (r['dataset'], r['task_id']))]
tune = [json.dumps({k: v for k, v in r.items()}, sort_keys=True) for r in sorted(out, key=lambda r: (r['dataset'], r['task_id'])) if r['split'] == 'tune']
split = [json.dumps({'dataset': r['dataset'], 'task_id': r['task_id'], 'split': r['split']}, sort_keys=True) for r in sorted(out, key=lambda r: (r['dataset'], r['task_id']))]
for name, lines in (('labels-all.SEALED.jsonl', full), ('labels-tune.jsonl', tune), ('split.jsonl', split)):
    data = ('\n'.join(lines) + '\n').encode()
    open(f'{OUT}/{name}', 'wb').write(data)
    print(name, len(lines), hashlib.sha256(data).hexdigest())
c = collections.Counter((r['dataset'], r['split'], r['target_tier']) for r in out)
for k in sorted(c): print(k, c[k])
print('ambiguous', collections.Counter((r['dataset'], r['ambiguous']) for r in out), 'unsolved', collections.Counter((r['dataset'], r['unsolved']) for r in out))
print('fast_safe', collections.Counter((r['dataset'], r['fast_safe']) for r in out))
