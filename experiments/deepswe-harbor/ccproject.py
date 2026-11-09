"""Claude Code × Harbor (CC orchestration design §2.3, §3): the outcome-blind pilot report and spend projection, the
per-runner caps, and the global budget pre-flight. Stdlib only, dev box only, no AWS.

Outcome-blind (0c): everything here reads cost, timing, call, attribution and host fields of the merged rows and the
final records' status (scored | excluded). It never reads `reward`, `score` or `solved`; `blind_rows` strips them
before any computation, and the tests check that changing every reward changes no output byte.

- κ per arm = the measured Claude Code spend of its finished runs (every attempt, reruns included) ÷ the paired Codex
  arm's measured mean cost on the same tasks (`codex_ref`; plan detail `codex_costs`). Below `min_n` finished runs the
  arm uses its prior: 0d's planning cost per run (arms.json `planning_usd`) ÷ the Codex arm's mean cost on the plan's
  tasks. τ (time) is the same ratio over wall seconds.
- remaining = κ × Codex cost of every planned trial without a final record (dropped tasks left out); runner hours =
  τ × Codex wall ÷ the runner's concurrency.
- caps for the passes being started: hard = settled + 1.4 × remaining(passes) + reserve + the in-flight allowance;
  soft = hard − reserve − the in-flight allowance − the shard's largest block (κ-priced), so blocks already admitted can
  finish; soft is the same as without the allowance. The in-flight allowance (17, after the TB pilot's cap stops) is
  concurrency × the largest per-call reservation hproxy can make for the passes' arms (cc_pricing.call_ceiling: a
  context-window prompt at the cache-write rate plus 128k output). hproxy admits a call only if settled + every
  in-flight reservation + this one ≤ hard − reserve, so without it a small cap stops on the first calls of a full
  runner; it is additive, so it is still free when settled reaches soft. Settled includes the spend of voided attempts
  (merged summary.json `void`): it stays on the ledger.
- the global pre-flight: Σ over every Claude Code ledger (both benchmarks, every runner) of its hard cap — or, once a
  benchmark is closed, its settled spend — plus the spend outside the proxies (budget.json) must be ≤ the budget.
"""
from __future__ import annotations

import hashlib
import json
import math
import pathlib
from collections import Counter, defaultdict
from collections.abc import Callable
from typing import Any

import classify as clf
import shardplan

CAPS_SCHEMA = 'cc-caps/v1'
COMMITTED_SCHEMA = 'cc-caps-committed/v1'
BUDGET_SCHEMA = 'cc-budget/v1'
CAP_MARGIN = 1.4
MIN_N = 4
STAGES = {'stage1': ('pilot', 'main'), 'stage2': ('rep2', 'rep3')}
FINISHED = ('scored', 'excluded')
OUTCOME_FIELDS = frozenset({'reward', 'score', 'solved', 'resolved', 'verifier'})
ROLES = ('main', 'main_subagent', 'helper')
ROLE_COST_TOL = 0.01   # $ per trial, plus 0.5 % (the usual pricing tolerance)


def read_jsonl(p: pathlib.Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in p.read_text(encoding='utf-8').splitlines() if x.strip()] if p.exists() else []


def blind_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The rows without any outcome field (top level, and inside `classification`/`outcome` if present)."""
    out = []
    for r in rows:
        r = {k: v for k, v in r.items() if k not in OUTCOME_FIELDS}
        for k in ('classification', 'outcome'):
            if isinstance(r.get(k), dict):
                r[k] = {x: y for x, y in r[k].items() if x not in OUTCOME_FIELDS}
        out.append(r)
    return out


def void_spend(merged: pathlib.Path) -> dict[str, float]:
    """Per runner, the spend of attempts forgotten by `void-pass` (merged summary.json `void`; fleet merge, Claude
    Code). Replay drops those attempts from attempts.jsonl, but their spend stays on the runner's ledger."""
    p = merged / 'summary.json'
    doc = json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
    return {str(r): round(sum(float(v.get('spent_usd') or 0.0) for v in evs), 6) for r, evs in (doc.get('void') or {}).items()}


def load_merged(merged: pathlib.Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], set[str]]:
    att = blind_rows(read_jsonl(merged / 'attempts.jsonl'))
    finals = blind_rows(read_jsonl(merged / 'final.jsonl'))
    checks = json.loads((merged / 'checks.json').read_text()) if (merged / 'checks.json').exists() else {}
    return att, finals, set(checks.get('dropped') or [])


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def _q(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, max(0, math.ceil(q * len(xs)) - 1))], 3)


# ---------------------------------------------------------------- κ and τ

