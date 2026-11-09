"""Docker CLI wrapper (argv lists only, no shell on the host). Task containers:
- run on the experiment's network (an --internal bridge by default; review R3 fallback: a user-defined bridge
  whose forwarding the runner's iptables rules drop), never `--network host`, never `--privileged`;
- get the same CPU / memory / pids limits (D11), no added capabilities, `no-new-privileges`;
- are labelled `llmar-experiment=codex-deepswe` so `cleanup` can find leftovers.
"""
from __future__ import annotations

import dataclasses
import json
import pathlib
import subprocess  # nosec B404 - fixed docker argv lists
import time
from collections.abc import Callable, Sequence

LABEL = 'llmar-experiment=codex-deepswe'
NETWORK = 'llmar-tasks'


@dataclasses.dataclass(frozen=True)
class Limits:
    cpus: str = '2'
    memory: str = '8g'
    pids: int = 4096


@dataclasses.dataclass
class Result:
    code: int
    out: str
    err: str
    secs: float


Runner = Callable[[Sequence[str], float | None, bytes | None], Result]

# Review F3/F4/M3: container-creating docker commands are checked against an allowlist of exactly the flags this
# harness uses (start() and ensure_network()); anything else is refused, so --restart, --privileged, -p, --cap-add,
# --ipv6, host namespaces, devices, mounts and --network host|bridge|none can never be passed.
RUN_VALUE_FLAGS = {'--name', '--platform', '--network', '--cpus', '--memory', '--memory-swap', '--pids-limit',
                   '--security-opt', '--cap-drop', '--label'}
RUN_BOOL_FLAGS = {'-d', '-t', '-i'}
EXEC_VALUE_FLAGS = {'-w', '-e'}
EXEC_BOOL_FLAGS = {'-i'}
NETWORK_CREATE_VALUE_FLAGS = {'--driver', '--label'}
NETWORK_CREATE_BOOL_FLAGS = {'--internal'}
FORBIDDEN_NETWORKS = ('host', 'bridge', 'none', 'default')
ALLOWED_VALUES = {'--security-opt': {'no-new-privileges'}, '--cap-drop': {'NET_RAW'}, '--platform': {'linux/amd64'},
                  '--driver': {'bridge'}}


class ForbiddenDockerArg(Exception):
    pass


def _check_flags(args: list[str], value_flags: set[str], bool_flags: set[str], network: str | None = None) -> int:
    """Walks flags up to the first positional (the image, or the network name); returns its index."""
    i = 0
    while i < len(args):
        a = args[i]
        if not a.startswith('-'):
            return i
        flag, eq, inline = a.partition('=')
        if flag in bool_flags and not eq:
            i += 1
            continue
        if flag not in value_flags:
            raise ForbiddenDockerArg(f'refusing docker flag {flag}')
        if eq:
            val = inline
            i += 1
        else:
            if i + 1 >= len(args):
                raise ForbiddenDockerArg(f'{flag} needs a value')
            val = args[i + 1]
            i += 2
        if flag in ALLOWED_VALUES and val not in ALLOWED_VALUES[flag]:
            raise ForbiddenDockerArg(f'refusing {flag} {val}')
        if flag == '--network' and (val in FORBIDDEN_NETWORKS or val.startswith('container:')):
            raise ForbiddenDockerArg(f'refusing --network {val}')
        if flag == '--network' and network is not None and val != network:
            raise ForbiddenDockerArg(f'refusing --network {val}: not the experiment network {network}')
    raise ForbiddenDockerArg('no image / name after the flags')


def check_argv(argv: Sequence[str], network: str | None = None) -> None:
    """`network`: the configured experiment network; `run --network` must name exactly it (review F2)."""
    args = list(argv)
    sub = args[1:2]
    if sub == ['run']:
        end = _check_flags(args[2:], RUN_VALUE_FLAGS, RUN_BOOL_FLAGS, network) + 2
        if network is not None and not any(a == '--network' or a.startswith('--network=') for a in args[2:end]):
            raise ForbiddenDockerArg('docker run without --network')
    elif sub == ['exec']:
        # Review F2: only -w, -e and -i before the container name; what follows the name is the command.
        _check_flags(args[2:], EXEC_VALUE_FLAGS, EXEC_BOOL_FLAGS)
    elif args[1:3] == ['network', 'create']:
        _check_flags(args[3:], NETWORK_CREATE_VALUE_FLAGS, NETWORK_CREATE_BOOL_FLAGS)
    elif args[1:2] == ['network'] and args[2:3] != ['inspect']:
        raise ForbiddenDockerArg(f'refusing docker network {args[2] if len(args) > 2 else ""}'.strip())
    elif sub in (['create'], ['update'], ['container'], ['compose'], ['service'], ['swarm'], ['plugin'], ['context']):
        raise ForbiddenDockerArg(f'refusing docker {sub[0]}')
    # cp / rm / ps / pull / image inspect / version / network inspect: no container-creating flags


def _run(argv: Sequence[str], timeout: float | None = None, stdin: bytes | None = None) -> Result:
    t0 = time.time()
    try:
        p = subprocess.run(list(argv), input=stdin, capture_output=True, timeout=timeout)  # nosec B603
        return Result(p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace'), time.time() - t0)
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b'').decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else ''
        return Result(124, out, 'host-timeout', time.time() - t0)


