/**
 * Hook entry point: `node dist/local-decider-hook.mjs <claude|codex> <Event>`. Reads the hook JSON from stdin,
 * runs it, writes the harness answer to stdout and exits 0. Everything else lives in `run.ts`.
 */
import { launchGateway } from '@ziptie-soft/local-decider-launcher';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { hooksClientId } from './gateway-client.ts';
import { gatewayConfig } from './gateway-config.ts';
import { run, timeoutOf } from './run.ts';

/** Up to this size a hook payload is handled normally. */
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
/** Up to this size it is parsed for the deterministic guard only; beyond it, it is not read. */
const MAX_GUARD_BYTES = 32 * 1024 * 1024;
/** Of a payload that is not read, the head kept to look for `permission_mode`. */
const HEAD_BYTES = 64 * 1024;

interface Input {
  readonly text: string;
  readonly oversize?: 'large' | 'huge';
}

/** Read stdin, never buffering more than `MAX_GUARD_BYTES` plus one chunk. */
async function readStdin(): Promise<Input> {
  const chunks: Buffer[] = [];
  const head: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    if (size < HEAD_BYTES) {
      head.push(buf);
    }
    size += buf.length;
    if (size > MAX_GUARD_BYTES) {
      process.stderr.write('local-decider: hook input over 32 MiB, not read; PreToolUse asks\n');
      const text = Buffer.concat(head).subarray(0, HEAD_BYTES).toString('utf8');
      process.stdin.destroy();
      return { text, oversize: 'huge' };
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (size > MAX_STDIN_BYTES) {
    process.stderr.write('local-decider: hook input over 4 MiB, running the guard only\n');
    return { text, oversize: 'large' };
  }
  return { text };
}

function finish(stdout: string): void {
  if (stdout === '') {
    process.exit(0);
  }
  process.stdout.write(stdout, () => process.exit(0));
}

function startGatewayDetached(harness: string): void {
  if (pinnedGatewayVersion() === null) return;
  const bundle = process.argv[1];
  if (bundle === undefined) return;
  try {
    const child = spawn(process.execPath, [bundle, '--launch-gateway', harness], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // SessionStart is fail-open if the detached kick cannot be created.
  }
}

function pinnedGatewayVersion(): string | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null;
    const localDecider = (manifest as Record<string, unknown>)['localDecider'];
    if (typeof localDecider !== 'object' || localDecider === null || Array.isArray(localDecider))
      return null;
    const version = (localDecider as Record<string, unknown>)['gateway'];
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

async function launchMode(): Promise<void> {
  const harness = process.argv[3] === 'codex' ? 'codex' : 'claude';
  const pinnedVersion = pinnedGatewayVersion();
  if (pinnedVersion === null) return;
  const env = process.env;
  const gateway = gatewayConfig(env);
  await launchGateway({
    url: gateway.url,
    defaultEndpoint: gateway.defaultEndpoint,
    env,
    pinnedVersion,
    clientId: hooksClientId(harness),
    guideUrl: 'https://github.com/ziptie-soft/local-decider/blob/master/docs/install.md',
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === '--launch-gateway') {
    try {
      await launchMode();
    } catch {
      // Fail open and keep the detached hook silent.
    }
    process.exit(0);
  }
  const env = process.env;
  // Last-resort fail-open: never outlive the gateway budget by much, whatever hangs.
  setTimeout(() => process.exit(0), timeoutOf(env) + 1000).unref();
  const [harness = '', event = ''] = process.argv.slice(2);
  const input = await readStdin();
  const deps = input.oversize === undefined ? {} : { oversize: input.oversize };
  const result = await run(harness, event, input.text, env, {
    ...deps,
    startGateway: () => startGatewayDetached(harness),
  });
  finish(result.stdout);
}

main().catch(() => process.exit(0));
