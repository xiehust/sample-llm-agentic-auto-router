"""Harbor 0.25.0 `claude-code` agent, subclassed thin for Claude Code × Harbor (design-harness §1.1, §1.4).

Loaded by Harbor itself (`import_path: cc_agent:LlmarClaudeCode`), so it imports harbor; nothing on the runner's
driver path imports it (the driver venv has no Harbor). Everything else is Harbor's own launch:
`printf … | claude --verbose --output-format=stream-json [flags] --print | tee <logs>/claude-code.txt`, run under
`set -o pipefail` by Harbor's exec, with CLAUDE_CONFIG_DIR=<logs>/sessions.

Overrides, and only these:
- `_model_alias_env` → {}: Harbor would set ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL and
  CLAUDE_CODE_SUBAGENT_MODEL to the main model under a custom base URL (73's R6). The aliases come from cc_config.
- `_resolve_auth_env` → exactly cc_config.agent_env(): the trial's proxy route, a dummy key, the alias map, the
  non-essential-traffic switches. Harbor's provider resolution (Bedrock/OAuth/gateway branches) never runs, so no
  host credential or Bedrock selector can reach the container.
- `check_model_credentials` → no check (there is no credential to check).
- `install()` → verify only: the pinned binary must answer `claude --version` with the pin; otherwise the trial fails
  as a harness error. It never falls through to npm or downloads.claude.ai (TB's open egress must not fetch an
  unpinned build).
"""
from __future__ import annotations

from typing import Any

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment

import cc_config


class LlmarClaudeCode(ClaudeCode):
    """Harbor's claude-code agent with fixed env, explicit model aliases and no installation."""

    @classmethod
    def check_model_credentials(cls, connection: Any, *, kwargs: Any, env: Any, explicit_env: Any = None) -> None:
        return None

    def _model_alias_env(self, model: str, *, all_aliases: bool) -> dict[str, str]:
        return {}

    def _resolve_auth_env(self) -> dict[str, str]:
        return cc_config.agent_env(self._llmar_base_url())

    def _llmar_base_url(self) -> str:
        url = (self._extra_env or {}).get(cc_config.BASE_URL_ENV) if hasattr(self, '_extra_env') else None
        url = url or self._get_env(cc_config.BASE_URL_ENV)
        if not url:
            raise NonZeroAgentExitCodeError(f'{cc_config.BASE_URL_ENV} is not set (the trial proxy route)')
        return url

    async def install(self, environment: BaseEnvironment) -> None:
        r = await environment.exec(command=self._INSTALL_VERSION_COMMAND)
        got = self.parse_version(r.stdout or '') if r.return_code == 0 else None
        if got != cc_config.VERSION:
            raise NonZeroAgentExitCodeError(f'claude-code pin not present (want {cc_config.VERSION}, got {got!r})')
