"""The assessor section of the live report (step 3): arm B's router-logged consultations joined to run outcomes, and
compared with the step 1 offline tiers. Stdlib only; text-free (ids, codes and numbers).

Interface (called by the report):

    data = assessor_live.build(rows, join, step1_dir=None, excluded=())
    md = assessor_live.render_zh(data)

- rows: one dict per graded run (any arm), at least `run_id`, `arm` ('A'|'F'|'C'|'B'), `task_id`, `resolved` (bool);
  optional `rep` (default 1), `attempt` (the latest per (phase, arm, task, rep) is kept), `cost_usd` (else the
  join's `cost_usd`), `exit_reason` ('harness-error' and 'budget' runs are dropped).
  These are the harvested R2E-schema rows (run_id = trial_id = the proxy's x-router-session value). The caller picks
  the phase (main, or main + repeat): every row passed is averaged per (arm, task).
- join: `routerlogs.join(...)` output (experiments/codex-deepswe/routerlogs.py), keyed by run_id. Fields used:
  assessor_tier, assessor_proposed, assessor_status, assessor_outcome, assessor_applied, assessor_consults,
  assessor_latency_ms, assessor_confidence, assessor_basis, assessor_cost_usd, cost_usd, served_models.
- step1_dir: the tier pass outputs (results/tierpass/); reads the pre-registered strata.json (`tierpass.py strata`:
  per task, the majority over the 3 reps of the opinion within the deadline, none counted as standard, and `stable`).
  The primary outcome breakdown is by these fixed strata; None skips the strata and the offline comparison.
- excluded: task ids dropped by the pre-registered infrastructure rule.
"""
from __future__ import annotations

import json
import pathlib
import random
from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import Any

DEADLINE_MS = 5000
EXCLUDED_EXITS = ('harness-error', 'budget')
TIER_MODEL = {'fast': 'global.openai.gpt-6-luna', 'standard': 'global.openai.gpt-6.1-sol', 'frontier': 'global.openai.gpt-6-astra'}
DEFAULT_TIER = 'standard'
ARM_TIER = {'F': 'fast', 'A': 'standard', 'C': 'frontier'}
TIERS = ('fast', 'standard', 'frontier')
SEED = 20261105
N_BOOT = 10_000


