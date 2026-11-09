"""Shard plan and run lists for the four runners (design §9, §7.3, §7.6). Offline, stdlib only.

  python3 shardplan.py build --tasks-json <tasks.json> --trials-json <trials.json> --tasks-dir <deep-swe>/tasks \
      [--tiers results/tierpass/strata.json]
  python3 shardplan.py cut --name rep2 --arm C --per-shard 14      # §7.5 checkpoint: C's 2nd run on a subset
  python3 shardplan.py cut --name rep3 --per-shard 10               # or the 3rd A+B run on a subset
  python3 shardplan.py add-pass --name pilot --phase pilot --arms A,F,C,B --pilot-per-shard --tiers results/tierpass/strata.json
  python3 shardplan.py show
  python3 shardplan.py --dataset tb21 build-tb --tasks-dir <tb21>/tasks --tiers <strata.json> --weights <tb-cost-weights.json>

`build` splits the DeepSWE v1.1 tasks into `--shards` shards (4), stratified by language and by public difficulty.
Difficulty is the per-task pass rate at effort high: for each of the planning models (gpt-5-6-sol, gpt-5-6-luna,
gpt-6-astra, mini-swe-agent, 4 attempts each), take the share of scored attempts that passed, then average the
three. Within each language, tasks are sorted by that rate (ties broken by a seeded key) and cut into consecutive
groups of `--shards`. The shards are permuted at random within each group. The partial group left over in each
language (fewer than `--shards` tasks) goes to distinct shards, always the currently smallest ones, largest
leftover groups first. So each shard gets the same number of tasks per language ±1, a matched difficulty profile,
and shard sizes within ±1 (28/28/28/29).

The passes (design §7.6, as amended by 0d), run in this order on every runner over its whole shard:
1. `main`: arms A, F, C, B, rep 1. Its blocks are the shard's tasks sorted, then shuffled with
   `random.Random(seed + shard index)`.
2. `rep2`: arms A, F, C, B, rep 2.
3. `rep3`: arms A, B, rep 3.
A block is one task with its arms in a seeded random order. rep2 and rep3 use a seeded *stratified* block order:
every prefix is a stratified subset by language and difficulty. So the §7.5 checkpoint decision (`cut`: run C's 2nd
run, or the whole 3rd A+B run, on the first N blocks per shard) gives a seeded, stratified subset that was fixed
before any outcome was seen. `add-pass` adds any other list of (task, arm, rep) blocks, such as the pilot
(`--pilot-per-shard`: one typical task per runner, in four different languages; phase pilot, outside the analysis),
`--sample N --from-shard S`, a tier-stratified sample (`--per-shard K --tiers …`) or an explicit list
(`--tasks id,id`). The plan refuses two non-pilot passes with the same (task, arm, rep).

Terminal-Bench 2.1 (`--dataset tb21 build-tb`, TB design §6.1, 0d §7.5–7.9): 89 tasks into 4 shards by category
group (a category with < 4 tasks joins `other`) dealt as above, then seeded same-group swaps that put the two
≥ 7200 s tasks on different runners, ≤ 2 of the 5 costliest tasks (0d's public weights) per runner, ≤ 1 four-CPU,
≤ 2 multi-CPU and ≤ 2 8-GB tasks per runner, hard / ≥ 3600 s / frontier-tier counts ±1, then the most even expected
cost. Passes: pilot (2 per shard, phase pilot), main, rep2, rep3, all arms, each a seeded stratified order by
(tier-pass tier × easy+medium | hard) with the ≥ 7200 s tasks first. The TB plan holds no tiers and no costs (their
input files' sha256 is recorded); image and content digests come from 4f's taskpin.plan_pins.

Committed output, plan.json: task ids, language, difficulty band, shard, and the blocks of each pass. It holds no
task text and no public per-task rates. The rates, costs and balance details go to results/plan-detail.json, which
is gitignored. That file costs B at the public cost of the model its tier-pass tier routes to.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
import re
import sys
import tomllib
from collections import Counter, defaultdict
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
PLAN = HERE / 'plan.json'
DETAIL = HERE / 'results' / 'plan-detail.json'

SEED = 20261105
N_SHARDS = 4
ARMS = ('A', 'F', 'C', 'B')
PHASES = ('pilot', 'main', 'repeat')
PLAN_MODELS = ('gpt-5-6-sol', 'gpt-5-6-luna', 'gpt-6-astra')
PLAN_EFFORT = 'high'
# Public planning cost per run (design §7.1) of the model each arm stands in for. B: see planning_cost (its tier-pass
# model when the tiers are given, else Sol).
ARM_PUBLIC_MODEL = {'A': 'gpt-5-6-sol', 'F': 'gpt-5-6-luna', 'C': 'gpt-6-astra', 'B': 'gpt-5-6-sol'}
DIFFICULTY_BANDS = ('hard', 'mid-hard', 'mid-easy', 'easy')   # quartiles of the public rate, low to high
DEEP_SWE_COMMIT = '0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea'   # datacurve-ai/deep-swe, pinned (73's tier pass used it)
TASK_ID_RE = r'^[a-z0-9][a-z0-9._-]{0,127}$'


class PlanError(ValueError):
    pass


def sha256_file(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def sha256_b64(p: pathlib.Path) -> str:
    """sha256 of a file as unpadded base64url: plan.json carries no 12-digit runs (N5 greps for bare \\d{12})."""
    import base64
    return base64.urlsafe_b64encode(bytes.fromhex(sha256_file(p))).decode().rstrip('=')


def seeded_key(seed: int | str, *parts: str) -> str:
    """A stable pseudo-random sort key (the tie-breaker everywhere; independent of dict or set order)."""
    return hashlib.sha256(':'.join((str(seed), *parts)).encode()).hexdigest()


# ---------------------------------------------------------------- public data

def load_tasks(tasks_json: dict[str, Any]) -> dict[str, str]:
    """task id -> language, from the public tasks.json (`rows`: id, language, ...). Nothing else is kept."""
    out: dict[str, str] = {}
    for r in tasks_json['rows']:
        tid, lang = r['id'], r['language']
        if tid in out:
            raise PlanError(f'duplicate task id {tid}')
        out[tid] = str(lang)
    if int(tasks_json.get('n_tasks', len(out))) != len(out):
        raise PlanError(f"tasks.json says n_tasks={tasks_json.get('n_tasks')} but lists {len(out)}")
    return out


def public_rates(trials_json: dict[str, Any], task_ids: set[str], models: tuple[str, ...] = PLAN_MODELS,
                 effort: str = PLAN_EFFORT) -> dict[str, dict[str, Any]]:
    """Per task: the pass rate of each planning model at `effort` over its scored attempts, their mean (`rate`),
    and the mean public cost per run of each model. Excluded (errored) attempts are left out, as on the
    leaderboard. Every task must have at least one scored attempt of every model."""
    passed: dict[tuple[str, str], list[bool]] = defaultdict(list)
    cost: dict[tuple[str, str], list[float]] = defaultdict(list)
    for r in trials_json['rows']:
        if r.get('model') not in models or r.get('reasoning_effort') != effort or r.get('task_name') not in task_ids:
            continue
        if r.get('included_in_score') is not True:
            continue
        passed[(r['task_name'], r['model'])].append(r.get('passed') is True)
        if isinstance(r.get('cost_usd'), (int, float)):
            cost[(r['task_name'], r['model'])].append(float(r['cost_usd']))
    out: dict[str, dict[str, Any]] = {}
    for t in sorted(task_ids):
        per = {}
        for m in models:
            xs = passed.get((t, m))
            if not xs:
                raise PlanError(f'{t}: no scored public attempt of {m} at effort {effort}')
            per[m] = sum(xs) / len(xs)
        out[t] = {'rate': sum(per.values()) / len(per), 'by_model': per, 'attempts': {m: len(passed[(t, m)]) for m in models},
                  'cost': {m: (sum(cost[(t, m)]) / len(cost[(t, m)]) if cost.get((t, m)) else None) for m in models}}
    return out


def difficulty_band(rate: float, cuts: list[float]) -> str:
    """Quartile band of a rate, given the three cut points (the 25/50/75% quantiles of all tasks' rates)."""
    for band, cut in zip(DIFFICULTY_BANDS, cuts):
        if rate <= cut:
            return band
    return DIFFICULTY_BANDS[-1]


def quantile_cuts(rates: list[float]) -> list[float]:
    s = sorted(rates)
    return [s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))] for q in (0.25, 0.5, 0.75)]


def task_dirs_check(tasks_dir: pathlib.Path, ids: set[str]) -> dict[str, str]:
    """Every task must exist under the pinned deep-swe checkout with a task.toml naming the same task id. Returns
    task id -> the task.toml sha256 as base64url (recorded, so a runner can verify it has the same task files)."""
    out: dict[str, str] = {}
    missing = sorted(t for t in ids if not (tasks_dir / t / 'task.toml').is_file())
    if missing:
        raise PlanError(f'{len(missing)} tasks missing under {tasks_dir}: {missing[:5]}')
    for t in sorted(ids):
        p = tasks_dir / t / 'task.toml'
        meta = tomllib.loads(p.read_text(encoding='utf-8')).get('metadata', {})
        if meta.get('task_id') != t:
            raise PlanError(f'{p}: metadata.task_id is {meta.get("task_id")!r}')
        out[t] = sha256_b64(p)
    return out


# ---------------------------------------------------------------- shards

