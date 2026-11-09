"""Claude Code agent settings for every arm (design-harness §1.3–1.5). Harbor-free: the driver venv imports it.

The container sees one arm-dependent value, the client's main-loop model (hcommon.CC_CLIENT_MODEL: A and B Sonnet,
C Opus, F Haiku). Everything else is identical across arms. Helper models are Claude Code's own choices: every
native alias maps to its 5.5 Bedrock id (Fable to its own id, which is not in the pool, so a Fable call is refused
loudly by the proxy), and CLAUDE_CODE_SUBAGENT_MODEL is never set.

Any change here changes Claude Code's requests: re-run the capture (capture.py) and send it to 73 before the pilot.
"""
from __future__ import annotations

import hcommon
from hcommon import CC_CLIENT_MODEL, CC_MODELS, DUMMY_KEY

VERSION = hcommon.CLAUDE_CODE['version']
EFFORT = 'high'
BASE_URL_ENV = 'LLMAR_CC_BASE_URL'      # the trial's proxy route, handed to cc_agent through the agent config env
DISALLOWED_TOOLS = ('WebSearch', 'WebFetch')   # both benchmarks (Codex had web search disabled on TB too)

# Non-essential traffic off (a3). The first switch covers the other four; they are set too, belt and braces. Not set:
# DISABLE_NON_ESSENTIAL_MODEL_CALLS (background model calls are Claude Code defaults the user kept).
TRAFFIC_OFF = {'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
               'DISABLE_AUTOUPDATER': '1', 'DISABLE_BUG_COMMAND': '1'}
ALIASES = {'ANTHROPIC_DEFAULT_OPUS_MODEL': CC_MODELS['opus'], 'ANTHROPIC_DEFAULT_SONNET_MODEL': CC_MODELS['sonnet'],
           'ANTHROPIC_DEFAULT_HAIKU_MODEL': CC_MODELS['haiku'], 'ANTHROPIC_SMALL_FAST_MODEL': CC_MODELS['haiku'],
           'ANTHROPIC_DEFAULT_FABLE_MODEL': CC_MODELS['fable']}
# Host variables that must never reach the harbor process (and so the agent): credentials, provider selectors and
# proxies Claude Code honours (a3: HTTP(S)_PROXY would send its traffic elsewhere than ANTHROPIC_BASE_URL).
SCRUB_ENV = ('CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_FORCE_OAUTH',
             'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'AWS_BEARER_TOKEN_BEDROCK')
SCRUB_PROXY = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')


def agent_env(base_url: str) -> dict[str, str]:
    """The env of the agent's `claude` exec, complete (cc_agent replaces Harbor's provider resolution with it)."""
    if not base_url.startswith('http://') or '/r/' not in base_url:
        raise ValueError('base_url must be the trial proxy route (http://<proxy>/r/<trial-id>)')
    url = base_url.rstrip('/')
    url = url.removesuffix('/v1')      # the proxy hands out …/r/<id>/v1; Claude Code appends /v1/messages
    return {'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_API_KEY': DUMMY_KEY, 'ANTHROPIC_AUTH_TOKEN': '',
            **ALIASES, **TRAFFIC_OFF}


def scrub(base: dict[str, str]) -> dict[str, str]:
    """`base` without the Claude Code credentials, provider selectors and proxy variables (any case)."""
    drop = set(SCRUB_ENV)
    return {k: v for k, v in base.items() if k not in drop and k.upper() not in SCRUB_PROXY}


def client_model(arm: str) -> str:
    try:
        return CC_CLIENT_MODEL[arm]
    except KeyError:
        raise ValueError(f'unknown arm {arm!r}') from None
