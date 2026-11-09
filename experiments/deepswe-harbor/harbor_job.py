"""Harbor job config for one trial attempt (design §4.5; the interface with 17's driver).

The driver runs `HARBOR_TELEMETRY=0 harbor run --config <job.json>` once per (task, arm, rep, attempt), with
n_concurrent_trials=1 and retry.max_retries=0, and owns block order, arm order, concurrency, the soft cap and the
§7.4 rerun rule. This module owns everything about the agent:
- Harbor's built-in `codex` agent (no subclass), Codex 0.166.0, effort high, `--model auto` (skip_model_parsing);
- the native config.toml (codex_config.config) with the trial's proxy route as provider base_url and a dummy key;
- the pinned Codex binary bind-mounted read-only at /usr/local/bin/codex: Harbor 0.25.0's install() returns early
  when `codex --version` matches the requested version, so nothing is fetched inside the container;
- the agent-phase allowlist = the proxy's IP literal only (an explicit list replaces Harbor's automatic
  inference-host addition);
- the task's own timeouts, CPU, memory and storage (never overridden; 0d finding 1).
The arm is not visible in the container: the proxy route registered for trial_id carries the router hint.

Public-network tasks (Terminal-Bench 2.1: `allow_internet = true`, no agent-phase override; TB design §4.2) differ in
two agent settings only: web search is disabled explicitly (`disable_web_search`; Harbor auto-disables it only under
a restricted policy, which is how DeepSWE ran), and there is no `extra_allowed_hosts` (Harbor ignores it for a public
policy). llmar_env puts such environments on the runner's online network. DeepSWE's job config is unchanged.
"""
from __future__ import annotations

import pathlib
import tomllib
import urllib.parse
from typing import Any

import codex_config
import hcommon
from hcommon import ARMS, DUMMY_KEY, DUMMY_KEY_ENV

CODEX_BIN = hcommon.codex_bin('x86_64')
ENV_IMPORT_PATH = 'llmar_env:LlmarDockerEnvironment'   # real no-network for all-denied environments (llmar_env.py)
# Host variables Harbor's codex agent would use instead of the dummy key or forward into the container (review 18 F6),
# plus anything AWS: the harbor process needs no credentials (the token lives in the driver's proxy).
SCRUB_ENV = ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_AUTH_JSON_PATH', 'CODEX_FORCE_AUTH_JSON', 'CODEX_HOME')
SCRUB_PREFIXES = ('AWS_', 'OPENAI_', 'CODEX_', 'ANTHROPIC_', 'LLMAR_')


def harbor_env(base: dict[str, str]) -> dict[str, str]:
    """The environment for the `harbor run` subprocess: the parent's, minus credentials and model endpoints, plus
    HARBOR_TELEMETRY=0 and this directory on PYTHONPATH (for llmar_env)."""
    env = {k: v for k, v in base.items() if k not in SCRUB_ENV and not k.startswith(SCRUB_PREFIXES)}
    env['HARBOR_TELEMETRY'] = '0'
    env['PYTHONPATH'] = str(hcommon.HERE) + (':' + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
    return env


def environment_config(codex_bin: pathlib.Path | None = None) -> dict[str, Any]:
    """Harbor `environment` section: local Docker through llmar_env (offline environments get network_mode none),
    containers deleted, no resource overrides. With codex_bin, the read-only Codex mount (agent environment only;
    Harbor does not propagate mounts to the separate verifier)."""
    env: dict[str, Any] = {'import_path': ENV_IMPORT_PATH, 'delete': True}
    if codex_bin is not None:
        if not codex_bin.is_absolute():
            raise ValueError('codex_bin must be an absolute host path')
        env['mounts'] = [{'type': 'bind', 'source': str(codex_bin), 'target': hcommon.CTR_CODEX, 'read_only': True}]
    return env


def task_network_public(task_dir: pathlib.Path) -> bool:
    """True when the task's agent phase resolves to Harbor's `public` policy: the environment allows the internet
    (`allow_internet = true` or `network_mode = "public"`, with no allowlist) and [agent] sets no other mode. A missing
    or unreadable task.toml is not public (the DeepSWE path)."""
    try:
        cfg = tomllib.loads((task_dir / 'task.toml').read_text(encoding='utf-8'))
    except (OSError, tomllib.TOMLDecodeError):
        return False
    env, agent = cfg.get('environment') or {}, cfg.get('agent') or {}
    if 'network_mode' in env or env.get('allowed_hosts') is not None:
        public_env = env.get('network_mode', 'public') == 'public' and not env.get('allowed_hosts')
    else:
        public_env = env.get('allow_internet') is True
    return public_env and agent.get('network_mode') in (None, 'public')


def agent_config(base_url: str, public: bool = False) -> dict[str, Any]:
    host = urllib.parse.urlsplit(base_url).hostname
    kwargs: dict[str, Any] = {'version': codex_config.codex_setup.CODEX['version'], 'reasoning_effort': codex_config.EFFORT,
                              'config': codex_config.config(base_url)}
    if public:
        kwargs['disable_web_search'] = True       # → `-c web_search=disabled`, kept through Harbor's public-mode call
    out: dict[str, Any] = {'name': 'codex', 'model_name': 'auto', 'skip_model_parsing': True, 'kwargs': kwargs,
                           'env': {DUMMY_KEY_ENV: DUMMY_KEY}}
    if not public:
        out['extra_allowed_hosts'] = [host]
    return out


def job_config(*, arm: str, trial_id: str, task_dir: pathlib.Path, jobs_dir: pathlib.Path, job_name: str, base_url: str,
               codex_bin: pathlib.Path | None = None) -> dict[str, Any]:
    if arm not in ARMS:
        raise ValueError(f'unknown arm {arm!r}')
    if f'/r/{trial_id}/' not in urllib.parse.urlsplit(base_url).path + '/':
        raise ValueError('base_url must be the route registered for this trial_id')
    return {
        'job_name': job_name, 'jobs_dir': str(jobs_dir), 'n_attempts': 1, 'n_concurrent_trials': 1, 'quiet': True,
        'retry': {'max_retries': 0},
        'environment': environment_config(codex_bin or CODEX_BIN),
        'verifier': {},
        'agents': [agent_config(base_url, public=task_network_public(task_dir))],
        'tasks': [{'path': str(task_dir)}],
    }
