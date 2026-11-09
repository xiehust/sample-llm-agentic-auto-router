"""In-session struggle signals per model call, from the Harbor runs' Codex rollouts (escalation design §3).
Stdlib only; run with -I. Text-free output: counts, flags and token numbers only (N5).

  python3 -I experiments/escalation/signals.py --bench deepswe|tbench   → results/signals-<bench>.jsonl

One line per scored run of the analysis set (phase != pilot, final_status scored, in_comparisons): run_id, task_id,
arm, rep, the agent timeout, per call from the host proxy (calls.jsonl, status 200, in seq order) its priced cost,
prompt tokens, start time (s after the first call) and usage [uncached, read, write, output], and `series`: for every model call k = 1..n the state *before* request k was sent, i.e. what a
router deciding request k could know. Signals are grouped by who can observe them (OBSERVABILITY below).
Outcome-free: no resolve, reward or exit field is read or written here (simulate.py joins outcomes after the freeze).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
from collections import defaultdict
from collections.abc import Iterable, Iterator
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
BENCH_DIRS = {'deepswe': ROOT / 'deepswe-harbor', 'tbench': ROOT / 'tbench-harbor'}

# Who can see each signal at request k:
#  router-today:  RequestLog / card fields the router already computes (core state, card/v1 stats);
#  router-body:   in the request body the router receives (Codex resends the full history), new parsing needed;
#  client-only:   not in any request (encrypted reasoning content, the verifier).
OBSERVABILITY = {
    'k': 'router-today',                 # SessionState.calls (lineage call count)
    'turn_index': 'router-today',        # card.stats.turnIndex (user-text turns; 0 for a Codex exec run)
    'prev_turn_tool_calls': 'router-today',   # card.stats.prevTurnToolCalls (all calls since the last user text)
    'prev_turn_tool_errors': 'router-today',  # card.stats.prevTurnToolErrors (Responses: always 0, no error flag)
    'compactions': 'router-today',       # SessionState.compactions (compaction:shrink break points)
    'prompt_tokens': 'router-today',     # estPromptTokens / usage.promptTokens of call k-1
    'spend_usd': 'router-today',         # Σ costUsd of the lineage so far
    'tool_calls': 'router-body',
    'exec_nonzero': 'router-body',       # tool outputs "Process exited with code N", N != 0
    'consec_nonzero': 'router-body',
    'test_runs': 'router-body',          # commands that run a test suite (by command shape)
    'test_fail': 'router-body',          # … that exited non-zero
    'consec_test_fail': 'router-body',
    'repeat_cmd': 'router-body',         # a command identical to an earlier one (hash)
    'no_progress': 'router-body',        # tool calls since the last call whose command was not a read-only look
}

EXIT_RE = re.compile(r'Process exited with code (-?\d+)')
SESSION_RE = re.compile(r'Process running with session ID (\d+)')
TEST_RE = re.compile(
    r'(?:^|[\s;&|(])(?:pytest|py\.test|python3? -m (?:pytest|unittest)|go test|cargo (?:test|nextest)|'
    r'(?:npm|yarn|pnpm|bun)(?: run)? test|npx (?:jest|vitest|mocha)|jest|vitest|mocha|mvn\b[^\n;&|]*\btest|'
    r'(?:\./)?gradlew?\b[^\n;&|]*\btest|make (?:test|check)|ctest|phpunit|rspec|bundle exec (?:rake|rspec)|tox|nox|'
    r'dotnet test|swift test|bats|mix test|stack test|cabal test|zig (?:build )?test|deno test|'
    r'[\w./-]*run[_-]?tests?[\w.-]*|[\w./-]*test[\w-]*\.sh)\b')
LOOK_RE = re.compile(r'^\s*(?:cd [^;&|]+(?:&&|;)\s*)?(?:ls|cat|head|tail|sed -n|grep|rg|find|pwd|wc|nl|tree|file|stat|git (?:status|diff|log|show)|echo)\b')


INSTALL_RE = re.compile(r'\b(?:pip3?|uv pip|python3? -m pip|apt(?:-get)?|brew|npm (?:i|install)|yarn add|pnpm (?:add|i|install)|'
                        r'cargo install|go (?:get|install))\b[^;&|\n]*')


def is_test_cmd(cmd: str) -> bool:
    """A command that runs a test suite (package installs naming a test tool do not count)."""
    return TEST_RE.search(INSTALL_RE.sub(' ', cmd)) is not None


def is_look_cmd(cmd: str) -> bool:
    return LOOK_RE.match(cmd) is not None and not is_test_cmd(cmd)


def _cmd_of(payload: dict[str, Any]) -> tuple[str, str | None]:
    """(command text, write_stdin session id or None) of a function_call."""
    try:
        args = json.loads(payload.get('arguments') or '{}')
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    if payload.get('name') == 'write_stdin':
        return str(args.get('chars') or ''), str(args.get('session_id')) if args.get('session_id') is not None else None
    cmd = args.get('cmd', args.get('command', ''))
    return (' '.join(map(str, cmd)) if isinstance(cmd, list) else str(cmd)), None


def _lines(paths: Iterable[pathlib.Path]) -> Iterator[dict[str, Any]]:
    for p in paths:
        for line in p.read_text(encoding='utf-8', errors='ignore').splitlines():
            try:
                j = json.loads(line)
            except ValueError:
                continue
            if isinstance(j, dict):
                yield j


def series(rollouts: list[pathlib.Path]) -> list[dict[str, Any]]:
    """Per model call k (1-based), the signals before request k. A model call ends at a token_count event whose cumulative total grew."""
    st = {'tool_calls': 0, 'exec_nonzero': 0, 'consec_nonzero': 0, 'test_runs': 0, 'test_fail': 0, 'consec_test_fail': 0,
          'repeat_cmd': 0, 'no_progress': 0, 'compactions': 0, 'prompt_tokens': 0, 'out_tokens': 0}
    seen: set[str] = set()
    pending: dict[str, tuple[bool, bool]] = {}       # call_id → (is_test, is_look)
    sessions: dict[str, bool] = {}                   # exec session id → is_test (long-running commands)
    last_total = [0]
    out: list[dict[str, Any]] = []

    def snapshot() -> dict[str, Any]:
        k = len(out) + 1
        return {'k': k, 'turn_index': 0, 'prev_turn_tool_calls': st['tool_calls'], 'prev_turn_tool_errors': 0,
                **{x: st[x] for x in ('tool_calls', 'exec_nonzero', 'consec_nonzero', 'test_runs', 'test_fail',
                                      'consec_test_fail', 'repeat_cmd', 'no_progress', 'compactions', 'prompt_tokens', 'out_tokens')}}

    out.append(snapshot())
    for j in _lines(rollouts):
        t, p = j.get('type'), j.get('payload') if isinstance(j.get('payload'), dict) else {}
        if t == 'response_item' and p.get('type') == 'function_call':
            cmd, sid = _cmd_of(p)
            test = sessions.get(sid, False) if sid is not None else is_test_cmd(cmd)
            look = False if sid is not None else is_look_cmd(cmd)
            st['tool_calls'] += 1
            if sid is None and cmd.strip():
                h = hashlib.sha256(' '.join(cmd.split()).encode()).hexdigest()
                st['repeat_cmd'] += h in seen
                seen.add(h)
            st['no_progress'] = st['no_progress'] + 1 if look or sid is not None else 0
            pending[str(p.get('call_id'))] = (test, look)
        elif t == 'response_item' and p.get('type') == 'function_call_output':
            test, _ = pending.pop(str(p.get('call_id')), (False, False))
            o = p.get('output')
            text = o if isinstance(o, str) else json.dumps(o)
            m, s = EXIT_RE.search(text[:400]), SESSION_RE.search(text[:400])
            if s and not m:
                sessions[s.group(1)] = test
                continue
            if m:
                bad = int(m.group(1)) != 0
                st['exec_nonzero'] += bad
                st['consec_nonzero'] = st['consec_nonzero'] + 1 if bad else 0
                if test:
                    st['test_runs'] += 1
                    st['test_fail'] += bad
                    st['consec_test_fail'] = st['consec_test_fail'] + 1 if bad else 0
        elif t == 'compacted':
            st['compactions'] += 1
        elif t == 'event_msg' and p.get('type') == 'token_count':
            # One model response = a token_count whose cumulative total grew (the event repeats unchanged around a
            # compaction and resets its `last` to 0 after one; token_usage_record is missing for some calls).
            info = p.get('info') or {}
            total = int((info.get('total_token_usage') or {}).get('total_tokens') or 0)
            if total <= last_total[0]:
                continue
            last_total[0] = total
            last = info.get('last_token_usage') or {}
            st['prompt_tokens'] = int(last.get('input_tokens') or 0)
            st['out_tokens'] += int(last.get('output_tokens') or 0)
            out.append(snapshot())
    return out[:-1]          # the snapshot after the last call precedes no request


# ---------------------------------------------------------------- the analysis set


def agent_timeout(row: dict[str, Any], task_dir: str) -> float | None:
    """The task's agent timeout: TB rows carry it; DeepSWE's from [agent] timeout_sec in the task's task.toml."""
    t = (row.get('tb') or {}).get('agent_timeout_s')
    if t is None and task_dir and (pathlib.Path(task_dir) / 'task.toml').is_file():
        m = re.search(r'^\[agent\][^\[]*?^timeout_sec\s*=\s*([0-9.]+)', (pathlib.Path(task_dir) / 'task.toml').read_text(encoding='utf-8'), re.MULTILINE | re.DOTALL)
        t = float(m.group(1)) if m else None
    return float(t) if isinstance(t, (int, float)) else None


