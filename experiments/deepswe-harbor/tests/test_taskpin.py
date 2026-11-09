"""taskpin: the TB 2.1 pin (manifest, content digests, image digests), the online-network check and task facts, on a
synthetic checkout with fake git/docker/registry. No network, no Docker."""
import io
import json
import subprocess

import pytest

pytest.importorskip('harbor')

import taskpin as tp  # noqa: E402

DIG = 'ab' * 32


def _task(root, tid, image='alexgshaw/x:20251031', **md):
    d = root / 'tasks' / tid
    (d / 'tests').mkdir(parents=True)
    (d / 'solution').mkdir()
    (d / 'environment').mkdir()
    meta = {'difficulty': 'medium', 'category': 'software-engineering', 'expert_time_estimate_min': 60.0, **md}
    (d / 'task.toml').write_text('[metadata]\n' + ''.join(f'{k} = {json.dumps(v)}\n' for k, v in meta.items())
                                 + '[agent]\ntimeout_sec = 900.0\n[verifier]\ntimeout_sec = 600.0\n'
                                 + f'[environment]\ndocker_image = "{image}"\ncpus = 1\nmemory_mb = 2048\nallow_internet = true\n'
                                 + 'description = "not copied"\n')
    (d / 'instruction.md').write_text(f'synthetic instruction {tid}\n')
    (d / 'tests' / 'test.sh').write_text('#!/bin/sh\necho 1 > /logs/verifier/reward.txt\n')
    (d / 'solution' / 'solve.sh').write_text('#!/bin/sh\ntrue\n')
    (d / 'environment' / 'Dockerfile').write_text('FROM scratch\n')
    return d


def _checkout(tmp_path, ids=('a-task', 'b-task')):
    root = tmp_path / 'tb'
    for t in ids:
        _task(root, t)
    lines = ['[dataset]\nname = "terminal-bench/terminal-bench-2-1"\n']
    for t in ids:
        lines.append(f'\n[[tasks]]\nname = "terminal-bench/{t}"\ndigest = "sha256:{tp.content_digest(root / "tasks" / t)}"\n')
    (root / 'tasks' / 'dataset.toml').write_text(''.join(lines))
    return root


def _plan(root, ids=('a-task', 'b-task')):
    return {'tasks': tp.plan_pins(root, ids, lambda image: (DIG, 1234))}


def test_digest_roundtrip_and_no_12_digit_runs():
    b = tp.hex_to_b64('sha256:' + DIG)
    assert tp.b64_to_hex(b) == DIG and len(b) == 43
    with pytest.raises(ValueError):
        tp.hex_to_b64('12' * 10)


def test_verify_passes_and_catches_edits_and_set_changes(tmp_path):
    root = _checkout(tmp_path)
    plan = _plan(root)
    assert plan['tasks']['a-task']['image_bytes'] == 1234 and set(plan['tasks']['a-task']) == {'digest_b64', 'image', 'image_digest_b64', 'image_bytes'}
    assert tp.verify(plan, root, ['a-task', 'b-task']) == []
    (root / 'tasks' / 'a-task' / 'tests' / 'test.sh').write_text('#!/bin/sh\necho 1\n')       # a changed test file
    issues = tp.verify(plan, root, ['a-task', 'b-task'])
    assert issues == ['a-task: content digest differs from the plan', 'a-task: content digest differs from the manifest']
    _task(root, 'c-task')                                                                  # an extra dir
    assert any(i.startswith('task set: task dirs') for i in tp.verify(plan, root, ['b-task']))
    plan['tasks']['z-task'] = {}
    assert any(i.startswith('task set: plan') for i in tp.verify(plan, root, ['b-task']))


def test_plan_pins_refuses_a_checkout_that_disagrees_with_its_manifest(tmp_path):
    root = _checkout(tmp_path)
    (root / 'tasks' / 'b-task' / 'instruction.md').write_text('changed\n')
    with pytest.raises(ValueError):
        _plan(root)


