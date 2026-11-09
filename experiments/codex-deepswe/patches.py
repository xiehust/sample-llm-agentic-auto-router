"""Agent patch extraction and filtering (design D12).

The patch is `git add -A && git diff --cached` in /testbed (R2E-Gym's get_patch), minus test files (R2E-Gym's
FileDiff.is_test_file rule) and build or scratch artefacts. Files are split on `diff --git` headers.
"""
from __future__ import annotations

import re
from typing import Any

import r2e

GET_PATCH = 'git add -A && git diff --cached'
_HEADER = re.compile(r'^diff --git a/(.+?) b/(.+)$')

ARTEFACT_DIRS = ('__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.eggs',
                 '.codex', 'node_modules', '.venv', 'r2e_tests')
TOP_LEVEL_ARTEFACT_DIRS = ('build', 'dist')   # review G3: only at the repository root (a package may have build/ code)
ARTEFACT_SUFFIXES = ('.pyc', '.pyo', '.so', '.o', '.a', '.dylib', '.pyd', '.orig', '.rej', '.log', '.egg-info')
C_EXT_SUFFIXES = ('.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.pyx', '.pxd', '.pxi', '.f', '.f90')


def split(diff: str) -> list[tuple[str, str]]:
    """[(path, chunk)] in order; the path is the b/ side of each `diff --git` header."""
    out: list[tuple[str, str]] = []
    cur: list[str] = []
    path = ''
    for line in diff.splitlines(keepends=True):
        m = _HEADER.match(line.rstrip('\n'))
        if m:
            if cur:
                out.append((path, ''.join(cur)))
            path, cur = m.group(2), [line]
        elif cur:
            cur.append(line)
    if cur:
        out.append((path, ''.join(cur)))
    return out


def drop_reason(path: str, chunk: str) -> str | None:
    parts = path.split('/')
    if path in r2e.SKIP_FILES or parts[0] == 'r2e_tests':
        return 'hidden-test-path'
    if r2e.is_test_file(path):
        return 'test-file'
    if any(p in ARTEFACT_DIRS or p.endswith('.egg-info') for p in parts[:-1]) or parts[-1] in ARTEFACT_DIRS:
        return 'artefact'
    if len(parts) > 1 and parts[0] in TOP_LEVEL_ARTEFACT_DIRS:
        return 'artefact'
    if path.endswith(ARTEFACT_SUFFIXES):
        return 'artefact'
    if '\nBinary files ' in chunk or '\nGIT binary patch' in chunk:
        return 'binary'
    return None


def filter_patch(diff: str) -> tuple[str, list[dict[str, str]]]:
    kept: list[str] = []
    dropped: list[dict[str, str]] = []
    for path, chunk in split(diff):
        why = drop_reason(path, chunk)
        if why:
            dropped.append({'path': path, 'why': why})
        else:
            kept.append(chunk)
    return ''.join(kept), dropped


def stats(diff: str) -> dict[str, Any]:
    files = split(diff)
    added = removed = 0
    for _, chunk in files:
        for line in chunk.splitlines():
            if line.startswith('+') and not line.startswith('+++'):
                added += 1
            elif line.startswith('-') and not line.startswith('---'):
                removed += 1
    return {'files': len(files), 'added': added, 'removed': removed, 'bytes': len(diff.encode()),
            'paths': [p for p, _ in files]}


def touches_c_ext(diff: str) -> bool:
    return any(p.endswith(C_EXT_SUFFIXES) for p, _ in split(diff))


# R2E-Gym's runtime has no rebuild step; images ship with extensions built in place. When a patch touches extension
# sources the grader rebuilds in place with the repo's own setup.py (same command for gold and agent patches).
REBUILD_COMMAND = 'python setup.py build_ext --inplace'
