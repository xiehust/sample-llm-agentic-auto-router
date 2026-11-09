"""USD for one Anthropic Messages call (Claude Code routes in hproxy; design-harness §2.5–2.6). Harbor-free.

Mirrors @auto-router/pricing `fromAnthropic` + `costOf`: uncached = input_tokens; reads = cache_read_input_tokens;
writes split by cache_creation.ephemeral_{5m,1h}_input_tokens (an unsplit remainder counts as 5m); prompt = the sum;
the long-context price applies to the whole call when prompt > longContext.aboveTokens (Haiku 5.5: 100k). An unknown
model is priced as Opus 5.5, so the ledger stays an upper bound. The catalog is codex-deepswe/pricing's (the
experiment Region's bundled catalog).
"""
from __future__ import annotations

import json
from typing import Any

import hcommon  # isort: skip  (puts codex-deepswe on sys.path, so it must come first)
import pricing  # isort: skip

UNKNOWN_AS = hcommon.CC_MODELS['opus']


def _n(v: Any) -> int:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else 0


def normalize(usage: dict[str, Any] | None) -> dict[str, int]:
    u = usage or {}
    uncached, read, total_w = _n(u.get('input_tokens')), _n(u.get('cache_read_input_tokens')), _n(u.get('cache_creation_input_tokens'))
    split = u.get('cache_creation') if isinstance(u.get('cache_creation'), dict) else None
    if split is not None:
        w5, w1 = _n(split.get('ephemeral_5m_input_tokens')), _n(split.get('ephemeral_1h_input_tokens'))
        w5 += max(0, total_w - w5 - w1)
    else:
        w5, w1 = total_w, 0
    det = u.get('output_tokens_details') if isinstance(u.get('output_tokens_details'), dict) else {}
    return {'prompt': uncached + read + w5 + w1, 'uncached': uncached, 'read': read, 'write': w5 + w1, 'write_5m': w5, 'write_1h': w1,
            'output': _n(u.get('output_tokens')), 'reasoning': _n(det.get('thinking_tokens'))}


def _prices(model: str | None, prompt: int, cat: dict[str, dict[str, Any]] | None = None) -> tuple[dict[str, Any], dict[str, Any], bool]:
    cat = cat or pricing.catalog()
    mid = pricing.resolve(model, cat)
    m = cat[mid] if mid else cat[UNKNOWN_AS]
    lc = m.get('longContext')
    long = bool(lc) and prompt > lc['aboveTokens']
    return m, (lc['price'] if long else m['price']), long


def cost(model: str | None, usage: dict[str, Any] | None, cat: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    n = normalize(usage)
    m, p, long = _prices(model, n['prompt'], cat)
    w = p.get('cacheWrite') or {}
    default = w.get(m['cache']['defaultTtl'], p['input'])
    usd = (n['uncached'] * p['input'] + n['read'] * p['cacheRead'] + n['write_5m'] * w.get('5m', default)
           + n['write_1h'] * w.get('1h', default) + n['output'] * p['output']) / 1e6
    return {'usd': usd, 'model': pricing.resolve(model, cat or pricing.catalog()), 'priced_as': m['modelId'], 'long': long}


def worst(model: str | None, prompt_tokens: int, output_tokens: int, cat: dict[str, dict[str, Any]] | None = None) -> float:
    """Upper bound for one call: every prompt token at max(input, any cache-write rate) of the price for its size, plus
    the output (17 §3: Claude Code writes the cache on most calls, and the 1h write is 2× input)."""
    _, p, _ = _prices(model, prompt_tokens, cat)
    per_prompt = max([p['input'], *((p.get('cacheWrite') or {}).values())])
    return (prompt_tokens * per_prompt + output_tokens * p['output']) / 1e6


MAX_OUTPUT_TOKENS = 128_000            # body_max_tokens' cap: the most output hproxy reserves for one call
DEFAULT_CONTEXT_TOKENS = 1_000_000     # a catalog entry without contextWindow


def call_ceiling(model: str | None, cat: dict[str, dict[str, Any]] | None = None) -> float:
    """The most hproxy reserves for one call of `model` while the client stays inside the model's context window:
    worst() at the catalog's contextWindow and the MAX_OUTPUT_TOKENS output cap (17: the caps' in-flight allowance)."""
    cat = cat or pricing.catalog()
    mid = pricing.resolve(model, cat)
    ctx = int((cat[mid] if mid else cat[UNKNOWN_AS]).get('contextWindow') or DEFAULT_CONTEXT_TOKENS)
    return worst(model, ctx, MAX_OUTPUT_TOKENS, cat)


def body_max_tokens(body: dict[str, Any], floor: int = 16_000, cap: int = MAX_OUTPUT_TOKENS) -> int:
    v = body.get('max_tokens')
    return max(floor, min(cap, int(v))) if isinstance(v, int) and not isinstance(v, bool) and v > 0 else floor


def dumps(x: Any) -> str:
    return json.dumps(x, separators=(',', ':'))
