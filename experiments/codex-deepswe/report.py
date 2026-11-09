"""Report generator (R7): data JSON (aggregates + per-task rows by id) and a Chinese Markdown skeleton.

Statistics come from stats.py (the pre-registered analyses); this module only selects, aligns and formats. Main-phase rows only for
the inference; pilot and repeat rows are summarised separately. No dataset text: ids, strata, codes and numbers.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

import results
import stats

ARM_LABEL = {'A': 'A（固定 Sol）', 'F': 'F（固定 Luna）', 'C': 'C（固定 Astra）', 'B': 'B（auto + 评估器）', 'D': 'D（直连 Bedrock，Sol）'}


def _aligned(rows: dict[str, dict[str, Any]], arm_x: str, arm_y: str, ids: list[str]) -> tuple[list[dict], list[dict]]:
    xs, ys = [], []
    for t in sorted(ids):
        a, b = rows.get(f'{arm_x}:{t}'), rows.get(f'{arm_y}:{t}')
        if a and b:
            xs.append(a)
            ys.append(b)
    return xs, ys


def _cannot_show() -> list[str]:
    doc = stats.__doc__ or ''
    part = doc.split('can and cannot show', 1)[-1]
    items: list[str] = []
    for line in part.splitlines()[1:]:
        if line.startswith('- '):
            items.append(line[2:].strip())
        elif line.startswith('  ') and items:
            items[-1] += ' ' + line.strip()
        elif line.strip() == '' and items:
            continue
    return items


def build(rows_all: list[dict[str, Any]], join: dict[str, dict[str, Any]], sel: dict[str, Any], ledger: dict[str, Any],
          seed: int = stats.SEED, n_boot: int = stats.N_BOOT, runner: dict[str, Any] | None = None) -> dict[str, Any]:
    latest = results.latest(rows_all)
    main = [r for (ph, *_), r in latest.items() if ph == 'main']
    flat_all = {f"{r['arm']}:{r['task_id']}": results.analysis_row(r, join.get(r['run_id'])) for r in main}
    # Review G2: a run the harness could not grade (rebuild failed) removes its task from every comparison.
    excluded = sorted({v['task_id'] for v in flat_all.values() if v['grade_excluded']})
    flat = {k: v for k, v in flat_all.items() if v['task_id'] not in excluded}
    by_arm: dict[str, list[dict]] = defaultdict(list)
    for _, v in sorted(flat.items()):
        by_arm[v['arm']].append(v)

    out: dict[str, Any] = {
        'schema': 'codex-deepswe-report/v2', 'seed': seed, 'n_boot': n_boot,
        'selection': {k: sel.get(k) for k in ('dataset', 'rules', 'pred_tier_counts', 'pred_tier_untimed_counts')},
        'counts': {a: len(v) for a, v in sorted(by_arm.items())},
        'arms': {a: stats.arm_summary(v) for a, v in sorted(by_arm.items())},
        'ledger': ledger,
        'excluded_tasks': excluded,
        'validation': sel.get('validation_summary'),
    }
    # Design §11. Primary: F vs A (50) and C vs A (20). Descriptive: B vs A (10), D vs A (5), the ideal router.
    for arm, ids, primary in (('F', sel['arms'].get('F', []), True), ('C', sel['arms'].get('C', []), True),
                              ('B', sel['arms'].get('B', []), False), ('D', sel['arms'].get('D', []), False)):
        pair = _aligned(flat, 'A', arm, ids)
        if pair[0]:
            out[f'{arm}_vs_A'] = {**stats.compare_arms(*pair, seed=seed, n_boot=n_boot), 'primary': primary,
                                  'same_patch_stats': same_patch_stats(main, 'A', arm, ids, excluded),
                                  'calls_sum': pair_calls(main, 'A', arm, ids, excluded)}
            if primary:
                out[f'{arm}_vs_A_by_size'] = stats.by_stratum(*pair, key='size_bucket', seed=seed, n_boot=n_boot)
    out['ideal_router'] = ideal(by_arm, sel, seed, n_boot)
    out['escalation_oracle'] = escalation_oracle(flat, sel)
    out['a_only_tier_opinion'] = a_only_tier_opinion(flat, sel)
    out['failure_signals'] = failure_signals(main, sel, excluded)
    out['tierpass'] = sel.get('tierpass')
    out['transparency'] = transparency(main, join)
    out['timing'] = timing(main, join)
    out['assessor'] = assessor_summary([r for r in main if r['arm'] == 'B'], join)
    out['history'] = history([r for r in latest.values() if r.get('schema')])
    out['runner'] = runner_hours(runner, list(latest.values()))
    out['selection_facts'] = selection_facts(sel)
    out['repeats'] = repeats(latest, seed, n_boot)
    # The repeat tasks are a size-stratified draw, not an SRS of the 200: compare noise with F vs A on the same tasks too.
    rep_pair = _aligned(flat, 'A', 'F', sel.get('repeat', []))
    if rep_pair[0]:
        out['F_vs_A_on_repeat_tasks'] = stats.paired_diff([bool(r['resolved']) for r in rep_pair[0]], [bool(r['resolved']) for r in rep_pair[1]])
    out['pilot'] = pilot_checks([r for (ph, *_), r in latest.items() if ph == 'pilot'], join)
    out['per_task'] = per_task(flat, sel)
    out['limitations'] = _cannot_show()
    return out


def ideal(by_arm: dict[str, list[dict]], sel: dict[str, Any], seed: int, n_boot: int) -> dict[str, Any]:
    """Design §11, descriptive: an oracle that picks per task the cheapest tier that solved it, among the arms run on
    it, against always-Sol (A) and the assessor's actual choice (standard on every task in the tier pass, so also A).
    Variants: F/A on all tasks; F/A/C on C's subset; A/B on B's subset (both on Sol, so any gain is run-to-run noise:
    the inflation of the oracle)."""
    out: dict[str, Any] = {}
    base = {'always_sol': 'A', 'assessor_choice': 'A'}
    have = {a: rows for a, rows in by_arm.items() if rows}
    try:
        if 'F' in have and 'A' in have:
            common = sorted({r['task_id'] for r in have['A']} & {r['task_id'] for r in have['F']})
            out['F_A'] = stats.ideal_router(have, order=('F', 'A'), baselines=base, tasks=common, seed=seed, n_boot=n_boot)
        c_ids = sorted({r['task_id'] for r in have.get('C', [])} & {r['task_id'] for r in have.get('A', [])} & {r['task_id'] for r in have.get('F', [])})
        if c_ids:
            out['F_A_C'] = stats.ideal_router(have, order=('F', 'A', 'C'), baselines=base, tasks=c_ids, seed=seed, n_boot=n_boot)
        # B tasks still served on Sol (majority of calls): two Sol runs, so the oracle's gain there is pure noise.
        b_ids = sorted({r['task_id'] for r in have.get('B', []) if r.get('served_model') == 'global.openai.gpt-6.1-sol'}
                       & {r['task_id'] for r in have.get('A', [])})
        if b_ids:
            out['noise_A_B'] = stats.ideal_router(have, order=('A', 'B'), baselines={'always_sol': 'A'}, tasks=b_ids, seed=seed, n_boot=n_boot)
    except ValueError as e:
        out['error'] = str(e)[:200]
    return out


def same_patch_stats(main: list[dict[str, Any]], arm_x: str, arm_y: str, ids: list[str], excluded: list[str]) -> dict[str, int]:
    """How many aligned pairs produced patches with the same size statistics (paths, lines added/removed, bytes):
    a proxy for "the same fix", since patch text is not in results.jsonl."""
    by = {(r['arm'], r['task_id']): r for r in main}
    n = same = 0
    for t in ids:
        a, b = by.get((arm_x, t)), by.get((arm_y, t))
        if not a or not b or t in excluded:
            continue
        n += 1
        sa, sb = ((a.get('patch') or {}).get('stats') or {}), ((b.get('patch') or {}).get('stats') or {})
        keys = ('paths', 'added', 'removed', 'bytes')
        same += int(bool(sa) and all(sa.get(k) == sb.get(k) for k in keys))
    return {'n': n, 'same': same}


def pair_calls(main: list[dict[str, Any]], arm_x: str, arm_y: str, ids: list[str], excluded: list[str]) -> dict[str, Any]:
    """Model calls and prompt tokens summed over the aligned tasks (explains cost ratios between arms on one model)."""
    by = {(r['arm'], r['task_id']): r for r in main}
    out: dict[str, Any] = {arm_x: {'calls': 0, 'prompt_tokens': 0}, arm_y: {'calls': 0, 'prompt_tokens': 0}}
    for t in ids:
        a, b = by.get((arm_x, t)), by.get((arm_y, t))
        if not a or not b or t in excluded:
            continue
        for arm, r in ((arm_x, a), (arm_y, b)):
            c = r.get('calls') or {}
            out[arm]['calls'] += int(c.get('calls') or 0)
            out[arm]['prompt_tokens'] += int((c.get('usage') or {}).get('prompt') or 0)
    return out


def escalation_oracle(flat: dict[str, dict[str, Any]], sel: dict[str, Any]) -> dict[str, Any] | None:
    """Descriptive, on the F/A tasks: run F everywhere and re-run with A exactly where F failed (a perfect end-of-run
    failure detector). Unlike the ideal router it needs no foresight about which tasks need A, only a reliable
    'this run failed' signal; it pays F on every task plus A on every F failure."""
    ts = [t for t in sel['main'] if f'F:{t}' in flat and f'A:{t}' in flat]
    if not ts:
        return None
    f_cost = sum(flat[f'F:{t}']['cost_usd'] for t in ts)
    a_cost = sum(flat[f'A:{t}']['cost_usd'] for t in ts)
    fails = [t for t in ts if not flat[f'F:{t}']['resolved']]
    cost = f_cost + sum(flat[f'A:{t}']['cost_usd'] for t in fails)
    solved = sum(1 for t in ts if flat[f'F:{t}']['resolved'] or flat[f'A:{t}']['resolved'])
    return {'n': len(ts), 'escalated': len(fails), 'solved': solved, 'cost': round(cost, 6),
            'cost_ratio_vs_always_sol': cost / a_cost if a_cost else None, 'cost_ratio_vs_always_luna': cost / f_cost if f_cost else None}


def a_only_tier_opinion(flat: dict[str, dict[str, Any]], sel: dict[str, Any]) -> dict[str, Any]:
    """The offline tier-pass opinion (at the main run's 5000 ms timeout, else untimed) on the tasks only A solved,
    next to all F/A tasks: could a session-start assessor have told them apart?"""
    def op(t: str) -> str:
        m = sel['tasks'].get(t) or {}
        return str(m.get('pred_tier_5000') or m.get('pred_tier_untimed') or 'none')
    ts = [t for t in sel['main'] if f'F:{t}' in flat and f'A:{t}' in flat]
    ao = [t for t in ts if flat[f'A:{t}']['resolved'] and not flat[f'F:{t}']['resolved']]
    return {'a_only': dict(Counter(op(t) for t in ao)), 'all': dict(Counter(op(t) for t in ts))}


def failure_signals(main: list[dict[str, Any]], sel: dict[str, Any], excluded: list[str]) -> dict[str, Any]:
    """Descriptive: what F's own runs look like when F solves, when only A solves, and when neither does (medians of
    signals a router could see during or at the end of a run). Small groups; no inference."""
    by = {(r['arm'], r['task_id']): r for r in main}
    groups: dict[str, list[dict[str, Any]]] = {'F_solved': [], 'F_failed_A_solved': [], 'both_failed': []}
    for t in sel['main']:
        a, f = by.get(('A', t)), by.get(('F', t))
        if not a or not f or t in excluded:
            continue
        k = 'F_solved' if f.get('resolved') else 'F_failed_A_solved' if a.get('resolved') else 'both_failed'
        groups[k].append(f)

    def med(rs: list[dict[str, Any]], get) -> float | None:  # noqa: ANN001
        return results.median([v for v in (get(r) for r in rs) if isinstance(v, (int, float))])

    return {k: {'n': len(rs),
                'calls_p50': med(rs, lambda r: (r.get('calls') or {}).get('calls')),
                'commands_p50': med(rs, lambda r: (r.get('events') or {}).get('commands')),
                'commands_failed_p50': med(rs, lambda r: (r.get('events') or {}).get('commands_failed')),
                'output_tokens_p50': med(rs, lambda r: ((r.get('calls') or {}).get('usage') or {}).get('output')),
                'wall_s_p50': med(rs, lambda r: r.get('wall_s'))}
            for k, rs in groups.items()}


def _q(xs: list[float], p: float) -> float | None:
    xs = sorted(x for x in xs if isinstance(x, (int, float)))
    return xs[min(len(xs) - 1, int(p * (len(xs) - 1) + 0.5))] if xs else None


def timing(rows: list[dict[str, Any]], join: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Per arm (main phase): run wall time (agent container start to patch extracted; grading not included), Codex time, model calls per run, upstream
    TTFB (proxy) and the router's own per-request overhead (router log; B's session-start request also waits for the
    assessor, which is reported separately)."""
    by: dict[str, Any] = {}
    for arm in sorted({r['arm'] for r in rows}):
        rs = [r for r in rows if r['arm'] == arm]
        js = [join[r['run_id']] for r in rs if r.get('run_id') in join]
        calls = [(r.get('calls') or {}).get('calls') for r in rs]
        by[arm] = {'runs': len(rs),
                   'wall_s_p50': results.median([x for x in (r.get('wall_s') for r in rs) if isinstance(x, (int, float))]),
                   'wall_s_p90': _q([r.get('wall_s') for r in rs], 0.9),
                   'codex_s_p50': results.median([x for x in (r.get('codex_secs') for r in rs) if isinstance(x, (int, float))]),
                   'calls_p50': results.median([c for c in calls if isinstance(c, (int, float))]),
                   'calls_total': sum(c for c in calls if isinstance(c, (int, float))),
                   'ttfb_ms_p50': results.median([x for x in ((r.get('calls') or {}).get('ttfb_ms_p50') for r in rs) if isinstance(x, (int, float))]),
                   'router_runs': len(js),
                   'router_overhead_ms_p50': results.median([j['overhead_ms_p50'] for j in js if j.get('overhead_ms_p50') is not None]),
                   'router_overhead_ms_p99_max': max((j['overhead_ms_p99'] for j in js if j.get('overhead_ms_p99') is not None), default=None),
                   'router_overhead_ms_max_excl_assessor': max((j['overhead_ms_max_excl_assessor'] for j in js
                                                                if j.get('overhead_ms_max_excl_assessor') is not None), default=None)}
    return by


