import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { writeGuard } from '../src/write-guard.ts';
import { LINEAR_BOUND_MS, cpuMs } from './cpu-time.ts';

const CWD = '/work/repo';
const rule = (path: string): string | undefined =>
  writeGuard('Write', { file_path: path }, CWD)?.rule;
const patch = (line: string): string | undefined =>
  writeGuard('apply_patch', { command: `*** Begin Patch\n${line}\n*** End Patch` }, CWD)?.rule;

const bash = (command: string): string | null => writeGuard('Bash', { command }, CWD)?.rule ?? null;

describe('writeGuard', () => {
  it('denies .git and .ssh, case-insensitively and anywhere in the path', () => {
    for (const path of ['.git/config', '.GIT/hooks/x', 'a/.git/x', 'sub\\.git\\x']) {
      assert.equal(rule(path), 'write-git', path);
    }
    for (const path of ['../../.ssh/authorized_keys', '/home/u/.ssh/id', '.SSH/config']) {
      assert.equal(rule(path), 'write-ssh', path);
    }
  });

  it('marks workflows as ask', () => {
    for (const path of ['.github/workflows/ci.yml', '.Github/Workflows']) {
      assert.deepEqual(writeGuard('Edit', { file_path: path }, CWD)?.ask, true, path);
      assert.equal(rule(path), 'write-workflow');
    }
    assert.equal(writeGuard('Edit', { file_path: '.git/x' }, CWD)?.ask, undefined);
  });

  it('reads every patch marker and Bash patches', () => {
    assert.equal(patch('*** Move to: .git/x'), 'write-git');
    assert.equal(patch('*** Delete File: .ssh/id'), 'write-ssh');
    assert.equal(patch('*** Add File: .github/workflows/a.yml'), 'write-workflow');
    const viaBash = { command: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: .git/x\nEOF" };
    assert.equal(writeGuard('Bash', viaBash, CWD)?.rule, 'write-git');
    assert.equal(writeGuard('Bash', { command: 'ls .git' }, CWD), null);
  });

  it('passes ordinary paths and unreadable input', () => {
    for (const path of ['.gitignore', '.github/ISSUE_TEMPLATE/a.md', 'src/a.ts', '/tmp/x']) {
      assert.equal(rule(path), undefined, path);
    }
    assert.equal(writeGuard('Write', {}, CWD), null);
    assert.equal(writeGuard('Write', 'x', CWD), null);
    assert.equal(writeGuard('apply_patch', { command: 3 }, CWD), null);
    assert.equal(writeGuard('WebFetch', { url: 'x' }, CWD), null);
  });

  it('checks only the part under cwd when inside it', () => {
    assert.equal(writeGuard('Write', { file_path: 'a.ts' }, '/home/u/.ssh/proj'), null);
    assert.equal(writeGuard('Write', { file_path: 'a.ts' }, ''), null);
  });

  it('still finds a protected target in a patch padded past the target cap', () => {
    const pad = Array.from({ length: 1000 }, (_, i) => `*** Add File: src/f${i}.ts`).join('\n');
    const command = `*** Begin Patch\n${pad}\n*** Add File: .git/hooks/x\n*** End Patch`;
    assert.equal(writeGuard('apply_patch', { command }, CWD)?.rule, 'write-git');
  });

  it('reads Bash redirects and tee operands', () => {
    assert.equal(bash('echo x > .git/config'), 'write-git');
    assert.equal(bash('echo x>>.git/config'), 'write-git');
    assert.equal(bash('echo x >| .git/config'), 'write-git');
    assert.equal(bash('echo x &> .git/config'), 'write-git');
    assert.equal(bash('echo x 2>.git/config'), 'write-git');
    assert.equal(bash('cat a | tee -a .ssh/authorized_keys'), 'write-ssh');
    assert.equal(bash('sudo tee .git/hooks/pre-commit < x'), 'write-git');
    assert.equal(bash('cat <<EOF > .git/x\nbody\nEOF'), 'write-git');
    assert.equal(bash('2>> .github/workflows/x'), 'write-workflow');
    assert.equal(writeGuard('Bash', { command: 'echo > .github/workflows/x' }, CWD)?.ask, true);
  });

  it('lets ordinary redirects through', () => {
    for (const command of [
      'ls > /dev/null',
      'ls > /dev/null 2>&1',
      'echo x > out.txt',
      'cat .git/config > out.txt',
      'echo x | tee out.txt',
      'echo x 2>&1 | cat',
      'cat <<EOF\n> .git/x\nEOF',
      "echo '> .git/x'",
    ]) {
      assert.equal(bash(command), null, command);
    }
  });

  it('scans a 3 MiB redirect-heavy command in linear time', () => {
    for (const command of ['> .git/x '.repeat(349_525), '> x '.repeat(786_432), '>'.repeat(3e6)]) {
      const ms = cpuMs(() => bash(command));
      assert.ok(ms < LINEAR_BOUND_MS, `took ${ms} ms`);
    }
  });
});
