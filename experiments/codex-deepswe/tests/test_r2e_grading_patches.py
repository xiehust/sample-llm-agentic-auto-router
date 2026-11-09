import json

import grading
import patches
import r2e

# A synthetic pytest -rA log in the shape R2E-Gym's parser reads (no dataset text).
LOG = """============================= test session starts ==============================
collected 4 items

r2e_tests/test_1.py ..F.                                                 [100%]
=========================== short test summary info ============================
PASSED r2e_tests/test_1.py::test_alpha
PASSED r2e_tests/test_1.py::TestKlass::test_beta
FAILED r2e_tests/test_1.py::test_gamma - AssertionError: boom
ERROR r2e_tests/test_1.py::test_delta - ImportError
========================= 1 failed, 2 passed in 0.10s =========================="""


def test_parse_log_pytest_matches_r2e_gym():
    assert r2e.parse_log_pytest(LOG) == {
        'test_alpha': 'PASSED', 'TestKlass.test_beta': 'PASSED', 'test_gamma': 'FAILED', 'test_delta': 'ERROR'}
    assert r2e.parse_log_pytest('no summary here') == {}
    assert r2e.parse_log_pytest(None) == {}


def test_reward_strict_rules():
    parsed = r2e.parse_log_pytest(LOG)
    exp = {'test_alpha': 'PASSED', 'TestKlass.test_beta': 'PASSED', 'test_gamma': 'FAILED', 'test_delta': 'ERROR'}
    assert r2e.r2e_reward(parsed, json.dumps(exp)) == 1.0
    assert r2e.r2e_reward(parsed, json.dumps({**exp, 'test_gamma': 'PASSED'})) == 0.0
    assert r2e.r2e_reward(parsed, json.dumps({**exp, 'test_extra': 'PASSED'})) == 0.0     # count differs
    # keys are normalised with split(' - ')[0] and ANSI colour codes are removed
    assert r2e.r2e_reward({'\u001b[32mtest_x - msg': 'PASSED'}, json.dumps({'test_x': 'PASSED'})) == 1.0


def test_exec_result_and_clean():
    assert r2e.exec_result('x', 124, 600) == ('The command took too long to execute (>600s)', '-1')
    assert r2e.exec_result('out', 1, 600) == ('out', 'Error: Exit code 1')
    assert r2e.exec_result('\x1b[31mred\x1b[0m\r', 0, 600) == ('red', '0')


def test_task_instruction():
    assert r2e.task_instruction('pre [ISSUE]\nthe bug\n[/ISSUE] post') == '\nthe bug\n'
    assert r2e.task_instruction('plain text') == 'plain text'


def test_setup_and_hide_commands():
    setup = r2e.setup_env_commands()
    assert setup[-2:] == ['mv /r2e_tests /root/r2e_tests', 'ln -s /root/r2e_tests /testbed/r2e_tests']
    assert 'mv /testbed/run_tests.sh /root/run_tests.sh' in setup
    hide = r2e.agent_hide_commands()
    assert not any(c.startswith('mv /r2e_tests') or c.startswith('ln -s /root/r2e_tests') for c in hide)
    assert 'rm -rf /r2e_tests' in hide and 'rm -rf /testbed/run_tests.sh' in hide
    assert r2e.wrap(r2e.run_tests_command(), 600) == 'timeout 600 bash /root/run_tests.sh'


def _commit(paths):
    def fd(p):
        return {'header': {'file': {'path': p}}, 'index_line': {'old_commit_hash': 'aaa', 'new_commit_hash': 'bbb', 'mode': '100644'},
                'minus_file': {'path': f'a/{p}'}, 'plus_file': {'path': f'b/{p}'},
                'hunks': [{'descriptor': {'old_range': {'start': 1, 'length': 2}, 'new_range': {'start': 1, 'length': 2}, 'section': 'def f():'},
                           'line_group': {'all_lines': [{'content': 'x = 1', 'type': 'context'}, {'content': 'y = 1', 'type': 'deleted'},
                                                        {'content': 'y = 2', 'type': 'added'}]}}],
                'old_file_content': '', 'new_file_content': ''}
    return json.dumps({'file_diffs': [fd(p) for p in paths], 'old_commit_hash': 'a', 'new_commit_hash': 'b'})


def test_gold_patch_matches_parsed_commit_get_patch():
    c = _commit(['pkg/mod.py', 'pkg/tests/test_mod.py', 'README.rst'])
    patch = r2e.gold_patch(c)
    assert 'diff --git a/pkg/mod.py b/pkg/mod.py\nindex aaa..bbb 100644\n--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1,2 +1,2 @@ def f():\n x = 1\n-y = 1\n+y = 2\n' in patch
    assert 'pkg/tests/test_mod.py' in patch          # test files included by default (only_python)
    assert 'README.rst' not in patch                 # only python files
    assert r2e.gold_patch(c, test_file=False).count('diff --git') == 1
    assert r2e.gold_non_test_files(c) == ['pkg/mod.py', 'README.rst']


