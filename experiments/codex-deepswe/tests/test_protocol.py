"""Protocol and scheduler plumbing against a scripted fake Docker (no containers, no model calls)."""
import json
import pathlib

import pytest

import protocol
import proxy as px
import scheduler
import selection
from common import write_json
from dataset import Task
from docker_ops import Limits, Result

LOG_GOLD = 'short test summary info\nPASSED r2e_tests/test_1.py::test_a\nPASSED r2e_tests/test_1.py::test_b\n'
LOG_BASE = 'short test summary info\nFAILED r2e_tests/test_1.py::test_a - E\nPASSED r2e_tests/test_1.py::test_b\n'
COMMIT = json.dumps({'file_diffs': [{'header': {'file': {'path': 'pkg/m.py'}}, 'minus_file': {'path': 'a/pkg/m.py'}, 'plus_file': {'path': 'b/pkg/m.py'},
                                     'hunks': [{'descriptor': {'old_range': {'start': 1, 'length': 1}, 'new_range': {'start': 1, 'length': 1}, 'section': ''},
                                                'line_group': {'all_lines': [{'content': 'a', 'type': 'deleted'}, {'content': 'b', 'type': 'added'}]}}]}],
                     'old_commit_hash': 'a' * 40, 'new_commit_hash': 'b' * 40})
AGENT_DIFF = 'diff --git a/pkg/m.py b/pkg/m.py\n--- a/pkg/m.py\n+++ b/pkg/m.py\n@@ -1 +1 @@\n-a\n+b\n'


class FakeDocker:
    """Containers are names; a patched container 'passes' the hidden tests."""

    def __init__(self, future_visible=False):
        self.patched: set[str] = set()
        self.started: list[tuple[str, str]] = []
        self.removed: list[str] = []
        self.files: dict[tuple[str, str], bytes] = {}
        self.future_visible = future_visible
        self.stripped: set[str] = set()

    def start(self, image, name, network, limits, label):
        assert network == 'llmar-tasks'
        self.started.append((name, label))
        return Result(0, 'id', '', 0.1)

    def sh(self, name, script, timeout, workdir='/testbed', env=None):
        if script.startswith('test -e '):
            return Result(1, '', '', 0.0)                         # hidden paths are gone
        if 'git cat-file -e' in script:
            return Result(0 if self.future_visible and name not in self.stripped else 1, '', '', 0.0)
        if 'git for-each-ref' in script:
            self.stripped.add(name)
            return Result(0, '', '', 0.0)
        if 'git write-tree' in script:
            return Result(0, 'c' * 40 + '\n', '', 0.0)
        if 'git diff --cached' in script:
            return Result(0, AGENT_DIFF, '', 0.0)
        if 'git apply' in script:
            self.patched.add(name)
            return Result(0, '', '', 0.0)
        if 'run_tests.sh' in script:
            return Result(0, LOG_GOLD if name in self.patched else LOG_BASE, '', 1.0)
        return Result(0, '', '', 0.0)

    def exec_argv(self, name, argv, timeout, workdir, env, stdout_path, stderr_path):
        assert 'LLMAR_DUMMY_KEY' in env and not any('TOKEN' in k for k in env)
        stdout_path.write_text('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n'
                               '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\n')
        stderr_path.write_text('')
        return Result(0, '', '', 2.0)

    def cp_in(self, name, src, dest):
        return Result(0, '', '', 0.0)

    def write_file(self, name, dest, content, mode='0644'):
        self.files[(name, dest)] = content
        return Result(0, '', '', 0.0)

    def rm(self, name):
        self.removed.append(name)
        return Result(0, '', '', 0.0)

    def pull(self, image, timeout=0):
        self.pulls = getattr(self, 'pulls', 0) + 1
        self.have_image = True
        return Result(0, '', '', 0.0)

    def image_arch(self, image):
        return 'amd64' if getattr(self, 'have_image', True) else None


def _task(tid='numpy-0aa000-000001'):
    return Task(tid, 'numpy', '1' * 40, 'img:tag', 5, 1, problem_statement='[ISSUE]bug[/ISSUE]',
                expected_output_json=json.dumps({'test_a': 'PASSED', 'test_b': 'PASSED'}), parsed_commit=COMMIT)


def _env(fd):
    return protocol.Env(fd, 'llmar-tasks', Limits(), 600)


def test_validate_three_times_each(tmp_path):
    fd = FakeDocker()
    rec = protocol.validate(_env(fd), _task(), tmp_path)
    assert rec['verdict']['ok'] and rec['spec']['f2p'] == ['test_a'] and rec['spec']['p2p'] == ['test_b']
    assert len(fd.started) == 7 and len(fd.removed) == 7 and rec['base_strict'] == [False] * 3 and rec['gold_strict'] == [True] * 3
    assert rec['base_rebuild_ok']
    assert json.loads((tmp_path / 'numpy-0aa000-000001.json').read_text())['verdict']['ok']