def assign_shards(tasks: dict[str, str], rates: dict[str, float], n_shards: int = N_SHARDS, seed: int = SEED) -> dict[str, int]:
    """Stratified permuted-group assignment (module docstring). Deterministic for a given seed and input."""
    if n_shards < 1:
        raise PlanError('need at least one shard')
    rng = random.Random(f'{seed}:shards')
    shard_of: dict[str, int] = {}
    size = [0] * n_shards

    def key(t: str) -> tuple[float, str]:
        return (rates[t], seeded_key(seed, 'tie', t))

    def deal(group: list[str]) -> None:
        if len(group) == n_shards:
            perm = list(range(n_shards))
            rng.shuffle(perm)
        else:   # a partial group: the smallest shards, ties at random, in a random task-to-shard order
            perm = sorted(range(n_shards), key=lambda s: (size[s], rng.random()))[:len(group)]
            rng.shuffle(perm)
        for t, s in zip(group, perm):
            shard_of[t] = s
            size[s] += 1

    leftovers: dict[str, list[str]] = {}
    by_lang: dict[str, list[str]] = defaultdict(list)
    for t, lang in tasks.items():
        by_lang[lang].append(t)
    for lang in sorted(by_lang):
        ts = sorted(by_lang[lang], key=key)
        full = len(ts) - len(ts) % n_shards
        for i in range(0, full, n_shards):
            deal(ts[i:i + n_shards])
        if ts[full:]:
            leftovers[lang] = ts[full:]
    # Each language's leftover tasks (fewer than n_shards) go to distinct shards, always the currently smallest
    # ones: per-language counts stay within ±1 and shard sizes within ±1. Largest leftover groups first.
    for lang in sorted(leftovers, key=lambda x: (-len(leftovers[x]), x)):
        deal(leftovers[lang])
    return shard_of


def arm_order(pass_name: str, task: str, arms: tuple[str, ...], seed: int = SEED,
              base_order: tuple[str, ...] = ARMS) -> list[str]:
    """The seeded random launch order of one block's arms (design §7.6). `base_order`: the plan's arm list (a Claude
    Code plan's arm table may add arms; Codex plans use ARMS)."""
    out = sorted(arms, key=lambda a: base_order.index(a))
    random.Random(f'{seed}:{pass_name}:arms:{task}').shuffle(out)
    return out


def block_order(pass_name: str, shard: int, tasks: list[str], seed: int = SEED) -> list[str]:
    """Design §7.6: the main pass shuffles the shard's sorted tasks with random.Random(seed + shard index); any
    other pass uses its own stream (seed + shard index, pass name)."""
    out = sorted(tasks)
    rng = random.Random(seed + shard) if pass_name == 'main' else random.Random(f'{seed + shard}:{pass_name}')  # nosec B105: pass name, not a credential
    rng.shuffle(out)
    return out


def stratified_order(pass_name: str, shard: int, tasks: list[str], strata: dict[str, tuple[str, ...]], seed: int = SEED) -> list[str]:
    """A seeded order in which every prefix is close to proportionally stratified (±1 task per stratum): within
    stratum s (n_s tasks, seeded random order), task j gets the position (j + u_s) / n_s with a seeded u_s in [0, 1),
    and the shard is sorted by position. Used for passes that may be cut to a prefix at the checkpoint (design
    §7.5), so the cut is a seeded stratified subset fixed before any outcome is seen."""
    by: dict[tuple[str, ...], list[str]] = defaultdict(list)
    for t in tasks:
        by[strata[t]].append(t)
    pos: dict[str, tuple[float, str]] = {}
    for st in sorted(by):
        ts = sorted(by[st], key=lambda t: seeded_key(seed + shard, pass_name, 'within', t))
        u = random.Random(f'{seed + shard}:{pass_name}:offset:{"/".join(st)}').random()
        for j, t in enumerate(ts):
            pos[t] = ((j + u) / len(ts), seeded_key(seed + shard, pass_name, 'tie', t))
    return sorted(tasks, key=lambda t: pos[t])


def make_pass(name: str, phase: str, arms: tuple[str, ...], rep: int, tasks_by_shard: dict[int, list[str]],
              seed: int = SEED, ordered: bool = False, note: str = '', order: str = 'random',
              strata: dict[str, tuple[str, ...]] | None = None, first: frozenset[str] | None = None,
              allowed_arms: tuple[str, ...] = ARMS) -> dict[str, Any]:
    """A pass: per shard, the blocks in launch order. `ordered=True` keeps the given task order (a pre-ordered
    sample); otherwise `order` is 'random' (`block_order`) or 'stratified' (`stratified_order` over
    `strata`, for a pass that may be cut to a prefix). `first` (TB anti-tail, 0d): these tasks' blocks move to the
    front of their shard, a stable partition of that order fixed before any outcome."""
    if order not in ('random', 'stratified'):
        raise PlanError(f'order must be random or stratified, not {order!r}')
    if order == 'stratified' and not strata:
        raise PlanError('a stratified order needs the strata')
    if phase not in PHASES:
        raise PlanError(f'phase must be one of {PHASES}')
    if not arms or any(a not in allowed_arms for a in arms) or len(set(arms)) != len(arms):
        raise PlanError(f'arms must be distinct values from {allowed_arms}')
    if rep < 1:
        raise PlanError('rep must be ≥ 1')
    if phase == 'main' and rep != 1:
        raise PlanError('the main pass is rep 1; use phase repeat for rep ≥ 2')
    shards: dict[str, list[dict[str, Any]]] = {}
    for s in sorted(tasks_by_shard):
        if ordered:
            ts = list(tasks_by_shard[s])
        elif order == 'stratified':
            ts = stratified_order(name, s, tasks_by_shard[s], strata or {}, seed)
        else:
            ts = block_order(name, s, tasks_by_shard[s], seed)
        if first:
            ts = [t for t in ts if t in first] + [t for t in ts if t not in first]
        shards[str(s)] = [{'block': i + 1, 'task': t, 'arms': arm_order(name, t, arms, seed, allowed_arms)} for i, t in enumerate(ts)]
    return {'phase': phase, 'arms': list(arms), 'rep': rep, 'note': note, 'order': 'given' if ordered else order, 'cut': None,
            **({'first': sorted(first)} if first else {}),
            'n_trials': sum(len(b['arms']) for bs in shards.values() for b in bs),
            'shards': shards}


def systematic_sample(items: list[str], k: int, seed: int | str) -> list[str]:
    """k items from an ordered list at evenly spaced positions from a seeded random start (implicit
    stratification by the list's sort order)."""
    n = len(items)
    if k > n:
        raise PlanError(f'cannot sample {k} of {n}')
    if k == 0:
        return []
    step = n / k
    start = random.Random(f'{seed}:systematic').random() * step
    return [items[min(n - 1, int(start + j * step))] for j in range(k)]


DEFAULT_PASSES = (
    ('main', 'main', ARMS, 1, 'random', 'all arms, rep 1 (design §7.6: blocks shuffled with seed + shard index)'),
    ('rep2', 'repeat', ARMS, 2, 'stratified', 'all arms, rep 2; C may be cut to a prefix at the §7.5 checkpoint'),
    ('rep3', 'repeat', ('A', 'B'), 3, 'stratified', 'A and B, rep 3; may be cut to a prefix at the §7.5 checkpoint'),
)
TIER_MODEL = {'fast': 'gpt-5-6-luna', 'standard': 'gpt-5-6-sol', 'frontier': 'gpt-6-astra', 'none': 'gpt-5-6-sol'}


