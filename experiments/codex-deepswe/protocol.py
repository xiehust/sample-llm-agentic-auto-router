"""Per-task protocols on the runner (design §5 as revised by D4, D5, D9–D13): gold validation, agent run, grading.

Every container is fresh, on the experiment network, with the same limits. R2E-Gym's command conventions come from
r2e.py; the deviations (deleting hidden tests in the agent container, grading in a fresh one, 3x validation) are
documented there.
"""
from __future__ import annotations

import dataclasses
import json
import pathlib
import time
from typing import Any

import codex_setup
import events
import grading
import patches
import r2e
from common import ARM_PIN, mask, now_iso, write_json
from dataset import Task
from docker_ops import Docker, Limits, Result

PATCH_IN_CTR = '/tmp/llmar.patch'   # nosec B108 - a path inside the task container
GIT_TIMEOUT = 600
# A throwaway index: a copy of the repository's index (or empty), removed on exit.
TEMP_INDEX_SCRIPT = ('set -e; export GIT_INDEX_FILE=$(mktemp /tmp/.llmar-index.XXXXXX); trap \'rm -f "$GIT_INDEX_FILE"\' EXIT; '
                     'cp .git/index "$GIT_INDEX_FILE" 2>/dev/null || rm -f "$GIT_INDEX_FILE"; git add -A; ')


def _q(s: str) -> str:
    import shlex
    return shlex.quote(s)
REBUILD_TIMEOUT = 1800
VALIDATION_REPEATS = 3


@dataclasses.dataclass
class Env:
    docker: Docker
    network: str
    limits: Limits
    test_timeout: int = 600      # design §4: a test run longer than 10 minutes drops the task


class StepFailed(RuntimeError):
    """A docker step that failed, with its exit code and the tails of its output (task containers hold no secrets;
    12-digit numbers are masked anyway)."""

    def __init__(self, step: str, r: Result):
        self.step, self.code = step, r.code
        self.stdout_tail = mask(r.out[-600:].strip())
        self.stderr_tail = mask(r.err[-600:].strip())
        super().__init__(f'{step} failed: exit {r.code}; stderr: {self.stderr_tail or "-"}; stdout: {self.stdout_tail or "-"}')


def checked(r: Result, step: str) -> Result:
    if r.code != 0:
        raise StepFailed(step, r)
    return r


def ensure_image(env: Env, image: str) -> dict[str, Any]:
    """Pulls the task image only when it is not present locally, and checks it is amd64."""
    arch = env.docker.image_arch(image)
    pulled = False
    if arch is None:
        checked(env.docker.pull(image), f'docker pull {image}')
        pulled = True
        arch = env.docker.image_arch(image)
    if arch != 'amd64':
        raise RuntimeError(f'{image}: image architecture is {arch!r}, expected amd64')
    return {'image': image, 'pulled': pulled, 'arch': arch}


# The interpreter for harness-side helper scripts in a task container: the repo venv's python after R2E-Gym's links,
# else python3 (task images are Ubuntu with a venv; neither name is guaranteed on its own).
PYTHON = 'if command -v python >/dev/null 2>&1; then exec python "$@"; else exec python3 "$@"; fi'


def net_check(env: Env, image: str, gateway_ip: str, port: int, script: str) -> dict[str, Any]:
    """Runs `script` (the in-container probe) in a fresh task container on the experiment network, with the same
    venv links and PATH as the runs. Every docker step is checked; a failure raises StepFailed with its output."""
    info = ensure_image(env, image)
    name = _ctr('netcheck', 'probe')
    try:
        s = env.docker.start(image, name, env.network, env.limits, 'netcheck')
        checked(s, 'docker run (net-check container)')
        _setup(env, name, r2e.setup_env_commands()[:4])     # /root/.venv -> /testbed/.venv, as in every run
        checked(env.docker.write_file(name, '/tmp/llmar_netcheck.py', script.encode()), 'write net-check script')
        r = env.docker.sh(name, f"sh -c {_q(PYTHON)} sh /tmp/llmar_netcheck.py {gateway_ip} {port}", 60, env={'PATH': r2e.DOCKER_PATH})
        checked(r, 'net-check script')
        lines = [x for x in r.out.strip().splitlines() if x.strip().startswith('{')]
        if not lines:
            raise StepFailed('net-check script (no JSON on stdout)', r)
        return {**json.loads(lines[-1]), 'image': info}
    finally:
        env.docker.rm(name)


