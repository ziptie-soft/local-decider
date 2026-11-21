/**
 * Hook entry point: `node dist/local-decider-hook.mjs <claude|codex> <Event>`. Reads the hook JSON from stdin,
 * runs it, writes the harness answer to stdout and exits 0. Everything else lives in `run.ts`.
 */
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

async function main(): Promise<void> {
  const env = process.env;
  // Last-resort fail-open: never outlive the gateway budget by much, whatever hangs.
  setTimeout(() => process.exit(0), timeoutOf(env) + 1000).unref();
  const [harness = '', event = ''] = process.argv.slice(2);
  const input = await readStdin();
  const deps = input.oversize === undefined ? {} : { oversize: input.oversize };
  const result = await run(harness, event, input.text, env, deps);
  finish(result.stdout);
}

main().catch(() => process.exit(0));