class Docker:
    def __init__(self, runner: Runner = _run, docker: str = 'docker', network: str | None = None):
        """`network`: the experiment network every `docker run` must use (None only in unit tests of other code)."""
        self.r = runner
        self.d = docker
        self.network = network

    def _x(self, *args: str, timeout: float | None = 120, stdin: bytes | None = None) -> Result:
        argv = [self.d, *args]
        check_argv(argv, self.network)
        return self.r(argv, timeout, stdin)

    # ------------------------------------------------------------ network
    def ensure_network(self, name: str = NETWORK, internal: bool = True) -> dict:
        r = self._x('network', 'inspect', name)
        if r.code != 0:
            args = ['network', 'create', '--driver', 'bridge', '--label', LABEL]
            if internal:
                args.append('--internal')
            c = self._x(*args, name)
            if c.code != 0:
                raise RuntimeError(f'docker network create failed: {c.err.strip()[:200]}')
            r = self._x('network', 'inspect', name)
        info = json.loads(r.out)[0]
        if bool(info.get('Internal')) != internal:
            raise RuntimeError(f'network {name} exists with Internal={info.get("Internal")}; remove it or pick another name')
        return info

    @staticmethod
    def gateway_ip(info: dict) -> str:
        for cfg in (info.get('IPAM') or {}).get('Config') or []:
            if cfg.get('Gateway'):
                return str(cfg['Gateway'])
        raise RuntimeError('the network has no IPv4 gateway address')

    # ------------------------------------------------------------ containers
    def pull(self, image: str, timeout: float = 1800) -> Result:
        return self._x('pull', '--platform', 'linux/amd64', image, timeout=timeout)

    def start(self, image: str, name: str, network: str, limits: Limits, run_label: str) -> Result:
        """`docker run -d -t -i <image> /bin/bash`, as R2E-Gym starts its containers (tty, stdin open)."""
        return self._x('run', '-d', '-t', '-i', '--name', name, '--platform', 'linux/amd64', '--network', network,
                       '--cpus', limits.cpus, '--memory', limits.memory, '--memory-swap', limits.memory,
                       '--pids-limit', str(limits.pids), '--security-opt', 'no-new-privileges', '--cap-drop', 'NET_RAW',
                       '--label', LABEL, '--label', f'llmar-run={run_label}', image, '/bin/bash', timeout=300)

    def sh(self, name: str, script: str, timeout: int, workdir: str = '/testbed', env: dict[str, str] | None = None) -> Result:
        """`docker exec -w <workdir> -e ... <name> /bin/sh -c <script>`, as R2E-Gym's run() does (the in-container
        `timeout N` prefix is part of `script`, see r2e.wrap); the host-side timeout is a backstop."""
        args = ['exec', '-w', workdir]
        for k, v in (env or {}).items():
            args += ['-e', f'{k}={v}']
        args += [name, '/bin/sh', '-c', script]
        return self._x(*args, timeout=timeout + 30)

    def exec_argv(self, name: str, argv: Sequence[str], timeout: float, workdir: str, env: dict[str, str],
                  stdout_path: pathlib.Path, stderr_path: pathlib.Path) -> Result:
        """Streams the command's stdout to a file (the Codex JSONL); no stdin (`docker exec` without -i)."""
        args = [self.d, 'exec', '-w', workdir]
        for k, v in env.items():
            args += ['-e', f'{k}={v}']
        args += [name, *argv]
        check_argv(args, self.network)
        t0 = time.time()
        with open(stdout_path, 'wb') as out, open(stderr_path, 'wb') as err:
            p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=out, stderr=err)  # nosec B603
            try:
                code = p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                p.kill()
                code = p.wait()
                code = 124 if code in (0, -9) else code
        return Result(code, '', '', time.time() - t0)

    def cp_in(self, name: str, src: pathlib.Path, dest: str) -> Result:
        return self._x('cp', str(src), f'{name}:{dest}', timeout=300)

    def write_file(self, name: str, dest: str, content: bytes, mode: str = '0644') -> Result:
        """Writes bytes to a path in the container through stdin (no host temp file, no shell interpolation)."""
        r = self._x('exec', '-i', name, '/bin/sh', '-c', 'umask 077; cat > "$1" && chmod "$2" "$1"', 'sh', dest, mode,
                    stdin=content, timeout=120)
        return r

    def read_file(self, name: str, path: str, timeout: int = 120) -> Result:
        return self._x('exec', name, 'cat', path, timeout=timeout)

    def rm(self, name: str) -> Result:
        return self._x('rm', '-f', '-v', name, timeout=120)

    def leftovers(self) -> list[str]:
        r = self._x('ps', '-a', '--filter', f'label={LABEL}', '--format', '{{.Names}}')
        return [x for x in r.out.split() if x]

    def image_arch(self, image: str) -> str | None:
        r = self._x('image', 'inspect', '--format', '{{.Architecture}}', image)
        return r.out.strip() or None if r.code == 0 else None

    def version(self) -> str:
        r = self._x('version', '--format', '{{.Server.Version}}')
        return r.out.strip()