def test_fetch_runs_the_pinned_git_sequence_and_checks_head(tmp_path):
    calls = []
    commit = 'c' * 40

    def run(argv, head=commit):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=head + '\n' if argv[-1] == 'HEAD' else '', stderr='')
    assert tp.fetch(tmp_path / 'tb', 'https://github.com/harbor-framework/terminal-bench-2-1', commit, run) == commit
    assert [c[1] if c[1] != '-C' else c[3] for c in calls] == ['clone', 'fetch', 'checkout', 'rev-parse']
    with pytest.raises(SystemExit):
        tp.fetch(tmp_path / 'tb', 'https://x.example/r', commit, lambda a: run(a, head='d' * 40))
    for bad in ('c' * 12, 'C' * 40):
        with pytest.raises(ValueError):
            tp.fetch(tmp_path, 'https://x.example/r', bad, run)
    with pytest.raises(ValueError):
        tp.fetch(tmp_path, 'git@github.com:x/y', commit, run)


def test_images_pull_by_digest_and_check_repodigests(tmp_path):
    root = _checkout(tmp_path)
    plan = _plan(root)
    ref, tag = tp.image_pull_args(plan['tasks']['a-task'])
    assert ref == f'alexgshaw/x@sha256:{DIG}' and tag == 'alexgshaw/x:20251031'
    seen = []

    def run(argv, digests=(ref,), rc=0):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, rc, stdout=json.dumps(list(digests)), stderr='')
    assert tp.check_images(plan, ['a-task'], run) == [] and seen[0][:3] == ['docker', 'image', 'inspect']
    assert tp.check_images(plan, ['a-task'], lambda a: run(a, digests=('alexgshaw/x@sha256:' + 'cd' * 32,))) == ['a-task: local image is not the pinned digest']
    assert tp.check_images(plan, ['a-task'], lambda a: run(a, rc=1)) == ['a-task: image not present']
    for bad in ('x:1', 'alexgshaw/x', 'alexgshaw/x@sha256:' + DIG):
        with pytest.raises(ValueError):
            tp.split_image(bad)


def _inspect(**over):
    d = {'Name': 'llmar-online', 'Id': 'n1', 'Driver': 'bridge', 'EnableIPv6': False, 'Internal': False,
         'IPAM': {'Config': [{'Subnet': '10.201.0.0/24', 'Gateway': '10.201.0.1'}]},
         'Options': {'com.docker.network.bridge.name': 'br-llmon', 'com.docker.network.bridge.enable_icc': 'false',
                     'com.docker.network.bridge.enable_ip_masquerade': 'true'}}
    for k, v in over.items():
        if k.startswith('opt_'):
            d['Options'][k[4:].replace('_', '.')] = v
        else:
            d[k] = v
    return d


def test_online_network_check_only_inspects_and_names_the_difference():
    argvs = []

    def run_with(doc, rc=0):
        def run(argv):
            argvs.append(argv)
            return subprocess.CompletedProcess(argv, rc, stdout=json.dumps([doc]), stderr='')
        return run
    got = tp.check_online_network(run_with(_inspect()))
    assert got['bridge'] == 'br-llmon' and got['id'] == 'n1'
    bad = {'icc': _inspect(Options={'com.docker.network.bridge.name': 'br-llmon', 'com.docker.network.bridge.enable_icc': 'true'}),
           'ipv6': _inspect(EnableIPv6=True), 'internal': _inspect(Internal=True), 'driver': _inspect(Driver='macvlan'),
           'subnet': _inspect(IPAM={'Config': [{'Subnet': '10.200.3.0/24'}]}),
           'bridge': _inspect(Options={'com.docker.network.bridge.enable_icc': 'false'})}
    for field, doc in bad.items():
        with pytest.raises(tp.NetworkMismatch, match=field):
            tp.check_online_network(run_with(doc))
    with pytest.raises(tp.NetworkMismatch, match='missing'):
        tp.check_online_network(run_with({}, rc=1))
    assert all(a[:3] == ['docker', 'network', 'inspect'] for a in argvs)       # never create or rm


