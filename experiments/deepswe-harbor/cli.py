"""DeepSWE v1.1 x Codex via Harbor: offline commands of the integration (design §4–5). The live driver is 17's.

  stage-codex   download the pinned Codex release asset, check its sha256, write bin/codex-<v>-<arch>
  stage-claude-code  download the pinned Claude Code builds (glibc + musl), check the release manifest and each
                sha256 against hcommon.CLAUDE_CODE, write bin/claude-<v>-<platform> and the mount wrapper
  job           print the Harbor job config for one trial (what the driver writes per attempt)
  dryrun        Harbor + Codex + proxy against the mock router (no AWS, no real token)
  harvest       merged attempt meta + trial dirs + proxy calls → results rows (classifier's scores)
"""
from __future__ import annotations

import argparse
import json
import pathlib
import platform
import shutil
import sys
import tarfile
import tempfile
import urllib.request

import hcommon
import codex_setup
from common import read_json, sha256_file, write_json


def _arch() -> str:
    m = platform.machine()
    return 'x86_64' if m in ('x86_64', 'AMD64') else 'aarch64' if m in ('aarch64', 'arm64') else m


def verified_codex(arch: str) -> pathlib.Path:
    p = hcommon.codex_bin(arch)
    meta = p.with_name(p.name + '.sha256.json')
    if not p.exists() or not meta.exists():
        sys.exit(f'{p} missing: run `cli.py stage-codex --arch {arch}`')
    if sha256_file(p) != read_json(meta)['binary_sha256']:
        sys.exit(f'{p}: sha256 changed since stage-codex')
    return p


def cmd_stage_codex(a: argparse.Namespace) -> None:
    """Same pin and checks as codex-deepswe `fetch-codex` (the release asset's sha256 is pinned in codex_setup)."""
    asset = codex_setup.CODEX['assets'][a.arch]
    url = f"https://github.com/openai/codex/releases/download/{codex_setup.CODEX['tag']}/{asset['name']}"
    dest = hcommon.codex_bin(a.arch)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent) as td:
        tgz = pathlib.Path(td) / asset['name']
        with urllib.request.urlopen(url, timeout=600) as r, open(tgz, 'wb') as f:  # nosec B310 - fixed https URL
            shutil.copyfileobj(r, f)
        got = sha256_file(tgz)
        if got != asset['sha256']:
            sys.exit(f"{asset['name']}: sha256 {got} != pinned {asset['sha256']}")
        with tarfile.open(tgz) as t:
            m = t.getmember(asset['member'])
            if not m.isfile():
                sys.exit('unexpected archive member')
            src = t.extractfile(m)
            with open(dest, 'wb') as f:
                shutil.copyfileobj(src, f)  # type: ignore[arg-type]
    dest.chmod(0o755)
    write_json(dest.with_name(dest.name + '.sha256.json'), {'asset': asset['name'], 'asset_sha256': got,
                                                            'binary_sha256': sha256_file(dest), 'version': codex_setup.CODEX['version']})
    print('ok', dest)


def cmd_stage_claude_code(a: argparse.Namespace) -> None:
    """The pinned native builds for one arch (glibc and musl). The release manifest must list the pinned sha256 for each
    platform, and each download must match it; the mount wrapper is written next to them."""
    import harbor_job_cc

    cc = hcommon.CLAUDE_CODE
    with urllib.request.urlopen(f"{cc['base_url']}/{cc['version']}/manifest.json", timeout=60) as r:  # nosec B310 - fixed https URL
        manifest = json.load(r)
    if manifest.get('version') != cc['version']:
        sys.exit(f"manifest version {manifest.get('version')!r} != pinned {cc['version']}")
    for musl in (False, True):
        plat = hcommon.claude_platform(a.arch, musl)
        want = cc['sha256'][plat]
        listed = ((manifest.get('platforms') or {}).get(plat) or {}).get('checksum')
        if listed != want:
            sys.exit(f'{plat}: manifest lists {listed!r}, pinned {want}')
        dest = hcommon.claude_bin(plat)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=dest.parent) as td:
            tmp = pathlib.Path(td) / 'claude'
            with urllib.request.urlopen(f"{cc['base_url']}/{cc['version']}/{plat}/claude", timeout=900) as r, open(tmp, 'wb') as f:  # nosec B310
                shutil.copyfileobj(r, f)
            got = sha256_file(tmp)
            if got != want:
                sys.exit(f'{plat}: sha256 {got} != pinned {want}')
            tmp.chmod(0o755)
            tmp.replace(dest)
        write_json(dest.with_name(dest.name + '.sha256.json'), {'platform': plat, 'binary_sha256': got, 'version': cc['version'],
                                                                'commit': manifest.get('commit')})
        print('ok', dest)
    harbor_job_cc.WRAPPER.write_text(harbor_job_cc.WRAPPER_TEXT, encoding='utf-8')
    harbor_job_cc.WRAPPER.chmod(0o755)
    print('ok', harbor_job_cc.WRAPPER)


