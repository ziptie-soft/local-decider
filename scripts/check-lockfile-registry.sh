#!/bin/sh
# Fail when pnpm-lock.yaml records a tarball URL off the public npm registry, such as a local
# registry mirror's host (see .pnpmfile.mjs, which strips pnpr mirror URLs as pnpm writes them).
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
    echo "::error file=$lockfile::$count tarball URL(s) off $ALLOWED; resolve them from the public registry (pnpm install --registry=$ALLOWED) or check .pnpmfile.mjs:" >&2
    printf '%s\n' "$bad" | head -10 >&2
    exit 1
fi
