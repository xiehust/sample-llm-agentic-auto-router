#!/bin/bash
# Sets this llmar runner's container egress to 'internet'. Generated from infra/src/runner.ts (runnerEgressSwitchScript);
# regenerate, do not edit. Idempotent. Run as root (SSM Run Command) only while no container runs.
set -euo pipefail
umask 022
env_file=/etc/llmar-runner.env
fw=/usr/local/sbin/runner-firewall
dropin=/etc/systemd/system/docker.service.d/10-runner-firewall.conf
backup_root=/var/lib/llmar-runner/egress-backup
ipt=/usr/sbin/iptables
printk=/proc/sys/kernel/printk
printk_dropin=/etc/sysctl.d/90-runner-console.conf
printk_before=/var/lib/llmar-runner/printk.before
fail() { echo "runner-egress: $*" >&2; exit 1; }
absent() { if "$@" >/dev/null 2>&1; then fail "unexpected: $*"; fi; }
test "$(id -u)" = 0 || fail "run as root"
test -f "$env_file" && test -x "$fw" || fail "not a runner (env file or firewall missing)"
grep -qx "ExecStartPost=$fw" "$dropin" || fail "the docker.service firewall drop-in is missing"
grep -qx 'PROXY_PORT=8088' "$env_file" || fail "PROXY_PORT in $env_file is not 8088; regenerate for this runner"
systemctl is-active --quiet docker || fail "docker is not active"
test -z "$(docker ps -q)" || fail "containers are running: finish or stop the run first"
install -d -m 0700 "$backup_root"
backup="$(mktemp -d "$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-XXXX")"
cp -p "$fw" "$env_file" "$backup/"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/runner-firewall" <<'EOF'
#!/bin/bash
set -euo pipefail
ipt=/usr/sbin/iptables
ip6t=/usr/sbin/ip6tables
/usr/sbin/modprobe br_netfilter
/usr/sbin/sysctl -q -w net.bridge.bridge-nf-call-iptables=1 net.bridge.bridge-nf-call-ip6tables=1
for rule in "-i docker0 -j DROP" "-i br+ -j DROP" "-d 169.254.169.254/32 -j DROP"; do
  $ipt -C DOCKER-USER $rule 2>/dev/null || $ipt -I DOCKER-USER $rule
done
$ipt -N RUNNER-BRIDGE-IN 2>/dev/null || $ipt -F RUNNER-BRIDGE-IN
$ipt -A RUNNER-BRIDGE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ipt -A RUNNER-BRIDGE-IN -p tcp -d 172.17.0.1/32 --dport 8088 -j ACCEPT
$ipt -A RUNNER-BRIDGE-IN -j DROP
for ifc in docker0 br+; do
  $ipt -C INPUT -i $ifc -j RUNNER-BRIDGE-IN 2>/dev/null || $ipt -I INPUT 1 -i $ifc -j RUNNER-BRIDGE-IN
  for chain in INPUT FORWARD; do
    $ip6t -C $chain -i $ifc -j DROP 2>/dev/null || $ip6t -I $chain 1 -i $ifc -j DROP
  done
done
# Internet egress for br-llmon only (the llmar-online network), ahead of the drops above.
$ipt -N RUNNER-ONLINE-OUT 2>/dev/null || $ipt -F RUNNER-ONLINE-OUT
$ipt -A RUNNER-ONLINE-OUT -m conntrack --ctstate INVALID -j DROP
$ipt -A RUNNER-ONLINE-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ipt -A RUNNER-ONLINE-OUT -o docker0 -j DROP
$ipt -A RUNNER-ONLINE-OUT -o br+ -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 169.254.169.253/32 -p udp --dport 53 -j ACCEPT
$ipt -A RUNNER-ONLINE-OUT -d 169.254.169.253/32 -p tcp --dport 53 -j ACCEPT
$ipt -A RUNNER-ONLINE-OUT -d 0.0.0.0/8 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 10.0.0.0/8 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 100.64.0.0/10 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 127.0.0.0/8 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 169.254.0.0/16 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 172.16.0.0/12 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 192.0.0.0/24 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 192.0.2.0/24 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 192.88.99.0/24 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 192.168.0.0/16 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 198.18.0.0/15 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 198.51.100.0/24 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 203.0.113.0/24 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 224.0.0.0/4 -j DROP
$ipt -A RUNNER-ONLINE-OUT -d 240.0.0.0/4 -j DROP
$ipt -A RUNNER-ONLINE-OUT -p tcp -j LOG --log-prefix "llmar-online: " --log-level 6
$ipt -A RUNNER-ONLINE-OUT -p tcp -m multiport --dports 443,80 -j ACCEPT
$ipt -A RUNNER-ONLINE-OUT -p tcp -j REJECT --reject-with tcp-reset
$ipt -A RUNNER-ONLINE-OUT -j REJECT --reject-with icmp-admin-prohibited
$ipt -N RUNNER-ONLINE-IN 2>/dev/null || $ipt -F RUNNER-ONLINE-IN
$ipt -A RUNNER-ONLINE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ipt -A RUNNER-ONLINE-IN -j DROP
for rule in "-o br-llmon -j RUNNER-ONLINE-IN" "-i br-llmon -j RUNNER-ONLINE-OUT"; do
  $ipt -C DOCKER-USER $rule 2>/dev/null || $ipt -I DOCKER-USER 1 $rule
