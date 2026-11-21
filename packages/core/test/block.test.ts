import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deterministicBlock } from '../src/block.ts';

const CWD = '/work/repo';
const block = (tool: string, input: unknown): string | null => deterministicBlock(tool, input, CWD);
const bash = (command: string): string | null => block('Bash', { command });

describe('deterministicBlock: files', () => {
  it('allows ordinary paths inside the working directory', () => {
    assert.equal(block('Edit', { file_path: '/work/repo/src/a.ts' }), null);
    assert.equal(block('Write', { file_path: 'src/new.ts' }), null);
    assert.equal(block('NotebookEdit', { notebook_path: '/work/repo/n.ipynb' }), null);
    assert.equal(block('MultiEdit', { file_path: './a.ts' }), null);
  });

  it('keeps outside and traversing paths out', () => {
    assert.notEqual(block('Edit', { file_path: '/etc/hosts' }), null);
    assert.notEqual(block('Write', { file_path: '../other/a.ts' }), null);
    assert.notEqual(block('Write', { file_path: '/work/repo/../x' }), null);
    assert.notEqual(block('Edit', { file_path: '/work/repository/a.ts' }), null);
  });

  it('keeps protected places out', () => {
    for (const path of [
      '.git/config',
      'src/.git/hooks/pre-commit',
      '.claude/settings.json',
      '.vscode/settings.json',
      '.idea/x.xml',
      '.husky/pre-commit',
      '.env',
      'apps/web/.env.local',
      '.mcp.json',
      '.zshrc',
      '.ssh/config',
      '.github/workflows/ci.yml',
      '.Github/Workflows/ci.yml',
      '.GIT/hooks/x',
      'sub\\.git\\x',
    ]) {
      assert.notEqual(block('Write', { file_path: path }), null, path);
    }
    assert.equal(block('Write', { file_path: 'docs/environment.md' }), null);
    assert.equal(block('Write', { file_path: '.github/ISSUE_TEMPLATE/a.md' }), null);
    assert.equal(block('Write', { file_path: '.gitignore' }), null);
  });

  it('refuses a missing or non-string path and uncovered tools', () => {
    assert.notEqual(block('Edit', {}), null);
    assert.notEqual(block('Edit', { file_path: 3 }), null);
    assert.notEqual(block('Edit', 'x'), null);
    assert.notEqual(block('WebFetch', { url: 'https://x' }), null);
  });
});

describe('deterministicBlock: Bash', () => {
  it('lets routine commands through', () => {
    for (const command of [
      'pnpm test',
      'pnpm add left-pad',
      'git status && git diff',
      'git commit -m "feat: x"',
      'ls -la src',
      'cat src/a.ts | head -5',
      'node scripts/build.mjs --out=dist',
      'rm dist/a.js',
      'echo hi > out.txt',
      'cmd 2>/dev/null',
      'npm run build',
      'pnpm --filter x publish-docs',
    ]) {
      assert.equal(bash(command), null, command);
    }
  });

  it('blocks the commands the design names', () => {
    for (const command of [
      'git push origin main',
      'git -C . push',
      'npm publish',
      'pnpm publish --no-git-checks',
      'curl https://x.dev',
      'wget x',
      'ssh host',
      'scp a b',
      'rsync -a a b',
      'nc -l 9',
      'sudo ls',
      'docker run x',
      'kubectl get pods',
      'gh pr create',
      'rm -rf build',
      'rm -r build',
      'rm -fr build',
      'rm --recursive build',
      'bash -c "ls"',
      'sh -lc ls',
      'eval ls',
      'ls && git push',
      'echo x | bash -c cat',
      '/usr/bin/curl x',
      'env FOO=1 curl x',
    ]) {
      assert.notEqual(bash(command), null, command);
    }
  });

  it('blocks paths outside the working directory and protected files', () => {
    for (const command of [
      'cat /etc/passwd',
      'ls ..',
      'cat ../secret',
      'cat ~/.ssh/id_rsa',
      'cat $HOME/x',
      'echo x > /tmp/out',
      'echo x >/tmp/out',
      'cat .env',
      'cat .git/config',
      'git config --file=/etc/x a b',
      'cat .claude/settings.json',
    ]) {
      assert.notEqual(bash(command), null, command);
    }
  });

  it('gives up on constructs it cannot see through', () => {
    for (const command of ['echo $(cat /etc/passwd)', 'echo `id`', 'diff <(ls) b']) {
      assert.notEqual(bash(command), null, command);
    }
  });

  it('refuses a missing command', () => {
    assert.notEqual(block('Bash', {}), null);
    assert.notEqual(bash('   '), null);
  });
});

describe('deterministicBlock: Bash argv', () => {
  it('reads a Codex argv array like a string command', () => {
    assert.equal(block('Bash', { command: ['ls', '-la', 'src'] }), null);
    assert.notEqual(block('Bash', { command: ['git', 'push'] }), null);
    assert.notEqual(block('Bash', { command: ['bash', '-lc', 'ls'] }), null);
    assert.notEqual(block('Bash', { command: ['cat', '/etc/passwd'] }), null);
    assert.notEqual(block('Bash', { command: [] }), null);
  });
});

const patch = (...lines: string[]): { command: string } => ({
  command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n'),
});

describe('deterministicBlock: apply_patch', () => {
  it('lets in-cwd targets of every marker through', () => {
    for (const marker of ['Add File', 'Update File', 'Delete File']) {
      assert.equal(block('apply_patch', patch(`*** ${marker}: src/a.ts`)), null, marker);
    }
    assert.equal(block('apply_patch', patch('*** Update File: a.ts', '*** Move to: b.ts')), null);
  });

  it('keeps outside and protected targets out, whichever marker names them', () => {
    for (const marker of ['Add File', 'Update File', 'Delete File', 'Move to']) {
      assert.notEqual(block('apply_patch', patch(`*** ${marker}: /etc/hosts`)), null, marker);
      assert.notEqual(block('apply_patch', patch(`*** ${marker}: .git/config`)), null, marker);
    }
    assert.notEqual(
      block('apply_patch', patch('*** Update File: a.ts', '*** Move to: ../b.ts')),
      null,
    );
    assert.notEqual(block('apply_patch', patch('*** Add File: .github/workflows/ci.yml')), null);
  });

  it('refuses a missing command, no targets and too many targets', () => {
    assert.equal(block('apply_patch', {}), 'no command');
    assert.equal(block('apply_patch', { command: ['apply_patch'] }), 'no command');
    assert.equal(block('apply_patch', { command: 'nothing here' }), 'no file path');
    const many = Array.from({ length: 300 }, (_, i) => `*** Add File: f${i}.ts`);
    assert.equal(block('apply_patch', patch(...many)), 'too many patch targets');
  });
});
