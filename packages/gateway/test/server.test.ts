import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MemoryConfigStore } from '../src/config-file.ts';
import { parseConfig } from '../src/config.ts';
import { ENGINE_BENCHMARK_RUNNING_ERROR } from '../src/engine-busy.ts';
import { EngineControl } from '../src/engine-control.ts';
import { startGateway, type Gateway } from '../src/runtime.ts';
import { createGatewayServer, serverTimeouts, type ServerOptions } from '../src/server.ts';
import {
  controlHeaders,
  FakeEngine,
  NO_CAPABILITIES,
  readLog,
  tempPaths,
  testConfig,
} from './helpers.ts';

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function directorySnapshot(directory: string): readonly (readonly [string, string])[] | undefined {
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory)
    .toSorted()
    .map((name) => [name, readFileSync(join(directory, name), 'base64')] as const);
}

describe('error hygiene and /health counters', () => {
  const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

  it('returns a fixed 502 body and logs the redacted detail server-side', async () => {
    const engine = new FakeEngine();
    engine.respond = () => {
      throw new Error(`engine crashed on state ${SECRET}\nsecond line`);
    };
    const lines: string[] = [];
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine,
      env: {},
      log: (line) => lines.push(line),
    });
    try {
      const res = await fetch(`${gw.url}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: 's',
          questions: { q: { type: 'choice', instructions: 'i', criteria: { done: 'd' } } },
        }),
      });
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'engine error' });
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? '', /^engine error: engine crashed on state /);
      assert.ok(!(lines[0] ?? '').includes(SECRET), 'secrets are redacted in the log');
      assert.ok(!(lines[0] ?? '').includes('second line'), 'only the first line is logged');
      const health = await json(await fetch(`${gw.url}/health`));
      const counters = health['counters'] as Record<string, number>;
      assert.equal(counters['passThroughErrors'], 1);
      assert.equal(typeof health['errorP50Ms'], 'number');
      assert.equal(typeof health['errorP95Ms'], 'number');
    } finally {
      await gw.close();
    }
  });

  it('keeps the specific statuses and messages', async () => {
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: {},
    });
    try {
      const unknown = await fetch(`${gw.url}/v1/decide/nope`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'mcp', input: {} }),
      });
      assert.equal(unknown.status, 404);
      assert.match(String((await json(unknown))['error']), /unknown policy/);
      const bad = await fetch(`${gw.url}/v1/decide/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      assert.equal(bad.status, 400);
    } finally {
      await gw.close();
    }
  });

  it('reports every counter as zero on a fresh gateway', async () => {
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: {},
    });
    try {
      const health = await json(await fetch(`${gw.url}/health`));
      assert.deepEqual(health['counters'], {
        queueFull: 0,
        busy: 0,
        timeouts: 0,
        errors: 0,
        passThroughErrors: 0,
        logWriteFailures: 0,
        logDropped: 0,
        engineRestarts: 0,
        engineHangs: 0,
      });
      assert.equal(health['errorP50Ms'], undefined, 'no failures yet: no percentile');
    } finally {
      await gw.close();
    }
  });
});

describe('routing presets per harness', () => {
  it('attaches the harness target of a routing action and fills models for savings', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig({
        policies: { routing: { mode: 'act' } },
        routing: {
          presets: {
            'claude-code': { fast: { model: 'haiku' } },
            'paseo': { fast: { profile: 'implementer-luna', thinking: 'xhigh' } },
            'codex': { fast: { model: 'gpt-6-luna', thinking: 'xhigh' } },
          },
        },
      }),
      paths,
      engine: new FakeEngine({ fast: 0.9, standard: 0.05, deep: 0.05 }),
      env: {},
    });
    const decide = async (harness: string): Promise<Record<string, unknown>> =>
      json(
        await fetch(`${gw.url}/v1/decide/routing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ harness, input: { prompt: 'rename foo' } }),
        }),
      );
    try {
      const claude = await decide('claude-code');
      assert.equal(claude['action'], 'route:fast');
      assert.deepEqual(claude['route'], { preset: 'fast', model: 'haiku' });
      assert.deepEqual((await decide('codex'))['route'], {
        preset: 'fast',
        model: 'gpt-6-luna',
        thinking: 'xhigh',
      });
      assert.deepEqual((await decide('paseo'))['route'], {
        preset: 'fast',
        thinking: 'xhigh',
        profile: 'implementer-luna',
      });
      assert.equal((await decide('mcp'))['route'], undefined, 'mcp has no mapping');
    } finally {
      await gw.close();
    }
  });

  it('resolves a profile preset to a routed model from the harness profile models', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig({
        policies: { routing: { mode: 'act' } },
        routing: { presets: { paseo: { fast: { profile: 'implementer-luna' } } } },
      }),
      paths,
      engine: new FakeEngine({ fast: 0.9, standard: 0.05, deep: 0.05 }),
      env: {},
    });
    try {
      const res = await fetch(`${gw.url}/v1/decide/routing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          harness: 'paseo',
          input: { prompt: 'rename foo' },
          models: {
            requested: 'claude/claude-opus-5-5',
            profiles: { 'implementer-luna': 'codex/gpt-6-luna' },
          },
        }),
      });
      const id = (await json(res))['decisionId'];
      const record = readLog(paths, gw).find((r) => r.kind === 'decision' && r.decisionId === id);
      assert.ok(record?.kind === 'decision');
      assert.equal(record.requestedModel, 'claude/claude-opus-5-5');
      assert.equal(record.routedModel, 'codex/gpt-6-luna');
    } finally {
      await gw.close();
    }
  });
});

