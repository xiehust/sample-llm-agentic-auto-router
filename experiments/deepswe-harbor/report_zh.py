"""DeepSWE v1.1 × Codex via Harbor: the zh-CN report (P5, design §7). Data JSON plus a Markdown report.

Every statistic comes from ../codex-deepswe/stats.py (the pre-registered functions); the assessor section is
assessor_live.py. This module only selects, aligns and formats. No dataset text: ids, strata, codes and numbers.

  python3 report_zh.py --rows results/merged/rows.jsonl [--strata results/tierpass/strata.json]
                       [--router-logs results/merged/router-logs-*.json ...] [--out results/report] [--include-pilot]
                       [--profile tb21 [--oracle-recheck failed.json] [--compare-with <deepswe>/report-data.json]]

Profile tb21 (Terminal-Bench 2.1, TB design §4.7; 0d §7): rows of schema tbench-harbor-run/v1; 3 runs per arm (no
blind-design split, no S7a/S7b); a run the lookup scanner flagged scores as not resolved in the primary (§7.7) with
the as-graded comparison as the sensitivity; P1-tight (NI at 5 pp) next to 10 pp for P1 and S1 B−C; difficulty strata
(easy+medium / hard) and tier × difficulty; flag rates per arm (Wilson CIs, Fisher A vs B); flaky_env tasks apart;
the post-run oracle sensitivity; the C ≥ 80% premise check; and DeepSWE side by side (§7.11).

Row selection (design §7.4, 0d's notes):
- analysis rows have phase != 'pilot' (in_comparisons alone is not enough: pilot2 rows are in_comparisons=True).
  --include-pilot keeps them, for a dry run of the generator only; the report then says so at the top;
- one row per (pass, arm, task, rep), the latest attempt (keyed by pass, not phase: pilot and pilot2 share a phase);
- scored = final_status 'scored' with a score (the classifier's); everything else is listed, never scored;
- strata are the frozen tier-pass strata (strata.json), never the row's pred_tier (the driver ran without tiers);
- run cost = the proxy ledger's Bedrock cost of the trial (`ledger_usd`); for B plus its router-side assessor calls
  (B is "auto + assessor"; 0d), for every comparison involving B, with B at ledger cost only shown as the variant. If
  any scored B run has no router logs, every B cost falls back to the ledger only and the report says so;
- the §7.4 sensitivity (any arm with ≥ 4 excluded tasks): each run excluded after its reruns or re-verifies (class
  upstream, harness or verifier_infra) counts as a failed run at its cost, for P1 and S1. Cap stops never count;
  other excluded runs (cancelled, unknown action) are listed, never scored;
- C and F reps 4–5 (rep4c, rep5c) were added after an interim look (design §7.5.2, §11). The S1/S2 claims are made
  on the blind-design set (BLIND_REPS: A/B reps 1–5, C/F reps 1–3); the same comparisons on every run are shown next
  to them, labelled, and a claim that differs between the two is flagged (the blind-design claim is kept). S3–S5 use
  every run and carry the label whenever such runs are present. The report header always states the disclosure.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import pathlib
import random
import sys
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Sequence
from typing import Any

import hcommon  # noqa: F401  (puts ../codex-deepswe on sys.path)
import assessor_live
import report as R
import routerlogs
import stats

SCHEMA = 'deepswe-harbor-report/v1'
ARMS = ('A', 'B', 'F', 'C')
LABEL = {'A': 'A（固定 Sol）', 'B': 'B（auto + 评估器）', 'F': 'F（固定 Luna）', 'C': 'C（固定 Astra）'}
PASS_ORDER = ('main', 'rep2', 'rep3', 'rep4', 'rep3c', 'rep5', 'rep4c', 'rep5c')
PLANNED_REPS = {'A': 3, 'B': 3, 'C': 2, 'F': 2}          # S7a: the plan as first registered (A/B/C 3/3/2)
EXTENSION_REPS = (4, 5)                                   # S7b: each arm's reps 4–5 vs its reps 1–3 (all four arms)
BLIND_REPS = {'A': 5, 'B': 5, 'C': 3, 'F': 3}            # §7.5.2 blind-design set: designs fixed before any outcome was seen
CLAIM_KEYS = ('noninferior', 'b_better', 'b_lower_cost', 'b_costs_more', 'b_geq_a_at_lower_cost')
S12 = (('B_vs_C', 'C', 'B'), ('B_vs_F', 'F', 'B'), ('F_vs_A', 'A', 'F'), ('C_vs_A', 'A', 'C'))   # name, x, y: y − x
AFTER_LOOK = '含中期查看之后加入的运行（C/F rep 4–5，design §7.5.2）'
STRATA = ('frontier', 'standard')
EXCLUDED_SENSITIVITY_MIN = 4                              # "more than 3 such tasks" (design §7.4)
RERUN_CLASSES = frozenset({'upstream', 'harness', 'verifier_infra'})   # classify.RERUN_CLASSES: excluded after 2 reruns
Runs = dict[str, list[tuple[bool, float]]]


@dataclasses.dataclass(frozen=True)
class Profile:
    """What differs between the benchmarks' reports (TB design §4.7). DeepSWE's is today's report, unchanged."""
    name: str
    title: str
    run_schema: str
    planned: dict[str, int]          # S7a: the plan as first registered
    blind: dict[str, int]            # the blind-design set (DeepSWE §7.5.2); every run when nothing was added after a look
    interim_disclosure: bool         # the DeepSWE §11 header
    extension: bool                  # S7a/S7b rows (reps beyond the first plan exist)
    ni_tight: float | None = None    # TB §7.2 P1-tight (and S1): NI at 5 pp next to 10 pp
    lookup: bool = False             # TB §7.7: a flagged resolved run is scored not resolved (primary); as graded = sensitivity
    public_ref: str | None = None
    limits: tuple[str, ...] = ()


PROFILES = {
    'deepswe': Profile('deepswe', '# DeepSWE v1.1 × Codex（Harbor）：auto router 实验报告', 'deepswe-harbor-run/v1', PLANNED_REPS, BLIND_REPS, True, True),
    'tb21': Profile('tb21', '# Terminal-Bench 2.1 × Codex（Harbor）：auto router 实验报告', 'tbench-harbor-run/v1',
                    {a: 3 for a in ARMS}, {a: 3 for a in ARMS}, False, False, ni_tight=0.05, lookup=True,
                    public_ref='TB 2.1 公开排行榜：GPT-6 Astra + Codex 87.4%（effort high，k = 5；TB design §7.1），仅作参考，不参与任何判定。',
                    limits=('- 任务容器可以访问互联网（只允许 TCP 80/443 到公网 IPv4，DNS 只到 VPC 解析器；TB design §4.2）；'
                            '其他端口和协议被拒绝。oracle 检查已在同样的规则下通过，被丢弃的任务单独列出。',
                            '- verifier 与 agent 在同一个容器里运行（TB 的设定，与公开排行榜相同）：agent 能改变 verifier 的环境，对每个臂都一样。',
                            '- 查找检查（§7.7）只看 Codex 的命令日志：编码或混淆过的下载、以及 agent 没有在命令里写出的程序的下载都看不到；'
                            '网络连接日志没有主机名，只作描述。')),
}


# ---------------------------------------------------------------------------------------------------------------------
# Selection


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]


def load_strata(path: pathlib.Path | None) -> dict[str, dict[str, Any]] | None:
    if path is None:
        return None
    return {t: {'stratum': x['stratum'], 'stable': bool(x['stable'])} for t, x in json.loads(path.read_text())['tasks'].items()}


def _pass_rank(p: str) -> tuple[int, str]:
    return (PASS_ORDER.index(p), p) if p in PASS_ORDER else (len(PASS_ORDER), p)


def latest(rows: Iterable[dict[str, Any]]) -> dict[tuple, dict[str, Any]]:
    """One row per (pass, arm, task, rep): the highest attempt (harvest already emits one per key)."""
    out: dict[tuple, dict[str, Any]] = {}
    for r in sorted(rows, key=lambda r: int(r.get('attempt') or 1)):
        out[(r['pass'], r['arm'], r['task_id'], int(r.get('rep') or 1))] = r
    return out


def select(rows: Iterable[dict[str, Any]], include_pilot: bool = False, schema: str = 'deepswe-harbor-run/v1') -> list[dict[str, Any]]:
    keep = [r for r in rows if r.get('schema') == schema and (include_pilot or r.get('phase') != 'pilot')]
    return sorted(latest(keep).values(), key=lambda r: (r['arm'], r['task_id'], int(r.get('rep') or 1), _pass_rank(r['pass'])))


def is_scored(r: dict[str, Any]) -> bool:
    return r.get('final_status') == 'scored' and bool(r.get('in_comparisons')) and r.get('score') is not None


def rep(r: dict[str, Any]) -> int:
    return int(r.get('rep') or 1)


