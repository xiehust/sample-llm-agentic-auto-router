"""llmar_env against the installed Harbor (skipped when harbor is not importable): which environments go offline,
and the compose overrides each one gets. No Docker is started."""
import json
import pathlib

import pytest

harbor = pytest.importorskip('harbor')

import llmar_env  # noqa: E402
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy  # noqa: E402
from harbor.models.trial.paths import TrialPaths  # noqa: E402

NO = NetworkPolicy(network_mode=NetworkMode.NO_NETWORK)
PUB = NetworkPolicy(network_mode=NetworkMode.PUBLIC)
PROXY = NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=['172.17.0.1'])


def _env(tmp_path, baseline, phases, monkeypatch):
    # The kernel probe runs a container; pretend it passes so the agent-env case keeps its sidecar.
    monkeypatch.setattr(llmar_env.DockerEnvironment, '_egress_control_kernel_support', classmethod(lambda cls: True))
    (tmp_path / 'env').mkdir(exist_ok=True)
    return llmar_env.LlmarDockerEnvironment(environment_dir=tmp_path / 'env', environment_name='t', session_id='s',
                                            trial_paths=TrialPaths(trial_dir=tmp_path / 'trial'),
                                            task_env_config=EnvironmentConfig(docker_image='img:1'),
                                            network_policy=baseline, phase_network_policies=phases)


def test_verifier_env_is_offline_without_sidecar(tmp_path, monkeypatch):
    e = _env(tmp_path, PUB, [NO], monkeypatch)
    assert e.llmar_offline and not e._enable_egress_control
    assert e._docker_compose_paths[-1] == llmar_env.COMPOSE_NO_NETWORK_PATH
    assert llmar_env.CAP_DROP_NET_RAW not in e._docker_compose_paths
    caps = e.capabilities
    assert caps.disable_internet and caps.dynamic_network_policy
    e.validate_network_policy_support(NO)


def test_agent_env_keeps_the_sidecar_and_drops_net_raw(tmp_path, monkeypatch):
    e = _env(tmp_path, PUB, [PROXY], monkeypatch)
    assert not e.llmar_offline and e._enable_egress_control
    paths = e._docker_compose_paths
    assert paths[-1] == llmar_env.CAP_DROP_NET_RAW and llmar_env.COMPOSE_NO_NETWORK_PATH not in paths
    assert json.loads(llmar_env.CAP_DROP_NET_RAW.read_text()) == {'services': {'main': {'cap_drop': ['NET_RAW']}}}


async def _apply(e, p):
    await e._apply_network_policy(p)


def test_offline_ignores_policy_switches_with_a_warning(tmp_path, monkeypatch, caplog):
    import asyncio

    e = _env(tmp_path, PUB, [NO], monkeypatch)
    asyncio.run(_apply(e, NO))
    asyncio.run(_apply(e, PUB))
    assert any('ignoring a switch to public' in r.message for r in caplog.records)


# ---------------------------------------------------------------- online mode (Terminal-Bench 2.1, TB design §4.2)

ONLINE = {'ONLINE_NETWORK': 'llmar-online', 'ONLINE_DNS': '169.254.169.253'}


def _online(tmp_path, monkeypatch, env=ONLINE, phases=(PUB, PUB)):
    for k in llmar_env.ONLINE_KEYS:
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return _env(tmp_path, PUB, list(phases), monkeypatch)


def test_all_public_environment_joins_the_runner_network(tmp_path, monkeypatch):
    e = _online(tmp_path, monkeypatch)
    assert e.llmar_online and not e.llmar_offline and not e._enable_egress_control
    paths = e._docker_compose_paths
    assert paths[-1] == e.llmar_online_compose and llmar_env.CAP_DROP_NET_RAW not in paths and llmar_env.COMPOSE_NO_NETWORK_PATH not in paths
    ov = json.loads(e.llmar_online_compose.read_text())
    assert ov == {'services': {'main': {'networks': {'llmar-online': {}}, 'dns': ['169.254.169.253'], 'cap_drop': ['NET_RAW']}},
                  'networks': {'llmar-online': {'external': True, 'name': 'llmar-online'}}}
    assert e.llmar_online_compose.parent == tmp_path / 'trial'


