"""Harbor job config for one Claude Code trial attempt (design-harness §1; 17's profile `harbor_job_cc:job_config`).

Same shape and driver contract as harbor_job.job_config (Codex, unchanged): one trial, no retries, llmar_env, the
task's own timeouts and resources. The agent is cc_agent.LlmarClaudeCode (Harbor's claude-code, subclassed thin),
the client's main-loop model is the arm's (cc_config.client_model), effort high, WebSearch/WebFetch disallowed on both
benchmarks. The pinned binaries are mounted read-only with a wrapper at /usr/local/bin/claude that execs the build
that runs in the image (glibc, then musl); a3's prepull gate refuses a task where neither runs.
"""
from __future__ import annotations

import pathlib
import urllib.parse
from typing import Any

import cc_config
import harbor_job
import hcommon
from hcommon import ARMS

AGENT_IMPORT_PATH = 'cc_agent:LlmarClaudeCode'
WRAPPER = hcommon.BIN / 'claude-wrapper.sh'
WRAPPER_TEXT = (
    '#!/bin/sh\n'
    '# llmar: exec the pinned Claude Code build that runs in this image (glibc first, then musl).\n'
    f'd={hcommon.CTR_CLAUDE_BUILDS}\n'
    'for b in glibc musl; do\n'
    '  if "$d/$b" --version >/dev/null 2>&1; then exec "$d/$b" "$@"; fi\n'
    'done\n'
    'echo "claude: no pinned build runs in this image" >&2\n'
    'exit 127\n'
)


def harbor_env(base: dict[str, str]) -> dict[str, str]:
    """harbor_job.harbor_env (credentials and model endpoints dropped) minus the Claude Code selectors and proxies."""
    return cc_config.scrub(harbor_job.harbor_env(base))


def mounts(glibc: pathlib.Path | None = None, musl: pathlib.Path | None = None, wrapper: pathlib.Path | None = None) -> list[dict[str, Any]]:
    pairs = [(glibc or hcommon.claude_bin('linux-x64'), f'{hcommon.CTR_CLAUDE_BUILDS}/glibc'),
             (musl or hcommon.claude_bin('linux-x64-musl'), f'{hcommon.CTR_CLAUDE_BUILDS}/musl'),
             (wrapper or WRAPPER, hcommon.CTR_CLAUDE)]
    out = []
    for src, dst in pairs:
        if not src.is_absolute():
            raise ValueError('mount sources must be absolute host paths')
        out.append({'type': 'bind', 'source': str(src), 'target': dst, 'read_only': True})
    return out


def environment_config(**kw: Any) -> dict[str, Any]:
    env = harbor_job.environment_config(None)
    env['mounts'] = mounts(**kw)
    return env


def agent_config(arm: str, base_url: str, public: bool = False) -> dict[str, Any]:
    host = urllib.parse.urlsplit(base_url).hostname
    out: dict[str, Any] = {
        'import_path': AGENT_IMPORT_PATH, 'model_name': cc_config.client_model(arm), 'skip_model_parsing': True,
        'kwargs': {'version': cc_config.VERSION, 'reasoning_effort': cc_config.EFFORT, 'disable_web_search': True},
        'env': {cc_config.BASE_URL_ENV: base_url},
    }
    if not public:
        out['extra_allowed_hosts'] = [host]
    return out


def job_config(*, arm: str, trial_id: str, task_dir: pathlib.Path, jobs_dir: pathlib.Path, job_name: str, base_url: str,
               **mount_kw: Any) -> dict[str, Any]:
    if arm not in ARMS:
        raise ValueError(f'unknown arm {arm!r}')
    if f'/r/{trial_id}/' not in urllib.parse.urlsplit(base_url).path + '/':
        raise ValueError('base_url must be the route registered for this trial_id')
    return {
        'job_name': job_name, 'jobs_dir': str(jobs_dir), 'n_attempts': 1, 'n_concurrent_trials': 1, 'quiet': True,
        'retry': {'max_retries': 0},
        'environment': environment_config(**mount_kw),
        'verifier': {},
        'agents': [agent_config(arm, base_url, public=harbor_job.task_network_public(task_dir))],
        'tasks': [{'path': str(task_dir)}],
    }