def test_run_agent_and_grade(tmp_path):
    fd = FakeDocker(future_visible=True)
    spec = protocol.RunSpec('r-1', 'pilot', 'A', _task(), 'standard')
    out = protocol.run_agent(_env(fd), spec, 'http://172.18.0.1:8088/r/r-1/v1', pathlib.Path('/bin/true'), tmp_path / 'run')
    assert out['exit_reason'] == 'done' and out['future_commit_visible'] and out['git_stripped']
    assert out['patch_text'] == AGENT_DIFF and out['patch']['stats']['files'] == 1
    toml = next(v for (n, d), v in fd.files.items() if d.endswith('config.toml')).decode()
    assert 'x-router-session = "r-1"' in toml or '"x-router-session" = "r-1"' in toml
    g = protocol.grade(_env(fd), _task(), out['patch_text'], {'f2p': ['test_a'], 'p2p': ['test_b']}, 'r-1-grade')
    assert g['status'] == 'graded' and g['resolved'] and g['strict']
    assert protocol.grade(_env(fd), _task(), '', {'f2p': ['test_a'], 'p2p': []}, 'x')['status'] == 'empty-patch'
    assert set(fd.removed) == {n for n, _ in fd.started}            # every container removed


def test_scheduler_end_to_end_with_fake_docker(tmp_path):
    fd = FakeDocker()
    t = _task()
    cands = [{'task_id': f'numpy-{i:06x}-c0ffee', 'repo': ['numpy', 'pandas', 'pillow'][i % 3], 'size': 'small',
              'pred_tier': ['standard', 'fast', 'frontier'][i % 3]} for i in range(60)]
    sel = selection.select(cands, seed=5, n_main=10, subsets={'C': 2, 'B': 1, 'D': 1}, n_repeat=2)
    tasks = {tid: Task(tid, sel['tasks'][tid]['repo'], '1' * 40, 'img', 5, 1, t.problem_statement, t.expected_output_json, COMMIT)
             for tid in sel['tasks']}
    vdir = tmp_path / 'validation'
    for tid in tasks:
        write_json(vdir / f'{tid}.json', {'verdict': {'ok': True}, 'spec': {'f2p': ['test_a'], 'p2p': ['test_b']}})
    from ledger import Ledger
    led = Ledger(tmp_path / 'ledger.json')
    srv = px.EgressProxy('127.0.0.1', 0, px.Upstreams(None, 'ap-southeast-1'), on_call=lambda r: None, allow_loopback_bind=True)
    try:
        s = scheduler.Scheduler(_env(fd), srv, led, tasks, sel, pathlib.Path('/bin/true'), lambda: (lambda: 'tok'),
                                concurrency=2, results_dir=tmp_path, validation_dir=vdir, log=lambda m: None, min_free_gb=0)
        out = s.run(scheduler.plan(sel, 'pilot', 1))
    finally:
        srv.server_close()
    rows = [json.loads(x) for x in (tmp_path / 'results.jsonl').read_text().splitlines()]
    assert out['ran'] == 9 and out['stop_reason'] is None and len(rows) == 9
    assert all(r['resolved'] and r['exit_reason'] == 'done' for r in rows)
    assert len({r['run_id'] for r in rows}) == 9 and all(r['run_id'].startswith('r-') for r in rows)
    assert all(v['status'] == 'settled' for v in led.data['runs'].values()) and len(led.data['runs']) == 9
    assert not srv.routes                                           # every route unregistered
    # a second run of the phase skips what is done
    srv2 = px.EgressProxy('127.0.0.1', 0, px.Upstreams(None, 'ap-southeast-1'), on_call=lambda r: None, allow_loopback_bind=True)
    try:
        s2 = scheduler.Scheduler(_env(fd), srv2, Ledger(tmp_path / 'ledger.json'), tasks, sel, pathlib.Path('/bin/true'), lambda: (lambda: 'tok'),
                                 results_dir=tmp_path, validation_dir=vdir, log=lambda m: None, min_free_gb=0)
        assert s2.run(scheduler.plan(sel, 'pilot', 1))['ran'] == 0
    finally:
        srv2.server_close()


