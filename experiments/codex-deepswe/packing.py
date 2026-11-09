"""Reproducible tarball of the harness for the runner (shipped over SSM; no git remote needed).

Contents: experiments/codex-deepswe (minus results/, data/, bin/ and caches) and packages/pricing/data (the price
catalogs pricing.py reads), with repository-relative paths. Byte-identical for identical inputs: sorted entries,
mtime 0, uid/gid 0, no owner names, modes 0644 / 0755 (executables and directories), gzip header with mtime 0 and
no file name. Only regular files and directories; symlinks are refused.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import os
import pathlib
import tarfile

from common import HERE, REPO

ROOTS = ('experiments/codex-deepswe', 'packages/pricing/data')
EXCLUDE_DIRS = {'results', 'data', 'bin', '__pycache__', '.ruff_cache', '.pytest_cache', '.mypy_cache', 'node_modules'}
EXCLUDE_SUFFIXES = ('.pyc', '.pyo')


def members(repo: pathlib.Path = REPO, roots: tuple[str, ...] = ROOTS) -> list[pathlib.PurePosixPath]:
    """Repository-relative paths (dirs and files), sorted. Exclusions apply below the experiment root only for
    `data`/`bin`/`results` (packages/pricing/data is itself a root)."""
    out: set[pathlib.PurePosixPath] = set()
    for root in roots:
        base = repo / root
        if not base.is_dir():
            raise FileNotFoundError(f'{base} missing')
        out.add(pathlib.PurePosixPath(root))
        for dirpath, dirnames, filenames in os.walk(base):
            rel_dir = pathlib.Path(dirpath).relative_to(repo)
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
            for d in dirnames:
                p = pathlib.Path(dirpath) / d
                if p.is_symlink():
                    raise ValueError(f'refusing symlink {p.relative_to(repo)}')
                out.add(pathlib.PurePosixPath(rel_dir.as_posix()) / d)
            for f in filenames:
                p = pathlib.Path(dirpath) / f
                if f.endswith(EXCLUDE_SUFFIXES):
                    continue
                if p.is_symlink() or not p.is_file():
                    raise ValueError(f'refusing non-regular file {p.relative_to(repo)}')
                out.add(pathlib.PurePosixPath(rel_dir.as_posix()) / f)
    return sorted(out)


def build(out: pathlib.Path, repo: pathlib.Path = REPO, roots: tuple[str, ...] = ROOTS) -> dict[str, object]:
    buf = io.BytesIO()
    paths = members(repo, roots)
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for rel in paths:
            src = repo / rel
            ti = tarfile.TarInfo(rel.as_posix())
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ''
            if src.is_dir():
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                tar.addfile(ti)
            else:
                data = src.read_bytes()
                ti.size = len(data)
                ti.mode = 0o755 if os.access(src, os.X_OK) else 0o644
                tar.addfile(ti, io.BytesIO(data))
    raw = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as gz:
        gz.write(buf.getvalue())
    blob = raw.getvalue()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    return {'path': str(out), 'sha256': hashlib.sha256(blob).hexdigest(), 'bytes': len(blob),
            'files': sum(1 for p in paths if (repo / p).is_file())}


DEFAULT_OUT = HERE / 'results' / 'llmar-experiment.tar.gz'
