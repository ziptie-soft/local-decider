// Helpers shared by the plugin e2e scripts (harness-e2e.mjs, harness-install-e2e.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = join(ROOT, 'plugins/local-decider');
const MARKETPLACE = 'ld-e2e';
export const PLUGIN_REF = `local-decider@${MARKETPLACE}`;

/** Print an error and exit 2. */
function die(message) {
  console.error(`e2e: ${message}`);
  process.exit(2);
}

/** Run a command to completion; exits with its output when it fails. Returns stdout. */
export function run(bin, args, options) {
  const res = spawnSync(bin, args, { encoding: 'utf8', ...options });
  if (res.status !== 0) {
    die(`${bin} ${args.join(' ')} failed (${res.status}): ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout;
}

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
 * after `until()` first holds. With `input` it is written to stdin, which then stays open until
 * `inputDone(stdout)` holds (plus `graceMs`) so async hooks can finish: a headless Claude Code
 * cancels them when it exits. Resolves with `{ code, signal, stdout, stderr }`.
 */
export function runCaptured({
  bin,
  args,
  env,
  cwd,
  timeoutMs,
  until,
  input,
  inputDone,
  graceMs = 2000,
}) {
  return new Promise((done) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.write(input);
    }
    let inputClosed = input === undefined;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, timeoutMs);
    const poll = setInterval(() => {
      if (!inputClosed && inputDone?.(stdout)) {
        inputClosed = true;
        setTimeout(() => child.stdin.end(), graceMs);
      }
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

/** The npm package of the plugin, extracted into a marketplace with both marketplace files. */
export function makeMarketplace(dir) {
  if (!existsSync(join(PLUGIN_DIR, 'dist/local-decider-hook.mjs'))) {
    die(
      'plugins/local-decider has no dist; run `pnpm --filter @ziptie-soft/local-decider-hooks build`',
    );
  }
  const packDir = join(dir, 'pack');
  mkdirSync(packDir, { recursive: true });
  const archive = run('npm', ['pack', '--silent', '--pack-destination', packDir], {
    cwd: PLUGIN_DIR,
    env: { ...process.env, npm_config_cache: join(dir, 'npm-cache') },
  }).trim();
  const market = join(dir, 'marketplace');
  const pluginRoot = join(market, 'plugins/local-decider');
  mkdirSync(pluginRoot, { recursive: true });
  run('tar', ['-xzf', join(packDir, archive), '-C', pluginRoot, '--strip-components=1']);
  const claude = { name: MARKETPLACE, owner: { name: 'e2e' } };
  claude.plugins = [{ name: 'local-decider', source: './plugins/local-decider' }];
  const codex = { name: MARKETPLACE };
  codex.plugins = [
    {
      name: 'local-decider',
      source: { source: 'local', path: './plugins/local-decider' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  ];
  for (const [file, body] of [
    ['.claude-plugin/marketplace.json', claude],
    ['.agents/plugins/marketplace.json', codex],
  ]) {
    mkdirSync(dirname(join(market, file)), { recursive: true });
    writeFileSync(join(market, file), JSON.stringify(body, null, 2));
  }
  return market;
}
