"""Offline "does auto help" on DeepSWE v1.1 public trials (mini-swe-agent), using the recorded v2.1 / v2.2 tier calls.

  python3 -I analyze.py <trials.json from https://deepswe.datacurve.ai/artifacts/v1.1/trials.json> <main>/experiments/assessor-v22/results/calls [--extra]

--extra (0d, design-stats §15.4) appends, without changing any line above it:
  * attempt 1 only, the earliest-started scored attempt per (config, task), to match our 1-run design. It gives
    C − A (paired bootstrap), exact McNemar, the per-run and per-solve cost ratios (bootstrap) and the 0/1 rescue counts;
  * all attempts: CIs for the C/A cost ratios, plus the held-out ideal {std, frontier} router with ties going to the
    cheaper tier.
  Each block uses its own Random(20261107), so the default output is byte-identical with or without the flag.

Reads only aggregates (pass, cost_usd) and task ids; prints no task text. The public file is not committed (third-party data)."""
import json, sys, random, collections, itertools, statistics as st
EXTRA = '--extra' in sys.argv   # 0d additions (design-stats §15.4): printed after the unchanged default output
TRIALS, CALLS = [a for a in sys.argv[1:] if a != '--extra'][:2]
rows = json.load(open(TRIALS))['rows']
FAM = {
  'claude5': {'frontier': 'claude_opus_5_high', 'standard': 'claude_sonnet_5_high', 'fast': None},
  'gpt':     {'frontier': 'gpt_6_astra_high', 'standard': 'gpt_5_6_sol_high', 'fast': 'gpt_5_6_luna_high'},
}
by = collections.defaultdict(list)   # (cfg, task) -> [(pass, cost)]
for r in rows:
    if not r['included_in_score']: continue
    cfg = r['config'].replace('mini_swe_agent_', '')
    by[(cfg, r['task_name'])].append((1.0 if r['passed'] else 0.0, float(r['cost_usd'] or 0.0), r['trial_name']))
def calls(label, part):
    out = collections.defaultdict(list)
    for rep in (1, 2, 3):
        for l in open(f'{CALLS}/{label}/r{rep}-{part}.jsonl'):
            c = json.loads(l)
            if c['dataset'] == 'deepswe': out[c['task_id']].append(c.get('pred') or 'standard')
    return out
v21 = calls('v21-base', 'all')
v22 = calls('d1a', 'tune'); v22.update(calls('v22d-eval', 'heldout'))   # d1a == v2.2-D content (same hash, same mapping)
TASKS = sorted(set(v21) & set(v22))
rng = random.Random(20261107); NB = 10000
def boot(vals, wts=None):
    n = len(vals); out = []
    for _ in range(NB):
        idx = [rng.randrange(n) for _ in range(n)]
        out.append(sum(vals[i] for i in idx) / n)
    out.sort(); return out[int(.025*NB)], out[int(.975*NB)]
def boot_ratio(num, den):
    n = len(num); out = []
    for _ in range(NB):
        idx = [rng.randrange(n) for _ in range(n)]
        d = sum(den[i] for i in idx); out.append(sum(num[i] for i in idx) / d if d else float('nan'))
    out.sort(); return out[int(.025*NB)], out[int(.975*NB)]
def pc(cfg, t):
    a = by[(cfg, t)]; return (st.mean(x[0] for x in a), st.mean(x[1] for x in a), len(a)) if a else None
def tierdist(c):
    k = collections.Counter(x for t in TASKS for x in c[t]); return dict(k)
