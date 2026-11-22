#!/bin/sh
# Runs dist/local-decider-hook.mjs with whichever node can be found. A harness started from the macOS GUI has
# a bare PATH, so look in the usual places. With no node, or an unbuilt checkout without
# dist/local-decider-hook.mjs, fail open (exit 0): SessionStart prints one static notice so the
# broken install is visible, every other event prints nothing.
harness=$1
event=$2

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 0

# notice <reason>: report an inactive install and fail open. <reason> is a fixed string from this
# script, never hook input. Claude Code and Codex both accept `systemMessage` from SessionStart.
notice() {
  if [ "${LOCAL_DECIDER_DEBUG:-}" = 1 ]; then
    printf 'local-decider: %s (root %s); failing open\n' "$1" "$root" >&2
  fi
  if [ "$event" = SessionStart ]; then
    case $harness in
      claude | codex)
        printf '{"systemMessage":"local-decider: hooks inactive (%s). Reinstall the plugin or rebuild it with: pnpm --filter @ziptie-soft/local-decider-hooks build"}\n' "$1"
        ;;
      *) ;;
    esac
  fi
  exit 0
}

node_bin=$(command -v node 2>/dev/null)
run_from_root=
if [ -z "$node_bin" ]; then
  for candidate in \
    "$HOME/.local/share/mise/shims/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      node_bin=$candidate
      run_from_root=1
      break
    fi
  done
fi
[ -n "$node_bin" ] || notice 'node not found'

[ -f "$root/dist/local-decider-hook.mjs" ] || notice 'bundle dist/local-decider-hook.mjs missing'

# The runner's SessionStart work (gateway health notice, pending purge) is Claude Code only, so
# a healthy Codex install skips starting node.
if [ "$harness" = codex ] && [ "$event" = SessionStart ]; then
  exit 0
fi

# A mise shim resolves node for the project in the current directory, which is the agent's
# workspace: it may install a node of its own (slower than the hook timeout), pin one the bundle
# does not support, or sit in an untrusted mise.toml. The bundle takes cwd from the hook payload,
# so run the shim from the plugin root, where the global node applies.
if [ -n "$run_from_root" ]; then
  cd -- "$root" || exit 0
fi

exec "$node_bin" "$root/dist/local-decider-hook.mjs" "$@"
