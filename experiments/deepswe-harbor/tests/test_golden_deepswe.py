"""DeepSWE parity (TB design §4.0): the Harbor config, the compose paths of each DeepSWE environment, and a report_zh
render of synthetic rows are byte-identical to the snapshots taken on the code before the Terminal-Bench change."""
import json
import pathlib

import pytest

pytest.importorskip('harbor')

import harbor_job  # noqa: E402
import llmar_env  # noqa: E402
import report_zh as rz  # noqa: E402
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy  # noqa: E402
from harbor.models.trial.paths import TrialPaths  # noqa: E402

GOLDEN = pathlib.Path(__file__).parent / 'golden'
TID = '0123456789abcdef0123456789abcdef'
ROOT = pathlib.Path('/golden')
NO = NetworkPolicy(network_mode=NetworkMode.NO_NETWORK)
PUB = NetworkPolicy(network_mode=NetworkMode.PUBLIC)
PROXY = NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=['172.17.0.1'])


def _config_snapshot(tmp_path, monkeypatch) -> dict:
    jc = {a: harbor_job.job_config(arm=a, trial_id=TID, task_dir=ROOT / 'tasks' / 't', jobs_dir=ROOT / 'jobs', job_name=TID,
                                   base_url=f'http://172.17.0.1:8088/r/{TID}/v1', codex_bin=ROOT / 'bin' / 'codex') for a in 'AFCB'}
    out = {'job_config': jc, 'environment_config': harbor_job.environment_config(),
           'environment_config_bin': harbor_job.environment_config(ROOT / 'bin' / 'codex')}
    monkeypatch.setattr(llmar_env.DockerEnvironment, '_egress_control_kernel_support', classmethod(lambda cls: True))
    for k in llmar_env.ONLINE_KEYS:      # a runner in internet mode must not change DeepSWE's environments either
        monkeypatch.setenv(k, {'ONLINE_NETWORK': 'llmar-online', 'ONLINE_DNS': '169.254.169.253'}[k])
    (tmp_path / 'env').mkdir()
    for name, base, ph in (('verifier_no_network', PUB, [NO]), ('agent_proxy_allowlist', PUB, [PROXY]), ('checks_no_network', NO, [NO, NO])):
        e = llmar_env.LlmarDockerEnvironment(environment_dir=tmp_path / 'env', environment_name='t', session_id='s',
                                             trial_paths=TrialPaths(trial_dir=tmp_path / 'trial'),
                                             task_env_config=EnvironmentConfig(docker_image='img:1'), network_policy=base, phase_network_policies=ph)
        out[name] = {'offline': e.llmar_offline, 'egress_control': e._enable_egress_control,
                     'compose_tail': [p.name for p in e._docker_compose_paths], 'caps': e.capabilities.model_dump(mode='json')}
    return out


def test_deepswe_harbor_config_is_unchanged(tmp_path, monkeypatch):
    got = json.dumps(_config_snapshot(tmp_path, monkeypatch), indent=1, sort_keys=True) + '\n'
    assert got == (GOLDEN / 'deepswe_harbor_config.json').read_text()


def test_deepswe_report_render_is_unchanged():
    import test_report_zh as T

    rows = T._four_arm(n=10)
    strata = {f't{i}': {'stratum': 'frontier' if i < 5 else 'standard', 'stable': i % 3 != 0} for i in range(10)}
    assert rz.render(rz.build(rows, strata, n_boot=200)) == (GOLDEN / 'deepswe_report.zh.md').read_text()