def blind(r: dict[str, Any]) -> bool:
    """In the §7.5.2 blind-design set (the run's design was fixed before any per-arm outcome was seen)."""
    return rep(r) <= BLIND_REPS.get(r['arm'], 0)


def cost(r: dict[str, Any]) -> float:
    return float(r.get('ledger_usd') or 0.0)


def graded(r: dict[str, Any]) -> bool:
    return bool(r['resolved'])


def lookup_primary(r: dict[str, Any]) -> bool:
    """TB §7.7 primary: a run the lookup scanner flagged counts as not resolved (never excluded; its cost counts)."""
    return bool(r['resolved']) and not bool((r.get('lookup') or {}).get('flag'))


def runs(rows: Iterable[dict[str, Any]], arm: str, keep: Callable[[dict[str, Any]], bool] = lambda r: True,
         extra: dict[str, float] | None = None, ok: Callable[[dict[str, Any]], bool] | None = None) -> Runs:
    """task → [(resolved, cost)] for one arm's scored runs, in (rep, pass) order. `extra` adds per-run cost (e.g. the
    assessor's, by run_id); `ok` decides what counts as resolved (default: as graded)."""
    okf = ok or graded
    out: Runs = defaultdict(list)
    for r in sorted(rows, key=lambda r: (int(r.get('rep') or 1), _pass_rank(r['pass']))):
        if r['arm'] == arm and is_scored(r) and keep(r):
            out[r['task_id']].append((okf(r), cost(r) + (extra or {}).get(r['run_id'], 0.0)))
    return dict(out)


def _ok(rs: Runs) -> dict[str, list[bool]]:
    return {t: [x for x, _ in v] for t, v in rs.items()}


def _mean_cost(rs: Runs, tasks: Sequence[str]) -> list[float]:
    return [sum(c for _, c in rs[t]) / len(rs[t]) for t in tasks]


# ---------------------------------------------------------------------------------------------------------------------
# Comparisons


def compare(rx: Runs, ry: Runs, tasks: set[str] | None = None, seed: int = stats.SEED, n_boot: int = stats.N_BOOT) -> dict[str, Any]:
    """y − x: paired_mean_diff on resolves and ΣY/ΣX of per-task mean costs, on tasks with ≥ 1 scored run in both."""
    if tasks is not None:
        rx = {t: v for t, v in rx.items() if t in tasks}
        ry = {t: v for t, v in ry.items() if t in tasks}
    common = sorted(t for t in rx.keys() & ry.keys() if rx[t] and ry[t])
    return {'resolve': stats.paired_mean_diff(_ok(rx), _ok(ry), seed=seed, n_boot=n_boot),
            'cost': stats.cost_ratio(_mean_cost(rx, common), _mean_cost(ry, common), seed=seed, n_boot=n_boot),
            'tasks': len(common)}


def claims(p: dict[str, Any]) -> dict[str, Any]:
    """The pre-registered P1/P2 claims (design §7.2). Never 'equivalent'."""
    r, c = p['resolve'], p['cost']['ratio_of_sums']
    ni = r['noninferiority']['noninferior']
    ci, cci = r.get('ci'), c.get('ci')
    out = {'noninferior': ni, 'b_better': bool(ci and ci[0] > 0), 'b_lower_cost': bool(cci and cci[1] < 1),
           'b_costs_more': bool(cci and cci[0] > 1), 'ci_degenerate': r.get('ci_degenerate')}
    out['b_geq_a_at_lower_cost'] = bool(ni) and out['b_lower_cost']
    if out['ci_degenerate']:     # a zero-width interval says nothing (tiny n): no claim is made
        out.update({k: None for k in ('noninferior', 'b_better', 'b_geq_a_at_lower_cost')})
    return out


def claims_differ(a: dict[str, Any], b: dict[str, Any]) -> list[str]:
    """The claim keys on which two claim sets disagree (§7.5.2: blind-design vs every run)."""
    return [k for k in CLAIM_KEYS if a.get(k) != b.get(k)]


