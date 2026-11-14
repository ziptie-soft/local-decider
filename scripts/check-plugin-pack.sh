#!/bin/sh
# Checks npm package contents and exercises its extracted Codex hook.
# Run after `pnpm -r build`. Usage: scripts/check-plugin-pack.sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/plugins/local-decider"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/local-decider-pack.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
listing=$(npm_config_cache="$tmp/cache" npm pack --dry-run --json | grep '"path"')

status=0
for want in dist/local-decider-hook.mjs hooks/local-decider-auto-mode.mjs hooks/local-decider-hook.sh hooks/hooks.json \
  hooks/codex-hooks.json .claude-plugin/plugin.json .codex-plugin/plugin.json LICENSE NOTICE; do
  if ! printf '%s\n' "$listing" | grep -q "\"path\": \"$want\""; then
    echo "::error::npm pack is missing $want" >&2
    status=1
  fi
done
if printf '%s\n' "$listing" | grep -q '"path": "tests/'; then
  echo "::error::npm pack includes tests/" >&2
  status=1
fi
[ "$status" -eq 0 ] || exit "$status"

archive=$(npm_config_cache="$tmp/cache" npm pack --silent --pack-destination "$tmp")
tar -xzf "$tmp/$archive" -C "$tmp"
node "$root/plugins/local-decider/tests/pack-smoke.mjs" "$tmp/package"