def assessor_summary(rows: list[dict[str, Any]], join: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """Arm B's session-start consultations as the router logged them (one per run; codes and numbers only)."""
    js = [join[r['run_id']] for r in rows if r.get('run_id') in join]
    if not js:
        return None
    lat = [j['assessor_latency_ms'] for j in js if isinstance(j.get('assessor_latency_ms'), (int, float))]
    conf = [j['assessor_confidence'] for j in js if isinstance(j.get('assessor_confidence'), (int, float))]
    return {'runs': len(js),
            'tier': dict(Counter(str(j.get('assessor_tier')) for j in js)),
            'proposed': dict(Counter(str(j.get('assessor_proposed')) for j in js)),
            'status': dict(Counter(str(j.get('assessor_status')) for j in js)),
            'applied': dict(Counter(str(j.get('assessor_applied')).lower() for j in js)),
            'consults': sum(int(j.get('assessor_consults') or 0) for j in js),
            'basis': dict(Counter('+'.join(j.get('assessor_basis') or []) or 'none' for j in js)),
            'cost_usd': round(sum(float(j.get('assessor_cost_usd') or 0.0) for j in js), 6),
            'cost_share_of_arm': (sum(float(j.get('assessor_cost_usd') or 0.0) for j in js) / s
                                  if (s := sum(float(j.get('cost_usd') or 0.0) for j in js)) else None),
            'latency_ms': {'n': len(lat), 'min': min(lat, default=None), 'p50': results.median(lat), 'max': max(lat, default=None),
                           'within_1500': sum(1 for x in lat if x <= 1500)},
            'confidence': {'min': min(conf, default=None), 'p50': results.median(conf), 'max': max(conf, default=None)}}


def history(rows: list[dict[str, Any]]) -> dict[str, int]:
    """Future-commit check (prepare_agent): the fix commit reachable in the image's git history before the strip,
    and after it."""
    hc = [r.get('history_check') or {} for r in rows]
    return {'runs': len(rows), 'checked': sum(1 for h in hc if h),
            'leak_before': sum(1 for h in hc if h.get('leak')), 'leak_after': sum(1 for h in hc if (h.get('after') or {}).get('leak'))}


def _epoch(iso: str | None) -> float | None:
    import datetime as _dt
    try:
        return _dt.datetime.fromisoformat(str(iso).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def runner_hours(runner: dict[str, Any] | None, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not runner or runner.get('started_at') is None:
        return None
    ends = [e for e in (_epoch(r.get('ended_at')) for r in rows if r.get('ended_at')) if e]
    end = runner.get('ended_at') or (max(ends) if ends else None)
    if end is None:
        return None
    hours = max(0.0, end - runner['started_at']) / 3600
    rate = runner.get('usd_per_hour')
    return {'hours': round(hours, 3), 'end': 'instance-stop' if runner.get('ended_at') else 'last-run-end',
            'usd_per_hour': rate, 'usd': round(hours * rate, 4) if rate else None}


def selection_facts(sel: dict[str, Any]) -> dict[str, Any]:
    main = sel.get('main') or []
    tasks = sel.get('tasks') or {}
    return {'n_main': len(main), 'n_pilot': len(sel.get('pilot') or []), 'rules': sel.get('rules'),
            'repo_counts': sel.get('repo_counts'), 'repo_cap_effect': sel.get('repo_cap_effect'),
            'size_counts': dict(Counter(tasks[t]['size'] for t in main if t in tasks)),
            'subset_size_counts': {a: dict(Counter(tasks[t]['size'] for t in ids if t in tasks))
                                   for a, ids in sorted((sel.get('arms') or {}).items()) if a in ('C', 'B', 'D')},
            'repeat_size_counts': dict(Counter(tasks[t]['size'] for t in (sel.get('repeat') or []) if t in tasks)),
            'replacements': len(sel.get('replacements') or []),
            'replacement_reasons': dict(Counter(r.get('reason') for r in sel.get('replacements') or []))}


def transparency(rows: list[dict[str, Any]], join: dict[str, dict[str, Any]]) -> dict[str, Any]:
    by: dict[str, dict[str, Any]] = {}
    for arm in sorted({r['arm'] for r in rows}):
        rs = [r for r in rows if r['arm'] == arm]
        loss: Counter = Counter()
        first_read = 0
        fallback = 0
        net = 0
        refused: Counter = Counter()
        statuses: Counter = Counter()
        pairs = exp = got = 0
        overhead = []
        failovers = 0
        for r in rs:
            c = r.get('calls') or {}
            cache = c.get('cache') or {}
            loss.update(cache.get('loss_by_reason') or {})
            first_read += int(cache.get('first_call_read') or 0)
            pairs += int(cache.get('same_model_pairs') or 0)
            exp += int(cache.get('expected_read') or 0)
            got += int(cache.get('read') or 0)
            fallback += int(c.get('gateway_fallback_calls') or 0)
            refused.update(c.get('refused') or {})
            statuses.update(c.get('statuses') or {})
            net += int(((r.get('events') or {}).get('network_command_total')) or 0)
            j = join.get(r['run_id']) or {}
            if j.get('overhead_ms_p50') is not None:
                overhead.append(j['overhead_ms_p50'])
            failovers += len(j.get('failovers') or [])
        by[arm] = {'runs': len(rs), 'cache_loss_events': dict(loss), 'cache_retention': (got / exp) if exp else None,
                   'same_model_pairs': pairs, 'first_call_cache_read_tokens': first_read, 'gateway_fallback_calls': fallback,
                   'proxy_refused': dict(refused), 'call_statuses': dict(statuses), 'network_commands': net,
                   'router_overhead_ms_p50_median': results.median(overhead), 'router_failovers': failovers,
                   'exit': dict(Counter(r.get('exit_reason') for r in rs))}
    return by


def repeats(latest: dict[tuple, dict[str, Any]], seed: int = stats.SEED, n_boot: int = stats.N_BOOT) -> dict[str, Any]:
    """Run-to-run noise per arm (A, F) over tasks run more than once (main rep 1 + repeat reps): stats.replicate_noise
    (task flip rate, equal-weight pair disagreement with CIs) plus the per-task resolve rate."""
    out: dict[str, Any] = {}
    for arm in ('A', 'F'):
        runs: dict[str, list[bool]] = defaultdict(list)
        for k, v in sorted(latest.items(), key=lambda kv: (kv[0][2], kv[0][3] if len(kv[0]) > 3 else 1)):
            if k[1] == arm and k[0] in ('main', 'repeat'):
                runs[k[2]].append(bool(v.get('resolved')))
        multi = {t: r for t, r in runs.items() if len(r) > 1}
        if multi:
            out[arm] = {**stats.replicate_noise(multi, seed=seed, n_boot=n_boot),
                        'resolve_rate_by_task': {t: sum(r) / len(r) for t, r in sorted(multi.items())}}
    return out


def pilot_checks(rows: list[dict[str, Any]], join: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {}
    from routerlogs import unique_lineages
    mine = {r['run_id']: join[r['run_id']] for r in rows if r['run_id'] in join}
    recon = []
    for r in rows:
        j = join.get(r['run_id'])
        if j and r.get('ledger_usd'):
            recon.append({'run_id': r['run_id'], 'ledger_usd': r['ledger_usd'], 'router_usd': j['cost_usd'],
                          'rel_diff': (r['ledger_usd'] - j['cost_usd']) / r['ledger_usd'] if r['ledger_usd'] else None})
    return {'runs': len(rows), 'graded': sum(1 for r in rows if (r.get('grade') or {}).get('status') == 'graded'),
            'lineages': unique_lineages(mine) if mine else None, 'reconcile': recon,
            'within_10pct': all(abs(x['rel_diff']) <= 0.10 for x in recon if x['rel_diff'] is not None) if recon else None,
            'exit': dict(Counter(r.get('exit_reason') for r in rows)), 'statuses': dict(sum((Counter((r.get('calls') or {}).get('statuses') or {}) for r in rows), Counter())),
            # The pilot ran before the proxy's SSE fix: calls it could not price were charged at the worst-case estimate.
            'ledger_usd': round(sum(float(r.get('ledger_usd') or 0.0) for r in rows), 6),
            'proxy_priced_usd': round(sum(float((r.get('calls') or {}).get('cost_usd') or 0.0) for r in rows), 6),
            'unpriced_calls': sum(int((r.get('calls') or {}).get('unpriced_calls') or 0) for r in rows),
            'calls': sum(int((r.get('calls') or {}).get('calls') or 0) for r in rows),
            'router_usd': round(sum(float(j['cost_usd']) for j in mine.values()), 6) if mine else None,
            'router_runs': len(mine),
            # Best estimate of the real spend: router-log price where the run is joined, else the proxy's own price (D).
            'real_usd': round(sum(float(mine[r['run_id']]['cost_usd']) if r.get('run_id') in mine
                                  else float((r.get('calls') or {}).get('cost_usd') or 0.0) for r in rows), 6) if mine else None}


def per_task(flat: dict[str, dict[str, Any]], sel: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for t in sel['main']:
        meta = sel['tasks'][t]
        row: dict[str, Any] = {'task_id': t, 'repo': meta['repo'], 'size': meta['size'], 'pred_tier': meta['pred_tier'],
                               'pred_tier_untimed': meta.get('pred_tier_untimed')}
        for arm in ('A', 'F', 'C', 'B', 'D'):
            v = flat.get(f'{arm}:{t}')
            if v:
                row[arm] = {'resolved': v['resolved'], 'cost_usd': round(v['cost_usd'], 4), 'exit': v['exit_detail'],
                            **({'tier': v['assessor_tier'], 'served': v['served_model']} if arm == 'B' else {})}
        out.append(row)
    return out


# ---------------------------------------------------------------- Markdown (zh-CN report)
#
# Tables are generated here; the written analysis is in analysis_zh.py (its numbers are read from the same data, so
# `cli.py report` reproduces the whole document).

def _validation_note(v: dict | None) -> str:
    if not v:
        return ''
    parts = [f"{t} {x['ok']}/{x['validated']}" for t, x in sorted((v.get('by_tier') or {}).items())]
    return f"各 tier 的验证通过率：{'，'.join(parts)}。" if parts else ''


def _counts(d: dict[str, Any] | None) -> str:
    """{'standard': 18, 'none': 4} → 'standard 18，none 4' (largest first)."""
    return '—' if not d else '，'.join(f'{k} {v}' for k, v in sorted(d.items(), key=lambda kv: (-kv[1], str(kv[0]))))


def _pct(x: float | None, digits: int = 1) -> str:
    return '—' if x is None else f'{100 * x:.{digits}f}%'


def _num(x: float | None, digits: int = 3) -> str:
    return '—' if x is None else f'{x:.{digits}f}'


def _p(p: float | None) -> str:
    return '—' if p is None else f'{p:.2g}' if p < 0.01 else f'{p:.3f}'


def _degenerate(ci: Any) -> bool:
    return not ci or ci[0] is None or ci[1] is None or abs(ci[1] - ci[0]) < 1e-12


def _ci(ci: Any, pct: bool = False, digits: int = 2) -> str:
    """'' for a degenerate interval (a percentile bootstrap over all-equal values shows no uncertainty: don't print it)."""
    if _degenerate(ci):
        return ''
    lo, hi = ci
    f = (lambda v: f'{100 * v:.1f}') if pct else (lambda v: f'{v:.{digits}f}')
    return f' [{f(lo)}, {f(hi)}]'


def _pp(x: float | None) -> str:
    return '—' if x is None else '0.0 pp' if abs(x) < 5e-4 else f'{100 * x:+.1f} pp'


def zero_upper(n: int) -> float | None:
    """Wilson 95% upper bound on a rate observed as 0/n (e.g. discordant pairs)."""
    return stats.wilson(0, n)[1] if n else None


def repeat_runs(x: dict[str, Any]) -> int:
    """Repeat-phase runs behind one arm's noise estimate (every run beyond the main-phase one)."""
    return sum((int(k) - 1) * v for k, v in (x.get('runs_per_task') or {}).items())


def max_pair_disagreement(k: int) -> float:
    """The largest pair disagreement one task can show over k runs (split as evenly as possible)."""
    return (k // 2) * (k - k // 2) / (k * (k - 1) / 2) if k > 1 else 0.0


def noise_upper(x: dict[str, Any]) -> float | None:
    """Upper bound on an arm's pair disagreement when no task flipped: task-flip upper bound × the most one task can add."""
    ks = [int(k) for k in (x.get('runs_per_task') or {})]
    ci = x.get('task_flip_ci')
    return ci[1] * max_pair_disagreement(max(ks)) if ks and ci else None


def _diff_cell(x: dict[str, Any], primary: bool) -> str:
    r = x['resolve']
    if r['a_only'] + r['b_only'] == 0:
        ub = zero_upper(r['n'])
        if primary:  # keep the pre-registered interval, add the bound the data supports
            return f"{_pp(r['diff'])}{_ci(r['ci'], True)}（0/{r['n']} 不一致，差在 ±{100 * ub:.1f} pp 内）"
        return f"0（0/{r['n']} 不一致，差在 ±{100 * ub:.1f} pp 内）"
    return f"{_pp(r['diff'])}{_ci(r['ci'], True)}"


def _cost_cell(c: dict[str, Any] | None) -> str:
    return '—' if not c else f"{_num(c.get('point'))}{_ci(c.get('ci'), digits=3)}"


def render(data: dict[str, Any]) -> str:
    import analysis_zh

    class _Safe:
        """Written sections are prose over the recorded result; on data they cannot describe (a crash in a section),
        print a marker instead of failing the whole report."""
        def __getattr__(self, name: str):  # noqa: ANN204
            fn = getattr(analysis_zh, name)

            def call(d: dict[str, Any]) -> list[str]:
                try:
                    return fn(d)
                except (KeyError, TypeError, ValueError, ZeroDivisionError, IndexError) as e:
                    return [f'（本段无法从当前数据生成：{type(e).__name__}，需要重写 analysis_zh.{name}。）']
            return call

    az = _Safe()
    L: list[str] = ['# Codex × DeepSWE（R2E-Gym）路由实验报告', '',
                    '> 由 `experiments/codex-deepswe/report.py`（表格）与 `analysis_zh.py`（正文）从 `results/report-data.json` 生成；'
                    '文中数字都来自该数据文件。重新生成：`uv run experiments/codex-deepswe/cli.py report --out <本文件>`。只记录任务 id，不含数据集文本。', '']
    warn = az.checks(data)
    if warn:
        L += ['> ⚠ 正文按下列前提写成，当前数据不满足，需要重写对应段落：', *[f'> - {w}' for w in warn], '']
    L += ['## 摘要', '', *az.summary(data), '']

    sf = data.get('selection_facts') or {}
    L += ['## 1. 实验设置', '', *az.setup(data), '']
    L += ['| 组 | 模型与路径 | 任务数 | 任务选择 |', '|---|---|---|---|']
    for a, model, path, how in (
            ('A', 'Sol（standard）', '网关 → 路由器，`auto` + `pin=Sol`', '全部主任务'),
            ('F', 'Luna（fast）', '网关 → 路由器，`auto` + `pin=Luna`', '全部主任务'),
            ('C', 'Astra（frontier）', '网关 → 路由器，`auto` + `pin=Astra`', '按规模分层的子集'),
            ('B', '路由器选择（评估器 v2.1，auto，autoRules all）', '网关 → 路由器，`auto`', '按规模分层的子集'),
            ('D', 'Sol', '直连 bedrock-runtime（不经网关和路由器）', '按规模分层的子集')):
        n = (data.get('counts') or {}).get(a, 0)
        sc = (sf.get('subset_size_counts') or {}).get(a)
        L.append(f"| {ARM_LABEL.get(a, a)} | {model}；{path} | {n} | {how}{'' if not sc else '（' + '/'.join(f'{k} {v}' for k, v in sorted(sc.items())) + '）'} |")
    L += ['', f"- 运行数：主阶段 {sum((data.get('counts') or {}).values())}，重复阶段 {sum(repeat_runs(x) for x in (data.get('repeats') or {}).values())}，试点 {(data.get('pilot') or {}).get('runs', 0)}；"
          f"seed {data['seed']}，bootstrap {data['n_boot']} 次。", '']
    tp = data.get('tierpass')
    if tp:
        lat = tp.get('latency_ms') or {}
        L += ['### 离线 tier pass（D2）', '',
              f"- {tp['n']} 个候选，评估器 Luna（pack v2.1，autoRules all），花费 ${tp['cost_usd']:.3f}。",
              f"- 不计时限的意见：{_counts(tp['pred_tier_untimed'])}；按 {tp.get('recorded_deadline_ms', 1500)} ms 时限判定：{_counts(tp['pred_tier'])}"
              f"（{tp['within_deadline']}/{tp['n']} 在时限内）。",
              f"- 延迟（开发机测得）：p10 {lat.get('p10')} ms，p50 {lat.get('p50')} ms，p90 {lat.get('p90')} ms，p95 {lat.get('p95')} ms，最大 {lat.get('max')} ms。"]
        dl = tp.get('deadlines') or {}
        if dl:
            L += ['', '| 路由器评估器超时 | 在时限内 | 路由器可用的意见 |', '|---|---|---|']
            L += [f"| {d} ms | {v['within']}/{tp['n']} | {_counts(v['pred_tier'])} |" for d, v in sorted(dl.items(), key=lambda kv: int(kv[0]))]
            L.append('')
        L += ['- 结论：Codex 规模的任务卡上评估器从不给出 fast/frontier；按 1500 ms 时约六成请求超时、退回默认 tier。'
              '因此 B 组与 A 组一样由 Sol 服务，改为增加固定 Luna 的 F 组（设计 §11）；主运行把路由器评估器超时提高到 5000 ms（设计 §13），'
              '按同一批记录离线重算，所有请求都在时限内，结论不变。',
              '- 试点中唯一的 B 运行仍用 1500 ms 超时（试点数据不进入分析）。', '']

    L += ['## 2. 各组概览', '', '| 组 | n | 解决率 [95% CI] | 总成本 $ | $/解决 | 缓存命中率 | 退出原因 |', '|---|---|---|---|---|---|---|']
    for a, s in data['arms'].items():
        L.append(f"| {ARM_LABEL.get(a, a)} | {s['n']} | {s['resolved']}/{s['n']} = {_pct(s['rate'])}{_ci(s['ci'], True)} | {s['sum_cost']:.2f} | "
                 f"{'—' if s['usd_per_solved'] is None else f'{s['usd_per_solved']:.3f}'} | {_pct(s['cache_hit_rate'])} | {_counts(s['exit'])} |")
    L += ['', '- 解决率的方括号为 Wilson 95% CI（%）。各组的任务集不同（C、B、D 是子集），组间比较只看第 3、4 节的配对结果。成本按路由器日志计价（D 组按代理记录），B 组含评估器调用费用。', '']
    tm = data.get('timing') or {}
    if tm:
        L += ['| 组 | 运行墙钟 p50（p90） | 其中 Codex p50 | 模型调用数 p50 | 首字节 p50 | 路由器开销 p50 | 路由器开销最大值（不含评估器等待） |',
              '|---|---|---|---|---|---|---|']
        for a, t in tm.items():
            L.append(f"| {ARM_LABEL.get(a, a)} | {_num(t['wall_s_p50'], 1)} s（{_num(t['wall_s_p90'], 1)} s） | {_num(t['codex_s_p50'], 1)} s | "
                     f"{_num(t['calls_p50'], 1)} | {_num(t['ttfb_ms_p50'], 0)} ms | "
                     f"{'—（不经路由器）' if t['router_overhead_ms_p50'] is None else f'{t['router_overhead_ms_p50']:.0f} ms'} | "
                     f"{'—' if t['router_overhead_ms_max_excl_assessor'] is None else f'{t['router_overhead_ms_max_excl_assessor']:.0f} ms'} |")
        L += ['', '- 墙钟从代理容器启动到取出补丁（含环境准备与安装 Codex，不含评分），Codex 时间只算 `codex exec`。首字节为代理测得的上游首字节时间（每运行的中位数再取中位数）。'
              '路由器开销取自路由器日志 `overheadMs`（请求体解析完到发往上游）；B 组会话开始的那个请求还要等评估器，见第 4 节。', '']

    L += ['## 3. 主要问题（预注册，设计 §11）', '',
          '| 比较 | n | 解决率差（X−A） | 不一致对 A only / X only | McNemar p | 总成本比 ΣX/ΣA | $/解决比 |', '|---|---|---|---|---|---|---|']
    for arm, label in (('F', 'F vs A（fast 是否够用）'), ('C', 'C vs A（frontier 是否值得）'),
                       ('B', 'B vs A（描述性：路由器全路径）'), ('D', 'D vs A（描述性：直连，无网关/路由器）')):
        x = data.get(f'{arm}_vs_A')
        if not x:
            continue
        r = x['resolve']
        L.append(f"| {label} | {x['n']} | {_diff_cell(x, bool(x.get('primary')))} | {r['a_only']}/{r['b_only']} | {_p(r['p_mcnemar'])} | "
                 f"{_cost_cell(x['cost']['ratio_of_sums'])} | {_cost_cell(x.get('usd_per_solved_ratio'))} |")
    L += ['', '- 不一致对为 0 时，Newcombe 区间按条件读会偏窄（它只反映两组 Wilson 区间的不对称），所以另给出 0/n 不一致对的 Wilson 95% 上界：两组解决率之差不会超过不一致率。'
          'B、D 是描述性比较，只给这个上界。解决数相同时 $/解决比等于总成本比。', '']
    by = data.get('F_vs_A_by_size') or {}
    if by:
        L += ['| F vs A 按规模（描述性） | n | A 解决率 | F 解决率 | 差（F−A） | A only / F only | 成本比 ΣF/ΣA |', '|---|---|---|---|---|---|---|']
        for size in ('small', 'medium', 'large'):
            b = by.get(size)
            if not b:
                continue
            r = b['resolve']
            L.append(f"| {size} | {b['n']} | {_pct(r['rate_a'])} | {_pct(r['rate_b'])} | {_pp(r['diff'])}{_ci(r['ci'], True)} | {r['a_only']}/{r['b_only']} | "
                     f"{_cost_cell(b['cost']['ratio_of_sums'])} |")
        L.append('')
    rp = data.get('repeats') or {}
    fa = data.get('F_vs_A')
    if rp:
        L += ['| 运行间噪声（重复阶段） | 任务数 | 每任务运行数 | 成对不一致率 | 翻转的任务 |', '|---|---|---|---|---|']
        for arm in ('A', 'F'):
            x = rp.get(arm)
            if not x:
                continue
            pd = x['pair_disagreement']
            # One bound for every arm (review: with one mixed task the percentile bootstrap is anti-conservative).
            pd_cell = f"{'0' if pd == 0 else _pct(pd)}（上界 ≈ {_pct(noise_upper(x))}）"
            L.append(f"| {arm} 对自身 | {x['tasks']} | {'/'.join(sorted(x['runs_per_task']))} | {pd_cell} | "
                     f"{x.get('mixed_tasks', 0)}/{x['tasks']}（{_pct(x['task_flip_rate'])}{_ci(x.get('task_flip_ci'), True)}） |")
        if fa:
            L.append(f"| 对照：F vs A 不一致率（全部任务） | {fa['n']} | 1 | {_pct(fa['resolve']['discordance'])} | — |")
        fr = data.get('F_vs_A_on_repeat_tasks')
        if fr:
            L.append(f"| 对照：F vs A 不一致率（同一批重复任务，rep 1） | {fr['n']} | 1 | {_pct(fr['discordance'])} | — |")
        L += ['', '- 主阶段每个（任务, 组）只跑一次，不一致对同时包含组间差异与 Codex 自身的运行间波动；重复阶段的成对不一致率是同一组对自身的基线。'
              '纯噪声基准是 A 与 F 成对不一致率的均值，不是其中任一个。重复任务按规模分层抽取，因此另列同一批任务上的 F vs A 不一致率。'
              '成对不一致率的上界 = 翻转率的 Wilson 95% 上界 × 单个任务最多能贡献的成对不一致率（3 次运行时为 2/3）。', '']
    L += [*az.primary(data), '']

    ir = data.get('ideal_router') or {}
    if ir.get('F_A') or ir.get('F_A_C'):
        L += ['### 理想路由与升级策略（描述性上界）', '',
              '| 变体 | n | 解决 / 成本 $ | 选择分布 | 对比 always-Sol：解决率差 | 成本比 | 评估器实际选择（standard） |', '|---|---|---|---|---|---|---|']
        for key, label in (('F_A', '理想 F/A，全部任务'), ('F_A_C', '理想 F/A/C，C 子集'), ('noise_A_B', '理想 A/B（两次 Sol 运行，纯噪声增益）')):
            v = ir.get(key)
            if not v:
                continue
            vs = v['vs']['always_sol']
            asr = v['vs'].get('assessor_choice')
            rd = vs['resolve_diff']
            gain = (f"无增益（0/{v['n']} 个任务，上界 {_pct(zero_upper(v['n']))}）" if key == 'noise_A_B' else f"无增益（0/{v['n']} 个任务）") \
                if rd['diff'] == 0 and _degenerate(rd.get('ci')) else f"{_pp(rd['diff'])}{_ci(rd['ci'], True)}"
            L.append(f"| {label} | {v['n']} | {v['ideal']['solved']} / {v['ideal']['cost']:.2f} | {_counts(v['choice_counts'])} | {gain} | "
                     f"{_cost_cell(vs['cost_ratio'])} | {'—' if not asr else f'解决 {asr['solved']}，成本 ${asr['cost']:.2f}'} |")
        eo = data.get('escalation_oracle')
        if eo:
            L.append(f"| 升级：先 F，F 失败再用 A（完美失败检测） | {eo['n']} | {eo['solved']} / {eo['cost']:.2f} | F {eo['n']}，其中 {eo['escalated']} 次再跑 A | "
                     f"— | {_num(eo['cost_ratio_vs_always_sol'])} | — |")
        L += ['', '- 理想路由是事后的 oracle：按 tier 从便宜到贵取第一个解决该任务的组，并支付该组在该任务上的实际成本；无组解决时取最便宜的组。'
              '它需要预先知道每个任务的结果，包含运行间波动带来的膨胀（见 A/B 行），不是可实现的策略。'
              '升级行不需要预知，只需要在 F 运行结束时可靠地判断失败；它为每个任务付 F 的费用，再为每次失败付 A 的费用，墙钟也相应增加。', '']
        fs = data.get('failure_signals') or {}
        if fs:
            L += ['| F 运行的表面特征（描述性） | n | 模型调用 p50 | 命令数 p50 | 失败命令 p50 | 输出 token p50 | 墙钟 p50 |', '|---|---|---|---|---|---|---|']
            for k, label in (('F_solved', 'F 解决'), ('F_failed_A_solved', 'F 失败、A 解决'), ('both_failed', '两组都失败')):
                g = fs.get(k)
                if g:
                    L.append(f"| {label} | {g['n']} | {_num(g['calls_p50'], 1)} | {_num(g['commands_p50'], 1)} | {_num(g['commands_failed_p50'], 1)} | "
                             f"{_num(g['output_tokens_p50'], 0)} | {_num(g['wall_s_p50'], 1)} s |")
            L.append('')
        L += [*az.ideal(data), '']

    L += ['## 4. 路由器全路径（B）、评估器与直连（D）', '']
    asr = data.get('assessor')
    if asr:
        la, cf = asr['latency_ms'], asr['confidence']
        L += ['| 评估器（B 组，会话开始） | 值 |', '|---|---|',
              f"| 会话数 / 咨询次数 | {asr['runs']} / {asr['consults']} |",
              f"| 状态 | {_counts(asr['status'])} |",
              f"| 给出的 tier（提议 / 最终） | {_counts(asr['proposed'])} / {_counts(asr['tier'])} |",
              f"| 改变了决策（applied） | {_counts(asr['applied'])} |",
              f"| 依据（rule / fact 代码） | {_counts(asr['basis'])} |",
              f"| 置信度 最小 / 中位 / 最大 | {_num(cf['min'], 2)} / {_num(cf['p50'], 2)} / {_num(cf['max'], 2)} |",
              f"| 延迟（路由器内） 最小 / 中位 / 最大 | {la['min']} / {_num(la['p50'], 0)} / {la['max']} ms（{la['within_1500']}/{la['n']} ≤ 1500 ms） |",
              f"| 费用 | ${asr['cost_usd']:.4f}（占 B 组费用 {_pct(asr['cost_share_of_arm'])}） |", '']
    L += [*az.router_path(data), '']

    L += ['## 5. 路由透明性与开销（H4、D9–D13）', '', '| 组 | 缓存保留率 | 缓存丢失事件 | 首次调用缓存读 | 网关 fallback 调用 | 路由 failover | 网络命令 | 代理拒绝 |', '|---|---|---|---|---|---|---|---|']
    for a, t in (data.get('transparency') or {}).items():
        L.append(f"| {a} | {_pct(t['cache_retention'])} | {_counts(t['cache_loss_events']) if t['cache_loss_events'] else '无'} | {t['first_call_cache_read_tokens']} | "
                 f"{t['gateway_fallback_calls']} | {t['router_failovers']} | {t['network_commands']} | {_counts(t['proxy_refused']) if t['proxy_refused'] else '无'} |")
    L += ['', *az.transparency(data), '']

    L += ['## 6. 成本', '', *az.costs(data), '']
    L += ['## 7. 对路由策略的含义与下一步', '', *az.implications(data), '']

    choice = {p['task_id']: p['choice'] for p in ((data.get('ideal_router') or {}).get('F_A') or {}).get('per_task', [])}
    L += ['## 8. 逐任务结果（仅 id）', '', '| 任务 | 仓库 | 规模 | 预测 tier（限时/不限时） | A | F | C | B（tier/模型） | D | 理想（F/A） |',
          '|---|---|---|---|---|---|---|---|---|---|']
    for r in data.get('per_task') or []:
        def cell(x: dict | None) -> str:
            return '—' if not x else ('✓' if x['resolved'] else '✗') + f" ${x['cost_usd']:.2f}"
        b = r.get('B')
        L.append(f"| {r['task_id']} | {r['repo']} | {r['size']} | {r['pred_tier']}/{r.get('pred_tier_untimed') or '—'} | {cell(r.get('A'))} | "
                 f"{cell(r.get('F'))} | {cell(r.get('C'))} | "
                 f"{cell(b)}{'' if not b else f' {b.get('tier') or '—'}/{(b.get('served') or '—').split('.')[-1]}'} | {cell(r.get('D'))} | {choice.get(r['task_id'], '—')} |")
    if data.get('excluded_tasks'):
        L += ['', f"- 因 harness 无法重建扩展（rebuild-unavailable）而排除出所有比较的任务：{', '.join(data['excluded_tasks'])}"]
    L += ['', '- 预测 tier 是离线 tier pass 按 1500 ms 时限 / 不限时的结果；成本 $0.00 表示不到半美分。', '']

    L += ['## 9. 局限', '', '### 预注册的功效假设（运行前；`stats.py` 原文）', '']
    L += [f'- {x}' for x in data.get('limitations') or []]
    L += ['', '### 实际观测', '', *az.observed(data), '', '### 其他局限', '', *az.limitations(data),
          '- Codex 对 `auto` 与 Bedrock 模型 id 都使用回退的模型元数据（"Model metadata ... not found"），各组一致。',
          '- Codex 的权限说明写的是 “Network access is enabled”（danger-full-access）；容器实际没有出网路由，提示词也说明了无网络。',
          '- 离线 tier pass 的延迟在开发机上测得（不是路由器任务内），pred_tier 以 1.5 s 为界，可能与线上略有差异（第 4 节为路由器内实测）。',
          '- 选择假设：未通过 gold 验证而被替换的任务与留下的任务可交换（与结果无关）。' + _validation_note(data.get('validation')), '']
    return '\n'.join(L) + '\n'
