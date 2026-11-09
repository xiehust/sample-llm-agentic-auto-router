"""Terminal-Bench 2.1 dataset pin and runner network check (TB design §4.2–4.3). Pure functions; 17's driver calls
them in `fetch-tasks`, `prepull` and at the start of `run`/`check`, and shardplan's builder calls `plan_pins`.

- fetch: the pinned commit of the dataset repository (clone --no-checkout, fetch, checkout --detach, HEAD check);
- verify: the plan's tasks == the manifest's (`tasks/dataset.toml`) == the task dirs, and per task Harbor's own
  `Packager.compute_content_hash` == the plan's digest == the manifest's digest;
- images: each task's tag is pinned by the registry digest recorded in the plan (pull `repo@digest`, tag it
  `repo:tag`; Harbor's prebuilt compose then never pulls), checked against RepoDigests at start;
- the online network (`llmar-online`, created by infra) must exist with exactly the contract's options;
- task facts for harvest and the report: labels and numbers from task.toml, never text.

Digests are stored in the plan as unpadded base64url (64-hex digests can contain bare 12-digit runs; N5). Every git or
docker call goes through an injected `run(argv) -> CompletedProcess`. Nothing here creates or removes a network.
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import re
import shutil
import subprocess  # nosec B404 - fixed argv: git, docker, Harbor's own python
import tomllib
import urllib.request
from collections.abc import Callable, Iterable
from typing import Any

Run = Callable[[list[str]], subprocess.CompletedProcess]
MANIFEST = 'dataset.toml'
TASK_PREFIX = 'terminal-bench/'
ONLINE_NETWORK = {'name': 'llmar-online', 'driver': 'bridge', 'bridge': 'br-llmon', 'subnet': '10.201.0.0/24', 'icc': False,
                  'masquerade': True, 'internal': False, 'ipv6': False}
_HEX40 = re.compile(r'[0-9a-f]{40}')
_HEX64 = re.compile(r'[0-9a-f]{64}')
_IMAGE = re.compile(r'(?P<repo>[a-z0-9]+(?:[._-][a-z0-9]+)*/[a-z0-9]+(?:[._-][a-z0-9]+)*):(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})')


class NetworkMismatch(ValueError):
    pass


def _default_run(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=1800)  # nosec B603


# ---------------------------------------------------------------- digests (hex <-> plan's base64url)

def hex_to_b64(digest: str) -> str:
    h = digest.removeprefix('sha256:')
    if not _HEX64.fullmatch(h):
        raise ValueError('not a sha256 hex digest')
    return base64.urlsafe_b64encode(bytes.fromhex(h)).decode().rstrip('=')


def b64_to_hex(b64: str) -> str:
    raw = base64.urlsafe_b64decode(b64 + '=' * (-len(b64) % 4))
    if len(raw) != 32:
        raise ValueError('not a sha256 digest')
    return raw.hex()


_DIGEST_SCRIPT = ('import json, pathlib, sys\n'
                  'from harbor.publisher.packager import Packager\n'
                  'print(json.dumps({d: Packager.compute_content_hash(pathlib.Path(d))[0] for d in sys.argv[1:]}))\n')


def harbor_python() -> str | None:
    """Harbor's own interpreter: $HARBOR_PYTHON, else the shebang of the `harbor` executable (the uv tool layout on the
    runners: /usr/local/bin/harbor → its tool venv's python). The driver's venv has no Harbor (17)."""
    exe = os.environ.get('HARBOR_PYTHON')
    if exe:
        return exe
    h = os.environ.get('HARBOR_BIN') or shutil.which('harbor')
    if not h:
        return None
    try:
        first = pathlib.Path(h).read_bytes()[:512].split(b'\n', 1)[0].decode()
    except OSError:
        return None
    py = first[2:].strip().split()[0] if first.startswith('#!') and first[2:].strip() else ''
    return py if py and pathlib.Path(py).is_file() else None


def content_digests(task_dirs: Iterable[pathlib.Path], run: Run | None = None) -> dict[str, str]:
    """Harbor's own task content hash (file selection and .gitignore filtering as `harbor sync`/publish), by task dir
    name. In-process when Harbor is importable, else one batched call of Harbor's own interpreter (same algorithm)."""
    dirs = [pathlib.Path(d) for d in task_dirs]
    if not dirs:
        return {}
    if run is None:
        try:
            from harbor.publisher.packager import Packager
        except ImportError:
            pass
        else:
            return {d.name: Packager.compute_content_hash(d)[0] for d in dirs}
    py = harbor_python()
    if not py:
        raise RuntimeError('no Harbor interpreter: set HARBOR_PYTHON or put harbor on PATH')
    r = (run or _default_run)([py, '-I', '-c', _DIGEST_SCRIPT, *map(str, dirs)])
    if r.returncode != 0:
        raise RuntimeError(f'Harbor digest helper failed (exit {r.returncode})')
    got = json.loads((r.stdout or '').strip().splitlines()[-1])
    out = {pathlib.Path(k).name: v for k, v in got.items()}
    if set(out) != {d.name for d in dirs} or not all(_HEX64.fullmatch(v) for v in out.values()):
        raise RuntimeError('Harbor digest helper returned an incomplete answer')
    return out