def build(tasks_json: dict[str, Any], trials_json: dict[str, Any], *, n_shards: int = N_SHARDS, seed: int = SEED,
          task_toml_sha: dict[str, str] | None = None, inputs: dict[str, Any] | None = None,
          tiers: dict[str, str] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """(plan, detail). The plan is committed; the detail (public rates and costs) stays in results/."""
    tasks = load_tasks(tasks_json)
    pub = public_rates(trials_json, set(tasks))
    rates = {t: pub[t]['rate'] for t in tasks}
    cuts = quantile_cuts(list(rates.values()))
    shard_of = assign_shards(tasks, rates, n_shards, seed)
    by_shard: dict[int, list[str]] = defaultdict(list)
    for t, s in shard_of.items():
        by_shard[s].append(t)
    plan = {
        'schema': 'deepswe-harbor-plan/v1', 'seed': seed, 'n_shards': n_shards,
        'dataset': {'repo': 'datacurve-ai/deep-swe', 'version': 'v1.1', 'commit': DEEP_SWE_COMMIT, 'n_tasks': len(tasks)},
        'stratification': {'language': True, 'difficulty': {'models': list(PLAN_MODELS), 'effort': PLAN_EFFORT,
                                                            'statistic': 'mean over models of the scored pass share',
                                                            'bands': list(DIFFICULTY_BANDS)}},
        'inputs': inputs or {},
        'tasks': {t: {'language': tasks[t], 'difficulty': difficulty_band(rates[t], cuts), 'shard': shard_of[t],
                      **({'task_toml_sha256_b64': task_toml_sha[t]} if task_toml_sha else {})}
                  for t in sorted(tasks)},
        'passes': {},
    }
    strata = task_strata(plan)
    for name, phase, arms, rep, order, note in DEFAULT_PASSES:
        plan['passes'][name] = make_pass(name, phase, arms, rep, by_shard, seed, note=note, order=order, strata=strata)
    detail = {'schema': 'deepswe-harbor-plan-detail/v1', 'cuts': cuts, 'tasks': pub, 'balance': balance(plan, pub, tiers)}
    return plan, detail


def planning_cost(pub: dict[str, dict[str, Any]], task: str, arm: str, tiers: dict[str, str] | None = None) -> float:
    """Public mean cost of one run (κ = 1) of `arm` on `task`. B is costed at the model of the task's tier-pass
    tier when the tiers are known (0d), else as Sol."""
    model = TIER_MODEL.get((tiers or {}).get(task, 'standard'), 'gpt-5-6-sol') if arm == 'B' else ARM_PUBLIC_MODEL[arm]
    v = pub[task]['cost'].get(model)
    return float(v) if v is not None else 0.0


def balance(plan: dict[str, Any], pub: dict[str, dict[str, Any]], tiers: dict[str, str] | None = None) -> dict[str, Any]:
    """Per shard: size, languages, difficulty bands, the mean public rate per model, and the planning cost of one
    run of each arm on every task of the shard (public mean cost × κ = 1; B at its tier-pass model)."""
    out: dict[str, Any] = {}
    for s in range(plan['n_shards']):
        ts = [t for t, m in plan['tasks'].items() if m['shard'] == s]
        cost = {arm: round(sum(planning_cost(pub, t, arm, tiers) for t in ts), 2) for arm in ARMS}
        out[str(s)] = {
            'n': len(ts),
            'language': dict(sorted(Counter(plan['tasks'][t]['language'] for t in ts).items())),
            'difficulty': {b: sum(1 for t in ts if plan['tasks'][t]['difficulty'] == b) for b in DIFFICULTY_BANDS},
            'mean_rate': round(sum(pub[t]['rate'] for t in ts) / len(ts), 4) if ts else None,
            'mean_rate_by_model': {m: round(sum(pub[t]['by_model'][m] for t in ts) / len(ts), 4) for m in PLAN_MODELS} if ts else {},
            'public_cost_usd_one_pass': cost,
            'b_costed_by': 'tier-pass tier' if tiers else 'Sol (no tiers given)',
        }
    out['all'] = {'n': len(plan['tasks']), 'public_cost_usd_one_pass': {a: round(sum(v['public_cost_usd_one_pass'][a] for v in out.values()), 2) for a in ARMS}}
    return out


# ---------------------------------------------------------------- extra passes

def shard_tasks(plan: dict[str, Any]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {s: [] for s in range(plan['n_shards'])}
    for t, m in plan['tasks'].items():
        out[m['shard']].append(t)
    return out


def load_tiers(path: pathlib.Path, field: str = 'pred_tier') -> dict[str, str]:
    """Task → tier-pass tier: 73's strata.json (`tasks.<id>.stratum`: the majority over the tier-pass reps) or a
    tier-pass jsonl (`field` per row)."""
    text = path.read_text(encoding='utf-8')
    try:
        doc = json.loads(text)
    except ValueError:
        doc = None
    if isinstance(doc, dict) and isinstance(doc.get('tasks'), dict):
        return {t: str(v.get('stratum') or 'none') for t, v in doc['tasks'].items()}
    return tier_of([json.loads(x) for x in text.splitlines() if x.strip()], field)


def tier_of(rows: list[dict[str, Any]], field: str = 'pred_tier') -> dict[str, str]:
    out = {}
    for r in rows:
        if isinstance(r.get('task_id'), str):
            out[r['task_id']] = str(r.get(field) or 'none')
    return out


def tier_sample(plan: dict[str, Any], tiers: dict[str, str], per_shard: int, seed: int = SEED, name: str = 'sample') -> dict[int, list[str]]:
    """`per_shard` tasks of each shard, stratified by tier-pass tier and language (a systematic
    sample of the shard sorted by tier, language and a seeded key). The order of the result is the sample's own
    seeded order, which is also its run order."""
    out: dict[int, list[str]] = {}
    for s, ts in shard_tasks(plan).items():
        missing = [t for t in ts if t not in tiers]
        if missing:
            raise PlanError(f'shard {s}: {len(missing)} tasks have no tier-pass tier (e.g. {missing[:3]})')
        ordered = sorted(ts, key=lambda t: (tiers[t], plan['tasks'][t]['language'], seeded_key(seed, name, t)))
        picked = systematic_sample(ordered, per_shard, f'{seed + s}:{name}')
        out[s] = sorted(picked, key=lambda t: seeded_key(seed + s, name, 'order', t))
    return out


PILOT_LANGUAGE_ORDER = ('go', 'python', 'typescript', 'javascript', 'rust')


def pilot_sample(plan: dict[str, Any], pub: dict[str, dict[str, Any]], tiers: dict[str, str] | None = None,
                 seed: int = SEED, band: tuple[float, float] = (0.25, 0.5)) -> dict[int, list[str]]:
    """The pilot (design P3, §7.4: outside the analysis): one task per shard, so every runner runs it, each in a
    different language. Languages go to shards in a seeded order, the most common languages first. Within its
    (shard, language), the task is a seeded pick among those whose planning cost of one block (A+F+C+B, B at its
    tier-pass model) lies between the 25th and 50th percentile over all tasks: typical rather than extreme, and
    below the median to fit the pilot cap. If none lies there, the task nearest that range."""
    block_cost = {t: sum(planning_cost(pub, t, a, tiers) for a in ARMS) for t in plan['tasks']}
    cs = sorted(block_cost.values())
    lo, hi = (cs[min(len(cs) - 1, int(q * (len(cs) - 1)))] for q in band)
    shards = list(range(plan['n_shards']))
    random.Random(f'{seed}:pilot:shards').shuffle(shards)
    used: set[str] = set()
    out: dict[int, list[str]] = {}
    for s in shards:
        mine = shard_tasks(plan)[s]
        langs = [lg for lg in PILOT_LANGUAGE_ORDER if lg not in used and any(plan['tasks'][t]['language'] == lg for t in mine)]
        langs += sorted({plan['tasks'][t]['language'] for t in mine} - set(PILOT_LANGUAGE_ORDER) - used)
        if not langs:
            raise PlanError(f'shard {s}: no language left for a distinct-language pilot')
        lg = langs[0]
        used.add(lg)
        cand = sorted((t for t in mine if plan['tasks'][t]['language'] == lg), key=lambda t: seeded_key(seed, 'pilot', t))
        inside = [t for t in cand if lo <= block_cost[t] <= hi]
        pick = inside[0] if inside else min(cand, key=lambda t: (min(abs(block_cost[t] - lo), abs(block_cost[t] - hi)), seeded_key(seed, 'pilot', t)))
        out[s] = [pick]
    return dict(sorted(out.items()))


def sample_tasks(plan: dict[str, Any], n: int, from_shard: int, seed: int = SEED, name: str = 'pilot') -> dict[int, list[str]]:
    """n tasks of one shard, spread over difficulty (a systematic sample of the shard sorted by public band)."""
    ts = shard_tasks(plan)[from_shard]
    ordered = sorted(ts, key=lambda t: (DIFFICULTY_BANDS.index(plan['tasks'][t]['difficulty']), seeded_key(seed, name, t)))
    return {from_shard: systematic_sample(ordered, n, f'{seed}:{name}')}


def task_strata(plan: dict[str, Any], tiers: dict[str, str] | None = None) -> dict[str, tuple[str, ...]]:
    """(language, difficulty band) per task: the plan's stratification. A TB plan: (tier-pass tier, easy+medium or
    hard); its tiers are not in the committed plan, so they must be given (73's strata.json)."""
    if plan.get('schema') == TB_SCHEMA or (plan.get('dataset') or {}).get('base') == 'tb21':
        if tiers is None and plan.get('schema') == CC_SCHEMA:   # no tier pass (pinned arms only): category group × difficulty
            return {t: (str(m.get('group') or 'other'), tb_difficulty2(m['difficulty'])) for t, m in plan['tasks'].items()}
        if tiers is None:
            raise PlanError('a TB plan is stratified by the tier-pass tiers: pass --tiers <strata.json>')
        return tb_strata(plan['tasks'], tiers)
    return {t: (m['language'], m['difficulty']) for t, m in plan['tasks'].items()}


def add_pass(plan: dict[str, Any], name: str, phase: str, arms: tuple[str, ...], rep: int,
             tasks_by_shard: dict[int, list[str]], ordered: bool, note: str = '', replace: bool = False,
             order: str = 'random', tiers: dict[str, str] | None = None) -> dict[str, Any]:
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', name):
        raise PlanError('pass name: lowercase letters, digits and dashes, starting with a letter')
    if name in plan['passes'] and not replace:
        raise PlanError(f'pass {name!r} exists (use --replace)')
    for s, ts in tasks_by_shard.items():
        for t in ts:
            if plan['tasks'].get(t, {}).get('shard') != s:
                raise PlanError(f'{t} is not a task of shard {s}')
    taken = {(t, a, p['rep']) for pn, p in plan['passes'].items() if pn != name
             for bs in p['shards'].values() for b in bs for a in b['arms']}
    clash = sorted({(t, a) for ts in tasks_by_shard.values() for t in ts for a in arms if (t, a, rep) in taken})
    if clash and phase != 'pilot':
        raise PlanError(f'{len(clash)} (task, arm) pairs already have rep {rep} in another pass, e.g. {clash[:3]}')
    strata = task_strata(plan, tiers) if (order == 'stratified' or plan.get('schema') != TB_SCHEMA) else None
    plan['passes'][name] = make_pass(name, phase, arms, rep, tasks_by_shard, plan['seed'], ordered=ordered, note=note,
                                     order=order, strata=strata, first=tb_first(plan) if plan.get('schema') == TB_SCHEMA else None)
    return plan


def cut_pass(plan: dict[str, Any], name: str, per_shard: int | None, note: str, arms: tuple[str, ...] | None = None) -> dict[str, Any]:
    """Design §7.5 checkpoint: keep `arms` (default: every arm of the pass) only in the first `per_shard` blocks of
    each shard of a pass; later blocks run without them (a block left with no arm is dropped). None removes the
    cut. The block order was fixed when the pass was added, so the subset is seeded and fixed before any outcome of
    the pass is seen; a stratified-order pass gives a stratified subset."""
    if name not in plan['passes']:
        raise PlanError(f'no pass {name!r}')
    if name == 'main':
        raise PlanError('the main pass is never cut (a cap stop truncates it instead)')
    if per_shard is not None and per_shard < 0:
        raise PlanError('per_shard must be ≥ 0')
    if arms and any(a not in plan['passes'][name]['arms'] for a in arms):
        raise PlanError(f"arms {arms} are not all arms of pass {name} ({plan['passes'][name]['arms']})")
    plan['passes'][name]['cut'] = None if per_shard is None else {'per_shard': per_shard, 'arms': list(arms) if arms else None, 'note': note}
    return plan


def trials_of(plan: dict[str, Any], pass_name: str, shard: int) -> list[dict[str, Any]]:
    """The flat launch list of one shard's pass: (block, task, arm, rep, phase) in order."""
    return [{'pass': pass_name, 'phase': plan['passes'][pass_name]['phase'], 'block': b['block'], 'task': b['task'], 'arm': a,
             'rep': plan['passes'][pass_name]['rep']} for b in blocks_of(plan, pass_name, shard) for a in b['arms']]


def blocks_of(plan: dict[str, Any], pass_name: str, shard: int) -> list[dict[str, Any]]:
    """The blocks of one shard's pass in launch order, after the pass's cut (if any)."""
    p = plan['passes'][pass_name]
    bs = p['shards'].get(str(shard), [])
    cut = p.get('cut') or {}
    if cut.get('per_shard') is None:
        return bs
    k, arms = int(cut['per_shard']), cut.get('arms')
    if not arms:
        return bs[:k]
    out = list(bs[:k])
    for b in bs[k:]:
        rest = [a for a in b['arms'] if a not in arms]
        if rest:
            out.append({**b, 'arms': rest})
    return out


# ---------------------------------------------------------------- Terminal-Bench 2.1 (TB design §6.1, §7.5–7.9)

TB_SCHEMA = 'tbench-harbor-plan/v1'
CC_SCHEMA = 'cc-harbor-plan/v1'
PLAN_SCHEMAS = ('deepswe-harbor-plan/v1', TB_SCHEMA, CC_SCHEMA)
TB_STRATA_SCHEMA = 'tbench-harbor-strata/v1'
TB_WEIGHTS_SCHEMA = 'tb-cost-weights/v1'
TB_SEED = 20261106
# harbor-framework/terminal-bench-2-1, pinned (PRD). Unpadded base64url of the 20-byte commit: the hex form has a
# bare 12-digit run (N5); commit_hex() decodes it.
TB_COMMIT_B64 = 'ErdWVnnOUAYjC4IGZjU2c6Ez25M'
TB_GROUP_MIN = 4               # a category with fewer tasks joins `other`
TB_FIRST_S = 7200.0            # anti-tail (0d): blocks of tasks with agent timeout ≥ this go first in every pass
TB_LONG_S = 3600.0
TB_TOP_COST = 5                # the costliest tasks (public weight) spread ≤ 2 per shard (§7.6)
TB_PASSES = (('main', 'main', 1, 'all arms, rep 1; stratified (tier × easy+medium/hard), long tasks first'),
             ('rep2', 'repeat', 2, 'all arms, rep 2; stratified, long tasks first'),
             ('rep3', 'repeat', 3, 'all arms, rep 3; stratified, long tasks first'))
# §7.9 planning: DeepSWE's measured mean cost per run of each pinned model (s = 1), scaled per task by the public
# relative weight (mean 1). B is costed at the model of its tier-pass tier (TIER_MODEL).
TB_MODEL_RUN_USD = {'gpt-5-6-sol': 0.72, 'gpt-5-6-luna': 0.13, 'gpt-6-astra': 4.42}
_LABEL = re.compile(r'[a-z0-9][a-z0-9+-]{0,40}')


def commit_hex(plan: dict[str, Any]) -> str:
    """The dataset commit as 40 hex: DeepSWE stores it as is; TB as base64url (`commit_b64`)."""
    ds = plan.get('dataset') or {}
    if ds.get('commit'):
        return str(ds['commit'])
    import base64
    raw = base64.urlsafe_b64decode(str(ds['commit_b64']) + '=' * (-len(str(ds['commit_b64'])) % 4))
    if len(raw) != 20:
        raise PlanError('dataset.commit_b64 is not a 20-byte commit')
    return raw.hex()


def tb_task_meta(task_dir: pathlib.Path) -> dict[str, Any]:
    """Labels and numbers of one TB task (task.toml), never text."""
    cfg = tomllib.loads((task_dir / 'task.toml').read_text(encoding='utf-8'))
    md, env = cfg.get('metadata') or {}, cfg.get('environment') or {}
    name = str((cfg.get('task') or {}).get('name') or '')
    if name != f'terminal-bench/{task_dir.name}':
        raise PlanError(f'{task_dir.name}: task.name is {name!r}')
    out: dict[str, Any] = {}
    for k in ('category', 'difficulty'):
        v = md.get(k)
        if not isinstance(v, str) or not _LABEL.fullmatch(v):
            raise PlanError(f'{task_dir.name}: metadata.{k} is not a label')
        out[k] = v
    for k, sec, key in (('agent_timeout_s', 'agent', 'timeout_sec'), ('verifier_timeout_s', 'verifier', 'timeout_sec'),
                        ('build_timeout_s', 'environment', 'build_timeout_sec'), ('cpus', 'environment', 'cpus'),
                        ('memory_mb', 'environment', 'memory_mb')):
        v = (cfg.get(sec) or {}).get(key)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
            raise PlanError(f'{task_dir.name}: {sec}.{key} missing')
        out[k] = int(v) if float(v).is_integer() else float(v)
    if env.get('allow_internet') is not True:
        raise PlanError(f'{task_dir.name}: allow_internet is not true (the TB design assumes it for every task)')
    return out


def tb_groups(meta: dict[str, dict[str, Any]], min_n: int = TB_GROUP_MIN) -> dict[str, str]:
    n = Counter(m['category'] for m in meta.values())
    return {t: (m['category'] if n[m['category']] >= min_n else 'other') for t, m in meta.items()}


def tb_difficulty2(difficulty: str) -> str:
    """§7.8: easy (4 tasks) is merged with medium."""
    return 'hard' if difficulty == 'hard' else 'easy+medium'


def tb_strata(tasks: dict[str, dict[str, Any]], tiers: dict[str, str]) -> dict[str, tuple[str, ...]]:
    """§7.6/7.8 block-order strata: (tier-pass tier, easy+medium or hard)."""
    missing = sorted(t for t in tasks if t not in tiers)
    if missing:
        raise PlanError(f'{len(missing)} tasks have no tier-pass tier (e.g. {missing[:3]})')
    return {t: (tiers[t], tb_difficulty2(m['difficulty'])) for t, m in tasks.items()}


def tb_first(plan: dict[str, Any]) -> frozenset[str]:
    return frozenset(t for t, m in plan['tasks'].items() if float(m['agent_timeout_s']) >= TB_FIRST_S)


def load_tb_strata(path: pathlib.Path) -> dict[str, str]:
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema') != TB_STRATA_SCHEMA:
        raise PlanError(f'{path.name}: schema {doc.get("schema")!r}, expected {TB_STRATA_SCHEMA}')
    return load_tiers(path)


def load_tb_weights(path: pathlib.Path) -> dict[str, float]:
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema') != TB_WEIGHTS_SCHEMA:
        raise PlanError(f'{path.name}: schema {doc.get("schema")!r}, expected {TB_WEIGHTS_SCHEMA}')
    w = {str(k): float(v) for k, v in doc['weights'].items()}
    if any(v <= 0 for v in w.values()):
        raise PlanError('cost weights must be positive')
    return w


def tb_profile(meta: dict[str, dict[str, Any]], shard_of: dict[str, int], weights: dict[str, float], tiers: dict[str, str],
               n_shards: int) -> list[dict[str, Any]]:
    """Per shard, the counts the TB assignment balances."""
    top = set(sorted(meta, key=lambda t: (-weights[t], t))[:TB_TOP_COST])
    out = []
    for s in range(n_shards):
        ts = [t for t in meta if shard_of[t] == s]
        out.append({
            'n': len(ts), 'hard': sum(meta[t]['difficulty'] == 'hard' for t in ts),
            'frontier': sum(tiers[t] == 'frontier' for t in ts), 'long': sum(meta[t]['agent_timeout_s'] >= TB_LONG_S for t in ts),
            'first': sum(meta[t]['agent_timeout_s'] >= TB_FIRST_S for t in ts), 'top_cost': sum(t in top for t in ts),
            'cpu4': sum(meta[t]['cpus'] >= 4 for t in ts), 'multi_cpu': sum(meta[t]['cpus'] >= 2 for t in ts),
            'mem8': sum(meta[t]['memory_mb'] >= 8192 for t in ts), 'cost_weight': round(sum(weights[t] for t in ts), 6),
            'agent_timeout_h': round(sum(meta[t]['agent_timeout_s'] for t in ts) / 3600, 6)})
    return out


def tb_objective(prof: list[dict[str, Any]]) -> tuple[float, ...]:
    """Lexicographic (§6.1): the hard limits first, then the ±1 balances, then the cost and timeout ranges."""
    def over(k: str, cap: int) -> int:
        return sum(max(0, x[k] - cap) for x in prof)

    def spread(k: str) -> float:
        return max(x[k] for x in prof) - min(x[k] for x in prof)
    return (over('first', 1), over('top_cost', 2), over('cpu4', 1) + over('multi_cpu', 2) + over('mem8', 2),
            sum(max(0, spread(k) - 1) for k in ('hard', 'long', 'frontier')), round(spread('cost_weight'), 6),
            round(spread('agent_timeout_h'), 6))


def assign_tb_shards(meta: dict[str, dict[str, Any]], weights: dict[str, float], tiers: dict[str, str],
                     n_shards: int = N_SHARDS, seed: int = TB_SEED) -> dict[str, int]:
    """§6.1: (1) the category deal of `assign_shards` with groups in place of languages, each group sorted by
    (difficulty, cost weight descending, agent timeout descending, seeded tie): shard sizes ±1, groups ±1 per shard;
    (2) seeded hill-climbing over swaps of two same-group tasks in different shards (which keeps (1)), minimising
    `tb_objective`. Deterministic for a given seed and input."""
    groups = tb_groups(meta)
    rank = {'hard': 0, 'medium': 1, 'easy': 2}
    key = {t: (rank.get(m['difficulty'], 3), -weights[t], -m['agent_timeout_s']) for t, m in meta.items()}

    shard_of = assign_shards(groups, key, n_shards, seed)   # type: ignore[arg-type]  # sorts by (key[t], seeded tie)
    order = sorted(meta, key=lambda t: seeded_key(seed, 'swap', t))
    best = tb_objective(tb_profile(meta, shard_of, weights, tiers, n_shards))
    improved = True
    while improved:
        improved = False
        for i, a in enumerate(order):
            for b in order[i + 1:]:
                if groups[a] != groups[b] or shard_of[a] == shard_of[b]:
                    continue
                shard_of[a], shard_of[b] = shard_of[b], shard_of[a]
                j = tb_objective(tb_profile(meta, shard_of, weights, tiers, n_shards))
                if j < best:
                    best, improved = j, True
                else:
                    shard_of[a], shard_of[b] = shard_of[b], shard_of[a]
    return shard_of


def tb_pilot(plan_tasks: dict[str, dict[str, Any]], tiers: dict[str, str], n_shards: int, seed: int = TB_SEED) -> dict[int, list[str]]:
    """The pilot (0d: 2 tasks per shard, 32 runs, an 8-slot load test, no task ≥ 7200 s, ≥ 1 multi-CPU task):
    pick 1, seeded: standard tier, 1 CPU, 2 GB, agent timeout ≤ 900 s, medium, groups distinct across shards (the
    largest groups first); pick 2, seeded: frontier tier (prices B's frontier routing), ≤ 1800 s, another group than
    pick 1. The multi-CPU task with the shortest agent timeout replaces pick 2 on its shard."""
    by_size = sorted(Counter(m['group'] for m in plan_tasks.values()).items(), key=lambda x: (-x[1], x[0]))
    used: set[str] = set()
    picks: dict[int, list[str]] = {}
    for s in range(n_shards):
        cand = [t for t, m in plan_tasks.items() if m['shard'] == s and tiers[t] == 'standard' and m['cpus'] == 1
                and m['memory_mb'] == 2048 and m['agent_timeout_s'] <= 900 and m['difficulty'] == 'medium']
        for g, _ in by_size:
            cs = sorted((t for t in cand if plan_tasks[t]['group'] == g and g not in used), key=lambda t: seeded_key(seed, 'pilot', t))
            if cs:
                picks[s] = [cs[0]]
                used.add(g)
                break
        else:
            raise PlanError(f'shard {s}: no typical standard-tier task for pilot pick 1')
    multi = min((t for t, m in plan_tasks.items() if m['cpus'] >= 2 and m['agent_timeout_s'] < TB_FIRST_S),
                key=lambda t: (plan_tasks[t]['agent_timeout_s'], t))
    for s in range(n_shards):
        if plan_tasks[multi]['shard'] == s:
            picks[s].append(multi)
            continue
        g1 = plan_tasks[picks[s][0]]['group']
        cs = sorted((t for t, m in plan_tasks.items() if m['shard'] == s and tiers[t] == 'frontier' and m['agent_timeout_s'] <= 1800
                     and m['group'] != g1), key=lambda t: seeded_key(seed, 'pilot2', t))
        if not cs:
            raise PlanError(f'shard {s}: no frontier-tier task for pilot pick 2')
        picks[s].append(cs[0])
    return picks


def build_tb(tasks_dir: pathlib.Path, *, tiers: dict[str, str], weights: dict[str, float], pins: dict[str, dict[str, Any]],
             n_shards: int = N_SHARDS, seed: int = TB_SEED, inputs: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """(plan, detail) for Terminal-Bench 2.1. The plan (committed) holds ids, labels, timeouts, resources, shards,
    digests and blocks: no task text, no tier-pass tiers and no public costs (those stay in the gitignored detail and
    their inputs' sha256 is recorded). `pins` comes from 4f's taskpin.plan_pins (content and image digests)."""
    ids = sorted(p.name for p in tasks_dir.iterdir() if p.is_dir() and (p / 'task.toml').is_file())
    meta = {t: tb_task_meta(tasks_dir / t) for t in ids}
    for what, d in (('tier', tiers), ('cost weight', weights), ('pin', pins)):
        missing = sorted(set(ids) - set(d))
        if missing:
            raise PlanError(f'{len(missing)} tasks have no {what} (e.g. {missing[:3]})')
    shard_of = assign_tb_shards(meta, weights, tiers, n_shards, seed)
    groups = tb_groups(meta)
    tasks = {t: {'group': groups[t], **meta[t], 'shard': shard_of[t],
                 **{k: pins[t][k] for k in ('digest_b64', 'image', 'image_digest_b64', 'image_bytes')}} for t in ids}
    plan: dict[str, Any] = {
        'schema': TB_SCHEMA, 'seed': seed, 'n_shards': n_shards,
        'dataset': {'name': 'tb21', 'repo': 'harbor-framework/terminal-bench-2-1', 'version': '2.1', 'commit_b64': TB_COMMIT_B64,
                    'n_tasks': len(ids)},
        'stratification': {'shards': 'category groups ±1, then the §6.1 objective (seeded swaps)',
                           'blocks': 'tier-pass tier × (easy+medium | hard), seeded stratified order; agent timeout ≥ 7200 s first'},
        'inputs': inputs or {}, 'tasks': tasks, 'passes': {}}
    strata = tb_strata(tasks, tiers)
    first = tb_first(plan)
    by_shard: dict[int, list[str]] = defaultdict(list)
    for t in ids:
        by_shard[shard_of[t]].append(t)
    pilot = tb_pilot(tasks, tiers, n_shards, seed)
    plan['passes']['pilot'] = make_pass('pilot', 'pilot', ARMS, 1, pilot, seed, ordered=True,
                                        note='2 tasks per shard (0d): an 8-slot load test, frontier-tier pick 2; outside the analysis')
    for name, phase, rep, note in TB_PASSES:
        plan['passes'][name] = make_pass(name, phase, ARMS, rep, by_shard, seed, note=note, order='stratified', strata=strata, first=first)
    cost = {t: {m: round(weights[t] * usd, 6) for m, usd in TB_MODEL_RUN_USD.items()} for t in ids}
    detail = {'schema': 'tbench-harbor-plan-detail/v1', 'model_run_usd': TB_MODEL_RUN_USD,
              'tasks': {t: {'weight': weights[t], 'tier': tiers[t], 'cost': cost[t]} for t in ids},
              'balance': {str(s): x for s, x in enumerate(tb_profile(meta, shard_of, weights, tiers, n_shards))},
              'objective': list(tb_objective(tb_profile(meta, shard_of, weights, tiers, n_shards))),
              'pilot': {str(s): ts for s, ts in pilot.items()}}
    detail['pilot_planning_usd'] = round(sum(planning_cost(detail['tasks'], t, a, tiers) for ts in pilot.values() for t in ts for a in ARMS), 2)
    return plan, detail


def max_run_usd(plan: dict[str, Any], detail: dict[str, Any], passes: list[str], shard: int | None = None,
                tiers: dict[str, str] | None = None) -> float:
    """The largest planning cost of a single run among the listed passes (0d's pre-flight: the proxy reserve must
    stay below hard cap − this)."""
    best = 0.0
    for p in passes:
        for s in ([shard] if shard is not None else range(plan['n_shards'])):
            for it in trials_of(plan, p, s):
                best = max(best, planning_cost(detail['tasks'], it['task'], it['arm'], tiers))
    return round(best, 4)


# ---------------------------------------------------------------- Claude Code × Harbor (CC design §1.2, §2.3)

CC_SEED = 20261107
CC_ARMS_SCHEMA = 'cc-arms/v1'
CC_PASSES = (('main', 'main', 1, 'stage 1: all arms, rep 1; stratified, long tasks first'),
             ('rep2', 'repeat', 2, 'stage 2: all arms, rep 2; stratified, long tasks first'),
             ('rep3', 'repeat', 3, 'stage 2: all arms, rep 3; stratified, long tasks first'))
CC_PILOT_QUANTILES = (0.25, 0.75)      # pilot picks per shard: near these quantiles of the Codex-measured task cost
CC_SCANNER_CAL_N = 2                   # TB: scanner-v2 calibration tasks in the pilot (0d §10), a seeded draw
_ARM_RE = re.compile(r'[A-Z][A-Z0-9]{0,7}')
_HINT_RE = re.compile(r'[a-z]+=[A-Za-z0-9._:;=-]{1,120}')
ARM_FIELDS = ('client_model', 'main_model', 'hint', 'pack', 'worst_model', 'codex_ref', 'planning_usd')


def load_arms(path: pathlib.Path) -> tuple[list[str], dict[str, dict[str, Any]]]:
    """The data-driven arm table (experiments/claude-code-harbor/arms.json): `order` and per arm the client's model
    (ANTHROPIC_MODEL), the model serving the main loop ('auto' for an assessor arm: 4f's proxy rewrites the client
    model to auto), the router hint the proxy stamps (None for every Claude Code arm: a pin hint would pin helper calls
    too), the assessor pack (None: none), the CapLedger's worst-case model, the Codex arm whose measured costs it is paired with for κ, and 0d's
    planning cost per run (m = 1) per benchmark, which gives the prior κ before the pilot. Adding an arm before stage 1
    is an edit of this file; derive freezes it into the plan (its sha covers it)."""
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema') != CC_ARMS_SCHEMA:
        raise PlanError(f'{path.name}: schema {doc.get("schema")!r}, expected {CC_ARMS_SCHEMA}')
    order, arms = list(doc.get('order') or []), doc.get('arms') or {}
    if sorted(order) != sorted(arms) or len(set(order)) != len(order) or not order:
        raise PlanError('arms: `order` must list every arm exactly once')
    for k, v in arms.items():
        if not _ARM_RE.fullmatch(k):
            raise PlanError(f'arm letter {k!r}')
        for f in ('client_model', 'main_model', 'worst_model'):
            if not isinstance(v.get(f), str) or not v[f]:
                raise PlanError(f'arm {k}: {f} required')
        if v.get('hint') is not None and not _HINT_RE.fullmatch(str(v['hint'])):
            raise PlanError(f'arm {k}: hint {v.get("hint")!r}')
        if v.get('codex_ref') not in ARMS:
            raise PlanError(f'arm {k}: codex_ref must be one of {ARMS}')
        pu = v.get('planning_usd')
        if not isinstance(pu, dict) or not pu or not all(b in ('deepswe', 'tb21') and isinstance(x, (int, float)) and x > 0 for b, x in pu.items()):
            raise PlanError(f'arm {k}: planning_usd must map deepswe/tb21 to a positive per-run cost (0d planning numbers, m = 1)')
    return order, {k: {f: arms[k].get(f) for f in ARM_FIELDS} for k in order}


def load_drops(path: pathlib.Path | None) -> set[str]:
    """The pre-registered drop list: a JSON list of task ids, or a merged checks.json (`dropped`)."""
    if path is None:
        return set()
    doc = json.loads(path.read_text(encoding='utf-8'))
    ids = doc.get('dropped') if isinstance(doc, dict) else doc
    if not isinstance(ids, list):
        raise PlanError(f'{path.name}: no drop list')
    return {str(t) for t in ids}


def codex_task_costs(attempts_path: pathlib.Path, field: str = 'spent_usd') -> dict[str, dict[str, float]]:
    """Per task and Codex arm: the mean ledger cost (or `field`, e.g. wall_s) of its scored main/repeat runs (our own
    measured data, kept in the gitignored plan detail; the committed plan records only the input's sha256)."""
    acc: dict[tuple[str, str], list[float]] = defaultdict(list)
    for line in attempts_path.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get('phase') in ('main', 'repeat') and r.get('class') in ('agent', 'sut') and r.get('final_status') == 'scored' and r.get('is_final'):
            acc[(str(r['task']), str(r['arm']))].append(float(r.get(field) or 0.0))
    out: dict[str, dict[str, float]] = defaultdict(dict)
    for (t, arm), xs in acc.items():
        out[t][arm] = round(sum(xs) / len(xs), 6)
    return dict(out)


def cc_scanner_cal(tasks: dict[str, dict[str, Any]], scanner_pool: list[str] | None, seed: int = CC_SEED) -> list[str]:
    """TB (0d §10): a seeded draw of CC_SCANNER_CAL_N kept tasks from `scanner_pool`, labelled 'scanner-cal' in the pilot."""
    if not scanner_pool:
        return []
    pool = sorted(t for t in scanner_pool if t in tasks)
    if len(pool) < CC_SCANNER_CAL_N:
        raise PlanError(f'scanner-cal: only {len(pool)} of the pool are kept tasks')
    return sorted(random.Random(f'{seed}:scanner-cal').sample(pool, CC_SCANNER_CAL_N))


def cc_pilot(tasks: dict[str, dict[str, Any]], n_shards: int, costs: dict[str, dict[str, float]], seed: int = CC_SEED,
             long_s: float = TB_FIRST_S, scanner_pool: list[str] | None = None) -> dict[int, list[str]]:
    """CC design §2.3 (0d §10): per shard, the tasks nearest the 25th and 75th percentile of the Codex-measured mean
    cost over arms (ties broken by a seeded key), among tasks under the long-task threshold; TB adds the scanner-cal
    draw (cc_scanner_cal), each task on its own shard (not added twice if it is already a pick). Outcome-blind: costs
    only."""
    out: dict[int, list[str]] = {}
    for s in range(n_shards):
        mine = [t for t, m in tasks.items() if m['shard'] == s and float(m.get('agent_timeout_s') or 0) < long_s and costs.get(t)]
        mine.sort(key=lambda t: (sum(costs[t].values()) / len(costs[t]), seeded_key(seed, 'cc-pilot', t)))
        if len(mine) < len(CC_PILOT_QUANTILES):
            raise PlanError(f'shard {s}: fewer than {len(CC_PILOT_QUANTILES)} tasks with Codex costs')
        picks: list[str] = []
        for q in CC_PILOT_QUANTILES:
            i = min(len(mine) - 1, max(0, round(q * (len(mine) - 1))))
            while mine[i] in picks:
                i = min(len(mine) - 1, i + 1)
            picks.append(mine[i])
        out[s] = picks
    for t in cc_scanner_cal(tasks, scanner_pool, seed):
        if t not in out[tasks[t]['shard']]:
            out[tasks[t]['shard']].append(t)
    return out


def derive_cc(codex_plan: dict[str, Any], *, name: str, base: str, order: list[str], arms: dict[str, dict[str, Any]],
              drops: set[str], costs: dict[str, dict[str, float]], tiers: dict[str, str] | None = None, seed: int = CC_SEED,
              scanner_pool: list[str] | None = None, inputs: dict[str, Any] | None = None,
              walls: dict[str, dict[str, float]] | None = None, passes: tuple[str, ...] = ('main', 'rep2', 'rep3')
              ) -> tuple[dict[str, Any], dict[str, Any]]:
    """(plan, detail) for one Claude Code benchmark: the Codex plan's tasks, shards and pins minus the pre-registered
    drops; the arm table; passes pilot, main (rep 1: stage 1), rep2 and rep3 (stage 2), every arm in each, seeded
    stratified block order with the ≥ 7200 s tasks first (TB). Stage 2 is a pure continuation of stage 1: the same
    file, the same blocks."""
    if base not in ('deepswe', 'tb21'):
        raise PlanError(f'base {base!r}')
    unknown = sorted(drops - set(codex_plan['tasks']))
    if unknown:
        raise PlanError(f'drop list names tasks not in the Codex plan: {unknown[:3]}')
    tasks = {t: dict(m) for t, m in sorted(codex_plan['tasks'].items()) if t not in drops}
    ds = codex_plan.get('dataset') or {}
    plan: dict[str, Any] = {
        'schema': CC_SCHEMA, 'seed': seed, 'n_shards': codex_plan['n_shards'],
        'dataset': {'name': name, 'base': base, 'agent': 'claude-code',
                    **{k: ds[k] for k in ('repo', 'version', 'commit', 'commit_b64') if k in ds}, 'n_tasks': len(tasks),
                    'dropped': sorted(drops)},
        'arm_order': list(order), 'arms': arms,
        'stratification': {'shards': "the Codex plan's", 'blocks': (('tier-pass tier' if tiers else 'category group') + ' × (easy+medium | hard)'
                                                                   if base == 'tb21' else 'language × difficulty band') + '; seeded stratified order'
                           + ('; agent timeout ≥ 7200 s first' if base == 'tb21' else '')},
        'inputs': inputs or {}, 'tasks': tasks, 'passes': {}}
    strata = task_strata(plan, tiers)
    first = tb_first(plan) if base == 'tb21' else None
    by_shard: dict[int, list[str]] = defaultdict(list)
    for t, m in tasks.items():
        by_shard[m['shard']].append(t)
    allowed = tuple(order)
    pool = scanner_pool if base == 'tb21' else None
    pilot = cc_pilot(tasks, plan['n_shards'], costs, seed, scanner_pool=pool)
    plan['passes']['pilot'] = make_pass('pilot', 'pilot', allowed, 1, pilot, seed, ordered=True, allowed_arms=allowed,
                                        note='stage 1 first slice: calibration (cost, κ, timing, 429s, memory/OOM, helper share); outside the analysis')
    scanner = cc_scanner_cal(tasks, pool, seed)
    if scanner:
        plan['passes']['pilot']['labels'] = {'scanner-cal': scanner}
    unknown_p = sorted(set(passes) - {x[0] for x in CC_PASSES})
    if unknown_p:
        raise PlanError(f'passes {unknown_p}: one of main, rep2, rep3')
    for pname, phase, rep, note in CC_PASSES:
        if pname not in passes:
            continue
        plan['passes'][pname] = make_pass(pname, phase, allowed, rep, dict(by_shard), seed, note=note, order='stratified', strata=strata,
                                          first=first, allowed_arms=allowed)
    detail = {'schema': 'cc-harbor-plan-detail/v1', 'codex_costs': {t: costs.get(t, {}) for t in tasks},
              'codex_wall_s': {t: (walls or {}).get(t, {}) for t in tasks},
              'pilot': {str(s): ts for s, ts in pilot.items()}, 'scanner_cal': scanner, 'arms': arms}
    return plan, detail


def validate(plan: dict[str, Any]) -> list[str]:
    """Structural checks of a plan file (used by the driver before it runs anything)."""
    issues = []
    if plan.get('schema') not in PLAN_SCHEMAS:
        issues.append(f"schema {plan.get('schema')!r}")
    if re.search(r'\d{12}', json.dumps({k: v for k, v in plan.items() if not k.startswith('_')})):
        issues.append('a 12-digit run (N5: nothing account-shaped in committed files)')
    n = plan.get('n_shards')
    for t, m in plan.get('tasks', {}).items():
        if not re.fullmatch(TASK_ID_RE, t):
            issues.append(f'task id {t!r}')
        if not isinstance(m.get('shard'), int) or not 0 <= m['shard'] < n:
            issues.append(f'{t}: shard {m.get("shard")!r}')
    seen: set[tuple[str, str, int]] = set()
    table = plan.get('arms')
    for pn, p in plan.get('passes', {}).items():
        if isinstance(table, dict) and any(a not in table for a in p.get('arms', [])):
            issues.append(f'{pn}: arms {p.get("arms")} are not all in the plan\'s arm table')
        for s, bs in p['shards'].items():
            for b in bs:
                if plan['tasks'].get(b['task'], {}).get('shard') != int(s):
                    issues.append(f'{pn}: {b["task"]} listed under shard {s}')
                for a in b['arms']:
                    k = (b['task'], a, p['rep'])
                    if p['phase'] == 'pilot':
                        continue   # pilot runs are outside the analysis (design §7.4) and may repeat main's keys
                    if k in seen:
                        issues.append(f'{pn}: {k} appears twice')
                    seen.add(k)
    return issues


# ---------------------------------------------------------------- io

def write_json(path: pathlib.Path, data: Any) -> None:
    import os
    import tempfile
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1, ensure_ascii=False, allow_nan=False) + '\n'
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def load_plan(path: pathlib.Path = PLAN) -> dict[str, Any]:
    plan = json.loads(path.read_text(encoding='utf-8'))
    issues = validate(plan)
    if issues:
        raise PlanError(f'{path}: {issues[:5]}')
    return plan


def summary(plan: dict[str, Any]) -> dict[str, Any]:
    by = Counter(m['shard'] for m in plan['tasks'].values())
    return {'tasks': len(plan['tasks']), 'shards': {str(s): by.get(s, 0) for s in range(plan['n_shards'])},
            'passes': {n: {'phase': p['phase'], 'arms': p['arms'], 'rep': p['rep'], 'trials': p['n_trials'],
                           'order': p.get('order'), 'cut': p.get('cut'),
                           'per_shard': {s: len(bs) for s, bs in p['shards'].items()}} for n, p in plan['passes'].items()}}


def cmd_derive(a: argparse.Namespace) -> None:
    """Claude Code: derive a benchmark's plan from its Codex plan (CC design §1.2)."""
    import profiles
    prof = a.profile
    if a.plan_path.exists() and not a.force:
        sys.exit(f'{a.plan_path} exists; it is the pre-registered plan (use --force to rebuild it before stage 1)')
    src = pathlib.Path(a.src) if a.src else profiles.PROFILES[prof.base].plan
    codex_plan = load_plan(src)
    arms_p = pathlib.Path(a.arms) if a.arms else profiles.CC_HERE / 'arms.json'
    order, arms = load_arms(arms_p)
    if a.only_arms:   # a subset of the arm table (0c: the A/C validation), in the table's order
        keep = [x.strip() for x in a.only_arms.split(',') if x.strip()]
        missing = [x for x in keep if x not in arms]
        if missing or not keep:
            sys.exit(f'--only-arms: {missing or "empty"} not in {arms_p.name}')
        order, arms = [x for x in order if x in keep], {x: arms[x] for x in order if x in keep}
    passes = tuple(x.strip() for x in (a.passes or 'main,rep2,rep3').split(',') if x.strip())
    drops_p = pathlib.Path(a.drops) if a.drops else None
    attempts_p = pathlib.Path(a.codex_attempts)
    tiers_p = pathlib.Path(a.tiers) if a.tiers else None
    if prof.base == 'tb21' and tiers_p is None and any(v['main_model'] == 'auto' for v in arms.values()):
        sys.exit('derive for tb21 with an auto arm needs --tiers <the Claude Code tier pass strata.json> (73)')
    inputs = {'codex_plan_sha256_b64': sha256_b64(src), 'arms_sha256_b64': sha256_b64(arms_p),
              'codex_attempts_sha256_b64': sha256_b64(attempts_p),
              **({'drops_sha256_b64': sha256_b64(drops_p)} if drops_p else {}), **({'strata_sha256_b64': sha256_b64(tiers_p)} if tiers_p else {})}
    plan, detail = derive_cc(codex_plan, name=prof.name, base=str(prof.base), order=order, arms=arms, drops=load_drops(drops_p),
                             costs=codex_task_costs(attempts_p), walls=codex_task_costs(attempts_p, 'wall_s'),
                             tiers=load_tiers(tiers_p) if tiers_p else None, seed=a.seed, passes=passes,
                             scanner_pool=[x for x in (a.scanner_cal or '').split(',') if x] or None, inputs=inputs)
    issues = validate(plan)
    if issues:
        sys.exit(f'plan: {issues[:5]}')
    write_json(a.plan_path, plan)
    write_json(a.detail_path, detail)
    print(json.dumps({'plan': summary(plan), 'pilot': detail['pilot'], 'arms': order}, indent=1))


def cmd_build_tb(a: argparse.Namespace) -> None:
    """TB: tasks from the pinned checkout, tiers from 73's strata.json, cost weights from 0d's file, content and
    image digests from 4f's taskpin.plan_pins (Docker Hub, read-only; cached in the gitignored detail dir)."""
    if a.plan_path.exists() and not a.force:
        sys.exit(f'{a.plan_path.name} exists; it is the pre-registered plan (use --force to rebuild it)')
    tasks_dir = pathlib.Path(a.tasks_dir)
    sp, wp = pathlib.Path(a.tiers), pathlib.Path(a.weights)
    tiers, weights = load_tb_strata(sp), load_tb_weights(wp)
    ids = sorted(p.name for p in tasks_dir.iterdir() if p.is_dir() and (p / 'task.toml').is_file())
    cache = a.detail_path.parent / 'pins.json'
    if a.pins:
        pins = json.loads(pathlib.Path(a.pins).read_text(encoding='utf-8'))
    elif cache.exists() and not a.refresh_pins:
        pins = json.loads(cache.read_text(encoding='utf-8'))
    else:
        import taskpin
        pins = taskpin.plan_pins(tasks_dir.parent, ids)
        write_json(cache, pins)
    import base64
    head = subprocess_head(tasks_dir.parent)
    want = commit_hex({'dataset': {'commit_b64': TB_COMMIT_B64}})
    if head != want:
        sys.exit(f'{tasks_dir.parent}: HEAD is not the pinned TB commit')
    inputs = {'strata_sha256_b64': sha256_b64(sp), 'cost_weights_sha256_b64': sha256_b64(wp),
              'pins_sha256_b64': base64.urlsafe_b64encode(hashlib.sha256(json.dumps(pins, sort_keys=True).encode()).digest()).decode().rstrip('=')}
    plan, detail = build_tb(tasks_dir, tiers=tiers, weights=weights, pins=pins, n_shards=a.shards, seed=a.seed, inputs=inputs)
    issues = validate(plan)
    if issues:
        sys.exit(f'plan: {issues[:5]}')
    write_json(a.plan_path, plan)
    write_json(a.detail_path, detail)
    print(json.dumps({'plan': summary(plan), 'balance': detail['balance'], 'objective': detail['objective'], 'pilot': detail['pilot'],
                      'pilot_planning_usd': detail['pilot_planning_usd']}, indent=1))


def subprocess_head(root: pathlib.Path) -> str:
    import subprocess  # nosec B404 - fixed argv
    r = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=60, check=False)  # nosec B603 B607
    return r.stdout.strip() if r.returncode == 0 else ''


def cmd_build(a: argparse.Namespace) -> None:
    tj, rj = pathlib.Path(a.tasks_json), pathlib.Path(a.trials_json)
    tasks_json = json.loads(tj.read_text(encoding='utf-8'))
    trials_json = json.loads(rj.read_text(encoding='utf-8'))
    sha = task_dirs_check(pathlib.Path(a.tasks_dir), set(load_tasks(tasks_json))) if a.tasks_dir else None
    inputs = {'tasks_json_sha256_b64': sha256_b64(tj), 'trials_json_sha256_b64': sha256_b64(rj)}
    if a.plan_path.exists() and not a.force:
        sys.exit(f'{a.plan_path.name} exists; it is the pre-registered plan (use --force to rebuild it)')
    tiers = load_tiers(pathlib.Path(a.tiers)) if a.tiers else None
    plan, detail = build(tasks_json, trials_json, n_shards=a.shards, seed=a.seed, task_toml_sha=sha, inputs=inputs, tiers=tiers)
    write_json(a.plan_path, plan)
    write_json(a.detail_path, detail)
    print(json.dumps({'plan': summary(plan), 'balance': detail['balance']}, indent=1))


def cmd_add_pass(a: argparse.Namespace) -> None:
    plan = load_plan(a.plan_path)
    arms = tuple(x.strip() for x in a.arms.split(',') if x.strip())
    if a.pilot_per_shard:
        detail = json.loads(a.detail_path.read_text(encoding='utf-8'))
        tiers = load_tiers(pathlib.Path(a.tiers)) if a.tiers else None
        by, ordered = pilot_sample(plan, detail['tasks'], tiers, plan['seed']), True
        print(json.dumps({'pilot': {str(k): v for k, v in by.items()},
                          'planning_cost_usd': round(sum(planning_cost(detail['tasks'], t, x, tiers) for ts in by.values() for t in ts for x in ARMS), 2),
                          'languages': {t: plan['tasks'][t]['language'] for ts in by.values() for t in ts}}, indent=1))
    elif a.per_shard is not None:
        if not a.tiers:
            sys.exit('--per-shard needs --tiers <tier-pass rows (jsonl)>')
        by, ordered = tier_sample(plan, load_tiers(pathlib.Path(a.tiers), a.tier_field), a.per_shard, plan['seed'], a.name), True
    elif a.sample is not None:
        if a.from_shard is None:
            sys.exit('--sample needs --from-shard')
        by, ordered = sample_tasks(plan, a.sample, a.from_shard, plan['seed'], a.name), True
    elif a.tasks == 'all':
        by, ordered = shard_tasks(plan), False
    elif a.tasks:
        ids = [x.strip() for x in a.tasks.split(',') if x.strip()]
        unknown = [t for t in ids if t not in plan['tasks']]
        if unknown:
            sys.exit(f'unknown tasks: {unknown}')
        by = defaultdict(list)
        for t in ids:
            by[plan['tasks'][t]['shard']].append(t)
        ordered = False
    else:
        sys.exit('one of --per-shard, --sample, --tasks')
    tiers_tb = load_tb_strata(pathlib.Path(a.tiers)) if (plan.get('schema') == TB_SCHEMA and a.tiers) else None
    add_pass(plan, a.name, a.phase, arms, a.rep, dict(by), ordered, note=a.note or '', replace=a.replace, order=a.order, tiers=tiers_tb)
    write_json(a.plan_path, plan)
    print(json.dumps(summary(plan)['passes'][a.name], indent=1))


def cmd_cut(a: argparse.Namespace) -> None:
    plan = load_plan(a.plan_path)
    arms = tuple(x.strip() for x in a.arm.split(',')) if a.arm else None
    cut_pass(plan, a.name, None if a.remove else a.per_shard, a.note or '', arms)
    write_json(a.plan_path, plan)
    print(json.dumps(summary(plan)['passes'][a.name], indent=1))


def cmd_show(a: argparse.Namespace) -> None:
    plan = load_plan(a.plan_path)
    out = summary(plan)
    if a.detail_path.exists():
        out['balance'] = json.loads(a.detail_path.read_text(encoding='utf-8'))['balance']
    print(json.dumps(out, indent=1))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dataset', default='deepswe', help='deepswe (default) or tb21: which plan and detail files')
    ap.add_argument('--agent', default=None, help='codex (default) or claude-code (profiles.py)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('derive', help="Claude Code: the benchmark's plan from its Codex plan (shards, pins, drops kept)")
    p.add_argument('--from', dest='src', help="the Codex plan (default: the base dataset's committed plan)")
    p.add_argument('--arms', help='the arm table (default: experiments/claude-code-harbor/arms.json)')
    p.add_argument('--drops', help='the pre-registered drop list: a JSON list, or the Codex merged checks.json')
    p.add_argument('--codex-attempts', required=True, help="the Codex run's merged attempts.jsonl (per-task costs for the pilot pick)")
    p.add_argument('--tiers', help="tb21: the Claude Code tier pass strata.json (73); without it (pinned arms only) TB blocks are "
                                   "stratified by category group × difficulty")
    p.add_argument('--only-arms', help='a subset of the arm table, e.g. A,C (the plan records only these)')
    p.add_argument('--passes', help='the passes to pre-register besides the pilot (default main,rep2,rep3; stage 1 only: main)')
    p.add_argument('--scanner-cal', help='tb21: the comma list the 2 scanner-calibration pilot tasks are drawn from (0d §10)')
    p.add_argument('--seed', type=int, default=CC_SEED)
    p.add_argument('--force', action='store_true')
    p.set_defaults(fn=cmd_derive)
    p = sub.add_parser('build-tb', help='TB 2.1: build the plan (shards, pilot, main, rep2, rep3)')
    p.add_argument('--tasks-dir', required=True, help='<terminal-bench-2-1 checkout at the pin>/tasks')
    p.add_argument('--tiers', required=True, help="73's strata.json (tbench-harbor-strata/v1)")
    p.add_argument('--weights', required=True, help="0d's tb-cost-weights.json (gitignored copy)")
    p.add_argument('--pins', help='precomputed taskpin.plan_pins JSON (default: the cached results/pins.json, else Docker Hub)')
    p.add_argument('--refresh-pins', action='store_true')
    p.add_argument('--shards', type=int, default=N_SHARDS)
    p.add_argument('--seed', type=int, default=TB_SEED)
    p.add_argument('--force', action='store_true')
    p.set_defaults(fn=cmd_build_tb)
    p = sub.add_parser('build')
    p.add_argument('--tasks-json', required=True, help='public tasks.json (deepswe.datacurve.ai artifacts v1.1)')
    p.add_argument('--trials-json', required=True, help='public trials.json (same release)')
    p.add_argument('--tasks-dir', help='<deep-swe checkout>/tasks: check every task exists and record task.toml hashes')
    p.add_argument('--shards', type=int, default=N_SHARDS)
    p.add_argument('--seed', type=int, default=SEED)
    p.add_argument('--tiers', help="73's strata.json: cost B at its tier-pass model in plan-detail.json")
    p.add_argument('--force', action='store_true')
    p.set_defaults(fn=cmd_build)
    p = sub.add_parser('add-pass')
    p.add_argument('--name', required=True)
    p.add_argument('--phase', choices=PHASES, required=True)
    p.add_argument('--arms', required=True, help='comma list, e.g. A or A,B')
    p.add_argument('--rep', type=int, required=True)
    p.add_argument('--per-shard', type=int, help='a tier- and language-stratified sample of this many tasks per shard')
    p.add_argument('--tiers', help="73's strata.json, or tier-pass rows (jsonl with task_id and the tier field)")
    p.add_argument('--tier-field', default='pred_tier')
    p.add_argument('--pilot-per-shard', action='store_true', help='the pilot rule: one task per shard, distinct languages (pilot_sample)')
    p.add_argument('--sample', type=int, help='this many tasks of --from-shard, spread over difficulty')
    p.add_argument('--from-shard', type=int)
    p.add_argument('--tasks', help="'all' or a comma list of task ids")
    p.add_argument('--note')
    p.add_argument('--replace', action='store_true')
    p.add_argument('--order', choices=('random', 'stratified'), default='random',
                   help='stratified: every prefix is a stratified subset (for a pass that may be cut at the checkpoint)')
    p.set_defaults(fn=cmd_add_pass)
    p = sub.add_parser('cut', help='run only the first N blocks per shard of a pass (design §7.5 checkpoint)')
    p.add_argument('--name', required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--per-shard', type=int)
    g.add_argument('--remove', action='store_true')
    p.add_argument('--arm', help='cut only these arms of the pass (comma list), e.g. C; default: whole blocks')
    p.add_argument('--note')
    p.set_defaults(fn=cmd_cut)
    p = sub.add_parser('show')
    p.set_defaults(fn=cmd_show)
    a = ap.parse_args(argv)
    import profiles
    prof = a.profile = profiles.get(a.dataset, a.agent)
    a.plan_path, a.detail_path = prof.plan, prof.dev_results / 'plan-detail.json'
    if (a.cmd == 'build-tb' and prof.name != 'tb21') or (a.cmd == 'build' and prof.name != 'deepswe'):
        sys.exit('build-tb is the --dataset tb21 builder; build is DeepSWE\'s')
    if (a.cmd == 'derive') != (prof.agent == 'claude-code') and a.cmd in ('derive', 'build', 'build-tb'):
        sys.exit('derive builds the Claude Code plans (--agent claude-code); build/build-tb are the Codex builders')
    try:
        a.fn(a)
    except PlanError as e:
        sys.exit(f'plan: {e}')


if __name__ == '__main__':
    main()
