"""Seeded task selection (design §11, revision 2 after the tier pass).

The tier pass found no off-standard predictions (0 fast, 0 frontier of 500), so tier stratification and the D2
population weights are dropped; each task's predicted tier is still recorded (`pred_tier`, `pred_tier_untimed`).
1. Candidates: a seeded simple random sample of 500 R2E-Gym-Subset tasks (candidates.json).
2. Order: the candidates in a seeded random order. The pilot takes the first 3 small/medium tasks from distinct
   repos; the main 50 take the next tasks in order, at most 8 per repo. Every candidate left is a reserve, in order.
3. Arms: A (pin Sol) and F (pin Luna) on all 50; C (Astra) on 20, B (auto + assessor) on 10 and D (direct Sol)
   on 5, each a size-stratified subset of the 50. Repeat: 10 of the 50 (A and F again).
4. A task that fails gold validation is replaced by the next reserve under the repo cap (same size first when the
   task is in a size-stratified subset; a distinct repo for pilot tasks). Arm membership moves with it.
Only ids, strata and arm membership are written; no dataset text.
"""
from __future__ import annotations

import random
from collections import Counter
from collections.abc import Sequence
from typing import Any

from common import DATASET, SEED, now_iso

REPO_CAP = 8


def candidates(task_ids: Sequence[str], n: int = 500, seed: int = SEED) -> list[str]:
    pool = sorted(set(task_ids))
    return sorted(random.Random(seed).sample(pool, min(n, len(pool))))


def _alloc(counts: dict[str, int], total: int) -> dict[str, int]:
    """Largest-remainder allocation of `total` over keys in proportion to counts (deterministic order)."""
    s = sum(counts.values())
    if s == 0 or total <= 0:
        return {k: 0 for k in counts}
    raw = {k: total * v / s for k, v in counts.items()}
    out = {k: int(raw[k]) for k in counts}
    rest = total - sum(out.values())
    for k in sorted(counts, key=lambda k: (-(raw[k] - out[k]), k))[:rest]:
        out[k] += 1
    return out


def _take(order: list[str], k: int, repo_of: dict[str, str], repo_count: Counter, cap: int = REPO_CAP) -> list[str]:
    got: list[str] = []
    for t in order:
        if len(got) >= k:
            break
        if repo_count[repo_of[t]] >= cap:
            continue
        got.append(t)
        repo_count[repo_of[t]] += 1
    return got


def _size_stratified(ids: list[str], k: int, size_of: dict[str, str], rng: random.Random) -> list[str]:
    by: dict[str, list[str]] = {}
    for t in ids:
        by.setdefault(size_of[t], []).append(t)
    alloc = _alloc({s: len(v) for s, v in sorted(by.items())}, min(k, len(ids)))
    out: list[str] = []
    for s in sorted(by):
        v = sorted(by[s])
        rng.shuffle(v)
        out += v[:alloc[s]]
    return sorted(out)


def select(cands: list[dict[str, Any]], seed: int = SEED, n_main: int = 50, n_pilot: int = 3,
           subsets: dict[str, int] | None = None, n_repeat: int = 10) -> dict[str, Any]:
    """`cands`: [{task_id, repo, size, pred_tier[, pred_tier_untimed]}] for every candidate."""
    rng = random.Random(seed)
    subs = subsets or {'C': 20, 'B': 10, 'D': 5}
    meta = {c['task_id']: {'repo': c['repo'], 'size': c['size'], 'pred_tier': c.get('pred_tier') or 'none',
                           'pred_tier_untimed': c.get('pred_tier_untimed') or c.get('pred_tier') or 'none'} for c in cands}
    order = sorted(meta)
    rng.shuffle(order)
    pilot: list[str] = []
    for t in order:
        if len(pilot) >= n_pilot:
            break
        if meta[t]['size'] != 'large' and meta[t]['repo'] not in {meta[p]['repo'] for p in pilot}:
            pilot.append(t)
    rest = [t for t in order if t not in pilot]
    main = sorted(_take(rest, n_main, {t: meta[t]['repo'] for t in rest}, Counter()))
    reserves = [t for t in rest if t not in main]
    size_of = {t: meta[t]['size'] for t in meta}
    arms: dict[str, list[str]] = {'A': main, 'F': main}
    for arm in sorted(subs):
        arms[arm] = _size_stratified(main, subs[arm], size_of, rng)
    rep = list(main)
    rng.shuffle(rep)
    return {
        'schema': 'codex-deepswe-selection/v2', 'created': now_iso(), 'seed': seed,
        'dataset': {k: DATASET[k] for k in ('repo', 'revision', 'license')},
        'rules': {'n_main': n_main, 'n_pilot': n_pilot, 'repo_cap': REPO_CAP, 'subsets': subs, 'n_repeat': n_repeat,
                  'design': '§11: seeded SRS, no tier stratification'},
        'pred_tier_counts': dict(sorted(Counter(m['pred_tier'] for m in meta.values()).items())),
        'pred_tier_untimed_counts': dict(sorted(Counter(m['pred_tier_untimed'] for m in meta.values()).items())),
        'tasks': {x: meta[x] for x in sorted(set(main) | set(pilot))},
        'pilot': sorted(pilot), 'main': main, 'arms': arms, 'repeat': sorted(rep[:n_repeat]),
        'reserves': reserves, 'reserve_meta': {x: meta[x] for x in reserves},
        'replacements': [], 'validated': {},
    }


