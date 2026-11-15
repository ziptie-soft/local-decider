# shellcheck shell=bats

setup() {
  script="$(cd -- "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/check-plugin-release-coupling.sh"
  repo="$BATS_TEST_TMPDIR/repo"
  git init --quiet "$repo"
  mkdir -p "$repo/packages/core/src" "$repo/packages/hooks/src" "$repo/plugins/local-decider"
  printf 'base\n' >"$repo/packages/core/src/client.ts"
  printf 'base\n' >"$repo/packages/hooks/src/run.ts"
  printf 'base\n' >"$repo/plugins/local-decider/README.md"
  git -C "$repo" add .
  git -C "$repo" -c user.name=Fixture -c user.email=fixture@example.com \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet -m 'initial'
  base=$(git -C "$repo" rev-parse HEAD)
  title='fix(plugin): update the hook'
  author='contributor'
  branch='feature'
}

commit_changes() {
  git -C "$repo" add -A
  git -C "$repo" -c user.name=Fixture -c user.email=fixture@example.com \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet -m 'change'
}

check_diff() {
  cd "$repo" || return 1
  "$script" "$base" HEAD "$title" "$author" "$branch"
}

@test "rejects shared source changes without a plugin change" {
  printf 'change\n' >>"$repo/packages/core/src/client.ts"
  commit_changes
  run check_diff
  [ "$status" -eq 1 ]
  [[ "$output" == *'without a plugins/local-decider change'* ]]
}

@test "requires a plugin release for lockfile changes that can alter the bundle" {
  printf 'esbuild: changed\n' >"$repo/pnpm-lock.yaml"
  commit_changes
  run check_diff
  [ "$status" -eq 1 ]
  [[ "$output" == *'without a plugins/local-decider change'* ]]
}

write_lock() {
  cat >"$repo/pnpm-lock.yaml" <<EOF
lockfileVersion: '9.0'

importers:

  packages/hooks:
    devDependencies:
      esbuild:
        version: $1

  packages/paseo-plugin:
    $2:
      zod:
        version: 4.6.7

  plugins/local-decider: {}

packages:

  zod@4.6.7:
    resolution: {integrity: sha512-x}
EOF
}

@test "ignores lockfile changes confined to the Paseo plugin's importer" {
  write_lock 0.28.2 dependencies
  commit_changes
  base=$(git -C "$repo" rev-parse HEAD)
  write_lock 0.28.2 devDependencies
  commit_changes
  run check_diff
  [ "$status" -eq 0 ]
}

@test "still requires a plugin release when another importer changes alongside" {
  write_lock 0.28.2 dependencies
  commit_changes
  base=$(git -C "$repo" rev-parse HEAD)
  write_lock 0.28.3 devDependencies
  commit_changes
  run check_diff
  [ "$status" -eq 1 ]
  [[ "$output" == *'without a plugins/local-decider change'* ]]
}

@test "accepts shared source changes accompanied by a plugin change" {
  printf 'change\n' >>"$repo/packages/hooks/src/run.ts"
  printf 'change\n' >>"$repo/plugins/local-decider/README.md"
  commit_changes
  run check_diff
  [ "$status" -eq 0 ]
}

@test "accepts a test-only change without a plugin change" {
  mkdir -p "$repo/packages/core/test"
  printf 'test\n' >"$repo/packages/core/test/client.test.ts"
  commit_changes
  run check_diff
  [ "$status" -eq 0 ]
}

@test "detects deleted shared source" {
  git -C "$repo" rm --quiet packages/hooks/src/run.ts
  commit_changes
  run check_diff
  [ "$status" -eq 1 ]
}

@test "rejects non-releasing PR titles even when the plugin changed" {
  printf 'change\n' >>"$repo/packages/core/src/client.ts"
  printf 'change\n' >>"$repo/plugins/local-decider/README.md"
  commit_changes
  title='chore(plugin): refresh the hook'
  run check_diff
  [ "$status" -eq 1 ]
  [[ "$output" == *'Use a fix or feat PR title'* ]]
}

@test "accepts a breaking PR title" {
  printf 'change\n' >>"$repo/packages/core/src/client.ts"
  printf 'change\n' >>"$repo/plugins/local-decider/README.md"
  commit_changes
  title='refactor(plugin)!: change the hook contract'
  run check_diff
  [ "$status" -eq 0 ]
}

@test "accepts a release-please bot PR with its expected branch" {
  printf 'version\n' >"$repo/packages/core/package.json"
  commit_changes
  title='chore(master): release'
  author='github-actions[bot]'
  branch='release-please--branches--master'
  run check_diff
  [ "$status" -eq 0 ]
}

@test "does not exempt a contributor or an unrelated bot branch" {
  printf 'version\n' >"$repo/packages/core/package.json"
  commit_changes
  title='chore(master): release'
  branch='release-please--branches--master'
  run check_diff
  [ "$status" -eq 1 ]
  author='github-actions[bot]'
  branch='release-please--branches--master-evil'
  run check_diff
  [ "$status" -eq 1 ]
}