def test_is_test_file():
    for p in ('a/tests/x.py', 'test_x.py', 'a/test_x.py', 'x_test.py', 'a/test/x.py', 'Tests/x.py'):
        assert r2e.is_test_file(p), p
    for p in ('a/x.py', 'testing/x.py', 'a/contest.py'):
        assert not r2e.is_test_file(p), p


# ---------------------------------------------------------------- grading (D4)

def test_derive_spec_and_grade():
    base = [{'t1': 'FAILED', 't2': 'PASSED', 't3': 'FAILED'}] * 3
    gold = [{'t1': 'PASSED', 't2': 'PASSED', 't3': 'FAILED', 't4': 'PASSED'}] * 3
    spec = grading.derive_spec(base, gold)
    assert spec['stable'] and spec['f2p'] == ['t1', 't4'] and spec['p2p'] == ['t2'] and spec['fail_both'] == ['t3']
    assert grading.grade_swebench({'t1': 'PASSED', 't2': 'PASSED', 't4': 'PASSED'}, spec)['resolved']
    assert not grading.grade_swebench({'t1': 'PASSED', 't2': 'FAILED', 't4': 'PASSED'}, spec)['resolved']   # P2P broke
    assert not grading.grade_swebench({'t1': 'PASSED', 't2': 'PASSED'}, spec)['resolved']                   # F2P missing
    assert grading.grade_swebench({'t1': 'PASSED', 't2': 'PASSED', 't4': 'PASSED', 't3': 'FAILED'}, spec)['resolved']


def test_unstable_and_verdict():
    base = [{'t1': 'FAILED', 't2': 'PASSED'}, {'t1': 'FAILED', 't2': 'FAILED'}, {'t1': 'FAILED', 't2': 'PASSED'}]
    gold = [{'t1': 'PASSED', 't2': 'PASSED'}] * 3
    spec = grading.derive_spec(base, gold)
    assert not spec['stable'] and spec['unstable_base'] == ['t2']
    v = grading.validation_verdict(spec, [False] * 3, [True] * 3, [10.0] * 6)
    assert not v['ok'] and v['reasons'] == ['unstable']
    ok = grading.validation_verdict(grading.derive_spec([{'t1': 'FAILED'}] * 3, [{'t1': 'PASSED'}] * 3), [False] * 3, [True] * 3, [5.0])
    assert ok['ok']
    slow = grading.validation_verdict(grading.derive_spec([{'t1': 'FAILED'}] * 3, [{'t1': 'PASSED'}] * 3), [True, False, False], [True, True, False], [700.0])
    assert set(slow['reasons']) == {'base-passes-strict', 'gold-fails-strict', 'slow'}


# ---------------------------------------------------------------- patches (D12)

DIFF = """diff --git a/pkg/mod.py b/pkg/mod.py
index 1..2 100644
--- a/pkg/mod.py
+++ b/pkg/mod.py
@@ -1 +1 @@
-a
+b
diff --git a/pkg/tests/test_mod.py b/pkg/tests/test_mod.py
new file mode 100644
--- /dev/null
+++ b/pkg/tests/test_mod.py
@@ -0,0 +1 @@
+x
diff --git a/pkg/__pycache__/mod.cpython-38.pyc b/pkg/__pycache__/mod.cpython-38.pyc
Binary files a/pkg/__pycache__/mod.cpython-38.pyc and b/pkg/__pycache__/mod.cpython-38.pyc differ
diff --git a/build/lib/x.so b/build/lib/x.so
Binary files differ
diff --git a/run_tests.sh b/run_tests.sh
deleted file mode 100644
diff --git a/pkg/_ext.pyx b/pkg/_ext.pyx
--- a/pkg/_ext.pyx
+++ b/pkg/_ext.pyx
@@ -1 +1 @@
-c
+d
diff --git a/scratch.png b/scratch.png
new file mode 100644
Binary files /dev/null and b/scratch.png differ
"""


def test_filter_patch():
    kept, dropped = patches.filter_patch(DIFF)
    assert [p for p, _ in patches.split(kept)] == ['pkg/mod.py', 'pkg/_ext.pyx']
    assert {d['path']: d['why'] for d in dropped} == {
        'pkg/tests/test_mod.py': 'test-file', 'pkg/__pycache__/mod.cpython-38.pyc': 'artefact', 'build/lib/x.so': 'artefact',
        'run_tests.sh': 'hidden-test-path', 'scratch.png': 'binary'}
    st = patches.stats(kept)
    assert (st['files'], st['added'], st['removed']) == (2, 2, 2)
    assert patches.touches_c_ext(kept) and not patches.touches_c_ext(patches.split(kept)[0][1])