def ratios(plan: dict[str, Any], detail: dict[str, Any], att: list[dict[str, Any]], finals: list[dict[str, Any]],
           min_n: int = MIN_N, borrow: dict[str, dict[str, Any]] | None = None, prior_m: float = 1.0,
           prior_tau: float = 1.0) -> dict[str, dict[str, Any]]:
    """κ (cost) and τ (wall time) per arm, with their source: 'measured' (≥ min_n finished runs with spend), 'borrowed'
    (the other benchmark's measured value, when given), or 'prior': 0d's planning cost per run × `prior_m` (0d's m; the
    pilot's caps before anything is measured), τ = `prior_tau` (Claude Code 1.3–1.8× Codex)."""
    base = plan['dataset']['base']
    costs, walls = detail.get('codex_costs') or {}, detail.get('codex_wall_s') or {}
    spend: dict[str, float] = defaultdict(float)
    wall: dict[str, float] = defaultdict(float)
    for r in att:
        spend[r['key']] += float(r.get('spent_usd') or 0.0)
        wall[r['key']] += float(r.get('wall_s') or 0.0)
    pilot = plan['passes'].get('pilot') or {}
    labels = {t: lab for lab, ts in (pilot.get('labels') or {}).items() for t in ts}
    picks = {t: ('q25', 'q75')[i] if i < 2 else 'extra' for s, ts in (detail.get('pilot') or {}).items() for i, t in enumerate(ts)}
    out: dict[str, dict[str, Any]] = {}
    for arm, spec in plan['arms'].items():
        ref = spec['codex_ref']
        ks = [f for f in finals if f['arm'] == arm and f.get('status') in FINISHED and ref in (costs.get(f['task']) or {})]
        cc_usd = sum(spend[f['key']] for f in ks)
        cx_usd = sum(float(costs[f['task']][ref]) for f in ks)
        cc_s = sum(wall[f['key']] for f in ks)
        cx_s = sum(float((walls.get(f['task']) or {}).get(ref) or 0.0) for f in ks)
        mean_cx = _mean([float(c[ref]) for t, c in costs.items() if t in plan['tasks'] and ref in c])
        prior = float(spec['planning_usd'][base]) / mean_cx if mean_cx else None
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for f in ks:
            if f.get('pass') == 'pilot':
                groups[labels.get(f['task']) or picks.get(f['task'], 'other')].append(f)
        by_pick = {g: {'n': len(fs), 'kappa': round(sum(spend[f['key']] for f in fs) / s, 3) if (s := sum(float(costs[f['task']][ref]) for f in fs)) else None}
                   for g, fs in sorted(groups.items())}
        if len(ks) >= min_n and cx_usd > 0 and cc_usd > 0:   # no measured spend (e.g. a dry run): not a measurement
            k, src = cc_usd / cx_usd, 'measured'
            t = cc_s / cx_s if cx_s > 0 else 1.0
        elif borrow and arm in borrow and borrow[arm].get('source') == 'measured':
            k, t, src = float(borrow[arm]['kappa']), float(borrow[arm]['tau']), 'borrowed'
        else:
            k, t, src = (prior if prior is not None else 1.0) * prior_m, prior_tau, 'prior'
        out[arm] = {'n': len(ks), 'measured_usd': round(cc_usd, 2), 'codex_usd': round(cx_usd, 2), 'kappa': round(k, 4),
                    'tau': round(t, 4), 'source': src, 'prior_kappa': round(prior, 4) if prior is not None else None, 'pilot_by_pick': by_pick}
    return out


def trial_usd(plan: dict[str, Any], detail: dict[str, Any], rat: dict[str, dict[str, Any]], task: str, arm: str) -> float:
    """κ-priced expected cost of one run; a task without a Codex cost for the paired arm takes that arm's mean."""
    ref = plan['arms'][arm]['codex_ref']
    costs = detail.get('codex_costs') or {}
    c = (costs.get(task) or {}).get(ref)
    if c is None:
        c = _mean([float(v[ref]) for v in costs.values() if ref in v]) or 0.0
    return rat[arm]['kappa'] * float(c)


def trial_s(plan: dict[str, Any], detail: dict[str, Any], rat: dict[str, dict[str, Any]], task: str, arm: str) -> float:
    ref = plan['arms'][arm]['codex_ref']
    walls = detail.get('codex_wall_s') or {}
    w = (walls.get(task) or {}).get(ref)
    if w is None:
        w = _mean([float(v[ref]) for v in walls.values() if ref in v]) or float(plan['tasks'][task].get('agent_timeout_s') or 0) / 2
    return rat[arm]['tau'] * float(w)


# ---------------------------------------------------------------- projection

def projection(plan: dict[str, Any], detail: dict[str, Any], att: list[dict[str, Any]], finals: list[dict[str, Any]], dropped: set[str],
               rat: dict[str, dict[str, Any]], concurrency: int, settled: dict[str, float] | None = None,
               void_usd: dict[str, float] | None = None) -> dict[str, Any]:
    """Per runner: settled spend (its attempts' plus `void_usd`, the voided attempts' spend that stays on the
    ledger), remaining spend and runner hours per pass, the largest single run and block per pass (κ-priced), and the
    totals per stage."""
    done = {f['key'] for f in finals if f.get('status') in FINISHED}
    spent: dict[str, float] = defaultdict(float)
    for r in att:
        spent[str(r['runner'])] += float(r.get('spent_usd') or 0.0)
    for r, v in (void_usd or {}).items():
        spent[str(r)] += float(v or 0.0)
    if settled:
        for r, v in settled.items():
            spent[str(r)] = max(spent[str(r)], float(v or 0.0))
    runners: dict[str, Any] = {}
    for s in range(plan['n_shards']):
        rem: dict[str, float] = {}
        hrs: dict[str, float] = {}
        big_run: dict[str, float] = {}
        big_block: dict[str, float] = {}
        left: dict[str, int] = {}
        for name in plan['passes']:
            usd = secs = 0.0
            n = 0
            run_max = block_max = 0.0
            for b in shardplan.blocks_of(plan, name, s):
                if b['task'] in dropped:
                    continue
                blk = 0.0
                for arm in b['arms']:
                    key = f"{name}/{b['task']}/{arm}/r{plan['passes'][name]['rep']}"
                    u = trial_usd(plan, detail, rat, b['task'], arm)
                    run_max, blk = max(run_max, u), blk + u
                    if key in done:
                        continue
                    usd, secs, n = usd + u, secs + trial_s(plan, detail, rat, b['task'], arm), n + 1
                block_max = max(block_max, blk)
            rem[name], hrs[name], left[name] = round(usd, 2), round(secs / max(1, concurrency) / 3600, 2), n
            big_run[name], big_block[name] = round(run_max, 4), round(block_max, 4)
        sr = str(s)
        runners[sr] = {'settled_usd': round(spent.get(sr, 0.0), 2), 'void_usd': round(float((void_usd or {}).get(sr, 0.0)), 2),
                       'remaining_usd': rem, 'remaining_trials': left,
                       'runner_hours': hrs, 'largest_run_usd': big_run, 'largest_block_usd': big_block,
                       'projected_usd': round(spent.get(sr, 0.0) + sum(rem.values()), 2)}
    stages = {st: {'remaining_usd': round(sum(r['remaining_usd'].get(p, 0.0) for r in runners.values() for p in ps), 2),
                   'runner_hours_max': round(max((sum(r['runner_hours'].get(p, 0.0) for p in ps) for r in runners.values()), default=0.0), 2)}
              for st, ps in STAGES.items()}
    return {'runners': runners, 'stages': stages, 'settled_usd': round(sum(r['settled_usd'] for r in runners.values()), 2),
            'projected_usd': round(sum(r['projected_usd'] for r in runners.values()), 2)}


