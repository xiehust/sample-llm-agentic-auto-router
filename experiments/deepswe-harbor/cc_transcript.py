"""Claude Code transcripts of one trial (design-harness §4): text-free summary for harvest, and the agent's actions and
tool outputs for lookupscan. Stdlib only (harvest and the runner's export run without Harbor).

Layout under the trial's agent dir (Harbor: CLAUDE_CONFIG_DIR=<agent>/sessions, stdout tee'd to claude-code.txt):
- sessions/projects/<cwd-slug>/<session>.jsonl (main loop) and <session>/subagents/agent-*.jsonl (subagents);
- claude-code.txt: the `--output-format=stream-json` events, ending with one `result` event per finished turn.
Only `assistant` (tool_use) and `user` (tool_result) records are agent work. Everything else is skipped, in particular
`api-request-blob` (Claude Code 2.1 stores whole request bodies in the transcript: system prompt, tools, the task's own
instruction), so the scanner never reads the instruction as if the agent had produced it.
"""
from __future__ import annotations

import json
import pathlib
from collections import Counter
from collections.abc import Iterator
from typing import Any

DISALLOWED = ('WebSearch', 'WebFetch')
MAX_FILE = 256 * 1024 * 1024


def _records(path: pathlib.Path) -> Iterator[dict[str, Any]]:
    try:
        if path.stat().st_size > MAX_FILE:
            return
        text = path.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        return
    for line in text.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if isinstance(j, dict):
            yield j


def session_files(agent_dir: pathlib.Path) -> tuple[list[pathlib.Path], list[pathlib.Path]]:
    """(main session files, subagent files) under sessions/projects/."""
    root = agent_dir / 'sessions' / 'projects'
    if not root.is_dir():
        return [], []
    main = sorted(p for p in root.glob('*/*.jsonl') if p.is_file())
    subs = sorted(p for p in root.glob('*/*/subagents/*.jsonl') if p.is_file())
    return main, subs


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(str(x.get('text') or '') if isinstance(x, dict) else str(x) for x in content)
    return json.dumps(content) if content is not None else ''


def _input_text(inp: Any) -> str:
    """A tool_use input as text: its string values one per line (Bash `command`, Edit/Write fields, …)."""
    if isinstance(inp, dict):
        return '\n'.join(v if isinstance(v, str) else json.dumps(v) for v in inp.values())
    return inp if isinstance(inp, str) else json.dumps(inp)


def _work(records: Iterator[dict[str, Any]]) -> Iterator[tuple[str, str, str | None, str | None]]:
    """(kind, text, tool name, tool_use id) for each tool_use ('action') and tool_result ('output')."""
    for j in records:
        t = j.get('type')
        if t not in ('assistant', 'user'):
            continue
        content = (j.get('message') or {}).get('content') if isinstance(j.get('message'), dict) else None
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict):
                continue
            if t == 'assistant' and c.get('type') == 'tool_use':
                yield 'action', _input_text(c.get('input')), str(c.get('name') or ''), str(c.get('id') or '')
            elif t == 'user' and c.get('type') == 'tool_result':
                yield 'output', _text(c.get('content')), None, str(c.get('tool_use_id') or '')


def units(agent_dir: pathlib.Path) -> tuple[str, list[str], list[str], list[int | None]] | None:
    """(source, actions, outputs, the action index of each output's tool_use or None) for lookupscan: the session files
    when present, else claude-code.txt; None when the trial has neither (not a Claude Code trial)."""
    main, subs = session_files(agent_dir)
    files = [*main, *subs]
    if files:
        src, recs = 'cc-session', (r for f in files for r in _records(f))
    elif (agent_dir / 'claude-code.txt').is_file():
        src, recs = 'claude-code.txt', _records(agent_dir / 'claude-code.txt')
    else:
        return None
    actions: list[str] = []
    outputs: list[str] = []
    out_src: list[int | None] = []
    by_id: dict[str, int] = {}
    for kind, text, _, tid in _work(recs):
        if kind == 'action':
            if tid:
                by_id[tid] = len(actions)
            actions.append(text)
        else:
            outputs.append(text)
            out_src.append(by_id.get(tid or ''))
    return src, actions, outputs, out_src


def empty() -> dict[str, Any]:
    return {'result': {'status': 'missing'}, 'results': 0, 'transcript': {'files_main': 0, 'files_subagent': 0}}


def summary(agent_dir: pathlib.Path) -> dict[str, Any]:
    out = empty()
    results = [j for j in _records(agent_dir / 'claude-code.txt') if j.get('type') == 'result'] if (agent_dir / 'claude-code.txt').is_file() else []
    out['results'] = len(results)
    if results:
        r = results[-1]
        sub = r.get('subagent_stats') if isinstance(r.get('subagent_stats'), dict) else {}
        out['result'] = {'status': 'present', **{k: r.get(k) for k in ('subtype', 'is_error', 'num_turns', 'terminal_reason', 'duration_ms',
                                                                        'duration_api_ms', 'api_error_status')},
                         'permission_denials': len(r.get('permission_denials') or []),
                         'subagents': {'spawned': sub.get('spawned'), 'failed': sub.get('failed'), 'by_type': sub.get('by_type')},
                         'model_usage': {m: {k: v.get(k) for k in ('inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens')}
                                         for m, v in (r.get('modelUsage') or {}).items() if isinstance(v, dict)}}
    main, subs = session_files(agent_dir)
    tools: Counter[str] = Counter()
    for f in (*main, *subs):
        for kind, _, name, _ in _work(_records(f)):
            if kind == 'action' and name:
                tools[name] += 1
    out['transcript'] = {'files_main': len(main), 'files_subagent': len(subs),
                         'compactions': sum(1 for f in main for j in _records(f) if j.get('type') == 'system' and j.get('subtype') == 'compact_boundary'),
                         'tool_calls': dict(sorted(tools.items())), 'disallowed_tool_calls': sum(tools[t] for t in DISALLOWED)}
    return out
