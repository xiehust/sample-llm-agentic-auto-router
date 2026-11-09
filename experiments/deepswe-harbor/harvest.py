"""17's merged attempt metadata + Harbor trial dirs + proxy calls → one result row per (pass, task, arm, rep) key
(design §4.6). Text-free: ids, codes and numbers only (no instruction, patch content, test names or messages).

Input: `fleet.py merge` → results/merged/harvest-meta.jsonl, one line per attempt: trial_id, arm, task, phase,
pass, rep, attempt, rerun_of, class, action, reason, score, runner, shard, block, host, cap_stopped, pred_tier,
jobs_dir, task_dir, job_name (the job holding the deciding verifier result: `<trial_id>-rv<k>-<hex>` after a
re-verify, else trial_id), agent_job_name (always trial_id: agent logs and timings), is_final, final_status
(scored | excluded); and merged/calls.jsonl (every runner's proxy calls, with `runner`).

**The scoring is the classifier's, never recomputed here (0d review F2):**
- the key's `is_final` attempt with final_status `scored` → `resolved = (score == 1)`, `in_comparisons = True`;
- `excluded`, or no final attempt yet (pending re-verify or rerun; the latest attempt is used) →
  `exit_reason = 'harness-error'` (`budget` for cap_stop), `resolved = False`, `in_comparisons = False`;
- for scored rows, `exit_reason` (done | timeout | error, R2E's vocabulary) is descriptive only, taken from the
  deciding attempt's ORIGINAL Harbor exception (the agent job's result.json): a re-verified timeout stays
  `timeout`; `sut` is `error`.

Terminal-Bench 2.1 (a public-network task, or meta `dataset = tb21`) gets schema `tbench-harbor-run/v1`: the same
field names with repo/language/size_bucket/solution_lines and patch null (the work is the container state), plus
`tb` (task facts from taskpin: category, difficulty, timeouts, cpus, memory), `tests_ran` (the verifier's ctrf ran ≥ 1
test), `lookup` (lookupscan's record: from 17's export via the meta line, else scanned here from the local trial dir),
`flaky_env` (0d §7.5, from the checks) and `net` (the container's IP and host veth from llmar-net.json).

Row schema `deepswe-harbor-run/v1` keeps the R2E names, so results.analysis_row, stats.py, routerlogs.join and
73's assessor_live take it unchanged: run_id (= trial_id of the deciding attempt = x-router-session), phase, arm,
task_id, repo, language, size_bucket, pred_tier, rep, attempt, resolved, exit_reason, ledger_usd, calls,
tokens_by_model, timings …
"""
from __future__ import annotations

import json
import pathlib
import re
import tomllib
from collections import defaultdict
from collections.abc import Iterable
from typing import Any

import hcommon  # noqa: F401  (sys.path for codex-deepswe)
import codex_config
import harbor_job
import hproxy
import results
from common import append_jsonl, read_jsonl, size_bucket

SCHEMA = 'deepswe-harbor-run/v1'
TB_SCHEMA = 'tbench-harbor-run/v1'      # Terminal-Bench 2.1 rows (TB design §4.7): same names, TB facts, no patch
TEST_PATH = re.compile(r'(^|/)(tests?|testing|__tests__|spec)(/|$)|(^|/)test_[^/]*$|_test\.[a-z]+$|\.test\.[a-z]+$|\.spec\.[a-z]+$')


def _num(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if isinstance(v, (int, float, bool)) and not isinstance(v, str)}


def _secs(t: dict[str, Any] | None) -> float | None:
    from datetime import datetime

    if not t or not t.get('started_at') or not t.get('finished_at'):
        return None
    a = datetime.fromisoformat(str(t['started_at']).replace('Z', '+00:00'))
    b = datetime.fromisoformat(str(t['finished_at']).replace('Z', '+00:00'))
    return round((b - a).total_seconds(), 3)


def task_facts(task_dir: pathlib.Path) -> dict[str, Any]:
    """Ids and sizes only from the task: repo (owner/name), language, change-size stratum of the reference
    solution (non-test lines changed), base commit."""
    meta = tomllib.loads((task_dir / 'task.toml').read_text()).get('metadata', {})
    url = str(meta.get('repository_url') or '')
    repo = '/'.join(url.rstrip('/').split('/')[-2:]) if url.startswith('https://github.com/') else None
    lines = 0
    sol = task_dir / 'solution' / 'solution.patch'
    if sol.exists():
        path = ''
        for line in sol.read_text(errors='replace').splitlines():
            if line.startswith('diff --git '):
                path = line.split(' b/', 1)[-1]
            elif (line.startswith('+') or line.startswith('-')) and not line.startswith(('+++', '---')) and not TEST_PATH.search(path):
                lines += 1
    return {'task_id': task_dir.name, 'repo': repo, 'language': meta.get('language'), 'base_commit': meta.get('base_commit_hash'),
            'solution_lines': lines if sol.exists() else None, 'size_bucket': size_bucket(lines) if sol.exists() else None}


