# ADR-0009: Ship the plugin bundle from npm, not git

Status: accepted (2026-11-11); amends [ADR-0004](0004-marketplace-layout.md)

## Context

ADR-0004 committed `plugins/local-decider/dist/hook.mjs`, and the mod `hooks/register.mjs`
followed, so that installs from the git marketplace worked. Generated code in git needed a CI diff
check and noisy diffs. Claude Code and Codex both support an `npm` plugin source; no other built
artifact source is common to both.

## Decision

- The plugin directory is published as `@ziptie-soft/local-decider-agent-plugin` by the existing release
  workflow (npm trusted publishing, provenance).
- Both marketplaces stay in git; each plugin entry's `source` is
  `{ "source": "npm", "package": "@ziptie-soft/local-decider-agent-plugin", "version": "<x.y.z>" }`.
  release-please keeps that version, both `plugin.json` versions and `package.json` in step.
- The hook and mod bundles are git-ignored and built by
  `pnpm --filter @ziptie-soft/local-decider-hooks build`. CI checks the npm package contents and
  runs the extracted Codex hook against controlled fixtures instead of a bundle diff.
- `run-hook.sh` exits 0 silently when `dist/hook.mjs` is missing (unbuilt checkout).

## Consequences

No generated files in git. The installable artifact comes from the npm registry, pinned per
marketplace commit; neither harness runs install scripts. The `npm` CLI must be on `PATH`. The
first release (1.0.0) was published by hand to set up trusted publishing; until a version is on
npm, marketplace installs of it fail. release-please bumps the plugin only for commits touching
`plugins/local-decider/`, so shared hook/core source or dependency lockfile changes need a change
there (release-please has no `additional-paths`). Pull request CI checks this coupling and requires
a releasable PR title for those changes. The repo
marketplace no longer installs the working tree; develop with
`claude --plugin-dir plugins/local-decider` after a build.