@pytest.mark.parametrize('env', [{}, {'ONLINE_NETWORK': 'llmar-online'}, {'ONLINE_DNS': '169.254.169.253'},
                                 {'ONLINE_NETWORK': 'Bad Name', 'ONLINE_DNS': '169.254.169.253'},
                                 {'ONLINE_NETWORK': 'llmar-online', 'ONLINE_DNS': 'dns.example'},
                                 {'ONLINE_NETWORK': 'llmar-online', 'ONLINE_DNS': 'fd00:ec2::253'}])
def test_online_mode_fails_closed_without_valid_runner_keys(tmp_path, monkeypatch, env):
    with pytest.raises(ValueError):
        _online(tmp_path, monkeypatch, env)


def test_online_refuses_a_task_compose_file_and_non_public_switches(tmp_path, monkeypatch):
    import asyncio

    (tmp_path / 'env').mkdir()
    (tmp_path / 'env' / 'docker-compose.yaml').write_text('services: {}\n')
    with pytest.raises(ValueError):
        _online(tmp_path, monkeypatch)
    (tmp_path / 'env' / 'docker-compose.yaml').unlink()
    e = _online(tmp_path, monkeypatch)
    asyncio.run(_apply(e, PUB))                       # no-op
    with pytest.raises(ValueError):
        asyncio.run(_apply(e, NO))


def test_mixed_or_restricted_policies_never_go_online(tmp_path, monkeypatch):
    for phases in ((PUB, PROXY), (PROXY,), (NO,), (PUB, NO)):
        e = _online(tmp_path, monkeypatch, phases=phases)
        assert not e.llmar_online and e.llmar_online_compose is None


def test_overlay_never_creates_or_removes_the_network():
    ov = llmar_env.online_overlay('llmar-online', '169.254.169.253')
    assert ov['networks']['llmar-online']['external'] is True
    src = (pathlib.Path(llmar_env.__file__)).read_text()
    assert 'network rm' not in src and 'network create' not in src


def test_net_probe_parsing_and_host_veth(tmp_path):
    trie = ('Main:\n  +-- 0.0.0.0/0 3 0 5\n     |-- 0.0.0.0\n        /0 universe UNICAST\n     |-- 10.201.0.7\n        /32 host LOCAL\n'
            'Local:\n     |-- 10.201.0.7\n        /32 host LOCAL\n     |-- 127.0.0.1\n        /32 host LOCAL\n')
    p = llmar_env.parse_net_probe('42\n' + trie)
    assert p == {'iflink': 42, 'ip': '10.201.0.7', 'ips': ['10.201.0.7']}
    assert llmar_env.parse_net_probe('')['iflink'] is None
    sysnet = tmp_path / 'net'
    for name, idx in (('lo', 1), ('br-llmon', 7), ('veth1a2b3c', 42)):
        (sysnet / name).mkdir(parents=True)
        (sysnet / name / 'ifindex').write_text(f'{idx}\n')
    assert llmar_env.host_veth(42, sysnet) == 'veth1a2b3c' and llmar_env.host_veth(99, sysnet) is None and llmar_env.host_veth(None, sysnet) is None


def test_start_records_the_veth_and_never_fails_the_trial(tmp_path, monkeypatch):
    import asyncio

    e = _online(tmp_path, monkeypatch)

    async def fake_super_start(self, force_build):
        return None

    class R:
        def __init__(self, out, rc=0):
            self.stdout, self.return_code = out, rc

    async def fake_exec(command, **kw):
        assert command == 'cat /sys/class/net/eth0/iflink /proc/net/fib_trie'
        return R('5\n     |-- 10.201.0.9\n        /32 host LOCAL\n')

    monkeypatch.setattr(llmar_env.DockerEnvironment, 'start', fake_super_start)
    monkeypatch.setattr(e, 'exec', fake_exec)
    monkeypatch.setattr(llmar_env, 'host_veth', lambda i: 'vethabc' if i == 5 else None)
    asyncio.run(e.start(False))
    rec = json.loads((tmp_path / 'trial' / llmar_env.NET_RECORD).read_text())
    assert rec['veth'] == 'vethabc' and rec['ip'] == '10.201.0.9' and rec['iflink'] == 5 and rec['network'] == 'llmar-online'

    async def boom(command, **kw):
        raise RuntimeError('exec failed')
    monkeypatch.setattr(e, 'exec', boom)
    asyncio.run(e.start(False))                       # no exception
    assert json.loads((tmp_path / 'trial' / llmar_env.NET_RECORD).read_text())['error'] == 'RuntimeError'
