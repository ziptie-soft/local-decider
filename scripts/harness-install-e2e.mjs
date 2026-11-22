#!/usr/bin/env node
// Secret-free install e2e: install the packed plugin into Claude Code and Codex the way a user
// does (local marketplace), run each harness once against a stub gateway, and assert that the
// hooks reached it. Both harnesses fire their first hooks (SessionStart, UserPromptSubmit) before
// the first model call, so a model that answers 400 is enough and no login or key is needed.
//
//   node scripts/harness-install-e2e.mjs claude|codex|all
//
// Checks per harness:
//   install    the packed plugin installs from a local marketplace
//   trust      (Codex) without hook trust no hook runs; with --dangerously-bypass-hook-trust the
//              routing hook reaches the gateway. A Codex change to this behaviour shows up here.
//   routing    (Claude) the routing hook reaches the gateway and SessionStart prints no
//              "hooks inactive" notice
//   bare PATH  with no node on PATH, the launcher finds node through the mise shim, and runs it from
//              the plugin root instead of the agent's workspace
//
// Everything lives under a temp HOME (HOME, XDG_*, CODEX_HOME and CLAUDE_CONFIG_DIR), the harness
// gets a clean environment instead of yours, and the gateway is the stub: your gateway, configs and
// logins are never touched. Needs `pnpm --filter @ziptie-soft/local-decider-hooks build` first
// (`mise run e2e:install` does it).
//
// Env: LD_E2E_KEEP=1 (keep the temp directory), LD_E2E_TIMEOUT_S (per harness run, default 60).
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  makeMarketplace,
  makeWorkspace,
  PLUGIN_REF,
  printResults,
  run,
  runCaptured,
  selectedHarnesses,
} from './e2e-lib.mjs';
import { startStubGateway } from './e2e-stub-gateway.mjs';

const TIMEOUT_MS = Number(process.env.LD_E2E_TIMEOUT_S ?? 60) * 1000;

function fail(message) {
  console.error(`harness-install-e2e: ${message}`);
  process.exit(2);
}

function binDir(bin) {
  const found = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  if (found.status !== 0) {
    fail(`${bin} is not on PATH`);
  }
  return dirname(found.stdout.trim());
}

/** A clean environment: your shell's variables (LOCAL_DECIDER_*, CLAUDE_*, keys) do not leak in. */
function cleanEnv(home, extra) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'dumb',
    LANG: 'C.UTF-8',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ...extra,
  };
}

const HARNESSES = {
  claude: {
    bin: 'claude',
    harness: 'claude-code',
    install(market, env) {
      run('claude', ['plugin', 'marketplace', 'add', market], { env });
      run('claude', ['plugin', 'install', PLUGIN_REF], { env });
    },
    extraEnv: (stub) => ({
      ANTHROPIC_API_KEY: 'dummy',
      ANTHROPIC_BASE_URL: stub.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }),
    args: () => [
      '-p',
      'say hi',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
    ],
  },
  codex: {
    bin: 'codex',
    harness: 'codex',
    install(market, env) {
      mkdirSync(env.CODEX_HOME, { recursive: true });
      run('codex', ['plugin', 'marketplace', 'add', market], { env });
      run('codex', ['plugin', 'add', PLUGIN_REF], { env });
    },
    extraEnv: () => ({ LD_E2E_STUB_KEY: 'dummy' }),
    args(stub, { bypassTrust }) {
      const provider = `{name="stub",base_url="${stub.url}/v1",wire_api="responses",env_key="LD_E2E_STUB_KEY",request_max_retries=0,stream_max_retries=0}`;
      return [
        'exec',
        '--skip-git-repo-check',
        ...(bypassTrust ? ['--dangerously-bypass-hook-trust'] : []),
        '-c',
        `model_providers.stub=${provider}`,
        '-c',
        'model_provider=stub',
        'say hi',
      ];
    },
  },
};

const gatewayCalls = (stub, harness) =>
  stub.calls.filter((c) => c.method === 'POST' && c.body?.harness === harness);
const routingCalls = (stub, harness) =>
  gatewayCalls(stub, harness).filter((c) => c.policy?.startsWith('routing'));

function result(label, ok, detail) {
  return { label, ok, detail };
}

/** One harness run in its own temp HOME against a fresh stub; resolves with the stub and the run. */
async function exercise(spec, ctx, options) {
  const stub = await startStubGateway();
  const home = mkdtempSync(join(ctx.dir, 'home-'));
  const env = cleanEnv(home, { LOCAL_DECIDER_URL: stub.url, ...spec.extraEnv(stub) });
  const cwd = makeWorkspace(spec.harness);
  ctx.cleanup.push(cwd);
  if (options.bareNode) {
    Object.assign(env, bareEnv(spec, home, cwd));
  }
  try {
    spec.install(ctx.market, env);
    const wait = options.expect ?? (() => false);
    const res = await runCaptured({
      bin: spec.bin,
      args: spec.args(stub, options),
      env,
      cwd,
      timeoutMs: TIMEOUT_MS,
      until: () => wait(stub),
    });
    return { stub, res, home, cwd };
  } finally {
    await stub.close();
  }
}

