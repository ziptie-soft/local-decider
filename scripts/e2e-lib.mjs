// Helpers shared by the plugin e2e scripts (harness-e2e.mjs, harness-install-e2e.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A scratch git workspace with a README. */
export function makeWorkspace(name) {
  const dir = mkdtempSync(join(tmpdir(), `ld-e2e-${name}-`));
  writeFileSync(join(dir, 'README.md'), '# local-decider e2e scratch workspace\n');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** Parse JSON Lines, ignoring blank lines and non-JSON noise (warnings). */
export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      // Non-JSON noise is ignored.
    }
  }
  return out;
}

/** Print PASS, FAIL and SKIP lines for `{ label, ok, skipped?, detail }` results. */
export function printResults(results) {
  console.log('');
  for (const r of results) {
    const status = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    console.log(`  ${status}  ${String(r.label)}: ${r.detail}`);
  }
}

/**
 * Run a command with captured output until it exits. It is stopped after `timeoutMs`, or `graceMs`
 * after `until()` first holds. Resolves with `{ code, signal, stdout, stderr }`.
 */
export function runCaptured({ bin, args, env, cwd, timeoutMs, until, graceMs = 2000 }) {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, timeoutMs);
    const poll = setInterval(() => {
      if (until?.()) {
        clearInterval(poll);
        setTimeout(stop, graceMs);
      }
    }, 100);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearInterval(poll);
      done({ code, signal, stdout, stderr });
    });
  });
}

/** The harness names `argv[2]` selects (default all); exits 2 with a usage line otherwise. */
export function selectedHarnesses(script, harnesses) {
  const target = process.argv[2] ?? 'all';
  const names = target === 'all' ? Object.keys(harnesses) : [target];
  if (!names.every((n) => n in harnesses)) {
    console.error(
      `${script}: usage: ${script}.mjs ${Object.keys(harnesses).join('|')}|all (got ${target})`,
    );
    process.exit(2);
  }
  return names;
}
