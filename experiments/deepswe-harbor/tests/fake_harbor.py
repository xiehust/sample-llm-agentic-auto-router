#!/usr/bin/env python3
"""A scripted stand-in for the `harbor` CLI (driver tests). It writes the one-trial job layout of Harbor 0.25.0:
<jobs_dir>/<job_name>/<trial_name>/result.json (+ artifacts/model.patch), for

  fake_harbor.py run --config job.json --yes
  fake_harbor.py jobs regrade <source_job_dir> --task-path T --jobs-dir J --job-name N --n-concurrent 1 --yes

The behaviour comes from the job config's `llmar_test` block (`behaviour`), from the regrade scenario file
($FAKE_HARBOR_REGRADE: a JSON list consumed in order), or from the agent name for oracle/nop jobs
($FAKE_HARBOR_CHECKS: JSON {"<task>/<agent>": "pass"|"fail"|"infra"|… or a list consumed one per attempt, with
the counters in $FAKE_HARBOR_STATE}). The TB behaviours write a shared verifier's outputs (verifier/ctrf.json,
verifier/test-stdout.txt): tb_pass, tb_fail (tests ran), netfail (reward 0, the test runner never started, a
network error in the stdout). Every invocation is appended to $FAKE_HARBOR_LOG (JSON lines) with its start time,
its end time and the env keys it saw."""
import fcntl
import json
import os
import pathlib
import random
import string
import sys
import time


def log(rec):
    p = os.environ.get('FAKE_HARBOR_LOG')
    if p:
        with open(p, 'a') as f:
            f.write(json.dumps(rec) + '\n')


def trial_dir(jobs_dir: pathlib.Path, job_name: str, task: str) -> pathlib.Path:
    name = f"{task[:32].rstrip('_-')}__{''.join(random.choice(string.ascii_letters + string.digits) for _ in range(7))}"
    d = jobs_dir / job_name / name
    d.mkdir(parents=True)
    (d / 'config.json').write_text('{}')
    return d


def result(task, *, reward=None, exc=None, agent_done=True):
    r = {'task_name': task, 'trial_name': 'x', 'exception_info': ({'exception_type': exc, 'exception_message': 'm', 'exception_traceback': '',
                                                                  'occurred_at': '2026-11-05T00:00:00Z'} if exc else None),
         'verifier_result': ({'rewards': {'reward': reward}} if reward is not None else None),
         'agent_execution': {'started_at': '2026-11-05T00:00:00Z', 'finished_at': '2026-11-05T00:10:00Z' if agent_done else None},
         'verifier': {'started_at': '2026-11-05T00:10:00Z', 'finished_at': '2026-11-05T00:11:00Z'}}
    return r


TB_VERIFIER = {   # behaviour → (ctrf tests or None, stdout)
    'tb_pass': (3, 'collected 3 items\n3 passed\n'), 'tb_fail': (3, 'collected 3 items\n1 failed, 2 passed\n'),
    'netfail': (None, 'downloading uv 0.9.5\ncurl: (6) Could not resolve host: astral.sh\n'),
}