def ctrf_counts(path: pathlib.Path) -> dict[str, Any] | None:
    try:
        j = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    tests = ((j.get('results') or {}).get('tests')) or []
    out: dict[str, int] = defaultdict(int)
    for t in tests:
        if not isinstance(t, dict):
            continue
        # DeepSWE's grader names tests "[f2p] <id>" / "[p2p] <id>"; only the bucket and status are kept.
        m = re.match(r'^\[(f2p|p2p)\] ', str(t.get('name') or ''))
        out[f"{m.group(1) if m else 'other'}_{str(t.get('status'))[:20]}"] += 1
    summ = (j.get('results') or {}).get('summary') or {}
    return {**dict(out), **{f'summary_{k}': v for k, v in summ.items() if isinstance(v, int)}}


def descriptive_exit(cls: str | None, exception: str | None) -> str:
    """R2E's exit_reason vocabulary for a SCORED row (descriptive only; the score is the classifier's)."""
    if cls == 'sut':
        return 'error'
    if exception is None:
        return 'done'
    return 'timeout' if exception == 'AgentTimeoutError' else 'error'


def _load(path: pathlib.Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except ValueError:
        return {}


def trial_dir_of(job_dir: pathlib.Path | None) -> pathlib.Path | None:
    """The single trial dir of a one-trial Harbor job (`<jobs_dir>/<job_name>/<trial_name>/result.json`)."""
    if job_dir is None:
        return None
    found = sorted(p.parent for p in job_dir.glob('*/result.json'))
    return found[0] if len(found) == 1 else None


def row(meta: dict[str, Any], calls: list[dict[str, Any]], task_dir: pathlib.Path | None = None) -> dict[str, Any]:
    """One key's row from its deciding (or, if none yet, latest) attempt's meta line."""
    jobs = pathlib.Path(meta['jobs_dir']) if meta.get('jobs_dir') else None
    adir = trial_dir_of(jobs / (meta.get('agent_job_name') or meta['trial_id'])) if jobs else None
    vdir = trial_dir_of(jobs / (meta.get('job_name') or meta['trial_id'])) if jobs else None
    vdir = vdir or adir
    res = _load(adir / 'result.json') if adir else {}
    vres = _load(vdir / 'result.json') if vdir else {}
    orig_exc = (res.get('exception_info') or {}).get('exception_type')
    status = meta.get('final_status') if meta.get('is_final') else 'pending'
    status = status or 'pending'
    cls = meta.get('class')
    scored = status == 'scored'
    ex = descriptive_exit(cls, orig_exc) if scored else ('budget' if cls == 'cap_stop' else 'harness-error')
    score = meta.get('score') if scored else None
    rjson = _num(_load(vdir / 'verifier' / 'reward.json')) if vdir else {}
    patch = next(iter(sorted(adir.joinpath('artifacts').rglob('model.patch'))), None) if adir else None
    cc = is_claude_code(adir, calls)
    cs = results.calls_summary([{**c, 'leaf': 'responses'} if c.get('leaf') == 'messages' else c for c in calls] if cc else calls)
    td = task_dir or (pathlib.Path(meta['task_dir']) if meta.get('task_dir') else None)
    facts = task_facts(td) if td is not None and (td / 'task.toml').exists() else {'task_id': meta.get('task')}
    timings = {k: _secs(res.get(k)) for k in ('environment_setup', 'agent_setup', 'agent_execution')}
    timings['verifier'] = _secs(vres.get('verifier'))
    tid = meta['trial_id']
    out = {
        'schema': SCHEMA, 'run_id': tid, 'trial_id': tid, 'pass': meta.get('pass'), 'phase': meta.get('phase', 'main'),
        'arm': meta['arm'], **{k: facts.get(k) for k in ('task_id', 'repo', 'language', 'size_bucket', 'solution_lines')},
        'pred_tier': meta.get('pred_tier') or 'none', 'rep': int(meta.get('rep') or 1), 'attempt': int(meta.get('attempt') or 1),
        'rerun_of': meta.get('rerun_of'), 'block': meta.get('block'), 'runner': meta.get('runner'), 'shard': meta.get('shard'),
        'final_status': status, 'in_comparisons': scored, 'class': cls, 'action': meta.get('action'), 'score': score,
        'resolved': bool(scored and score == 1), 'exit_reason': ex, 'exit_detail': orig_exc,
        'reward': ((vres.get('verifier_result') or {}).get('rewards') or {}).get('reward'),
        'verifier': {'reward_json': rjson, 'ctrf': ctrf_counts(vdir / 'verifier' / 'ctrf.json') if vdir else None,
                     'reverified': (meta.get('job_name') or tid) != (meta.get('agent_job_name') or tid)},
        'patch': {'bytes': patch.stat().st_size if patch else None, 'empty': (patch.stat().st_size == 0) if patch else None},
        'calls': cs, 'tokens_by_model': hproxy.tokens_by_model([c for c in calls if c.get('leaf') in (('responses', 'messages') if cc else ('responses',))]),
        'ledger_usd': cs['ledger_usd'],
        'harbor': {'exception': orig_exc, 'cause': _cause(orig_exc), 'agent_version': (res.get('agent_info') or {}).get('version'),
                   'trial_name': res.get('trial_name')},
        'codex': codex_config.summary(), 'timings': timings,
        'wall_s': _secs({'started_at': res.get('started_at'), 'finished_at': res.get('finished_at')}),
        'codex_secs': timings['agent_execution'], 'host': meta.get('host'), 'cap_stopped': bool(meta.get('cap_stopped')),
    }
    if meta.get('dataset') == 'tb21' or (td is not None and harbor_job.task_network_public(td)):
        out.update(tb_fields(meta, adir, vdir, td))
    if cc:
        out.update(cc_fields(meta, adir, calls))
    return out


def is_claude_code(adir: pathlib.Path | None, calls: list[dict[str, Any]]) -> bool:
    return any(c.get('leaf') == 'messages' for c in calls) or bool(adir and (adir / 'agent' / 'claude-code.txt').is_file())


def cc_fields(meta: dict[str, Any], adir: pathlib.Path | None, calls: list[dict[str, Any]]) -> dict[str, Any]:
    """The Claude Code part of a row (design-harness §4). Text-free: codes, counts and model ids only — never message
    text, tool inputs or outputs. The stream-json `result` event (claude-code.txt) gives the session's own outcome
    (Harbor runs `| tee` under pipefail, so a failed process also fails the exec); a missing event is `missing`."""
    import cc_transcript

    model = [c for c in calls if c.get('leaf') == 'messages']
    t = cc_transcript.summary(adir / 'agent') if adir else cc_transcript.empty()
    return {'agent': 'claude-code', 'codex': None,
            'claude': {'version': hcommon.CLAUDE_CODE['version'], 'build': meta.get('claude_build'), 'effort': 'high',
                       'client_model': hcommon.CC_CLIENT_MODEL.get(meta.get('arm', ''), None), **t},
            **hproxy.cc_summary(model)}


def tb_fields(meta: dict[str, Any], adir: pathlib.Path | None, vdir: pathlib.Path | None, td: pathlib.Path | None) -> dict[str, Any]:
    """The Terminal-Bench 2.1 part of a row (module docstring). Text-free."""
    import lookupscan          # stdlib only: harvest runs where Harbor may not be installed (fleet merge)
    import taskpin

    facts = taskpin.task_facts(td) if td is not None and (td / 'task.toml').exists() else {}
    ctrf = ctrf_counts(vdir / 'verifier' / 'ctrf.json') if vdir else None
    lookup = meta.get('lookup')
    if lookup is None and adir is not None and td is not None:
        lookup = lookupscan.scan_trial(adir, td)[0]
    net = _load(adir / hcommon.NET_RECORD) if adir else {}
    return {'schema': TB_SCHEMA, 'repo': None, 'language': None, 'size_bucket': None, 'solution_lines': None, 'patch': None,
            'tb': facts, 'tests_ran': None if ctrf is None else int(ctrf.get('summary_tests') or 0) >= 1, 'lookup': lookup,
            'flaky_env': meta.get('flaky_env'), 'net': {k: net.get(k) for k in ('ip', 'veth')} if net else None}


def _cause(exc: str | None) -> str | None:
    if exc is None:
        return None
    try:
        from harbor.models.trial.error_policy import policy_for  # type: ignore[import-not-found]
    except ImportError:
        return None
    return str(policy_for(exc).cause)


def latest(rows: Iterable[dict[str, Any]]) -> dict[tuple, dict[str, Any]]:
    """One row per (phase, arm, task, rep); harvest already emits one per key (the deciding attempt)."""
    out: dict[tuple, dict[str, Any]] = {}
    for r in sorted((r for r in rows if r.get('schema') in (SCHEMA, TB_SCHEMA)), key=lambda r: r.get('attempt', 1)):
        out[(r['phase'], r['arm'], r['task_id'], r.get('rep', 1))] = r
    return out


def harvest(meta_path: pathlib.Path, calls_path: pathlib.Path, out: pathlib.Path) -> int:
    """One row per (pass, task, arm, rep): its is_final attempt, else (pending) its latest attempt."""
    by_trial: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in read_jsonl(calls_path):
        if c.get('trial_id') or c.get('run_id'):
            by_trial[c.get('trial_id') or c['run_id']].append(c)
    keys: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for m in read_jsonl(meta_path):
        keys[(m.get('pass'), m.get('task'), m.get('arm'), int(m.get('rep') or 1))].append(m)
    n = 0
    for attempts in keys.values():
        attempts.sort(key=lambda m: int(m.get('attempt') or 1))
        m = next((x for x in reversed(attempts) if x.get('is_final')), attempts[-1])
        append_jsonl(out, row(m, by_trial.get(m['trial_id'], [])))
        n += 1
    return n