def content_digest(task_dir: pathlib.Path) -> str:
    return content_digests([task_dir])[task_dir.name]


# ---------------------------------------------------------------- checkout

def fetch(root: pathlib.Path, url: str, commit_hex: str, run: Run = _default_run) -> str:
    """The dataset repository at `commit_hex` (the full 40-hex commit) under `root`; returns HEAD."""
    if not _HEX40.fullmatch(commit_hex):
        raise ValueError('commit must be the full 40-hex hash')
    if not url.startswith('https://'):
        raise ValueError('repository URL must be https')

    def git(*args: str) -> str:
        r = run(['git', *args])
        if r.returncode != 0:
            raise SystemExit(f'git {args[0] if args[0] != "-C" else args[2]} failed (exit {r.returncode})')
        return (r.stdout or '').strip()

    if not (root / '.git').is_dir():
        git('clone', '--quiet', '--no-checkout', url, str(root))
    git('-C', str(root), 'fetch', '--quiet', 'origin', commit_hex)
    git('-C', str(root), 'checkout', '--quiet', '--detach', commit_hex)
    head = git('-C', str(root), 'rev-parse', 'HEAD')
    if head != commit_hex:
        raise SystemExit('dataset HEAD differs from the plan commit')
    return head


def manifest_digests(checkout: pathlib.Path) -> dict[str, str]:
    """task id → hex digest from `tasks/dataset.toml` (names `terminal-bench/<id>`)."""
    m = tomllib.loads((checkout / 'tasks' / MANIFEST).read_text(encoding='utf-8'))
    out: dict[str, str] = {}
    for t in m.get('tasks', []):
        name = str(t.get('name', ''))
        if not name.startswith(TASK_PREFIX):
            raise ValueError(f'manifest task outside {TASK_PREFIX}')
        tid = name[len(TASK_PREFIX):]
        if tid in out:
            raise ValueError(f'manifest lists {tid} twice')
        out[tid] = str(t.get('digest', '')).removeprefix('sha256:')
    return out


def task_dirs(checkout: pathlib.Path) -> set[str]:
    return {p.name for p in (checkout / 'tasks').iterdir() if p.is_dir() and (p / 'task.toml').is_file()}


