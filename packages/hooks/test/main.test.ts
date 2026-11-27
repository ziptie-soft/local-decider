import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runMain(
  harness: string,
  event: string,
  input: string,
  extraEnv: Record<string, string> = {},
): Result {
  const res = spawnSync(process.execPath, ['--conditions=source', main, harness, event], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOCAL_DECIDER_URL: 'http://127.0.0.1:1',
      LOCAL_DECIDER_TIMEOUT_MS: '300',
      ...extraEnv,
    },
    timeout: 20_000,
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

function hook(event: string, payload: unknown): { stdout: string; status: number | null } {
  const { stdout, status } = runMain('claude', event, JSON.stringify(payload));
  return { stdout, status };
}

const MIB = 1024 * 1024;

/** A hook payload padded with `mib` MiB in an unused field, `permission_mode` ahead of the tool. */
function padded(tool: string, toolInput: unknown, mib: number, mode = 'default'): string {
  const head = JSON.stringify({ session_id: 's', cwd: '/tmp', permission_mode: mode });
  const tail = JSON.stringify({ tool_name: tool, tool_input: toolInput });
  return `${head.slice(0, -1)},${tail.slice(1, -1)},"pad":"${'x'.repeat(mib * MIB)}"}`;
}

describe('main (process wrapper)', () => {
  const base = { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash' };

  it('prints a guard deny and exits 0', () => {
    const res = hook('PreToolUse', { ...base, tool_input: { command: 'rm -rf /' } });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /"permissionDecision":"deny"/);
  });

  it('prints nothing and exits 0 when the gateway is down', () => {
    const res = hook('PreToolUse', { ...base, tool_input: { command: 'ls' } });
    assert.deepEqual(res, { stdout: '', status: 0 });
  });

  const gitWrite = { file_path: '.git/x', content: 'y' };

  it('runs the guard on a 5 MiB payload and denies a .git write', () => {
    const res = runMain('claude', 'PreToolUse', padded('Write', gitWrite, 5));
    assert.equal(res.status, 0);
    assert.match(res.stdout, /write-git/);
    assert.match(res.stderr, /over 4 MiB/);
  });

  it('lets a clean 5 MiB payload through without a gateway call', () => {
    const res = runMain('claude', 'PreToolUse', padded('Write', { file_path: 'a.ts' }, 5));
    assert.equal(res.stdout, '');
    assert.equal(res.status, 0);
  });

  it('asks on Claude and denies on Codex for a 33 MiB PreToolUse', () => {
    const input = padded('Write', { file_path: 'a.ts' }, 33);
    const claude = runMain('claude', 'PreToolUse', input);
    assert.match(claude.stdout, /"permissionDecision":"ask"/);
    assert.match(claude.stdout, /oversize-input/);
    assert.match(claude.stderr, /over 32 MiB/);
    const codex = runMain('codex', 'PreToolUse', input);
    assert.match(codex.stdout, /"permissionDecision":"deny"/);
  });

  it('keeps oversized non-PreToolUse events silent', () => {
    const auto = runMain('claude', 'PreToolUse', padded('Write', {}, 33, 'auto'));
    assert.equal(auto.stdout, '');
    const start = runMain('claude', 'SessionStart', padded('Write', {}, 33));
    assert.equal(start.stdout, '');
    assert.equal(start.status, 0);
  });

  it('keeps full fail-open with LOCAL_DECIDER_GUARD=off', () => {
    const off = { LOCAL_DECIDER_GUARD: 'off' };
    assert.equal(runMain('claude', 'PreToolUse', padded('Write', gitWrite, 5), off).stdout, '');
    assert.equal(runMain('claude', 'PreToolUse', padded('Write', gitWrite, 33), off).stdout, '');
  });

  it('asks about a shell command over 1 MiB', () => {
    const command = `echo ${'a'.repeat(MIB + 10)}`;
    const res = runMain('claude', 'PreToolUse', padded('Bash', { command }, 0));
    assert.match(res.stdout, /oversize-command/);
    assert.match(res.stdout, /"permissionDecision":"ask"/);
  });
});