def _ctr(prefix: str, label: str) -> str:
    return f'llmar-{prefix}-{label}-{int(time.time() * 1000) % 10**9}'


def _setup(env: Env, name: str, commands: list[str]) -> list[dict[str, Any]]:
    out = []
    for c in commands:
        r = env.docker.sh(name, r2e.wrap(c), r2e.CMD_TIMEOUT, env={'PATH': r2e.DOCKER_PATH})
        out.append({'cmd': c.split(' ', 1)[0], 'code': r.code})
    return out


def _run_tests(env: Env, name: str) -> dict[str, Any]:
    t0 = time.time()
    r = env.docker.sh(name, r2e.wrap(r2e.run_tests_command(), env.test_timeout), env.test_timeout, env={'PATH': r2e.DOCKER_PATH})
    out, code = r2e.exec_result(r.out + r.err, r.code, env.test_timeout)   # exec_run(stdout=True, stderr=True): both streams
    return {'statuses': grading.statuses(out), 'code': code, 'secs': round(time.time() - t0, 1),
            'timed_out': r.code == 124, 'output_tail': r2e.clean(out)[-4000:]}


def _apply(env: Env, name: str, patch: str) -> dict[str, Any]:
    w = env.docker.write_file(name, PATCH_IN_CTR, patch.encode())
    if w.code != 0:
        return {'ok': False, 'stage': 'write', 'code': w.code}
    r = env.docker.sh(name, r2e.wrap(r2e.apply_patch_command(PATCH_IN_CTR)), r2e.CMD_TIMEOUT, env={'PATH': r2e.DOCKER_PATH})
    res: dict[str, Any] = {'ok': r.code == 0, 'stage': 'apply', 'code': r.code}
    if r.code == 0 and patches.touches_c_ext(patch):
        # Review G2: a patch that touches extension sources is only graded after a successful in-place rebuild.
        if env.docker.sh(name, 'test -f setup.py', 30).code != 0:
            return {'ok': False, 'stage': 'rebuild', 'code': None, 'rebuild': {'status': 'no-setup-py'}}
        b = env.docker.sh(name, r2e.wrap(patches.REBUILD_COMMAND, REBUILD_TIMEOUT), REBUILD_TIMEOUT, env={'PATH': r2e.DOCKER_PATH})
        res['rebuild'] = {'status': 'ok' if b.code == 0 else 'failed', 'code': b.code, 'secs': round(b.secs, 1)}
        if b.code != 0:
            return {**res, 'ok': False, 'stage': 'rebuild'}
    return res


def test_once(env: Env, task: Task, patch: str | None, label: str) -> dict[str, Any]:
    """One fresh container: R2E-Gym setup_env, optional patch (+ rebuild), run the hidden tests."""
    name = _ctr('grade', label)
    try:
        s = env.docker.start(task.image, name, env.network, env.limits, label)
        if s.code != 0:
            return {'error': 'start-failed', 'detail': str(StepFailed('docker run', s))[:600]}
        setup = _setup(env, name, r2e.setup_env_commands())
        applied = _apply(env, name, patch) if patch else None
        if applied is not None and not applied['ok']:
            if applied.get('stage') == 'rebuild':
                no_setup = (applied.get('rebuild') or {}).get('status') == 'no-setup-py'
                err = 'rebuild-unavailable' if no_setup else 'rebuild-failed'
            else:
                err = 'apply-failed'
            return {'setup': setup, 'apply': applied, 'statuses': {}, 'error': err}
        t = _run_tests(env, name)
        return {'setup': setup, 'apply': applied, **t}
    finally:
        env.docker.rm(name)


# ---------------------------------------------------------------- gold validation (D4)

def rebuild_base(env: Env, task: Task, label: str) -> dict[str, Any]:
    """Review G2: does the unpatched repo rebuild its extensions in place? Decides at grading whether a failed rebuild
    of an agent patch is the agent's fault (base rebuilds) or the harness's (no setup.py, or the base fails too)."""
    name = _ctr('rebuild', label)
    try:
        s = env.docker.start(task.image, name, env.network, env.limits, label)
        if s.code != 0:
            return {'ok': False, 'status': 'start-failed', 'detail': str(StepFailed('docker run', s))[:600]}
        _setup(env, name, r2e.setup_env_commands())
        if env.docker.sh(name, 'test -f setup.py', 30).code != 0:
            return {'ok': False, 'status': 'no-setup-py'}
        b = env.docker.sh(name, r2e.wrap(patches.REBUILD_COMMAND, REBUILD_TIMEOUT), REBUILD_TIMEOUT, env={'PATH': r2e.DOCKER_PATH})
        return {'ok': b.code == 0, 'status': 'ok' if b.code == 0 else 'failed', 'code': b.code, 'secs': round(b.secs, 1)}
    finally:
        env.docker.rm(name)


