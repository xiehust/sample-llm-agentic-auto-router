"""Isolation suite (design §10; criteria agreed by 18 and 0c). Runs the checks, judges them, writes one JSON report.

  python3 isolation.py run --where runner|devbox [--env llmar|plain] [--proxy-host 172.17.0.1] [--proxy-port 8088]
                           [--region R] [--harbor EXE] [--image IMAGE] [--aws-sg sg.json [--aws-instances inst.json]]
                           [--skip harbor,bridge,host] [--out DIR]

On the runners, 17's `fleet.py isolation` runs it as the systemd unit `llmar-isolation`:
  $WORK_DIR/venv/bin/python -I .../experiments/deepswe-harbor/isolation.py run --where runner --env llmar \
      --harbor harbor --region <fleet --region> --out $WORK_DIR/results/isolation; echo isolation-exit=$?
after a host `docker pull -q` of PROBE_IMAGE (fleet reads it from this module; `driver.py prepull` imports it), and
exports results/isolation/** with the run's results. Exit 0 = every gate passed, 1 = a gate failed, 2 = usage.
  python3 isolation.py aws --sg sg.json [--instances inst.json]     # judge describe-* JSON only (fetched read-only by 0c)
  python3 isolation.py run --where runner --profile tb21 --env llmar --harbor harbor --region R --out DIR   # TB 2.1 gates

Gates (PASS/FAIL; `info` never gates; `runner-only` = measured but gating only with --where runner, because the
dev box has no runner firewall):
  1 verifier env: only `lo` (packet socket: info)
  2 agent main: AF_PACKET socket creation fails with EPERM
  3 agent main through the sidecar: proxy answers; HTTPS to a public IP, IMDS, public DNS fail; other host ports
    give no reply (runner-only part: other host ports)
  4 plain bridge containers (docker0 and a user-defined network): same as 3; the proxy port is the only host port
    that accepts a connection (runner-only)
  5 host: TCP listeners only on loopback and the proxy address; UDP 68/5355 info (runner-only); security group has
    no inbound rules (from --aws-sg)
  L leakscan.py (18's, unchanged) over this run's outputs: no high finding
  P the probe image is present (pulled on the host by digest when missing; infra does not pre-pull it)

Profile tb21 (Terminal-Bench 2.1, TB design §4.6): the trial container is on the runner's online network (llmar_env
online mode, from ONLINE_NETWORK / ONLINE_DNS in the environment or --env-file), with a shared verifier. Gates, each
in the agent and the verifier phase: O1 internet (public DNS, TLS 443, HTTP 80), O1b egress limits (public 22/8443
refused fast, UDP 53 and QUIC to public blocked, the VPC resolver answers on 53 only), O2 metadata, O3 private ranges
and the host's own IP, O4 host (the proxy answers, nothing else), O5 peer containers (same network, docker0, a pool
bridge), O6 no published port and no DNAT, O7 no packet socket, O8 the network's contract and the container's
interfaces and DNS, O9 the probe's own connections in the kernel log (prefix, IP and veth). DeepSWE's gate 4 (other
bridges still offline), 5 (host listeners, security group), L and P as before.

The Harbor part is a real Harbor 0.25.0 trial: the oracle agent on a synthetic probe task (image --image, prebuilt),
whose solve.sh runs isoprobe.py in the agent environment (agent-phase allowlist = the proxy, like real trials) and
whose test.sh runs it in the separate verifier environment. `--env plain` uses Harbor's own DockerEnvironment (the
"before"); `--env llmar` (default) uses llmar_env (offline verifier, NET_RAW dropped in the agent's main).
Starts a RunnerProxy (no routes, no token) on the proxy address when nothing listens there yet; reuses the driver's
otherwise. No AWS calls.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import pathlib
import shutil
import socket
import subprocess  # nosec B404 - fixed argv: docker, harbor, ss, python
import sys
import textwrap
import time
import uuid
from typing import Any

_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:      # runnable as `python -I isolation.py` (fleet.py runs scripts isolated)
    sys.path.insert(0, str(_HERE))

import hcommon  # noqa: E402
import harbor_job  # noqa: E402

HERE = hcommon.HERE
# python:3.13-slim, multi-arch index digest (bash is required in Harbor's main container). Not in the runner's
# PREPULL_IMAGES (infra is frozen): `run` pulls it on the host by digest before anything else (ensure_image).
PROBE_IMAGE = 'python:3.13-slim@sha256:09a17cad02668ae61ece136b4fd36ac3849e14f670ebedb637ea3e15580525bc'
INFO_UDP_PORTS = (68, 5355)


# ---------------------------------------------------------------- judging (pure)

def _g(ok: bool, detail: Any, kind: str = 'gate') -> dict[str, Any]:
    return {'status': 'PASS' if ok else 'FAIL', 'kind': kind, 'detail': detail}


def _no_reply(t: dict[str, Any] | None) -> bool:
    return not t or t.get('reply') != 'bytes'


def _no_connect(t: dict[str, Any] | None) -> bool:
    return not t or t.get('connect') != 'ok'


def _dns_failed(d: dict[str, Any] | None) -> bool:
    d = d or {}
    return str(d.get('getaddrinfo', '')).startswith('failed') and d.get('getent') != 'resolved'


def judge_verifier(p: dict[str, Any] | None) -> dict[str, Any]:
    if not p:
        return _g(False, 'no verifier probe output')
    return {**_g(p.get('interfaces') == ['lo'], {'interfaces': p.get('interfaces')}),
            'info': {'packet_socket': p.get('packet_socket'), 'proxy_http': p.get('proxy_http')}}


def judge_agent_caps(p: dict[str, Any] | None) -> dict[str, Any]:
    if not p:
        return _g(False, 'no agent probe output')
    return {**_g(p.get('packet_socket') == 'EPERM', {'packet_socket': p.get('packet_socket')}),
            'info': {'raw_inet_socket': p.get('raw_inet_socket')}}


def judge_sidecar(p: dict[str, Any] | None, where: str) -> dict[str, Any]:
    """Behind the egress sidecar a connect always succeeds locally; a reply (or a TLS handshake) is what counts."""
    if not p:
        return _g(False, 'no agent probe output')
    sub = {
        'proxy_replies': (p.get('proxy_http') or {}).get('reply') == 'bytes',
        'internet_tls_fails': (p.get('internet_tls') or {}).get('handshake') != 'ok',
        'internet_tcp80_no_reply': _no_reply(p.get('internet_tcp80')),
        'imds_no_reply': _no_reply(p.get('imds_http')),
        'public_dns_fails': _dns_failed(p.get('dns')),
    }
    replied = sorted(k for k, t in (p.get('host_ports') or {}).items() if not _no_reply(t))
    out = _g(all(sub.values()), {**sub, 'host_ports_replied': replied})
    if replied:
        if where == 'runner':
            out['status'] = 'FAIL'
        else:
            out['runner_only'] = {'host_ports_no_reply': 'FAIL on this host (no runner firewall here)', 'replied': replied}
    return out


def judge_bridge(probes: dict[str, dict[str, Any] | None], proxy: str) -> dict[str, Any]:
    """Plain bridge containers, no sidecar: the connect itself is the evidence."""
    detail: dict[str, Any] = {}
    ok = True
    for net, p in probes.items():
        if not p:
            detail[net] = 'no probe output'
            ok = False
            continue
        open_ports = sorted(k for k, t in (p.get('host_ports') or {}).items() if not _no_connect(t))
        sub = {
            'proxy_replies': (p.get('proxy_http') or {}).get('reply') == 'bytes',
            'internet_tls_fails': (p.get('internet_tls') or {}).get('handshake') != 'ok',
            'internet_tcp80_blocked': _no_connect(p.get('internet_tcp80')),
            'imds_blocked': _no_connect(p.get('imds_http')),
            'public_dns_fails': _dns_failed(p.get('dns')),
            'only_proxy_port_open': not open_ports,
        }
        detail[net] = {**sub, 'open_host_ports': open_ports}
        ok = ok and all(sub.values())
    return {**_g(ok, detail), 'kind': 'runner-only'}


def parse_ss(text: str) -> list[str]:
    """Local addresses from `ss -H -ltn` / `-lun` (column 4)."""
    out = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            out.append(parts[3])
    return out


def _split(addr: str) -> tuple[str, int]:
    host, _, port = addr.rpartition(':')
    host = host.strip('[]').split('%', 1)[0]
    return host, int(port) if port.isdigit() else -1


def judge_host_listeners(tcp: list[str], udp: list[str], proxy_host: str, proxy_port: int) -> dict[str, Any]:
    bad = []
    for a in tcp:
        h, p = _split(a)
        try:
            loop = ipaddress.ip_address(h).is_loopback
        except ValueError:
            loop = h in ('localhost',)
        if loop or (h == proxy_host and p == proxy_port):
            continue
        bad.append(a)
    udp_info = [a for a in udp if _split(a)[1] in INFO_UDP_PORTS]
    udp_other = [a for a in udp if _split(a)[1] not in INFO_UDP_PORTS and not _is_loop(_split(a)[0])]
    return {**_g(not bad, {'tcp_unexpected': bad, 'tcp_all': tcp}), 'kind': 'runner-only',
            'info': {'udp_68_5355': udp_info, 'udp_other': udp_other}}


def _is_loop(h: str) -> bool:
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def judge_aws(sg_doc: dict[str, Any], instances_doc: dict[str, Any] | None = None) -> dict[str, Any]:
    """`aws ec2 describe-security-groups --group-ids <runner sg>` (and optionally describe-instances) JSON."""
    groups = sg_doc.get('SecurityGroups') or []
    inbound = {g.get('GroupId', '?'): len(g.get('IpPermissions') or []) for g in groups}
    out = _g(bool(groups) and not any(inbound.values()), {'inbound_rules': inbound})
    if not groups:
        out['detail'] = 'no security groups in the JSON'
    if instances_doc:
        info = []
        for r in instances_doc.get('Reservations') or []:
            for i in r.get('Instances') or []:
                md = i.get('MetadataOptions') or {}
                sgs = sorted(g.get('GroupId') for g in i.get('SecurityGroups') or [])
                info.append({'instance': i.get('InstanceId'), 'imds_tokens': md.get('HttpTokens'),
                             'imds_hop_limit': md.get('HttpPutResponseHopLimit'), 'security_groups': sgs,
                             'sgs_judged': all(s in inbound for s in sgs)})
        out['info'] = info
        if any(not x['sgs_judged'] for x in info):
            out['status'] = 'FAIL'
            out['detail'] = {**out['detail'], 'error': 'an instance security group is missing from --aws-sg'}
    return out


# ---------------------------------------------------------------- judging, profile tb21 (pure)

ONLINE_PRIVATE = ('10.0.0.1', '172.16.0.1', '192.168.0.1', '100.64.0.1')
CONN_LOG_PREFIX = 'llmar-online: '


def _phases(probes: dict[str, dict[str, Any] | None], fn) -> tuple[bool, dict[str, Any]]:
    detail: dict[str, Any] = {}
    ok = True
    for phase, p in probes.items():
        if not p:
            detail[phase] = 'no probe output'
            ok = False
            continue
        sub = fn(p)
        detail[phase] = sub
        ok = ok and all(v for k, v in sub.items() if not k.startswith('_'))
    return ok, detail


def judge_online_internet(probes: dict[str, dict[str, Any] | None]) -> dict[str, Any]:
    return _g(*_phases(probes, lambda p: {
        'public_dns_resolves': all(str((d or {}).get('getaddrinfo')) == 'resolved' for d in (p.get('dns') or {}).values()) and bool(p.get('dns')),
        'tls_443_ok': (p.get('internet_tls') or {}).get('handshake') == 'ok',
        'http_80_reply': (p.get('internet_http80') or {}).get('reply') == 'bytes'}))


def judge_online_limits(probes: dict[str, dict[str, Any] | None]) -> dict[str, Any]:
    def fn(p: dict[str, Any]) -> dict[str, Any]:
        pt = p.get('public_tcp') or {}
        vr = p.get('vpc_resolver_link_local') or {}
        return {'public_other_ports_refused_fast': bool(pt) and all(t.get('connect') == 'refused' and float(t.get('s', 99)) < 2.0 for t in pt.values()),
                'public_udp53_blocked': (p.get('public_udp53') or {}).get('result') != 'reply',
                'public_quic_blocked': (p.get('public_quic') or {}).get('result') != 'reply',
                'vpc_resolver_answers_53': (vr.get('udp53') or {}).get('result') == 'reply',
                'vpc_resolver_no_443': _no_connect(vr.get('tcp443'))}
    return {**_g(*_phases(probes, fn)), 'kind': 'runner-only'}


def _tcp_closed(p: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    t = p.get('tcp') or {}
    connected = sorted(k for k in keys if not _no_connect(t.get(k)))
    missing = sorted(k for k in keys if k not in t)
    return {'none_connect': not connected and not missing, '_connected': connected, '_missing': missing}


def judge_online_metadata(probes: dict[str, dict[str, Any] | None]) -> dict[str, Any]:
    def fn(p):
        out = _tcp_closed(p, ['169.254.169.254:80', '169.254.170.2:80'])
        out['imds_v6_no_connect'] = _no_connect(p.get('imds_v6'))
        return out
    return {**_g(*_phases(probes, fn)), 'kind': 'runner-only'}


def judge_online_private(probes: dict[str, dict[str, Any] | None], host_ip: str | None, vpc_dns: str | None,
                         private: tuple[str, ...]) -> dict[str, Any]:
    def fn(p):
        keys = [f'{h}:80' for h in private] + ([f'{vpc_dns}:53'] if vpc_dns else [])
        keys += [k for k in (p.get('tcp') or {}) if host_ip and k.startswith(f'{host_ip}:')]
        out = _tcp_closed(p, keys)
        out['host_ip_probed'] = host_ip is not None and any(k.startswith(f'{host_ip}:') for k in (p.get('tcp') or {}))
        return out
    return {**_g(*_phases(probes, fn)), 'kind': 'runner-only'}


def judge_online_host(probes: dict[str, dict[str, Any] | None], proxy: str, where: str) -> dict[str, Any]:
    ph = proxy.rsplit(':', 1)[0]

    def fn(p):
        gw = p.get('gateway')
        keys = [k for k in (p.get('tcp') or {}) if k != proxy and (k.startswith(f'{ph}:') or (gw and k.startswith(f'{gw}:')))]
        return {'proxy_replies': (p.get('proxy_http') or {}).get('reply') == 'bytes', **_tcp_closed(p, keys)}
    ok, detail = _phases(probes, fn)
    out = _g(ok, detail)
    proxy_ok = all(isinstance(d, dict) and d['proxy_replies'] for d in detail.values())
    if where != 'runner' and proxy_ok and not ok:      # other host ports answer on a host without the runner firewall
        out = {**_g(True, detail), 'runner_only': {'other_host_ports_closed': 'FAIL on this host (no runner firewall here)'}}
    return out


def judge_online_peers(probes: dict[str, dict[str, Any] | None], peers: dict[str, str]) -> dict[str, Any]:
    return {**_g(*_phases(probes, lambda p: {**_tcp_closed(p, list(peers.values())), '_peers': peers})), 'kind': 'runner-only'}


def judge_inbound(ports: list[str], nat_rules: str | None, network: str, subnet: str) -> dict[str, Any]:
    published = sorted(x for x in ports if x.strip())
    dnat = None if nat_rules is None else [ln for ln in nat_rules.splitlines() if 'DNAT' in ln and (subnet.rsplit('.', 1)[0] in ln or network in ln)]
    return {**_g(not published and dnat == [], {'published_ports': published, 'dnat_rules': dnat,
                                                 'error': None if nat_rules is not None else 'iptables -t nat unreadable'}), 'kind': 'runner-only'}


def judge_caps_online(probes: dict[str, dict[str, Any] | None]) -> dict[str, Any]:
    return _g(*_phases(probes, lambda p: {'packet_socket_eperm': p.get('packet_socket') == 'EPERM'}))


def judge_online_network(net: dict[str, Any] | None, error: str | None, probes: dict[str, dict[str, Any] | None],
                         dns: str, netrec: dict[str, Any] | None) -> dict[str, Any]:
    def fn(p):
        rv = p.get('resolv') or {}
        ext = rv.get('ext_servers')
        return {'interfaces_eth0_lo': p.get('interfaces') == ['eth0', 'lo'],
                'embedded_resolver': rv.get('nameservers') == ['127.0.0.11'],
                'upstream_is_online_dns': ext is None or dns in str(ext), '_ext_servers': ext}
    ok, detail = _phases(probes, fn)
    rec_ok = bool(netrec and netrec.get('veth') and netrec.get('ip'))
    return _g(ok and net is not None and rec_ok, {'network': net, 'network_error': error, 'phases': detail, 'net_record': netrec})


def parse_conn_log(journal_json_lines: str) -> list[dict[str, Any]]:
    import lookupscan

    return lookupscan.parse_conn_log(journal_json_lines)


def judge_conn_log(lines: list[dict[str, Any]], netrec: dict[str, Any] | None) -> dict[str, Any]:
    ip, veth = (netrec or {}).get('ip'), (netrec or {}).get('veth')
    mine = [x for x in lines if ip and x['src'] == ip]
    sub = {'accepted_443_logged': any(x['dpt'] == 443 for x in mine), 'rejected_22_logged': any(x['dpt'] == 22 for x in mine)}
    # PHYSIN is the preferred join key (a3); if the kernel omits it, the join falls back to IP + trial window: info only.
    info = {'physin_is_the_trial_veth': bool(mine) and bool(veth) and all(x['physin'] == veth for x in mine),
            'lines_for_ip': len(mine), 'lines_total': len(lines)}
    return {**_g(all(sub.values()), sub), 'info': info, 'kind': 'runner-only'}


def verdict(gates: dict[str, dict[str, Any]], where: str) -> bool:
    for g in gates.values():
        if g.get('status') == 'SKIP':
            continue
        if g.get('kind') == 'runner-only' and where != 'runner':
            continue
        if g.get('status') != 'PASS':
            return False
    return True


# ---------------------------------------------------------------- measuring

def _run(argv: list[str], timeout: float = 600, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)  # nosec B603


def last_json(text: str) -> dict[str, Any] | None:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith('{'):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def ensure_image(image: str) -> dict[str, Any]:
    """The probe image on the host's dockerd, pulled by digest when missing (the host pull is allowed; containers
    never pull). A tag without a digest is refused: the suite must be reproducible."""
    if '@sha256:' not in image:
        return _g(False, {'image': image, 'error': 'image must be pinned by digest'})
    if _run(['docker', 'image', 'inspect', image], timeout=60).returncode == 0:
        return _g(True, {'image': image, 'pulled': False})
    r = _run(['docker', 'pull', '-q', image], timeout=1800)
    ok = r.returncode == 0 and _run(['docker', 'image', 'inspect', image], timeout=60).returncode == 0
    return _g(ok, {'image': image, 'pulled': ok, 'error': None if ok else r.stderr.strip()[-300:]})


def host_listeners() -> tuple[list[str], list[str]]:
    return parse_ss(_run(['ss', '-H', '-ltn']).stdout), parse_ss(_run(['ss', '-H', '-lun']).stdout)


def bridge_probes(image: str, proxy: str, out: pathlib.Path) -> dict[str, dict[str, Any] | None]:
    probes: dict[str, dict[str, Any] | None] = {}
    net = f'llmar-iso-{uuid.uuid4().hex[:8]}'
    _run(['docker', 'network', 'create', net])
    try:
        for name, args in (('docker0', []), ('user-network', ['--network', net])):
            r = _run(['docker', 'run', '--rm', *args, '-v', f'{HERE / "isoprobe.py"}:/p/isoprobe.py:ro', image,
                      'python3', '/p/isoprobe.py', '--role', 'bridge', '--proxy', proxy], timeout=300)
            (out / f'bridge-{name}.log').write_text(r.stdout + '\n--- stderr ---\n' + r.stderr[-4000:])
            probes[name] = last_json(r.stdout)
    finally:
        _run(['docker', 'network', 'rm', net])
    return probes


def probe_task(root: pathlib.Path, image: str, proxy: str) -> pathlib.Path:
    t = root / 'llmar-isoprobe'
    if t.exists():
        shutil.rmtree(t)
    for d in ('environment', 'tests', 'solution'):
        (t / d).mkdir(parents=True)
    for d in ('tests', 'solution'):
        shutil.copy(HERE / 'isoprobe.py', t / d / 'isoprobe.py')
    (t / 'instruction.md').write_text('Isolation probe (no model).\n')
    (t / 'solution' / 'solve.sh').write_text(f'#!/bin/bash\nmkdir -p /logs/agent\npython3 /solution/isoprobe.py --role agent --proxy {proxy} '
                                             '--out /logs/agent/isoprobe.json\n')
    (t / 'tests' / 'test.sh').write_text(f'#!/bin/bash\nmkdir -p /logs/verifier\npython3 /tests/isoprobe.py --role verifier --proxy {proxy} '
                                         '--out /logs/verifier/isoprobe.json\necho \'{"reward": 1}\' > /logs/verifier/reward.json\n')
    (t / 'tests' / 'Dockerfile').write_text(f'FROM {image}\nCOPY test.sh isoprobe.py /tests/\nRUN chmod +x /tests/test.sh\n')
    (t / 'task.toml').write_text(textwrap.dedent(f'''\
        schema_version = "1.3"
        [task]
        name = "llmar/isoprobe"
        description = ""
        [verifier]
        network_mode = "no-network"
        environment_mode = "separate"
        timeout_sec = 300.0
        [verifier.environment]
        build_timeout_sec = 600.0
        cpus = 1
        memory_mb = 1024
        storage_mb = 4096
        [agent]
        network_mode = "no-network"
        timeout_sec = 300.0
        [environment]
        build_timeout_sec = 600.0
        docker_image = "{image}"
        os = "linux"
        cpus = 1
        memory_mb = 1024
        storage_mb = 4096
        gpus = 0
        mcp_servers = []
        '''))
    return t


def harbor_trial(image: str, proxy_host: str, proxy_port: int, env_kind: str, out: pathlib.Path,
                 harbor: str | None = None) -> dict[str, Any]:
    proxy = f'{proxy_host}:{proxy_port}'
    task = probe_task(out / 'tasks', image, proxy)
    env = harbor_job.environment_config() if env_kind == 'llmar' else {'type': 'docker', 'delete': True}
    job_name = f'isoprobe-{env_kind}-{uuid.uuid4().hex[:8]}'
    job = {'job_name': job_name, 'jobs_dir': str(out / 'jobs'), 'n_attempts': 1, 'n_concurrent_trials': 1, 'quiet': True,
           'retry': {'max_retries': 0}, 'environment': env, 'verifier': {},
           # Same agent-phase policy as real trials: no-network + the proxy's IP literal.
           'agents': [{'name': 'oracle', 'extra_allowed_hosts': [proxy_host]}], 'tasks': [{'path': str(task)}]}
    cfg = out / f'{job_name}.json'
    cfg.write_text(json.dumps(job, indent=2))
    exe = harbor or os.environ.get('HARBOR_BIN') or shutil.which('harbor') or 'harbor'
    r = _run([exe, 'run', '--config', str(cfg)], timeout=1800, env=harbor_job.harbor_env(dict(os.environ)))
    (out / f'{job_name}.log').write_text(r.stdout[-20000:] + '\n--- stderr ---\n' + r.stderr[-20000:])
    trials = sorted(p.parent for p in (out / 'jobs' / job_name).glob('*/result.json'))
    tdir = trials[0] if len(trials) == 1 else None
    res = json.loads((tdir / 'result.json').read_text()) if tdir else {}

    def read(p: pathlib.Path) -> dict[str, Any] | None:
        return last_json(p.read_text()) if p.exists() else None
    return {'env': env_kind, 'harbor_exit': r.returncode, 'trial_dir': str(tdir) if tdir else None,
            'exception': (res.get('exception_info') or {}).get('exception_type'),
            'reward': ((res.get('verifier_result') or {}).get('rewards') or {}).get('reward'),
            'agent': read(tdir / 'agent' / 'isoprobe.json') if tdir else None,
            'verifier': read(tdir / 'verifier' / 'isoprobe.json') if tdir else None}


def proxy_listening(host: str, port: int) -> bool:
    try:
        socket.create_connection((host, port), timeout=2).close()
        return True
    except OSError:
        return False


def start_proxy(host: str, port: int, out: pathlib.Path, region: str):
    import hproxy
    import proxy as px

    srv = hproxy.RunnerProxy(host, port, px.Upstreams(None, region), hproxy.make_ledger(out / 'proxy', cap_usd=1.0), None,
                             out / 'proxy', require_host=host)
    hproxy.serve_in_thread(srv)
    return srv


def leakscan(paths: list[pathlib.Path], out: pathlib.Path) -> dict[str, Any]:
    j = out / 'leakscan.json'
    r = _run([sys.executable, '-I', str(HERE / 'leakscan.py'), '--json', str(j), *map(str, paths)], timeout=600)
    rep = json.loads(j.read_text()) if j.exists() else {}
    high = (rep.get('summary') or {}).get('high') if isinstance(rep, dict) else None
    return {**_g(r.returncode == 0, {'exit': r.returncode, 'summary': rep.get('summary') if isinstance(rep, dict) else None,
                                     'high': high})}


def run(a: argparse.Namespace) -> int:
    out = pathlib.Path(a.out) / time.strftime('%Y%m%dT%H%M%S') / a.env
    out.mkdir(parents=True)
    skip = set(filter(None, (a.skip or '').split(',')))
    proxy = f'{a.proxy_host}:{a.proxy_port}'
    srv = None
    if not proxy_listening(a.proxy_host, a.proxy_port):
        if not a.region:
            print('isolation: no proxy is listening and no --region / $AWS_REGION to start one', file=sys.stderr)
            return 2
        srv = start_proxy(a.proxy_host, a.proxy_port, out, a.region)
    report: dict[str, Any] = {'schema': 'llmar-isolation/v1', 'where': a.where, 'env': a.env, 'proxy': proxy,
                              'image': a.image, 'proxy_started_here': srv is not None, 'gates': {}, 'raw': {}}
    gates = report['gates']
    gates['P_probe_image'] = ensure_image(a.image)
    if gates['P_probe_image']['status'] != 'PASS':
        skip |= {'harbor', 'bridge'}   # nothing to run them with; P fails the suite
    try:
        if 'harbor' not in skip:
            h = harbor_trial(a.image, a.proxy_host, a.proxy_port, a.env, out, a.harbor)
            report['raw']['harbor'] = h
            gates['1_verifier_lo_only'] = judge_verifier(h['verifier'])
            gates['2_agent_no_packet_socket'] = judge_agent_caps(h['agent'])
            gates['3_agent_sidecar_egress'] = judge_sidecar(h['agent'], a.where)
            gates['H_harbor_trial_ok'] = _g(h['harbor_exit'] == 0 and h['exception'] is None and h['reward'] == 1,
                                            {k: h[k] for k in ('harbor_exit', 'exception', 'reward')})
        else:
            for k in ('1_verifier_lo_only', '2_agent_no_packet_socket', '3_agent_sidecar_egress'):
                gates[k] = {'status': 'SKIP'}
        if 'bridge' not in skip:
            b = bridge_probes(a.image, proxy, out)
            report['raw']['bridge'] = b
            gates['4_plain_bridges'] = judge_bridge(b, proxy)
        else:
            gates['4_plain_bridges'] = {'status': 'SKIP'}
        if 'host' not in skip:
            tcp, udp = host_listeners()
            if srv is not None:
                tcp = [x for x in tcp if x != proxy]   # this run's own proxy is the allowed listener anyway
                tcp.append(proxy)
            gates['5_host_listeners'] = judge_host_listeners(tcp, udp, a.proxy_host, a.proxy_port)
        else:
            gates['5_host_listeners'] = {'status': 'SKIP'}
        if a.aws_sg:
            gates['5_security_group_no_inbound'] = judge_aws(json.loads(pathlib.Path(a.aws_sg).read_text()),
                                                             json.loads(pathlib.Path(a.aws_instances).read_text()) if a.aws_instances else None)
        else:
            gates['5_security_group_no_inbound'] = {'status': 'SKIP', 'detail': 'no --aws-sg (0c fetches describe-* read-only)'}
    finally:
        if srv is not None:
            srv.shutdown()
            srv.server_close()
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    gates['L_leakscan'] = leakscan([out], out)
    report['pass'] = verdict(gates, a.where)
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    print(render(report))
    print(f'report: {out / "report.json"}')
    return 0 if report['pass'] else 1


# ---------------------------------------------------------------- measuring, profile tb21

ENV_FILE = pathlib.Path('/etc/llmar-runner.env')
VPC_CIDR = '10.91.0.0/24'        # infra RUNNER_CIDR (the runner VPC); its resolver is the network address + 2


def read_env_file(path: pathlib.Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            v = v.strip()
            out[k.strip()] = v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'' else v
    return out


def online_env(env_file: pathlib.Path) -> dict[str, str]:
    """ONLINE_NETWORK / ONLINE_DNS from the process environment, else the runner env file (infra's keys). Harbor-free:
    the suite runs in the driver's venv and only shells out to `harbor`."""
    f = read_env_file(env_file)
    return {k: os.environ.get(k) or f.get(k, '') for k in hcommon.ONLINE_KEYS}


def host_ipv4() -> str | None:
    out = _run(['ip', '-4', 'route', 'get', '1.1.1.1'], timeout=10).stdout.split()
    return out[out.index('src') + 1] if 'src' in out else None


def vpc_resolver(cidr: str = VPC_CIDR) -> str:
    return str(ipaddress.ip_network(cidr).network_address + 2)


def _docker_run_bg(image: str, args: list[str]) -> str | None:
    name = f'llmar-iso-peer-{uuid.uuid4().hex[:8]}'
    r = _run(['docker', 'run', '-d', '--rm', '--name', name, '--cap-drop', 'NET_RAW', *args, image,  # nosec B104: http.server inside the probe container, no published port
              'python3', '-m', 'http.server', '8000', '--bind', '0.0.0.0'], timeout=120)
    return name if r.returncode == 0 else None


def _container_ip(name: str, network: str) -> str | None:
    r = _run(['docker', 'inspect', '--format', f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', name], timeout=30)
    ip = r.stdout.strip()
    return ip if r.returncode == 0 and ip and ip != '<no value>' else None


def start_peers(image: str, network: str) -> tuple[dict[str, str], list[str], str | None]:
    """Listening containers the trial must not reach: one on the online network, one on docker0, one on a pool bridge.
    Returns (peer → ip:8000, container names, the temporary pool network)."""
    pool = f'llmar-iso-{uuid.uuid4().hex[:8]}'
    _run(['docker', 'network', 'create', pool], timeout=60)
    peers: dict[str, str] = {}
    names: list[str] = []
    for label, net, args in (('online', network, ['--network', network]), ('docker0', 'bridge', []), ('pool', pool, ['--network', pool])):
        n = _docker_run_bg(image, args)
        if n:
            names.append(n)
            ip = _container_ip(n, net)
            if ip:
                peers[label] = f'{ip}:8000'
    return peers, names, pool


def stop_peers(names: list[str], pool: str | None) -> None:
    if names:
        _run(['docker', 'rm', '-f', *names], timeout=120)
    if pool:
        _run(['docker', 'network', 'rm', pool], timeout=60)


def probe_task_online(root: pathlib.Path, image: str, probe_args: str) -> pathlib.Path:
    """A TB-shaped probe task: allow_internet, shared verifier (no verifier environment), the oracle runs the probe."""
    t = root / 'llmar-isoprobe-online'
    if t.exists():
        shutil.rmtree(t)
    for d in ('environment', 'tests', 'solution'):
        (t / d).mkdir(parents=True)
    for d in ('tests', 'solution'):
        shutil.copy(HERE / 'isoprobe.py', t / d / 'isoprobe.py')
    (t / 'instruction.md').write_text('Isolation probe (no model).\n')
    (t / 'environment' / 'Dockerfile').write_text(f'FROM {image}\n')
    (t / 'solution' / 'solve.sh').write_text('#!/bin/bash\nmkdir -p /logs/agent\n'
                                             f'python3 /solution/isoprobe.py --role agent-online {probe_args} --out /logs/agent/isoprobe.json\n')
    (t / 'tests' / 'test.sh').write_text('#!/bin/bash\nmkdir -p /logs/verifier\n'
                                         f'python3 /tests/isoprobe.py --role verifier-online {probe_args} --out /logs/verifier/isoprobe.json\n'
                                         'echo 1 > /logs/verifier/reward.txt\n')
    (t / 'task.toml').write_text(textwrap.dedent(f'''\
        schema_version = "1.1"
        [task]
        name = "llmar/isoprobe-online"
        description = ""
        [verifier]
        timeout_sec = 600.0
        [agent]
        timeout_sec = 600.0
        [environment]
        build_timeout_sec = 600.0
        docker_image = "{image}"
        cpus = 1
        memory_mb = 1024
        storage_mb = 4096
        gpus = 0
        allow_internet = true
        mcp_servers = []
        '''))
    return t


def harbor_trial_online(image: str, proxy: str, probe_args: str, online: dict[str, str], out: pathlib.Path,
                        harbor: str | None = None) -> dict[str, Any]:
    task = probe_task_online(out / 'tasks', image, probe_args)
    job_name = f'isoprobe-online-{uuid.uuid4().hex[:8]}'
    job = {'job_name': job_name, 'jobs_dir': str(out / 'jobs'), 'n_attempts': 1, 'n_concurrent_trials': 1, 'quiet': True,
           'retry': {'max_retries': 0}, 'environment': harbor_job.environment_config(), 'verifier': {},
           'agents': [{'name': 'oracle'}], 'tasks': [{'path': str(task)}]}
    cfg = out / f'{job_name}.json'
    cfg.write_text(json.dumps(job, indent=2))
    exe = harbor or os.environ.get('HARBOR_BIN') or shutil.which('harbor') or 'harbor'
    env = harbor_job.harbor_env({**os.environ, **online})
    t0 = time.time()
    r = _run([exe, 'run', '--config', str(cfg)], timeout=1800, env=env)
    (out / f'{job_name}.log').write_text(r.stdout[-20000:] + '\n--- stderr ---\n' + r.stderr[-20000:])
    trials = sorted(q.parent for q in (out / 'jobs' / job_name).glob('*/result.json'))
    tdir = trials[0] if len(trials) == 1 else None
    res = json.loads((tdir / 'result.json').read_text()) if tdir else {}

    def read(q: pathlib.Path) -> dict[str, Any] | None:
        return last_json(q.read_text()) if q.exists() else None
    return {'harbor_exit': r.returncode, 'trial_dir': str(tdir) if tdir else None, 't0': t0, 't1': time.time(),
            'exception': (res.get('exception_info') or {}).get('exception_type'),
            'reward': ((res.get('verifier_result') or {}).get('rewards') or {}).get('reward'),
            'agent': read(tdir / 'agent' / 'isoprobe.json') if tdir else None,
            'verifier': read(tdir / 'verifier' / 'isoprobe.json') if tdir else None,
            'net_record': read(tdir / hcommon.NET_RECORD) if tdir else None}


def run_tb(a: argparse.Namespace) -> int:
    import taskpin

    out = pathlib.Path(a.out) / time.strftime('%Y%m%dT%H%M%S') / f'tb21-{a.env}'
    out.mkdir(parents=True)
    skip = set(filter(None, (a.skip or '').split(',')))
    proxy = f'{a.proxy_host}:{a.proxy_port}'
    online = online_env(pathlib.Path(a.env_file))
    report: dict[str, Any] = {'schema': 'llmar-isolation/v2', 'profile': 'tb21', 'where': a.where, 'env': a.env, 'proxy': proxy,
                              'image': a.image, 'online': online, 'gates': {}, 'raw': {}}
    gates = report['gates']
    gates['P_probe_image'] = ensure_image(a.image)
    net, net_err = None, None
    try:
        net = taskpin.check_online_network(lambda argv: _run(argv, timeout=60), online.get('ONLINE_NETWORK') or taskpin.ONLINE_NETWORK['name'])
    except taskpin.NetworkMismatch as e:
        net_err = str(e)
    if gates['P_probe_image']['status'] != 'PASS' or net is None or not all(online.values()):
        skip |= {'harbor'}
    srv = None
    if 'harbor' not in skip and not proxy_listening(a.proxy_host, a.proxy_port):
        if not a.region:
            print('isolation: no proxy is listening and no --region / $AWS_REGION to start one', file=sys.stderr)
            return 2
        srv = start_proxy(a.proxy_host, a.proxy_port, out, a.region)
    report['proxy_started_here'] = srv is not None
    hip, vdns = host_ipv4(), vpc_resolver(a.vpc_cidr)
    names: list[str] = []
    pool = None
    try:
        h: dict[str, Any] = {}
        peers: dict[str, str] = {}
        if 'harbor' not in skip:
            peers, names, pool = start_peers(a.image, online['ONLINE_NETWORK'])
            ps = _run(['docker', 'ps', '--format', '{{.Ports}}'], timeout=60).stdout.splitlines()
            nat = _run(['iptables', '-t', 'nat', '-S'], timeout=30)
            gates['O6_no_inbound'] = judge_inbound(ps, nat.stdout if nat.returncode == 0 else None, online['ONLINE_NETWORK'],
                                                   taskpin.ONLINE_NETWORK['subnet'])
            args = (f'--proxy {proxy} --vpc-dns {vdns} --private {",".join(ONLINE_PRIVATE)}' + (f' --host-ip {hip}' if hip else '')
                    + ''.join(f' --peer {v}' for v in peers.values()))
            h = harbor_trial_online(a.image, proxy, args, online, out, a.harbor)
            report['raw']['harbor'] = h
            report['raw']['peers'] = peers
        probes = {'agent': h.get('agent'), 'verifier': h.get('verifier')}
        gates['H_harbor_trial_ok'] = _g(bool(h) and h['harbor_exit'] == 0 and h['exception'] is None and h['reward'] == 1,
                                        {k: h.get(k) for k in ('harbor_exit', 'exception', 'reward')} if h else 'not run')
        gates['O1_internet'] = judge_online_internet(probes)
        gates['O1b_egress_limits'] = judge_online_limits(probes)
        gates['O2_metadata'] = judge_online_metadata(probes)
        gates['O3_private'] = judge_online_private(probes, hip, vdns, ONLINE_PRIVATE)
        gates['O4_host'] = judge_online_host(probes, proxy, a.where)
        gates['O5_containers'] = judge_online_peers(probes, peers) if len(peers) == 3 else _g(False, {'peers': peers, 'error': 'peers did not start'}, 'runner-only')
        gates['O7_caps'] = judge_caps_online(probes)
        gates['O8_network'] = judge_online_network(net, net_err, probes, online.get('ONLINE_DNS', ''), h.get('net_record'))
        if h:
            j = _run(['journalctl', '-k', '-o', 'json', '--since', f"@{int(h['t0']) - 5}", '--grep', CONN_LOG_PREFIX.strip()], timeout=120)
            log_lines = parse_conn_log(j.stdout) if j.returncode in (0, 1) else []
            gates['O9_conn_log'] = judge_conn_log(log_lines, h.get('net_record'))
        else:
            gates['O9_conn_log'] = {'status': 'SKIP'}
        if 'bridge' not in skip:
            b = bridge_probes(a.image, proxy, out)
            report['raw']['bridge'] = b
            gates['4_plain_bridges'] = judge_bridge(b, proxy)
        if 'host' not in skip:
            tcp, udp = host_listeners()
            if srv is not None:
                tcp = [x for x in tcp if x != proxy] + [proxy]
            gates['5_host_listeners'] = judge_host_listeners(tcp, udp, a.proxy_host, a.proxy_port)
        gates['5_security_group_no_inbound'] = (judge_aws(json.loads(pathlib.Path(a.aws_sg).read_text()),
                                                          json.loads(pathlib.Path(a.aws_instances).read_text()) if a.aws_instances else None)
                                                if a.aws_sg else {'status': 'SKIP', 'detail': 'no --aws-sg (0c fetches describe-* read-only)'})
    finally:
        stop_peers(names, pool)
        if srv is not None:
            srv.shutdown()
            srv.server_close()
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    gates['L_leakscan'] = leakscan([out], out)
    report['pass'] = verdict(gates, a.where)
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    print(render(report))
    print(f'report: {out / "report.json"}')
    return 0 if report['pass'] else 1


def render(report: dict[str, Any]) -> str:
    lines = [f"isolation  where={report['where']}  env={report['env']}  proxy={report['proxy']}"
             + (f"  profile={report['profile']}" if report.get('profile') else '')]
    for k, g in report['gates'].items():
        st = g.get('status')
        tag = ' (runner-only)' if g.get('kind') == 'runner-only' else ''
        extra = ' [runner-only part fails here]' if g.get('runner_only') else ''
        lines.append(f'  {st:5} {k}{tag}{extra}')
    lines.append(f"  => {'PASS' if report.get('pass') else 'FAIL'}")
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('run')
    p.add_argument('--where', choices=('runner', 'devbox'), required=True)
    p.add_argument('--env', choices=('llmar', 'plain'), default='llmar')
    p.add_argument('--proxy-host', default=hcommon.PROXY_HOST)
    p.add_argument('--proxy-port', type=int, default=hcommon.PROXY_PORT)
    p.add_argument('--image', default=PROBE_IMAGE)
    p.add_argument('--region', default=os.environ.get('AWS_REGION'),
                   help='the experiment Region (a deploy parameter; default $AWS_REGION): only selects the price catalog of the '
                        'proxy this run starts when none is listening; no AWS calls')
    p.add_argument('--aws-sg')
    p.add_argument('--aws-instances')
    p.add_argument('--skip', help='comma list of harbor,bridge,host')
    p.add_argument('--harbor', help='harbor executable (default: $HARBOR_BIN, then PATH)')
    p.add_argument('--out', default=str(hcommon.RESULTS / 'isolation'))
    p.add_argument('--profile', choices=('deepswe', 'tb21'), default='deepswe')
    p.add_argument('--env-file', default=str(ENV_FILE), help='runner env file (tb21: ONLINE_NETWORK, ONLINE_DNS)')
    p.add_argument('--vpc-cidr', default=VPC_CIDR, help='tb21: the runner VPC (its resolver, VPC+2, must be unreachable)')
    p.set_defaults(fn=lambda a: run_tb(a) if a.profile == 'tb21' else run(a))
    p = sub.add_parser('aws')
    p.add_argument('--sg', required=True)
    p.add_argument('--instances')
    p.set_defaults(fn=lambda a: (print(json.dumps(judge_aws(json.loads(pathlib.Path(a.sg).read_text()),
                                                            json.loads(pathlib.Path(a.instances).read_text()) if a.instances else None),
                                                  indent=2)), 0)[1])
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == '__main__':
    sys.exit(main())
