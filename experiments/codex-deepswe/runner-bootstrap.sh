#!/bin/bash
# Prepares the experiment runner (AL2023 x86_64, run as root through SSM Run Command). Either:
#   bash runner-bootstrap.sh <repo-url> <commit-sha> [workdir]        # git clone at a pinned commit
#   bash runner-bootstrap.sh --tarball <path> <sha256> [workdir]      # tarball from `cli.py pack`, shipped over SSM
# Env: LLMAR_PROXY_PORT (default 8088), the port the runner firewall opens to the container bridges.
# Waits for Docker, installs a pinned uv (sha256-checked), puts the harness in <workdir>/repo, then fetches the pinned
# dataset and the pinned Codex binary (both sha256-checked by cli.py). Idempotent: results/, data/ and bin/ under the
# harness survive a re-run. No credentials needed.
set -euo pipefail
UV_VERSION=0.12.6
UV_SHA256=14e4172aace66a475062cebec7ca04f497d5619e95325dfcc9e4447b9c516846

MODE=git
if [ "${1:-}" = "--tarball" ]; then
  MODE=tarball
  TARBALL=${2:?tarball path}
  WANT=${3:?tarball sha256}
  WORK=${4:-/opt/llmar-experiment}
  [[ $WANT =~ ^[0-9a-f]{64}$ ]] || { echo "sha256 must be 64 hex characters" >&2; exit 2; }
else
  REPO_URL=${1:?repo url or --tarball}
  SHA=${2:?commit sha}
  WORK=${3:-/opt/llmar-experiment}
  [[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo "commit sha must be 40 hex characters" >&2; exit 2; }
fi

PROXY_PORT=${LLMAR_PROXY_PORT:-8088}
[[ $PROXY_PORT =~ ^[0-9]{4,5}$ ]] || { echo "LLMAR_PROXY_PORT must be a port number" >&2; exit 2; }

# Review M4: user data (Docker, the bridge firewall) must have finished, and the firewall must be in place.
if command -v cloud-init >/dev/null; then
  rc=0; cloud-init status --wait >/dev/null || rc=$?
  # Newer cloud-init exits 2 for "done with recoverable errors"; accept that only when it reports status: done.
  if [ "$rc" -eq 2 ] && cloud-init status 2>/dev/null | grep -Eq '^status: done$'; then rc=0; fi
  [ "$rc" -eq 0 ] || { echo "cloud-init did not finish (exit $rc)" >&2; exit 1; }
fi
for _ in $(seq 1 60); do systemctl is-active --quiet docker && break; sleep 5; done
systemctl is-active --quiet docker || { echo "docker is not active" >&2; exit 1; }
ipt=/usr/sbin/iptables
bridge_in=$($ipt -S RUNNER-BRIDGE-IN 2>/dev/null) || { echo "firewall chain RUNNER-BRIDGE-IN is missing" >&2; exit 1; }
grep -Eq -- "^-A RUNNER-BRIDGE-IN -p tcp (-m tcp )?--dport $PROXY_PORT -j ACCEPT$" <<<"$bridge_in" \
  || { echo "RUNNER-BRIDGE-IN does not accept tcp/$PROXY_PORT" >&2; exit 1; }
[ "$(grep '^-A RUNNER-BRIDGE-IN' <<<"$bridge_in" | tail -1)" = "-A RUNNER-BRIDGE-IN -j DROP" ] \
  || { echo "RUNNER-BRIDGE-IN does not end in DROP" >&2; exit 1; }
$ipt -S DOCKER-USER | grep -Eq -- '^-A DOCKER-USER -i br\+ -j DROP$' || { echo "DOCKER-USER has no '-i br+ -j DROP'" >&2; exit 1; }
for ifc in docker0 br+; do
  $ipt -S INPUT | grep -Fq -- "-A INPUT -i $ifc -j RUNNER-BRIDGE-IN" || { echo "INPUT does not send $ifc to RUNNER-BRIDGE-IN" >&2; exit 1; }
done

if ! /usr/local/bin/uv --version 2>/dev/null | grep -q "$UV_VERSION"; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/uv.tgz" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-musl.tar.gz"
  echo "$UV_SHA256  $tmp/uv.tgz" | sha256sum -c -
  tar -xzf "$tmp/uv.tgz" -C "$tmp"
  install -m 0755 "$tmp/uv-x86_64-unknown-linux-musl/uv" /usr/local/bin/uv
  rm -rf "$tmp"
fi

umask 077
mkdir -p "$WORK"
if [ "$MODE" = tarball ]; then
  echo "$WANT  $TARBALL" | sha256sum -c -
  # Only regular files and directories, only under the two packed roots, no absolute paths or '..'.
  bad=$(tar -tvzf "$TARBALL" | awk '{print substr($1,1,1)}' | grep -v '^[-d]$' || true)
  [ -z "$bad" ] || { echo "tarball contains links or special files" >&2; exit 1; }
  if tar -tzf "$TARBALL" | grep -Ev '^(experiments/codex-deepswe|packages/pricing/data)(/|$)' | grep -q .; then
    echo "tarball contains paths outside the packed roots" >&2; exit 1
  fi
  if tar -tzf "$TARBALL" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "tarball contains absolute or parent paths" >&2; exit 1
  fi
  stage=$(mktemp -d "$WORK/stage.XXXXXX")
  tar -xzf "$TARBALL" -C "$stage" --no-same-owner --no-same-permissions
  mkdir -p "$WORK/repo/experiments" "$WORK/repo/packages/pricing"
  # Replace the code; keep the harness's local results/, data/ and bin/.
  h="$WORK/repo/experiments/codex-deepswe"
  mkdir -p "$h"
  find "$h" -mindepth 1 -maxdepth 1 ! -name results ! -name data ! -name bin -exec rm -rf {} +
  cp -a "$stage/experiments/codex-deepswe/." "$h/"
  rm -rf "$WORK/repo/packages/pricing/data"
  cp -a "$stage/packages/pricing/data" "$WORK/repo/packages/pricing/data"
  rm -rf "$stage"
  echo "$WANT" > "$WORK/repo/.llmar-tarball-sha256"
  VERSION="tarball ${WANT:0:12}"
else
  if [ ! -d "$WORK/repo/.git" ]; then
    git clone --quiet "$REPO_URL" "$WORK/repo"
  fi
  git -C "$WORK/repo" fetch --quiet origin
  git -C "$WORK/repo" checkout --quiet --detach "$SHA"
  test "$(git -C "$WORK/repo" rev-parse HEAD)" = "$SHA"
  VERSION="git $(git -C "$WORK/repo" rev-parse --short HEAD)"
fi

cd "$WORK/repo"
# uv must use CPython 3.12 (pyarrow 21 ships cp312 wheels; a newer managed Python would build from source).
export UV_PYTHON=3.12
# Review L8: dependencies come from the committed script lock (cli.py.lock); --locked fails if it is stale.
uv run --locked --quiet experiments/codex-deepswe/cli.py fetch-dataset
uv run --locked --quiet experiments/codex-deepswe/cli.py fetch-codex --arch x86_64
echo "ready: $VERSION, uv $(uv --version | cut -d' ' -f2), docker $(docker version --format '{{.Server.Version}}')"