def verified_claude(platform: str) -> pathlib.Path:
    """The staged build, re-hashed against the pin (job start)."""
    p = hcommon.claude_bin(platform)
    if not p.exists():
        sys.exit(f'{p} missing: run `cli.py stage-claude-code`')
    if sha256_file(p) != hcommon.CLAUDE_CODE['sha256'][platform]:
        sys.exit(f'{p}: sha256 differs from the pin')
    return p


def cmd_job(a: argparse.Namespace) -> None:
    import harbor_job

    url = f'http://{a.proxy_host}:{a.proxy_port}/r/{a.trial_id}/v1'
    print(json.dumps(harbor_job.job_config(arm=a.arm, trial_id=a.trial_id, task_dir=pathlib.Path(a.task_dir).resolve(),
                                           jobs_dir=pathlib.Path(a.jobs_dir).resolve(), job_name=a.trial_id, base_url=url),
                     indent=2))


def cmd_dryrun(a: argparse.Namespace) -> None:
    import dryrun

    rep = dryrun.main(a.proxy_host, a.proxy_port, verified_codex(_arch()),
                      task_dir=pathlib.Path(a.task_dir).resolve() if a.task_dir else None, arms=tuple(a.arms),
                      blackhole_dns=a.blackhole_dns,
                      instruction_from=pathlib.Path(a.instruction_from).resolve() if a.instruction_from else None,
                      region=a.region, profile=a.profile)
    print(json.dumps({k: rep[k] for k in ('out', 'trials', 'proxy', 'mock')}, indent=2))


def cmd_harvest(a: argparse.Namespace) -> None:
    import harvest

    n = harvest.harvest(pathlib.Path(a.meta), pathlib.Path(a.calls), pathlib.Path(a.out))
    print(f'{n} rows → {a.out}')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('stage-codex')
    p.add_argument('--arch', choices=sorted(codex_setup.CODEX['assets']), default=_arch())
    p.set_defaults(fn=cmd_stage_codex)
    p = sub.add_parser('stage-claude-code')
    p.add_argument('--arch', default='x86_64', choices=('x86_64', 'aarch64'))
    p.set_defaults(fn=cmd_stage_claude_code)
    p = sub.add_parser('job')
    p.add_argument('--arm', choices=hcommon.ARMS, required=True)
    p.add_argument('--trial-id', required=True)
    p.add_argument('--task-dir', required=True)
    p.add_argument('--jobs-dir', default=str(hcommon.RESULTS / 'trials'))
    p.add_argument('--proxy-host', default=hcommon.PROXY_HOST)
    p.add_argument('--proxy-port', type=int, default=hcommon.PROXY_PORT)
    p.set_defaults(fn=cmd_job)
    p = sub.add_parser('dryrun')
    p.add_argument('--proxy-host', required=True, help="this host's docker0 address (private IPv4; never 0.0.0.0)")
    p.add_argument('--proxy-port', type=int, default=hcommon.PROXY_PORT)
    p.add_argument('--task-dir', help='a real task dir (x86 runner); default: the local stand-in task')
    p.add_argument('--arms', nargs='+', choices=hcommon.ARMS, default=list(hcommon.ARMS))
    p.add_argument('--region', help='the experiment Region (price catalog only; default $AWS_REGION); no AWS calls')
    p.add_argument('--instruction-from', help="a DeepSWE task dir whose instruction.md the stand-in uses (body capture)")
    p.add_argument('--blackhole-dns', help='container DNS server that never answers (e.g. 192.0.2.53, as on the runner)')
    p.add_argument('--profile', choices=('deepswe', 'tb21'), default='deepswe',
                   help='tb21: a Terminal-Bench-shaped stand-in on the online network (ONLINE_NETWORK / ONLINE_DNS set)')
    p.set_defaults(fn=cmd_dryrun)
    p = sub.add_parser('harvest')
    p.add_argument('--meta', required=True, help="17's results/merged/harvest-meta.jsonl")
    p.add_argument('--calls', required=True, help='results/merged/calls.jsonl')
    p.add_argument('--out', default=str(hcommon.RESULTS / 'results.jsonl'))
    p.set_defaults(fn=cmd_harvest)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
