"""Shared paths, pins and small helpers for the Codex x DeepSWE harness (stdlib only)."""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import pathlib
import re
import tempfile
import threading
from collections.abc import Iterable, Iterator
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / 'results'          # gitignored: events, patches, grading logs, ledger, per-call logs
DATA = HERE / 'data'                # gitignored: the dataset parquet files
BIN = HERE / 'bin'                  # gitignored: the pinned Codex binary
SELECTIONS = HERE / 'selections.json'   # committed: task ids, strata, arms (no dataset text)
CANDIDATES = HERE / 'candidates.json'   # committed: the tier-pass candidate ids

SEED = 20261105

# Dataset pin: Hugging Face R2E-Gym/R2E-Gym-Subset (Apache-2.0), revision and LFS sha256 of every parquet file.
DATASET = {
    'repo': 'R2E-Gym/R2E-Gym-Subset',
    'revision': '2e8108ff942f24fcb5686badfaf7f9a8808566d5',
    'license': 'Apache-2.0',
    'files': {
        'data/train-00000-of-00008.parquet': '09c44f9d70be1aeda517735d9ef1c7dcc4ffa8d701f403a7f5f6055eb158ea04',
        'data/train-00001-of-00008.parquet': 'e7f64726f8707c05787d3238567d0c78f08dbd0ddc43f60638e8c75dd31ac1a8',
        'data/train-00002-of-00008.parquet': '9083b80453997fe855a5b8f59a3211bdcec092419a4bc79fab858b5607a09f7f',
        'data/train-00003-of-00008.parquet': 'e54f4199d6db5823fb3527297b1ee31f886a17a407f35646789952fceba3496b',
        'data/train-00004-of-00008.parquet': 'd7d045224a72f2ce9ed61de776f290c165de314bc65af44ff4fe88a96a31dbb8',
        'data/train-00005-of-00008.parquet': '24ad6911efeb05974ee533f05d07c609cce718fa25493e540bb0765dec845c2c',
        'data/train-00006-of-00008.parquet': 'ff510fe60b7789626be936d0a57965542b4336210fd87ac61ffd7bfd3f08f74e',
        'data/train-00007-of-00008.parquet': '5d7bbd6155f9d269331d32e4cc3783275db5f98e46ed8c1b8896a8e959931489',
    },
}

# R2E-Gym harness pin: the conventions in r2e.py are copied from this commit (Apache-2.0).
R2E_GYM = {'repo': 'https://github.com/R2E-Gym/R2E-Gym', 'commit': '0d94c4eb9431cd195c55a7ea3abd54006c9a1735'}

_REGION: list[str] = []


def set_region(region: str) -> None:
    """The experiment Region (a deploy parameter, never hardcoded): selects the bundled price catalog and the
    bedrock-runtime host. Set once by cli.py from --region / AWS_REGION."""
    if not re.fullmatch(r'[a-z]{2}(-[a-z]+)+-\d', region):
        raise ValueError(f'not a Region name: {region!r}')
    _REGION[:] = [region]


def region() -> str:
    if not _REGION:
        raise RuntimeError('the experiment Region is not set (cli.py --region or AWS_REGION)')
    return _REGION[0]


def catalog_path(r: str | None = None) -> pathlib.Path:
    return REPO / 'packages' / 'pricing' / 'data' / f'catalog.{r or region()}.json'

ARM_MODELS = {
    'A': 'global.openai.gpt-6.1-sol',     # pin standard (router default tier)
    'F': 'global.openai.gpt-6-luna',      # pin fast (design §11)
    'C': 'global.openai.gpt-6-astra',     # pin frontier
    'B': None,                            # auto + assessor
    'D': 'global.openai.gpt-6.1-sol',     # direct to bedrock-runtime, no gateway or router
}
# Arms that go through the gateway with `model: "auto"` and an `x-router-hint: pin=<id>` header.
ARM_PIN = {'A': ARM_MODELS['A'], 'F': ARM_MODELS['F'], 'C': ARM_MODELS['C']}
ARMS = tuple(ARM_MODELS)
POOL_MODELS = ('global.openai.gpt-6-astra', 'global.openai.gpt-6.1-sol', 'global.openai.gpt-6-luna')
ASSESSOR_MODEL = 'global.openai.gpt-6-luna'

_ACCOUNT_RE = re.compile(r'(?<!\d)\d{12}(?!\d)')


def mask(text: str) -> str:
    """Masks 12-digit numbers (account ids) in anything that reaches results/ or the console."""
    return _ACCOUNT_RE.sub('<acct>', text)


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: pathlib.Path, data: Any) -> None:
    """Atomic JSON write (temp file + rename). Refuses NaN/inf so every output stays strict JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False, sort_keys=False) + '\n'
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def read_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding='utf-8'))


_append_lock = threading.Lock()


def append_jsonl(path: pathlib.Path, row: dict[str, Any]) -> None:
    line = json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n'
    with _append_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())


def read_jsonl(path: pathlib.Path) -> Iterator[dict[str, Any]]:
    """Yields objects from a JSONL file; skips blank and malformed lines (e.g. a torn last line after a crash)."""
    if not path.exists():
        return
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                yield obj


def size_bucket(num_non_test_lines: int) -> str:
    """Change-size stratum (design §4): ≤ 10 / 11–40 / > 40 non-test lines."""
    return 'small' if num_non_test_lines <= 10 else 'medium' if num_non_test_lines <= 40 else 'large'


def uniq(xs: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in xs:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out
