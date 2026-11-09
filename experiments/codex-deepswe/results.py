"""Result rows (results/results.jsonl, one per run) and the per-call summaries behind D9, D10 and D13.

Row schema `codex-deepswe-run/v1` (text-free: ids, codes and numbers only):
  run_id, phase ('pilot'|'main'|'repeat'), arm ('A'|'B'|'C'|'D'), task_id, repo, size_bucket, pred_tier, rep,
  codex: {version, settings}, started_at, ended_at, wall_s, codex_secs, exit_reason
  ('done'|'timeout'|'error'|'budget'|'harness-error'), codex_exit_code,
  events: events.summarize() (turns, commands, network commands, usage at stop, error codes),
  calls: calls_summary() (proxy per-call: served models, router headers, usage, priced cost, cache transparency),
  patch: {raw_bytes, stats, dropped, touches_c_ext}, grade: protocol.grade(), resolved, strict,
  ledger_usd, future_commit_visible, git_stripped, limits, error
"""
from __future__ import annotations

import statistics
from collections import Counter
from collections.abc import Iterable
from typing import Any

import pricing

SCHEMA = 'codex-deepswe-run/v1'
LOSS_FRACTION = 0.5      # call k reads < 50% of call k-1's prompt on the same model → a cache-loss event
MIN_CACHEABLE = 1024
UNPRICED_OUTPUT_TOKENS = 4000