def validate(env: Env, task: Task, out_dir: pathlib.Path, repeats: int = VALIDATION_REPEATS) -> dict[str, Any]:
    """Base and gold `repeats` times each, no model calls. Writes results/validation/<task>.json."""
    t0 = time.time()
    try:
        pull = ensure_image(env, task.image)
    except (StepFailed, RuntimeError) as e:
        rec = {'schema': 'codex-deepswe-validation/v1', 'task_id': task.task_id, 'image': task.image, 'at': now_iso(),
               'verdict': {'ok': False, 'reasons': ['image-unavailable'], 'slowest_s': 0.0}, 'error': str(e)[:600],
               'spec': {'f2p': [], 'p2p': [], 'stable': False}, 'secs': round(time.time() - t0, 1)}
        write_json(out_dir / f'{task.task_id}.json', rec)
        return rec
    gold = r2e.gold_patch(task.parsed_commit)
    base_runs = [test_once(env, task, None, f'{task.task_id}-base{i}') for i in range(repeats)]
    gold_runs = [test_once(env, task, gold, f'{task.task_id}-gold{i}') for i in range(repeats)]
    spec = grading.derive_spec([r.get('statuses', {}) for r in base_runs], [r.get('statuses', {}) for r in gold_runs])
    base_strict = [grading.grade_strict(r.get('statuses', {}), task.expected_output_json) for r in base_runs]
    gold_strict = [grading.grade_strict(r.get('statuses', {}), task.expected_output_json) for r in gold_runs]
    base_rebuild = rebuild_base(env, task, f'{task.task_id}-rebuild')
    errors = [r['error'] for r in base_runs + gold_runs if r.get('error')]
    verdict = grading.validation_verdict(spec, base_strict, gold_strict, [r.get('secs', 0.0) for r in base_runs + gold_runs],
                                         limit_s=env.test_timeout)
    if errors:
        verdict = {**verdict, 'ok': False, 'reasons': verdict['reasons'] + sorted(set(errors))}
    if any(r.get('timed_out') for r in base_runs + gold_runs):
        verdict = {**verdict, 'ok': False, 'reasons': sorted(set(verdict['reasons'] + ['test-timeout']))}
    rec = {
        'schema': 'codex-deepswe-validation/v1', 'task_id': task.task_id, 'image': task.image, 'at': now_iso(),
        'pull': pull, 'repeats': repeats,
        'verdict': verdict, 'spec': spec, 'base_strict': base_strict, 'gold_strict': gold_strict,
        'gold_touches_c_ext': patches.touches_c_ext(gold),
        'base_rebuild': base_rebuild, 'base_rebuild_ok': base_rebuild['ok'],
        'runs': {'base': [_slim(r) for r in base_runs], 'gold': [_slim(r) for r in gold_runs]},
        'secs': round(time.time() - t0, 1),
    }
    write_json(out_dir / f'{task.task_id}.json', rec)
    return rec


def _slim(r: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in r.items() if k != 'output_tail'} | {'n_statuses': len(r.get('statuses') or {})}


# ---------------------------------------------------------------- agent run

@dataclasses.dataclass
class RunSpec:
    run_id: str
    phase: str
    arm: str
    task: Task
    pred_tier: str
    rep: int = 1
    attempt: int = 1


