"""Isolation probe (design §10): runs inside a container and prints one JSON line of raw observations. No verdicts
here (isolation.py judges them), no payloads beyond a HEAD request, a one-line raw probe or a TLS ClientHello, nothing sent on a packet
socket (only whether one can be created). Stdlib only, Python ≥ 3.10.

  python3 isoprobe.py --role agent|verifier|bridge --proxy 172.17.0.1:8088 [--ports 22,80,...] [--out FILE]

Observations:
- interfaces (socket.if_nameindex), the default gateway (/proc/net/route);
- packet / raw sockets: created, or the errno name (EPERM expected without NET_RAW);
- per TCP target: `connect` (ok | refused | timeout | <errno>) and `reply` (bytes came back | closed | timeout):
  behind Harbor's egress sidecar every connect succeeds locally (a transparent proxy), so only `reply` counts there;
  on a plain bridge `connect` decides;
- HTTPS to a public IP: whether a TLS handshake completed;
- the proxy: an HTTP reply to `GET /r/isoprobe/v1/models` (any status: the route is unknown, so 404);
- IMDS: an HTTP reply from 169.254.169.254;
- DNS: getaddrinfo and `getent hosts` for a public name (with the time taken).

Online roles (`agent-online`, `verifier-online`; Terminal-Bench 2.1, TB design §4.6), for a container on the runner's
online network, where TCP 80/443 to public IPv4 and DNS to the VPC resolver are allowed and nothing else:
- internet: DNS for public names, a TLS handshake to a public name on 443, an HTTP reply from a public name on 80;
- egress limits: a public host on TCP 22 and 8443 (refused, and how fast), a DNS query over UDP to a public resolver,
  a QUIC version-negotiation trigger to UDP 443 (RFC 9000 §6: a server answers an unknown version), the VPC resolver
  on 443; the VPC resolver answering a UDP DNS query on 53;
- metadata, private ranges (`--private`), the host's own IP (`--host-ip`, every probed port), the bridge gateway and
  other host ports, and peer containers (`--peer`) by TCP connect;
- resolv.conf: the nameserver lines and Docker's `ExtServers` comment (the embedded resolver's upstream).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import errno as _errno
import json
import shutil
import socket
import ssl
import struct
import subprocess  # nosec B404 - fixed argv (getent)
import sys
import time

PUBLIC_IP = '1.1.1.1'
IMDS = '169.254.169.254'
PUBLIC_NAME = 'example.com'
ONLINE_NAMES = ('pypi.org', 'example.com', 'github.com')     # TLS on 443, HTTP on 80, SSH port 22 (refused by the firewall)
VPC_DNS_LINK_LOCAL = '169.254.169.253'
DEFAULT_PORTS = (22, 53, 80, 111, 443, 2375, 2376, 5355, 8080, 8089, 9100)
TIMEOUT = 4.0
# Neither HTTP nor TLS: Harbor's gost sidecar cannot sniff a host from it and forwards it raw to the original
# destination when that IP is allowlisted, the most permissive path, so it is the one probed for host ports.
RAW_PROBE = b'llmar-isoprobe\r\n'


def _err(e: BaseException) -> str:
    if isinstance(e, socket.timeout) or isinstance(e, TimeoutError):
        return 'timeout'
    n = getattr(e, 'errno', None)
    if isinstance(n, int) and n in _errno.errorcode:
        return {_errno.ECONNREFUSED: 'refused'}.get(n, _errno.errorcode[n])
    return type(e).__name__


def tcp(host: str, port: int, send: bytes = b'HEAD / HTTP/1.0\r\n\r\n', timeout: float = TIMEOUT) -> dict:
    out = {'connect': None, 'reply': None}
    try:
        s = socket.create_connection((host, port), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        out['connect'] = _err(e)
        return out
    out['connect'] = 'ok'
    try:
        s.settimeout(timeout)
        if send:
            s.sendall(send)
        data = s.recv(64)
        out['reply'] = 'bytes' if data else 'closed'
    except Exception as e:  # noqa: BLE001
        out['reply'] = _err(e)
    finally:
        s.close()
    return out


def tls(host: str, port: int = 443, timeout: float = TIMEOUT) -> dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE   # only "did a handshake with something out there complete"
    try:
        with socket.create_connection((host, port), timeout=timeout) as raw:
            raw.settimeout(timeout)
            with ctx.wrap_socket(raw, server_hostname=None) as s:
                return {'handshake': 'ok', 'version': s.version()}
    except Exception as e:  # noqa: BLE001
        return {'handshake': _err(e)}


def http_reply(host: str, port: int, path: str, timeout: float = TIMEOUT) -> dict:
    r = tcp(host, port, f'GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\n\r\n'.encode(), timeout)
    return r


def sock_create(family: int, kind: int, proto: int = 0) -> str:
    try:
        socket.socket(family, kind, proto).close()
        return 'created'
    except Exception as e:  # noqa: BLE001
        return _err(e)


def udp_exchange(host: str, port: int, payload: bytes, timeout: float = TIMEOUT) -> dict:
    """One datagram on a connected UDP socket: `reply` (bytes came back), `timeout`, or the errno (an ICMP error,
    e.g. admin-prohibited, surfaces as ECONNREFUSED/EHOSTUNREACH on the next recv)."""
    t0 = time.time()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        s.send(payload)
        data = s.recv(4096)
        r = 'reply' if data else 'empty'
    except socket.timeout:
        r = 'timeout'
    except OSError as e:
        r = _err(e)
    finally:
        s.close()
    return {'result': r, 's': round(time.time() - t0, 2)}


def dns_query(name: str) -> bytes:
    """A minimal standard DNS query (A record, recursion desired)."""
    q = b''.join(bytes([len(x)]) + x.encode() for x in name.split('.')) + b'\x00'
    return struct.pack('>HHHHHH', 0x1d1d, 0x0100, 1, 0, 0, 0) + q + struct.pack('>HH', 1, 1)


def quic_probe() -> bytes:
    """A QUIC long-header Initial-shaped packet with a reserved version: a QUIC server must answer it with Version
    Negotiation (RFC 9000 §6), so any reply shows UDP 443 got through. Padded to 1200 bytes (§14.1)."""
    pkt = bytes([0xc0]) + bytes.fromhex('0a0a0a0a') + bytes([8]) + b'llmarisp' + bytes([0])
    return pkt + b'\x00' * (1200 - len(pkt))


def timed_tcp(host: str, port: int, timeout: float = 7.0) -> dict:
    t0 = time.time()
    r = tcp(host, port, RAW_PROBE, timeout=timeout)
    return {**r, 's': round(time.time() - t0, 2)}


def resolv() -> dict:
    try:
        lines = open('/etc/resolv.conf').read().splitlines()
    except OSError:
        return {'nameservers': None, 'ext_servers': None}
    ext = [ln.split('ExtServers:', 1)[1].strip() for ln in lines if 'ExtServers:' in ln]
    return {'nameservers': [ln.split()[1] for ln in lines if ln.startswith('nameserver') and len(ln.split()) > 1], 'ext_servers': ext[0] if ext else None}


def probe_online(role: str, proxy: str, ports: tuple[int, ...], host_ip: str | None, vpc_dns: str | None,
                 private: tuple[str, ...], peers: tuple[str, ...]) -> dict:
    ph, pp = proxy.rsplit(':', 1)
    port = int(pp)
    gw = default_gateway()
    out: dict = {'schema': 'llmar-isoprobe/v2', 'role': role, 'proxy': proxy,
                 'interfaces': sorted(n for _, n in socket.if_nameindex()), 'gateway': gw, 'resolv': resolv()}
    out['packet_socket'] = sock_create(socket.AF_PACKET, socket.SOCK_RAW) if hasattr(socket, 'AF_PACKET') else 'unsupported'
    out['raw_inet_socket'] = sock_create(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP)
    out['proxy_http'] = http_reply(ph, port, '/r/isoprobe/v1/models')
    out['dns'] = {n: dns(n) for n in ONLINE_NAMES}
    out['internet_tls'] = tls(ONLINE_NAMES[0], 443)
    out['internet_http80'] = http_reply(ONLINE_NAMES[1], 80, '/')
    out['public_tcp'] = {f'{h}:{p}': timed_tcp(h, p) for h, p in ((ONLINE_NAMES[2], 22), (PUBLIC_IP, 8443))}
    out['public_udp53'] = udp_exchange(PUBLIC_IP, 53, dns_query(PUBLIC_NAME))
    out['public_quic'] = udp_exchange(PUBLIC_IP, 443, quic_probe())
    out['vpc_resolver_link_local'] = {'udp53': udp_exchange(VPC_DNS_LINK_LOCAL, 53, dns_query(PUBLIC_NAME)), 'tcp443': tcp(VPC_DNS_LINK_LOCAL, 443)}
    meta = [(IMDS, 80), ('169.254.170.2', 80)]
    if vpc_dns:
        meta.append((vpc_dns, 53))
    targets = meta + [(h, 80) for h in private]
    hosts = [ph] + ([gw] if gw and gw != ph else []) + ([host_ip] if host_ip else [])
    targets += [(h, p) for h in hosts for p in ports if not (h == ph and p == port)]
    if gw and gw != ph:
        targets.append((gw, port))
    if host_ip:
        targets.append((host_ip, port))
    targets += [(h, int(p)) for h, p in (x.rsplit(':', 1) for x in peers)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        res = list(pool.map(lambda t: tcp(t[0], t[1], RAW_PROBE, timeout=7.0), targets))
    out['tcp'] = {f'{h}:{p}': r for (h, p), r in zip(targets, res, strict=True)}
    out['imds_v6'] = tcp('fd00:ec2::254', 80, timeout=4.0) if socket.has_ipv6 else {'connect': 'no-ipv6'}
    return out


def dns(name: str) -> dict:
    t0 = time.time()
    try:
        socket.getaddrinfo(name, 443)
        r = 'resolved'
    except Exception as e:  # noqa: BLE001
        r = 'failed:' + type(e).__name__
    out = {'getaddrinfo': r, 'getaddrinfo_s': round(time.time() - t0, 1)}
    exe = shutil.which('getent')
    if exe:
        t0 = time.time()
        try:
            p = subprocess.run([exe, 'hosts', name], capture_output=True, timeout=30)  # nosec B603
            out['getent'] = 'resolved' if p.returncode == 0 and p.stdout.strip() else f'failed:rc{p.returncode}'
        except Exception as e:  # noqa: BLE001
            out['getent'] = 'failed:' + type(e).__name__
        out['getent_s'] = round(time.time() - t0, 1)
    else:
        out['getent'] = 'absent'
    return out


def default_gateway() -> str | None:
    try:
        with open('/proc/net/route') as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if len(parts) > 2 and parts[1] == '00000000':
                    return socket.inet_ntoa(struct.pack('<L', int(parts[2], 16)))
    except OSError:
        return None
    return None


def probe(role: str, proxy: str, ports: tuple[int, ...]) -> dict:
    ph, pp = proxy.rsplit(':', 1)
    port = int(pp)
    gw = default_gateway()
    out: dict = {'schema': 'llmar-isoprobe/v1', 'role': role, 'proxy': proxy,
                 'interfaces': sorted(n for _, n in socket.if_nameindex()), 'gateway': gw}
    out['packet_socket'] = sock_create(socket.AF_PACKET, socket.SOCK_RAW) if hasattr(socket, 'AF_PACKET') else 'unsupported'
    out['raw_inet_socket'] = sock_create(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP)
    out['proxy_http'] = http_reply(ph, port, '/r/isoprobe/v1/models')
    out['internet_tls'] = tls(PUBLIC_IP)
    out['internet_tcp80'] = tcp(PUBLIC_IP, 80)
    out['imds_http'] = http_reply(IMDS, 80, '/latest/meta-data/')
    out['dns'] = dns(PUBLIC_NAME)
    hosts = [ph] + ([gw] if gw and gw != ph else [])
    targets = [(h, p) for h in hosts for p in ports if not (h == ph and p == port)]
    if gw and gw != ph:
        targets.append((gw, port))
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:   # dropped packets cost a full timeout each
        res = list(pool.map(lambda t: tcp(t[0], t[1], RAW_PROBE, timeout=7.0), targets))
    out["host_ports"] = {f"{h}:{p}": r for (h, p), r in zip(targets, res, strict=True)}
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--role', required=True, choices=('agent', 'verifier', 'bridge', 'agent-online', 'verifier-online'))
    ap.add_argument('--proxy', required=True)
    ap.add_argument('--ports', default=','.join(map(str, DEFAULT_PORTS)))
    ap.add_argument('--host-ip')
    ap.add_argument('--vpc-dns')
    ap.add_argument('--private', default='')
    ap.add_argument('--peer', action='append', default=[])
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    ports = tuple(int(x) for x in a.ports.split(',') if x)
    if a.role.endswith('-online'):
        rec = probe_online(a.role, a.proxy, ports, a.host_ip, a.vpc_dns, tuple(x for x in a.private.split(',') if x), tuple(a.peer))
    else:
        rec = probe(a.role, a.proxy, ports)
    line = json.dumps(rec, sort_keys=True)
    if a.out:
        with open(a.out, 'w') as f:
            f.write(line + '\n')
    print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
