"""cc_agent.LlmarClaudeCode on Harbor 0.25.0 (design-harness §1.1): no alias forcing, the exact agent env, Harbor's own
CLI flags, and an install() that only verifies the pin. Skipped without Harbor (the driver venv has none)."""
import asyncio
import types

import pytest

pytest.importorskip('harbor')

import cc_agent  # noqa: E402
import cc_config  # noqa: E402

URL = 'http://172.17.0.1:8088/r/t1/v1'


class FakeEnv:
    def __init__(self, out, rc=0):
        self.out, self.rc, self.cmds = out, rc, []

    async def exec(self, command, **_):
        self.cmds.append(command)
        return types.SimpleNamespace(return_code=self.rc, stdout=self.out, stderr='')


def agent(tmp_path, **kw):
    return cc_agent.LlmarClaudeCode(logs_dir=tmp_path, model_name='global.anthropic.claude-sonnet-5-5', skip_model_parsing=True,
                                    version=cc_config.VERSION, reasoning_effort='high', disable_web_search=True,
                                    extra_env={cc_config.BASE_URL_ENV: URL}, **kw)


def test_env_aliases_and_flags(tmp_path):
    a = agent(tmp_path)
    assert a._model_alias_env('global.anthropic.claude-sonnet-5-5', all_aliases=True) == {}
    assert a._resolve_auth_env() == cc_config.agent_env(URL)
    flags = a.build_cli_flags()
    assert '--effort high' in flags and '--disallowedTools WebSearch,WebFetch' in flags and '--permission-mode=bypassPermissions' in flags


def test_install_only_verifies_the_pin(tmp_path):
    a = agent(tmp_path)
    env = FakeEnv('2.1.318 (Claude Code)')
    asyncio.run(a.install(env))
    assert len(env.cmds) == 1 and 'claude --version' in env.cmds[0]
    for out, rc in (('2.1.319 (Claude Code)', 0), ('', 127)):
        with pytest.raises(Exception, match='pin not present'):
            asyncio.run(a.install(FakeEnv(out, rc)))
    assert not any('npm' in c or 'curl' in c for c in env.cmds)
