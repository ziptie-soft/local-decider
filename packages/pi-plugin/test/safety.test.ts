import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkSafety, protectedDirs } from '../extension/safety.ts';
import type { SafetyResult } from '../extension/safety.ts';
import { classifyTool } from '../extension/tools.ts';

const home = '/home/u';
const cwd = '/work/proj';
const options = { env: {}, home };

function bash(command: string): SafetyResult {
  return checkSafety(classifyTool('bash', { command }), cwd, 'linux', options);
}

function edit(name: 'edit' | 'write', path: string): SafetyResult {
  return checkSafety(classifyTool(name, { path }), cwd, 'linux', options);
}

test('a harmless command is auto-allowable', () => {
  assert.deepEqual(bash('ls -la'), { hard: null, ask: null, autoAllow: true });
});

test('guard hard hit', () => {
  const r = bash('rm -rf /');
  assert.equal(typeof r.hard, 'string');
  assert.equal(r.autoAllow, false);
});

test('guard ask hit', () => {
  let nested = 'ls';
  for (let i = 0; i < 12; i += 1) {
    nested = `bash -c ${JSON.stringify(nested)}`;
  }
  const r = bash(nested);
  assert.equal(r.hard, null);
  assert.equal(typeof r.ask, 'string');
  assert.equal(r.autoAllow, false);
});

test('deterministic block disables auto-allow without blocking', () => {
  const r = edit('write', '/etc/passwd');
  assert.equal(r.hard, null);
  assert.equal(r.ask, null);
  assert.equal(r.autoAllow, false);
});

test('edit inside the project is auto-allowable', () => {
  assert.equal(edit('edit', 'src/a.ts').autoAllow, true);
  assert.equal(edit('write', '/work/proj/b.ts').autoAllow, true);
});

test('gateway config paths ask', () => {
  const r = edit('write', '/home/u/.config/local-decider/config.yaml');
  assert.equal(r.autoAllow, false);
  assert.equal(typeof r.ask, 'string');
  const cmd = bash('echo x > ~/.config/local-decider/policies/p.yaml');
  assert.equal(cmd.autoAllow, false);
  assert.equal(typeof cmd.ask, 'string');
});

test('pi settings and extensions ask', () => {
  for (const path of ['/home/u/.pi/agent/settings.json', '/home/u/.pi/agent/extensions/x.ts']) {
    const r = edit('edit', path);
    assert.equal(r.autoAllow, false);
    assert.equal(typeof r.ask, 'string');
  }
  assert.equal(typeof bash('sed -i s/a/b/ $HOME/.pi/agent/settings.json').ask, 'string');
  assert.equal(typeof bash('cat ~/.pi/agent/settings.json').ask, 'string');
});

test('the working directory inside a protected dir asks', () => {
  const r = checkSafety(
    classifyTool('bash', { command: 'ls' }),
    '/home/u/.pi/agent',
    'linux',
    options,
  );
  assert.equal(r.autoAllow, false);
  assert.equal(typeof r.ask, 'string');
});

test('project-local .pi config asks', () => {
  for (const path of ['.pi/extensions/x.ts', '/work/proj/.pi/extensions/x.ts']) {
    const r = edit('write', path);
    assert.equal(r.autoAllow, false);
    assert.equal(typeof r.ask, 'string');
  }
  const cmd = bash('echo {} > .pi/settings.json');
  assert.equal(cmd.autoAllow, false);
  assert.equal(typeof cmd.ask, 'string');
  assert.equal(edit('write', '.pip/x').ask, null);
});

test('a sibling directory with a shared prefix is not protected', () => {
  assert.equal(edit('write', '/home/u/.pi/agent2/x').ask, null);
});

test('env overrides move the protected directories', () => {
  const env = { LOCAL_DECIDER_CONFIG_DIR: '/cfg', PI_CODING_AGENT_DIR: '~/pi-agent' };
  assert.deepEqual(protectedDirs(env, home), ['/cfg', '/home/u/pi-agent']);
  const r = checkSafety(classifyTool('write', { path: '/cfg/config.yaml' }), cwd, 'linux', {
    env,
    home,
  });
  assert.equal(typeof r.ask, 'string');
});

test('Windows is never auto-allowable', () => {
  const r = checkSafety(classifyTool('bash', { command: 'ls' }), cwd, 'win32', options);
  assert.deepEqual(r, { hard: null, ask: null, autoAllow: false });
});

test('powershell, mcp and unknown tools are not auto-allowable', () => {
  for (const [name, input] of [
    ['powershell', { command: 'dir' }],
    ['mcp__s__t', {}],
    ['Bash', { command: 'ls' }],
  ] as const) {
    assert.equal(checkSafety(classifyTool(name, input), cwd, 'linux', options).autoAllow, false);
  }
});

test('indirect writes into a config dir are never auto-allowable', () => {
  for (const command of [
    'd="$HOME/.pi/agent"; cd "$d"; echo x > settings.json',
    'D=.pi; echo x > $D/settings.json',
    'cd ~/.pi/agent && echo x > settings.json',
    'cd src; echo x > ../.pi/settings.json',
    'cd src && cd .. && cd .pi && echo x > settings.json',
    'echo x > .p""i/settings.json',
  ]) {
    assert.equal(bash(command).autoAllow, false, command);
  }
});

test('a missing command or path does not crash and is not auto-allowable', () => {
  assert.equal(checkSafety(classifyTool('bash', {}), cwd, 'linux', options).autoAllow, false);
  assert.equal(
    checkSafety(classifyTool('edit', { path: 1 }), cwd, 'linux', options).autoAllow,
    false,
  );
});