print(f'tasks with both tier-call sets: {len(TASKS)}')
print('v2.1 calls:', tierdist(v21), ' v2.2 calls:', tierdist(v22))
for fam, m in FAM.items():
    T = [t for t in TASKS if pc(m['standard'], t) and pc(m['frontier'], t)]
    A = {t: pc(m['standard'], t) for t in T}; C = {t: pc(m['frontier'], t) for t in T}
    F = {t: pc(m['fast'], t) for t in T} if m['fast'] else {}
    model = lambda tier, t: (C if tier == 'frontier' else F if (tier == 'fast' and F.get(t)) else A)[t]
    pA = [A[t][0] for t in T]; pC = [C[t][0] for t in T]; cA = [A[t][1] for t in T]; cC = [C[t][1] for t in T]
    print(f'\n== {fam}: standard={m["standard"]} frontier={m["frontier"]} fast={m["fast"]}  n_tasks={len(T)}  attempts/task A={collections.Counter(A[t][2] for t in T)} C={collections.Counter(C[t][2] for t in T)}')
    print(f'  pin standard: {st.mean(pA):.1%}  ${st.mean(cA):.2f}/run ; pin frontier: {st.mean(pC):.1%}  ${st.mean(cC):.2f}/run')
    if F: print(f'  pin fast: {st.mean(F[t][0] for t in T):.1%}  ${st.mean(F[t][1] for t in T):.2f}/run')
    d = [C[t][0] - A[t][0] for t in T]; lo, hi = boot(d)
    print(f'  frontier - standard: {st.mean(d)*100:+.1f} pp [{lo*100:+.1f}, {hi*100:+.1f}], cost x{sum(cC)/sum(cA):.2f}; tasks C>A {sum(x>0 for x in d)}, C<A {sum(x<0 for x in d)}, tie {sum(x==0 for x in d)}')
    resc = [(1-A[t][0])*(C[t][0]-A[t][0]) for t in T]; roll = [(1-A[t][0])*A[t][0] for t in T]; anyc = [(1-A[t][0])*C[t][0] for t in T]
    print(f'  frontier-specific rescue mass {st.mean(resc)*100:.1f} pp  (std fail & frontier pass {st.mean(anyc)*100:.1f} pp; std second roll {st.mean(roll)*100:.1f} pp)')
    for name, cl in (('v2.1', v21), ('v2.2', v22)):
        pB = [st.mean(model(x, t)[0] for x in cl[t]) for t in T]; cB = [st.mean(model(x, t)[1] for x in cl[t]) for t in T]
        dd = [b - a for b, a in zip(pB, pA)]; lo, hi = boot(dd); rl, rh = boot_ratio(cB, cA)
        dc = [b - c for b, c in zip(pB, pC)]; clo, chi = boot(dc)
        share = collections.Counter(x for t in T for x in cl[t]); n = sum(share.values())
        print(f'  auto {name}: {st.mean(pB):.1%}  vs std {st.mean(dd)*100:+.1f} pp [{lo*100:+.1f}, {hi*100:+.1f}] cost x{sum(cB)/sum(cA):.2f} [{rl:.2f}, {rh:.2f}]'
              f' | vs frontier {st.mean(dc)*100:+.1f} pp [{clo*100:+.1f}, {chi*100:+.1f}] cost x{sum(cB)/sum(cC):.2f} | calls ' + ', '.join(f'{k} {v/n:.0%}' for k, v in sorted(share.items())))
        maj = {t: collections.Counter(cl[t]).most_common(1)[0][0] for t in T}
        fr = [d[i] for i, t in enumerate(T) if maj[t] == 'frontier']; sd = [d[i] for i, t in enumerate(T) if maj[t] == 'standard']
        if fr and sd:
            print(f'    selection: (C-A | called frontier, n={len(fr)}) {st.mean(fr)*100:+.1f} pp vs (C-A | called standard, n={len(sd)}) {st.mean(sd)*100:+.1f} pp -> {(st.mean(fr)-st.mean(sd))*100:+.1f} pp')
        else:
            print(f'    selection: not estimable (frontier-majority tasks {len(fr)}, standard {len(sd)})')
    # ideal router over {std, frontier}: held-out (choose on 2 attempts, score on the other 2), ties -> standard
    hs, hc, ch = [], [], []
    for t in T:
        a, c = by[(m['standard'], t)], by[(m['frontier'], t)]
        if len(a) < 4 or len(c) < 4: continue
        res = []
        for sel in itertools.combinations(range(4), 2):
            rest = [i for i in range(4) if i not in sel]
            pick = c if st.mean(c[i][0] for i in sel) > st.mean(a[i][0] for i in sel) else a
            res.append((st.mean(pick[i][0] for i in rest), st.mean(pick[i][1] for i in rest), pick is c))
        hs.append((st.mean(x[0] for x in res), st.mean(a[i][0] for i in range(4)))); hc.append((st.mean(x[1] for x in res), st.mean(a[i][1] for i in range(4)))); ch.append(st.mean(x[2] for x in res))
    dd = [x - y for x, y in hs]; lo, hi = boot(dd)
    print(f'  ideal router {{std, frontier}} held-out (n={len(hs)}): {st.mean(x for x, _ in hs):.1%}  vs std {st.mean(dd)*100:+.1f} pp [{lo*100:+.1f}, {hi*100:+.1f}]  cost x{sum(x for x,_ in hc)/sum(y for _,y in hc):.2f}  frontier share {st.mean(ch):.0%}')
    ins = [max(A[t][0], C[t][0]) for t in T]
    print(f'  ideal router in-sample upper bound: {st.mean(ins):.1%} ({(st.mean(ins)-st.mean(pA))*100:+.1f} pp vs std)')


