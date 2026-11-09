"""Codex CLI pin, run-local config.toml, prompt and command line (design §5 step 3–5, D5, D6).

Config keys are checked against the pinned version's `codex exec --help` and its config schema
(codex-rs/core/config.schema.json, codex-rs/model-provider-info/src/lib.rs at the release tag). `--strict-config`
makes Codex refuse any key it does not know, so a drift fails the first run instead of being ignored.
"""
from __future__ import annotations

import json
import re
import shlex
from typing import Any

# Pinned upstream release: static musl builds from github.com/openai/codex releases (Apache-2.0).
CODEX = {
    'version': '0.166.0',
    'tag': 'rust-v0.166.0',
    'assets': {
        'x86_64': {'name': 'codex-x86_64-unknown-linux-musl.tar.gz',
                   'sha256': 'a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978',
                   'member': 'codex-x86_64-unknown-linux-musl'},
        'aarch64': {'name': 'codex-aarch64-unknown-linux-musl.tar.gz',
                    'sha256': '94eb707605ec2646b2e05b7edf7c4e7b3ccf02b16237c34ae9beb8cfb7f810a9',
                    'member': 'codex-aarch64-unknown-linux-musl'},
    },
}

# In-container layout. CODEX_HOME is not under /tmp (Codex refuses to create its helper links there).
CTR_CODEX = '/opt/llmar-codex/bin/codex'
CTR_CODEX_HOME = '/opt/llmar-codex/home'
DUMMY_KEY_ENV = 'LLMAR_DUMMY_KEY'
DUMMY_KEY = 'not-a-credential'   # the proxy drops it; the real token never enters a container (D5)
PROVIDER_ID = 'llmar'

# D6: settings pinned for every arm, recorded in every result row.
CODEX_SETTINGS: dict[str, Any] = {
    'model_reasoning_effort': 'medium',
    'model_reasoning_summary': 'none',
    'model_context_window': 272_000,           # the long-context price step of Sol / Astra / Luna
    'model_auto_compact_token_limit': 200_000,  # ≤ 200k (D6)
    'approval_policy': 'never',
    'sandbox_mode': 'danger-full-access',      # the container is the sandbox
    'web_search': 'disabled',
    'check_for_update_on_startup': False,
    'hide_agent_reasoning': False,
    'show_raw_agent_reasoning': False,
    'project_doc_max_bytes': 0,                # ignore any AGENTS.md in the task repo
    'include_environment_context_time': False,  # same environment text for every run (cross-run cache, D10)
    'history': {'persistence': 'none'},
    'analytics': {'enabled': False},
    'feedback': {'enabled': False},
    'otel': {'exporter': 'none', 'metrics_exporter': 'none', 'trace_exporter': 'none'},
    'features': {
        'multi_agent': False,                  # one lineage per run; no sub-agents
        'memories': False,
        'apps': False,
        'remote_plugin': False,
        'enable_request_compression': False,   # the gateway/router path takes identity-encoded JSON
        'goals': False,
    },
}
PROVIDER_SETTINGS = {'request_max_retries': 4, 'stream_max_retries': 5, 'stream_idle_timeout_ms': 300_000,
                     'supports_websockets': False, 'requires_openai_auth': False}

PROMPT_TEMPLATE = """<issue>
{issue}
</issue>

The repository for this issue is checked out at /testbed. Fix the issue with a minimal change to the non-test source files.
- Do not add, change or delete any test files.
- You may run the existing tests and throwaway scripts; delete any scratch files you create before you finish.
- There is no network access, so do not try to install packages.
When you are done, reply with a short summary of the change."""


def prompt(issue_text: str) -> str:
    return PROMPT_TEMPLATE.format(issue=issue_text.strip())


def arm_headers(arm: str, run_id: str, pin: str | None) -> dict[str, str]:
    """Headers the provider adds to every request. A: pin Sol, C: pin Astra, B: none; D goes direct (no router)."""
    if arm == 'D':
        return {}
    h = {'x-router-session': run_id}
    if pin:
        h['x-router-hint'] = f'pin={pin}'
    return h


