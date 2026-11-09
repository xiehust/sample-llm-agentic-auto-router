# probe.py tcp|udp HOST PORT: prints ok, refused, unreachable or timeout (1.5 s). Test harness for the runner firewall.
import socket, sys, errno
proto, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM if proto == 'tcp' else socket.SOCK_DGRAM)
s.settimeout(1.5)
try:
    s.connect((host, port))
    if proto == 'udp':
        s.send(b'q'); s.recv(64)
    else:
        s.recv(64)
    print('ok')
except socket.timeout:
    print('timeout')
except ConnectionRefusedError:
    print('refused')
except OSError as e:
    print('unreachable' if e.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EACCES, errno.EPERM) else f'err{e.errno}')
