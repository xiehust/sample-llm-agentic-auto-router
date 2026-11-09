#!/bin/bash
# Dry run of the egress switch scripts against real iptables-nft, without Docker or root: run it as
#   unshare -rn --pid --fork --mount-proc --kill-child bash switch.sh DIR
# DIR holds fw-none.sh (a deployed runner's firewall), runner-egress-internet.sh and runner-egress-none.sh. A fake
# runner under DIR/root (env file, firewall, drop-in) and stubs for docker and systemctl stand in for the host; the
# paths in the scripts are rewritten to it. Sequence: deployed (none) -> internet -> internet -> none -> none ->
# internet. Checks idempotence, that `none` restores the deployed filter table, env file and console log level
# exactly, and that `internet` sets the console level to 4.
set -euo pipefail
D="$(cd "$1" && pwd)"; R="$D/root"
ipt=/usr/sbin/iptables
rm -rf "$R"; mkdir -p "$R/bin" "$R/backup"
$ipt -N DOCKER-USER; $ipt -A DOCKER-USER -j RETURN; $ipt -A FORWARD -j DOCKER-USER
$ipt -t nat -A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
strip() { sed -e '/modprobe br_netfilter/d' -e '/sysctl -q -w net.bridge/d' "$1"; }
strip "$D/fw-none.sh" > "$R/runner-firewall"; chmod 755 "$R/runner-firewall"
printf 'RUNNER_INDEX=0\nPROXY_PORT=8088\nDRIVER_PYTHON=/x\n' > "$R/env"; cp "$R/env" "$R/env.deployed"
printf '8\t4\t1\t7\n' > "$R/printk"; cp "$R/printk" "$R/printk.deployed"  # AL2023 on EC2: console level 8
echo "ExecStartPost=$R/runner-firewall" > "$R/dropin"
printf '#!/bin/bash\nexit 0\n' > "$R/bin/systemctl"
cat > "$R/bin/docker" <<S
#!/bin/bash
case "\$1 \$2" in
  "ps -q") exit 0;;
  "network inspect") test -f "$R/net" || exit 1; [ "\${4:-}" = --format ] && echo 'bridge br-llmon false true false false 10.201.0.0/24 '; exit 0;;
  "network create") touch "$R/net"; $ipt -t nat -A POSTROUTING -s 10.201.0.0/24 ! -o br-llmon -j MASQUERADE;;
  *) echo "unexpected: docker \$*" >&2; exit 1;;
esac
S
chmod 755 "$R/bin/"*
for m in internet none; do
  strip "$D/runner-egress-$m.sh" | sed -e "s#^env_file=.*#env_file=$R/env#" -e "s#^fw=.*#fw=$R/runner-firewall#" \
    -e "s#^dropin=.*#dropin=$R/dropin#" -e "s#^backup_root=.*#backup_root=$R/backup#" \
    -e "s#^printk=.*#printk=$R/printk#" -e "s#^printk_dropin=.*#printk_dropin=$R/sysctl-console.conf#" \
    -e "s#^printk_before=.*#printk_before=$R/state/printk.before#" > "$R/switch-$m.sh"
done
export PATH="$R/bin:$PATH"
"$R/runner-firewall"; $ipt -S > "$R/s0"
step() { bash "$R/switch-$1.sh" >/dev/null; $ipt -S > "$R/s$2"; cp "$R/env" "$R/e$2"; cp "$R/printk" "$R/p$2"; test -e "$R/sysctl-console.conf" && echo y > "$R/d$2" || echo n > "$R/d$2"; }
step internet 1; step internet 2; step none 3; step none 4; step internet 5
cmp "$R/s1" "$R/s2" && cmp "$R/s1" "$R/s5" || { echo "internet is not idempotent"; exit 1; }
cmp "$R/s0" "$R/s3" && cmp "$R/s0" "$R/s4" || { echo "none does not restore the deployed rules"; diff "$R/s0" "$R/s3"; exit 1; }
cmp "$R/e3" "$R/env.deployed" || { echo "none does not restore the env file"; exit 1; }
grep -c '' "$R/e1" | grep -qx 6 && cmp "$R/e1" "$R/e5" || { echo "internet env keys wrong"; cat "$R/e1"; exit 1; }
grep -qx '4 4 1 7' "$R/p1" && cmp "$R/p1" "$R/p5" || { echo "internet does not quiet the console"; exit 1; }
cmp "$R/p3" "$R/printk.deployed" && cmp "$R/p4" "$R/printk.deployed" || { echo "none does not restore the console level"; exit 1; }
grep -qx n "$R/d3" && grep -qx n "$R/d4" && grep -qx y "$R/d1" && grep -qx y "$R/d5" || { echo "console drop-in wrong"; exit 1; }
test "$(ls "$R/backup" | wc -l)" = 5 || { echo "expected 5 backups"; exit 1; }
echo "--- internet"; cat "$R/s1"; echo "--- env"; cat "$R/e1"; echo ok