def test_task_facts_are_labels_and_numbers_only(tmp_path):
    d = _task(tmp_path, 'f-task', category='data-science', difficulty='hard')
    f = tp.task_facts(d)
    assert f == {'category': 'data-science', 'difficulty': 'hard', 'expert_min': 60.0, 'junior_min': None, 'agent_timeout_s': 900.0,
                 'verifier_timeout_s': 600.0, 'cpus': 1.0, 'memory_mb': 2048.0}
    assert 'not copied' not in json.dumps(f)
    assert tp.task_facts(_task(tmp_path, 'g-task', category='Some free text!'))['category'] is None


def test_registry_digest_picks_amd64_from_an_index():
    index = {'manifests': [{'digest': 'sha256:' + '11' * 32, 'platform': {'os': 'linux', 'architecture': 'arm64'}},
                           {'digest': 'sha256:' + '22' * 32, 'platform': {'os': 'linux', 'architecture': 'amd64'}}]}
    amd = {'config': {'size': 10}, 'layers': [{'size': 100}, {'size': 5}]}
    asked = []

    class Resp(io.BytesIO):
        def __init__(self, doc, digest=''):
            super().__init__(json.dumps(doc).encode())
            self.headers = {'Docker-Content-Digest': digest}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def opener(req, timeout):
        url = req if isinstance(req, str) else req.full_url
        asked.append(url)
        if 'auth.docker.io' in url:
            assert 'scope=repository:alexgshaw/x:pull' in url
            return Resp({'token': 't'})
        return Resp(index, 'sha256:' + DIG) if url.endswith(':20251031') or url.endswith('/20251031') else Resp(amd, 'sha256:' + '22' * 32)
    assert tp.registry_digest('alexgshaw/x:20251031', opener=opener) == (DIG, 115)
    assert asked[1].endswith('/v2/alexgshaw/x/manifests/20251031') and asked[2].endswith('sha256:' + '22' * 32)


def test_digests_via_harbors_own_python_when_harbor_is_not_importable(tmp_path, monkeypatch):
    root = _checkout(tmp_path)
    plan = _plan(root)
    real = {t: tp.content_digest(root / 'tasks' / t) for t in ('a-task', 'b-task')}
    seen = []

    def run(argv):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({a: real[a.rsplit('/', 1)[1]] for a in argv[4:]}) + '\n', stderr='')
    monkeypatch.setenv('HARBOR_PYTHON', '/opt/uv/tools/harbor/bin/python')
    assert tp.verify(plan, root, ['a-task', 'b-task'], run=run) == []
    assert seen[0][:3] == ['/opt/uv/tools/harbor/bin/python', '-I', '-c'] and len(seen) == 1      # one batched call
    with pytest.raises(RuntimeError):
        tp.verify(plan, root, ['a-task'], run=lambda a: subprocess.CompletedProcess(a, 1, stdout='', stderr='x'))
    with pytest.raises(RuntimeError):     # an incomplete answer is never taken as a pass
        tp.verify(plan, root, ['a-task', 'b-task'], run=lambda a: subprocess.CompletedProcess(a, 0, stdout=json.dumps({a[4]: DIG}), stderr=''))


def test_harbor_python_from_the_tool_shebang(tmp_path, monkeypatch):
    py = tmp_path / 'venv' / 'bin' / 'python'
    py.parent.mkdir(parents=True)
    py.write_text('')
    exe = tmp_path / 'harbor'
    exe.write_text(f'#!{py}\nimport sys\n')
    monkeypatch.delenv('HARBOR_PYTHON', raising=False)
    monkeypatch.setenv('HARBOR_BIN', str(exe))
    assert tp.harbor_python() == str(py)
    exe.write_text('#!/nonexistent/python\n')
    assert tp.harbor_python() is None
