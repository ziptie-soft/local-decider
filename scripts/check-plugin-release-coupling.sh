#!/bin/sh
# release-please tracks the plugin directory, while its executable bundles shared source.
# Usage: scripts/check-plugin-release-coupling.sh <base-ref> <head-ref> <pr-title> <author> <head-branch>
set -eu

if [ "$#" -ne 5 ]; then
  echo 'usage: check-plugin-release-coupling.sh <base-ref> <head-ref> <pr-title> <author> <head-branch>' >&2
  exit 2
fi

# Generated release PRs bump package manifests; their bot identity and branch come from the
# authenticated pull_request event, not the editable title.
case "$4:$5" in
  'github-actions[bot]:release-please--branches--master'|'github-actions[bot]:release-please--branches--master--components--'*) exit 0 ;;
esac

# The lockfile without the Paseo plugin's importer block, which never feeds the hook bundle.
lock_without_paseo_plugin() {
  git show "$1:pnpm-lock.yaml" 2>/dev/null | awk '
    /^  packages\/paseo-plugin:/ { skip = 1; next }
    skip && (/^[^ ]/ || /^  [^ ]/) { skip = 0 }
    !skip
  '
}

lock=''
if [ "$(lock_without_paseo_plugin "$1")" != "$(lock_without_paseo_plugin "$2")" ]; then
  lock=pnpm-lock.yaml
fi

# Be conservative about core source: the hook bundle imports through its public barrel and
# future imports can change which files esbuild includes. Tests and documentation do not ship.
shared=$(git diff --name-only --no-renames "$1" "$2" -- \
  packages/core/src packages/core/package.json \
  packages/hooks/src packages/hooks/build.mjs packages/hooks/package.json)
shared="$shared$lock"
if [ -z "$shared" ]; then
  exit 0
fi

plugin=$(git diff --name-only --no-renames "$1" "$2" -- plugins/local-decider)
if [ -z "$plugin" ]; then
  echo '::error::Shared hook/core source changed without a plugins/local-decider change; include a plugin change to trigger its release.' >&2
  exit 1
fi

# PRs are squash-merged using the title. Only fix, feat and a breaking change are
# guaranteed to create a release for this Node package in the default configuration.
releasable='^(fix|feat)(\([a-z0-9./_-]+\))?!?: [^[:space:]]|^(build|chore|ci|docs|perf|refactor|revert|style|test)(\([a-z0-9./_-]+\))?!: [^[:space:]]'
if ! printf '%s\n' "$3" | grep -Eq "$releasable"; then
  echo '::error::Use a fix or feat PR title, or mark a breaking change, to release the updated plugin.' >&2
  exit 1
fi
