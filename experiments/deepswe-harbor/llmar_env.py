"""Harbor's local Docker environment with a real no-network mode (design §4.7; review 18 F1).

Harbor 0.25.0 implements every restricted policy, `no-network` included, with its egress sidecar (gost +
nftables in a shared network namespace). The task container keeps Docker's default NET_RAW, so raw packets can
bypass the nftables filter; and on the runner a container on any bridge can reach the proxy port. For an
environment whose every phase policy is `no-network` (the separate verifier; the oracle and nop checks), this
subclass runs the main service with compose `network_mode: none` (loopback only) and no sidecar at all. A
policy switch on such an environment is a no-op: none is stricter than any policy Harbor could ask for.

The agent environment (phase policy: allowlist = the proxy) keeps Harbor's sidecar, and its main service drops
NET_RAW (compose/main-cap-drop-net-raw.json; review 18): no raw or packet sockets, so the sidecar's nftables
cannot be bypassed from the task container. Codex, git and test suites use plain TCP; ping still works through
Docker's ping_group_range. The host firewall stays the second layer.
Used through `environment.import_path = "llmar_env:LlmarDockerEnvironment"`; Harbor copies the environment config
into the separate verifier environment, so both get this class.

**Online mode** (Terminal-Bench 2.1, TB design §4.2): an environment whose every phase policy is `public` (the task
sets allow_internet and has a shared verifier) joins the runner's one fixed network instead of a per-trial compose
network: a compose overlay generated from the runner env keys ONLINE_NETWORK and ONLINE_DNS (a3's contract; no
literal in code) attaches `main` to that external network, sets its DNS, and drops NET_RAW. The runner firewall
(infra, `-i br-llmon`) allows only DNS to the VPC resolver and TCP 80/443 to public IPv4 from it. Fail-closed: no
keys, an invalid value, a task with its own compose file, or a missing network → the environment never starts.
After start it records the container's host-side veth (`llmar-net.json`), the join key for the kernel connection
log. DeepSWE has no all-public environment, so its behaviour is unchanged (golden test).
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import hcommon
from harbor.environments.capabilities import EnvironmentCapabilities
from harbor.environments.docker import COMPOSE_NO_NETWORK_PATH
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import NetworkMode, NetworkPolicy

IMPORT_PATH = 'llmar_env:LlmarDockerEnvironment'
ONLINE_KEYS = hcommon.ONLINE_KEYS
_NET_NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,31}')
NET_RECORD = hcommon.NET_RECORD     # in the trial dir: the join key for the runner's kernel connection log
CAP_DROP_NET_RAW = Path(__file__).resolve().parent / 'compose' / 'main-cap-drop-net-raw.json'
log = logging.getLogger(__name__)


def all_denied(phase_network_policies: Sequence[NetworkPolicy]) -> bool:
    return bool(phase_network_policies) and all(p.network_mode == NetworkMode.NO_NETWORK for p in phase_network_policies)


def all_public(phase_network_policies: Sequence[NetworkPolicy]) -> bool:
    return bool(phase_network_policies) and all(p.network_mode == NetworkMode.PUBLIC for p in phase_network_policies)


def online_settings(environ: Mapping[str, str] | None = None) -> tuple[str, str]:
    """(network, dns) from the runner env keys; ValueError if either is missing or malformed (fail-closed)."""
    e = os.environ if environ is None else environ
    net, dns = (e.get(k, '').strip() for k in ONLINE_KEYS)
    if not net or not dns:
        raise ValueError('llmar_env online mode: ONLINE_NETWORK and ONLINE_DNS must be set (runner env, CONTAINER_EGRESS=internet)')
    if not _NET_NAME.fullmatch(net):
        raise ValueError(f'llmar_env online mode: bad ONLINE_NETWORK {net!r}')
    try:
        ip = ipaddress.ip_address(dns)
    except ValueError:
        raise ValueError(f'llmar_env online mode: ONLINE_DNS {dns!r} is not an IP literal') from None
    if ip.version != 4:
        raise ValueError('llmar_env online mode: ONLINE_DNS must be IPv4 (the network is IPv4 only)')
    return net, dns


def online_overlay(network: str, dns: str) -> dict[str, Any]:
    """Compose overlay for an online environment: main on the external runner network only, its DNS, no NET_RAW.
    `external: true` means compose never creates or removes the network (infra owns it)."""
    return {'services': {'main': {'networks': {network: {}}, 'dns': [dns], 'cap_drop': ['NET_RAW']}},
            'networks': {network: {'external': True, 'name': network}}}


def parse_net_probe(text: str) -> dict[str, Any]:
    """`cat /sys/class/net/eth0/iflink /proc/net/fib_trie` from inside the container → {iflink, ip} (the local,
    non-loopback IPv4 address from the fib trie's `/32 host LOCAL` entries)."""
    lines = text.splitlines()
    iflink = int(lines[0].strip()) if lines and lines[0].strip().isdigit() else None
    ips: list[str] = []
    for i, ln in enumerate(lines):
        if '/32 host LOCAL' in ln and i > 0:
            m = re.search(r'(\d+\.\d+\.\d+\.\d+)\s*$', lines[i - 1])
            if m and not m.group(1).startswith('127.') and m.group(1) not in ips:
                ips.append(m.group(1))
    return {'iflink': iflink, 'ip': ips[0] if len(ips) == 1 else None, 'ips': ips}


def host_veth(ifindex: int | None, sys_class_net: Path = Path('/sys/class/net')) -> str | None:
    """The host interface whose ifindex is the container's eth0 iflink: the veth the kernel log names as PHYSIN."""
    if ifindex is None or not sys_class_net.is_dir():
        return None
    for d in sorted(sys_class_net.iterdir()):
        try:
            if int((d / 'ifindex').read_text().strip()) == ifindex:
                return d.name
        except (OSError, ValueError):
            continue
    return None


class LlmarDockerEnvironment(DockerEnvironment):
    def __init__(self, *args: Any, network_policy: NetworkPolicy | None = None,
                 phase_network_policies: Sequence[NetworkPolicy] = (), **kwargs: Any) -> None:
        self.llmar_offline = all_denied(phase_network_policies)
        self.llmar_online = (not self.llmar_offline and all_public(phase_network_policies)
                             and (network_policy is None or network_policy.network_mode == NetworkMode.PUBLIC))
        self.llmar_online_compose: Path | None = None
        if self.llmar_online:
            self.llmar_online_settings = online_settings()          # before anything else: fail-closed
        super().__init__(*args, network_policy=network_policy, phase_network_policies=phase_network_policies, **kwargs)
        if self.llmar_online:
            if (self.environment_dir / 'docker-compose.yaml').exists():
                raise ValueError('llmar_env online mode: a task with its own docker-compose.yaml is not supported '
                                 '(its services would need their own network decisions)')
            path = Path(self.trial_paths.trial_dir) / 'llmar-online-compose.json'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(online_overlay(*self.llmar_online_settings), indent=1, sort_keys=True) + '\n')
            self.llmar_online_compose = path

    def _requires_egress_control(self, *, startup_network_policy: NetworkPolicy,  # type: ignore[override]
                                 phase_network_policies: Sequence[NetworkPolicy]) -> bool:
        if getattr(self, 'llmar_offline', False):
            return False
        return DockerEnvironment._requires_egress_control(startup_network_policy=startup_network_policy,
                                                          phase_network_policies=phase_network_policies)

    @property
    def _docker_compose_paths(self) -> list[Path]:  # type: ignore[override]
        paths = list(super()._docker_compose_paths)
        if getattr(self, 'llmar_online_compose', None) is not None:
            paths.append(self.llmar_online_compose)                 # the runner network, its DNS, cap_drop NET_RAW
            return paths
        paths.append(COMPOSE_NO_NETWORK_PATH if self.llmar_offline   # services.main.network_mode: none
                     else CAP_DROP_NET_RAW)                           # services.main.cap_drop: [NET_RAW]
        return paths

    @property
    def capabilities(self) -> EnvironmentCapabilities:  # type: ignore[override]
        caps = super().capabilities
        if not self.llmar_offline:
            return caps
        # Offline for its whole life: Harbor's "disable internet" and phase switches are trivially satisfied.
        return caps.model_copy(update={'disable_internet': True, 'dynamic_network_policy': True, 'stream': False})

    async def start(self, force_build: bool) -> None:
        await super().start(force_build)
        if getattr(self, 'llmar_online', False):
            await self._record_net()

    async def _record_net(self) -> None:
        """One read of the container's eth0 iflink and address before the agent runs (the agent has no NET_ADMIN, so
        it cannot replace eth0), mapped to the host veth: the kernel connection log's PHYSIN. Never fails the trial."""
        rec: dict[str, Any] = {'network': self.llmar_online_settings[0], 'at': round(time.time(), 3)}
        try:
            r = await self.exec('cat /sys/class/net/eth0/iflink /proc/net/fib_trie', timeout_sec=30)
            probe = parse_net_probe(r.stdout or '') if r.return_code == 0 else {'iflink': None, 'ip': None, 'ips': []}
            rec.update(probe, veth=host_veth(probe['iflink']), rc=r.return_code)
        except Exception as e:  # noqa: BLE001 - a missing record degrades the join to IP + window, nothing more
            rec['error'] = type(e).__name__
        try:
            (Path(self.trial_paths.trial_dir) / NET_RECORD).write_text(json.dumps(rec, sort_keys=True) + '\n')
        except OSError as e:
            log.warning('llmar_env: could not write %s: %s', NET_RECORD, e)

    async def _apply_network_policy(self, network_policy: NetworkPolicy) -> None:
        if getattr(self, 'llmar_online', False):
            if network_policy.network_mode != NetworkMode.PUBLIC:
                raise ValueError(f'llmar_env online mode: refusing a switch to {network_policy.network_mode.value}')
            return
        if self.llmar_offline:
            if network_policy.network_mode != NetworkMode.NO_NETWORK:
                # Stays offline (stricter); a visible warning, so a misconfiguration is not a mystery timeout.
                log.warning('llmar_env: environment is offline (network_mode none); ignoring a switch to %s',
                            network_policy.network_mode.value)
            return
        await super()._apply_network_policy(network_policy)