# ---------------------------------------------------------------- 0d additions (--extra; design-stats §15.4)
def _ci(xs):
    xs = sorted(x for x in xs if x == x); m = len(xs)
    return (xs[int(.025 * m)], xs[min(m - 1, int(.975 * m))]) if m else (float('nan'), float('nan'))

def _boot_tasks(n, stat, seed=20261107, nb=NB):
    r = random.Random(seed); out = []
    for _ in range(nb):
        idx = [r.randrange(n) for _ in range(n)]; out.append(stat(idx))
    return _ci(out)

def _mcnemar(b, c):   # exact two-sided binomial on the discordant pairs
    from math import comb
    n = b + c
    return 1.0 if n == 0 else min(1.0, 2 * sum(comb(n, k) for k in range(min(b, c) + 1)) / 2 ** n)

def _ratio(num, den, idx):
    d = sum(den[i] for i in idx); return sum(num[i] for i in idx) / d if d else float('nan')

def _per_solve(cc, sc, ca, sa, idx):
    kc, ka, xa = sum(sc[i] for i in idx), sum(sa[i] for i in idx), sum(ca[i] for i in idx)
    return (sum(cc[i] for i in idx) / kc) / (xa / ka) if kc and ka and xa else float('nan')

def _block(label, A, C):
    T = sorted(set(A) & set(C)); n = len(T)
    pA = [A[t][0] for t in T]; pC = [C[t][0] for t in T]; cA = [A[t][1] for t in T]; cC = [C[t][1] for t in T]
    d = [c - a for a, c in zip(pA, pC)]; lo, hi = _boot_tasks(n, lambda ix: sum(d[i] for i in ix) / len(ix))
    print(f'  {label}: n_tasks={n}  std {st.mean(pA):.1%} ${st.mean(cA):.2f}/run ; frontier {st.mean(pC):.1%} ${st.mean(cC):.2f}/run')
    print(f'    frontier - standard: {st.mean(d)*100:+.1f} pp [{lo*100:+.1f}, {hi*100:+.1f}]')
    rl, rh = _boot_tasks(n, lambda ix: _ratio(cC, cA, ix))
    pl, ph = _boot_tasks(n, lambda ix: _per_solve(cC, pC, cA, pA, ix))
    print(f'    cost per run C/A x{sum(cC)/sum(cA):.2f} [{rl:.2f}, {rh:.2f}] ; per solve C/A x{_per_solve(cC, pC, cA, pA, range(n)):.2f} [{pl:.2f}, {ph:.2f}]')
    return T, pA, pC

