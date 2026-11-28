#!/bin/sh
# Fail when pnpm-lock.yaml records a tarball URL off the public npm registry, such as a local
# registry mirror's host. A mirror must be declared with its serverType under `registries` in
# pnpm-workspace.yaml so pnpm leaves its tarball URLs out.
# A dependency that really is a tarball elsewhere must be added to ALLOWED below on purpose.
# Usage: scripts/check-lockfile-registry.sh [pnpm-lock.yaml]
set -eu

lockfile=${1:-pnpm-lock.yaml}
if [ ! -r "$lockfile" ]; then
    echo "::error::check-lockfile-registry.sh: cannot read $lockfile" >&2
    exit 2
fi

ALLOWED='https://registry.npmjs.org/'

bad=$(grep -o 'tarball: *[^,} ]*' "$lockfile" | sed 's/^tarball: *//' | while IFS= read -r url; do
    case "$url" in
        "$ALLOWED"*) ;;
        *) printf '%s\n' "$url" ;;
    esac
done)

if [ -n "$bad" ]; then
    count=$(printf '%s\n' "$bad" | wc -l | tr -d ' ')
    echo "::error file=$lockfile::$count tarball URL(s) off $ALLOWED; declare the mirror's serverType in pnpm-workspace.yaml, or resolve them with pnpm install --registry=$ALLOWED:" >&2
    printf '%s\n' "$bad" | head -10 >&2
    exit 1
fi