def _q(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


def _tier(v: Any) -> str:
    return v if v in TIERS else 'none'


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


# The pre-registered strata files this module reads: DeepSWE's and Terminal-Bench 2.1's (73's `tierpass.py strata`;
# same task shape). Any other schema is refused, not guessed at.
STRATA_SCHEMAS = frozenset({'deepswe-harbor-strata/v1', 'tbench-harbor-strata/v1'})


def load_strata(step1_dir: pathlib.Path | str) -> dict[str, dict[str, Any]]:
    """task → {'stratum', 'stable', 'reps'} from the pre-registered strata.json."""
    d = json.loads((pathlib.Path(step1_dir) / 'strata.json').read_text(encoding='utf-8'))
    if d.get('schema') not in STRATA_SCHEMAS:
        raise ValueError(f"unexpected strata schema {d.get('schema')}")
    return d['tasks']


def load_card_checks(step1_dir: pathlib.Path | str) -> list[dict[str, Any]]:
    """carddiff.ts outputs (carddiff-<task>.json): the live Harbor first request's card vs the step 1 card."""
    out = []
    for p in sorted(pathlib.Path(step1_dir).glob('carddiff-*.json')):
        d = json.loads(p.read_text(encoding='utf-8'))
        out.append({'task': d.get('task'), 'card_equal': bool(d.get('card_equal')), 'differs': sorted((d.get('card_diff') or {}).keys())})
    return out


def _as_served(tier: str) -> str:
    """No opinion → the pool default, as the router serves it (and as the strata count it)."""
    return DEFAULT_TIER if tier == 'none' else tier


def _boot_ci(pairs: list[tuple[float, float]], seed: int = SEED, n: int = N_BOOT) -> list[float] | None:
    """95% task-bootstrap CI of mean(x - y)."""
    if len(pairs) < 2:
        return None
    rnd = random.Random(seed)
    k = len(pairs)
    ds = sorted(sum(pairs[i][0] - pairs[i][1] for i in (rnd.randrange(k) for _ in range(k))) / k for _ in range(n))
    return [ds[int(0.025 * n)], ds[int(0.975 * n) - 1]]


def _per_task(rows: Iterable[dict[str, Any]], arm: str) -> dict[str, float]:
    """task → mean resolved over that arm's runs (reps averaged)."""
    acc: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        if r['arm'] == arm:
            acc[r['task_id']].append(1.0 if r.get('resolved') else 0.0)
    return {t: sum(v) / len(v) for t, v in acc.items()}


def _dominant(served: dict[str, int] | None) -> str | None:
    if not served:
        return None
    return max(served.items(), key=lambda kv: (kv[1], kv[0]))[0]


def _outcome_cell(ts: list[str], per: dict[str, dict[str, float]]) -> dict[str, Any]:
    cell: dict[str, Any] = {'tasks': len(ts)}
    for arm in ('B', 'A', 'F', 'C'):
        vals = [per[arm][t] for t in ts if t in per[arm]]
        cell[f'{arm}_resolved'] = round(_mean(vals), 4) if vals else None
    # The discrimination test: does Astra beat Sol more on the tasks the assessor calls frontier?
    for x, y in (('C', 'A'), ('F', 'A'), ('B', 'A'), ('B', 'C')):
        pairs = [(per[x][t], per[y][t]) for t in ts if t in per[x] and t in per[y]]
        if pairs:
            cell[f'{x}_minus_{y}_pp'] = round(100 * _mean([u - v for u, v in pairs]), 2)
            ci = _boot_ci(pairs)
            cell[f'{x}_minus_{y}_ci95_pp'] = [round(100 * c, 2) for c in ci] if ci else None
    return cell


def build(rows: list[dict[str, Any]], join: dict[str, dict[str, Any]], step1_dir: pathlib.Path | str | None = None,
          excluded: Iterable[str] = ()) -> dict[str, Any]:
    ex = set(excluded)
    # The latest attempt per (phase, arm, task, rep) (a rerun replaces the errored attempt), then drop what the
    # pre-registered rule excludes: infrastructure errors and cap stops are not outcomes.
    last: dict[tuple, dict[str, Any]] = {}
    for r in sorted(rows, key=lambda r: int(r.get('attempt') or 1)):
        last[(r.get('phase'), r['arm'], r['task_id'], int(r.get('rep') or 1))] = r
    rows = [r for r in last.values() if r.get('task_id') not in ex and r.get('exit_reason') not in EXCLUDED_EXITS]
    b = [r for r in rows if r['arm'] == 'B']
    out: dict[str, Any] = {'schema': 'deepswe-harbor-assessor-live/v1', 'b_runs': len(b),
                           'b_runs_without_router_logs': sorted(r['run_id'] for r in b if r['run_id'] not in join)}
    bj = [(r, join[r['run_id']]) for r in b if r['run_id'] in join]

    # ---- 1. the consultations as logged (one non-cached consultation per run is expected: each run has its own
    # x-router-session, so the memo never carries an opinion across runs)
    lat = [float(j['assessor_latency_ms']) for _, j in bj if isinstance(j.get('assessor_latency_ms'), (int, float))]
    conf = [float(j['assessor_confidence']) for _, j in bj if isinstance(j.get('assessor_confidence'), (int, float))]
    consults = Counter(int(j.get('assessor_consults') or 0) for _, j in bj)
    a_cost = sum(float(j.get('assessor_cost_usd') or 0.0) for _, j in bj)
    arm_cost = sum(float(r.get('cost_usd') if r.get('cost_usd') is not None else j.get('cost_usd') or 0.0) for r, j in bj)
    out['consultations'] = {
        'runs_with_logs': len(bj),
        'tier': dict(Counter(_tier(j.get('assessor_tier')) for _, j in bj)),
        'proposed': dict(Counter(_tier(j.get('assessor_proposed')) for _, j in bj)),
        'status': dict(Counter(str(j.get('assessor_status')) for _, j in bj)),
        'outcome': dict(Counter(str(j.get('assessor_outcome')) for _, j in bj)),
        'applied': dict(Counter(str(j.get('assessor_applied')).lower() for _, j in bj)),
        'basis': dict(Counter('+'.join(j.get('assessor_basis') or []) or 'none' for _, j in bj)),
        'consults_per_run': {str(k): v for k, v in sorted(consults.items())},
        # 0 consultations but an assessment present: the run reused a cached opinion (memo shared across runs?).
        'cached_only_runs': sorted(r['run_id'] for r, j in bj if int(j.get('assessor_consults') or 0) == 0
                                   and j.get('assessor_status') is not None),
        'no_assessment_runs': sorted(r['run_id'] for r, j in bj if j.get('assessor_status') is None),
        'latency_ms': {'n': len(lat), 'p50': _q(lat, .5), 'p90': _q(lat, .9), 'p95': _q(lat, .95), 'max': max(lat, default=None),
                       'over_deadline': sum(1 for x in lat if x > DEADLINE_MS)},
        'confidence': {'p50': _q(conf, .5), 'min': min(conf, default=None), 'below_0.8': sum(1 for c in conf if c < 0.8)},
        'cost_usd': round(a_cost, 6), 'cost_share_of_arm': round(a_cost / arm_cost, 6) if arm_cost else None,
    }

    # ---- 2. did the served model follow the opinion? (no opinion → the pool default)
    follow: Counter[str] = Counter()
    switched = []
    for r, j in bj:
        want = TIER_MODEL[_tier(j.get('assessor_tier')) if _tier(j.get('assessor_tier')) != 'none' else DEFAULT_TIER]
        dom = _dominant(j.get('served_models'))
        follow['follows' if dom == want else 'differs' if dom else 'unknown'] += 1
        if len(j.get('served_models') or {}) > 1:
            switched.append(r['run_id'])
    out['served'] = {'dominant_model_vs_opinion': dict(follow), 'runs_with_more_than_one_model': sorted(switched)}

    # ---- 3. live opinion vs the step 1 offline opinions (same task, same card shape), none counted as standard
    live_by_task: dict[str, list[str]] = defaultdict(list)
    for r, j in bj:
        live_by_task[r['task_id']].append(_as_served(_tier(j.get('assessor_tier'))))
    strata = load_strata(step1_dir) if step1_dir is not None else None
    if step1_dir is not None:
        out['card_check'] = load_card_checks(step1_dir)
    if strata is not None:
        common = sorted(t for t in live_by_task if t in strata)
        agree_each = []  # per live run: share of the offline reps it matches
        xt: dict[str, Counter] = defaultdict(Counter)
        agree_stratum = agree_stable = n_stable = 0
        for t in common:
            st, reps = strata[t]['stratum'], strata[t]['reps']
            for lv in live_by_task[t]:
                agree_each.append(sum(1 for o in reps if o == lv) / len(reps))
                xt[st][lv] += 1
                agree_stratum += lv == st
                if strata[t]['stable']:
                    n_stable += 1
                    agree_stable += lv == st
        n_live = sum(len(live_by_task[t]) for t in common)
        off_pairs = [sum(1 for i in range(len(v)) for k in range(i + 1, len(v)) if v[i] == v[k]) / (len(v) * (len(v) - 1) / 2)
                     for v in (x['reps'] for x in strata.values()) if len(v) > 1]
        out['offline_vs_live'] = {
            'tasks': len(common), 'live_runs': n_live, 'offline_reps': max((len(x['reps']) for x in strata.values()), default=0),
            'live_agrees_with_stratum': round(agree_stratum / n_live, 4) if n_live else None,
            'live_agrees_with_stratum_stable_tasks': round(agree_stable / n_stable, 4) if n_stable else None,
            'live_runs_on_stable_tasks': n_stable,
            'live_agrees_with_an_offline_rep': round(_mean(agree_each), 4) if agree_each else None,
            'offline_pairwise_agreement': round(_mean(off_pairs), 4) if off_pairs else None,
            'stratum_x_live': {k: dict(v) for k, v in sorted(xt.items())},
        }

    # ---- 4. outcomes, paired with the pinned arms on the same tasks. Primary: the pre-registered strata (all tasks,
    # and the stable ones); secondary: the live opinion of each task's B run(s).
    per = {arm: _per_task(rows, arm) for arm in ('A', 'F', 'C', 'B')}
    if strata is not None:
        tasks_run = {r['task_id'] for r in rows}
        out['outcome_by_stratum'] = {}
        for label, keep in (('all', lambda x: True), ('stable', lambda x: x['stable'])):
            groups = {tier: sorted(t for t, x in strata.items() if x['stratum'] == tier and keep(x) and t in tasks_run) for tier in TIERS}
            out['outcome_by_stratum'][label] = {tier: _outcome_cell(ts, per) for tier, ts in groups.items() if ts}
    live_tier: dict[str, str] = {}
    for t, v in live_by_task.items():
        live_tier[t] = Counter(v).most_common(1)[0][0]   # one B run per task in the main run; majority over repeats
    out['outcome_by_live_tier'] = {tier: _outcome_cell(ts, per) for tier in TIERS
                                   if (ts := sorted(t for t, lt in live_tier.items() if lt == tier))}
    return out


def _pct(x: float | None) -> str:
    return '—' if x is None else f'{100 * x:.1f}%'


def _n(x: Any) -> str:
    return '—' if x is None else (f'{x:.0f}' if isinstance(x, float) else str(x))


def _f2(x: float | None) -> str:
    return '—' if x is None else f'{x:.2f}'


def _diff(x: dict[str, Any], a: str, b: str) -> str:
    d, ci = x.get(f'{a}_minus_{b}_pp'), x.get(f'{a}_minus_{b}_ci95_pp')
    if d is None:
        return '—'
    return f'{d:+.1f} pp' + (f' [{ci[0]:+.1f}, {ci[1]:+.1f}]' if ci else '')


def _counts(d: dict[str, int]) -> str:
    return '，'.join(f'{k} {v}' for k, v in sorted(d.items(), key=lambda kv: -kv[1])) or '—'


def render_zh(data: dict[str, Any]) -> str:
    c = data['consultations']
    lat = c['latency_ms']
    lines = ['### assessor 在 B 臂上的表现', '',
             f"B 臂共 {data['b_runs']} 次运行，其中 {c['runs_with_logs']} 次能和 router 日志对上"
             + (f"（{len(data['b_runs_without_router_logs'])} 次没有日志）" if data['b_runs_without_router_logs'] else '') + '。', '',
             '| 项目 | 结果 |', '|---|---|',
             f"| 意见（core 看到的 tier） | {_counts(c['tier'])} |",
             f"| 映射出的 tier（`proposedTier`） | {_counts(c['proposed'])} |",
             f"| 状态 | {_counts(c['status'])} |",
             f"| 是否改变了模型（`applied`） | {_counts(c['applied'])} |",
             f"| 每次运行的咨询次数 | {_counts(c['consults_per_run'])} |",
             f"| 延迟 p50 / p95 / 最大 | {_n(lat['p50'])} / {_n(lat['p95'])} / {_n(lat['max'])} ms（超过 {DEADLINE_MS} ms：{lat['over_deadline']}） |",
             f"| 置信度中位数 / 低于 0.8 | {_f2(c['confidence']['p50'])} / {c['confidence']['below_0.8']} |",
             f"| assessor 花费 / 占 B 臂 | ${c['cost_usd']:.4f} / {'—' if c['cost_share_of_arm'] is None else format(100 * c['cost_share_of_arm'], '.3f') + '%'} |", '']
    if c['cached_only_runs'] or c['no_assessment_runs']:
        lines += [f"注意：{len(c['cached_only_runs'])} 次运行只用了缓存的意见，{len(c['no_assessment_runs'])} 次运行没有 assessor 记录；"
                  '每次运行有自己的 `x-router-session`，正常情况下应各咨询一次。', '']
    s = data['served']
    lines += [f"服务模型与意见：{_counts(s['dominant_model_vs_opinion'])}；会话中换过模型的运行 {len(s['runs_with_more_than_one_model'])} 次。", '']
    cc = data.get('card_check')
    if cc:
        fields = sorted({f for x in cc for f in x['differs']})
        card_fields = [f for f in fields if f != 'templateFamily']
        lines += [f"**card 是否一致**：用 Harbor 实际发出的首个请求（mock upstream 抓取，{len(cc)} 个任务）构造的 card 与 step 1 的 card "
                  + ('完全相同。' if not fields else
                     ('除 router 的 template family 外完全相同（差别来自 skills 段里的 CODEX_HOME 路径；family 不进入 card，'
                      'router 也没有配置 roleLabels，所以 assessor 看到的输入相同）。' if not card_fields else
                      f"在这些字段上不同：{'、'.join(card_fields)}。")), '']
    o = data.get('offline_vs_live')
    if o:
        lines += ['**离线与线上的一致性**（没有意见按 standard 计）：线上意见与预先登记的分层（step 1 '
                  f"{o['offline_reps']} 次离线结果的多数）一致的比例为 {_pct(o['live_agrees_with_stratum'])}，"
                  f"其中三次离线都一致的任务上为 {_pct(o['live_agrees_with_stratum_stable_tasks'])}"
                  f"（{o['live_runs_on_stable_tasks']} 次运行）；与任一次离线结果一致的平均比例为 "
                  f"{_pct(o['live_agrees_with_an_offline_rep'])}。离线几次之间两两一致的比例为 "
                  f"{_pct(o['offline_pairwise_agreement'])}，是同一 card 下的噪声基线。", '']
    head = ['| 分组 | 任务数 | B | A (Sol) | F (Luna) | C (Astra) | C − A | B − A | B − C |', '|---|---|---|---|---|---|---|---|---|']

    def table(cells: dict[str, Any]) -> list[str]:
        out = list(head)
        for tier, x in cells.items():
            out.append(f"| {tier} | {x['tasks']} | {_pct(x.get('B_resolved'))} | {_pct(x.get('A_resolved'))} | "
                       f"{_pct(x.get('F_resolved'))} | {_pct(x.get('C_resolved'))} | {_diff(x, 'C', 'A')} | "
                       f"{_diff(x, 'B', 'A')} | {_diff(x, 'B', 'C')} |")
        return out + ['']

    st = data.get('outcome_by_stratum')
    if st:
        lines += ['**按预先登记的分层看结果**（分层来自 step 1，跑之前就固定；各臂在同一批任务上的解决率，差值的 95% 区间为任务 '
                  'bootstrap）：', '']
        lines += ['全部任务：', ''] + table(st.get('all', {}))
        if st.get('stable'):
            lines += ['只看三次离线结果都一致的任务：', ''] + table(st['stable'])
        lines += ['如果 assessor 能分辨难度，frontier 组的 C − A 应明显大于 standard 组。', '']
    bt = data.get('outcome_by_live_tier')
    if bt:
        lines += ['按线上意见分组（参考；分组本身受线上意见噪声影响）：', ''] + table(bt)
    return '\n'.join(lines)


def _selftest() -> None:  # pragma: no cover - quick manual check: python3 -I assessor_live.py
    rows, join = [], {}
    for i in range(6):
        t = f't{i}'
        tier = 'frontier' if i < 3 else 'standard'
        for arm in 'AFCB':
            rid = f'{arm}-{t}'
            rows.append({'run_id': rid, 'arm': arm, 'task_id': t, 'resolved': (i + 'AFCB'.index(arm)) % 2 == 0})
        join[f'B-{t}'] = {'assessor_tier': tier, 'assessor_proposed': tier, 'assessor_status': 'ok', 'assessor_consults': 1,
                          'assessor_latency_ms': 1500 + i, 'assessor_confidence': 0.9, 'assessor_cost_usd': 0.0007,
                          'cost_usd': 3.0, 'served_models': {TIER_MODEL[tier]: 10}, 'assessor_applied': tier != 'standard'}
    print(render_zh(build(rows, join)))


if __name__ == '__main__':
    _selftest()
