#!/bin/bash
# Packet-level check of a runner firewall script (argument) without Docker or root: run it as
#   unshare -rn --pid --fork --mount-proc --kill-child bash packets.sh FIREWALL_SCRIPT
# The fresh user+network namespace plays the host: Docker 25's bridge baseline (FORWARD policy DROP, DOCKER-USER first,
# per-bridge accepts, icc=false on the online bridge, MASQUERADE), containers C1 and C2 on br-llmon, P1 on a pool
# bridge, and a fake internet W behind ens5 that also owns VPC, IMDS, resolver and other non-public addresses. The
# firewall's modprobe and sysctl lines are skipped (br_netfilter must already be loaded on the machine). Prints one
# line per probe, then PASS/FAIL counts; exits 1 on any FAIL.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; FW=$1
ipt=/usr/sbin/iptables
test "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables)" = 1
ip link set lo up
echo 1 > /proc/sys/net/ipv4/ip_forward
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT
ns() { unshare -n sleep 120 >/dev/null 2>&1 & pids+=($!); }
ns; C1=$!; ns; C2=$!; ns; P1=$!; ns; W=$!
sleep 0.3
nsx() { local p=$1; shift; nsenter -t "$p" -n "$@"; }
for p in $C1 $C2 $P1 $W; do nsx $p ip link set lo up; done
mkbr() { ip link add $1 type bridge; ip addr add $2 dev $1; ip link set $1 up; }
mkbr br-llmon 10.201.0.1/24; mkbr br-0a1b2c3d 10.200.7.1/24; mkbr docker0 172.17.0.1/16
attach() { local pid=$1 br=$2 addr=$3 gw=$4; ip link add h$pid type veth peer name eth0 netns $pid; ip link set h$pid master $br up
  nsx $pid ip addr add $addr dev eth0; nsx $pid ip link set eth0 up; nsx $pid ip route add default via $gw; }
attach $C1 br-llmon 10.201.0.2/24 10.201.0.1; attach $C2 br-llmon 10.201.0.3/24 10.201.0.1; attach $P1 br-0a1b2c3d 10.200.7.2/24 10.200.7.1
ip link add ens5 type veth peer name w0 netns $W; ip addr add 1.2.3.1/24 dev ens5; ip link set ens5 up
nsx $W ip addr add 1.2.3.4/24 dev w0; nsx $W ip link set w0 up
for a in 8.8.8.8 10.91.0.5 169.254.169.254 169.254.169.253 169.254.170.2 198.51.100.7 100.64.0.9; do nsx $W ip addr add $a/32 dev lo; done
nsx $W ip route add 10.201.0.0/24 via 1.2.3.1  # an outside sender that routes straight at the containers
ip route add default via 1.2.3.4
$ipt -P FORWARD DROP
$ipt -N DOCKER-USER; $ipt -A DOCKER-USER -j RETURN; $ipt -A FORWARD -j DOCKER-USER
for br in br-llmon br-0a1b2c3d docker0; do
  $ipt -A FORWARD -o $br -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  $ipt -A FORWARD -i $br ! -o $br -j ACCEPT
done
$ipt -A FORWARD -i br-llmon -o br-llmon -j DROP
$ipt -A FORWARD -i br-0a1b2c3d -o br-0a1b2c3d -j ACCEPT
for s in 10.201.0.0/24:br-llmon 10.200.7.0/24:br-0a1b2c3d 172.17.0.0/16:docker0; do $ipt -t nat -A POSTROUTING -s ${s%:*} ! -o ${s#*:} -j MASQUERADE; done
wlog="$(mktemp)"
nsx $W python3 -I "$D/listen.py" 0.0.0.0 tcp:443 tcp:80 tcp:22 tcp:53 udp:443 tcp:8443 > "$wlog" 2>&1 & pids+=($!)
# UDP replies leave from the bound address: bind the resolver address itself, as the real resolver answers from it
nsx $W python3 -I "$D/listen.py" 169.254.169.253 udp:53 >> "$wlog" 2>&1 & pids+=($!)
python3 -I "$D/listen.py" 172.17.0.1 tcp:8088 >/dev/null 2>&1 & pids+=($!)
python3 -I "$D/listen.py" 0.0.0.0 tcp:2222 >/dev/null 2>&1 & pids+=($!)
for p in $C1 $C2 $P1; do nsx $p python3 -I "$D/listen.py" 0.0.0.0 tcp:9000 >/dev/null 2>&1 & pids+=($!); done
sleep 0.5
sed -e '/modprobe br_netfilter/d' -e '/sysctl -q -w net.bridge/d' "$FW" | bash
pass=0; failed=0
pr() { local who=$1 pid=$2 proto=$3 host=$4 port=$5 want=$6 got; got=$(nsx $pid python3 -I "$D/probe.py" $proto $host $port)
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); r=PASS; else failed=$((failed + 1)); r=FAIL; fi
  printf '%s %-3s %-3s %-15s %-5s want %-11s got %s\n' $r $who $proto $host $port $want $got; }
. "$D/expect-$(basename "$FW" .sh | sed 's/^fw-//').sh"
peers="$(awk '{print $1}' "$wlog" | sort -u | tr '\n' ' ')"
if [ -n "${WANT_PEERS+x}" ]; then
  if [ "$peers" = "$WANT_PEERS" ]; then pass=$((pass + 1)); r=PASS; else failed=$((failed + 1)); r=FAIL; fi
  echo "$r internet side saw peers: '$peers' want '$WANT_PEERS'"
fi
echo "pass=$pass fail=$failed"
test $failed = 0