def test_scheduler_stops_at_cap(tmp_path):
    fd = FakeDocker()
    cands = [{'task_id': f'numpy-{i:06x}-c0ffee', 'repo': ['numpy', 'pandas', 'pillow'][i % 3], 'size': 'small', 'pred_tier': 'standard'} for i in range(30)]
    sel = selection.select(cands, seed=6, n_main=6, subsets={'C': 1, 'B': 1, 'D': 1}, n_repeat=1)
    t = _task()
    tasks = {tid: Task(tid, 'numpy', '1' * 40, 'img', 5, 1, t.problem_statement, t.expected_output_json, COMMIT) for tid in sel['tasks']}
    from ledger import Ledger
    led = Ledger(tmp_path / 'ledger.json', caps={'pilot': 10, 'total': 0.5})
    srv = px.EgressProxy('127.0.0.1', 0, px.Upstreams(None, 'ap-southeast-1'), on_call=lambda r: None, allow_loopback_bind=True)
    try:
        out = scheduler.Scheduler(_env(fd), srv, led, tasks, sel, pathlib.Path('/bin/true'), lambda: (lambda: 'tok'),
                                  results_dir=tmp_path, validation_dir=tmp_path / 'v', log=lambda m: None, min_free_gb=0).run(scheduler.plan(sel, 'main', 1))
    finally:
        srv.server_close()
    assert out['ran'] == 0 and out['stop_reason'].startswith('cap')


def test_scheduler_stops_below_free_disk(tmp_path):
    cands = [{'task_id': f'numpy-{i:06x}-c0ffee', 'repo': 'numpy', 'size': 'small', 'pred_tier': 'standard'} for i in range(30)]
    sel = selection.select(cands, seed=7, n_main=6, subsets={'C': 1, 'B': 1, 'D': 1}, n_repeat=1)
    from ledger import Ledger
    srv = px.EgressProxy('127.0.0.1', 0, px.Upstreams(None, 'ap-southeast-1'), on_call=lambda r: None, allow_loopback_bind=True)
    try:
        s = scheduler.Scheduler(_env(FakeDocker()), srv, Ledger(tmp_path / 'l.json'), {}, sel, pathlib.Path('/bin/true'), None,
                                results_dir=tmp_path, log=lambda m: None, min_free_gb=30)
        s.free_gb = lambda paths: 12.0
        out = s.run(scheduler.plan(sel, 'main', 1))
    finally:
        srv.server_close()
    assert out['ran'] == 0 and out['stop_reason'].startswith('disk')


def test_history_leak_beyond_head_is_stripped_and_recorded(tmp_path):
    class Leaky(FakeDocker):
        def sh(self, name, script, timeout, workdir='/testbed', env=None):
            if 'rev-list --all --not HEAD' in script:
                return Result(0, '' if name in self.stripped else 'f' * 40 + '\n', '', 0.0)
            return super().sh(name, script, timeout, workdir, env)
    fd = Leaky()
    out = protocol.run_agent(_env(fd), protocol.RunSpec('r-2', 'pilot', 'A', _task(), 'standard'), 'http://x/r/r-2/v1',
                             pathlib.Path('/bin/true'), tmp_path / 'run')
    h = out['history_check']
    assert h['beyond_head'] and out['git_stripped'] and not h['after']['leak'] and out['exit_reason'] == 'done'


def test_history_leak_that_survives_stripping_fails_the_run(tmp_path):
    class Stubborn(FakeDocker):
        def sh(self, name, script, timeout, workdir='/testbed', env=None):
            if 'rev-list --all --not HEAD' in script:
                return Result(0, 'f' * 40 + '\n', '', 0.0)
            return super().sh(name, script, timeout, workdir, env)
    out = protocol.run_agent(_env(Stubborn()), protocol.RunSpec('r-3', 'pilot', 'A', _task(), 'standard'), 'http://x/r/r-3/v1',
                             pathlib.Path('/bin/true'), tmp_path / 'run')
    assert out['exit_reason'] == 'harness-error' and 'still reachable' in out['error']


def test_rebuild_failure_is_excluded_not_unresolved():
    class NoBuild(FakeDocker):
        def sh(self, name, script, timeout, workdir='/testbed', env=None):
            if 'build_ext' in script:
                return Result(1, '', 'gcc: error', 1.0)
            return super().sh(name, script, timeout, workdir, env)
    ext = 'diff --git a/pkg/_x.pyx b/pkg/_x.pyx\n--- a/pkg/_x.pyx\n+++ b/pkg/_x.pyx\n@@ -1 +1 @@\n-a\n+b\n'
    g = protocol.grade(_env(NoBuild()), _task(), ext, {'f2p': ['test_a'], 'p2p': []}, 'g', base_rebuild_ok=False)
    assert g['status'] == 'rebuild-unavailable' and g['excluded']
    ga = protocol.grade(_env(NoBuild()), _task(), ext, {'f2p': ['test_a'], 'p2p': []}, 'g', base_rebuild_ok=True)
    assert ga['status'] == 'rebuild-failed-agent' and not ga['resolved'] and not ga.get('excluded')

    class NoSetup(FakeDocker):
        def sh(self, name, script, timeout, workdir='/testbed', env=None):
            if script == 'test -f setup.py':
                return Result(1, '', '', 0.0)
            return super().sh(name, script, timeout, workdir, env)
    g2 = protocol.grade(_env(NoSetup()), _task(), ext, {'f2p': ['test_a'], 'p2p': []}, 'g', base_rebuild_ok=True)
    assert g2['status'] == 'rebuild-unavailable' and g2['excluded'] and g2['apply']['rebuild']['status'] == 'no-setup-py'
    assert protocol.rebuild_base(_env(NoSetup()), _task(), 'x') == {'ok': False, 'status': 'no-setup-py'}
    assert protocol.rebuild_base(_env(NoBuild()), _task(), 'x')['status'] == 'failed'
    assert protocol.rebuild_base(_env(FakeDocker()), _task(), 'x')['ok']


