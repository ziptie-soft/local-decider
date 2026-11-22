import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { engineProjectDir } from '../src/engine-install.ts';
import { pinnedStrandsVersion, strandsPinMismatch } from '../src/engines/strands/venv.ts';
import { tempPaths } from './helpers.ts';

function project(pin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ld-pin-'));
  writeFileSync(
    join(dir, 'pyproject.toml'),
    `[project]\ndependencies = [\n  "strands-decider==${pin}",\n]\n`,
  );
  return dir;
}

function venvWith(installed: string | null): ReturnType<typeof tempPaths> {
  const paths = tempPaths();
  const site = join(paths.venvs, 'strands-decider', 'lib', 'python3.12', 'site-packages');
  mkdirSync(site, { recursive: true });
  if (installed !== null) mkdirSync(join(site, `strands_decider-${installed}.dist-info`));
  return paths;
}

describe('Strands venv pin check', () => {
  it('reports a venv older than the pin, with the remedy', () => {
    assert.equal(
      strandsPinMismatch(venvWith('0.3.1.dev2+g846b69e'), project('0.4.0')),
      'strands-decider venv has 0.3.1.dev2+g846b69e, pinned 0.4.0; run local-decider engine install',
    );
  });

  it('reports nothing for a matching venv', () => {
    assert.equal(strandsPinMismatch(venvWith('0.4.0'), project('0.4.0')), null);
  });

  it('reports nothing for a missing venv or a venv without strands-decider', () => {
    assert.equal(strandsPinMismatch(tempPaths(), project('0.4.0')), null);
    assert.equal(strandsPinMismatch(venvWith(null), project('0.4.0')), null);
  });

  it('reports nothing when the pin is unreadable', () => {
    assert.equal(strandsPinMismatch(venvWith('0.3.1'), tmpdir()), null);
  });

  it('reads the bundled pin', () => {
    const pin = pinnedStrandsVersion();
    assert.ok(pin !== null);
    assert.match(readFileSync(join(engineProjectDir(), 'pyproject.toml'), 'utf8'), new RegExp(pin));
  });
});