def load(bench: str) -> list[dict[str, Any]]:
    base = BENCH_DIRS[bench] / 'results' / 'merged'
    rows = [json.loads(x) for x in (base / 'rows.jsonl').read_text(encoding='utf-8').splitlines() if x.strip()]
    rows = [r for r in rows if r.get('phase') != 'pilot' and r.get('final_status') == 'scored' and r.get('in_comparisons')]
    tdir: dict[str, pathlib.Path | None] = {}
    tdir_task: dict[str, str] = {}
    for x in (base / 'harvest-meta.jsonl').read_text(encoding='utf-8').splitlines():
        m = json.loads(x)
        if m.get('is_final'):
            tdir[m['trial_id']] = pathlib.Path(m['trial_dir']) if m.get('trial_dir') else None
            tdir_task[m['trial_id']] = m.get('task_dir') or ''
    costs: dict[str, list[tuple[int, float, int, float, list[int]]]] = defaultdict(list)
    with (base / 'calls.jsonl').open(encoding='utf-8') as f:
        for x in f:
            c = json.loads(x)
            if c.get('status') == 200 and c.get('leaf') == 'responses':
                u = c.get('usage') or {}
                costs[c['run_id']].append((int(c['seq']), float(c.get('cost_usd') or 0.0), int(u.get('prompt') or 0), float(c.get('t_start') or 0.0),
                                            [int(u.get(x) or 0) for x in ('uncached', 'read', 'write', 'output')]))
    out = []
    for r in rows:
        d = tdir.get(r['trial_id'])
        sess = d / 'agent' / 'sessions' if d else None
        rolls = sorted(sess.rglob('rollout-*.jsonl')) if sess and sess.is_dir() else []
        cc = sorted(costs.get(r['run_id'], []))
        s = series(rolls) if rolls else []
        out.append({'run_id': r['run_id'], 'task_id': r['task_id'], 'arm': r['arm'], 'rep': r.get('rep'), 'pred_tier': r.get('pred_tier'),
                    'ledger_usd': r.get('ledger_usd'), 'agent_timeout_s': agent_timeout(r, tdir_task.get(r['trial_id'], '')),
                    'call_cost': [x[1] for x in cc], 'call_prompt': [x[2] for x in cc],
                    'call_t': [round(x[3] - cc[0][3], 1) for x in cc] if cc else [], 'call_usage': [x[4] for x in cc],
                    'has_rollout': bool(rolls), 'aligned': len(s) == len(cc), 'series': s})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bench', choices=sorted(BENCH_DIRS), required=True)
    a = ap.parse_args()
    runs = load(a.bench)
    dst = HERE / 'results' / f'signals-{a.bench}.jsonl'
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(''.join(json.dumps(r, separators=(',', ':')) + '\n' for r in runs), encoding='utf-8')
    n = len(runs)
    print(f'{a.bench}: {n} runs, {sum(r["has_rollout"] for r in runs)} with a rollout, {sum(r["aligned"] for r in runs)} '
          f'aligned with calls.jsonl → {dst.relative_to(ROOT.parent)}', file=sys.stderr)


if __name__ == '__main__':
    main()