describe('gateway precedent', () => {
  it('learns from outcomes posted for escalated requests', async () => {
    const paths = tempPaths();
    const reportTokenFile = join(paths.config, 'report-token');
    const gw = await startGateway({
      config: testConfig({ policies: { permission: { mode: 'act' } } }),
      paths,
      engine: new FakeEngine({ allow: 0.7, ask: 0.2, deny: 0.1 }),
      env: {},
    });
    const reportToken = readFileSync(reportTokenFile, 'utf8');
    const decide = async (): Promise<Record<string, unknown>> =>
      json(
        await fetch(`${gw.url}/v1/decide/permission`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            harness: 'paseo',
            scope: 'claude-auto',
            workspace: { cwd: '/project' },
            input: { project: '/project', subject: 'Bash: npm test', request: 'npm test' },
          }),
        }),
      );
    try {
      const forged = await decide();
      assert.equal(forged['action'], 'ask');
      assert.deepEqual(forged['precedent'], { allows: 0, denies: 0 });
      const forgedOutcome = await fetch(`${gw.url}/v1/outcomes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decisionId: forged['decisionId'],
          outcome: 'allow',
          source: 'user',
        }),
      });
      assert.equal(forgedOutcome.status, 200);
      const forgedRecord = readLog(paths, gw).findLast(
        (record) => record.kind === 'outcome' && record.decisionId === forged['decisionId'],
      );
      assert.equal(
        forgedRecord?.kind === 'outcome' ? forgedRecord.source : undefined,
        'unverified',
      );
      assert.equal(forgedRecord?.kind === 'outcome' ? forgedRecord.verified : undefined, false);
      for (const source of ['classifier', 'harness', 'user'] as const) {
        for (let index = 0; index < 9; index += 1) {
          const result = await decide();
          assert.equal(result['action'], 'ask');
          assert.deepEqual(result['precedent'], { allows: 0, denies: 0 });
          const outcome = await fetch(`${gw.url}/v1/outcomes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              decisionId: result['decisionId'],
              outcome: 'allow',
              source,
            }),
          });
          assert.equal(outcome.status, 200);
        }
      }
      const unaffected = await decide();
      assert.equal(unaffected['action'], 'ask');
      assert.deepEqual(unaffected['precedent'], { allows: 0, denies: 0 });

      for (let index = 0; index < 3; index += 1) {
        const result = await decide();
        assert.equal(result['action'], 'ask');
        assert.equal(
          (
            await fetch(`${gw.url}/v1/outcomes`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-local-decider-report': reportToken,
              },
              body: JSON.stringify({
                decisionId: result['decisionId'],
                outcome: 'allow',
                source: 'user',
              }),
            })
          ).status,
          200,
        );
      }
      const verifiedRecord = readLog(paths, gw).findLast(
        (record) => record.kind === 'outcome' && record.verified === true,
      );
      assert.equal(verifiedRecord?.kind === 'outcome' ? verifiedRecord.source : undefined, 'user');
      const learned = await decide();
      assert.equal(learned['action'], 'allow');
      assert.deepEqual(learned['precedent'], { allows: 3, denies: 0 });
      await fetch(`${gw.url}/v1/outcomes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decisionId: learned['decisionId'],
          outcome: 'deny',
          source: 'classifier',
        }),
      });
      const classifierRecord = readLog(paths, gw).findLast(
        (record) => record.kind === 'outcome' && record.decisionId === learned['decisionId'],
      );
      assert.deepEqual(
        classifierRecord?.kind === 'outcome'
          ? [classifierRecord.source, classifierRecord.claimedSource, classifierRecord.verified]
          : [],
        ['unverified', 'classifier', false],
      );
      const vetoed = await decide();
      assert.equal(vetoed['action'], 'ask', JSON.stringify(vetoed));
      assert.deepEqual(vetoed['precedent'], { allows: 3, denies: 1 });
      assert.equal(JSON.stringify(readLog(paths, gw)).includes(reportToken), false);
    } finally {
      await gw.close();
    }
  });
});

describe('gateway HTTP', () => {
  let gw: Gateway;
  const logPaths = tempPaths();
  let configDir = '';
  const engine = new FakeEngine({ done: 0.9, needs_input: 0.05, stuck: 0.03, failed: 0.02 });

  before(async () => {
    configDir = logPaths.config;
    gw = await startGateway({ config: testConfig(), paths: logPaths, engine, env: {} });
  });
  after(async () => gw.close());

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${gw.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...controlHeaders(logPaths), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const readStats = async (): Promise<
    { policy: string; labelled: number; unverified?: { outcomes: number; usage: number } }[]
  > => (await (await fetch(`${gw.url}/v1/stats`)).json()) as never;

  it('GET /health and /ping report the engine', async () => {
    for (const path of ['/health', '/ping']) {
      const body = await json(await fetch(`${gw.url}${path}`));
      assert.equal(body['status'], 'ok');
      assert.equal(body['engine'], 'fake');
      assert.equal(body['engineTag'], 'fake');
    }
  });

  it('starts no decision when the client leaves during the body read', async () => {
    const baseline = engine.requests.length;
    const port = Number(new URL(gw.url).port);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          'POST /v1/systemone HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\nContent-Length: 500\r\n\r\n{"state":',
        );
        setTimeout(() => socket.destroy(), 20);
      });
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(engine.requests.length, baseline);
    const ok = await post('/v1/systemone', {
      state: 's',
      questions: { q: { type: 'choice', instructions: 'i', criteria: { done: 'd' } } },
    });
    assert.equal(ok.status, 200, 'a normal request is not aborted');
  });

  it('refuses harness mcp on a hook-enforced policy with 403, other harnesses unaffected', async () => {
    const mcp = await post('/v1/decide/permission', { harness: 'mcp', input: {} });
    assert.equal(mcp.status, 403);
    assert.deepEqual(await mcp.json(), { error: 'policy not available to agents' });
    const hook = await post('/v1/decide/permission', { harness: 'claude-code', input: {} });
    assert.equal(hook.status, 200);
    const open = await post('/v1/decide/turn-outcome', { harness: 'mcp', input: {} });
    assert.equal(open.status, 200);
  });

  it('POST /v1/decide?view=agent returns only the projection, 400 for another view', async () => {
    const res = await post('/v1/decide/turn-outcome?view=agent', { harness: 'mcp', input: {} });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(Object.keys(body).toSorted(), [
      'action',
      'decisionId',
      'enforced',
      'failedOpen',
      'policy',
      'primary',
      'truncated',
    ]);
    assert.equal(body['enforced'], false);
    for (const hidden of ['answers', 'rule', 'precedentKey', 'engine', 'model']) {
      assert.equal(hidden in body, false, hidden);
    }
    assert.equal(
      (await post('/v1/decide/turn-outcome?view=full', { harness: 'mcp', input: {} })).status,
      400,
    );
    const plain = await json(await post('/v1/decide/turn-outcome', { harness: 'cli', input: {} }));
    assert.ok('answers' in plain, 'the body is unchanged without the query');
  });

  it('GET /v1/policies?view=agent lists only open policies, trimmed', async () => {
    const res = await fetch(`${gw.url}/v1/policies?view=agent`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as Record<string, unknown>[];
    const ids = list.map((p) => p['id']);
    assert.ok(ids.includes('turn-outcome'));
    assert.ok(!ids.includes('permission'));
    for (const entry of list) {
      assert.deepEqual(Object.keys(entry).toSorted(), [
        'description',
        'id',
        'inputKeys',
        'questions',
      ]);
    }
    assert.equal((await fetch(`${gw.url}/v1/policies?view=x`)).status, 400);
  });

  it('GET /models and /v1/policies', async () => {
    const models = await json(await fetch(`${gw.url}/models`));
    assert.ok(Array.isArray(models['models']));
    const policies = (await (await fetch(`${gw.url}/v1/policies`)).json()) as { id: string }[];
    assert.deepEqual(policies.map((p) => p.id).toSorted(), [
      'command-risk',
      'command-risk-binary',
      'permission',
      'routing',
      'routing-budget',
      'routing-task-kind',
      'turn-outcome',
    ]);
    const routing = policies.find((p) => p.id === 'routing') as Record<string, unknown>;
    assert.deepEqual(routing['routes'], ['fast', 'deep', 'standard']);
    assert.equal(routing['variant'], 'routing');
    assert.deepEqual(routing['variants'], ['routing', 'routing-budget', 'routing-task-kind']);
    const budget = policies.find((p) => p.id === 'routing-budget') as Record<string, unknown>;
    assert.equal(budget['variantOf'], 'routing');
  });

  it('policy variant and reload routes need a switchable engine', async () => {
    assert.equal((await post('/v1/policies/routing/variant', { variant: 'x' })).status, 409);
    assert.equal((await post('/v1/policies/reload', {})).status, 409);
  });

  it('POST /v1/decide/:policy runs a policy', async () => {
    const res = await post('/v1/decide/turn-outcome', {
      harness: 'paseo',
      input: { lastMessage: 'done' },
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body['action'], 'log');
    assert.equal(body['enforced'], false);
  });

  it('drops an out-of-range budgetMs instead of rejecting or applying it', async () => {
    for (const budgetMs of [0, -5, 1.5, 600_001, '100', null]) {
      const res = await post('/v1/decide/turn-outcome', {
        harness: 'paseo',
        input: { lastMessage: 'done' },
        budgetMs,
      });
      assert.equal(res.status, 200);
      assert.equal((await json(res))['error'], undefined);
    }
  });

  it('validates requests', async () => {
    assert.equal(
      (await post('/v1/decide/turn-outcome', { harness: 'evil', input: {} })).status,
      400,
    );
    assert.equal((await post('/v1/decide/turn-outcome', { harness: 'cli' })).status, 400);
    assert.equal((await post('/v1/decide/turn-outcome', '{nope')).status, 400);
    assert.equal((await post('/v1/decide/missing', { harness: 'cli', input: {} })).status, 404);
    assert.equal((await post('/v1/decide/../../etc', { harness: 'cli', input: {} })).status, 404);
    assert.equal((await post('/v1/systemone', { state: 'x' })).status, 400);
    assert.equal((await fetch(`${gw.url}/nope`)).status, 404);
  });

  it('rejects oversized bodies', async () => {
    const res = await post('/v1/decide/turn-outcome', {
      harness: 'claude-code',
      input: { lastMessage: 'x'.repeat(300 * 1024) },
    });
    assert.equal(res.status, 413);
  });

  it('POST /v1/systemone passes through', async () => {
    const res = await post('/v1/systemone', {
      state: 's',
      questions: { q: { type: 'choice', instructions: 'i', criteria: { done: 'a', stuck: 'b' } } },
    });
    const body = await json(res);
    assert.ok(typeof body['answers'] === 'object');
  });

  it('POST /v1/systemone returns 503 while the engine is held', async () => {
    gw.decider.hold(ENGINE_BENCHMARK_RUNNING_ERROR);
    try {
      const res = await post('/v1/systemone', {
        state: 's',
        questions: {
          q: { type: 'choice', instructions: 'i', criteria: { done: 'a', stuck: 'b' } },
        },
      });
      assert.equal(res.status, 503);
      assert.deepEqual(await json(res), { error: ENGINE_BENCHMARK_RUNNING_ERROR });
    } finally {
      gw.decider.hold(null);
    }
  });

  it('records outcomes and serves stats', async () => {
    const decision = await json(
      await post('/v1/decide/turn-outcome', {
        harness: 'claude-code',
        input: { lastMessage: 'ok' },
      }),
    );
    const demoted = await post('/v1/outcomes', {
      decisionId: decision['decisionId'],
      outcome: 'done',
      source: 'supervised',
    });
    assert.equal(demoted.status, 200);
    assert.deepEqual(await demoted.json(), { ok: true, verified: false });
    const outcome = readLog(logPaths, gw).findLast(
      (record) => record.kind === 'outcome' && record.decisionId === decision['decisionId'],
    );
    assert.equal(outcome?.kind === 'outcome' ? outcome.source : undefined, 'unverified');
    assert.equal(outcome?.kind === 'outcome' ? outcome.verified : undefined, false);
    assert.equal((await post('/v1/outcomes', { outcome: 'done' })).status, 400);
    const first = (await readStats()).find((s) => s.policy === 'turn-outcome');
    assert.equal(first?.labelled, 0, 'unverified outcomes are not agreement labels');
    assert.equal(first.unverified?.outcomes, 1);
    const reportHeader = {
      'x-local-decider-report': readFileSync(join(configDir, 'report-token'), 'utf8'),
    };
    const verifiedReply = await post(
      '/v1/outcomes',
      { decisionId: decision['decisionId'], outcome: 'done', source: 'user' },
      reportHeader,
    );
    assert.equal(verifiedReply.status, 200);
    assert.deepEqual(await verifiedReply.json(), { ok: true, verified: true });
    const stats = await readStats();
    assert.equal(stats.find((s) => s.policy === 'turn-outcome')?.labelled, 1);
    const reportToken = readFileSync(join(configDir, 'report-token'), 'utf8');
    assert.equal(JSON.stringify(readLog(logPaths, gw)).includes(reportToken), false);
  });

  it('records usage against a decision and reports token savings', async () => {
    const decision = await json(
      await post('/v1/decide/turn-outcome', {
        harness: 'claude-code',
        input: { lastMessage: 'ok' },
        models: {
          requested: 'claude/claude-opus-4-6[1m]',
          routes: { log: 'claude/haiku', bad: 'no spaces allowed' },
        },
      }),
    );
    const usage = {
      decisionId: decision['decisionId'],
      turnId: 't1',
      model: 'claude/claude-opus-4-6[1m]',
      inputTokens: 1000,
      cachedInputTokens: 5000,
      outputTokens: 200,
    };
    const reportHeader = {
      'x-local-decider-report': readFileSync(join(configDir, 'report-token'), 'utf8'),
    };
    assert.equal((await post('/v1/usage', usage)).status, 200);
    const unverifiedStats = (await (await fetch(`${gw.url}/v1/stats`)).json()) as {
      policy: string;
      savings?: { potential: { moved: number } };
      unverified?: { usage: number };
    }[];
    const unverifiedPolicy = unverifiedStats.find((s) => s.policy === 'turn-outcome');
    assert.equal(unverifiedPolicy?.savings?.potential.moved, 0, 'unverified usage saves nothing');
    assert.ok((unverifiedPolicy?.unverified?.usage ?? 0) >= 1);
    assert.equal((await post('/v1/usage', usage, reportHeader)).status, 200);
    assert.equal(
      (await post('/v1/usage', usage, reportHeader)).status,
      200,
      'a repeated turn counts once',
    );
    assert.equal((await post('/v1/usage', { ...usage, inputTokens: -1 })).status, 400);
    const stats = (await (await fetch(`${gw.url}/v1/stats`)).json()) as {
      policy: string;
      savings?: {
        potential: { moved: number; tokens: { input: number }; moves: { from: string }[] };
      };
    }[];
    const potential = stats.find((s) => s.policy === 'turn-outcome')?.savings?.potential;
    assert.equal(potential?.moved, 1);
    assert.equal(potential.tokens.input, 1000);
    assert.equal(potential.moves[0]?.from, 'claude/claude-opus-4-6[1m]');
  });

  it('rejects unknown decisions and outcome values, and rate-limits unverified posts', async () => {
    const decision = await json(
      await post('/v1/decide/turn-outcome', {
        harness: 'claude-code',
        input: { lastMessage: 'ok' },
      }),
    );
    const reportHeader = {
      'x-local-decider-report': readFileSync(join(configDir, 'report-token'), 'utf8'),
    };
    const usage = { decisionId: 'nope', inputTokens: 1, outputTokens: 1 };
    assert.equal((await post('/v1/usage', usage)).status, 404);
    assert.equal((await post('/v1/usage', usage, reportHeader)).status, 404);
    const unknown = { decisionId: 'nope', outcome: 'allow' };
    assert.equal((await post('/v1/outcomes', unknown)).status, 404);
    const bad = { decisionId: decision['decisionId'], outcome: 'whatever' };
    assert.equal((await post('/v1/outcomes', bad)).status, 400);
    assert.equal((await post('/v1/outcomes', bad, reportHeader)).status, 400);
    const good = { decisionId: decision['decisionId'], outcome: 'stuck' };
    assert.equal((await post('/v1/outcomes', good)).status, 200, 'an answer label is valid');

    const statuses: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      statuses.push((await post('/v1/outcomes', good)).status);
    }
    assert.ok(statuses.includes(429), 'unverified posts are limited');
    for (let index = 0; index < 40; index += 1) {
      assert.equal((await post('/v1/outcomes', good, reportHeader)).status, 200);
    }
  });

  it('serves MCP tools/list and decide', async () => {
    const headers = { accept: 'application/json, text/event-stream' };
    const list = await json(
      await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers),
    );
    const tools = (list['result'] as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(tools.toSorted(), ['decide', 'policies']);
    const call = await json(
      await post(
        '/mcp',
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'decide',
            arguments: { policy: 'turn-outcome', input: { lastMessage: 'done' } },
          },
        },
        headers,
      ),
    );
    const text = (call['result'] as { content: { text: string }[] }).content[0]?.text ?? '';
    assert.equal((JSON.parse(text) as { action: string }).action, 'log');
  });

  it('accepts an MCP protocol version newer than the SDK knows on later requests', async () => {
    const headers = {
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
    };
    const res = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);
    assert.equal(res.status, 200);
    const list = await json(res);
    const tools = (list['result'] as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(tools.toSorted(), ['decide', 'policies']);
  });
});

describe('gateway browser guard', () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: {},
    });
  });
  after(async () => gw.close());

  const port = (): string => new URL(gw.url).port;
  /** Raw request so Host and Origin can be set (fetch forbids both). */
  function raw(
    headers: Record<string, string>,
    method = 'POST',
    body = '{"harness":"cli","input":{}}',
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: port(), path: '/v1/decide/turn-outcome', method, headers },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? body : undefined);
    });
  }

  it('answers 400 to a request target URL cannot parse, and keeps serving', async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port()), '127.0.0.1', () => {
        socket.end('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => (data += String(chunk)));
      socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
    assert.match(status, / 400 /);
    assert.equal((await fetch(`${gw.url}/health`)).status, 200);
  });

  it('refuses text/plain POSTs (no CORS preflight)', async () => {
    assert.equal(await raw({ 'content-type': 'text/plain' }), 403);
    assert.equal(await raw({}), 403);
  });

  it('refuses non-loopback Host headers (DNS rebinding)', async () => {
    assert.equal(
      await raw({ 'content-type': 'application/json', 'host': `evil.example:${port()}` }),
      403,
    );
  });

  it('refuses foreign browser origins, including null', async () => {
    assert.equal(
      await raw({ 'content-type': 'application/json', 'origin': 'https://evil.example' }),
      403,
    );
    assert.equal(await raw({ 'content-type': 'application/json', 'origin': 'null' }), 403);
  });

  it('accepts loopback JSON requests', async () => {
    assert.equal(await raw({ 'content-type': 'application/json; charset=utf-8' }), 200);
    assert.equal(
      await raw({
        'content-type': 'application/json',
        'host': `localhost:${port()}`,
        'origin': 'http://localhost:3000',
      }),
      200,
    );
    assert.equal(await raw({}, 'GET'), 404);
  });

  it('reports which models fit in memory', async () => {
    const body = (await (await fetch(`${gw.url}/models`)).json()) as {
      totalMemoryGb: number;
      models: { fits: boolean }[];
    };
    assert.ok(body.totalMemoryGb > 0);
    assert.ok(body.models.every((m) => typeof m.fits === 'boolean'));
  });
});

describe('control token', () => {
  let gw: Gateway;
  const paths = tempPaths();
  const engine = new FakeEngine();

  before(async () => {
    gw = await startGateway({ config: testConfig(), paths, engine, env: {} });
  });
  after(async () => gw.close());

  it('guards every control route before reading the request or causing effects', async () => {
    const routes = [
      ['GET', '/v1/engines'],
      ['POST', '/v1/engine'],
      ['POST', '/v1/engine/mode'],
      ['POST', '/v1/engine/load'],
      ['POST', '/v1/engine/unload'],
      ['POST', '/v1/engine/lifecycle'],
      ['POST', '/v1/models/download'],
      ['POST', '/v1/models/remove'],
      ['POST', '/v1/engines/validate'],
      ['POST', '/v1/engines/discover'],
      ['POST', '/v1/paths'],
      ['POST', '/v1/policies/reload'],
      ['POST', '/v1/policies/permission/mode'],
      ['POST', '/v1/policies/permission/variant'],
      ['POST', '/v1/policies/permission/thresholds'],
      ['POST', '/v1/policies/permission/selection'],
      ['GET', '/v1/config'],
      ['POST', '/v1/config/reload'],
      ['POST', '/v1/config/engine'],
      ['POST', '/v1/routing/presets'],
      ['GET', '/v1/policies/routing/prompt'],
    ] as const;
    const valid = controlHeaders(paths)['x-local-decider-control'] ?? '';
    const wrong = 'w'.repeat(valid.length);
    const stateBefore = engine.state;
    const configFile = join(paths.config, 'config.yaml');
    const configBefore = existsSync(configFile) ? readFileSync(configFile) : undefined;
    const policiesDirectory = join(paths.config, 'policies');
    const policiesBefore = directorySnapshot(policiesDirectory);
    for (const [method, path] of routes) {
      for (const headers of [
        {},
        { 'x-local-decider-control': wrong },
        { 'x-local-decider-control': '' },
      ]) {
        const res = await fetch(`${gw.url}${path}`, {
          method,
          headers: {
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal((await res.text()).includes(valid), false);
      }
    }
    assert.equal(engine.state, stateBefore);
    assert.equal(engine.requests.length, 0);
    assert.equal(existsSync(policiesDirectory), false);
    assert.deepEqual(directorySnapshot(policiesDirectory), policiesBefore);
    assert.equal(
      existsSync(configFile) ? readFileSync(configFile).toString() : undefined,
      configBefore?.toString(),
    );
  });

  it('leaves open routes available without a control token', async () => {
    for (const path of ['/health', '/ping', '/v1/policies']) {
      assert.notEqual((await fetch(`${gw.url}${path}`)).status, 401, path);
    }
    assert.equal(
      (
        await fetch(`${gw.url}/v1/decide/turn-outcome`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ harness: 'cli', input: {} }),
        })
      ).status,
      200,
    );
    assert.equal((await fetch(`${gw.url}/v1/calls/missing`)).status, 404);
    const mcp = await fetch(`${gw.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.notEqual(mcp.status, 401);
  });

  it('accepts a mixed-case control header name and rejects a duplicate header', async () => {
    const token = controlHeaders(paths)['x-local-decider-control'] ?? '';
    assert.equal(
      (await fetch(`${gw.url}/v1/engines`, { headers: { 'X-Local-Decider-Control': token } }))
        .status,
      409,
      'authentication passes before the injected engine 409',
    );
    const duplicate = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(new URL(gw.url).port),
          path: '/v1/engines',
          headers: { 'x-local-decider-control': [token, token] },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(duplicate, 401);
  });
});