MIN_SOFT_HEADROOM_USD = 5.0   # driver.MIN_EFFECTIVE_CAP_USD: hard − reserve below this is refused
# Concurrent calls per trial slot the in-flight allowance prices at the call ceiling. One: a slot's ceiling (Opus 5.5:
# a 1M-token prompt at the 1h write rate + 128k out, $10.56) is about 2× the largest DeepSWE reservation (C $5.03, A
# $2.77); 241 of 242 DeepSWE trials never had two calls in flight; Claude Code's main call has returned before its
# parallel Task subagents start, and their prompts are small. DeepSWE's runner peak Σ reservations: $17.1–18.9 at
# concurrency 6, against a $63.36 allowance.
CALLS_PER_SLOT = 1


def pass_models(plan: dict[str, Any], passes: list[str]) -> list[str]:
    """Every model hproxy can price a call of these passes at: each arm's client model (the body model it names), main
    model and worst-case model (B's rewritten calls), `auto` left out."""
    arms = {a for p in passes for s in range(plan['n_shards']) for b in shardplan.blocks_of(plan, p, s) for a in b['arms']}
    return sorted({m for a in arms for k in ('client_model', 'main_model', 'worst_model')
                   for m in [(plan['arms'].get(a) or {}).get(k)] if m and m != 'auto'})


def inflight_allowance(plan: dict[str, Any], passes: list[str], concurrency: int, call_ceiling: Callable[[str], float],
                       calls_per_slot: int = CALLS_PER_SLOT) -> dict[str, Any]:
    """concurrency × calls_per_slot × the largest per-call ceiling of the passes' models (USD, rounded up to a cent)."""
    per = {m: round(float(call_ceiling(m)), 4) for m in pass_models(plan, passes)}
    slot = max(per.values(), default=0.0)
    return {'concurrency': int(concurrency), 'calls_per_slot': int(calls_per_slot), 'call_ceiling_usd': per,
            'usd': math.ceil(concurrency * calls_per_slot * slot * 100 - 1e-6) / 100}


def suggest_caps(proj: dict[str, Any], passes: list[str], reserve: float, margin: float = CAP_MARGIN,
                 inflight: float = 0.0) -> dict[str, dict[str, float]]:
    """CC design §3: base = settled + max(margin × remaining(passes), remaining + the largest block, the largest block
    + $5) + reserve, rounded up to $1; hard = base + `inflight` (inflight_allowance) rounded up to $1; soft = base −
    reserve − the largest block, rounded down to $1. The second term matters for a small slice (a pilot), where margin ×
    remaining alone would put the soft cap below the slice's own projected spend; for a whole pass the margin dominates.
    The allowance raises hard only: soft is exactly what it was without it, and hard − reserve − soft ≥ inflight + the
    largest block, so when the driver stops admitting blocks at soft the in-flight reservations still fit."""
    out = {}
    for r, d in proj['runners'].items():
        rem = sum(d['remaining_usd'].get(p, 0.0) for p in passes)
        block = max((d['largest_block_usd'].get(p, 0.0) for p in passes), default=0.0)
        base = math.ceil(d['settled_usd'] + max(margin * rem, rem + block, block + MIN_SOFT_HEADROOM_USD) + reserve)
        out[r] = {'hard': float(base + math.ceil(inflight - 1e-9)), 'soft': float(math.floor(base - reserve - block)),
                  'largest_run_usd': max((d['largest_run_usd'].get(p, 0.0) for p in passes), default=0.0)}
    return out


# ---------------------------------------------------------------- pilot / interim report (outcome-blind)

def _role(r: dict[str, Any], role: str) -> dict[str, Any]:
    return ((r.get('calls_by_role') or {}).get(role) or {})


