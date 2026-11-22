# shellcheck shell=bats

bats_require_minimum_version 1.5.0

setup() {
  local test_dir
  test_dir=$(cd -- "$(dirname -- "$BATS_TEST_FILENAME")" && pwd -P)
  tmp=$(cd -- "$BATS_TEST_TMPDIR" && pwd)
  shim="$test_dir/../hooks/local-decider-hook.sh"
  home="$tmp/home"
  fakebin="$tmp/fakebin"
  sysbin="$tmp/sysbin"

  mkdir -p "$tmp/plugin/hooks" "$tmp/plugin/dist" "$home" "$fakebin" "$sysbin"
  cp "$shim" "$tmp/plugin/hooks/local-decider-hook.sh"
  : >"$tmp/plugin/dist/local-decider-hook.mjs"
  ln -s "$(command -v dirname)" "$sysbin/dirname"

  # The fake node prints its argv.
  printf '#!/bin/sh\necho "node:$*"\n' >"$fakebin/node"
  chmod +x "$fakebin/node"
}

@test "uses node on PATH" {
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  local expected="node:$tmp/plugin/dist/local-decider-hook.mjs claude Stop"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

@test "falls back to the mise node shim" {
  mkdir -p "$home/.local/share/mise/shims"
  cp "$fakebin/node" "$home/.local/share/mise/shims/node"
  run env HOME="$home" PATH="$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" codex Stop
  [ "$status" -eq 0 ]
  local expected="node:$tmp/plugin/dist/local-decider-hook.mjs codex Stop"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

@test "fails open with no node and empty stdout" {
  if [ -x /opt/homebrew/bin/node ] || [ -x /usr/local/bin/node ]; then
    skip "a system node is installed in a fallback location"
  fi
  run env HOME="$home" PATH="$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  [ -z "$output" ] || { printf 'expected empty stdout, got %s\n' "$output"; return 1; }
}

@test "fails open when dist/local-decider-hook.mjs is missing" {
  rm "$tmp/plugin/dist/local-decider-hook.mjs"
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  [ -z "$output" ] || { printf 'expected empty stdout, got %s\n' "$output"; return 1; }
}

@test "SessionStart with the bundle missing prints a systemMessage notice" {
  rm "$tmp/plugin/dist/local-decider-hook.mjs"
  run --separate-stderr env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude SessionStart
  [ "$status" -eq 0 ]
  [[ "$output" == '{"systemMessage":"local-decider: hooks inactive (bundle dist/local-decider-hook.mjs missing).'* ]] || { printf 'got %s\n' "$output"; return 1; }
  [ -z "$stderr" ] || { printf 'expected empty stderr, got %s\n' "$stderr"; return 1; }
}

@test "Codex SessionStart with the bundle missing prints a systemMessage notice" {
  rm "$tmp/plugin/dist/local-decider-hook.mjs"
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" codex SessionStart
  [ "$status" -eq 0 ]
  [[ "$output" == '{"systemMessage":"local-decider: hooks inactive (bundle '* ]] || { printf 'got %s\n' "$output"; return 1; }
}

@test "unknown harness SessionStart with the bundle missing prints nothing" {
  rm "$tmp/plugin/dist/local-decider-hook.mjs"
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" other SessionStart
  [ "$status" -eq 0 ]
  [ -z "$output" ] || { printf 'expected empty stdout, got %s\n' "$output"; return 1; }
}

@test "debug Stop with the bundle missing writes a diagnostic to stderr only" {
  rm "$tmp/plugin/dist/local-decider-hook.mjs"
  run --separate-stderr env HOME="$home" PATH="$fakebin:$sysbin" LOCAL_DECIDER_DEBUG=1 /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  [ -z "$output" ] || { printf 'expected empty stdout, got %s\n' "$output"; return 1; }
  local expected="local-decider: bundle dist/local-decider-hook.mjs missing (root $tmp/plugin); failing open"
  [ "$stderr" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$stderr"; return 1; }
}

@test "SessionStart with no node prints a notice" {
  if [ -x /opt/homebrew/bin/node ] || [ -x /usr/local/bin/node ]; then
    skip "a system node is installed in a fallback location"
  fi
  run --separate-stderr env HOME="$home" PATH="$sysbin" LOCAL_DECIDER_DEBUG=1 /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude SessionStart
  [ "$status" -eq 0 ]
  [[ "$output" == '{"systemMessage":"local-decider: hooks inactive (node not found).'* ]] || { printf 'got %s\n' "$output"; return 1; }
  [[ "$stderr" == 'local-decider: node not found (root '* ]] || { printf 'got stderr %s\n' "$stderr"; return 1; }
}

@test "SessionStart with the bundle present runs node" {
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude SessionStart
  [ "$status" -eq 0 ]
  local expected="node:$tmp/plugin/dist/local-decider-hook.mjs claude SessionStart"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

@test "Codex SessionStart with the bundle present exits without running node" {
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" codex SessionStart
  [ "$status" -eq 0 ]
  [ -z "$output" ] || { printf 'expected empty stdout (node not run), got %s\n' "$output"; return 1; }
}

@test "the mise node shim runs from the plugin root" {
  mkdir -p "$home/.local/share/mise/shims" "$tmp/workspace"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\necho "pwd:$PWD"\n' >"$home/.local/share/mise/shims/node"
  chmod +x "$home/.local/share/mise/shims/node"
  cd "$tmp/workspace"
  run env HOME="$home" PATH="$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  local expected="pwd:$tmp/plugin"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

@test "a node on PATH keeps the caller's working directory" {
  # shellcheck disable=SC2016
  printf '#!/bin/sh\necho "pwd:$PWD"\n' >"$fakebin/node"
  mkdir -p "$tmp/workspace"
  cd "$tmp/workspace"
  run env HOME="$home" PATH="$fakebin:$sysbin" /bin/sh "$tmp/plugin/hooks/local-decider-hook.sh" claude Stop
  [ "$status" -eq 0 ]
  local expected="pwd:$tmp/workspace"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

# The Codex hooks file locates the launcher through PLUGIN_ROOT (native) or CLAUDE_PLUGIN_ROOT
# (compat alias). Run each command string through sh the way the harness does.
codex_command() {
  local hooks_file="$BATS_TEST_DIRNAME/../hooks/codex-hooks.json"
  sed -n 's/.*"command": "\(.*\)",\{0,1\}$/\1/p' "$hooks_file" | sed 's/\\"/"/g' | grep ' Stop$'
}

@test "the Codex hook command expands with only PLUGIN_ROOT set" {
  local cmd
  cmd=$(codex_command)
  ln -s /bin/sh "$sysbin/sh"
  run env -u CLAUDE_PLUGIN_ROOT HOME="$home" PATH="$fakebin:$sysbin" PLUGIN_ROOT="$tmp/plugin" /bin/sh -c "$cmd"
  [ "$status" -eq 0 ]
  local expected="node:$tmp/plugin/dist/local-decider-hook.mjs codex Stop"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}

@test "the Codex hook command expands with only CLAUDE_PLUGIN_ROOT set" {
  local cmd
  cmd=$(codex_command)
  ln -s /bin/sh "$sysbin/sh"
  run env -u PLUGIN_ROOT HOME="$home" PATH="$fakebin:$sysbin" CLAUDE_PLUGIN_ROOT="$tmp/plugin" /bin/sh -c "$cmd"
  [ "$status" -eq 0 ]
  local expected="node:$tmp/plugin/dist/local-decider-hook.mjs codex Stop"
  [ "$output" = "$expected" ] || { printf 'expected %s, got %s\n' "$expected" "$output"; return 1; }
}
