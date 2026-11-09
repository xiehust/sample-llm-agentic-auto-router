"""R2E-Gym conventions, copied from the R2E-Gym harness (Apache-2.0) at the commit pinned in common.R2E_GYM.

Sources (paths in that repository):
- src/r2egym/agenthub/runtime/docker.py: DockerRuntime.setup_env (r2e branch), run(), run_tests(), get_patch(),
  apply_patch(), _calculate_reward_r2e(), get_task_instruction()
- src/r2egym/agenthub/__init__.py: SKIP_FILES_NEW, CMD_TIMEOUT
- src/r2egym/repo_analysis/execution_log_parser.py: parse_log_pytest(), decolor_dict_keys()
- src/r2egym/commit_models/diff_classes.py: FileDiff.is_test_file, FileDiff.get_patch(), ParsedCommit.get_patch()
- src/r2egym/repo_analysis/validate_docker_and_hf.py: validate_docker() (base fails, gold passes)

Deliberate deviations, all because the agent here (Codex) has a full shell instead of R2E-Gym's restricted tools:
- R2E-Gym moves the hidden tests to /root and links them back into /testbed for its own agent. Here the agent's
  container gets the tests deleted (agent_hide_commands), and grading always runs in a fresh container that gets
  R2E-Gym's own setup_env unchanged.
- Grading runs base and gold 3x each in validation (design D4), not once.
"""
from __future__ import annotations

import json
import re
from typing import Any

REPO_PATH = '/testbed'
ALT_PATH = '/root'      # "used for keeping useful scripts to be hidden from the agent"
DOCKER_PATH = '/root/.venv/bin:/root/.local/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
SKIP_FILES_NEW = ['run_tests.sh', 'r2e_tests']
# Legacy SKIP_FILES (older images): answer-bearing files hidden from the agent as well (review G1a).
SKIP_FILES = ['run_tests.sh', 'syn_issue.json', 'expected_test_output.json', 'execution_result.json',
              'parsed_commit.json', 'modified_files.json', 'modified_entities.json', 'r2e_tests']
CMD_TIMEOUT = 120       # seconds, R2E-Gym's default per command
TEST_TIMEOUT = 300      # run_tests(timeout=300)

_ANSI = re.compile(r'\x1b\[[0-9;]*m|\r')


def setup_env_commands(repo_path: str = REPO_PATH, alt_path: str = ALT_PATH) -> list[str]:
    """DockerRuntime.setup_env for R2E-Gym images, command for command (each runs via `/bin/sh -c`, workdir
    repo_path, PATH=DOCKER_PATH; R2E-Gym ignores their exit codes, and so do we, but we record them)."""
    cmds = [
        f'ln -s {repo_path}/.venv {alt_path}/.venv',
        f'ln -s {repo_path}/.venv/bin/python {alt_path}/.local/bin/python',
        f'ln -s {repo_path}/.venv/bin/python {alt_path}/.local/bin/python3',
        f'find {repo_path}/.venv/bin -type f -executable -exec ln -sf {{}} {alt_path}/.local/bin/ \\;',
        'uv pip install chardet',
        "find . -name '*.pyc' -delete",
        "find . -name '__pycache__' -exec rm -rf {} +",
        "find /r2e_tests -name '*.pyc' -delete",
        "find /r2e_tests -name '__pycache__' -exec rm -rf {} +",
    ]
    cmds += [f'mv {repo_path}/{f} {alt_path}/{f}' for f in SKIP_FILES_NEW]
    cmds += [f'mv /r2e_tests {alt_path}/r2e_tests', f'ln -s {alt_path}/r2e_tests {repo_path}/r2e_tests']
    return cmds


def agent_hide_commands(repo_path: str = REPO_PATH, alt_path: str = ALT_PATH) -> list[str]:
    """The agent container: R2E-Gym's venv links and cleanup, but the hidden tests and the test runner are deleted
    (not moved to /root: Codex can read /root). Grading never uses this container."""
    cmds = setup_env_commands(repo_path, alt_path)[:9]
    for d in (repo_path, alt_path, ''):
        cmds += [f'rm -rf {d}/{f}' for f in SKIP_FILES]
    return cmds


def hidden_paths(repo_path: str = REPO_PATH, alt_path: str = ALT_PATH) -> list[str]:
    """Paths that must not exist in the agent container after agent_hide_commands (checked before Codex starts)."""
    return [f'{d}/{f}' for d in (repo_path, alt_path, '') for f in SKIP_FILES]


def wrap(code: str, timeout: int = CMD_TIMEOUT) -> str:
    """run() executes every command as `/bin/sh -c "timeout {timeout} {code}"` (workdir repo_path, PATH=DOCKER_PATH)."""
    return f'timeout {timeout} {code}'


def run_tests_command(alt_path: str = ALT_PATH) -> str:
    """run_tests(): `bash {alt_path}/run_tests.sh` (wrapped with the test timeout)."""
    return f'bash {alt_path}/run_tests.sh'


def apply_patch_command(patch_path: str) -> str:
    """apply_patch(): `git apply --whitespace=fix <patch>`."""
    return f'git apply --whitespace=fix {patch_path}'


def exec_result(output: str, exit_code: int, timeout: int) -> tuple[str, str]:
    """DockerRuntime.run's (output, error_code) convention: 124 → timeout message and '-1'; non-zero → the raw
    output and 'Error: Exit code N'; zero → ANSI-stripped output and '0'. run_tests() strips ANSI again."""
    if exit_code == 124:
        return f'The command took too long to execute (>{timeout}s)', '-1'
    if exit_code != 0:
        return output, f'Error: Exit code {exit_code}'
    return clean(output), str(exit_code)