def report(plan: dict[str, Any], att: list[dict[str, Any]], passes: list[str] | None = None) -> dict[str, Any]:
    """Per arm, over the attempts of `passes` (default: all): cost, calls and attribution (calls_by_role, null roles,
    the §4.2 served-model checks, assessor consults, sanitising), helper share, timing, 429s, memory/OOM tags and
    host PSI, classes and exception types. No outcome field is read."""
    rows = [r for r in att if passes is None or r.get('pass') in passes]
    out: dict[str, Any] = {}
    for arm, spec in plan['arms'].items():
        rs = [r for r in rows if r.get('arm') == arm]
        pin = spec['main_model'] if spec['main_model'] != 'auto' else None
        roles = {k: {'calls': sum(int(_role(r, k).get('calls') or 0) for r in rs),
                     'cost_usd': round(sum(float(_role(r, k).get('cost_usd') or 0.0) for r in rs), 4),
                     'served_models': dict(sum((Counter(_role(r, k).get('served_models') or {}) for r in rs), Counter()))} for k in ROLES}
        calls = sum(int(r.get('calls') or 0) for r in rs)
        role_calls = sum(v['calls'] for v in roles.values())
        role_cost = sum(v['cost_usd'] for v in roles.values())
        gaps = [r['trial_id'] for r in rs if r.get('calls_by_role') is not None and
                abs(sum(float(_role(r, k).get('cost_usd') or 0.0) for k in ROLES) - float(r.get('spent_usd') or 0.0))
                > ROLE_COST_TOL + 0.005 * float(r.get('spent_usd') or 0.0)]
        served_bad = []
        for r in rs:
            mains = set(_role(r, 'main').get('served_models') or {}) | set(_role(r, 'main_subagent').get('served_models') or {})
            if r.get('calls_by_role') is None:
                continue
            if (pin is not None and mains - {pin}) or (pin is None and len(mains) > 1):
                served_bad.append(r['trial_id'])
        consults = Counter(str(r.get('assessor_consults')) for r in rs)
        want = '1' if pin is None else '0'
        walls = [float(r['wall_s']) for r in rs if r.get('wall_s') is not None]
        host = [r.get('host') or {} for r in rs]
        mem = [h.get('mem') or {} for h in host]
        tags = Counter(t for r in rs for t in (r.get('tags') or []))
        psi = {k: max((float(h[k]) for h in host if isinstance(h.get(k), (int, float))), default=None)
               for k in sorted({k for h in host for k in h if k.startswith('psi_')})}
        out[arm] = {
            'attempts': len(rs), 'trials': len({r['key'] for r in rs}), 'spent_usd': round(sum(float(r.get('spent_usd') or 0.0) for r in rs), 2),
            'calls': calls, 'calls_by_role': roles,
            'attribution': {'unattributed_calls': calls - role_calls if any(r.get('calls_by_role') is not None for r in rs) else None,
                            'no_role_summary': sum(1 for r in rs if r.get('calls_by_role') is None),
                            'role_cost_gap_trials': gaps, 'served_model_violations': served_bad,
                            'assessor_consults': dict(consults), 'assessor_consult_violations': sum(n for c, n in consults.items() if c != want),
                            'sanitized_requests': sum(int(r.get('sanitized_requests') or 0) for r in rs)},
            'helper_share': round(roles['helper']['cost_usd'] / role_cost, 4) if role_cost > 0 else None,
            'throttled_429': sum(int(r.get('throttled') or 0) for r in rs),
            'rate_429': round(sum(int(r.get('throttled') or 0) for r in rs) / calls, 4) if calls else None,
            'wall_s': {'p50': _q(walls, 0.5), 'p90': _q(walls, 0.9), 'max': max(walls, default=None)},
            'agent_s_max': max((float(r['agent_s']) for r in rs if r.get('agent_s') is not None), default=None),
            'memory_mb': {f: {'p50': _q(xs, 0.5), 'p95': _q(xs, 0.95), 'max': max(xs, default=None)}
                          for f in ('agent_rss_peak_mb', 'container_mem_peak_mb', 'anon_peak_mb', 'swap_peak_mb')
                          for xs in [[float(m[f]) for m in mem if isinstance(m.get(f), (int, float))]]},
            'oom': {'tags': dict(tags), 'host_oom_trials': sum(1 for h in host if int(h.get('oom_global_trial') or 0) > 0)},
            'psi_max': psi,
            'classes': dict(Counter(str(r.get('class')) for r in rs)),
            'exception_types': dict(Counter(str(r.get('exception_type')) for r in rs if r.get('exception_type'))),
            'cc_result_missing': sum(1 for r in rs if (r.get('cc') or {}).get('result') == 'missing'),
        }
    return out


# ---------------------------------------------------------------- §4.2 preconditions, per call (0d design-stats §4.2, §11–§13)

# The anthropic-messages pool of the experiment router (policy.experiment-cc): the model each assessed tier maps to.
CC_TIER_MODEL = {'frontier': 'global.anthropic.claude-opus-5-5', 'standard': 'global.anthropic.claude-sonnet-5-5',
                 'fast': 'global.anthropic.claude-haiku-5-5'}
ROLE_TABLE_SCHEMA = 'cc-native-roles/v1'
MAIN_ROLES = ('main', 'main_subagent')
NULL_ROLE_OK_ARMS = ('F',)   # §12.3: in F a structurally ambiguous call_role may be null if attributed and served by the pin
SAMPLE = 10                  # trial ids listed per violation kind
AUX_LEAVES = ('messages/count_tokens',)   # 0d §16 (Amendment 7): non-model auxiliary calls
MODEL_LEAVES = ('messages', 'responses')


def is_count_tokens(c: dict[str, Any]) -> bool:
    """A count_tokens candidate: its path, or hproxy's tag (4f). Whether it is exempt is count_tokens_exempt's call."""
    return c.get('leaf') in AUX_LEAVES or c.get('call_type') == 'count_tokens'