/** PATH without node, plus a mise-shim node that records where it was started. */
function bareEnv(spec, home, cwd) {
  const shims = join(home, '.local/share/mise/shims');
  mkdirSync(shims, { recursive: true });
  const record = join(home, 'shim-cwd');
  // The shim stands in for mise's: it runs the real node, and notes the directory it was started in
  // (the shim resolves node for the project that directory belongs to).
  const body = `#!/bin/sh\npwd -P > "${record}"\nexec "${process.execPath}" "$@"\n`;
  writeFileSync(join(shims, 'node'), body);
  chmodSync(join(shims, 'node'), 0o755);
  // A project that pins an old node must not matter: the shim never runs from the workspace.
  writeFileSync(join(cwd, 'mise.toml'), '[tools]\nnode = "18"\n');
  return { PATH: `${binDir(spec.bin)}:/usr/bin:/bin` };
}

/** A node on the bare PATH (/usr/bin:/bin) would be found before the shim fallback. */
function systemNode() {
  return ['/usr/bin/node', '/bin/node'].find((p) => existsSync(p));
}

async function checkCodex(ctx) {
  const spec = HARNESSES.codex;
  const results = [];
  const untrusted = await exercise(spec, ctx, { bypassTrust: false });
  const n = gatewayCalls(untrusted.stub, 'codex').length;
  results.push(
    result('codex: untrusted hooks do not run', n === 0, `${String(n)} gateway call(s), need 0`),
  );

  const expect = (stub) => routingCalls(stub, 'codex').length > 0;
  const trusted = await exercise(spec, ctx, { bypassTrust: true, expect });
  const m = routingCalls(trusted.stub, 'codex').length;
  results.push(
    result('codex: routing reaches the gateway', m === 1, `${String(m)} routing call(s), need 1`),
  );
  return results;
}

async function checkClaude(ctx) {
  const spec = HARNESSES.claude;
  const expect = (stub) => routingCalls(stub, 'claude-code').length > 0;
  const live = await exercise(spec, ctx, { expect });
  const m = routingCalls(live.stub, 'claude-code').length;
  const inactive = live.res.stdout.includes('hooks inactive');
  return [
    result('claude: routing reaches the gateway', m === 1, `${String(m)} routing call(s), need 1`),
    result(
      'claude: SessionStart reports no inactive hooks',
      !inactive,
      inactive ? 'notice printed' : 'no notice',
    ),
  ];
}

/** The shim fallback: the call arrives, and node was started from the plugin root. */
async function checkBarePath(name, ctx) {
  const spec = HARNESSES[name];
  const found = systemNode();
  if (found !== undefined) {
    return [{ label: `${name}: bare PATH`, ok: true, skipped: true, detail: `${found} exists` }];
  }
  const expect = (stub) => routingCalls(stub, spec.harness).length > 0;
  const bare = await exercise(spec, ctx, { bypassTrust: true, bareNode: true, expect });
  const m = routingCalls(bare.stub, spec.harness).length;
  const record = join(bare.home, 'shim-cwd');
  const started = existsSync(record) ? readFileSync(record, 'utf8').trim() : '';
  const fromRoot =
    started !== '' &&
    started !== realpathSync(bare.cwd) &&
    existsSync(join(started, 'dist/local-decider-hook.mjs'));
  return [
    result(
      `${name}: bare PATH reaches the gateway`,
      m >= 1,
      `${String(m)} routing call(s), need >= 1`,
    ),
    result(
      `${name}: mise shim runs from the plugin root`,
      fromRoot,
      started === '' ? 'the shim never ran' : `shim started in ${started}`,
    ),
  ];
}

async function runTarget(name, ctx) {
  console.log(`\n== ${name}`);
  const main = name === 'codex' ? await checkCodex(ctx) : await checkClaude(ctx);
  const bare = await checkBarePath(name, ctx);
  const results = [...main, ...bare];
  printResults(results);
  return results.every((r) => r.ok);
}

const names = selectedHarnesses('harness-install-e2e', HARNESSES);
for (const name of names) {
  binDir(HARNESSES[name].bin);
  console.log(`${name}: ${run(HARNESSES[name].bin, ['--version'], {}).trim()}`);
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ld-e2e-install-')));
const ctx = { dir, market: makeMarketplace(dir), cleanup: [] };
let ok = true;
try {
  for (const name of names) {
    ok = (await runTarget(name, ctx)) && ok;
  }
} finally {
  if (process.env.LD_E2E_KEEP === '1') {
    console.log(`kept ${dir}`);
  } else {
    for (const path of [dir, ...ctx.cleanup]) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}
console.log(
  ok ? '\nharness-install-e2e: all checks passed' : '\nharness-install-e2e: some checks failed',
);
process.exit(ok ? 0 : 1);