def verify(plan: dict[str, Any], checkout: pathlib.Path, tasks: Iterable[str], run: Run | None = None) -> list[str]:
    """Issues (ids only) with the checkout: the global task set, then per task in `tasks` the content digest."""
    issues: list[str] = []
    try:
        man = manifest_digests(checkout)
    except (OSError, ValueError, tomllib.TOMLDecodeError) as e:
        return [f'manifest unreadable: {type(e).__name__}']
    # a derived plan (Claude Code) leaves out its pre-registered drops; they are still in the checkout and the manifest
    planned, dirs = set(plan['tasks']) | set((plan.get('dataset') or {}).get('dropped') or []), task_dirs(checkout)
    for what, a, b in (('plan', planned, set(man)), ('task dirs', dirs, set(man))):
        if a != b:
            issues.append(f'task set: {what} vs manifest differ ({len(a - b)} extra, {len(b - a)} missing)')
    tasks = sorted(tasks)
    todo = sorted(t for t in tasks if t in dirs)
    digests = content_digests([checkout / 'tasks' / t for t in todo], run)
    for t in sorted(tasks):
        want = (plan['tasks'].get(t) or {}).get('digest_b64')
        if not want:
            issues.append(f'{t}: no digest in the plan')
            continue
        if t not in dirs:
            issues.append(f'{t}: missing')
            continue
        got = digests[t]
        if hex_to_b64(got) != want:
            issues.append(f'{t}: content digest differs from the plan')
        if man.get(t) != got:
            issues.append(f'{t}: content digest differs from the manifest')
    return issues


# ---------------------------------------------------------------- images

def split_image(image: str) -> tuple[str, str]:
    m = _IMAGE.fullmatch(image)
    if not m:
        raise ValueError(f'unexpected image reference {image!r} (want <owner>/<name>:<tag>)')
    return m['repo'], m['tag']


def image_pull_args(plan_task: dict[str, Any]) -> tuple[str, str]:
    """(`repo@sha256:<pinned>` to pull, `repo:tag` to tag it as) for one plan task."""
    repo, tag = split_image(plan_task['image'])
    return f"{repo}@sha256:{b64_to_hex(plan_task['image_digest_b64'])}", f'{repo}:{tag}'


def check_images(plan: dict[str, Any], tasks: Iterable[str], run: Run) -> list[str]:
    """Each task's local `repo:tag` must carry the pinned digest in RepoDigests (else Harbor would run another image)."""
    issues = []
    for t in sorted(tasks):
        ref, tag = image_pull_args(plan['tasks'][t])
        r = run(['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', tag])
        if r.returncode != 0:
            issues.append(f'{t}: image not present')
            continue
        try:
            digests = json.loads((r.stdout or '').strip() or '[]')
        except ValueError:
            digests = []
        if ref not in digests:
            issues.append(f'{t}: local image is not the pinned digest')
    return issues


def registry_digest(image: str, timeout: float = 30.0, opener: Callable[..., Any] = urllib.request.urlopen) -> tuple[str, int]:
    """(top-level manifest digest, compressed linux/amd64 bytes) of a public Docker Hub image, by anonymous read-only
    registry requests (0c approved; dev box only, at plan build). The digest is what `docker pull repo:tag` records
    in RepoDigests; the index must contain linux/amd64."""
    repo, tag = split_image(image)
    tok = json.load(opener(f'https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull', timeout=timeout))['token']
    accept = ', '.join(('application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
                        'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'))

    def get(ref: str) -> tuple[dict[str, Any], str]:
        req = urllib.request.Request(f'https://registry-1.docker.io/v2/{repo}/manifests/{ref}',
                                     headers={'Authorization': f'Bearer {tok}', 'Accept': accept})
        with opener(req, timeout=timeout) as r:
            return json.load(r), r.headers.get('Docker-Content-Digest', '')

    top, digest = get(tag)
    if not _HEX64.fullmatch(digest.removeprefix('sha256:')):
        raise ValueError(f'{image}: registry returned no content digest')
    manifest = top
    if 'manifests' in top:          # an index: the linux/amd64 entry
        amd = [m for m in top['manifests'] if (m.get('platform') or {}).get('os') == 'linux' and (m.get('platform') or {}).get('architecture') == 'amd64']
        if not amd:
            raise ValueError(f'{image}: no linux/amd64 manifest')
        manifest, _ = get(amd[0]['digest'])
    size = int((manifest.get('config') or {}).get('size') or 0) + sum(int(x.get('size') or 0) for x in manifest.get('layers') or [])
    return digest.removeprefix('sha256:'), size