def is_model_call(c: dict[str, Any]) -> bool:
    """A model call record (/v1/messages, /v1/responses), as hproxy counts them in the trial summary's `calls`."""
    leaf = c.get('leaf')
    return leaf in MODEL_LEAVES or (leaf is None and c.get('method') in (None, 'POST'))


NON_MODEL = 'non_model'   # cc_calls.NON_MODEL: hproxy's role and struct on the count_tokens records it tags


def count_tokens_exempt(c: dict[str, Any], router_extra: int) -> bool:
    """0d §16.1, re-checked from the record whether hproxy tagged it or not (DeepSWE main ran an hproxy without the tag):
    POST, path exactly messages/count_tokens, status 404, origin gateway (hproxy's label for its own local 404), no
    router response headers, no router log event joined to it (router_extra: the trial's router events beyond its
    forwarded model calls; router events carry no path, so this is per trial), zero ledger cost and no usage. The tag
    must agree: tagged (call_type count_tokens) means role = struct = non_model, untagged means no call_type and a null
    role and struct; anything else is a tag/leaf disagreement."""
    tagged = c.get('call_type') == 'count_tokens'
    marks = (c.get('call_role'), c.get('call_role_struct'))
    tag_ok = marks == (NON_MODEL, NON_MODEL) if tagged else (c.get('call_type') is None and marks == (None, None))
    return (tag_ok and c.get('method') == 'POST' and c.get('leaf') == 'messages/count_tokens' and c.get('status') == 404
            and c.get('origin') == 'gateway' and not c.get('router') and not c.get('via_router') and router_extra == 0
            and not float(c.get('cost_usd') or 0.0) and not float(c.get('unpriced_estimate_usd') or 0.0) and not c.get('usage'))


CHECKS = ('calls_count_mismatch', 'null_role', 'null_or_unknown_struct', 'requested_wrong', 'main_served_wrong',
          'helper_served_wrong', 'no_router_decision', 'router_incomplete', 'consults_not_one', 'gateway_fallback', 'pin_served_other',
          'count_tokens_predicate_broken', 'deviation_in_pilot')
DEVIATION = 'deviation'   # 0d §18 item 5: the role of a deviation whose structure is not recorded


def refusal_fallback_deviation(c: dict[str, Any], ev: dict[str, Any] | None, m_arm: str | None) -> bool:
    """0d design-stats §18 item 5 (Amendment 9): the request hproxy refused in a refusal-fallback trial is a §13
    deviation (requested_model ≠ M_arm), reported, not a gate failure in main. Strict: the trial meets
    classify.refusal_fallback_blocked, this record is its last model call (seq and t_start), and the record is the
    refusal itself (POST messages, 403, origin proxy, refused model-not-allowed, never forwarded: no router headers,
    no served model, no cost, no usage)."""
    last = (ev or {}).get('last_call') or {}
    return (clf.refusal_fallback_blocked(ev, m_arm) and c.get('seq') == last.get('seq') and c.get('t_start') == last.get('t_start')
            and c.get('method') == 'POST' and c.get('leaf') == 'messages' and c.get('status') == 403 and c.get('origin') == 'proxy'
            and c.get('refused') == clf.POOL_REFUSED and not c.get('router') and not c.get('via_router') and not c.get('served_model')
            and not float(c.get('cost_usd') or 0.0) and not c.get('usage'))


def load_role_table(path: pathlib.Path, sha256: str) -> dict[str, Any]:
    """4f's frozen native role table (experiments/claude-code-harbor/native-roles.json, schema cc-native-roles/v1;
    design-stats §13 4a), loaded only if its sha256 (hex of the file's bytes) is the one recorded in §13.
    `roles.<request type>.requested`: "M" (the main model), a model id, or null (never observed: a call of that type
    is a violation)."""
    raw = path.read_bytes()
    got = hashlib.sha256(raw).hexdigest()
    if got != sha256.lower():
        raise SystemExit(f'{path.name}: sha256 {got} is not the recorded {sha256} (design-stats §13)')
    doc = json.loads(raw)
    if doc.get('schema') != ROLE_TABLE_SCHEMA or not isinstance(doc.get('roles'), dict):
        raise SystemExit(f'{path.name}: schema {ROLE_TABLE_SCHEMA} with `roles` required')
    return {**doc, '_sha256': got}


def expected_model(table: dict[str, Any], req_type: str | None, main_model: str | None) -> str | None:
    """table[request type](M); None if the type is not in the table, has no requested model, or M is unknown: a
    violation, never a default."""
    if not req_type or not main_model:
        return None
    v = ((table.get('roles') or {}).get(req_type) or {}).get('requested')
    return main_model if v == 'M' else (v if isinstance(v, str) and v else None)


def call_type(c: dict[str, Any]) -> str | None:
    """The structural request type of a call record: 0d's `call_role_struct` (4f's hproxy `call_type` as fallback)."""
    v = c.get('call_role_struct', c.get('call_type'))
    return str(v) if v else None


