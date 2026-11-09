"""Pre-registered statistics for the Codex x DeepSWE routing experiment (design.md §2, revised by §10, §11 and §12).

Pure, stdlib-only functions over per-task rows; ``report.py`` filters to main-phase rows and aligns paired lists by
``task_id`` before calling in. Every resampling function takes a ``seed`` and uses its own ``random.Random(seed)``;
nothing touches global random state, so a report is reproducible from (rows, seed). Results are plain dicts whose
confidence intervals are ``(lo, hi)`` float tuples, or ``None`` where the quantity is undefined, so they ``json.dump``
directly. Nothing returns ``inf`` or ``nan``.

Arms (revision 3, design §12; revision 2 in §11): A = pin Sol (standard), 200 tasks; F = pin Luna (fast), the same
200; C = pin Astra (frontier), a 60-task size-stratified subset; B = auto + assessor, a 30-task subset; D = direct
bedrock-runtime on Sol, a 10-task subset; repeat phase: extra runs of A and F on 20 tasks. The tier pass predicted
standard (or no opinion) for every candidate, so the assessor's choice equals A on every task.

Pre-registered analyses (D7, D8, §11, §12)
- Primary 1, F vs A (200 pairs), ``compare_arms(a_rows=A, b_rows=F)``: paired resolve difference F − A with the
  Newcombe hybrid-score 95% CI (method 10), exact McNemar p, non-inferiority at 10 pp (CI lower bound > −0.10); and
  the total-cost ratio ΣF/ΣA with a paired percentile bootstrap CI (median and geometric mean of per-task ratios are
  secondary; the median hides savings concentrated on a minority of tasks, see ``cost_ratio``).
- Primary 2, C vs A (60 pairs), ``compare_arms(a_rows=A, b_rows=C)``: paired resolve difference and ΣC/ΣA, plus
  $ per solved task for both arms and their paired ratio (``usd_per_solved_ratio``).
- Descriptive: the ideal per-task router (``ideal_router``) on {F, A} over 200 tasks and {F, A, C} over 60, against
  always-Sol (A) and the assessor's actual choice (= A); run-to-run noise of A and F from the repeat phase
  (``replicate_noise``) and from B's Sol-served tasks; B vs A (30) for overhead and transparency; D vs A (10) for
  router overhead; $ per solved task; cache-hit difference; size-bucket breakdowns.
- Not used since revision 2: the population-weighted estimators (``weighted_resolve_diff``, ``weighted_cost_ratio``).
  They stay for the D2 design but there is no tier stratification to undo.

What n = 200 with one main run per (task, arm) can and cannot show
- CAN detect a moderate resolve-rate change for F vs A. With about 20% discordant pairs, the 95% CI on F − A is
  about ±6 pp (1.96·√(0.2/200)); a true drop of about 9 pp or more shows as a CI that excludes 0 with 80% power.
  Fast and standard models may disagree on more than 20% of tasks (30% gives about ±7.5 pp).
- CAN show non-inferiority at 10 pp if the arms are about equal: 157 pairs give 80% power at a true difference of 0
  and 20% discordance (``ni_sample_size``); 200 give about 88%. At 30% discordance 236 pairs are needed, so a
  "fail" with high discordance is still weak evidence that F is worse. If F is truly 5 pp worse, NI holds
  (−5 > −10) but is shown with only about 35% power.
- C vs A has 60 pairs: the resolve-difference CI is about ±11 pp at 20% discordance (1.96·√(0.2/60)), so a
  true frontier gain of roughly 16 pp or more is distinguishable from zero with 80% power. $ per solved task rests
  on 60 tasks per arm; read its CI, which is wide.
- CANNOT separate the arm effect from Codex's run-to-run variance task by task. Every discordant pair mixes both.
  The repeat phase estimates the noise: ``replicate_noise`` gives each arm's pair disagreement (the discordance it
  would show against a copy of itself). On 20 tasks that estimate is imprecise (e.g. 4/20 tasks flipping has a 95%
  Wilson interval of about 8–42%), so it shows whether noise is a small or a large part of F vs A discordance, not
  its exact share. B's Sol-served tasks are a second A-vs-A replicate (about 30 pairs).
- CAN estimate the total-cost ratio ΣF/ΣA tightly: Luna costs about 1/20 of Sol per token, so the ratio is far from
  1 even with heavy-tailed run lengths. Fast runs may take more turns; the ratio already includes that. The
  percentile bootstrap can under-cover when a few very long runs dominate the sums, so read the CI as approximate.
- The ideal per-task router is an upper bound, not an achievable router. It knows each task's outcomes in advance,
  and with one run per arm "solved by some arm" includes lucky runs, so its solve count is inflated by run-to-run
  variance. The A-vs-B (both Sol) replicate run through ``ideal_router`` estimates that inflation: any solve gained
  there is pure noise.
- B (30 tasks) and D (10 tasks) are descriptive. They support overhead, transparency and error counts per call
  (thousands of calls), not resolve-rate or cost comparisons: a single flipped task moves B's rate by about 3 pp and
  D's by 10 pp.
- CANNOT support inference within strata: about 67 tasks per size bucket for F vs A, about 20 for C. ``by_stratum``
  marks n < 10 as ``descriptive_only``, and every stratum is descriptive by pre-registration anyway.
- CAN bound rare failures. Zero router-caused failures in N runs gives a one-sided 95% upper bound of
  1 − 0.05^(1/N), about 3/N (``zero_events_upper``).
- Nothing here generalises beyond R2E-Gym-style Python repository repairs, this Codex version and config, and
  these three models.
"""

from __future__ import annotations

import math
import random
import statistics
from collections.abc import Callable, Sequence
from typing import Any