describe('gateway auth', () => {
  it('refuses a non-loopback bind without a token', async () => {
    await assert.rejects(
      startGateway({
        config: testConfig({ host: '0.0.0.0' }),
        paths: tempPaths(),
        engine: new FakeEngine(),
        env: {},
      }),
      /LOCAL_DECIDER_TOKEN/,
    );
  });

  it('requires the bearer token when one is set', async () => {
    const token = 'a-very-long-test-token';
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: { LOCAL_DECIDER_TOKEN: token },
    });
    try {
      assert.equal((await fetch(`${gw.url}/health`)).status, 401);
      assert.equal(
        (await fetch(`${gw.url}/health`, { headers: { authorization: 'Bearer wrong' } })).status,
        401,
      );
      assert.equal(
        (await fetch(`${gw.url}/health`, { headers: { authorization: `Bearer ${token}` } })).status,
        200,
      );
    } finally {
      await gw.close();
    }
  });

  it('uses the bearer token, not the control header, on control routes in token mode', async () => {
    const token = 'a-very-long-test-token';
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine(),
      env: { LOCAL_DECIDER_TOKEN: token },
    });
    try {
      const route = `${gw.url}/v1/engines`;
      const bearerOnly = await fetch(route, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.notEqual(bearerOnly.status, 401);
      const controlOnly = await fetch(route, { headers: controlHeaders(paths) });
      assert.equal(controlOnly.status, 401);
    } finally {
      await gw.close();
    }
  });
});

