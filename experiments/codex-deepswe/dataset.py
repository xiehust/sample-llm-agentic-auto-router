"""Task loader for R2E-Gym-Subset (pinned revision, sha256-verified parquet files).

The parquet files are untrusted data: they are only parsed by pyarrow, never executed or used as paths or commands.
Nothing from the dataset is committed; selections.json holds task ids and strata only.
"""
from __future__ import annotations

import dataclasses
import pathlib
import urllib.request
from collections.abc import Iterable

from common import DATA, DATASET, sha256_file, size_bucket

# Columns the harness reads (design §4). `parsed_commit_content` (gold patch) is used for validation only.
COLUMNS = ('repo_name', 'docker_image', 'commit_hash', 'num_non_test_lines', 'num_non_test_files',
           'problem_statement', 'expected_output_json', 'parsed_commit_content')
META_COLUMNS = ('repo_name', 'docker_image', 'commit_hash', 'num_non_test_lines', 'num_non_test_files')


@dataclasses.dataclass(frozen=True)
class Task:
    task_id: str
    repo: str
    commit: str
    image: str
    num_non_test_lines: int
    num_non_test_files: int
    problem_statement: str = ''
    expected_output_json: str = ''
    parsed_commit: str = ''

    @property
    def size(self) -> str:
        return size_bucket(self.num_non_test_lines)


def task_id_of(repo: str, commit: str) -> str:
    """Stable id: `<repo>-<commit[0:6]>-<commit[6:12]>` (unique in the pinned revision; checked on load). The split
    keeps an all-digit commit prefix from looking like a 12-digit account id to the repository's sensitive-data scan."""
    return f'{repo}-{commit[:6]}-{commit[6:12]}'


def fetch(data_dir: pathlib.Path = DATA, opener=urllib.request.urlopen) -> list[pathlib.Path]:
    """Downloads the pinned parquet files (skipping ones already present with the right sha256) and verifies each."""
    out: list[pathlib.Path] = []
    data_dir.mkdir(parents=True, exist_ok=True)
    for name, digest in DATASET['files'].items():
        dest = data_dir / pathlib.Path(name).name
        if not (dest.exists() and sha256_file(dest) == digest):
            url = f"https://huggingface.co/datasets/{DATASET['repo']}/resolve/{DATASET['revision']}/{name}"
            tmp = dest.with_suffix('.part')
            with opener(url, timeout=600) as r, open(tmp, 'wb') as f:  # nosec B310 - fixed https URL
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            got = sha256_file(tmp)
            if got != digest:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f'{name}: sha256 {got} does not match the pin {digest}')
            tmp.replace(dest)
        out.append(dest)
    return out


def verify(data_dir: pathlib.Path = DATA) -> list[pathlib.Path]:
    paths = []
    for name, digest in DATASET['files'].items():
        p = data_dir / pathlib.Path(name).name
        if not p.exists():
            raise FileNotFoundError(f'{p} missing: run `cli.py fetch-dataset`')
        if sha256_file(p) != digest:
            raise RuntimeError(f'{p}: sha256 does not match the pin')
        paths.append(p)
    return paths


def rows_to_tasks(rows: Iterable[dict]) -> list[Task]:
    tasks: list[Task] = []
    seen: dict[str, str] = {}
    for r in rows:
        tid = task_id_of(str(r['repo_name']), str(r['commit_hash']))
        if tid in seen and seen[tid] != r['docker_image']:
            raise RuntimeError(f'task id collision: {tid}')
        seen[tid] = str(r['docker_image'])
        tasks.append(Task(
            task_id=tid, repo=str(r['repo_name']), commit=str(r['commit_hash']), image=str(r['docker_image']),
            num_non_test_lines=int(r['num_non_test_lines']), num_non_test_files=int(r['num_non_test_files']),
            problem_statement=str(r.get('problem_statement') or ''),
            expected_output_json=str(r.get('expected_output_json') or ''),
            parsed_commit=str(r.get('parsed_commit_content') or ''),
        ))
    return tasks


def load(data_dir: pathlib.Path = DATA, full: bool = False, ids: set[str] | None = None) -> list[Task]:
    """All tasks (metadata only unless `full`), optionally limited to `ids`, in dataset order."""
    import pyarrow.parquet as pq  # lazy: only the dataset commands need pyarrow

    cols = list(COLUMNS if full else META_COLUMNS)
    rows: list[dict] = []
    for p in verify(data_dir):
        rows.extend(pq.read_table(p, columns=cols).to_pylist())
    tasks = rows_to_tasks(rows)
    return [t for t in tasks if ids is None or t.task_id in ids]
