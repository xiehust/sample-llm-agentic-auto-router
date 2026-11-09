# listen.py ADDR tcp:PORT|udp:PORT...: answers "hi <peer>" and prints each peer. Test harness for the runner firewall.
import selectors, signal, socket, sys
# Backstop: never outlive the test that started it (the pid namespace normally kills it first).
signal.alarm(150)
addr = sys.argv[1]; sel = selectors.DefaultSelector()
for spec in sys.argv[2:]:
    proto, port = spec.split(':')
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM if proto == 'tcp' else socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((addr, int(port)))
    if proto == 'tcp': s.listen(16)
    sel.register(s, selectors.EVENT_READ, proto)
while True:
    for key, _ in sel.select():
        s = key.fileobj
        if key.data == 'tcp':
            c, peer = s.accept(); c.sendall(b'hi ' + peer[0].encode()); c.close()
        else:
            d, peer = s.recvfrom(64); s.sendto(b'hi ' + peer[0].encode(), peer)
        print(peer[0], s.getsockname()[1], flush=True)