def extend(prev: dict[str, Any], n_main: int = 200, repo_cap_frac: float = 0.25, subsets: dict[str, int] | None = None,
           n_repeat: int = 20, repeat_reps: int = 1, seed: int = SEED) -> dict[str, Any]:
    """Design §12 (revision 3): grows a validated v2 selection to `n_main` without re-drawing.

    The v2 main tasks and the pilot are kept (their gold validation is reused; the pilot stays outside main). New
    main tasks are taken from v2's reserves in their seeded order, the same random order the v2 sample was a prefix
    of, under a repo cap of `repo_cap_frac` × n_main. So the 200 are the prefix of one seeded random order, minus
    what the caps skipped and what failed validation. Tasks that failed validation never come back. The arm subsets
    (C, B, D) and the repeat list are drawn afresh (size-stratified) from the 200: no main-run data exists yet.
    """
    rng = random.Random(f'{seed}:v3')
    subs = subsets or {'C': 60, 'B': 30, 'D': 10}
    cap = max(1, int(repo_cap_frac * n_main))
    failed = {r['failed'] for r in prev['replacements']}
    tasks = dict(prev['tasks'])
    main = list(prev['main'])
    repos = Counter(tasks[t]['repo'] for t in main)
    if max(repos.values(), default=0) > cap:
        raise ValueError('the kept main tasks already exceed the new repo cap')
    reserves = list(prev['reserves'])
    rm = dict(prev['reserve_meta'])
    skipped_cap: list[str] = []
    for t in list(reserves):
        if len(main) >= n_main:
            break
        if t in failed:
            continue
        if repos[rm[t]['repo']] >= cap:
            skipped_cap.append(t)
            continue
        main.append(t)
        repos[rm[t]['repo']] += 1
        tasks[t] = rm.pop(t)
        reserves.remove(t)
    if len(main) < n_main:
        raise ValueError(f'only {len(main)} tasks fit under a repo cap of {cap}')
    main = sorted(main)
    size_of = {t: tasks[t]['size'] for t in main}
    arms: dict[str, list[str]] = {'A': main, 'F': main}
    for arm in sorted(subs):
        arms[arm] = _size_stratified(main, subs[arm], size_of, rng)
    rep = _size_stratified(main, n_repeat, size_of, rng)
    pool_by_repo = Counter(m['repo'] for m in list(tasks.values()) + list(rm.values()))
    return {
        **{k: prev[k] for k in ('dataset', 'seed', 'pilot', 'validated', 'replacements', 'tierpass', 'validation_summary') if k in prev},
        'schema': 'codex-deepswe-selection/v3', 'created': now_iso(), 'previous_schema': prev['schema'],
        'rules': {'n_main': n_main, 'n_pilot': len(prev['pilot']), 'repo_cap': cap, 'repo_cap_frac': repo_cap_frac,
                  'subsets': subs, 'n_repeat': n_repeat, 'repeat_reps': repeat_reps,
                  'design': '§12: the v2 sample (50 + 3 pilot, validated) extended along the same seeded order to 200'},
        'kept_from_v2': {'main': len(prev['main']), 'pilot': len(prev['pilot'])},
        'repo_counts': dict(sorted(Counter(tasks[t]['repo'] for t in main).items())),
        'size_counts': dict(sorted(Counter(size_of.values()).items())),
        'repo_cap_effect': {'skipped_by_cap': len(skipped_cap),
                            'skipped_by_repo': dict(sorted(Counter(rm[t]['repo'] for t in skipped_cap).items())),
                            'pool_by_repo': dict(sorted(pool_by_repo.items()))},
        'pred_tier_counts': dict(sorted(Counter(tasks[t]['pred_tier'] for t in main).items())),
        'tasks': tasks, 'main': main, 'arms': arms, 'repeat': sorted(rep),
        'reserves': reserves, 'reserve_meta': rm,
    }


def validation_summary(sel: dict[str, Any]) -> dict[str, Any]:
    """Review S1: gold-validation pass rate per predicted tier, over every task validated (failed ones included)."""
    tier_of = {x: m.get('pred_tier') for x, m in sel['tasks'].items()}
    by: dict[str, dict[str, int]] = {}
    for tid, v in sel['validated'].items():
        t = tier_of.get(tid, 'none') or 'none'
        b = by.setdefault(t, {'validated': 0, 'ok': 0})
        b['validated'] += 1
        b['ok'] += int(bool(v.get('ok')))
    return {'by_tier': dict(sorted(by.items())), 'validated': sum(b['validated'] for b in by.values()),
            'ok': sum(b['ok'] for b in by.values())}


def replace(sel: dict[str, Any], failed: str, reason: str) -> str | None:
    """Swaps a main or pilot task that failed validation for the next reserve (see the module docstring). Returns the
    replacement id, or None when the reserves are exhausted."""
    meta = sel['tasks'][failed]
    in_main = failed in sel['main']
    group = sel['main'] if in_main else sel['pilot']
    repos = Counter(sel['tasks'][x]['repo'] for x in group if x != failed)
    rm = sel['reserve_meta']
    pool = sel['reserves']
    if in_main:
        ok = [x for x in pool if repos[rm[x]['repo']] < sel['rules'].get('repo_cap', REPO_CAP)]
        if any(failed in sel['arms'].get(a, []) for a in sel['rules']['subsets']):
            ok = [x for x in ok if rm[x]['size'] == meta['size']] + [x for x in ok if rm[x]['size'] != meta['size']]
    else:
        ok = [x for x in pool if rm[x]['repo'] not in repos and rm[x]['size'] != 'large']
    pick = ok[0] if ok else None
    sel['replacements'].append({'failed': failed, 'reason': reason, 'replacement': pick, 'at': now_iso()})
    if pick is None:
        return None
    pool.remove(pick)
    sel['tasks'][pick] = rm.pop(pick)
    for key in ('main', 'pilot', 'repeat'):
        sel[key] = sorted(pick if x == failed else x for x in sel[key])
    for arm, ids in sel['arms'].items():
        sel['arms'][arm] = sorted(pick if x == failed else x for x in ids)
    return pick