def model_for(arm: str, direct_model: str) -> str:
    """Every routed arm sends `model: "auto"` (same gateway → router path); D sends the Bedrock id directly."""
    return direct_model if arm == 'D' else 'auto'


# ---------------------------------------------------------------- TOML (the subset we emit)

_BARE = re.compile(r'^[A-Za-z0-9_-]+$')


def _key(k: str) -> str:
    return k if _BARE.match(k) else json.dumps(k)


def _val(v: Any) -> str:
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return json.dumps(v)   # a JSON string is a valid TOML basic string for the characters we emit
    if isinstance(v, dict):
        return '{ ' + ', '.join(f'{_key(k)} = {_val(x)}' for k, x in v.items()) + ' }'
    raise TypeError(f'unsupported TOML value {v!r}')


def to_toml(cfg: dict[str, Any]) -> str:
    lines: list[str] = []
    tables: list[tuple[str, dict[str, Any]]] = []
    for k, v in cfg.items():
        if isinstance(v, dict) and k != 'http_headers':
            tables.append((k, v))
        else:
            lines.append(f'{_key(k)} = {_val(v)}')

    def emit(prefix: str, t: dict[str, Any]) -> None:
        sub = [(k, v) for k, v in t.items() if isinstance(v, dict) and k not in ('http_headers',)]
        lines.append('')
        lines.append(f'[{prefix}]')
        for k, v in t.items():
            if not (isinstance(v, dict) and k != 'http_headers'):
                lines.append(f'{_key(k)} = {_val(v)}')
        for k, v in sub:
            emit(f'{prefix}.{_key(k)}', v)

    for k, v in tables:
        emit(_key(k), v)
    return '\n'.join(lines).lstrip('\n') + '\n'


def config(base_url: str, arm: str, run_id: str, pin: str | None, direct_model: str) -> dict[str, Any]:
    cfg: dict[str, Any] = {'model': model_for(arm, direct_model), 'model_provider': PROVIDER_ID}
    cfg.update({k: v for k, v in CODEX_SETTINGS.items() if not isinstance(v, dict)})
    cfg.update({k: v for k, v in CODEX_SETTINGS.items() if isinstance(v, dict)})
    provider: dict[str, Any] = {'name': 'llmar experiment proxy', 'base_url': base_url, 'env_key': DUMMY_KEY_ENV,
                                'wire_api': 'responses', **PROVIDER_SETTINGS}
    headers = arm_headers(arm, run_id, pin)
    if headers:
        provider['http_headers'] = headers
    cfg['model_providers'] = {PROVIDER_ID: provider}
    return cfg


def config_toml(base_url: str, arm: str, run_id: str, pin: str | None, direct_model: str) -> str:
    return '# Generated per run by experiments/codex-deepswe (codex_setup.py). Do not edit.\n' + to_toml(
        config(base_url, arm, run_id, pin, direct_model))


def exec_argv(prompt_text: str, timeout_s: int, grace_s: int = 60) -> list[str]:
    """`timeout -s INT -k <grace> <timeout> codex exec --json …` (design §5 step 5): SIGINT first so Codex can
    end the turn and flush, SIGKILL after the grace period."""
    return ['timeout', '-s', 'INT', '-k', str(grace_s), str(timeout_s), CTR_CODEX, 'exec', '--json', '--strict-config',
            '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-C', '/testbed', prompt_text]


def exec_env(path: str) -> dict[str, str]:
    return {'CODEX_HOME': CTR_CODEX_HOME, DUMMY_KEY_ENV: DUMMY_KEY, 'PATH': path, 'HOME': '/root', 'SHELL': '/bin/bash',
            'TERM': 'dumb', 'NO_COLOR': '1'}


def describe(argv: list[str]) -> str:
    """The command line for logs, with the prompt replaced by its length."""
    return shlex.join(argv[:-1] + [f'<prompt {len(argv[-1])} chars>'])