describe('engine status stamps', () => {
  it('returns cached status without awaiting a blocked llama version probe', async () => {
    const paths = tempPaths();
    const bin = join(paths.data, 'bin');
    mkdirSync(bin, { recursive: true });
    const llama = join(bin, 'llama-server');
    writeFileSync(llama, `#!${process.execPath}\nsetInterval(() => undefined, 1000)\n`);
    chmodSync(llama, 0o755);
    const env = {
      PATH: bin,
      FLM_MODEL_PATH: join(paths.data, 'flm-models'),
      HF_HUB_CACHE: join(paths.data, 'hf-cache'),
    };
    const config = testConfig();
    const store = new MemoryConfigStore(config);
    const control = new EngineControl({
      store,
      paths,
      env,
      capabilities: async () => NO_CAPABILITIES,
      installed: async (ids) => new Map(ids.map((id) => [id, false])),
      create: () => new FakeEngine(),
    });
    const gw = await startGateway({ config, store, paths, env, engineControl: control });
    try {
      const started = performance.now();
      const response = await fetch(`${gw.url}/v1/engines`, { headers: controlHeaders(paths) });
      const elapsedMs = performance.now() - started;
      assert.equal(response.status, 200);
      assert.ok(elapsedMs < 500, `status took ${String(elapsedMs)} ms`);
      const body = await json(response);
      const engines = body['engines'] as { id: string; version?: string | null }[];
      assert.equal('version' in (engines.find((entry) => entry.id === 'llama-vulkan') ?? {}), true);
      const models = body['models'] as {
        id: string;
        engine: string;
        family?: { id: string; label: string } | null;
        format?: { short: string; label: string } | null;
        measured?: unknown[];
      }[];
      const llamaModel = models.find(
        (entry) => entry.engine === 'llama-vulkan' && entry.id === 'd3-mini-q4_k_m',
      );
      assert.deepEqual(llamaModel?.family, { id: 'vllm-sr/d3-mini', label: 'd3 mini' });
      assert.deepEqual(llamaModel?.format, { short: 'Q4_K_M', label: '4-bit (Q4_K_M)' });
      assert.deepEqual(llamaModel?.measured, []);
    } finally {
      await gw.close();
    }
  });
});