# ---------------------------------------------------------------- net-check and checked docker steps

NETCHECK_OK = '{"proxy": "404", "internet": "blocked:TimeoutError", "imds": "blocked:OSError", "host_other_port": "blocked:x", "dns": "blocked:gaierror"}'


class NetDocker(FakeDocker):
    def __init__(self, script_result=None, start_code=0, have_image=True, pull_code=0):
        super().__init__()
        self.script_result = script_result or Result(0, NETCHECK_OK + '\n', '', 1.0)
        self.start_code, self.have_image, self.pull_code = start_code, have_image, pull_code
        self.scripts = []

    def start(self, image, name, network, limits, label):
        self.started.append((name, label))
        return Result(self.start_code, '', 'docker: Error response from daemon: boom' if self.start_code else '', 0.1)

    def pull(self, image, timeout=0):
        self.pulls = getattr(self, 'pulls', 0) + 1
        if self.pull_code == 0:
            self.have_image = True
        return Result(self.pull_code, '', 'pull access denied' if self.pull_code else '', 0.0)

    def sh(self, name, script, timeout, workdir='/testbed', env=None):
        if 'llmar_netcheck.py' in script:
            self.scripts.append((script, env))
            return self.script_result
        return super().sh(name, script, timeout, workdir, env)


def test_net_check_runs_the_probe_with_run_path_and_venv_links():
    fd = NetDocker()
    res = protocol.net_check(_env(fd), 'img', '172.18.0.1', 8088, 'print(1)')
    assert res['proxy'] == '404' and res['image'] == {'image': 'img', 'pulled': False, 'arch': 'amd64'}
    script, env = fd.scripts[0]
    assert env['PATH'].startswith('/root/.venv/bin') and 'python3' in script and '172.18.0.1 8088' in script
    assert fd.files and fd.removed == [n for n, _ in fd.started]


def test_net_check_reports_the_failing_step_with_output():
    fd = NetDocker(script_result=Result(127, '', 'sh: 1: python: not found', 0.1))
    with pytest.raises(protocol.StepFailed) as e:
        protocol.net_check(_env(fd), 'img', '172.18.0.1', 8088, 'x')
    assert e.value.step == 'net-check script' and e.value.code == 127 and 'not found' in e.value.stderr_tail
    assert fd.removed                                                  # container removed on failure
    with pytest.raises(protocol.StepFailed) as e:
        protocol.net_check(_env(NetDocker(script_result=Result(0, 'warning only\n', '', 0.1))), 'img', '172.18.0.1', 8088, 'x')
    assert 'no JSON' in e.value.step and 'warning only' in e.value.stdout_tail
    with pytest.raises(protocol.StepFailed) as e:
        protocol.net_check(_env(NetDocker(start_code=125)), 'img', '172.18.0.1', 8088, 'x')
    assert e.value.step.startswith('docker run') and 'boom' in e.value.stderr_tail


def test_missing_image_is_pulled_and_pull_failures_surface(tmp_path):
    fd = NetDocker(have_image=False)
    assert protocol.net_check(_env(fd), 'img', '172.18.0.1', 8088, 'x')['image']['pulled'] and fd.pulls == 1
    with pytest.raises(protocol.StepFailed) as e:
        protocol.net_check(_env(NetDocker(have_image=False, pull_code=1)), 'img', '172.18.0.1', 8088, 'x')
    assert 'pull access denied' in e.value.stderr_tail
    rec = protocol.validate(_env(NetDocker(have_image=False, pull_code=1)), _task(), tmp_path)
    assert not rec['verdict']['ok'] and rec['verdict']['reasons'] == ['image-unavailable']


def test_agent_start_failure_is_a_harness_error_with_output(tmp_path):
    out = protocol.run_agent(_env(NetDocker(start_code=125)), protocol.RunSpec('r-9', 'pilot', 'A', _task(), 'standard'),
                             'http://x/r/r-9/v1', pathlib.Path('/bin/true'), tmp_path / 'run')
    assert out['exit_reason'] == 'harness-error' and 'docker run (agent container) failed: exit 125' in out['error'] and 'boom' in out['error']