def _p(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


def calls_summary(calls: list[dict[str, Any]]) -> dict[str, Any]:
    calls = sorted(calls, key=lambda c: c.get('seq', 0))
    models: Counter[str] = Counter()
    decisions: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    refused: Counter[str] = Counter()
    tot = {'prompt': 0, 'uncached': 0, 'read': 0, 'write': 0, 'output': 0, 'reasoning': 0}
    cost = 0.0
    unpriced = 0
    unpriced_usd = 0.0
    ttfb: list[float] = []
    pairs = 0
    expected = 0
    got = 0
    losses: list[dict[str, Any]] = []
    first_read = None
    no_router = 0
    for c in calls:
        statuses[str(c.get('status'))] += 1
        if c.get('refused'):
            refused[c['refused']] += 1
            continue
        if c.get('leaf') != 'responses' or c.get('local'):
            continue
        r = c.get('router') or {}
        if r.get('x-router-decision'):
            decisions[r['x-router-decision']] += 1
        if r.get('x-router-reason'):
            reasons[r['x-router-reason']] += 1
        if c.get('status') == 200 and not c.get('via_router') and c.get('arm') != 'D':
            no_router += 1            # served on the gateway path without router headers: the gateway's fallback
        if c.get('ttfb_ms') is not None:
            ttfb.append(c['ttfb_ms'])
        u = c.get('usage')
        m = pricing.resolve(c.get('served_model')) or str(c.get('served_model') or 'unknown')
        if c.get('status') == 200:
            models[m] += 1
        if u:
            for k in tot:
                tot[k] += int(u.get(k) or 0)
            cost += float(c.get('cost_usd') or 0.0)
            if first_read is None:
                first_read = int(u.get('read') or 0)
            prev, prev_model = c.get('prev_prompt'), c.get('prev_model')
            if prev and prev >= MIN_CACHEABLE:
                same = prev_model == pricing.resolve(c.get('served_model'))
                if same:
                    pairs += 1
                    expected += prev
                    got += min(int(u.get('read') or 0), prev)
                if not same or int(u.get('read') or 0) < LOSS_FRACTION * prev:
                    why = ('switch' if not same else 'compaction' if int(u.get('prompt') or 0) < 0.7 * prev
                           else 'failover' if 'failover' in (r.get('x-router-reason') or '') + (r.get('x-router-decision') or '')
                           else 'unexplained')
                    losses.append({'seq': c.get('seq'), 'why': why, 'prev_prompt': prev, 'read': int(u.get('read') or 0)})
        elif c.get('status') == 200 or c.get('mid_stream'):
            # Billed but unpriced (stream cut before the terminal event): estimate from the previous prompt.
            unpriced += 1
            unpriced_usd += float(c['unpriced_estimate_usd']) if c.get('unpriced_estimate_usd') is not None else pricing.cost(
                c.get('served_model') or c.get('prev_model'), {'input_tokens': c.get('prev_prompt') or 0, 'output_tokens': UNPRICED_OUTPUT_TOKENS})['usd']
    return {
        'calls': len(calls), 'responses_calls': sum(models.values()), 'statuses': dict(statuses), 'refused': dict(refused),
        'served_models': dict(models), 'decisions': dict(decisions), 'reasons': dict(reasons),
        'gateway_fallback_calls': no_router, 'usage': tot, 'cost_usd': round(cost, 6),
        'unpriced_calls': unpriced, 'unpriced_estimate_usd': round(unpriced_usd, 6),
        'ledger_usd': round(cost + unpriced_usd, 6),
        'cache': {'first_call_read': first_read, 'same_model_pairs': pairs, 'expected_read': expected, 'read': got,
                  'retention': (got / expected) if expected else None, 'loss_events': losses[:50],
                  'loss_by_reason': dict(Counter(x['why'] for x in losses))},
        'ttfb_ms_p50': _p(ttfb, 0.5), 'ttfb_ms_p99': _p(ttfb, 0.99),
        'budget_stopped': bool(refused.get('budget')),
    }


def build_row(spec: Any, agent: dict[str, Any], grade: dict[str, Any] | None, calls: dict[str, Any],
              codex_meta: dict[str, Any], limits: dict[str, Any]) -> dict[str, Any]:
    t = spec.task
    exit_reason = agent.get('exit_reason')
    if calls.get('budget_stopped') and exit_reason != 'harness-error':
        exit_reason = 'budget'
    g = grade or {}
    return {
        'schema': SCHEMA, 'run_id': spec.run_id, 'phase': spec.phase, 'arm': spec.arm, 'task_id': t.task_id,
        'repo': t.repo, 'size_bucket': t.size, 'pred_tier': spec.pred_tier, 'rep': spec.rep,
        'run_key': f'{spec.phase}/{spec.arm}/{t.task_id}/r{spec.rep}', 'attempt': spec.attempt,
        'codex': codex_meta, 'started_at': agent.get('started_at'), 'ended_at': agent.get('ended_at'),
        'wall_s': agent.get('wall_s'), 'codex_secs': agent.get('codex_secs'), 'exit_reason': exit_reason,
        'codex_exit_code': agent.get('codex_exit_code'), 'events': agent.get('events'), 'calls': calls,
        'patch': agent.get('patch'), 'grade': g, 'resolved': bool(g.get('resolved')), 'strict': bool(g.get('strict')),
        'grade_excluded': bool(g.get('excluded')),
        'ledger_usd': calls.get('ledger_usd'), 'future_commit_visible': agent.get('future_commit_visible'),
        'history_check': agent.get('history_check'),
        'git_stripped': agent.get('git_stripped'), 'limits': limits, 'error': agent.get('error'),
    }


def latest(rows: Iterable[dict[str, Any]]) -> dict[tuple, dict[str, Any]]:
    """The last row per (phase, arm, task, rep): a re-run after a harness error replaces the earlier row."""
    out: dict[tuple, dict[str, Any]] = {}
    for r in rows:
        if r.get('schema') == SCHEMA:
            out[(r['phase'], r['arm'], r['task_id'], r.get('rep', 1))] = r
    return out


def done_keys(rows: Iterable[dict[str, Any]]) -> set[tuple]:
    """Runs that need no re-run: anything except a harness error."""
    return {k for k, r in latest(rows).items() if r.get('exit_reason') != 'harness-error'}


def analysis_row(r: dict[str, Any], join: dict[str, Any] | None) -> dict[str, Any]:
    """The flat row stats.py takes (its documented field list)."""
    calls = r.get('calls') or {}
    u = calls.get('usage') or {}
    j = join or {}
    use_router = bool(j) and j.get('complete', False)
    served = calls.get('served_models') or {}
    return {
        'task_id': r['task_id'], 'arm': r['arm'], 'phase': r['phase'], 'repo': r['repo'], 'size_bucket': r['size_bucket'],
        'pred_tier': r.get('pred_tier') or 'none',
        'resolved': bool(r.get('resolved')) and r.get('exit_reason') != 'harness-error',
        'strict': bool(r.get('strict')),
        'cost_usd': float(j['cost_usd'] if use_router else r.get('ledger_usd') or 0.0),
        'cost_source': 'router' if use_router else 'ledger',
        'input_tokens': int(j.get('prompt_tokens', u.get('prompt', 0)) if use_router else u.get('prompt', 0)),
        'cached_tokens': int(j.get('cache_read_tokens', u.get('read', 0)) if use_router else u.get('read', 0)),
        'output_tokens': int(j.get('output_tokens', u.get('output', 0)) if use_router else u.get('output', 0)),
        'assessor_tier': j.get('assessor_tier') if r['arm'] == 'B' else None,
        'served_model': max(served, key=served.get) if served else None,
        'wall_s': float(r.get('wall_s') or 0.0),
        'exit_reason': {'done': 'done', 'timeout': 'timeout'}.get(r.get('exit_reason') or '', 'error'),
        'exit_detail': r.get('exit_reason'),
        'grade_excluded': bool(r.get('grade_excluded')),
    }


def median(xs: list[float]) -> float | None:
    return statistics.median(xs) if xs else None