describe('HTTP server hardening', () => {
  it('derives header, request and keep-alive timeouts from the decision deadline', () => {
    const server = createGatewayServer({ decisionTimeoutMs: 45_000 } as ServerOptions);
    const expected = serverTimeouts(45_000);
    assert.equal(server.headersTimeout, expected.headersTimeout);
    assert.equal(server.requestTimeout, expected.requestTimeout);
    assert.equal(server.keepAliveTimeout, expected.keepAliveTimeout);
    assert.ok(server.requestTimeout > 45_000, 'above the longest legitimate decision');
    assert.ok(server.headersTimeout > 45_000);
    assert.ok(server.headersTimeout <= server.requestTimeout);
    assert.ok(server.keepAliveTimeout > 0);
  });

  it('answers 500 with a generic body when the listener throws synchronously', async () => {
    const SECRET = `sk-${'a'.repeat(40)}`;
    const lines: string[] = [];
    const options = { report: (line: string) => lines.push(line) } as unknown as ServerOptions;
    Object.defineProperty(options, 'token', {
      get() {
        throw new Error(`boom ${SECRET}\nsecond line`);
      },
    });
    const server = createGatewayServer(options);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'internal error' });
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? '', /^request error: boom /);
      assert.ok(!(lines[0] ?? '').includes(SECRET), 'secrets are redacted in the log');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

interface Rig {
  readonly gw: Gateway;
  readonly paths: ReturnType<typeof tempPaths>;
  readonly engines: Map<string, FakeEngine>;
}

/** A gateway on a 2B CPU default model (8 GB of a 20 GB budget); engines are fakes keyed by model. */
async function rig(
  policies: Record<string, unknown>,
  engine: Record<string, unknown> = { type: 'strands-decider', device: 'cpu' },
  binaries: readonly string[] = ['llama-server', 'flm'],
): Promise<Rig> {
  const paths = tempPaths();
  const bin = join(paths.data, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of binaries) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nconsole.log('FLM v1.0.12')\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const venv = join(paths.venvs, 'strands-decider', 'bin');
  mkdirSync(venv, { recursive: true });
  writeFileSync(join(venv, 'strands-decider'), `#!${process.execPath}\n`);
  chmodSync(join(venv, 'strands-decider'), 0o755);
  const env = { PATH: bin, HF_HUB_CACHE: join(paths.data, 'hf') };
  const config = parseConfig({ port: 0, engine, lifecycle: { mode: 'eager' }, policies });
  const store = new MemoryConfigStore(config);
  const engines = new Map<string, FakeEngine>();
  const control = new EngineControl({
    store,
    paths,
    env,
    totalMemory: 25e9,
    capabilities: async () => NO_CAPABILITIES,
    installed: async (ids) => new Map(ids.map((id) => [id, true])),
    create: (c) => {
      const fake = new FakeEngine();
      fake.id = c.type;
      fake.model = c.model;
      engines.set(c.model, fake);
      return fake;
    },
  });
  const gw = await startGateway({ config, store, paths, env, engineControl: control });
  await control.idle();
  return { gw, paths, engines };
}

const post = (
  r: Rig,
  id: string,
  body: unknown,
  headers = controlHeaders(r.paths),
): Promise<Response> =>
  fetch(`${r.gw.url}/v1/policies/${id}/selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function listed(r: Rig, id: string): Promise<Record<string, unknown>> {
  const policies = (await (await fetch(`${r.gw.url}/v1/policies`)).json()) as Record<
    string,
    unknown
  >[];
  return policies.find((policy) => policy['id'] === id) ?? {};
}

describe('policy selection routes', () => {
  const OWN = { engine: 'llama-vulkan', model: 'd3-lite-q8_0' };
  const HOBSON = 'StrandsAgents/strands-decider-2B-hobson-v21';
  const HOBSON_V19 = 'StrandsAgents/strands-decider-2B-hobson-v19';
  const DECISION = {
    harness: 'claude-code',
    input: {
      project: '/p',
      tool: 'Bash',
      command: 'echo 1',
      request: { command: 'echo 1' },
      history: 'user: 1',
    },
  };

  it('sets and clears a model, and reports it on /v1/policies, /v1/engines and /health', async () => {
    const r = await rig({ 'command-risk': { mode: 'act' }, 'permission': { mode: 'act' } });
    try {
      const unset = await listed(r, 'command-risk');
      assert.equal(unset['selection'], null);
      assert.equal(unset['selectionStatus'], 'default');
      assert.equal(unset['modelSource'], 'default');

      const set = await post(r, 'command-risk', OWN);
      assert.equal(set.status, 200);
      const body = await json(set);
      assert.equal(body['ok'], true);
      assert.equal(body['policy'], 'command-risk');
      assert.equal(body['status'], 'active');
      assert.equal('reason' in body, false, 'no reason while active');
      assert.equal((body['selection'] as Record<string, unknown>)['model'], OWN.model);

      const chosen = await listed(r, 'command-risk');
      assert.equal(chosen['engine'], 'llama-vulkan');
      assert.equal(chosen['model'], OWN.model);
      assert.equal(chosen['modelSource'], 'policy');
      assert.equal(chosen['selectionStatus'], 'active');
      assert.equal((chosen['selection'] as Record<string, unknown>)['model'], OWN.model);

      const engines = await json(
        await fetch(`${r.gw.url}/v1/engines`, { headers: controlHeaders(r.paths) }),
      );
      const [row] = engines['policies'] as Record<string, unknown>[];
      assert.equal(row?.['id'], 'command-risk');
      assert.equal(row?.['fallback'], 'default');
      assert.equal(typeof row?.['label'], 'string');
      assert.equal(row?.['status'], 'active');

      const health = await json(await fetch(`${r.gw.url}/health`));
      const [own] = health['policyEngines'] as Record<string, unknown>[];
      assert.equal(own?.['policy'], 'command-risk');
      assert.equal(own?.['model'], OWN.model);
      assert.equal(own?.['fallback'], 'default');
      assert.equal(own?.['status'], 'active');

      const cleared = await post(r, 'command-risk', { clear: true });
      assert.equal(cleared.status, 200);
      assert.deepEqual(await json(cleared), {
        ok: true,
        policy: 'command-risk',
        selection: null,
        status: 'default',
      });
      assert.equal((await listed(r, 'command-risk'))['modelSource'], 'default');
      assert.deepEqual((await json(await fetch(`${r.gw.url}/health`)))['policyEngines'], []);
    } finally {
      await r.gw.close();
    }
  });

  it('answers each refusal with its status', async () => {
    const r = await rig({
      'command-risk': {
        mode: 'act',
        selection: { engine: 'strands-decider', model: HOBSON, device: 'cpu' },
      },
      'permission': { mode: 'act' },
    });
    try {
      const expectations: [string, unknown, number, RegExp][] = [
        ['permission', '{', 400, /./],
        ['permission', [], 400, /./],
        ['permission', { engine: 'nope', model: 'x' }, 400, /engine/],
        ['permission', { model: 'x' }, 400, /engine/],
        ['permission', { engine: 'llama-vulkan' }, 400, /model/],
        ['permission', { clear: true, engine: 'llama-vulkan', model: 'x' }, 400, /clear: true/],
        [
          'permission',
          { engine: 'llama-vulkan', model: 'x' },
          400,
          /unknown llama-vulkan model "x"/,
        ],
        ['nope', OWN, 404, /unknown policy "nope"/],
        [
          'permission',
          { engine: 'strands-decider', model: HOBSON_V19, device: 'cpu' },
          409,
          /needs ~\d+(\.\d+)? GB with the other models loaded; this machine allows ~20 GB/,
        ],
      ];
      for (const [id, body, status, message] of expectations) {
        const res = await post(r, id, body);
        assert.equal(res.status, status, `${id} ${JSON.stringify(body)}`);
        assert.match(String((await json(res))['error']), message);
      }
      const missing = await post(r, 'permission', OWN, {});
      assert.equal(missing.status, 401, 'the control token is required');
      assert.equal((await listed(r, 'permission'))['selection'], null, 'nothing was saved');
    } finally {
      await r.gw.close();
    }
  });

  it('refuses a fourth own model and a second fastflowlm model', async () => {
    const r = await rig({
      'command-risk': { mode: 'act', selection: OWN },
      'permission': { mode: 'act', selection: { ...OWN, model: 'd3-mini-q8_0' } },
      'routing': { mode: 'act', selection: { ...OWN, model: 'd3-nano-q8_0' } },
      'routing-budget': { mode: 'act' },
    });
    try {
      const res = await post(r, 'routing-budget', { ...OWN, model: 'd3-flash-q4_k_m' });
      assert.equal(res.status, 409);
      assert.match(
        String((await json(res))['error']),
        /too many decisions with their own model \(max 3\)/,
      );
    } finally {
      await r.gw.close();
    }
    const flm = await rig({
      'command-risk': { mode: 'act', selection: { engine: 'fastflowlm', model: 'd3:nano' } },
      'permission': { mode: 'act' },
    });
    try {
      const res = await post(flm, 'permission', { engine: 'fastflowlm', model: 'd3:lite' });
      assert.equal(res.status, 409);
      assert.match(
        String((await json(res))['error']),
        /fastflowlm serves one model at a time; command-risk already uses d3:nano/,
      );
    } finally {
      await flm.gw.close();
    }
  });

  it('refuses a set when the default model cannot switch', async () => {
    const r = await rig(
      { 'command-risk': { mode: 'act', selection: OWN }, 'permission': { mode: 'act' } },
      { type: 'systemone-remote', url: 'http://127.0.0.1:1' },
    );
    try {
      const res = await post(r, 'permission', OWN);
      assert.equal(res.status, 409);
      assert.match(String((await json(res))['error']), /cannot switch/);
      const stale = await listed(r, 'command-risk');
      assert.equal(stale['selectionStatus'], 'unavailable');
      assert.equal(stale['selectionReason'], 'the default model cannot switch');
    } finally {
      await r.gw.close();
    }
  });

  it('shows a generic reason on open surfaces, keeping the detail behind the token', async () => {
    const r = await rig(
      { 'command-risk': { mode: 'act', selection: OWN } },
      { type: 'strands-decider', device: 'cpu' },
      ['flm'],
    );
    try {
      const open = await listed(r, 'command-risk');
      assert.equal(open['selectionStatus'], 'unavailable');
      assert.equal(open['selectionReason'], 'llama-vulkan is not available');
      assert.ok(!JSON.stringify(open).includes(r.paths.data), 'no path on /v1/policies');
      const health = JSON.stringify(await json(await fetch(`${r.gw.url}/health`)));
      assert.ok(!health.includes(r.paths.data), 'no path on /health');

      const refused = await post(r, 'permission', { ...OWN, model: 'd3-nano-q8_0' });
      assert.equal(refused.status, 409);
      assert.match(String((await json(refused))['error']), /llama-vulkan is not available/);
    } finally {
      await r.gw.close();
    }
  });

  it('lets only one of two simultaneous sets take the last lane', async () => {
    const r = await rig({
      'command-risk': { mode: 'act', selection: OWN },
      'permission': { mode: 'act', selection: { ...OWN, model: 'kev-0.8b-q8_0' } },
      'routing': { mode: 'act' },
      'routing-budget': { mode: 'act' },
    });
    try {
      const answers = await Promise.all([
        post(r, 'routing', { ...OWN, model: 'd3-nano-q8_0' }),
        post(r, 'routing-budget', { ...OWN, model: 'd3-mini-q4_k_m' }),
      ]);
      assert.deepEqual(
        answers.map((res) => res.status).toSorted((a, b) => a - b),
        [200, 409],
      );
      const refused = answers.find((res) => res.status === 409);
      assert.match(
        String((await json(refused as Response))['error']),
        /too many decisions with their own model \(max 3\)/,
      );
    } finally {
      await r.gw.close();
    }
  });

  it('sums engine counters over every lane and counts decisions held by a lane', async () => {
    const r = await rig({ 'command-risk': { mode: 'act', selection: OWN } });
    try {
      const lane = r.engines.get(OWN.model);
      assert.ok(lane);
      const release = Promise.withResolvers<void>();
      lane.counters = () => ({ engineRestarts: 2, engineHangs: 1 });
      lane.respond = async (decision) => {
        await release.promise;
        return {
          model: OWN.model,
          answers: Object.fromEntries(
            Object.keys(decision.questions).map((id) => [id, { type: 'choice', choice: 'done' }]),
          ),
        } as never;
      };
      const primary = r.engines.get(HOBSON) ?? [...r.engines.values()].find((e) => e !== lane);
      assert.ok(primary);
      primary.counters = () => ({ engineRestarts: 1, engineHangs: 0 });

      const held = fetch(`${r.gw.url}/v1/decide/command-risk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(DECISION),
      });
      let health: Record<string, unknown> = {};
      for (let i = 0; i < 50 && health['queueDepth'] !== 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        health = await json(await fetch(`${r.gw.url}/health`));
      }
      assert.equal(health['queueDepth'], 1, 'the lane decision counts toward the global depth');
      const counters = health['counters'] as Record<string, number>;
      assert.equal(counters['engineRestarts'], 3);
      assert.equal(counters['engineHangs'], 1);
      release.resolve();
      await held;
    } finally {
      await r.gw.close();
    }
  });
});