def clean(output: str) -> str:
    return _ANSI.sub('', output)


def parse_log_pytest(log: str | None) -> dict[str, str]:
    """execution_log_parser.parse_log_pytest, verbatim (every R2E-Gym repo uses this parser)."""
    if log is None:
        return {}
    test_status_map: dict[str, str] = {}
    if 'short test summary info' not in log:
        return test_status_map
    log = log.split('short test summary info')[1]
    log = log.strip()
    lines = log.split('\n')
    for line in lines:
        if 'PASSED' in line:
            test_name = '.'.join(line.split('::')[1:])
            test_status_map[test_name] = 'PASSED'
        elif 'FAILED' in line:
            test_name = '.'.join(line.split('::')[1:]).split(' - ')[0]
            test_status_map[test_name] = 'FAILED'
        elif 'ERROR' in line:
            try:
                test_name = '.'.join(line.split('::')[1:])
            except IndexError:
                test_name = line
            test_name = test_name.split(' - ')[0]
            test_status_map[test_name] = 'ERROR'
    return test_status_map


def decolor_dict_keys(d: dict[str, Any]) -> dict[str, Any]:
    return {re.sub(r'\u001b\[\d+m', '', k): v for k, v in d.items()}


def normalize(parse: dict[str, str]) -> dict[str, str]:
    """_calculate_reward_r2e's key normalization: decolor, then `k.split(' - ')[0]` over sorted keys."""
    p = decolor_dict_keys(parse)
    return {k.split(' - ')[0]: p[k] for k in sorted(p.keys())}


def r2e_reward(parse: dict[str, str], expected_json: str) -> float:
    """_calculate_reward_r2e's comparison, verbatim: same number of tests, and every parsed status equals the
    expected one (empty keys skipped)."""
    parse = normalize(parse)
    expected = normalize(json.loads(expected_json))
    if len(parse) != len(expected):
        return 0.0
    for k in parse.keys():
        if not k:
            continue
        if k not in expected:
            return 0.0
        if parse[k] != expected[k]:
            return 0.0
    return 1.0


def task_instruction(problem_statement: str) -> str:
    """get_task_instruction: the text inside [ISSUE]...[/ISSUE], else the whole problem statement."""
    m = re.search(r'\[ISSUE\](.*)\[/ISSUE\]', problem_statement, re.DOTALL)
    return m.group(1) if m else problem_statement


# ---------------------------------------------------------------- ParsedCommit (gold patch)

def is_test_file(path: str) -> bool:
    """FileDiff.is_test_file."""
    parts = path.split('/')
    return (path.endswith('_test.py') or path.startswith('test_') or parts[-1].startswith('test_')
            or 'tests' in parts or 'Tests' in parts or 'test' in parts or 'Test' in parts)


def _range(r: dict[str, Any]) -> str:
    return f"{r['start']}" if r.get('length') is None else f"{r['start']},{r['length']}"


def _file_diff_patch(fd: dict[str, Any]) -> str:
    """FileDiff.get_patch (header, index line, binary line, ---/+++ lines, hunks)."""
    header = fd['header']
    patch = f"diff --git a/{header['file']['path']} b/{header['file']['path']}\n"
    if header.get('misc_line'):
        patch += header['misc_line'] + '\n'
    il = fd.get('index_line')
    if il:
        patch += f"index {il['old_commit_hash']}..{il['new_commit_hash']}{' ' if il.get('mode') else ''}{il.get('mode') or ''}\n"
    if fd.get('is_binary_file'):
        patch += (fd.get('binary_line') or '') + '\n'
    if fd.get('minus_file') and fd.get('plus_file'):
        patch += f"--- {fd['minus_file']['path']}\n"
        patch += f"+++ {fd['plus_file']['path']}\n"
    for hunk in fd.get('hunks') or []:
        d = hunk['descriptor']
        content = f"@@ -{_range(d['old_range'])} +{_range(d['new_range'])} @@"
        if d.get('section'):
            content += f" {d['section']}"
        patch += content + '\n'
        for line in hunk['line_group']['all_lines']:
            t = line['type']
            if t == 'context':
                patch += f" {line['content']}\n"
            elif t == 'added':
                patch += f"+{line['content']}\n"
            elif t == 'deleted':
                patch += f"-{line['content']}\n"
            elif t == 'note':
                patch += f"\\ {line['content']}\n"
    return patch


def gold_patch(parsed_commit_json: str, test_file: bool = True, non_test_file: bool = True, only_python: bool = True) -> str:
    """ParsedCommit.get_patch() with its defaults (python files only, test and non-test), as validate_docker uses."""
    commit = json.loads(parsed_commit_json)
    patch = ''
    for fd in commit['file_diffs']:
        path = fd['header']['file']['path']
        if only_python and not path.endswith('.py'):
            continue
        test = is_test_file(path)
        if (test and test_file) or (not test and non_test_file):
            patch += _file_diff_patch(fd)
    return patch


def gold_non_test_files(parsed_commit_json: str) -> list[str]:
    return [fd['header']['file']['path'] for fd in json.loads(parsed_commit_json)['file_diffs']
            if not is_test_file(fd['header']['file']['path'])]
