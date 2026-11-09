"""USD for one Responses call from its usage, priced with the experiment Region's bundled catalog.

Mirrors @auto-router/pricing (normalizeUsage for openai-responses + costOf): input_tokens includes cached reads
and cache writes; reads are `input_tokens_details.cached_tokens`, writes `input_tokens_details.cache_write_tokens`
(default TTL 30m); the long-context price applies when the prompt is above the model's `aboveTokens`.
"""
from __future__ import annotations

import functools
import pathlib
from typing import Any

from common import catalog_path, read_json


@functools.lru_cache(maxsize=4)
def _load(path: pathlib.Path) -> dict[str, dict[str, Any]]:
    c = read_json(path)
    return {m['modelId']: m for m in c['models']}


def catalog(path: pathlib.Path | None = None) -> dict[str, dict[str, Any]]:
    """The bundled catalog of the experiment Region (common.set_region), or an explicit file."""
    return _load(path or catalog_path())


def resolve(model: str | None, cat: dict[str, dict[str, Any]] | None = None) -> str | None:
    """Catalog id for a served model name: exact, else the catalog id ending with `.<name>` (Bedrock may return
    bare names such as `gpt-6.1-sol`)."""
    cat = cat or catalog()
    if not model:
        return None
    if model in cat:
        return model
    return next((k for k in cat if k.endswith('.' + model)), None)


def _n(v: Any) -> int:
    return int(v) if isinstance(v, (int, float)) and v > 0 else 0


def normalize(usage: dict[str, Any] | None) -> dict[str, int]:
    u = usage or {}
    det = u.get('input_tokens_details') or {}
    prompt = _n(u.get('input_tokens'))
    read = _n(det.get('cached_tokens'))
    write = _n(det.get('cache_write_tokens'))
    return {'prompt': prompt, 'uncached': max(0, prompt - read - write), 'read': read, 'write': write,
            'output': _n(u.get('output_tokens')), 'reasoning': _n((u.get('output_tokens_details') or {}).get('reasoning_tokens'))}


def cost(model: str | None, usage: dict[str, Any] | None, cat: dict[str, dict[str, Any]] | None = None,
         unknown_as: str = 'global.openai.gpt-6-astra') -> dict[str, Any]:
    """{'usd', 'model', 'priced_as', 'long'}; an unknown model is priced as `unknown_as` (the most expensive pool
    model), so the ledger stays an upper bound."""
    cat = cat or catalog()
    mid = resolve(model, cat)
    m = cat[mid] if mid else cat[unknown_as]
    n = normalize(usage)
    lc = m.get('longContext')
    long = bool(lc) and n['prompt'] > lc['aboveTokens']
    p = lc['price'] if long else m['price']
    wrate = p['cacheWrite'].get(m['cache']['defaultTtl']) if p['cacheWrite'] else p['input']
    usd = (n['uncached'] * p['input'] + n['read'] * p['cacheRead'] + n['write'] * (wrate or p['input']) + n['output'] * p['output']) / 1e6
    return {'usd': usd, 'model': mid, 'priced_as': m['modelId'], 'long': long}


def worst_call_usd(model: str, prompt_tokens: int, output_tokens: int, cat: dict[str, dict[str, Any]] | None = None) -> float:
    """Upper bound for one call: the whole prompt uncached at the price that applies to its size, plus the output."""
    return cost(model, {'input_tokens': prompt_tokens, 'output_tokens': output_tokens}, cat)['usd']