def prepare_agent(env: Env, task: Task, name: str, label: str, strip_future: bool = True) -> dict[str, Any]:
    checked(env.docker.start(task.image, name, env.network, env.limits, label), 'docker run (agent container)')
    setup = _setup(env, name, r2e.agent_hide_commands())
    present = [p for p in r2e.hidden_paths()
               if env.docker.sh(name, f'test -e {p} -o -L {p}', 30).code == 0]
    if present:
        raise RuntimeError(f'hidden test paths still present in the agent container: {present}')
    hist = history_check(env, name, task)
    stripped = False
    if hist['leak'] and strip_future:
        # The fix (or any history beyond HEAD) is reachable: detach HEAD at the base, delete every ref, the stash, the
        # reflogs and FETCH_HEAD/ORIG_HEAD, and prune unreachable objects. The working tree is unchanged.
        script = ('git checkout -q --detach'
                  ' && git for-each-ref --format="%(refname)" | while read r; do git update-ref -d "$r"; done'
                  ' && rm -f .git/FETCH_HEAD .git/ORIG_HEAD .git/MERGE_HEAD .git/packed-refs.lock'
                  ' && git reflog expire --expire=now --all && git gc -q --prune=now')
        g = env.docker.sh(name, r2e.wrap(f'sh -c {_q(script)}', GIT_TIMEOUT), GIT_TIMEOUT)   # one timeout over the whole chain
        after = history_check(env, name, task)
        stripped = g.code == 0 and not after['leak']
        hist = {**hist, 'after': after}
        if not stripped:
            raise RuntimeError(f'the fix is still reachable in the agent container after stripping: {after}')
    # Baseline tree after hiding: the agent patch is everything that differs from it (D12). Built in a throwaway index
    # so the agent starts with the image's own index (no staged changes in `git status`).
    b = env.docker.sh(name, r2e.wrap(f'sh -c {_q(TEMP_INDEX_SCRIPT + "git write-tree")}', GIT_TIMEOUT), GIT_TIMEOUT)
    base_tree = b.out.strip().splitlines()[-1] if b.code == 0 and b.out.strip() else ''
    if len(base_tree) not in (40, 64):
        raise RuntimeError('could not record the baseline tree')
    return {'setup': setup, 'future_commit_visible': hist['leak'], 'history_check': hist, 'git_stripped': stripped, 'base_tree': base_tree}


def history_check(env: Env, name: str, task: Task) -> dict[str, Any]:
    """Review G1b: is the answer reachable from the agent's git? `fix_objects`: the dataset's commit_hash or the parsed
    commit's new_commit_hash exists as a commit object (reachable or dangling); `beyond_head`: some ref reaches a
    commit that HEAD does not (`git rev-list --all --not HEAD`)."""
    hashes = sorted({h for h in (task.commit, json.loads(task.parsed_commit).get('new_commit_hash') if task.parsed_commit else None)
                     if h and all(c in '0123456789abcdef' for c in h)})
    present = [h for h in hashes if env.docker.sh(name, f'git cat-file -e {h}^{{commit}}', 60).code == 0]
    r = env.docker.sh(name, r2e.wrap('git rev-list --all --not HEAD --max-count=1', GIT_TIMEOUT), GIT_TIMEOUT)
    beyond = r.code == 0 and bool(r.out.strip())
    return {'checked': hashes, 'fix_objects': present, 'beyond_head': beyond, 'rev_list_code': r.code,
            'leak': bool(present) or beyond}


def install_codex(env: Env, name: str, codex_bin: pathlib.Path, toml: str) -> None:
    d = env.docker
    checked(d.sh(name, f'mkdir -p {pathlib.PurePosixPath(codex_setup.CTR_CODEX).parent} {codex_setup.CTR_CODEX_HOME}', 60), 'mkdir for codex')
    checked(d.cp_in(name, codex_bin, codex_setup.CTR_CODEX), 'docker cp codex')
    checked(d.sh(name, f'chmod 0755 {codex_setup.CTR_CODEX}', 60), 'chmod codex')
    checked(d.write_file(name, f'{codex_setup.CTR_CODEX_HOME}/config.toml', toml.encode(), '0600'), 'write config.toml')


def extract_patch(env: Env, name: str, base_tree: str) -> dict[str, Any]:
    # R2E-Gym's `git add -A && git diff --cached`, against the baseline tree, in a throwaway copy of the index.
    r = env.docker.sh(name, r2e.wrap(f'sh -c {_q(TEMP_INDEX_SCRIPT + "git diff --cached " + base_tree)}', GIT_TIMEOUT), GIT_TIMEOUT)
    if r.code != 0:
        return {'ok': False, 'code': r.code, 'raw': '', 'patch': '', 'dropped': []}
    kept, dropped = patches.filter_patch(r.out)
    return {'ok': True, 'raw_bytes': len(r.out.encode()), 'patch': kept, 'dropped': dropped,
            'stats': patches.stats(kept), 'touches_c_ext': patches.touches_c_ext(kept)}