def plan_pins(checkout: pathlib.Path, tasks: Iterable[str], image_digest: Callable[[str], tuple[str, int]] = registry_digest
              ) -> dict[str, dict[str, Any]]:
    """Per task, what the plan records: content digest (checked against the manifest), image tag, image digest and
    compressed size. `image_digest` is injected (the registry, or 17's runner-collected file)."""
    man = manifest_digests(checkout)
    tasks = sorted(tasks)
    digests = content_digests([checkout / 'tasks' / t for t in tasks])
    out: dict[str, dict[str, Any]] = {}
    for t in tasks:
        got = digests[t]
        if man.get(t) != got:
            raise ValueError(f'{t}: content digest differs from the manifest')
        image = task_image(checkout / 'tasks' / t)
        d, size = image_digest(image)
        out[t] = {'digest_b64': hex_to_b64(got), 'image': image, 'image_digest_b64': hex_to_b64(d), 'image_bytes': int(size)}
    return out


# ---------------------------------------------------------------- the online network (infra creates it; this only checks)

def check_online_network(run: Run, name: str = ONLINE_NETWORK['name']) -> dict[str, Any]:
    """The inspected network, or NetworkMismatch naming the first differing field (missing network included)."""
    r = run(['docker', 'network', 'inspect', name])
    if r.returncode != 0:
        raise NetworkMismatch(f'network {name} is missing (infra creates it in internet mode)')
    try:
        d = json.loads(r.stdout)[0]
    except (ValueError, IndexError, TypeError):
        raise NetworkMismatch(f'network {name}: unreadable inspect output') from None
    opts = d.get('Options') or {}
    subnets = [c.get('Subnet') for c in ((d.get('IPAM') or {}).get('Config') or [])]
    got = {'name': d.get('Name'), 'driver': d.get('Driver'), 'bridge': opts.get('com.docker.network.bridge.name'),
           'subnet': subnets[0] if len(subnets) == 1 else subnets, 'icc': opts.get('com.docker.network.bridge.enable_icc') == 'true',
           'masquerade': opts.get('com.docker.network.bridge.enable_ip_masquerade', 'true') == 'true',
           'internal': bool(d.get('Internal')), 'ipv6': bool(d.get('EnableIPv6'))}
    want = {**ONLINE_NETWORK, 'name': name}
    for k, v in want.items():
        if got[k] != v:
            raise NetworkMismatch(f'network {name}: {k} is {got[k]!r}, expected {v!r}')
    return {**got, 'id': d.get('Id')}


# ---------------------------------------------------------------- task facts

def task_image(task_dir: pathlib.Path) -> str:
    img = (tomllib.loads((task_dir / 'task.toml').read_text(encoding='utf-8')).get('environment') or {}).get('docker_image')
    if not isinstance(img, str) or not img:
        raise ValueError(f'{task_dir.name}: no environment.docker_image')
    return img


def task_facts(task_dir: pathlib.Path) -> dict[str, Any]:
    """Labels and numbers only (never description, keywords, tags, authors or instruction text)."""
    cfg = tomllib.loads((task_dir / 'task.toml').read_text(encoding='utf-8'))
    md, env = cfg.get('metadata') or {}, cfg.get('environment') or {}

    def num(x: Any) -> float | None:
        return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None

    def label(x: Any) -> str | None:
        return x if isinstance(x, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,40}', x) else None
    return {'category': label(md.get('category')), 'difficulty': label(md.get('difficulty')),
            'expert_min': num(md.get('expert_time_estimate_min')), 'junior_min': num(md.get('junior_time_estimate_min')),
            'agent_timeout_s': num((cfg.get('agent') or {}).get('timeout_sec')), 'verifier_timeout_s': num((cfg.get('verifier') or {}).get('timeout_sec')),
            'cpus': num(env.get('cpus')), 'memory_mb': num(env.get('memory_mb'))}
