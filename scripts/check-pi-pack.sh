#!/bin/sh
# Checks the pi package's npm contents and activates its extracted extension with a fake pi API.
# Usage: scripts/check-pi-pack.sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/packages/pi-plugin"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/local-decider-pi-pack.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
listing=$(npm_config_cache="$tmp/cache" npm pack --dry-run --json | grep '"path"')

status=0
for want in extension/index.ts extension/core/guard.ts extension/core/block.ts LICENSE NOTICE; do
  if ! printf '%s\n' "$listing" | grep -q "\"path\": \"$want\""; then
    echo "::error::npm pack is missing $want" >&2
    status=1
  fi
done
if printf '%s\n' "$listing" | grep -q '"path": "test/'; then
  echo "::error::npm pack includes test/" >&2
  status=1
fi
[ "$status" -eq 0 ] || exit "$status"

archive=$(npm_config_cache="$tmp/cache" npm pack --silent --pack-destination "$tmp")
tar -xzf "$tmp/$archive" -C "$tmp"
node "$root/scripts/pi-pack-smoke.mjs" "$tmp/package"
