"""Codex `exec --json` event stream (pinned 0.166.0, codex-rs/exec/src/exec_events.rs) → per-run summary.

`turn.completed.usage` is the thread's running total (event_processor_with_jsonl_output: usage_from_last_total), so
the last one is the run's total. A run that is interrupted or fails has no turn.completed; the proxy's per-call log
is the cost source either way.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

# D5: commands that try to reach the network (counted and reported; the container has no route out anyway).
NETWORK_PATTERNS = {
    'pip-install': re.compile(r'\b(pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\b'),
    'curl': re.compile(r'\bcurl\b'),
    'wget': re.compile(r'\bwget\b'),
    'git-remote': re.compile(r'\bgit\s+(clone|fetch|pull|push|ls-remote|submodule\s+update)\b'),
    'package-manager': re.compile(r'\b(apt(-get)?|yum|dnf|apk|conda|npm|yarn)\s+(install|add|update)\b'),
    'netcat': re.compile(r'\b(nc|ncat|netcat|socat|telnet)\s'),
    'ssh': re.compile(r'\b(ssh|scp|sftp|rsync)\s'),
    'python-http': re.compile(r'\b(urllib\.request|requests\.(get|post)|http\.client|socket\.(create_connection|socket))\b'),
    'dns': re.compile(r'\b(nslookup|dig)\s|\bgetent\s+hosts\b'),
}


def parse_line(line: str) -> dict[str, Any] | None:
    line = line.strip()
    if not line.startswith('{'):
        return None
    try:
        e = json.loads(line)
    except ValueError:
        return None
    return e if isinstance(e, dict) and isinstance(e.get('type'), str) else None


def network_hits(command: str) -> list[str]:
    return [k for k, rx in NETWORK_PATTERNS.items() if rx.search(command)]


def summarize(lines: list[str] | str) -> dict[str, Any]:
    if isinstance(lines, str):
        lines = lines.splitlines()
    types: Counter[str] = Counter()
    items: Counter[str] = Counter()
    usage: dict[str, int] | None = None
    errors: list[str] = []
    failed: str | None = None
    commands = 0
    cmd_failed = 0
    net: Counter[str] = Counter()
    file_changes = 0
    turns = 0
    thread_id = None
    last_message_chars = 0
    for raw in lines:
        e = parse_line(raw)
        if not e:
            continue
        t = e['type']
        types[t] += 1
        if t == 'thread.started':
            thread_id = e.get('thread_id')
        elif t == 'turn.started':
            turns += 1
        elif t == 'turn.completed':
            u = e.get('usage') or {}
            usage = {k: int(u.get(k) or 0) for k in ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
                                                    'output_tokens', 'reasoning_output_tokens')}
        elif t == 'turn.failed':
            failed = _code(((e.get('error') or {}).get('message')) or '')
        elif t == 'error':
            errors.append(_code(e.get('message') or ''))
        elif t == 'item.completed':
            it = e.get('item') or {}
            kind = it.get('type') or 'unknown'
            items[kind] += 1
            if kind == 'command_execution':
                commands += 1
                if it.get('exit_code') not in (0, None) or it.get('status') == 'failed':
                    cmd_failed += 1
                for h in network_hits(str(it.get('command') or '')):
                    net[h] += 1
            elif kind == 'file_change':
                file_changes += 1
            elif kind == 'agent_message':
                last_message_chars = len(str(it.get('text') or ''))
            elif kind == 'error':
                errors.append(_code(str(it.get('message') or '')))
    return {
        'thread_id': thread_id, 'turns': turns, 'completed': types['turn.completed'] > 0, 'failed': failed,
        'usage': usage, 'commands': commands, 'commands_failed': cmd_failed, 'file_changes': file_changes,
        'items': dict(items), 'events': dict(types), 'errors': errors[:20], 'network_commands': dict(net),
        'network_command_total': sum(net.values()), 'last_message_chars': last_message_chars,
    }


_CODE = re.compile(r'[^a-z0-9:_./ <>-]+')


def _code(message: str) -> str:
    """A short, text-free label for an error message (lower-cased, first 80 chars, digits kept, no quotes)."""
    m = message.strip().lower()
    m = re.sub(r'`[^`]*`', '<x>', m)
    return _CODE.sub('', m)[:80]