def precondition_checks(plan: dict[str, Any], att: list[dict[str, Any]], calls: list[dict[str, Any]],
                        role_table: dict[str, Any] | None = None, tier_model: dict[str, str] | None = None,
                        passes: list[str] | None = None) -> dict[str, Any]:
    """0d §4.2 over the per-call records (merged calls.jsonl: trial_id, call_role, call_role_struct, requested_model,
    served_model) and the router join merged into each attempt row (`router`: assessor_tier, assessor_consults,
    complete), for the attempts in `passes`. Per call, in every arm:
    - (1) attributed to a trial, and the trial's call count matches its proxy summary; the router saw every call;
    - (2) a call_role (null allowed only in F, §12.3) and a call_role_struct in the role table (§13: required everywhere);
    - (5, §13 4a) requested_model = table[call_role_struct](M_arm), M_arm = the pin, or B's assessed tier's model;
    - (3)/(4) main and main_subagent calls served by M_arm; B: one assessor consult per root session (router logs);
    - (5) helper calls served by their requested model.
    - 0d §16 (Amendment 7): a count_tokens call (its path, or call_type count_tokens) that meets count_tokens_exempt is a
      non-model auxiliary call: exempt from the role, model and count checks, listed under `count_tokens_exempt`
      (trial_id, seq, t_start) and counted per arm under `count_tokens` (n, n_404, trials_with). One that does not meet
      it (another status, a router event, cost or usage) fails `count_tokens_predicate_broken`: the route changed, stop
      the run. Still failing: one without a trial (`unattributed_calls`), any other null-role call or other path.
    - 0d §18 (Amendment 9) item 5: the request hproxy refused in a refusal-fallback trial (refusal_fallback_deviation)
      is a §13 deviation: role from its structure if recorded, else `deviation`; listed under `deviations` and counted
      per arm and type under each arm's `deviations`. In main it is reported, not a failure; in a pilot it fails
      `deviation_in_pilot`. Any other null-role call still fails null_role.
    - calls_count_mismatch counts model calls only (/v1/messages): per trial, the proxy summary's `calls` = its model
      call records, and the router's events = its forwarded model calls, 1:1 (fewer: `router_incomplete`; more:
      calls_count_mismatch, or count_tokens_predicate_broken when the trial has count_tokens calls).
    - 0c (2026-11-07): no attempt with a call answered by the gateway's fallback (`gateway_fallback`, the proxy's
      count), no pinned call served by another model (`pin_served_other`), and the router log short of the proxy's
      forwarded calls only on attempts that were rerun since (`router_incomplete` counts each key's last attempt;
      the superseded ones are listed under `router_short_superseded`).
    `ok` is the pilot gate: every count 0, a role table and router data present. Outcome-blind."""
    tm = tier_model or CC_TIER_MODEL
    rows = [r for r in att if passes is None or r.get('pass') in passes]
    by_tid = {r['trial_id']: r for r in rows}
    out: dict[str, Any] = {}
    v: dict[str, dict[str, list[str]]] = {arm: {k: [] for k in CHECKS} for arm in plan['arms']}
    n_calls: Counter[str] = Counter()
    struct: dict[str, Counter[str]] = defaultdict(Counter)
    agree: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    m_arm: dict[str, str | None] = {}
    last_n: dict[str, int] = {}
    for r in rows:
        last_n[str(r.get('key'))] = max(last_n.get(str(r.get('key')), 0), int(r.get('attempt') or 0))
    superseded: list[str] = []
    router_extra: dict[str, int] = {}
    for tid, r in by_tid.items():
        rt0 = r.get('router') or {}
        if rt0.get('requests') is not None and rt0.get('expected_model_requests') is not None:
            router_extra[tid] = max(0, int(rt0['requests']) - int(rt0['expected_model_requests']))
    for tid, r in by_tid.items():
        spec = plan['arms'][r['arm']]
        if spec['main_model'] != 'auto':
            m_arm[tid] = spec['main_model']
        else:
            m_arm[tid] = tm.get(str((r.get('router') or {}).get('assessor_tier')))
            if m_arm[tid] is None:
                v[r['arm']]['no_router_decision'].append(tid)
            elif int((r.get('router') or {}).get('assessor_consults') or 0) != 1:
                v[r['arm']]['consults_not_one'].append(tid)
        rt = r.get('router')
        if rt is not None and not rt.get('complete'):
            if int(r.get('attempt') or 0) >= last_n.get(str(r.get('key')), 0):
                v[r['arm']]['router_incomplete'].append(tid)
            else:
                superseded.append(tid)
        if int(r.get('gateway_fallback_calls') or 0) > 0:
            v[r['arm']]['gateway_fallback'].append(tid)
        if int(r.get('pin_served_other') or 0) > 0:
            v[r['arm']]['pin_served_other'].append(tid)
    per_trial: Counter[str] = Counter()
    aux: dict[str, dict[str, Any]] = {arm: {'n': 0, 'n_404': 0, 'trials': set()} for arm in plan['arms']}
    exempt: list[dict[str, Any]] = []
    by_trial: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in calls:
        if str(c.get('trial_id')) in by_tid:
            by_trial[str(c.get('trial_id'))].append(c)
    rf_ev = {tid: clf.refusal_evidence(cs) for tid, cs in by_trial.items()}
    devs: dict[str, dict[str, Any]] = {arm: {'n': 0, 'by_type': Counter(), 'trials': set(), 'tasks': set()} for arm in plan['arms']}
    deviations: list[dict[str, Any]] = []
    for c in calls:
        tid = str(c.get('trial_id'))
        r = by_tid.get(tid)
        if r is None:
            continue
        arm = r['arm']
        if is_count_tokens(c):
            aux[arm]['n'] += 1
            aux[arm]['n_404'] += int(c.get('status') == 404)
            aux[arm]['trials'].add(tid)
            if count_tokens_exempt(c, router_extra.get(tid, 0)):
                exempt.append({'trial_id': tid, 'seq': c.get('seq'), 't_start': c.get('t_start'), 'runner': c.get('runner')})
            else:
                v[arm]['count_tokens_predicate_broken'].append(tid)
            continue
        if c.get('refused') == clf.POOL_REFUSED and refusal_fallback_deviation(c, rf_ev.get(tid), m_arm.get(tid)):
            per_trial[tid] += 1   # a model call in the proxy summary's count; never forwarded, so not in the router's
            devs[arm]['n'] += 1
            devs[arm]['by_type'][clf.REFUSAL_FALLBACK] += 1
            devs[arm]['trials'].add(tid)
            devs[arm]['tasks'].add(str(r.get('task')))
            deviations.append({'trial_id': tid, 'seq': c.get('seq'), 't_start': c.get('t_start'), 'runner': c.get('runner'),
                               'pass': r.get('pass'), 'task': r.get('task'), 'arm': arm, 'type': clf.REFUSAL_FALLBACK,
                               'role': c.get('call_role') or DEVIATION, 'requested_model': c.get('requested_model')})
            if r.get('pass') == 'pilot':
                v[arm]['deviation_in_pilot'].append(tid)
            continue
        if is_model_call(c):
            per_trial[tid] += 1
        n_calls[arm] += 1
        role, st, M = c.get('call_role'), call_type(c), m_arm.get(tid)
        struct[arm][str(st)] += 1
        if role not in (*MAIN_ROLES, 'helper') and arm not in NULL_ROLE_OK_ARMS:
            v[arm]['null_role'].append(tid)
        want = expected_model(role_table or {}, st, M) if role_table else None
        if role_table and want is None:
            v[arm]['null_or_unknown_struct'].append(tid)
        elif role_table and c.get('requested_model') != want:
            v[arm]['requested_wrong'].append(tid)
        if role in MAIN_ROLES or (role is None and arm in NULL_ROLE_OK_ARMS):
            if M is not None and c.get('served_model') != M:
                v[arm]['main_served_wrong'].append(tid)
        elif role == 'helper' and c.get('served_model') != c.get('requested_model'):
            v[arm]['helper_served_wrong'].append(tid)
        if role_table and want is not None and role is not None and M is not None:   # §12.3: structural vs model-name role
            implied = 'helper' if want != M else ('main' if st in ('main', 'compaction') else 'main_subagent')
            agree[arm][0] += int(implied == role)
            agree[arm][1] += 1
    for tid, r in by_tid.items():
        proxy_off = r.get('calls') is not None and int(r['calls']) != per_trial[tid]
        router_off = bool(router_extra.get(tid)) and tid not in aux[r['arm']]['trials']   # router events the proxy never forwarded
        if proxy_off or router_off:
            v[r['arm']]['calls_count_mismatch'].append(tid)
    known = {r['trial_id'] for r in att}
    unattributed = sum(1 for c in calls if c.get('trial_id') is None or str(c.get('trial_id')) not in known)
    for arm in plan['arms']:
        a = agree[arm]
        out[arm] = {'trials': sum(1 for r in rows if r['arm'] == arm), 'calls': n_calls[arm], 'by_struct': dict(struct[arm]),
                    'struct_role_agreement': round(a[0] / a[1], 4) if a[1] else None,
                    'count_tokens': {'n': aux[arm]['n'], 'n_404': aux[arm]['n_404'], 'trials_with': len(aux[arm]['trials'])},
                    'deviations': {'n': devs[arm]['n'], 'by_type': dict(devs[arm]['by_type']), 'trials_with': len(devs[arm]['trials']),
                                   'tasks': sorted(devs[arm]['tasks'])},
                    **{k: {'n': len(v[arm][k]), 'trial_ids': sorted(set(v[arm][k]))[:SAMPLE]} for k in CHECKS}}
    have_router = any(r.get('router') is not None for r in rows)
    # the router-event leg of §16.1 needs the join's `requests` (fleet.py merge --router-logs from 2026-11-07 on)
    no_requests = sum(1 for r in rows if (r.get('router') or {}).get('model_requests') and (r.get('router') or {}).get('requests') is None)
    ok = (role_table is not None and have_router and unattributed == 0 and not no_requests
          and all(out[a][k]['n'] == 0 for a in out for k in CHECKS))
    return {'ok': bool(ok), 'unattributed_calls': unattributed, 'role_table_sha256': (role_table or {}).get('_sha256'), 'router_logs': have_router, 'tier_model': tm,
            'router_short_superseded': {'n': len(superseded), 'trial_ids': sorted(superseded)[:SAMPLE]},
            'count_tokens_exempt': sorted(exempt, key=lambda x: (x['trial_id'], str(x['t_start']))),
            'deviations': sorted(deviations, key=lambda x: (str(x['task']), str(x['arm']), x['trial_id'])),
            'missing': [x for x, have in (('role table', role_table is not None), ('router logs (merge --router-logs)', have_router),
                                          (f'router requests on {no_requests} attempts (re-merge --router-logs with this fleet.py)', not no_requests))
                        if not have],
            'arms': out}