def next_of(key: str, seq: list[str]) -> str:
    """The attempt-th entry of a per-key list (the last one repeats); counters under $FAKE_HARBOR_STATE."""
    d = pathlib.Path(os.environ.get('FAKE_HARBOR_STATE') or '/tmp')
    d.mkdir(parents=True, exist_ok=True)
    p = d / ('ctr-' + key.replace('/', '__'))
    with open(p, 'a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        n = int(f.read().strip() or 0)
        f.seek(0)
        f.truncate()
        f.write(str(n + 1))
    return seq[min(n, len(seq) - 1)]


BEHAVIOURS = {
    'tb_pass': {'reward': 1.0}, 'tb_fail': {'reward': 0.0}, 'netfail': {'reward': 0.0},
    'pass': dict(reward=1.0), 'fail': dict(reward=0.0), 'timeout': dict(reward=0.0, exc='AgentTimeoutError'),
    'nonzero': dict(reward=0.0, exc='NonZeroAgentExitCodeError'), 'env': dict(exc='EnvironmentStartTimeoutError', agent_done=False),
    'verifier_timeout': dict(exc='VerifierTimeoutError'), 'crash_sentinel': dict(reward=-1.0),
}


def model_call(base_url):
    import http.client
    import urllib.parse
    u = urllib.parse.urlsplit(base_url)
    body = json.dumps({'model': 'auto', 'stream': True, 'input': [{'type': 'message', 'role': 'user', 'content': 'x'}],
                       'tools': [{'type': 'function', 'name': 'exec_command'}]}).encode()
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    c.request('POST', u.path + '/responses', body=body, headers={'content-type': 'application/json', 'content-length': str(len(body))})
    r = c.getresponse()
    r.read()
    c.close()
    return r.status


def cc_artifacts(d: pathlib.Path, task: str) -> None:
    """Claude Code's agent dir (Harbor's claude-code agent): the stream-json log `agent/claude-code.txt` (a `result`
    event unless the scenario is no_result) and CLAUDE_CONFIG_DIR under agent/sessions (session and subagent jsonl
    files, plus the files the export must leave out). Scenario per attempt from $FAKE_HARBOR_CC {task: [..]}."""
    scen = json.loads(os.environ.get('FAKE_HARBOR_CC', '{}')).get(task, 'ok')
    if isinstance(scen, list):
        scen = next_of(f'cc-{task}', scen)
    a = d / 'agent'
    (a / 'sessions' / 'projects' / '-app' / 's1' / 'subagents').mkdir(parents=True)
    lines = [{'type': 'system', 'subtype': 'init'}, {'type': 'assistant', 'message': {'content': []}}]
    if scen != 'no_result':
        lines.append({'type': 'result', 'subtype': 'success' if scen == 'ok' else 'error_during_execution', 'is_error': scen != 'ok'})
    (a / 'claude-code.txt').write_text(''.join(json.dumps(x) + '\n' for x in lines))
    (a / 'sessions' / 'projects' / '-app' / 's1.jsonl').write_text('{"type":"user"}\n')
    (a / 'sessions' / 'projects' / '-app' / 's1' / 'subagents' / 'agent-a1.jsonl').write_text('{"type":"user"}\n')
    (a / 'sessions' / '.claude.json').write_text('{"userID":"not-exported"}')
    (a / 'sessions' / 'statsig').mkdir()
    (a / 'sessions' / 'statsig' / 'cache').write_text('not-exported')


def main():
    argv = sys.argv[1:]
    t0 = time.time()
    if argv[:1] == ['run']:
        cfg = json.loads(pathlib.Path(argv[argv.index('--config') + 1]).read_text())
        task = pathlib.Path(cfg['tasks'][0]['path']).name
        jobs_dir, job = pathlib.Path(cfg['jobs_dir']), cfg['job_name']
        agent = (cfg['agents'][0] or {}).get('name')
        t = cfg.get('llmar_test') or {}
        beh = t.get('behaviour', 'pass')
        if agent in ('oracle', 'nop'):
            checks = json.loads(os.environ.get('FAKE_HARBOR_CHECKS', '{}'))
            beh = checks.get(f'{task}/{agent}', 'pass' if agent == 'oracle' else 'fail')
            if isinstance(beh, list):
                beh = next_of(f'{task}/{agent}', beh)
            if beh == 'infra':
                beh = 'env'
        log({'cmd': 'run', 'job': job, 'task': task, 'agent': agent, 'behaviour': beh, 't0': t0, 'env': sorted(os.environ)})
        if beh == 'crash':
            sys.exit(1)
        if beh == 'hang':
            time.sleep(600)
        for _ in range(int(t.get('calls', 0))):   # Codex's model calls through the trial's proxy route
            model_call(t['base_url'])
        time.sleep(float(t.get('sleep', 0.05)))
        d = trial_dir(jobs_dir, job, task)
        if beh in TB_VERIFIER:   # a shared verifier: no patch artifact; CTRF report and stdout under verifier/
            tests, out = TB_VERIFIER[beh]
            (d / 'verifier').mkdir()
            (d / 'verifier' / 'test-stdout.txt').write_text(out)
            if tests is not None:
                (d / 'verifier' / 'ctrf.json').write_text(json.dumps({'results': {'summary': {'tests': tests}}}))
        elif beh != 'env':
            (d / 'artifacts').mkdir()
            (d / 'artifacts' / 'model.patch').write_text('diff --git a/x b/x\n')
        if str((cfg['agents'][0] or {}).get('import_path') or '').endswith('LlmarClaudeCode'):
            cc_artifacts(d, task)
        (d / 'result.json').write_text(json.dumps(result(task, **BEHAVIOURS[beh])))
    elif argv[:2] == ['jobs', 'regrade']:
        src = pathlib.Path(argv[2])
        jobs_dir, job = pathlib.Path(argv[argv.index('--jobs-dir') + 1]), argv[argv.index('--job-name') + 1]
        task = pathlib.Path(argv[argv.index('--task-path') + 1]).name
        scen = os.environ.get('FAKE_HARBOR_REGRADE')
        beh = 'pass'
        if scen:
            p = pathlib.Path(scen)
            q = json.loads(p.read_text())
            if q:
                beh = q.pop(0)
                p.write_text(json.dumps(q))
        log({'cmd': 'regrade', 'job': job, 'src': src.name, 'task': task, 'behaviour': beh, 't0': t0})
        time.sleep(0.05)
        d = trial_dir(jobs_dir, job, task)
        (d / 'result.json').write_text(json.dumps(result(task, **BEHAVIOURS[beh])))
    else:
        sys.exit(f'fake harbor: unsupported {argv}')
    log({'cmd': 'end', 'job': job, 't1': time.time()})


if __name__ == '__main__':
    main()
