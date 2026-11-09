"""Per-call request facts for Claude Code routes in hproxy (design-harness §2.3, §2.7; 0d design-stats §11–13).
Harbor-free and text-free: every output is a code, a count or a hash prefix.

- call_type ∈ {main, task, plan, explore, compaction, background, unknown}: the request's structure, matched against
  the frozen signatures in experiments/claude-code-harbor/native-roles.json (sha256 recorded by 0d in §13):
  x-claude-code-agent-id present or not, sha256[:12] of the first 60 characters of the last system block, tools
  present, and Claude Code's own summarization marker in the last user message.
- call_role_struct ∈ {main, main_subagent, helper} or None, from call_type (main, compaction → main; task, plan,
  explore → main_subagent; background → helper; unknown → None).
- call_role, from the requested model against the client's main model M: M → main (no agent header) or
  main_subagent (agent header); Haiku while M is not Haiku → helper; anything else → None. In F (M is Haiku) the
  model cannot separate roles, so call_role = call_role_struct (0d Amendment 3).
- lineage: 'subagent' with the agent header, else 'root'.
- sanitized: what the router's Bedrock compatibility will change ('user_id', 'beta:<name>'), mirrored from
  packages/router/src/bedrock-compat.ts (a test checks the constants against that file).
- B's rewrite: the top-level "model" member is replaced byte-exactly (every other byte unchanged).
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
from typing import Any

import hcommon

NATIVE_ROLES = hcommon.HERE.parent / 'claude-code-harbor' / 'native-roles.json'
AGENT_HEADER = 'x-claude-code-agent-id'
BEDROCK_BETA_STRIP = ('advanced-tool-use-2025-11-20',)
USER_ID_SAFE = re.compile(r'^[A-Za-z0-9_-]{1,256}$')
POOL = (hcommon.CC_MODELS['opus'], hcommon.CC_MODELS['sonnet'], hcommon.CC_MODELS['haiku'])
ROLES = ('main', 'main_subagent', 'helper')
# call_role / call_role_struct of an auxiliary non-model call: a count_tokens call meeting 0d's Amendment 7
# predicate (hproxy.count_tokens_aux). Anything else keeps null roles and fails the §4.2 gate.
NON_MODEL = 'non_model'
STRUCT_ROLE = {'main': 'main', 'compaction': 'main', 'task': 'main_subagent', 'plan': 'main_subagent',
               'explore': 'main_subagent', 'background': 'helper'}


def _sig(text: str) -> str:
    return hashlib.sha256(text.strip()[:60].encode('utf-8')).hexdigest()[:12]


def load_classifier(path: pathlib.Path = NATIVE_ROLES) -> dict[str, Any]:
    return json.loads(path.read_text(encoding='utf-8'))['classifier']


def system_sig(body: dict[str, Any]) -> str | None:
    s = body.get('system')
    if isinstance(s, str):
        return _sig(s)
    if isinstance(s, list) and s and isinstance(s[-1], dict) and isinstance(s[-1].get('text'), str):
        return _sig(s[-1]['text'])
    return None


def tools_sig(body: dict[str, Any]) -> str | None:
    t = body.get('tools')
    if not isinstance(t, list) or not t:
        return None
    names = sorted(str(x.get('name')) for x in t if isinstance(x, dict))
    return hashlib.sha256(json.dumps(names).encode()).hexdigest()[:12]


def _last_user_text(body: dict[str, Any]) -> str:
    msgs = body.get('messages')
    if not isinstance(msgs, list) or not msgs or not isinstance(msgs[-1], dict) or msgs[-1].get('role') != 'user':
        return ''
    c = msgs[-1].get('content')
    if isinstance(c, str):
        return c
    return '\n'.join(str(x.get('text') or '') for x in c if isinstance(x, dict) and x.get('type') == 'text') if isinstance(c, list) else ''


def call_type(headers: dict[str, str], body: dict[str, Any], clf: dict[str, Any]) -> str:
    agent = bool(headers.get(AGENT_HEADER))
    sig = system_sig(body)
    if not agent and not body.get('tools'):
        return 'background'
    if not agent and sig == clf['main']['system_sig']:
        return 'compaction' if clf['compaction']['marker'] in _last_user_text(body) else 'main'
    if agent:
        for kind in ('task', 'plan', 'explore'):
            if sig == clf[kind]['system_sig']:
                return kind
    return 'unknown'


def roles(headers: dict[str, str], body: dict[str, Any], client_model: str, clf: dict[str, Any]) -> dict[str, Any]:
    ct = call_type(headers, body, clf)
    struct = STRUCT_ROLE.get(ct)
    agent = bool(headers.get(AGENT_HEADER))
    req = body.get('model') if isinstance(body.get('model'), str) else None
    haiku = hcommon.CC_MODELS['haiku']
    if client_model == haiku:
        role = struct
    elif req == client_model:
        role = 'main_subagent' if agent else 'main'
    elif req == haiku:
        role = 'helper'
    else:
        role = None
    return {'call_type': ct, 'call_role': role, 'call_role_struct': struct, 'lineage': 'subagent' if agent else 'root',
            'system_sig': system_sig(body), 'tools_sig': tools_sig(body), 'n_tools': len(body.get('tools') or []) if isinstance(body.get('tools'), list) else 0}


def sanitized(headers: dict[str, str], body: dict[str, Any]) -> list[str]:
    out: list[str] = []
    m = body.get('metadata')
    if isinstance(m, dict) and isinstance(m.get('user_id'), str) and not USER_ID_SAFE.match(m['user_id']):
        out.append('user_id')
    betas = [b.strip() for b in (headers.get('anthropic-beta') or '').split(',')]
    out += [f'beta:{b}' for b in betas if b in BEDROCK_BETA_STRIP]
    return out


# ---------------------------------------------------------------- byte-exact top-level member edit (body.ts port)

_WS = b' \t\n\r'


def _skip_ws(b: bytes, i: int) -> int:
    while i < len(b) and b[i] in _WS:
        i += 1
    return i


def _skip_string(b: bytes, i: int) -> int:
    i += 1
    while i < len(b):
        c = b[i]
        if c == 0x5c:
            i += 2
            continue
        if c == 0x22:
            return i + 1
        i += 1
    raise ValueError('unterminated string')


def _skip_value(b: bytes, i: int) -> int:
    c = b[i]
    if c == 0x22:
        return _skip_string(b, i)
    if c in (0x7b, 0x5b):
        depth = 0
        while i < len(b):
            x = b[i]
            if x == 0x22:
                i = _skip_string(b, i)
                continue
            if x in (0x7b, 0x5b):
                depth += 1
            elif x in (0x7d, 0x5d):
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        raise ValueError('unterminated container')
    j = i
    while j < len(b) and b[j] not in _WS and b[j] not in (0x2c, 0x7d):
        j += 1
    if j == i:
        raise ValueError('value expected')
    return j


def splice_top_level(b: bytes, key: str, json_value: str) -> bytes:
    """Replaces the value of the (only) top-level `key`; every other byte unchanged. ValueError if absent or duplicated."""
    i = _skip_ws(b, 0)
    if i >= len(b) or b[i] != 0x7b:
        raise ValueError('top-level object expected')
    i = _skip_ws(b, i + 1)
    spans = []
    while i < len(b) and b[i] != 0x7d:
        if b[i] != 0x22:
            raise ValueError('member name expected')
        ke = _skip_string(b, i)
        name = json.loads(b[i:ke].decode('utf-8'))
        i = _skip_ws(b, ke)
        if b[i] != 0x3a:
            raise ValueError('colon expected')
        vs = _skip_ws(b, i + 1)
        ve = _skip_value(b, vs)
        if name == key:
            spans.append((vs, ve))
        i = _skip_ws(b, ve)
        if i < len(b) and b[i] == 0x2c:
            i = _skip_ws(b, i + 1)
    if len(spans) != 1:
        raise ValueError(f'{len(spans)} top-level "{key}" members')
    vs, ve = spans[0]
    return b[:vs] + json_value.encode('utf-8') + b[ve:]
