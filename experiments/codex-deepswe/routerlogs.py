"""Router CloudWatch log parser and the join to runs (design §5 step 7; review A2, A3).

Input: what the parent fetched from the router log group, in any of these shapes (one per line or one JSON
document): raw RequestLog JSON lines, `filter_log_events` events (`{"message": "<json>", ...}`), or a JSON object
with an `events` list. EMF documents (`_aws`) and unparsable lines are skipped.

Join key. Every run sends `x-router-session: <run-id>` (the proxy enforces it; run ids are random uuid4s). The router
logs `session = sha256(<x-router-session>)[:16]` on every request line, so a run's records are the ones whose
`session` equals label(run_id). Fallback, for robustness only (e.g. logs from before that field existed): core's
lineage for this header is `<run-id>/t:<family>` and the router logs `lineage = sha256(lineage)[:16]`; the 12-hex
template family appears in decision reasons as `family=<hex>`, so the label is recomputed from each family seen.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import Any

_FAMILY = re.compile(r'family=([0-9a-f]{12})\b')


def label(text: str) -> str:
    """The router's lineageLabel: sha256 hex, first 16 characters."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def parse(text: str) -> list[dict[str, Any]]:
    """RequestLog records from a CloudWatch export (see module docstring)."""
    text = text.strip()
    docs: list[Any] = []
    # One JSON document of any shape first (e.g. pretty-printed `aws logs filter-log-events --output json`), JSON
    # lines only if the whole text is not one document.
    try:
        docs = [json.loads(text)]
    except ValueError:
        docs = []
    if not docs:
        for line in text.splitlines():
            line = line.strip().rstrip(',')
            if not line:
                continue
            try:
                docs.append(json.loads(line))
            except ValueError:
                continue
    out: list[dict[str, Any]] = []

    def take(d: Any) -> None:
        if isinstance(d, list):
            for x in d:
                take(x)
        elif isinstance(d, dict):
            if isinstance(d.get('events'), list):
                take(d['events'])
            elif isinstance(d.get('message'), str):
                try:
                    take(json.loads(d['message']))
                except ValueError:
                    pass
            elif '_aws' not in d and 'reqId' in d and 'kind' in d:
                out.append(d)

    take(docs)
    return out


def families(records: Iterable[dict[str, Any]]) -> set[str]:
    fams: set[str] = set()
    for r in records:
        reason = ((r.get('decision') or {}).get('reason')) or ''
        fams.update(_FAMILY.findall(reason))
    return fams


def labels_for(run_id: str, fams: Iterable[str]) -> dict[str, str]:
    """label → how it was derived ('session' or 'lineage:<family>')."""
    out = {label(run_id): 'session'}
    for f in fams:
        out[label(f'{run_id}/t:{f}')] = f'lineage:{f}'
    return out


def join(records: list[dict[str, Any]], run_ids: Iterable[str], proxy_gateway_calls: dict[str, int] | None = None) -> dict[str, dict[str, Any]]:
    """Per-run aggregates of the router's records. `complete` = the router saw as many model requests as the proxy
    forwarded on the gateway path (otherwise some calls were served by the gateway's fallback, or logs are missing)."""
    fams = families(records)
    index: dict[str, str] = {}
    for rid in run_ids:
        for lab in labels_for(rid, fams):
            index[lab] = rid
    by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    lineages: dict[str, set[str]] = defaultdict(set)
    for r in records:
        keys = [r.get('session'), r.get('sessionLabel'), r.get('lineage')]
        rid = next((index[k] for k in keys if isinstance(k, str) and k in index), None)
        if rid:
            by_run[rid].append(r)
            if r.get('lineage'):
                lineages[rid].add(r['lineage'])
    out: dict[str, dict[str, Any]] = {}
    for rid, rs in by_run.items():
        rs.sort(key=lambda x: x.get('ts') or '')
        model = [x for x in rs if x.get('kind') == 'model']
        cost = sum(float(((x.get('costUsd') or {}).get('total')) or 0.0) for x in model)
        assessor = [x['assessor'] for x in rs if isinstance(x.get('assessor'), dict)]
        a_cost = sum(float(a.get('costUsd') or 0.0) for a in assessor)   # A3: not in costUsd.total
        first_a = next((a for a in assessor if not a.get('cached')), assessor[0] if assessor else None)
        u = Counter()
        for x in model:
            us = x.get('usage') or {}
            u['uncached'] += int(us.get('uncachedInputTokens') or 0)
            u['read'] += int(us.get('cacheReadTokens') or 0)
            u['write'] += sum(int(v or 0) for v in (us.get('cacheWriteTokens') or {}).values())
            u['output'] += int(us.get('outputTokens') or 0)
            u['prompt'] += int(us.get('promptTokens') or 0)
        overhead = sorted(float(x['overheadMs']) for x in model if isinstance(x.get('overheadMs'), (int, float)))
        # The request that waited for an assessor consultation carries its latency in overheadMs; the rest is the router's own.
        plain = sorted(float(x['overheadMs']) for x in model if isinstance(x.get('overheadMs'), (int, float))
                       and not (isinstance(x.get('assessor'), dict) and not x['assessor'].get('cached')))
        n_model = len(model)
        expected = (proxy_gateway_calls or {}).get(rid)
        out[rid] = {
            'requests': len(rs), 'model_requests': n_model,
            'statuses': dict(Counter(str(x.get('status')) for x in rs)),
            'decisions': dict(Counter(f"{(x.get('decision') or {}).get('action')};{(x.get('decision') or {}).get('point')}" for x in model)),
            'served_models': dict(Counter(str(x.get('servedModel')) for x in model)),
            'failovers': [x['failover'] for x in rs if x.get('failover')],
            'lineages': len(lineages[rid]),
            'router_cost_usd': round(cost, 6), 'assessor_cost_usd': round(a_cost, 6), 'cost_usd': round(cost + a_cost, 6),
            'prompt_tokens': u['prompt'], 'cache_read_tokens': u['read'], 'cache_write_tokens': u['write'],
            'output_tokens': u['output'],
            'assessor_tier': (first_a or {}).get('tier'), 'assessor_proposed': (first_a or {}).get('proposedTier'),
            'assessor_outcome': (first_a or {}).get('outcome'), 'assessor_status': (first_a or {}).get('status'),
            'assessor_applied': (first_a or {}).get('applied'), 'assessor_consults': sum(1 for a in assessor if not a.get('cached')),
            'assessor_latency_ms': (first_a or {}).get('latencyMs'), 'assessor_confidence': (first_a or {}).get('confidence'),
            'assessor_basis': (first_a or {}).get('basis'),
            'overhead_ms_p50': overhead[len(overhead) // 2] if overhead else None,
            'overhead_ms_p99': overhead[min(len(overhead) - 1, int(0.99 * (len(overhead) - 1) + 0.5))] if overhead else None,
            'overhead_ms_max_excl_assessor': plain[-1] if plain else None,
            'misses': dict(Counter(str((x.get('miss') or {}).get('reason')) for x in model if x.get('miss'))),
            'complete': expected is not None and n_model >= expected,
            'expected_model_requests': expected,
        }
    return out


def unique_lineages(joined: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Pilot check (A2): every run maps to exactly one lineage, and no lineage is shared between runs."""
    multi = sorted(r for r, j in joined.items() if j['lineages'] != 1)
    return {'runs': len(joined), 'runs_not_one_lineage': multi, 'ok': not multi}
