#!/usr/bin/env bash
# Mirror the Trellis task documents (Markdown only) into docs/tasks/ so they can be versioned
# without tracking .trellis/ itself. Run before committing documentation changes.
#   scripts/sync-docs.sh          sync, then check the copies for account ids and credentials
#   scripts/sync-docs.sh --check  only check that docs/tasks/ is in sync (exit 1 if not)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/.trellis/tasks/"
dst="$root/docs/tasks/"
# rsync uses the first matching rule, so exclusions come before the directory include.
filters=(
  --exclude='/00-bootstrap-guidelines/'  # Trellis setup task, not project documentation
  --exclude='research/raw/'              # raw third-party page dumps; summaries cite the URLs
  --include='*/'
  --include='*.md'
  --exclude='*'
)
if [[ "${1:-}" == "--check" ]]; then
  if rsync -a --delete --delete-excluded --prune-empty-dirs --dry-run --itemize-changes "${filters[@]}" "$src" "$dst" | grep -q .; then
    echo "docs/tasks/ is out of date: run scripts/sync-docs.sh" >&2
    exit 1
  fi
  echo "docs/tasks/ is in sync"
  exit 0
fi
mkdir -p "$dst"
rsync -a --delete --delete-excluded --prune-empty-dirs "${filters[@]}" "$src" "$dst"
# Refuse to leave account ids or credentials in versioned docs.
account="${LLMAR_SPIKE_ACCOUNT:-}"
pattern='ASIA[A-Z0-9]{16}|AKIA[A-Z0-9]{16}|IQoJ[A-Za-z0-9+/=]{20,}|BEGIN [A-Z ]*PRIVATE KEY'
[[ -n "$account" ]] && pattern="$pattern|$account"
if grep -rnE "$pattern" "$dst" >&2; then
  echo "sensitive values found in docs/tasks/ (see above): redact them in .trellis/ and re-run" >&2
  exit 1
fi
echo "synced $(find "$dst" -name '*.md' | wc -l) documents into docs/tasks/"
