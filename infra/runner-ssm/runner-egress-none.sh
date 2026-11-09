#!/bin/bash
# Sets this llmar runner's container egress to 'none'. Generated from infra/src/runner.ts (runnerEgressSwitchScript);
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
EOF
bash -n "$tmp/runner-firewall"
install -m 0755 "$tmp/runner-firewall" "$fw"
"$fw"
# Online leftovers: the jumps, then the chains (the drops above them are in place).
for rule in "-i br-llmon -j RUNNER-ONLINE-OUT" "-o br-llmon -j RUNNER-ONLINE-IN"; do
  while $ipt -C DOCKER-USER $rule 2>/dev/null; do $ipt -D DOCKER-USER $rule; done
done
for chain in RUNNER-ONLINE-OUT RUNNER-ONLINE-IN; do
  if $ipt -n -L $chain >/dev/null 2>&1; then $ipt -F $chain; $ipt -X $chain; fi
done
# The console log level from before internet egress, and no drop-in.
rm -f "$printk_dropin"
if [ -e "$printk_before" ]; then cat "$printk_before" > "$printk"; rm -f "$printk_before"; fi
sed -i '/^CONTAINER_EGRESS=/d; /^ONLINE_NETWORK=/d; /^ONLINE_DNS=/d' "$env_file"
# Check: every rule of this mode is in place, nothing else.
$ipt -C DOCKER-USER -i docker0 -j DROP
$ipt -C DOCKER-USER -i br+ -j DROP
$ipt -C DOCKER-USER -d 169.254.169.254/32 -j DROP
absent $ipt -C DOCKER-USER -i br-llmon -j RUNNER-ONLINE-OUT
absent $ipt -C DOCKER-USER -o br-llmon -j RUNNER-ONLINE-IN
absent $ipt -n -L RUNNER-ONLINE-OUT
absent $ipt -n -L RUNNER-ONLINE-IN
$ipt -C RUNNER-BRIDGE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ipt -C RUNNER-BRIDGE-IN -p tcp -d 172.17.0.1/32 --dport 8088 -j ACCEPT
$ipt -C RUNNER-BRIDGE-IN -j DROP
test "$($ipt -S RUNNER-BRIDGE-IN | grep -c '^-A')" = 3 || fail "RUNNER-BRIDGE-IN has other rules"
absent test -e "$printk_dropin"
absent test -e "$printk_before"
cmp -s "$tmp/runner-firewall" "$fw" || fail "the firewall script changed underneath"
absent grep -qE '^(CONTAINER_EGRESS|ONLINE_NETWORK|ONLINE_DNS)=' "$env_file"
echo "runner-egress: none; previous files in $backup"