def decomposition(rx: Runs, ry: Runs, strata: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """y − x = Σ w_s Δ_s over the strata, with w_s = the stratum's share of the paired tasks (exact for equal weights)."""
    common = [t for t in rx.keys() & ry.keys() if rx[t] and ry[t] and t in strata]
    d = {t: sum(ok for ok, _ in ry[t]) / len(ry[t]) - sum(ok for ok, _ in rx[t]) / len(rx[t]) for t in common}
    out: dict[str, Any] = {'n': len(common), 'by_stratum': {}}
    total = 0.0
    for s in STRATA:
        ts = [t for t in common if strata[t]['stratum'] == s]
        if not ts:
            continue
        w, delta = len(ts) / len(common), sum(d[t] for t in ts) / len(ts)
        out['by_stratum'][s] = {'n': len(ts), 'weight': w, 'diff': delta, 'contribution': w * delta}
        total += w * delta
    out['total'] = total if common else None
    return out


def interaction(rx: Runs, ry: Runs, strata: dict[str, dict[str, Any]], seed: int = stats.SEED,
                n_boot: int = stats.N_BOOT) -> dict[str, Any]:
    """(y − x | frontier) − (y − x | standard), bootstrap within strata. Descriptive (design §7.2 S4)."""
    d: dict[str, list[float]] = {s: [] for s in STRATA}
    for t in sorted(rx.keys() & ry.keys()):
        if rx[t] and ry[t] and t in strata and strata[t]['stratum'] in d:
            d[strata[t]['stratum']].append(sum(ok for ok, _ in ry[t]) / len(ry[t]) - sum(ok for ok, _ in rx[t]) / len(rx[t]))
    f, s = d['frontier'], d['standard']
    out: dict[str, Any] = {'n_frontier': len(f), 'n_standard': len(s), 'seed': seed, 'n_boot': n_boot}
    if not f or not s:
        return {**out, 'diff': None, 'ci': None}
    rng = random.Random(seed)
    reps = []
    for _ in range(n_boot):
        bf = [f[rng.randrange(len(f))] for _ in f]
        bs = [s[rng.randrange(len(s))] for _ in s]
        reps.append(sum(bf) / len(bf) - sum(bs) / len(bs))
    return {**out, 'diff': sum(f) / len(f) - sum(s) / len(s), 'ci': stats._percentile_ci(reps)}


def run1_only(rows: list[dict[str, Any]], x: str, y: str, ok: Callable[[dict[str, Any]], bool] | None = None) -> dict[str, Any]:
    """Sensitivity next to P1: the first run only (rep 1), `paired_diff` (Newcombe + McNemar), comparable with R2E."""
    one = {arm: {t: v[0][0] for t, v in runs(rows, arm, lambda r: int(r.get('rep') or 1) == 1, ok=ok).items()} for arm in (x, y)}
    ts = sorted(one[x].keys() & one[y].keys())
    return stats.paired_diff([one[x][t] for t in ts], [one[y][t] for t in ts])


def excluded_runs(rows: list[dict[str, Any]], extra: dict[str, dict[str, float]] | None = None,
                  keep: Callable[[dict[str, Any]], bool] = lambda r: True
                  ) -> tuple[dict[str, list[tuple[str, float]]], dict[str, list[str]]]:
    """Per arm, (task, cost) of each run excluded after exhausting its reruns or re-verifies (class upstream, harness
    or verifier_infra: the design §7.4 rule), and, listed apart and never scored, the run ids of any other excluded
    run that is not a cap stop (cancelled, or the driver's unknown-action fallback). Cap stops are never outcomes."""
    out: dict[str, list[tuple[str, float]]] = defaultdict(list)
    other: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        if r.get('final_status') != 'excluded' or r.get('class') == 'cap_stop' or not keep(r):
            continue
        if r.get('class') in RERUN_CLASSES:
            out[r['arm']].append((r['task_id'], cost(r) + ((extra or {}).get(r['arm']) or {}).get(r['run_id'], 0.0)))
        else:
            other[r['arm']].append(r['run_id'])
    return dict(out), {a: sorted(v) for a, v in other.items()}


def with_failures(rs: Runs, failed: Iterable[tuple[str, float]]) -> Runs:
    """The design §7.4 sensitivity: each excluded run counted as a failed run (at the cost it incurred)."""
    out = {t: list(v) for t, v in rs.items()}
    for t, c in failed:
        out.setdefault(t, []).append((False, c))
    return out


def reconcile(rows: list[dict[str, Any]], join: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Proxy ledger vs the router's own cost (model calls only) per scored run: they should agree closely."""
    rel = sorted(abs(cost(r) - float(join[r['run_id']].get('router_cost_usd') or 0.0)) / cost(r)
                 for r in rows if is_scored(r) and r['run_id'] in join and cost(r) > 0)
    return {'runs': len(rel), 'rel_diff_p50': R._q(rel, 0.5), 'rel_diff_max': rel[-1] if rel else None,
            'over_2pct': sum(1 for x in rel if x > 0.02)}


# ---------------------------------------------------------------------------------------------------------------------
# Descriptive


def _usage(rs: list[dict[str, Any]]) -> dict[str, int]:
    u: Counter[str] = Counter()
    for r in rs:
        for k, v in ((r.get('calls') or {}).get('usage') or {}).items():
            u[k] += int(v or 0)
    return dict(u)


def arm_table(rows: list[dict[str, Any]], all_rows: list[dict[str, Any]], seed: int, n_boot: int,
              extra: dict[str, dict[str, float]] | None = None, ok: Callable[[dict[str, Any]], bool] | None = None) -> dict[str, Any]:
    okf = ok or graded
    out: dict[str, Any] = {}
    for arm in ARMS:
        mine = [r for r in rows if r['arm'] == arm and is_scored(r)]
        if not mine and not any(r['arm'] == arm for r in all_rows):
            continue
        ex = (extra or {}).get(arm) or {}
        def rc(r: dict[str, Any], ex: dict[str, float] = ex) -> float:
            return cost(r) + ex.get(r['run_id'], 0.0)
        rs = runs(rows, arm, extra=ex, ok=ok)
        per_task = [sum(x for x, _ in v) / len(v) for v in rs.values()]
        u = _usage(mine)
        out[arm] = {
            'scored_runs': len(mine), 'tasks': len(rs), 'runs_per_task': dict(Counter(str(len(v)) for v in rs.values())),
            'rate': sum(per_task) / len(per_task) if per_task else None,
            'sum_cost': round(sum(rc(r) for r in mine), 6),
            'mean_cost': sum(rc(r) for r in mine) / len(mine) if mine else None,
            'usd_per_solved': stats.usd_per_solved([rc(r) for r in mine], [okf(r) for r in mine], seed=seed, n_boot=n_boot),
            'usage': u, 'cache_read_share': u.get('read', 0) / u['prompt'] if u.get('prompt') else None,
            'exit_reason': dict(Counter(str(r.get('exit_reason')) for r in mine)),
            'status': dict(Counter(f"{r.get('final_status')}:{r.get('class')}" for r in all_rows if r['arm'] == arm)),
            'reruns': sum(int(r.get('attempt') or 1) - 1 for r in all_rows if r['arm'] == arm),
            'sut': sorted(r['run_id'] for r in mine if r.get('class') == 'sut'),
            'codex_min_p50': R._q([float(r['codex_secs']) / 60 for r in mine if r.get('codex_secs') is not None], 0.5),
            'codex_min_max': max((float(r['codex_secs']) / 60 for r in mine if r.get('codex_secs') is not None), default=None),
        }
    return out


def served_share(rows: list[dict[str, Any]], arm: str = 'B') -> dict[str, Any]:
    """B's prompt-token share by served model, and the runs that were served by more than one model."""
    tok: Counter[str] = Counter()
    dom: Counter[str] = Counter()
    multi = []
    for r in rows:
        if r['arm'] != arm or not is_scored(r):
            continue
        tbm = r.get('tokens_by_model') or {}
        for m, x in tbm.items():
            tok[m] += int(x.get('prompt') or 0)
        if tbm:
            dom[max(tbm, key=lambda m: int(tbm[m].get('prompt') or 0))] += 1
        if len(tbm) > 1:
            multi.append(r['run_id'])
    total = sum(tok.values())
    return {'prompt_share': {m: v / total for m, v in tok.most_common()} if total else {}, 'dominant_model_runs': dict(dom),
            'multi_model_runs': sorted(multi)}


def per_runner(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in sorted({r.get('runner') for r in rows}, key=str):
        mine = [r for r in rows if r.get('runner') == k]
        sc = [r for r in mine if is_scored(r)]
        out[str(k)] = {'rows': len(mine), 'scored': len(sc), 'resolved': sum(1 for r in sc if r['resolved']),
                       'cost_usd': round(sum(cost(r) for r in mine), 4),
                       'trial_hours': round(sum(float(r.get('wall_s') or 0) for r in mine) / 3600, 2)}
    return out


def live_tier_flips(rows: list[dict[str, Any]], join: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """S5 for B: across a task's B runs, does the assessor's live tier change? (tasks with ≥ 2 logged runs)"""
    by: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        if r['arm'] == 'B' and is_scored(r) and r['run_id'] in join:
            by[r['task_id']].append(str(join[r['run_id']].get('assessor_tier') or 'none'))
    multi = [v for v in by.values() if len(v) >= 2]
    flips = sum(1 for v in multi if len(set(v)) > 1)
    return {'tasks': len(multi), 'flipped': flips, 'rate': flips / len(multi) if multi else None,
            'ci': stats.wilson(flips, len(multi)) if multi else None}


# ---------------------------------------------------------------------------------------------------------------------
# Build


def build(all_rows: list[dict[str, Any]], strata: dict[str, dict[str, Any]] | None = None,
          router_records: list[dict[str, Any]] | None = None, include_pilot: bool = False, strata_dir: pathlib.Path | None = None,
          seed: int = stats.SEED, n_boot: int = stats.N_BOOT, profile: str = 'deepswe', oracle_failed: Iterable[str] | None = None,
          compare_with: dict[str, Any] | None = None) -> dict[str, Any]:
    P = PROFILES[profile]
    okf = lookup_primary if P.lookup else None
    in_blind = blind if P.name == 'deepswe' else (lambda r: rep(r) <= P.blind.get(r['arm'], 0))
    rows = select(all_rows, include_pilot, P.run_schema)
    scored = [r for r in rows if is_scored(r)]
    # Router logs first: B's run cost includes its assessor calls (0d) when every scored B run has router logs
    join: dict[str, dict[str, Any]] = {}
    a_cost: dict[str, float] = {}
    if router_records is not None:
        gw = {r['run_id']: int((r.get('calls') or {}).get('responses_calls') or 0) for r in rows}
        join = routerlogs.join(router_records, [r['run_id'] for r in rows], gw)
        a_cost = {rid: float(j.get('assessor_cost_usd') or 0.0) for rid, j in join.items()}
    b_scored = [r for r in scored if r['arm'] == 'B']
    b_missing = sum(1 for r in b_scored if r['run_id'] not in join)
    with_assessor = router_records is not None and b_missing == 0
    extra = {'B': a_cost} if with_assessor else {}
    rs = {a: runs(rows, a, extra=extra.get(a), ok=okf) for a in ARMS}
    bl = {a: runs(rows, a, in_blind, extra=extra.get(a), ok=okf) for a in ARMS}     # §7.5.2 blind-design set
    after = [r for r in rows if not in_blind(r)]
    cmp_ = lambda x, y, **kw: compare(rs[x], rs[y], seed=seed, n_boot=n_boot, **kw)  # noqa: E731
    data: dict[str, Any] = {
        'schema': SCHEMA, 'seed': seed, 'n_boot': n_boot, 'include_pilot': include_pilot,
        'rows': {'input': len(all_rows), 'selected': len(rows), 'scored': len(scored),
                 'dropped_pilot_phase': 0 if include_pilot else sum(1 for r in all_rows if r.get('phase') == 'pilot'),
                 'by_pass': dict(Counter(f"{r['pass']}:{r['arm']}" for r in rows)),
                 'not_scored': dict(Counter(f"{r.get('final_status')}:{r.get('class')}" for r in rows if not is_scored(r)))},
        'tasks': len({r['task_id'] for r in scored}),
        'cost_basis': {'B': 'ledger+assessor' if with_assessor else 'ledger', 'others': 'ledger',
                       'b_runs_without_router_logs': b_missing if b_scored else 0, 'fell_back': not with_assessor},
        'interim_look': {'blind_reps': dict(P.blind), 'present': bool(after), 'runs_after_look': dict(Counter(r['arm'] for r in after)),
                         'scored_runs_after_look': dict(Counter(r['arm'] for r in after if is_scored(r)))},
    }
    # P1 / P2 and their sensitivities
    p1 = cmp_('A', 'B')
    data['primary'] = {'B_vs_A': p1, 'claims': claims(p1), 'run1_only': run1_only(rows, 'A', 'B', okf)}
    planned = {a: runs(rows, a, lambda r, a=a: int(r.get('rep') or 1) <= P.planned[a], extra=extra.get(a), ok=okf) for a in ARMS}
    data['primary']['s7a_reps_1_3'] = compare(planned['A'], planned['B'], seed=seed, n_boot=n_boot)
    if with_assessor:     # the variant: B at its ledger cost only
        led_b = runs(rows, 'B')
        data['primary']['B_vs_A_ledger_only'] = compare(rs['A'], led_b, seed=seed, n_boot=n_boot)['cost']
        data['secondary_ledger_only'] = {'B_vs_C': compare(bl['C'], runs(rows, 'B', in_blind, ok=okf), seed=seed, n_boot=n_boot)['cost']}   # blind
    exc, exc_other = excluded_runs(rows, extra)
    data['excluded_tasks'] = {a: sorted({t for t, _ in v}) for a, v in exc.items()}
    data['excluded_other_runs'] = exc_other
    sens = any(len(v) >= EXCLUDED_SENSITIVITY_MIN for v in data['excluded_tasks'].values())
    fail = {a: with_failures(rs[a], exc.get(a, ())) for a in ARMS} if sens else {}
    exc_bl = excluded_runs(rows, extra, in_blind)[0] if sens else {}
    fail_bl = {a: with_failures(bl[a], exc_bl.get(a, ())) for a in ARMS} if sens else {}
    if sens:
        data['primary']['excluded_as_failures'] = compare(fail['A'], fail['B'], seed=seed, n_boot=n_boot)
    if router_records is not None:
        data['router_logs'] = {
            'records': len(router_records), 'runs_joined': len(join), 'runs_complete': sum(1 for j in join.values() if j.get('complete')),
            'failovers_by_arm': {a: sum(len(join[r['run_id']].get('failovers') or []) for r in scored if r['arm'] == a and r['run_id'] in join)
                                 for a in ARMS},
            'assessor_cost_usd': round(sum(a_cost.values()), 6), 'ledger_vs_router_cost': reconcile(rows, join)}
        # assessor_live keys on phase; pass the pass as the phase so pilot and pilot2 rows stay apart (0d note c)
        # The assessor section scores outcomes like the primary (TB §7.7: flagged + resolved → unresolved; 0d)
        al_rows = [{'run_id': r['run_id'], 'arm': r['arm'], 'task_id': r['task_id'], 'resolved': okf(r) if okf else bool(r['resolved']),
                    'rep': int(r.get('rep') or 1), 'attempt': int(r.get('attempt') or 1), 'cost_usd': cost(r),
                    'exit_reason': r.get('exit_reason'), 'phase': r['pass']} for r in scored]
        data['assessor'] = assessor_live.build(al_rows, join, step1_dir=strata_dir, excluded=())
        data['noise_b_live_tier'] = live_tier_flips(rows, join)
    # S1 / S2: claims on the blind-design set (§7.5.2); every run shown next to them, and claim mismatches flagged
    sec: dict[str, Any] = {'s7a_B_vs_C': compare(planned['C'], planned['B'], seed=seed, n_boot=n_boot), 'all_runs': {}, 'claims': {}}
    for name, x, y in S12:
        sec[name] = compare(bl[x], bl[y], seed=seed, n_boot=n_boot)
        sec['all_runs'][name] = cmp_(x, y)
        cb, ca = claims(sec[name]), claims(sec['all_runs'][name])
        sec['claims'][name] = {'blind': cb, 'all_runs': ca, 'differ': claims_differ(cb, ca)}
    sec['claims_differ'] = [name for name, _, _ in S12 if sec['claims'][name]['differ']]
    if sens:
        sec['B_vs_C_excluded_as_failures'] = compare(fail_bl['C'], fail_bl['B'], seed=seed, n_boot=n_boot)
        sec['all_runs']['B_vs_C_excluded_as_failures'] = compare(fail['C'], fail['B'], seed=seed, n_boot=n_boot)
    data['secondary'] = sec
    # S3: ideal per-task router over {F, A, C}
    heldout = stats.ideal_router_heldout({a: rs[a] for a in ('F', 'A', 'C')}, ('F', 'A', 'C'), 'A', seed=seed, n_boot=n_boot)
    one = {a: {t: v[0] for t, v in runs(rows, a, lambda r: int(r.get('rep') or 1) == 1, ok=okf).items()} for a in ('F', 'A', 'C')}
    t1 = sorted(set.intersection(*(set(one[a]) for a in one)))
    insample = None
    if t1:
        flat = {a: [{'task_id': t, 'resolved': one[a][t][0], 'cost_usd': one[a][t][1]} for t in t1] for a in one}
        insample = stats.ideal_router(flat, ('F', 'A', 'C'), {'always_sol': 'A'}, tasks=t1, seed=seed, n_boot=n_boot)
        insample.pop('per_task', None)
    ho_tasks = [t for t in rs['B'] if all(len(rs[a].get(t, ())) >= 2 for a in ('F', 'A', 'C'))]
    b_on = {'n': len(ho_tasks),
            'rate': sum(sum(ok for ok, _ in rs['B'][t]) / len(rs['B'][t]) for t in ho_tasks) / len(ho_tasks) if ho_tasks else None,
            'cost': sum(_mean_cost(rs['B'], ho_tasks)) if ho_tasks else None}
    data['ideal'] = {'heldout': heldout, 'insample_run1': insample, 'B_on_heldout_tasks': b_on}
    # S4: by the frozen tier-pass strata
    if strata is not None:
        st: dict[str, Any] = {}
        for label, keep in (('all', lambda x: True), ('stable', lambda x: x['stable'])):
            st[label] = {}
            for s in STRATA:
                ts = {t for t, x in strata.items() if x['stratum'] == s and keep(x)}
                st[label][s] = {name: cmp_(x, y, tasks=ts) for name, (x, y) in
                                (('B_vs_A', ('A', 'B')), ('B_vs_C', ('C', 'B')), ('C_vs_A', ('A', 'C')))}
        missing = sorted({r['task_id'] for r in scored} - strata.keys())
        data['strata'] = {'counts': dict(Counter(x['stratum'] for x in strata.values())), 'stable': sum(x['stable'] for x in strata.values()),
                          'tasks_without_stratum': missing, 'by_stratum': st,
                          'decomposition_B_vs_A': decomposition(rs['A'], rs['B'], strata),
                          'decomposition_C_vs_A': decomposition(rs['A'], rs['C'], strata),
                          'assessor_skill_C_vs_A': interaction(rs['A'], rs['C'], strata, seed, n_boot)}
    # S5 / S6 / S7b
    data['noise'] = {a: stats.replicate_noise(_ok(rs[a]), seed=seed, n_boot=n_boot) for a in ARMS}
    data['arms'] = arm_table(rows, rows, seed, n_boot, extra, okf)
    data['served_B'] = served_share(rows)
    data['runners'] = per_runner(rows)
    early = {a: runs(rows, a, lambda r: rep(r) <= 3, ok=okf) for a in ARMS}
    late = {a: runs(rows, a, lambda r: rep(r) in EXTENSION_REPS, ok=okf) for a in ARMS}
    data['s7b_drift'] = {a: stats.paired_mean_diff(_ok(early[a]), _ok(late[a]), seed=seed, n_boot=n_boot) for a in ARMS}
    if P.name != 'deepswe':
        data['profile'] = P.name
        data['tb'] = tb_extras(rows, rs, extra, strata, P, seed, n_boot, oracle_failed, compare_with, data)
    return data


# ---------------------------------------------------------------------------------------------------------------------
# Terminal-Bench 2.1 additions (TB design §4.7; 0d §7.2, §7.5, §7.7, §7.8, §7.11)


def fisher_two_sided(a: int, b: int, c: int, d: int) -> float | None:
    """Two-sided Fisher exact p for the 2×2 table [[a, b], [c, d]] (sum of tables no more likely than the observed)."""
    n1, n2, k = a + b, c + d, a + c
    if n1 == 0 or n2 == 0:
        return None
    tot = math.comb(n1 + n2, k)

    def pr(x: int) -> float:
        return math.comb(n1, x) * math.comb(n2, k - x) / tot
    obs = pr(a)
    return min(1.0, sum(pr(x) for x in range(max(0, k - n2), min(k, n1) + 1) if pr(x) <= obs * (1 + 1e-9)))


def lookup_flags(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """S6 (§7.7): per arm, flag rates over scored runs (L1 and L2 apart, Wilson CIs), flagged resolved runs, and runs
    without a rollout to scan; the A-vs-B difference in flag rate (two-sided Fisher, descriptive)."""
    out: dict[str, Any] = {}
    for a in ARMS:
        mine = [r for r in rows if r['arm'] == a and is_scored(r)]
        if not mine:
            continue
        lk = [r.get('lookup') or {} for r in mine]
        n = len(mine)
        f1, f2, f = (sum(1 for x in lk if x.get(k)) for k in ('flag_l1', 'flag_l2', 'flag'))
        out[a] = {'runs': n, 'flag_l1': f1, 'flag_l2': f2, 'flag': f, 'flag_rate': f / n,
                  'flag_l1_ci': stats.wilson(f1, n), 'flag_l2_ci': stats.wilson(f2, n), 'flag_ci': stats.wilson(f, n),
                  'flagged_resolved': sum(1 for r, x in zip(mine, lk, strict=True) if x.get('flag') and r['resolved']),
                  'not_scanned': sum(1 for x in lk if not x or x.get('source') == 'missing'),
                  'net_config_touched': sum(1 for x in lk if x.get('net_config_touched')),
                  'model_api_runs': sum(1 for x in lk if (x.get('evidence') or {}).get('X_model_api'))}
    a, b = out.get('A'), out.get('B')
    fisher = fisher_two_sided(a['flag'], a['runs'] - a['flag'], b['flag'], b['runs'] - b['flag']) if a and b else None
    return {'by_arm': out, 'over_5pct': sorted(k for k, v in out.items() if v['flag_rate'] > 0.05), 'fisher_A_vs_B': fisher}


def _difficulty_strata(rows: list[dict[str, Any]]) -> dict[str, str]:
    """task → 'easy+medium' | 'hard' (TB author difficulty; easy has 4 tasks, merged with medium: §7.8)."""
    out: dict[str, str] = {}
    for r in rows:
        d = (r.get('tb') or {}).get('difficulty')
        if d in ('easy', 'medium', 'hard'):
            out[r['task_id']] = 'hard' if d == 'hard' else 'easy+medium'
    return out


def _arm_rate(rs: Runs, tasks: set[str]) -> float | None:
    v = [sum(x for x, _ in rs[t]) / len(rs[t]) for t in tasks if rs.get(t)]
    return sum(v) / len(v) if v else None


def _summary_of(x: dict[str, Any], tight: dict[str, Any] | None = None) -> dict[str, Any]:
    r = x['resolve']
    c = claims(x)
    return {'diff': r.get('diff'), 'ci': r.get('ci'), 'n': r.get('n'), 'ni10': c['noninferior'],
            'ni5': None if tight is None else tight['noninferiority']['noninferior'],
            'cost_ratio': (x['cost'].get('ratio_of_sums') or {}).get('point'), 'cost_ci': (x['cost'].get('ratio_of_sums') or {}).get('ci'),
            'claims': {k: c[k] for k in CLAIM_KEYS}}


def side_by_side(tb: dict[str, Any], ds: dict[str, Any]) -> dict[str, Any]:
    """§7.11: the same rows per benchmark, agreement in direction and claim, and a descriptive equal-weight average
    (CI from the two independent intervals, normal approximation). No pooled claim."""
    def ds_row(name: str) -> dict[str, Any] | None:
        if name == 'B_vs_A':
            x = (ds.get('primary') or {}).get('B_vs_A')
        else:
            x = (ds.get('secondary') or {}).get(name)
        return _summary_of(x) if x else None
    rows = {}
    for name in ('B_vs_A', 'B_vs_C', 'C_vs_A', 'F_vs_A'):
        t, d = tb.get(name), ds_row(name)
        if not t or not d:
            continue
        both = {}
        if t['ci'] and d['ci'] and t['diff'] is not None and d['diff'] is not None:
            se = math.sqrt(((t['ci'][1] - t['ci'][0]) / 3.92) ** 2 + ((d['ci'][1] - d['ci'][0]) / 3.92) ** 2) / 2
            avg = (t['diff'] + d['diff']) / 2
            both = {'avg': avg, 'ci': (avg - 1.96 * se, avg + 1.96 * se)}
        rows[name] = {'tb': t, 'deepswe': d, 'same_direction': (t['diff'] or 0) * (d['diff'] or 0) > 0 if t['diff'] and d['diff'] else None,
                      'claims_agree': t['claims'] == d['claims'], 'claims_differ': claims_differ(t['claims'], d['claims']), 'both_descriptive': both}
    return rows


def tb_extras(rows: list[dict[str, Any]], rs: dict[str, Runs], extra: dict[str, dict[str, float]], strata: dict[str, dict[str, Any]] | None,
              P: Profile, seed: int, n_boot: int, oracle_failed: Iterable[str] | None, compare_with: dict[str, Any] | None,
              data: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {'public_ref': P.public_ref}
    g = {a: runs(rows, a, extra=extra.get(a)) for a in ARMS}          # as graded (the §7.7 sensitivity)
    m = P.ni_tight or stats.NI_MARGIN
    p1, s1 = data['primary']['B_vs_A'], data['secondary']['B_vs_C']
    tight = {'B_vs_A': stats.paired_mean_diff(_ok(rs['A']), _ok(rs['B']), seed=seed, n_boot=n_boot, margin=m),
             'B_vs_C': stats.paired_mean_diff(_ok(rs['C']), _ok(rs['B']), seed=seed, n_boot=n_boot, margin=m)}
    out['ni_tight'] = {'margin': m, **{k: {'resolve': v, 'claims': claims({'resolve': v, 'cost': (p1 if k == 'B_vs_A' else s1)['cost']})}
                                       for k, v in tight.items()}}
    sens = {'B_vs_A': compare(g['A'], g['B'], seed=seed, n_boot=n_boot), 'B_vs_C': compare(g['C'], g['B'], seed=seed, n_boot=n_boot)}
    out['as_graded'] = {k: {**v, 'claims': claims(v), 'differ': claims_differ(claims(v), claims(p1 if k == 'B_vs_A' else s1))}
                        for k, v in sens.items()}
    out['lookup'] = lookup_flags(rows)
    # difficulty strata (§7.8, descriptive) and the tier × difficulty table
    dmap = _difficulty_strata(rows)
    out['difficulty'] = {'counts': dict(Counter(dmap.values())), 'by_stratum': {
        s: {name: compare(rs[x], rs[y], {t for t, v in dmap.items() if v == s}, seed=seed, n_boot=n_boot)
            for name, (x, y) in (('B_vs_A', ('A', 'B')), ('C_vs_A', ('A', 'C')))} for s in ('easy+medium', 'hard')}}
    if strata is not None:
        out['tier_by_difficulty'] = dict(Counter(f"{strata[t]['stratum']}|{d}" for t, d in dmap.items() if t in strata))
    # flaky-env tasks (§7.5): reported apart
    flaky = sorted({r['task_id'] for r in rows if r.get('flaky_env')})
    others = {r['task_id'] for r in rows} - set(flaky)
    out['flaky_env'] = {'tasks': flaky, 'rate_on_flaky': {a: _arm_rate(rs[a], set(flaky)) for a in ARMS},
                        'rate_on_others': {a: _arm_rate(rs[a], others) for a in ARMS}}
    # post-run oracle re-check (§7.5): P1 and S1 without the tasks whose oracle failed after the run
    if oracle_failed is not None:
        bad = set(oracle_failed)
        keep = {t for t in rs['A'].keys() | rs['B'].keys() | rs['C'].keys()} - bad
        out['oracle_recheck'] = {'failed_tasks': sorted(bad), 'B_vs_A': compare(rs['A'], rs['B'], keep, seed=seed, n_boot=n_boot),
                                 'B_vs_C': compare(rs['C'], rs['B'], keep, seed=seed, n_boot=n_boot)}
    # premise check (§7.2): C's run-1 rate as graded near the public 87.4 %; below 80 % flags an environment problem
    c1 = [v[0][0] for v in runs(rows, 'C', lambda r: rep(r) == 1).values() if v]
    rate = sum(c1) / len(c1) if c1 else None
    out['premise'] = {'C_run1_rate': rate, 'tasks': len(c1), 'threshold': 0.80, 'flag': rate is not None and rate < 0.80}
    if compare_with is not None:
        tbs = {'B_vs_A': _summary_of(p1, tight['B_vs_A']), 'B_vs_C': _summary_of(s1, tight['B_vs_C']),
               'C_vs_A': _summary_of(data['secondary']['C_vs_A']), 'F_vs_A': _summary_of(data['secondary']['F_vs_A'])}
        out['side_by_side'] = side_by_side(tbs, compare_with)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Render (zh-CN)


def _diff(x: dict[str, Any]) -> str:
    r = x['resolve']
    if not r['n']:
        return '—（没有配对任务）'
    ci = '（CI 退化：每个任务的差都相同）' if r['ci_degenerate'] else R._ci(r['ci'], True)
    return f"{R._pp(r['diff'])}{ci}，p = {R._p(r['p_signflip'])}，n = {r['n']}，不一致任务 {r['discordant_tasks']}"


def _ni(x: dict[str, Any]) -> str:
    v = x['resolve']['noninferiority']['noninferior']
    return '—' if v is None else '已显示' if v else '未显示（不等于“更差”）'


def _cost(x: dict[str, Any] | None) -> str:
    if not x:
        return '—'
    c = x.get('ratio_of_sums') or {}
    return f"×{R._num(c.get('point'), 2)}{R._ci(c.get('ci'))}（${R._num(x.get('sum_b'), 2)} / ${R._num(x.get('sum_a'), 2)}）"


def _row(name: str, x: dict[str, Any], ni: bool = True) -> str:
    return f"| {name} | {_diff(x)} | {_ni(x) if ni else '—'} | {_cost(x['cost'])} |"


def _cost_claim(c: dict[str, Any], y: str = 'B', x: str = 'A') -> str:
    if c['b_costs_more']:
        return f'；{y} 的成本高于 {x}（成本比 CI 下界 > 1）'
    if c['b_lower_cost']:
        return f'；{y} 的成本低于 {x}（成本比 CI 上界 < 1）'
    return '；成本比的 CI 包含 1，不能说更便宜或更贵'


def _claim_text(c: dict[str, Any], y: str = 'B', x: str = 'A', pp: int = 10) -> str:
    """The claim sentence for y − x (P1/P2 by default; S1/S2 with their arms); `pp` is the NI margin."""
    if c['ci_degenerate']:
        return '解决率差的 bootstrap CI 退化（每个任务的差都相同），不作解决率方面的判定' + _cost_claim(c, y, x) + '。预注册规则不允许说“等价”。'
    if c['b_geq_a_at_lower_cost']:
        return f'{y} 不劣于 {x}（{pp} pp 界限）且成本更低：预注册的“{y} ≥ {x} 且更便宜”成立。'
    parts = []
    if c['b_better']:
        parts.append(f'{y} 的解决率高于 {x}（CI 下界 > 0）')
    if c['noninferior']:
        parts.append(f'{y} 不劣于 {x}（{pp} pp 界限）')
    elif c['noninferior'] is False:
        parts.append(f'非劣性未显示（CI 下界低于 −{pp} pp；这不是“{y} 更差”）')
    if c['b_costs_more']:
        parts.append(f'{y} 的成本高于 {x}（成本比 CI 下界 > 1）')
    elif not c['b_lower_cost']:
        parts.append('成本比的 CI 包含 1 或高于 1，不能说更便宜')
    return '；'.join(parts) + '。预注册规则不允许说“等价”。' if parts else '数据不足以作出任何预注册判定。'


def _interim_header(il: dict[str, Any]) -> list[str]:
    """The §11 disclosure, always stated (the look happened whether or not C/F reps 4–5 are in these rows)."""
    br = il['blind_reps']
    here = ('本报告中这样的运行：' + '，'.join(f"{a} {n} 次（计分 {il['scored_runs_after_look'].get(a, 0)}）" for a, n in sorted(il['runs_after_look'].items())) + '。'
            if il['present'] else '本报告的行中还没有这样的运行。')
    return [f"> **中期查看披露（design §7.5.2、§11）**：决定给 C 和 F 加 rep 4–5 之前，main + rep2 上四个臂的中期解决率"
            f"（以及每次运行的平均成本）已被计算并展示给用户。加运行的规则（每臂每任务 5 次）没有引用这些结果，但无法证明没有它们"
            f"决定会相同，所以 C/F 的 rep 4–5 视为“在中期查看之后加入的运行”。P1/P2 不受影响（A、B 没有这样的运行）；"
            f"S1/S2 的判定基于盲设计集（A/B rep 1–{br['A']}，C/F rep 1–{br['C']}），含这些运行的同一比较并列显示，两者判定不同时保留盲设计集的判定；"
            f"S3–S5 使用全部运行，用到这些运行时加标注。{here}", '']


_S12_TITLE = {'B_vs_C': ('S1：B − C', 'B', 'C'), 'B_vs_F': ('S1：B − F', 'B', 'F'), 'F_vs_A': ('S2：F − A', 'F', 'A'), 'C_vs_A': ('S2：C − A', 'C', 'A')}


def render(data: dict[str, Any]) -> str:
    P = PROFILES[data.get('profile', 'deepswe')]
    tb = data.get('tb')
    L: list[str] = [P.title, '']
    if data['include_pilot']:
        L += ['> **试运行（dry run）**：本报告包含 pilot 阶段的行，只用于检查报告生成器。pilot 不进入分析（design §7.4），'
              '这里的数字不是实验结果。', '']
    il = data['interim_look']
    if P.interim_disclosure:
        L += _interim_header(il)
    if tb and tb['premise']['flag']:
        L += [f"> **前提检查未通过（TB design §7.2）**：C（Astra）第 1 次运行的解决率 {R._pct(tb['premise']['C_run1_rate'])}，"
              f"低于 80%（公开参考约 87%）。这很可能是环境问题（最可能是网络规则使任务失败），在阅读任何比较之前先排查。", '']
    tag = f"（{AFTER_LOOK}）" if il['present'] else ''
    rw = data['rows']
    L += ['## 1. 数据', '',
          f"输入 {rw['input']} 行，选中 {rw['selected']} 行（每个 (pass, arm, task, rep) 取最后一次尝试），"
          f"其中计分 {rw['scored']} 行，覆盖 {data['tasks']} 个任务。去掉 pilot 阶段 {rw['dropped_pilot_phase']} 行。", '',
          f"未计分：{R._counts(rw['not_scored'])}。按 pass 和臂：{R._counts(rw['by_pass'])}。", '']
    if data['excluded_tasks']:
        L += ['重跑或重新验证用尽后仍出错而排除的任务（与该臂的比较中成对剔除）：'
              + '；'.join(f"{a} {len(v)} 个" for a, v in sorted(data['excluded_tasks'].items())) + '。', '']
    if data['excluded_other_runs']:
        L += ['其他排除的运行（取消或未知处理，不计分、不进入敏感性分析）：'
              + '；'.join(f"{a} {len(v)} 次（{'、'.join(v)}）" for a, v in sorted(data['excluded_other_runs'].items())) + '。', '']
    if tb:
        lk = tb['lookup']['by_arm']
        L += [f"查找检查（§7.7）：每次计分运行都用 lookupscan 扫描了 Codex 的命令日志；没有可扫描日志的运行："
              f"{R._counts({a: v['not_scanned'] for a, v in lk.items()})}。主分析中被标记且已解决的运行记为未解决。", '']
    p = data['primary']
    L += ['## 2. 主要问题：B 相对 A 的质量和成本（P1、P2）', '', '| 比较 | 解决率差（95% CI，符号翻转 p） | 非劣性（10 pp） | 成本比 ΣB/ΣA |',
          '|---|---|---|---|', _row('B − A（全部运行）' if not tb else 'B − A（主分析：查找标记的已解决运行记为未解决）', p['B_vs_A'])]
    if P.extension:
        L.append(_row('S7a：只用 rep 1–3', p['s7a_reps_1_3']))
    if tb:
        L.append(_row('B − A，按原始评分（不计查找标记；§7.7 敏感性）', tb['as_graded']['B_vs_A']))
        if 'oracle_recheck' in tb:
            L.append(_row(f"B − A，去掉运行后 oracle 复查失败的 {len(tb['oracle_recheck']['failed_tasks'])} 个任务（§7.5 敏感性）",
                          tb['oracle_recheck']['B_vs_A']))
    if 'excluded_as_failures' in p:
        L.append(_row('排除的运行记为失败（敏感性）', p['excluded_as_failures']))
    L += ['', f"**预注册判定**：{_claim_text(p['claims'])}", '']
    if tb:
        nt = tb['ni_tight']
        pp = round(nt['margin'] * 100)
        r5 = nt['B_vs_A']['resolve']['noninferiority']
        L += [f"**P1-tight（非劣性 {pp} pp，同样的判定规则；CI 下界 {R._pp(r5['ci_lo'])}）**：{_claim_text(nt['B_vs_A']['claims'], pp=pp)}"
              + (f" 10 pp 下显示非劣性、{pp} pp 下没有显示，按此表述。"
                                                     if p['claims']['noninferior'] and nt['B_vs_A']['claims']['noninferior'] is False else ''), '']
        ag = tb['as_graded']['B_vs_A']
        if ag['differ']:
            L += [f"- **按原始评分时判定不同**（{'、'.join(ag['differ'])}）：{_claim_text(ag['claims'])}主分析的判定以查找规则（§7.7）为准。", '']
    r1 = p['run1_only']
    if r1['n']:
        L += [f"敏感性（只用第 1 次运行，Newcombe + 精确 McNemar，可与 R2E 对比）：{R._pp(r1['diff'])}{R._ci(r1['ci'], True)}，"
              f"McNemar p = {R._p(r1['p_mcnemar'])}，n = {r1['n']}，不一致 {r1['a_only'] + r1['b_only']}（A 独有 {r1['a_only']}，B 独有 {r1['b_only']}）。", '']
    cb = data['cost_basis']
    if not cb['fell_back']:
        L += [f"成本：每次运行取 proxy 账本的 Bedrock 费用；B 另加 router 侧的 assessor 调用费用（B 是“auto + 评估器”，计入对 B 更保守）。"
              f"只用账本费用的 B − A 成本比：{_cost(p['B_vs_A_ledger_only'])}。", '']
    else:
        why = '没有提供 router 日志' if 'router_logs' not in data else f"{cb['b_runs_without_router_logs']} 次计分的 B 运行没有 router 日志"
        L += [f"成本：{why}，所以回退为只用 proxy 账本费用（不含 B 的 assessor 调用）。", '']
    s = data['secondary']
    L += ['## 3. 次要比较（S1、S2；95% CI，未做多重比较校正）', '']
    if P.interim_disclosure:
        L += [f"判定基于盲设计集（A/B rep 1–{il['blind_reps']['A']}，C/F rep 1–{il['blind_reps']['C']}；design §7.5.2）。"
              + (f"标注“{AFTER_LOOK}”的行是同一比较用全部运行的结果，更精确，但不作判定。" if il['present'] else ''), '']
    L += ['| 比较 | 解决率差 | 非劣性（10 pp） | 成本比 |', '|---|---|---|---|']
    for name, (title, _, _) in _S12_TITLE.items():
        L.append(_row(f'{title}（盲设计集）' if P.interim_disclosure else title, s[name]))
        if il['present']:
            L.append(_row(f'{title}（{AFTER_LOOK}）', s['all_runs'][name]))
        if name == 'B_vs_C' and tb:
            L.append(_row('S1：B − C，按原始评分（§7.7 敏感性）', tb['as_graded']['B_vs_C']))
            if 'oracle_recheck' in tb:
                L.append(_row('S1：B − C，去掉 oracle 复查失败的任务（§7.5 敏感性）', tb['oracle_recheck']['B_vs_C']))
        if name == 'B_vs_C' and P.extension:
            L.append(_row('S7a：B − C（rep 1–3 / 1–2）', s['s7a_B_vs_C']))
            if 'B_vs_C_excluded_as_failures' in s:
                L.append(_row('S1：B − C，排除的运行记为失败（敏感性，盲设计集）', s['B_vs_C_excluded_as_failures']))
                if il['present']:
                    L.append(_row(f'S1：B − C，排除的运行记为失败（敏感性，{AFTER_LOOK}）', s['all_runs']['B_vs_C_excluded_as_failures']))
    L.append('')
    for name, (title, y, x) in _S12_TITLE.items():
        c = s['claims'][name]
        L.append(f"- **{title} 判定{'（盲设计集）' if P.interim_disclosure else ''}**：{_claim_text(c['blind'], y, x)}")
        if name == 'B_vs_C' and tb:
            nt = tb['ni_tight']
            pp = round(nt['margin'] * 100)
            L.append(f"  - 非劣性 {pp} pp：{_claim_text(nt['B_vs_C']['claims'], y, x, pp)}")
            if tb['as_graded']['B_vs_C']['differ']:
                L.append(f"  - **按原始评分时判定不同**（{'、'.join(tb['as_graded']['B_vs_C']['differ'])}）："
                         f"{_claim_text(tb['as_graded']['B_vs_C']['claims'], y, x)}以查找规则（§7.7）为准。")
        if c['differ']:
            L.append(f"  - **判定不同**：用全部运行（{AFTER_LOOK}）时为：{_claim_text(c['all_runs'], y, x)}"
                     f"（不同的判定项：{'、'.join(c['differ'])}）。按 design §7.5.2 保留盲设计集的判定。")
    L.append('')
    if 'secondary_ledger_only' in data:
        L += [f"只用账本费用的 B − C 成本比{'（盲设计集）' if P.interim_disclosure else ''}：{_cost(data['secondary_ledger_only']['B_vs_C'])}。", '']
    i = data['ideal']
    ho, ins, bo = i['heldout'], i['insample_run1'], i['B_on_heldout_tasks']
    L += [f'## 4. 理想的逐任务路由（S3，描述性）{tag}', '']
    if ho['n']:
        vb = ho['vs_baseline']
        L += [f"留出版（用一次运行选择、在另一次上计分），{ho['n']} 个任务：解决率 {R._pct(ho['ideal']['rate'])}，成本 ${R._num(ho['ideal']['cost'], 2)}；"
              f"相对 A：{R._pp(vb['resolve_diff']['diff'])}{R._ci(vb['resolve_diff']['ci'], True)}，成本比 ×{R._num(vb['cost_ratio']['point'], 2)}"
              f"{R._ci(vb['cost_ratio']['ci'])}。选择份额：{R._counts({k: round(v, 3) for k, v in ho['choice_share'].items() if v is not None})}。", '',
              f"同一批任务上的 B：解决率 {R._pct(bo['rate'])}，成本 ${R._num(bo['cost'], 2)}。", '']
    else:
        L += [f"留出版需要 F、A、C 每臂至少 2 次运行；目前没有这样的任务（跳过 {ho['skipped_tasks']} 个）。", '']
    if ins:
        b = ins['vs']['always_sol']
        L += [f"样本内版（只用第 1 次运行，被噪声抬高的上界），{ins['n']} 个任务：解决率 {R._pct(ins['ideal']['rate'])}，"
              f"相对 A {R._pp(b['resolve_diff']['diff'])}，成本比 ×{R._num(b['cost_ratio']['point'], 2)}。", '']
    if 'strata' in data:
        st = data['strata']
        L += [f'## 5. 按 tier pass 分层（S4，次要）{tag}', '',
              f"分层来自冻结的 strata.json（3 次 tier pass 的多数，none 记为 standard）：{R._counts(st['counts'])}，三次一致 {st['stable']} 个。"
              + (f" 有 {len(st['tasks_without_stratum'])} 个计分任务不在 strata.json 里。" if st['tasks_without_stratum'] else ''), '',
              '| 层 | 比较 | 解决率差 | 成本比 |', '|---|---|---|---|']
        for label, name in (('all', '全部'), ('stable', '三次一致')):
            for s_ in STRATA:
                for k, title in (('B_vs_A', 'B − A'), ('B_vs_C', 'B − C'), ('C_vs_A', 'C − A')):
                    x = st['by_stratum'][label][s_][k]
                    L.append(f"| {s_}（{name}） | {title} | {_diff(x)} | {_cost(x['cost'])} |")
        L.append('')
        for key, title in (('decomposition_B_vs_A', 'B − A'), ('decomposition_C_vs_A', 'C − A（反事实）')):
            dcp = st[key]
            if dcp['n']:
                L.append(f"分解 {title} = " + ' + '.join(f"{s_} {R._num(v['weight'], 2)} × {R._pp(v['diff'])}" for s_, v in dcp['by_stratum'].items())
                         + f" = {R._pp(dcp['total'])}。")
        sk = st['assessor_skill_C_vs_A']
        L += ['', f"assessor 的选择能力（描述性）：(C − A | frontier) − (C − A | standard) = {R._pp(sk['diff'])}{R._ci(sk['ci'], True)}"
              f"（frontier {sk['n_frontier']} 个，standard {sk['n_standard']} 个任务）。", '',
              '透明性检查：standard 层中 B ≈ Sol，B − A 应接近 0、成本比接近 1；frontier 层中 B ≈ Astra，B − C 应接近 0。'
              '偏离来自 router 的行为（会话中换模型、failover），不是路由选择本身。', '']
    if tb:
        dif = tb['difficulty']
        L += ['### 按 TB 作者难度分层（§7.8，描述性）', '', f"easy 与 medium 合并：{R._counts(dif['counts'])}。", '',
              '| 难度 | 比较 | 解决率差 | 成本比 |', '|---|---|---|---|']
        for s_, xs in dif['by_stratum'].items():
            for k, title in (('B_vs_A', 'B − A'), ('C_vs_A', 'C − A')):
                L.append(f"| {s_} | {title} | {_diff(xs[k])} | {_cost(xs[k]['cost'])} |")
        if tb.get('tier_by_difficulty'):
            L += ['', 'tier pass 分层 × 难度（assessor 是否把 hard 送去 frontier）：' + R._counts(tb['tier_by_difficulty']) + '。']
        L.append('')
    if 'assessor' in data:
        L += [assessor_live.render_zh(data['assessor']), '']
    L += [f'## 6. 运行间噪声（S5）{tag}', '', '| 臂 | 多次运行的任务 | 结果不全相同的任务（Wilson CI） | 两次运行不一致的概率（CI） |', '|---|---|---|---|']
    for a in ARMS:
        n = data['noise'][a]
        L.append(f"| {LABEL[a]} | {n['tasks']} | {R._pct(n['task_flip_rate'])}{R._ci(n['task_flip_ci'], True)} | "
                 f"{R._pct(n['pair_disagreement'])}{R._ci(n['pair_disagreement_ci'], True)} |")
    if data.get('noise_b_live_tier'):
        lt = data['noise_b_live_tier']
        L += ['', f"B 的实时 tier 在同一任务的多次运行间变化：{lt['flipped']}/{lt['tasks']} 个任务{R._ci(lt['ci'], True)}。"]
    L += ['', f'## 7. 描述性结果（S6）{tag}', '', '| 臂 | 计分运行 | 解决率（任务等权） | 总成本 | 每次运行 | 每解决一个任务（CI） | 缓存读取占比 | Codex 分钟 p50 / 最大 | 重跑 |',
          '|---|---|---|---|---|---|---|---|---|']
    for a, x in data['arms'].items():
        ups = x['usd_per_solved']
        L.append(f"| {LABEL[a]} | {x['scored_runs']} | {R._pct(x['rate'])} | ${R._num(x['sum_cost'], 2)} | ${R._num(x['mean_cost'], 2)} | "
                 f"${R._num(ups.get('point'), 2)}{R._ci(ups.get('ci'))} | {R._pct(x['cache_read_share'])} | "
                 f"{R._num(x['codex_min_p50'], 1)} / {R._num(x['codex_min_max'], 1)} | {x['reruns']} |")
    L += ['', '退出原因（计分运行）：' + '；'.join(f"{a} {R._counts(x['exit_reason'])}" for a, x in data['arms'].items()) + '。']
    sut = {a: x['sut'] for a, x in data['arms'].items() if x['sut']}
    L.append('router 造成的失败（记为 0）：' + ('；'.join(f"{a} {len(v)} 次（{'、'.join(v)}）" for a, v in sut.items()) if sut else '无') + '。')
    sb = data['served_B']
    L += [f"B 的 prompt token 按服务模型：{'，'.join(f'{m} {100 * v:.1f}%' for m, v in sb['prompt_share'].items()) or '—'}；"
          f"按主模型计的运行：{R._counts(sb['dominant_model_runs'])}；会话中用过多个模型的运行 {len(sb['multi_model_runs'])} 次。"]
    if 'router_logs' in data:
        rl = data['router_logs']
        L.append(f"router 日志：{rl['records']} 条记录，对上 {rl['runs_joined']} 次运行（完整 {rl['runs_complete']}）；"
                 f"failover：{R._counts({a: v for a, v in rl['failovers_by_arm'].items() if v}) if any(rl['failovers_by_arm'].values()) else '无'}；"
                 f"assessor 总花费 ${rl['assessor_cost_usd']:.4f}。")
        rc = rl['ledger_vs_router_cost']
        if rc['runs']:
            L.append(f"proxy 账本与 router 自报的模型费用：{rc['runs']} 次运行，相对差中位数 {R._pct(rc['rel_diff_p50'], 2)}，"
                     f"最大 {R._pct(rc['rel_diff_max'], 2)}，超过 2% 的 {rc['over_2pct']} 次。")
    L += ['', '| runner | 行 | 计分 | 解决 | 成本 | trial 小时 |', '|---|---|---|---|---|---|']
    L += [f"| {k} | {v['rows']} | {v['scored']} | {v['resolved']} | ${v['cost_usd']:.2f} | {v['trial_hours']} |" for k, v in data['runners'].items()]
    if tb:
        lf = tb['lookup']
        L += ['', '### 查找检查（§7.7）', '', '| 臂 | 计分运行 | L1 访问基准（Wilson CI） | L2 解答内容（CI） | 任一（CI） | 被标记且已解决 | 改动网络配置 | 调用其他模型 API |',
              '|---|---|---|---|---|---|---|---|']
        for a, v in lf['by_arm'].items():
            L.append(f"| {LABEL[a]} | {v['runs']} | {v['flag_l1']}{R._ci(v['flag_l1_ci'], True)} | {v['flag_l2']}{R._ci(v['flag_l2_ci'], True)} | "
                     f"{v['flag']}（{R._pct(v['flag_rate'])}）{R._ci(v['flag_ci'], True)} | {v['flagged_resolved']} | {v['net_config_touched']} | {v['model_api_runs']} |")
        if lf['over_5pct']:
            L += ['', f"**注意**：{'、'.join(lf['over_5pct'])} 的标记率超过 5%。"]
        if lf['fisher_A_vs_B'] is not None:
            L += ['', f"A 与 B 的标记率差（双侧 Fisher，描述性）：p = {R._p(lf['fisher_A_vs_B'])}"
                  + ('。p < 0.05：主分析可能对查找较少的臂有利。' if lf['fisher_A_vs_B'] < 0.05 else '。')]
        fl = tb['flaky_env']
        L += ['', f"oracle 两次中只通过一次的任务（flaky_env，§7.5）：{len(fl['tasks'])} 个"
              + ('；在这些任务上的解决率：' + '，'.join(f"{a} {R._pct(fl['rate_on_flaky'][a])}" for a in ARMS)
                 + '；其余任务：' + '，'.join(f"{a} {R._pct(fl['rate_on_others'][a])}" for a in ARMS) if fl['tasks'] else '') + '。']
    if P.extension:
        L += ['', '## 8. 漂移检查（S7b，描述性）', '']
        for a, x in data['s7b_drift'].items():
            late = f"（{AFTER_LOOK}）" if a in ('C', 'F') else ''     # C/F reps 4–5 are exactly the post-look runs (0d)
            L.append(f"- {LABEL[a]}：rep 4–5 − rep 1–3 = {_diff({'resolve': x})}，未配对任务 {x['unpaired_tasks']}（切分后只跑了部分任务时不为 0）{late}。"
                     if x['n'] else f"- {LABEL[a]}：没有 rep 4–5 的运行。")
    if tb and tb.get('side_by_side'):
        L += ['', '## 8. 与 DeepSWE 并列（§7.11；两个基准各自的结果，不合并、不作合并判定）', '',
              '| 比较 | TB 2.1 | DeepSWE v1.1 | 方向一致 | 判定一致 | 两基准等权平均（描述性） |', '|---|---|---|---|---|---|']
        for name, x in tb['side_by_side'].items():
            def cell(v: dict[str, Any]) -> str:
                ni = ('NI10 ' + ('是' if v['ni10'] else '否' if v['ni10'] is False else '—')
                      + ('' if v['ni5'] is None else '，NI5 ' + ('是' if v['ni5'] else '否')))
                return f"{R._pp(v['diff'])}{R._ci(v['ci'], True)}；{ni}；成本比 ×{R._num(v['cost_ratio'], 2)}"
            both = x['both_descriptive']
            L.append(f"| {name.replace('_vs_', ' − ')} | {cell(x['tb'])} | {cell(x['deepswe'])} | "
                     f"{'是' if x['same_direction'] else '否' if x['same_direction'] is False else '—'} | "
                     f"{'是' if x['claims_agree'] else '否（' + '、'.join(x['claims_differ']) + '）'} | "
                     f"{R._pp(both.get('avg')) + R._ci(both.get('ci'), True) if both else '—'} |")
        L += ['', '一致只表示两个基准相互印证，不增加统计功效。DeepSWE 半部分只来自 DeepSWE 的最终数据。']
    if tb and tb.get('public_ref'):
        L += ['', tb['public_ref']]
    L += ['', '## 9. 局限', '',
          ('- 结论只适用于 DeepSWE v1.1 的这些任务、这个 Codex 版本和配置、以及这三个模型。' if P.name == 'deepswe' else
           '- 结论只适用于 Terminal-Bench 2.1 的这些任务、这个 Codex 版本和配置、以及这三个模型。'), *P.limits,
          '- 非劣性“未显示”不等于“B 更差”；不报告“等价”。',
          '- 分层、理想路由和 assessor 能力都是描述性或次要结果；理想路由不是可实现的路由。',
          '- 运行间噪声（S5）跨越多个 pass，读作“噪声加上运行期间的漂移”。', '']
    return '\n'.join(L)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--rows', type=pathlib.Path, default=hcommon.RESULTS / 'merged' / 'rows.jsonl')
    ap.add_argument('--strata', type=pathlib.Path, default=hcommon.RESULTS / 'tierpass' / 'strata.json')
    ap.add_argument('--router-logs', type=pathlib.Path, nargs='*', default=None)
    ap.add_argument('--out', type=pathlib.Path, default=hcommon.RESULTS / 'report')
    ap.add_argument('--include-pilot', action='store_true', help='keep phase=pilot rows (generator dry run only)')
    ap.add_argument('--profile', choices=sorted(PROFILES), default='deepswe', help='tb21: the Terminal-Bench 2.1 report (TB design §4.7)')
    ap.add_argument('--oracle-recheck', type=pathlib.Path, help='tb21: JSON {"failed": [task ids]} from the post-run oracle re-check (§7.5)')
    ap.add_argument('--compare-with', type=pathlib.Path, help="tb21: DeepSWE's report-data.json for the side-by-side (§7.11)")
    a = ap.parse_args(argv)
    strata = load_strata(a.strata) if a.strata and a.strata.exists() else None
    records = None
    if a.router_logs:
        records = [x for p in a.router_logs for x in routerlogs.parse(p.read_text())]
    oracle_failed = json.loads(a.oracle_recheck.read_text())['failed'] if a.oracle_recheck else None
    compare_with = json.loads(a.compare_with.read_text()) if a.compare_with else None
    data = build(read_jsonl(a.rows), strata, records, a.include_pilot, a.strata.parent if strata is not None else None,
                 profile=a.profile, oracle_failed=oracle_failed, compare_with=compare_with)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / 'report-data.json').write_text(json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + '\n')
    (a.out / 'report.zh.md').write_text(render(data))
    print(f"{data['rows']['scored']} scored rows, {data['tasks']} tasks → {a.out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