for fam, m in FAM.items():
    if not EXTRA: break
    print(f'\n== {fam} (0d additions)')
    first = {}
    for (cfg, t), xs in by.items():
        if t in TASKS and cfg in (m['standard'], m['frontier']):
            r0 = min((r for r in rows if r['included_in_score'] and r['config'].replace('mini_swe_agent_', '') == cfg and r['task_name'] == t),
                     key=lambda r: r['started_at'])
            first[(cfg, t)] = (1.0 if r0['passed'] else 0.0, float(r0['cost_usd'] or 0.0))
    A1 = {t: v for (cfg, t), v in first.items() if cfg == m['standard']}; C1 = {t: v for (cfg, t), v in first.items() if cfg == m['frontier']}
    T1, a1, c1 = _block('attempt 1 only (earliest-started scored attempt)', A1, C1)
    both = sum(1 for a, c in zip(a1, c1) if a and c); onlyC = sum(1 for a, c in zip(a1, c1) if c and not a)
    onlyA = sum(1 for a, c in zip(a1, c1) if a and not c); neither = len(T1) - both - onlyC - onlyA
    print(f'    0/1 counts: both {both}, frontier only {onlyC}, standard only {onlyA}, neither {neither}; exact McNemar p = {_mcnemar(onlyC, onlyA):.4f};'
          f' frontier rescue rate on standard misses {onlyC/(onlyC+neither) if onlyC+neither else float("nan"):.1%}')
    Aall = {t: pc(m['standard'], t) for t in TASKS if pc(m['standard'], t) and pc(m['frontier'], t)}
    Call = {t: pc(m['frontier'], t) for t in Aall}
    _block('all attempts (CIs added)', Aall, Call)
    hs = []
    for t in Aall:
        a, c = by[(m['standard'], t)], by[(m['frontier'], t)]
        if len(a) < 4 or len(c) < 4: continue
        res = []
        for sel in itertools.combinations(range(4), 2):
            rest = [i for i in range(4) if i not in sel]
            sa, sc_ = st.mean(a[i][0] for i in sel), st.mean(c[i][0] for i in sel)
            cheaper_c = st.mean(c[i][1] for i in sel) < st.mean(a[i][1] for i in sel)
            pick = c if (sc_ > sa or (sc_ == sa and cheaper_c)) else a
            res.append((st.mean(pick[i][0] for i in rest), st.mean(pick[i][1] for i in rest), pick is c))
        hs.append((st.mean(x[0] for x in res), st.mean(a[i][0] for i in range(4)), st.mean(x[1] for x in res), st.mean(a[i][1] for i in range(4)), st.mean(x[2] for x in res),
                   st.mean(c[i][0] for i in range(4))))
    dd = [x[0] - x[1] for x in hs]; lo, hi = _boot_tasks(len(dd), lambda ix: sum(dd[i] for i in ix) / len(ix))
    print(f'    ideal router {{std, frontier}} held-out, ties -> cheaper on the selection attempts (n={len(hs)}): {st.mean(x[0] for x in hs):.1%}'
          f'  vs std {st.mean(dd)*100:+.1f} pp [{lo*100:+.1f}, {hi*100:+.1f}]  cost x{sum(x[2] for x in hs)/sum(x[3] for x in hs):.2f}  frontier share {st.mean(x[4] for x in hs):.0%}')
    df = [x[0] - x[5] for x in hs]; flo, fhi = _boot_tasks(len(df), lambda ix: sum(df[i] for i in ix) / len(ix))
    print(f'      same {len(hs)} tasks: pinned frontier {st.mean(x[5] for x in hs):.1%}; held-out router vs pinned frontier {st.mean(df)*100:+.1f} pp [{flo*100:+.1f}, {fhi*100:+.1f}]')