# ---------------------------------------------------------------- caps files and the global budget

def load_caps(path: pathlib.Path, profile: str, passes: list[str]) -> dict[str, dict[str, float]]:
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema') != CAPS_SCHEMA:
        raise SystemExit(f'{path.name}: schema {doc.get("schema")!r}, expected {CAPS_SCHEMA}')
    if doc.get('profile') != profile:
        raise SystemExit(f'{path.name}: written for {doc.get("profile")!r}, not {profile}')
    if sorted(doc.get('passes') or []) != sorted(passes):
        raise SystemExit(f'{path.name}: caps for passes {doc.get("passes")}, but starting {passes}')
    caps = {}
    for r, c in (doc.get('runners') or {}).items():
        if not all(isinstance(c.get(k), (int, float)) and c[k] > 0 for k in ('soft', 'hard')):
            raise SystemExit(f'{path.name}: runner {r}: soft and hard must be positive numbers')
        caps[str(int(r))] = {'soft': float(c['soft']), 'hard': float(c['hard'])}
    return caps


def caps_doc(profile: str, passes: list[str], caps: dict[str, dict[str, float]], basis: dict[str, Any] | None = None) -> dict[str, Any]:
    return {'schema': CAPS_SCHEMA, 'profile': profile, 'passes': list(passes),
            'runners': {r: {'soft': c['soft'], 'hard': c['hard']} for r, c in sorted(caps.items(), key=lambda x: int(x[0]))},
            **({'basis': basis} if basis else {})}