done
EOF
bash -n "$tmp/runner-firewall"
install -m 0755 "$tmp/runner-firewall" "$fw"
# Console log level 4: the connection log (level 6) goes to the journal only, not to the serial console.
install -d -m 0700 "$(dirname "$printk_before")"
test -e "$printk_before" || cat "$printk" > "$printk_before"
echo 'kernel.printk = 4 4 1 7' > "$printk_dropin"
echo '4 4 1 7' > "$printk"
"$fw"
docker network inspect llmar-online >/dev/null 2>&1 || docker network create --driver bridge --subnet 10.201.0.0/24 -o com.docker.network.bridge.name=br-llmon -o com.docker.network.bridge.enable_icc=false -o com.docker.network.bridge.enable_ip_masquerade=true llmar-online
test "$(docker network inspect llmar-online --format '{{.Driver}} {{index .Options "com.docker.network.bridge.name"}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{index .Options "com.docker.network.bridge.enable_ip_masquerade"}} {{.Internal}} {{.EnableIPv6}} {{range .IPAM.Config}}{{.Subnet}} {{end}}')" = 'bridge br-llmon false true false false 10.201.0.0/24 '
sed -i '/^CONTAINER_EGRESS=/d; /^ONLINE_NETWORK=/d; /^ONLINE_DNS=/d' "$env_file"
echo 'CONTAINER_EGRESS=internet' >> "$env_file"
echo 'ONLINE_NETWORK=llmar-online' >> "$env_file"
echo 'ONLINE_DNS=169.254.169.253' >> "$env_file"
# Check: every rule of this mode is in place, nothing else.
$ipt -C DOCKER-USER -i docker0 -j DROP
$ipt -C DOCKER-USER -i br+ -j DROP
$ipt -C DOCKER-USER -d 169.254.169.254/32 -j DROP
$ipt -C DOCKER-USER -i br-llmon -j RUNNER-ONLINE-OUT
$ipt -C DOCKER-USER -o br-llmon -j RUNNER-ONLINE-IN
test "$($ipt -S DOCKER-USER | sed -n 2,3p)" = "$(printf -- '-A DOCKER-USER %s\n' "-i br-llmon -j RUNNER-ONLINE-OUT" "-o br-llmon -j RUNNER-ONLINE-IN")" || fail "the online jumps are not first in DOCKER-USER"
$ipt -C RUNNER-ONLINE-OUT -m conntrack --ctstate INVALID -j DROP
$ipt -C RUNNER-ONLINE-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ipt -C RUNNER-ONLINE-OUT -o docker0 -j DROP
$ipt -C RUNNER-ONLINE-OUT -o br+ -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 169.254.169.253/32 -p udp --dport 53 -j ACCEPT
$ipt -C RUNNER-ONLINE-OUT -d 169.254.169.253/32 -p tcp --dport 53 -j ACCEPT
$ipt -C RUNNER-ONLINE-OUT -d 0.0.0.0/8 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 10.0.0.0/8 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 100.64.0.0/10 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 127.0.0.0/8 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 169.254.0.0/16 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 172.16.0.0/12 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 192.0.0.0/24 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 192.0.2.0/24 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 192.88.99.0/24 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 192.168.0.0/16 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 198.18.0.0/15 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 198.51.100.0/24 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 203.0.113.0/24 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 224.0.0.0/4 -j DROP
$ipt -C RUNNER-ONLINE-OUT -d 240.0.0.0/4 -j DROP
$ipt -C RUNNER-ONLINE-OUT -p tcp -j LOG --log-prefix "llmar-online: " --log-level 6
$ipt -C RUNNER-ONLINE-OUT -p tcp -m multiport --dports 443,80 -j ACCEPT
$ipt -C RUNNER-ONLINE-OUT -p tcp -j REJECT --reject-with tcp-reset
$ipt -C RUNNER-ONLINE-OUT -j REJECT --reject-with icmp-admin-prohibited
test "$($ipt -S RUNNER-ONLINE-OUT | grep -c '^-A')" = 25 || fail "RUNNER-ONLINE-OUT has other rules"
$ipt -C RUNNER-ONLINE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ipt -C RUNNER-ONLINE-IN -j DROP
test "$($ipt -S RUNNER-ONLINE-IN | grep -c '^-A')" = 2 || fail "RUNNER-ONLINE-IN has other rules"
$ipt -t nat -C POSTROUTING -s 10.201.0.0/24 ! -o br-llmon -j MASQUERADE  # Docker's NAT for the online network
$ipt -C RUNNER-BRIDGE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ipt -C RUNNER-BRIDGE-IN -p tcp -d 172.17.0.1/32 --dport 8088 -j ACCEPT
$ipt -C RUNNER-BRIDGE-IN -j DROP
test "$($ipt -S RUNNER-BRIDGE-IN | grep -c '^-A')" = 3 || fail "RUNNER-BRIDGE-IN has other rules"
read -r console_level _ < "$printk"
test "$console_level" -le 6 || fail "kernel console log level is $console_level (the connection log would reach the serial console)"
grep -qx 'kernel.printk = 4 4 1 7' "$printk_dropin" || fail "console level drop-in missing"
test -s "$printk_before" || fail "previous console level not kept"
cmp -s "$tmp/runner-firewall" "$fw" || fail "the firewall script changed underneath"
grep -qx 'CONTAINER_EGRESS=internet' "$env_file" || fail "env file not updated"
grep -qx 'ONLINE_NETWORK=llmar-online' "$env_file" || fail "env file not updated"
grep -qx 'ONLINE_DNS=169.254.169.253' "$env_file" || fail "env file not updated"
echo "runner-egress: internet; previous files in $backup"