SEED = 20261105
N_BOOT = 10_000
NI_MARGIN = 0.10
CACHE_MARGIN = 0.02
Z95 = statistics.NormalDist().inv_cdf(0.975)

Row = dict[str, Any]
CI = tuple[float, float]


# ---------------------------------------------------------------------------------------------------------------------
# Small exact / closed-form pieces


def wilson(k: int, n: int, z: float = Z95) -> CI | None:
    """Wilson score interval for k successes in n trials; None when n == 0."""
    if n == 0:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def mcnemar_exact(b: int, c: int) -> float:
    """Exact two-sided McNemar p-value on the discordant counts b and c: binomial(b + c, 1/2), doubled one tail."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def zero_events_upper(n: int, conf: float = 0.95) -> float | None:
    """One-sided upper bound on an event rate after 0 events in n trials (exact; about 3/n at 95%)."""
    if n <= 0:
        return None
    return 1 - (1 - conf) ** (1 / n)


def ni_sample_size(discordance: float, margin: float = NI_MARGIN, true_diff: float = 0.0, alpha: float = 0.025,
                   power: float = 0.8) -> int:
    """Pairs needed to show non-inferiority (normal approximation for paired proportions).

    n = (z_{1−α} + z_{power})² · p_d / (margin + true_diff)², where p_d is the discordant-pair rate. It ignores the
    small −diff² term in the variance, so it is slightly conservative. Example: p_d = 0.2, margin 0.10, true
    difference 0 gives 157.
    """
    nd = statistics.NormalDist()
    eff = margin + true_diff
    if eff <= 0:
        raise ValueError('margin + true_diff must be > 0')
    return math.ceil((nd.inv_cdf(1 - alpha) + nd.inv_cdf(power)) ** 2 * discordance / eff**2)


# ---------------------------------------------------------------------------------------------------------------------
# Bootstrap plumbing


def _quantile(sorted_xs: Sequence[float], q: float) -> float:
    """Linear-interpolation quantile (type 7) of an already sorted sequence."""
    if not sorted_xs:
        raise ValueError('empty')
    h = (len(sorted_xs) - 1) * q
    lo = math.floor(h)
    hi = min(lo + 1, len(sorted_xs) - 1)
    return sorted_xs[lo] + (h - lo) * (sorted_xs[hi] - sorted_xs[lo])


def _percentile_ci(reps: list[float], alpha: float = 0.05) -> CI | None:
    if not reps:
        return None
    s = sorted(reps)
    return (_quantile(s, alpha / 2), _quantile(s, 1 - alpha / 2))


def _bootstrap(n: int, stat: Callable[[list[int]], float | None], seed: int, n_boot: int) -> tuple[list[float], int]:
    """Resamples task indices 0..n−1 with replacement; returns the defined replicates and how many were undefined."""
    rng = random.Random(seed)
    reps: list[float] = []
    undefined = 0
    for _ in range(n_boot):
        idx = [rng.randrange(n) for _ in range(n)]
        v = stat(idx)
        if v is None:
            undefined += 1
        else:
            reps.append(v)
    return reps, undefined


def _stratified_bootstrap(groups: dict[str, list[int]], stat: Callable[[dict[str, list[int]]], float | None], seed: int,
                          n_boot: int) -> tuple[list[float], int]:
    """Resamples within each stratum (sizes kept), for the population-weighted estimates."""
    rng = random.Random(seed)
    keys = sorted(groups)
    reps: list[float] = []
    undefined = 0
    for _ in range(n_boot):
        draw = {k: [groups[k][rng.randrange(len(groups[k]))] for _ in groups[k]] for k in keys}
        v = stat(draw)
        if v is None:
            undefined += 1
        else:
            reps.append(v)
    return reps, undefined


def _same_len(a: Sequence[Any], b: Sequence[Any]) -> int:
    if len(a) != len(b):
        raise ValueError(f'paired inputs differ in length: {len(a)} vs {len(b)}')
    return len(a)


def _check_aligned(a_rows: Sequence[Row], b_rows: Sequence[Row]) -> int:
    n = _same_len(a_rows, b_rows)
    for i, (x, y) in enumerate(zip(a_rows, b_rows)):
        if x.get('task_id') != y.get('task_id'):
            raise ValueError(f'rows not aligned at {i}: {x.get("task_id")!r} vs {y.get("task_id")!r}')
    return n


# ---------------------------------------------------------------------------------------------------------------------
# H2: paired resolve difference


def paired_diff(a: Sequence[bool], b: Sequence[bool]) -> dict[str, Any]:
    """Paired resolve-rate difference B − A over aligned tasks.

    Returns n, both rates with Wilson CIs, the 2×2 counts (both, a_only, b_only, neither), diff, its Newcombe
    hybrid-score 95% CI (method 10, Newcombe 1998), the exact McNemar p and the discordance rate. The McNemar p
    tests only the discordant pairs; with few of them (e.g. 3 vs 1) it cannot be small, whatever n is.
    """
    n = _same_len(a, b)
    e = sum(1 for x, y in zip(a, b) if x and y)
    f = sum(1 for x, y in zip(a, b) if x and not y)  # A only
    g = sum(1 for x, y in zip(a, b) if y and not x)  # B only
    h = n - e - f - g
    out: dict[str, Any] = {'n': n, 'both': e, 'a_only': f, 'b_only': g, 'neither': h}
    if n == 0:
        return {**out, 'rate_a': None, 'rate_b': None, 'ci_a': None, 'ci_b': None, 'diff': None, 'ci': None,
                'p_mcnemar': 1.0, 'discordance': None}
    pa, pb = (e + f) / n, (e + g) / n
    la, ua = wilson(e + f, n)  # type: ignore[misc]
    lb, ub = wilson(e + g, n)  # type: ignore[misc]
    den = (e + f) * (g + h) * (e + g) * (f + h)
    phi = (e * h - f * g) / math.sqrt(den) if den > 0 else 0.0
    return {**out, 'rate_a': pa, 'rate_b': pb, 'ci_a': (la, ua), 'ci_b': (lb, ub), 'diff': pb - pa,
            'ci': _hybrid(pb, (lb, ub), pa, (la, ua), phi), 'p_mcnemar': mcnemar_exact(f, g), 'discordance': (f + g) / n}


def _hybrid(p1: float, ci1: CI, p2: float, ci2: CI, phi: float = 0.0) -> CI:
    """Newcombe's hybrid score interval for p1 − p2 from the two Wilson intervals; phi = 0 gives the unpaired method
    10 (Newcombe 1998a), phi = the 2×2 correlation gives the paired method 10 (Newcombe 1998b)."""
    (l1, u1), (l2, u2) = ci1, ci2
    d = p1 - p2
    lo = d - math.sqrt(max(0.0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2))
    hi = d + math.sqrt(max(0.0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2))
    return (max(-1.0, lo), min(1.0, hi))


def noninferiority(diff_ci_lo: float | None, margin: float = NI_MARGIN) -> dict[str, Any]:
    """B is non-inferior to A when the lower 95% bound of B − A is above −margin (one-sided α = 2.5%).

    At n=50 a False here is the expected outcome even when the arms are equal (see the module docstring); report it
    as "not shown", never as "B is worse".
    """
    return {'margin': margin, 'ci_lo': diff_ci_lo,
            'noninferior': None if diff_ci_lo is None else diff_ci_lo > -margin}


# ---------------------------------------------------------------------------------------------------------------------
# H1: cost


def cost_ratio(a_costs: Sequence[float], b_costs: Sequence[float], seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """Paired cost comparison B vs A over aligned tasks.

    Primary (D7): ``ratio_of_sums`` = ΣB/ΣA, the change in total spend, with a paired percentile bootstrap CI over
    tasks. Secondary: the ``median_ratio`` and ``geomean_ratio`` of the per-task ratios B_i/A_i, using only tasks
    where both costs are > 0 (``n_ratio`` of ``n``).

    Why the median is not primary: if 15 of 50 tasks go to a model costing 1/20 and 35 stay put, the median ratio
    is 1.0 ("no saving") while total spend falls by about 28%. The ratio of sums is dominated by the most expensive
    tasks, so read it with ``share_top5_a``, the share of A's total from its five costliest tasks.
    """
    n = _same_len(a_costs, b_costs)
    pairs = [(x, y) for x, y in zip(a_costs, b_costs) if x > 0 and y > 0]
    out: dict[str, Any] = {'n': n, 'n_ratio': len(pairs), 'sum_a': float(sum(a_costs)), 'sum_b': float(sum(b_costs)),
                           'primary': 'ratio_of_sums', 'seed': seed, 'n_boot': n_boot}

    def ros(idx: list[int]) -> float | None:
        sa = sum(a_costs[i] for i in idx)
        return sum(b_costs[i] for i in idx) / sa if sa > 0 else None

    def med(idx: list[int]) -> float | None:
        rs = [b_costs[i] / a_costs[i] for i in idx if a_costs[i] > 0 and b_costs[i] > 0]
        return statistics.median(rs) if rs else None

    def gm(idx: list[int]) -> float | None:
        ls = [math.log(b_costs[i] / a_costs[i]) for i in idx if a_costs[i] > 0 and b_costs[i] > 0]
        return math.exp(statistics.fmean(ls)) if ls else None

    allidx = list(range(n))
    top = sorted(a_costs, reverse=True)[:5]
    out['share_top5_a'] = sum(top) / out['sum_a'] if out['sum_a'] > 0 else None
    for name, fn in (('ratio_of_sums', ros), ('median_ratio', med), ('geomean_ratio', gm)):
        point = fn(allidx) if n else None
        if point is None:
            out[name] = {'point': None, 'ci': None, 'undefined_reps': None}
            continue
        reps, und = _bootstrap(n, fn, seed, n_boot)
        out[name] = {'point': point, 'ci': _percentile_ci(reps), 'undefined_reps': und}
    return out


def usd_per_solved(costs: Sequence[float], solved: Sequence[bool], seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """Σcost / Σsolved for one arm (all runs' cost counts, solved or not), with a bootstrap CI over tasks.

    Undefined when nothing is solved. Bootstrap replicates with zero solved are counted in ``undefined_reps``;
    when they exceed 2.5% of replicates the upper bound is unbounded and ``ci`` is ``(lo, None)``.
    """
    n = _same_len(costs, solved)
    k = sum(1 for s in solved if s)
    out: dict[str, Any] = {'n': n, 'solved': k, 'sum_cost': float(sum(costs)), 'seed': seed, 'n_boot': n_boot}
    if k == 0:
        return {**out, 'point': None, 'ci': None, 'undefined_reps': None}

    def stat(idx: list[int]) -> float | None:
        s = sum(1 for i in idx if solved[i])
        return sum(costs[i] for i in idx) / s if s else None

    reps, und = _bootstrap(n, stat, seed, n_boot)
    ci = _percentile_ci(reps)
    if ci is not None and und > 0.025 * n_boot:
        ci = (ci[0], None)  # type: ignore[assignment]
    return {**out, 'point': out['sum_cost'] / k, 'ci': ci, 'undefined_reps': und}


def usd_per_solved_ratio(a_costs: Sequence[float], a_solved: Sequence[bool], b_costs: Sequence[float],
                         b_solved: Sequence[bool], seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """Paired ratio of $/solved, B over A (e.g. C vs A on the 20-task subset), with a paired bootstrap CI."""
    n = _same_len(a_costs, b_costs)
    _same_len(a_costs, a_solved)
    _same_len(b_costs, b_solved)

    def stat(idx: list[int]) -> float | None:
        ka = sum(1 for i in idx if a_solved[i])
        kb = sum(1 for i in idx if b_solved[i])
        ca = sum(a_costs[i] for i in idx)
        if ka == 0 or kb == 0 or ca <= 0:
            return None
        return (sum(b_costs[i] for i in idx) / kb) / (ca / ka)

    point = stat(list(range(n))) if n else None
    if point is None:
        return {'n': n, 'point': None, 'ci': None, 'undefined_reps': None, 'seed': seed, 'n_boot': n_boot}
    reps, und = _bootstrap(n, stat, seed, n_boot)
    return {'n': n, 'point': point, 'ci': _percentile_ci(reps), 'undefined_reps': und, 'seed': seed, 'n_boot': n_boot}


# ---------------------------------------------------------------------------------------------------------------------
# H4: cache hit rate


def cache_hit_diff(a_rows: Sequence[Row], b_rows: Sequence[Row], seed: int = SEED, n_boot: int = N_BOOT,
                   margin: float = CACHE_MARGIN) -> dict[str, Any]:
    """Cache hit rate Σcached/Σinput per arm (input includes cached, Responses convention), the difference B − A,
    and a paired bootstrap CI over tasks.

    ``within_margin`` asks whether the CI lower bound is above −margin (default 2 pp), the H4 criterion. This
    aggregate mixes models with different prefixes; the per-call cache-loss count (D9) is the direct transparency
    measure.
    """
    n = _check_aligned(a_rows, b_rows)

    def rate(rows: Sequence[Row], idx: list[int]) -> float | None:
        inp = sum(rows[i]['input_tokens'] for i in idx)
        return sum(rows[i]['cached_tokens'] for i in idx) / inp if inp > 0 else None

    def stat(idx: list[int]) -> float | None:
        ra, rb = rate(a_rows, idx), rate(b_rows, idx)
        return None if ra is None or rb is None else rb - ra

    allidx = list(range(n))
    ra, rb = (rate(a_rows, allidx), rate(b_rows, allidx)) if n else (None, None)
    d = stat(allidx) if n else None
    out: dict[str, Any] = {'n': n, 'rate_a': ra, 'rate_b': rb, 'diff': d, 'margin': margin, 'seed': seed, 'n_boot': n_boot}
    if d is None:
        return {**out, 'ci': None, 'within_margin': None, 'undefined_reps': None}
    reps, und = _bootstrap(n, stat, seed, n_boot)
    ci = _percentile_ci(reps)
    return {**out, 'ci': ci, 'within_margin': None if ci is None else ci[0] > -margin, 'undefined_reps': und}


# ---------------------------------------------------------------------------------------------------------------------
# Composite and strata


def compare_arms(a_rows: Sequence[Row], b_rows: Sequence[Row], seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """All paired comparisons for aligned rows of two arms: resolve diff + NI, cost ratio, $/solved per arm and
    their ratio, cache-hit difference, and timeout/error counts."""
    n = _check_aligned(a_rows, b_rows)
    ra = [bool(r['resolved']) for r in a_rows]
    rb = [bool(r['resolved']) for r in b_rows]
    ca = [float(r['cost_usd']) for r in a_rows]
    cb = [float(r['cost_usd']) for r in b_rows]
    resolve = paired_diff(ra, rb)
    return {
        'n': n,
        'resolve': resolve,
        'noninferiority': noninferiority(resolve['ci'][0] if resolve['ci'] else None),
        'cost': cost_ratio(ca, cb, seed, n_boot),
        'usd_per_solved_a': usd_per_solved(ca, ra, seed, n_boot),
        'usd_per_solved_b': usd_per_solved(cb, rb, seed, n_boot),
        'usd_per_solved_ratio': usd_per_solved_ratio(ca, ra, cb, rb, seed, n_boot),
        'cache': cache_hit_diff(a_rows, b_rows, seed, n_boot),
        'exit_a': _counts(r.get('exit_reason') for r in a_rows),
        'exit_b': _counts(r.get('exit_reason') for r in b_rows),
        'cost_source_ledger': sum(1 for r in [*a_rows, *b_rows] if r.get('cost_source') == 'ledger'),
    }


def _counts(xs: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    for x in xs:
        k = 'none' if x is None else str(x)
        out[k] = out.get(k, 0) + 1
    return dict(sorted(out.items()))


def _stratum(key: str | Callable[[Row, Row], Any], a: Row, b: Row) -> str:
    if callable(key):
        v = key(a, b)
    else:
        v = b.get(key)
        if v is None:
            v = a.get(key)
    return 'none' if v is None else str(v)


def by_stratum(a_rows: Sequence[Row], b_rows: Sequence[Row], key: str | Callable[[Row, Row], Any],
               fn: Callable[[list[Row], list[Row]], dict[str, Any]] | None = None, seed: int = SEED,
               n_boot: int = N_BOOT) -> dict[str, dict[str, Any]]:
    """Splits aligned pairs by a stratum and applies ``fn`` (default ``compare_arms``) to each.

    ``key`` is a row field, taken from B's row and falling back to A's: ``assessor_tier`` exists only on B rows,
    while ``size_bucket`` and ``pred_tier`` are on both. It can also be a callable ``(a_row, b_row) -> value``.
    Missing values form the stratum 'none'. Strata are descriptive by pre-registration; n < 10 is also flagged
    ``descriptive_only`` because no interval there means much.
    """
    _check_aligned(a_rows, b_rows)
    groups: dict[str, tuple[list[Row], list[Row]]] = {}
    for a, b in zip(a_rows, b_rows):
        ga, gb = groups.setdefault(_stratum(key, a, b), ([], []))
        ga.append(a)
        gb.append(b)
    f = fn or (lambda xa, xb: compare_arms(xa, xb, seed, n_boot))
    return {k: {'n': len(v[0]), 'descriptive_only': len(v[0]) < 10, **f(v[0], v[1])} for k, v in sorted(groups.items())}


# ---------------------------------------------------------------------------------------------------------------------
# D2: population-weighted estimates (B sampled stratified by offline-predicted tier)


def _strata(a_rows: Sequence[Row], b_rows: Sequence[Row], weights: dict[str, float], key: str) -> dict[str, list[int]]:
    _check_aligned(a_rows, b_rows)
    groups: dict[str, list[int]] = {}
    for i, (a, b) in enumerate(zip(a_rows, b_rows)):
        groups.setdefault(_stratum(key, a, b), []).append(i)
    unknown = sorted(set(groups) - set(weights))
    if unknown:
        raise ValueError(f'strata without a population weight: {unknown}')
    missing = sorted(k for k, w in weights.items() if w > 0 and k not in groups)
    if missing:
        raise ValueError(f'strata with population weight but no sampled tasks (cannot be estimated): {missing}')
    return groups


def _norm(weights: dict[str, float]) -> dict[str, float]:
    tot = sum(weights.values())
    if tot <= 0 or any(w < 0 for w in weights.values()):
        raise ValueError('weights must be non-negative with a positive sum')
    return {k: w / tot for k, w in weights.items()}


def weighted_resolve_diff(a_rows: Sequence[Row], b_rows: Sequence[Row], weights: dict[str, float], key: str = 'pred_tier',
                          seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """Population-weighted resolve difference B − A: Σ_s w_s · (p̂B_s − p̂A_s).

    ``weights`` are the candidate pool's counts or shares per predicted tier, e.g. {'fast': 31, 'standard': 452,
    'frontier': 17}, normalised here. Every weighted stratum must have sampled pairs. The CI comes from a
    stratified paired bootstrap (resampling within strata), so it reflects the small strata honestly: a
    heavily weighted stratum with few tasks gives a wide interval.
    """
    w = _norm(weights)
    groups = _strata(a_rows, b_rows, w, key)

    def stat(g: dict[str, list[int]]) -> float:
        return sum(w[k] * sum(int(bool(b_rows[i]['resolved'])) - int(bool(a_rows[i]['resolved'])) for i in idx) / len(idx)
                   for k, idx in g.items() if w.get(k, 0) > 0)

    point = stat(groups)
    reps, _ = _stratified_bootstrap(groups, stat, seed, n_boot)
    return {'key': key, 'weights': w, 'n_by_stratum': {k: len(v) for k, v in sorted(groups.items())}, 'diff': point,
            'ci': _percentile_ci(reps), 'seed': seed, 'n_boot': n_boot}


def weighted_cost_ratio(a_rows: Sequence[Row], b_rows: Sequence[Row], weights: dict[str, float], key: str = 'pred_tier',
                        seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """Population-weighted total-cost ratio (combined ratio estimator): Σ_s w_s·mean(B_s) / Σ_s w_s·mean(A_s).

    This is the D7 primary measure, re-weighted to the candidate pool's tier mix: the expected change in spend on a
    task drawn from the pool. The CI comes from a stratified paired bootstrap.
    """
    w = _norm(weights)
    groups = _strata(a_rows, b_rows, w, key)

    def stat(g: dict[str, list[int]]) -> float | None:
        num = den = 0.0
        for k, idx in g.items():
            if w.get(k, 0) <= 0:
                continue
            num += w[k] * sum(float(b_rows[i]['cost_usd']) for i in idx) / len(idx)
            den += w[k] * sum(float(a_rows[i]['cost_usd']) for i in idx) / len(idx)
        return num / den if den > 0 else None

    point = stat(groups)
    reps, und = _stratified_bootstrap(groups, stat, seed, n_boot)
    return {'key': key, 'weights': w, 'n_by_stratum': {k: len(v) for k, v in sorted(groups.items())}, 'ratio': point,
            'ci': _percentile_ci(reps), 'undefined_reps': und, 'seed': seed, 'n_boot': n_boot}


def arm_summary(rows: Sequence[Row]) -> dict[str, Any]:
    """Unpaired per-arm description (any arm, including D): resolve rate with Wilson CI, cost totals, cache rate,
    exit reasons and served models."""
    n = len(rows)
    k = sum(1 for r in rows if r['resolved'])
    inp = sum(r['input_tokens'] for r in rows)
    cost = float(sum(r['cost_usd'] for r in rows))
    return {'n': n, 'resolved': k, 'rate': k / n if n else None, 'ci': wilson(k, n), 'sum_cost': cost,
            'mean_cost': cost / n if n else None, 'usd_per_solved': cost / k if k else None,
            'cache_hit_rate': sum(r['cached_tokens'] for r in rows) / inp if inp > 0 else None,
            'exit': _counts(r.get('exit_reason') for r in rows), 'served_model': _counts(r.get('served_model') for r in rows)}


# ---------------------------------------------------------------------------------------------------------------------
# §11: ideal per-task router (descriptive upper bound)


def ideal_router(rows_by_arm: dict[str, Sequence[Row]], order: Sequence[str], baselines: dict[str, str] | None = None,
                 tasks: Sequence[str] | None = None, unsolved: str = 'cheapest', seed: int = SEED,
                 n_boot: int = N_BOOT) -> dict[str, Any]:
    """Cost and solves of an oracle that picks, per task, the cheapest arm that solved it, against baselines.

    ``rows_by_arm`` maps arm → main-phase rows (any order; arms may cover different task subsets). ``order`` lists the
    arms considered, cheapest first by tier price, e.g. ('F', 'A') on the 50 tasks or ('F', 'A', 'C') on C's 20.
    ``tasks`` is the task set (default: the first baseline arm's tasks); every task must have a row for every baseline
    arm. Per task, only the arms in ``order`` that were run on it are considered (``arms_run``).

    - Choice: the first arm in ``order`` that solved the task. The oracle chooses a *tier* and pays that arm's observed
      cost on the task; it does not pick whichever run happened to be cheapest, which would select on cost noise too.
    - No arm solved it: ``unsolved='cheapest'`` (default) takes the cheapest arm run (first in ``order``): with
      hindsight nothing would have helped, so spend least. ``unsolved='baseline'`` keeps the first baseline's run.
    - ``baselines`` maps a label to an arm (default {'always_sol': 'A'} when A is present), e.g.
      {'always_sol': 'A', 'assessor_choice': 'A'}: in revision 2 the assessor chose standard on every task.

    Returns n, choice_counts, unsolved_tasks, ideal {solved, rate, cost}, per_task [{task_id, choice, resolved,
    cost_usd, arms_run}], and per baseline label: {arm, solved, rate, cost, resolve_diff {diff, ci}, cost_ratio
    {point, ci}} with paired percentile bootstrap CIs over tasks. resolve_diff = (ideal − baseline solves) / n, ≥ 0
    whenever the baseline arm is in ``order``. This is a descriptive upper bound inflated by run-to-run variance (see
    the module docstring); the same call on two Sol arms, e.g. ({'A': a, 'B': b_on_sol}, order=('A', 'B')), measures
    that inflation, since any solve it gains is noise.
    """
    if not order or len(set(order)) != len(order):
        raise ValueError('order must list distinct arms')
    if unsolved not in ('cheapest', 'baseline'):
        raise ValueError("unsolved must be 'cheapest' or 'baseline'")
    missing_arms = [a for a in order if a not in rows_by_arm]
    if missing_arms:
        raise ValueError(f'arms in order without rows: {missing_arms}')
    if baselines is None:
        baselines = {'always_sol': 'A'} if 'A' in rows_by_arm else {}
    if not baselines:
        raise ValueError('at least one baseline arm is required')
    by: dict[str, dict[str, Row]] = {}
    for arm, rows in rows_by_arm.items():
        m: dict[str, Row] = {}
        for r in rows:
            t = r['task_id']
            if t in m:
                raise ValueError(f'arm {arm!r}: duplicate task {t!r}')
            m[t] = r
        by[arm] = m
    for label, arm in baselines.items():
        if arm not in by:
            raise ValueError(f'baseline {label!r}: arm {arm!r} has no rows')
    first_base = next(iter(baselines.values()))
    ids = list(tasks) if tasks is not None else sorted(by[first_base])
    for label, arm in baselines.items():
        gap = [t for t in ids if t not in by[arm]]
        if gap:
            raise ValueError(f'baseline {label!r} (arm {arm!r}) has no row for {len(gap)} task(s), e.g. {gap[0]!r}')

    per_task: list[dict[str, Any]] = []
    i_cost: list[float] = []
    i_solved: list[bool] = []
    for t in ids:
        run = [a for a in order if t in by[a]]
        if not run:
            raise ValueError(f'task {t!r}: none of the arms {list(order)} was run on it')
        won = next((a for a in run if by[a][t]['resolved']), None)
        pick = won if won is not None else (run[0] if unsolved == 'cheapest' else first_base)
        r = by[pick][t]
        i_cost.append(float(r['cost_usd']))
        i_solved.append(bool(r['resolved']))
        per_task.append({'task_id': t, 'choice': pick, 'resolved': bool(r['resolved']), 'cost_usd': float(r['cost_usd']),
                         'arms_run': run})
    n = len(ids)
    counts = {a: 0 for a in order}
    if unsolved == 'baseline' and first_base not in counts:
        counts[first_base] = 0
    for p in per_task:
        counts[p['choice']] += 1
    out: dict[str, Any] = {
        'n': n, 'order': list(order), 'unsolved_rule': unsolved, 'seed': seed, 'n_boot': n_boot,
        'choice_counts': counts, 'unsolved_tasks': sum(1 for x in i_solved if not x),
        'ideal': {'solved': sum(i_solved), 'rate': sum(i_solved) / n if n else None, 'cost': sum(i_cost)},
        'per_task': per_task, 'vs': {},
    }
    for label, arm in baselines.items():
        b_cost = [float(by[arm][t]['cost_usd']) for t in ids]
        b_solved = [bool(by[arm][t]['resolved']) for t in ids]

        def resolve_diff(idx: list[int], b_solved: list[bool] = b_solved) -> float | None:
            return (sum(i_solved[i] for i in idx) - sum(b_solved[i] for i in idx)) / len(idx) if idx else None

        def ratio(idx: list[int], b_cost: list[float] = b_cost) -> float | None:
            den = sum(b_cost[i] for i in idx)
            return sum(i_cost[i] for i in idx) / den if den > 0 else None

        entry: dict[str, Any] = {'arm': arm, 'solved': sum(b_solved), 'rate': sum(b_solved) / n if n else None, 'cost': sum(b_cost)}
        allidx = list(range(n))
        d = resolve_diff(allidx) if n else None
        if d is None:
            entry['resolve_diff'] = {'diff': None, 'ci': None}
        else:
            reps, _ = _bootstrap(n, resolve_diff, seed, n_boot)
            entry['resolve_diff'] = {'diff': d, 'ci': _percentile_ci(reps)}
        p = ratio(allidx) if n else None
        if p is None:
            entry['cost_ratio'] = {'point': None, 'ci': None, 'undefined_reps': None}
        else:
            reps, und = _bootstrap(n, ratio, seed, n_boot)
            entry['cost_ratio'] = {'point': p, 'ci': _percentile_ci(reps), 'undefined_reps': und}
        out['vs'][label] = entry
    return out


# ---------------------------------------------------------------------------------------------------------------------
# §12: run-to-run noise from repeated runs of one arm


def replicate_noise(runs_by_task: dict[str, Sequence[bool]], seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """Run-to-run variance of one arm from repeated runs on the same tasks (the §12 repeat phase, A and F).

    ``runs_by_task`` maps task_id → that arm's resolved outcomes, one per run (main rep 1 plus repeat reps, any order).
    Tasks with fewer than two runs are ignored and counted in ``single_run_tasks``.

    - ``task_flip_rate``: share of tasks whose runs do not all agree, with a Wilson CI (tasks are independent).
      It grows with the number of runs per task, so compare it only across arms with the same run count.
    - ``pair_disagreement``: per task, the share of its run pairs that disagree (unbiased for 2·p·(1 − p), the chance
      that two independent runs of the task differ), averaged with equal weight per task; percentile bootstrap CI
      over tasks. This is the discordance an arm would show against an exact copy of itself, on the scale of
      ``paired_diff``'s ``discordance``: if F vs A discordance is about the mean of A's and F's pair_disagreement,
      most of it is noise. It does not depend on how many runs a task had.
    - ``mean_resolve_rate`` (equal weight per task) and ``mixed_tasks`` (tasks with at least one solve and one fail).
    """
    multi: list[list[bool]] = []
    single = 0
    for rs in runs_by_task.values():
        xs = [bool(x) for x in rs]
        if len(xs) >= 2:
            multi.append(xs)
        else:
            single += 1
    n = len(multi)
    out: dict[str, Any] = {'tasks': n, 'single_run_tasks': single, 'seed': seed, 'n_boot': n_boot,
                           'runs_per_task': _counts(str(len(xs)) for xs in multi)}
    if n == 0:
        out.update({'task_flip_rate': None, 'task_flip_ci': None, 'pair_disagreement': None, 'pair_disagreement_ci': None,
                    'mean_resolve_rate': None, 'mixed_tasks': 0})
        return out
    flips = [len(set(xs)) > 1 for xs in multi]
    dis: list[float] = []
    for xs in multi:
        k, s = len(xs), sum(xs)
        dis.append(s * (k - s) / (k * (k - 1) / 2))

    def mean_dis(idx: list[int]) -> float | None:
        return sum(dis[i] for i in idx) / len(idx) if idx else None

    reps, _ = _bootstrap(n, mean_dis, seed, n_boot)
    out.update({
        'task_flip_rate': sum(flips) / n, 'task_flip_ci': wilson(sum(flips), n),
        'pair_disagreement': sum(dis) / n, 'pair_disagreement_ci': _percentile_ci(reps),
        'mean_resolve_rate': sum(sum(xs) / len(xs) for xs in multi) / n, 'mixed_tasks': sum(flips),
    })
    return out


# ---------------------------------------------------------------------------------------------------------------------
# DeepSWE × Harbor (task 11-05, design §7): several runs per (task, arm)


def _signflip_p(d: Sequence[float], seed: int, n_perm: int) -> float:
    """Two-sided paired randomisation test of mean(d) = 0: under H0 each task's two arms are exchangeable, so each
    per-task difference is equally likely to have either sign. Exact when at most 16 tasks differ, otherwise a seeded
    Monte Carlo estimate with the (count + 1) / (n + 1) correction."""
    nz = [x for x in d if x != 0]
    if not nz:
        return 1.0
    obs = abs(sum(nz)) - 1e-9
    if len(nz) <= 16:
        hits = 0
        for mask in range(1 << len(nz)):
            s = sum(-x if mask >> i & 1 else x for i, x in enumerate(nz))
            hits += abs(s) >= obs
        return hits / (1 << len(nz))
    rng = random.Random(seed)
    hits = sum(abs(sum(x if rng.random() < 0.5 else -x for x in nz)) >= obs for _ in range(n_perm))
    return (hits + 1) / (n_perm + 1)


def paired_mean_diff(runs_a: dict[str, Sequence[bool]], runs_b: dict[str, Sequence[bool]], seed: int = SEED,
                     n_boot: int = N_BOOT, margin: float = NI_MARGIN) -> dict[str, Any]:
    """Resolve-rate difference B − A when each (task, arm) has one or more runs: the primary estimator of design §7.

    ``runs_a`` / ``runs_b`` map task_id → that arm's resolved outcomes (one per run). Only tasks with at least one run
    in both arms are used (``unpaired_tasks`` counts the rest). Per task, d = mean(B runs) − mean(A runs); the estimate
    is the equal-weight mean of d over tasks, so a task counts once however many runs it had, and run counts may
    differ between tasks (for example a repeat on a seeded subset) without biasing the estimate.

    - ``ci``: paired percentile bootstrap over tasks. ``ci_degenerate`` is True when every task has the same d (for
      example every run of both arms agreed), where the bootstrap interval has zero width and says nothing.
    - ``p_signflip``: two-sided randomisation test (exact for ≤ 16 non-zero d); with one run per arm it equals
      ``mcnemar_exact`` on the discordant pairs.
    - ``noninferiority``: as ``noninferiority`` on the bootstrap lower bound.
    - ``rate_a`` / ``rate_b``: equal-weight per-task means; ``discordant_tasks``: tasks with d ≠ 0.
    """
    keys = sorted(t for t in runs_a.keys() & runs_b.keys() if len(runs_a[t]) and len(runs_b[t]))
    unpaired = len(runs_a.keys() | runs_b.keys()) - len(keys)
    ma = [sum(map(bool, runs_a[t])) / len(runs_a[t]) for t in keys]
    mb = [sum(map(bool, runs_b[t])) / len(runs_b[t]) for t in keys]
    d = [y - x for x, y in zip(ma, mb)]
    n = len(keys)
    out: dict[str, Any] = {
        'n': n, 'unpaired_tasks': unpaired, 'seed': seed, 'n_boot': n_boot,
        'runs_a': _counts(str(len(runs_a[t])) for t in keys), 'runs_b': _counts(str(len(runs_b[t])) for t in keys),
    }
    if n == 0:
        out.update({'rate_a': None, 'rate_b': None, 'diff': None, 'ci': None, 'ci_degenerate': None, 'p_signflip': None,
                    'discordant_tasks': 0, 'noninferiority': noninferiority(None, margin)})
        return out

    def mean_d(idx: list[int]) -> float | None:
        return sum(d[i] for i in idx) / len(idx) if idx else None

    reps, _ = _bootstrap(n, mean_d, seed, n_boot)
    ci = _percentile_ci(reps)
    out.update({
        'rate_a': sum(ma) / n, 'rate_b': sum(mb) / n, 'diff': sum(d) / n, 'ci': ci,
        'ci_degenerate': len(set(d)) == 1, 'p_signflip': _signflip_p(d, seed, n_boot),
        'discordant_tasks': sum(1 for x in d if x != 0),
        'noninferiority': noninferiority(ci[0] if ci else None, margin),
    })
    return out


def ideal_router_heldout(runs_by_arm: dict[str, dict[str, Sequence[tuple[bool, float]]]], order: Sequence[str],
                         baseline: str = 'A', seed: int = SEED, n_boot: int = N_BOOT) -> dict[str, Any]:
    """Per-task oracle that chooses on one run and is scored on another, so it no longer gains from lucky runs.

    ``runs_by_arm`` maps arm → task_id → [(resolved, cost_usd), …] in run order; ``order`` lists the arms considered,
    cheapest tier first. A task is used only if every arm in ``order`` and ``baseline`` has at least two runs on it
    (``skipped_tasks`` counts the others). With K = the largest run count among the arms in ``order`` on that task,
    fold f (0 ≤ f < K) chooses, for each arm a with k_a runs, on run f mod k_a and scores on run (f + 1) mod k_a:
    the choice is the first arm in ``order`` whose selection run solved the task, else the cheapest arm. The task's
    value is the mean over its K folds of the scored run's resolved and cost.

    It is what a router with perfect knowledge of one earlier attempt per arm would get, not an achievable router (it
    still needs every arm run on the task), and it sits below the in-sample ``ideal_router`` by roughly the noise
    inflation. The baseline is the per-task mean over all its runs. Returns n, skipped_tasks, choice_share per arm,
    ideal {rate, cost}, and vs_baseline {arm, rate, cost, resolve_diff {diff, ci}, cost_ratio {point, ci}} with
    paired percentile bootstrap CIs over tasks; costs are sums over tasks of per-task means.
    """
    if not order or len(set(order)) != len(order):
        raise ValueError('order must list distinct arms')
    need = list(order) + ([baseline] if baseline not in order else [])
    missing = [a for a in need if a not in runs_by_arm]
    if missing:
        raise ValueError(f'arms without runs: {missing}')
    all_tasks = sorted(set().union(*(runs_by_arm[a].keys() for a in need)))
    keys = [t for t in all_tasks if all(len(runs_by_arm[a].get(t, ())) >= 2 for a in need)]
    n = len(keys)
    share = {a: 0.0 for a in order}
    i_res: list[float] = []
    i_cost: list[float] = []
    b_res: list[float] = []
    b_cost: list[float] = []
    for t in keys:
        runs = {a: list(runs_by_arm[a][t]) for a in need}
        k_max = max(len(runs[a]) for a in order)
        res = cost = 0.0
        for f in range(k_max):
            pick = next((a for a in order if runs[a][f % len(runs[a])][0]), order[0])
            ok, c = runs[pick][(f + 1) % len(runs[pick])]
            res += bool(ok)
            cost += float(c)
            share[pick] += 1 / k_max
        i_res.append(res / k_max)
        i_cost.append(cost / k_max)
        b_res.append(sum(bool(x[0]) for x in runs[baseline]) / len(runs[baseline]))
        b_cost.append(sum(float(x[1]) for x in runs[baseline]) / len(runs[baseline]))
    out: dict[str, Any] = {'n': n, 'skipped_tasks': len(all_tasks) - n, 'order': list(order), 'seed': seed,
                           'n_boot': n_boot, 'choice_share': {a: (v / n if n else None) for a, v in share.items()}}
    if n == 0:
        out.update({'ideal': {'rate': None, 'cost': None}, 'vs_baseline': None})
        return out

    def rdiff(idx: list[int]) -> float | None:
        return sum(i_res[i] - b_res[i] for i in idx) / len(idx) if idx else None

    def ratio(idx: list[int]) -> float | None:
        den = sum(b_cost[i] for i in idx)
        return sum(i_cost[i] for i in idx) / den if den > 0 else None

    all_idx = list(range(n))
    rd_reps, _ = _bootstrap(n, rdiff, seed, n_boot)
    point = ratio(all_idx)
    cr_reps, _ = _bootstrap(n, ratio, seed, n_boot) if point is not None else ([], 0)
    out.update({
        'ideal': {'rate': sum(i_res) / n, 'cost': sum(i_cost)},
        'vs_baseline': {'arm': baseline, 'rate': sum(b_res) / n, 'cost': sum(b_cost),
                        'resolve_diff': {'diff': rdiff(all_idx), 'ci': _percentile_ci(rd_reps)},
                        'cost_ratio': {'point': point, 'ci': _percentile_ci(cr_reps) if point is not None else None}},
    })
    return out