def run_agent(env: Env, spec: RunSpec, base_url: str, codex_bin: pathlib.Path, run_dir: pathlib.Path,
              timeout_s: int = 2400, direct_model: str = 'global.openai.gpt-6.1-sol') -> dict[str, Any]:
    """Agent container: hide tests, install Codex + config, `codex exec --json` under timeout, extract the patch."""
    run_dir.mkdir(parents=True, exist_ok=True)
    name = _ctr('agent', spec.run_id)
    out: dict[str, Any] = {}
    try:
        out['image'] = ensure_image(env, spec.task.image)      # outside the run's wall clock
    except (StepFailed, RuntimeError) as e:
        return {**out, 'started_at': now_iso(), 'ended_at': now_iso(), 'wall_s': 0.0, 'exit_reason': 'harness-error',
                'error': f'{type(e).__name__}: {str(e)[:600]}'}
    t0 = time.time()
    out['started_at'] = now_iso()
    try:
        prep = prepare_agent(env, spec.task, name, spec.run_id)
        out.update({k: v for k, v in prep.items() if k != 'setup'})
        pin = ARM_PIN.get(spec.arm)
        toml = codex_setup.config_toml(base_url, spec.arm, spec.run_id, pin, direct_model)
        (run_dir / 'config.toml').write_text(toml)
        install_codex(env, name, codex_bin, toml)
        prompt = codex_setup.prompt(r2e.task_instruction(spec.task.problem_statement))
        argv = codex_setup.exec_argv(prompt, timeout_s)
        t_codex = time.time()
        res = env.docker.exec_argv(name, argv, timeout_s + 180, '/testbed', codex_setup.exec_env(r2e.DOCKER_PATH),
                                   run_dir / 'events.jsonl', run_dir / 'codex.stderr')
        out['codex_secs'] = round(time.time() - t_codex, 1)
        out['codex_exit_code'] = res.code
        summary = events.summarize((run_dir / 'events.jsonl').read_text(errors='replace'))
        out['events'] = summary
        out['exit_reason'] = ('timeout' if res.code in (124, 130, 137) or (res.code != 0 and out['codex_secs'] >= timeout_s)
                              else 'done' if res.code == 0 and summary['completed'] else 'error')
        p = extract_patch(env, name, prep['base_tree'])   # D11: also the diff present at timeout
        (run_dir / 'patch.diff').write_text(p.get('patch', ''))
        out['patch'] = {k: v for k, v in p.items() if k != 'patch'}
        out['patch_text'] = p.get('patch', '')
    except Exception as e:  # noqa: BLE001 - recorded as a harness error, the scheduler continues
        out['exit_reason'] = 'harness-error'
        out['error'] = f'{type(e).__name__}: {str(e)[:600]}'
    finally:
        env.docker.rm(name)
        out['wall_s'] = round(time.time() - t0, 1)
        out['ended_at'] = now_iso()
    return out


def grade(env: Env, task: Task, patch: str, spec: dict[str, Any], label: str, base_rebuild_ok: bool | None = None) -> dict[str, Any]:
    """Fresh container: apply the agent patch, run the hidden tests, SWE-bench-style and R2E-strict verdicts."""
    if not patch.strip():
        return {'status': 'empty-patch', 'resolved': False, 'strict': False}
    r = test_once(env, task, patch, label)
    if r.get('error') == 'apply-failed':
        return {'status': 'apply-failed', 'resolved': False, 'strict': False, 'apply': r.get('apply')}
    if r.get('error') == 'rebuild-failed' and base_rebuild_ok:
        # The unpatched repo rebuilds (validation), so the agent's patch broke the build: an unresolved run.
        return {'status': 'rebuild-failed-agent', 'resolved': False, 'strict': False, 'apply': r.get('apply')}
    if r.get('error') in ('rebuild-failed', 'rebuild-unavailable'):
        # The harness cannot rebuild this repo (no setup.py, or the base itself does not rebuild): not the agent's
        # verdict. Excluded from the paired analysis (results.analysis_row: grade_excluded) and listed in the report.
        return {'status': 'rebuild-unavailable', 'resolved': False, 'strict': False, 'excluded': True, 'apply': r.get('apply')}
    if r.get('error'):
        return {'status': 'error', 'resolved': False, 'strict': False, 'error': r['error']}
    sw = grading.grade_swebench(r['statuses'], spec)
    return {'status': 'graded', **sw, 'strict': grading.grade_strict(r['statuses'], task.expected_output_json),
            'timed_out': r.get('timed_out', False), 'test_secs': r.get('secs'), 'apply': r.get('apply'),
            'n_statuses': len(r['statuses'])}