def load_budget(path: pathlib.Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f'{path}: the budget file is needed (schema {BUDGET_SCHEMA}: total_usd, outside_usd {{item: usd}})')
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema') != BUDGET_SCHEMA or not isinstance(doc.get('total_usd'), (int, float)):
        raise SystemExit(f'{path.name}: schema {BUDGET_SCHEMA} with total_usd required')
    if not all(isinstance(v, (int, float)) and v >= 0 for v in (doc.get('outside_usd') or {}).values()):
        raise SystemExit(f'{path.name}: outside_usd values must be non-negative numbers')
    return doc


def load_committed(path: pathlib.Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'schema': COMMITTED_SCHEMA, 'runners': {}}


def exposure(committed: dict[str, Any]) -> float:
    """What a benchmark's ledgers can still spend in total: each runner's hard cap, or its settled spend once closed."""
    return round(sum(float(c['settled_usd'] if c.get('closed') else c['hard']) for c in (committed.get('runners') or {}).values()), 2)


def global_preflight(budget: dict[str, Any], profile: str, new_caps: dict[str, dict[str, float]],
                     committed: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Σ exposure of every Claude Code ledger after this start (the started runners at their new hard caps) + the
    spend outside the proxies ≤ total. `committed`: profile name → its caps-committed doc."""
    after = {name: {'runners': {**{r: dict(c) for r, c in (doc.get('runners') or {}).items()}}} for name, doc in committed.items()}
    mine = after.setdefault(profile, {'runners': {}})
    for r, c in new_caps.items():
        mine['runners'][r] = {'hard': c['hard'], 'closed': False}
    by = {name: exposure(doc) for name, doc in sorted(after.items())}
    outside = round(sum(float(v) for v in (budget.get('outside_usd') or {}).values()), 2)
    total = round(sum(by.values()) + outside, 2)
    return {'ok': total <= float(budget['total_usd']) + 1e-9, 'budget_usd': float(budget['total_usd']), 'exposure_usd': by,
            'outside_usd': outside, 'total_usd': total, 'headroom_usd': round(float(budget['total_usd']) - total, 2)}


def commit_caps(committed: dict[str, Any], caps: dict[str, dict[str, float]], passes: list[str], at: str) -> dict[str, Any]:
    doc = {'schema': COMMITTED_SCHEMA, 'runners': {r: dict(c) for r, c in (committed.get('runners') or {}).items()}}
    for r, c in caps.items():
        doc['runners'][r] = {'soft': c['soft'], 'hard': c['hard'], 'passes': list(passes), 'at': at, 'closed': False}
    return doc


def close_caps(committed: dict[str, Any], settled: dict[str, float], at: str) -> dict[str, Any]:
    doc = {'schema': COMMITTED_SCHEMA, 'runners': {r: dict(c) for r, c in (committed.get('runners') or {}).items()}}
    for r, v in settled.items():
        doc['runners'].setdefault(r, {'hard': 0.0})
        doc['runners'][r].update({'closed': True, 'settled_usd': round(float(v), 4), 'closed_at': at})
    return doc


def project_cc(plan: dict[str, Any], detail: dict[str, Any], merged: pathlib.Path, *, concurrency: int, reserve: float,
               caps_for: list[str] | None = None, min_n: int = MIN_N, borrow: dict[str, dict[str, Any]] | None = None,
               report_passes: list[str] | None = None, plan_sha256: str | None = None,
               role_table: dict[str, Any] | None = None, tier_model: dict[str, str] | None = None,
               prior_m: float = 1.0, prior_tau: float = 1.0, inflight: dict[str, Any] | None = None) -> dict[str, Any]:
    """The `fleet.py --agent claude-code project` document for one benchmark (outcome-blind). `inflight`: the caps'
    in-flight allowance (inflight_allowance; fleet prices it from the Region's catalog)."""
    att, finals, dropped = load_merged(merged)
    rat = ratios(plan, detail, att, finals, min_n, borrow, prior_m, prior_tau)
    proj = projection(plan, detail, att, finals, dropped, rat, concurrency, void_usd=void_spend(merged))
    out = {'benchmark': plan['dataset']['name'], 'plan_sha256': plan_sha256, 'ratios': rat, 'projection': proj, 'dropped_tasks': sorted(dropped),
           'report': report(plan, att, report_passes),
           'preconditions': precondition_checks(plan, att, read_jsonl(merged / 'calls.jsonl'), role_table, tier_model, report_passes),
           'pilot_passes_measured': sorted({r.get('pass') for r in att if r.get('pass')})}
    if caps_for:
        out['caps'] = {'passes': caps_for, 'runners': suggest_caps(proj, caps_for, reserve, inflight=float((inflight or {}).get('usd') or 0.0)),
                       'inflight': inflight}
    return out
