"""Post-run leak scan (design §10): token-shaped strings and AWS account ids in trial artifacts and logs.

Run it on the runner over the trial dirs and the proxy/driver logs before they are uploaded, and on any file set
before a commit (N5). It never prints a matched value: each finding is kind, file, line, column and a fingerprint
(HMAC with a key drawn per scan, so repeats group within one report and nothing links across reports).

  python3 -I leakscan.py [--account-from-imds] [--exact-stdin] [--strict] [--json OUT] PATH...

- High confidence (exit 1): a Cognito-issued JWT (payload `iss` on cognito-idp), any other JWT, `Bearer <value>`
  other than the containers' dummy key, `Basic <base64 user:secret>`, AWS access key ids and session tokens, SigV4
  headers and presigned-URL signatures, a 12-digit account id inside an ARN, an ECR registry host or an
  account-id field, and any exact value given (`--exact-stdin`: one per line on stdin, e.g. the client id and
  secret; `--account-from-imds`: this instance's account id, read from IMDSv2 on the runner).
- Not reported (counted only): JWT-shaped encrypted reasoning, i.e. the Responses API's `encrypted_content` in Codex
  rollouts, a JWS-like container whose decoded payload has exactly the keys {ciphertext, protected} (no `iss`, no
  claims). Any extra or missing payload key makes it a `jwt` (or `cognito-jwt`) again, and exact values inside or
  equal to one are still reported.
- Fixture values (`--fixture-dir DIR`, repeatable; TB design §4.7): a benchmark's own task files can carry
  credential- or account-shaped test fixtures (e.g. an ARN in a task about scrubbing secrets). The fixture dirs are
  scanned first with the same per-scan key; a later finding whose fingerprint (its value's HMAC) equals one found in
  the fixtures is counted as `fixture` and not reported. Exact values (`--exact-stdin`, `--account-from-imds`) are
  never suppressed, whatever the fixtures contain, and no fixture value is kept, only its fingerprint.
- Review (exit 0 unless --strict): bare 12-digit numbers, which third-party repos and logs contain for many reasons.
  Not reviewed (counted as `opaque-signature`): a bare 12-digit run inside the opaque fields of an Anthropic thinking
  block in a JSON line (Claude Code session JSONL: `thinking.signature`, `redacted_thinking.data`), which are base64
  blobs. Only the review rule is relaxed there; every high-confidence rule and exact value still applies.
Placeholder ids (the AWS documentation's example id, and any one digit repeated 12 times) are ignored. Files that cannot be scanned are listed, never skipped
silently; .gz files are read decompressed.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import dataclasses
import gzip
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
import urllib.request
from collections import Counter
from collections.abc import Iterable, Iterator

DUMMY_BEARERS = frozenset({b'not-a-credential'})
# The AWS documentation's example account id (digits 1-9, 0, 1, 2), built at run time: no 12-digit literal in code
# (N5). Any one digit repeated twelve times is a placeholder too (checked in scan_bytes).
PLACEHOLDER_ACCOUNTS = frozenset({b''.join(b'%d' % (i % 10) for i in range(1, 13))})
MAX_FILE_BYTES = 1 << 30
WINDOW = 1 << 20          # lines longer than this are scanned in overlapping windows
OVERLAP = 4096

# (kind, severity, pattern). Group 1, when present, is the value that is fingerprinted and checked.
_RAW: tuple[tuple[str, str, str], ...] = (
    ('jwt', 'high', r'eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}'),
    ('bearer', 'high', r'(?i)\bbearer[ \t]+([A-Za-z0-9._~+/=-]{12,})'),
    ('basic-credential', 'high', r'(?i)\bbasic[ \t]+([A-Za-z0-9+/]{12,}={0,2})'),
    ('aws-access-key-id', 'high', r'(?<![A-Z0-9])((?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Z0-9])'),
    ('aws-session-token', 'high', r'(?<![A-Za-z0-9+/])((?:IQoJb3JpZ2lu|FwoGZXIvYXdz)[A-Za-z0-9+/=]{20,})'),
    ('sigv4-header', 'high', r'(AWS4-HMAC-SHA256[ \t]+Credential=[A-Za-z0-9/_-]{16,})'),
    ('sigv4-query', 'high', r'(?i)(X-Amz-Signature=[0-9a-f]{64})'),
    ('account-in-arn', 'high', r'arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):'),
    ('account-in-ecr-host', 'high', r'(?<!\d)(\d{12})\.dkr\.ecr\.'),
    ('account-field', 'high', r'(?i)(?:account[_ -]?id|"account"|owner[_ -]?id|aws[_ -]?account)["\']?\s*[:=]\s*["\']?(\d{12})(?!\d)'),
    ('bare-12-digits', 'review', r'(?<![0-9A-Za-z.])(\d{12})(?![0-9A-Za-z])'),   # not inside hashes or words
)
PATTERNS = tuple((k, s, re.compile(p.encode())) for k, s, p in _RAW)
ACCOUNT_KINDS = frozenset({'account-in-arn', 'account-in-ecr-host', 'account-field', 'bare-12-digits'})
# Payload keys of reasoning `encrypted_content` (a JWS-like container around ciphertext, not a credential).
ENCRYPTED_REASONING_KEYS = frozenset({'ciphertext', 'protected'})
SUPPRESSED_KINDS = frozenset({'encrypted-reasoning'})
OPAQUE_FIELDS = {'thinking': 'signature', 'redacted_thinking': 'data'}   # Anthropic content blocks: base64, not text


def opaque_spans(line: bytes) -> list[tuple[int, int]]:
    """Byte spans of the opaque thinking fields in one JSON line (any depth, e.g. inside an `api-request-blob`), [] for
    anything else. Found by value in the raw line, so a value JSON had to escape is simply not exempt."""
    if b'thinking' not in line or not line.lstrip().startswith(b'{'):
        return []
    try:
        root = json.loads(line)
    except ValueError:
        return []
    values: set[str] = set()
    stack = [root]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            f = OPAQUE_FIELDS.get(x.get('type')) if isinstance(x.get('type'), str) else None
            if f and isinstance(x.get(f), str) and len(x[f]) >= 16:
                values.add(x[f])
            stack.extend(x.values())
        elif isinstance(x, list):
            stack.extend(x)
    spans = []
    for v in values:
        b = b'"' + v.encode() + b'"'
        i = line.find(b)
        while i >= 0:
            spans.append((i + 1, i + len(b) - 1))
            i = line.find(b, i + 1)
    return spans


@dataclasses.dataclass(frozen=True)
class Finding:
    kind: str
    severity: str
    path: str
    line: int
    col: int
    fingerprint: str


@dataclasses.dataclass
class Report:
    findings: list[Finding] = dataclasses.field(default_factory=list)
    files: int = 0
    bytes: int = 0
    unscanned: list[tuple[str, str]] = dataclasses.field(default_factory=list)

    def high(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == 'high']

    def review(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == 'review']

    def summary(self) -> dict:
        return {
            'files': self.files, 'bytes': self.bytes,
            'high': dict(Counter(f.kind for f in self.high())),
            'review': dict(Counter(f.kind for f in self.review())),
            'unscanned': len(self.unscanned),
        }


def _b64url(s: bytes) -> bytes:
    return base64.urlsafe_b64decode(s + b'=' * (-len(s) % 4))


def classify_jwt(payload_b64: bytes) -> str | None:
    """'cognito-jwt' for a payload issued by Cognito, 'encrypted-reasoning' for a payload whose keys are exactly
    {ciphertext, protected}, 'jwt' for any other decodable JSON object payload, None otherwise."""
    try:
        claims = json.loads(_b64url(payload_b64))
    except (ValueError, binascii.Error):
        return None
    if not isinstance(claims, dict):
        return None
    iss = claims.get('iss')
    if isinstance(iss, str) and 'cognito-idp.' in iss:
        return 'cognito-jwt'
    if set(claims) == ENCRYPTED_REASONING_KEYS:
        return 'encrypted-reasoning'
    return 'jwt'


def is_basic_credential(value: bytes) -> bool:
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        return False
    return b':' in raw and len(raw) >= 8 and all(32 <= c < 127 for c in raw)


class Scanner:
    def __init__(self, exact: Iterable[str] = (), key: bytes | None = None, fixtures: Iterable[pathlib.Path] = ()):
        self.key = key or os.urandom(32)
        self.exact = sorted({e.strip().encode() for e in exact if e and e.strip() and len(e.strip()) >= 8}, key=len, reverse=True)
        self.exact_res = [re.compile(re.escape(e)) for e in self.exact]
        self.suppressed: Counter[str] = Counter()     # matched but not reported (SUPPRESSED_KINDS, fixture), for the summary
        self.fixture_fps: frozenset[str] = frozenset()
        self.fixture_unscanned: list[tuple[str, str]] = []
        fixtures = list(fixtures)
        if fixtures:
            # Same key, no exact values: the fingerprints of every value the fixtures themselves contain.
            ref, rep = Scanner(key=self.key), Report()
            for d in fixtures:
                ref.scan_path(pathlib.Path(d), rep)
            self.fixture_fps = frozenset(f.fingerprint for f in rep.findings)
            self.fixture_unscanned = rep.unscanned

    def fingerprint(self, value: bytes) -> str:
        return hmac.new(self.key, value, hashlib.sha256).hexdigest()[:12]

    def scan_bytes(self, data: bytes, path: str, line_no: int, col0: int = 0, opaque: list[tuple[int, int]] = ()) -> Iterator[Finding]:
        exact_spans: list[tuple[int, int]] = []
        for rx in self.exact_res:
            for m in rx.finditer(data):
                exact_spans.append(m.span())
                yield Finding('exact', 'high', path, line_no, col0 + m.start() + 1, self.fingerprint(m.group(0)))
        claimed: list[tuple[int, int]] = list(exact_spans)
        for kind, sev, rx in PATTERNS:
            for m in rx.finditer(data):
                value = m.group(1) if m.groups() else m.group(0)
                span = m.span(1) if m.groups() else m.span()
                if any(a <= span[0] < b for a, b in claimed):
                    continue      # already reported as an exact value or by a more specific pattern
                k = kind
                if kind == 'jwt':
                    k = classify_jwt(value) or ''
                    if not k:
                        continue
                    span = m.span()
                    value = m.group(0)
                    if k in SUPPRESSED_KINDS:
                        claimed.append(span)      # its base64 is not rescanned by the later patterns, as for a jwt
                        self.suppressed[k] += 1
                        continue
                    if self.fingerprint(value) in self.fixture_fps:
                        claimed.append(span)
                        self.suppressed['fixture'] += 1
                        continue
                elif kind == 'bearer' and value in DUMMY_BEARERS:
                    continue
                elif kind == 'bearer' and value.startswith(b'eyJ'):
                    continue      # the JWT pattern reports it
                elif kind == 'basic-credential' and not is_basic_credential(value):
                    continue
                elif kind in ACCOUNT_KINDS and (value in PLACEHOLDER_ACCOUNTS or len(set(value)) == 1):
                    continue
                elif sev == 'review' and any(a <= col0 + span[0] and col0 + span[1] <= b for a, b in opaque):
                    self.suppressed['opaque-signature'] += 1
                    continue
                claimed.append(span)
                fp = self.fingerprint(value)
                if fp in self.fixture_fps:        # the benchmark's own fixture value (never an exact value: those ran first)
                    self.suppressed['fixture'] += 1
                    continue
                yield Finding(k, sev, path, line_no, col0 + span[0] + 1, fp)

    def scan_stream(self, chunks: Iterable[bytes], path: str) -> Iterator[Finding]:
        seen: set[tuple[str, int, int]] = set()
        for line_no, line in enumerate(chunks, 1):
            opaque = opaque_spans(line)
            if len(line) <= WINDOW:
                yield from self.scan_bytes(line, path, line_no, 0, opaque)
                continue
            start = 0
            while start < len(line):
                piece = line[start:start + WINDOW + OVERLAP]
                for f in self.scan_bytes(piece, path, line_no, start, opaque):
                    if (f.kind, f.line, f.col) not in seen:
                        seen.add((f.kind, f.line, f.col))
                        yield f
                start += WINDOW

    def scan_path(self, root: pathlib.Path, report: Report) -> None:
        paths = [root] if root.is_file() else sorted(p for p in root.rglob('*') if p.is_file() or p.is_symlink())
        for p in paths:
            if p.is_symlink():
                report.unscanned.append((str(p), 'symlink (not followed)'))
                continue
            try:
                size = p.stat().st_size
                if size > MAX_FILE_BYTES:
                    report.unscanned.append((str(p), f'larger than {MAX_FILE_BYTES} bytes'))
                    continue
                opener = gzip.open if p.suffix == '.gz' else open
                with opener(p, 'rb') as fh:
                    report.findings.extend(self.scan_stream(fh, str(p)))
                report.files += 1
                report.bytes += size
            except (OSError, EOFError, gzip.BadGzipFile) as e:
                report.unscanned.append((str(p), type(e).__name__))


def scan_file(path: pathlib.Path | str, scanner: Scanner | None = None, review: bool = False) -> list[Finding]:
    """Findings in one regular file (.gz decompressed). High-confidence only unless review=True. Raises OSError for a
    file that cannot be read and ValueError for a symlink or a file over MAX_FILE_BYTES, so a caller that blocks on
    findings can also block on anything it could not scan. Pass one Scanner for a whole export so fingerprints group."""
    p = pathlib.Path(path)
    if p.is_symlink():
        raise ValueError('symlink (not followed)')
    if p.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f'larger than {MAX_FILE_BYTES} bytes')
    sc = scanner or Scanner()
    opener = gzip.open if p.suffix == '.gz' else open
    try:
        with opener(p, 'rb') as fh:
            found = list(sc.scan_stream(fh, str(p)))
    except (EOFError, gzip.BadGzipFile) as e:
        raise OSError(f'unreadable: {type(e).__name__}') from e
    return found if review else [f for f in found if f.severity == 'high']


def imds_account_id(timeout: float = 2.0) -> str:
    """This instance's account id from IMDSv2 (runner only). Raises if IMDS is unavailable."""
    tok_req = urllib.request.Request('http://169.254.169.254/latest/api/token', method='PUT',
                                     headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
    with urllib.request.urlopen(tok_req, timeout=timeout) as r:  # nosec B310 - fixed link-local IMDS URL
        token = r.read().decode()
    doc_req = urllib.request.Request('http://169.254.169.254/latest/dynamic/instance-identity/document',
                                     headers={'X-aws-ec2-metadata-token': token})
    with urllib.request.urlopen(doc_req, timeout=timeout) as r:  # nosec B310
        acct = json.loads(r.read()).get('accountId', '')
    if not re.fullmatch(r'\d{12}', acct or ''):
        raise RuntimeError('IMDS returned no account id')
    return acct


def render(report: Report, strict: bool, limit: int = 200, suppressed: Counter[str] | None = None) -> str:
    out = []
    shown = report.high() + (report.review() if strict else [])
    for f in shown[:limit]:
        out.append(f'{f.severity.upper():6} {f.kind:20} {f.path}:{f.line}:{f.col}  fp={f.fingerprint}')
    if len(shown) > limit:
        out.append(f'... {len(shown) - limit} more (see --json)')
    if not strict and report.review():
        by_file = Counter(f.path for f in report.review())
        out.append(f'review: {len(report.review())} bare 12-digit numbers in {len(by_file)} files (--strict lists them)')
    if suppressed:
        out.append('not reported: ' + ', '.join(f'{k}={n}' for k, n in sorted(suppressed.items())))
    for path, why in report.unscanned:
        out.append(f'UNSCANNED {path}: {why}')
    s = report.summary()
    verdict = 'FAIL' if report.high() or (strict and report.review()) else 'PASS'
    out.append(f'{verdict}: {s["files"]} files, {s["bytes"]} bytes, high={s["high"]}, review={s["review"]}, unscanned={s["unscanned"]}')
    return '\n'.join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='+', type=pathlib.Path)
    ap.add_argument('--exact-stdin', action='store_true', help='read exact values to find, one per line, from stdin')
    ap.add_argument('--account-from-imds', action='store_true', help="add this instance's account id (runner only)")
    ap.add_argument('--strict', action='store_true', help='bare 12-digit numbers fail too')
    ap.add_argument('--json', type=pathlib.Path, help='write the findings (no values) as JSON')
    ap.add_argument('--fixture-dir', type=pathlib.Path, action='append', default=[],
                    help="a benchmark's task files: values found there are counted as `fixture`, not reported (repeatable)")
    a = ap.parse_args(argv)
    exact: list[str] = []
    if a.exact_stdin:
        exact += sys.stdin.read().splitlines()
    if a.account_from_imds:
        try:
            exact.append(imds_account_id())
        except Exception as e:  # noqa: BLE001
            print(f'ERROR: --account-from-imds: {type(e).__name__}', file=sys.stderr)
            return 2
    for d in a.fixture_dir:
        if not d.is_dir():
            print(f'ERROR: --fixture-dir {d} is not a directory', file=sys.stderr)
            return 2
    sc = Scanner(exact, fixtures=a.fixture_dir)
    rep = Report()
    for p in a.paths:
        if not p.exists():
            print(f'ERROR: {p} does not exist', file=sys.stderr)
            return 2
        sc.scan_path(p, rep)
    print(render(rep, a.strict, suppressed=sc.suppressed))
    if a.json:
        a.json.write_text(json.dumps({'summary': rep.summary(), 'findings': [dataclasses.asdict(f) for f in rep.findings],
                                      'not_reported': dict(sc.suppressed), 'unscanned': rep.unscanned}, indent=1) + '\n')
    return 1 if rep.high() or (a.strict and rep.review()) else 0


if __name__ == '__main__':
    sys.exit(main())
