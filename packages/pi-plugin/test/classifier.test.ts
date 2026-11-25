import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLASSIFIER_API,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  PLACEHOLDER_API_KEY,
  PROVIDER_ID,
  createClassifier,
  registerClassifier,
} from '../extension/classifier.ts';
import type { CallOptions, Gateway } from '../extension/gateway.ts';
import type {
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  PiAPI,
  PiProviderConfig,
} from '../extension/pi-types.ts';

interface Call {
  body: unknown;
  options: CallOptions;
}

/** `reply` is the gateway's resolved value, or a function producing it. */
function fakeGateway(reply: unknown): {
  gateway: Gateway;
  calls: Call[];
} {
  const calls: Call[] = [];
  const gateway: Gateway = {
    decide: async () => null,
    reportOutcome: async () => false,
    health: async () => false,
    systemOne: async (body, options) => {
      calls.push({ body, options });
      return typeof reply === 'function' ? (reply as () => Promise<unknown>)() : reply;
    },
  };
  return { gateway, calls };
}

const MODEL: ClassifierModel = {
  type: 'classifier',
  id: 'active',
  name: 'local-decider (active engine)',
  api: CLASSIFIER_API,
  provider: PROVIDER_ID,
  baseUrl: 'http://127.0.0.1:8765',
  input: ['text'],
  contextWindow: 8192,
  cost: {},
};

const CONTEXT: ClassifierContext = {
  state: { task: 'rm -rf build' },
  questions: {
    risk: {
      type: 'choice',
      instructions: 'How risky?',
      criteria: { low: 'safe', high: 'dangerous' },
    },
    level: { type: 'score', instructions: 'How big?', criteria: ['small', 'medium', 'large'] },
    destructive: {
      type: 'bool',
      instructions: 'Destructive?',
      criteria: { true: 'deletes data', false: 'keeps data' },
    },
  },
};

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'some-engine',
    answers: {
      risk: { type: 'choice', choice: 'high', probabilities: { low: 0.2, high: 0.8 } },
      level: {
        type: 'score',
        score: 1.2,
        confidence: 0.7,
        probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
      },
      destructive: { type: 'noul', noul: 0.9 },
      ...overrides,
    },
    usage: { input_tokens: 40, output_tokens: 2 },
  };
}

function assertComplete(result: ClassifierResult): void {
  assert.equal(result.api, CLASSIFIER_API);
  assert.equal(result.provider, PROVIDER_ID);
  assert.equal(result.model, 'active');
  assert.equal(typeof result.timestamp, 'number');
  assert.ok(Number.isFinite(result.timestamp));
  assert.ok(typeof result.answers === 'object');
}

function assertError(result: ClassifierResult, pattern: RegExp): void {
  assertComplete(result);
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(result.answers, {});
  assert.match(result.errorMessage ?? '', pattern);
}

test('success maps all three question types and back', async () => {
  const { gateway, calls } = fakeGateway(wire());
  const result = await createClassifier(gateway).classify(MODEL, CONTEXT);
  assertComplete(result);
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.errorMessage, undefined);
  const risk = result.answers['risk'];
  assert.equal(risk?.type, 'choice');
  if (risk?.type === 'choice') {
    assert.equal(risk.choice, 'high');
    assert.deepEqual(risk.probabilities, { low: 0.2, high: 0.8 });
    // (N·pmax − 1)/(N − 1) with N = 2, pmax = 0.8
    assert.ok(Math.abs(risk.confidence - 0.6) < 1e-9);
  }
  assert.deepEqual(result.answers['level'], { type: 'score', score: 1.2, confidence: 0.7 });
  assert.deepEqual(result.answers['destructive'], { type: 'bool', probability: 0.9 });
  assert.deepEqual(result.usage, {
    input: 40,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 42,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options.timeoutMs, DEFAULT_CLASSIFY_TIMEOUT_MS);
  assert.deepEqual(calls[0]?.body, {
    state: { task: 'rm -rf build' },
    questions: {
      risk: {
        type: 'choice',
        instructions: 'How risky?',
        criteria: { low: 'safe', high: 'dangerous' },
      },
      level: { type: 'score', instructions: 'How big?', criteria: ['small', 'medium', 'large'] },
      destructive: {
        type: 'noul',
        instructions: 'Destructive?',
        criteria: { true: 'deletes data', false: 'keeps data' },
      },
    },
  });
  const body = calls[0]?.body as Record<string, unknown>;
  assert.ok(!Object.hasOwn(body, 'model'));
});

test('a given choice confidence is kept; bool prefers probabilities.true', async () => {
  const { gateway } = fakeGateway(
    wire({
      risk: {
        type: 'choice',
        choice: 'low',
        probabilities: { low: 0.7, high: 0.3 },
        confidence: 0.9,
      },
      destructive: { type: 'noul', noul: 1, probabilities: { true: 0.75, false: 0.25 } },
    }),
  );
  const result = await createClassifier(gateway).classify(MODEL, CONTEXT);
  assert.equal(result.stopReason, 'stop');
  const risk = result.answers['risk'];
  assert.equal(risk?.type === 'choice' ? risk.confidence : undefined, 0.9);
  assert.deepEqual(result.answers['destructive'], { type: 'bool', probability: 0.75 });
});

test('a boolean noul maps to 1 or 0; a missing score confidence is derived', async () => {
  const { gateway } = fakeGateway(
    wire({
      level: { type: 'score', score: 2, probabilities: { 0: 0, 1: 0, 2: 1 } },
      destructive: { type: 'noul', noul: false },
    }),
  );
  const result = await createClassifier(gateway).classify(MODEL, CONTEXT);
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.answers['level'], { type: 'score', score: 2, confidence: 1 });
  assert.deepEqual(result.answers['destructive'], { type: 'bool', probability: 0 });
});

test('a missing answer gives an error result', async () => {
  const reply = wire();
  delete (reply['answers'] as Record<string, unknown>)['level'];
  const { gateway } = fakeGateway(reply);
  const result = await createClassifier(gateway).classify(MODEL, CONTEXT);
  assertError(result, /no answer for level/);
  assert.equal(result.usage?.totalTokens, 42);
});

test('malformed numbers give error results', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ destructive: { type: 'noul', noul: 1.5 } }, /malformed probability for destructive/],
    [{ destructive: { type: 'noul', noul: Number.NaN } }, /malformed probability/],
    [
      { destructive: { type: 'noul', noul: 0.5, probabilities: { true: -0.1 } } },
      /malformed probability/,
    ],
    [
      { risk: { type: 'choice', choice: 'high', probabilities: { low: 'x', high: 0.8 } } },
      /malformed probabilities for risk/,
    ],
    [
      {
        risk: {
          type: 'choice',
          choice: 'high',
          probabilities: { low: 0.2, high: 0.8 },
          confidence: 2,
        },
      },
      /malformed confidence for risk/,
    ],
    [
      { risk: { type: 'choice', choice: 'medium', probabilities: { low: 0.2, high: 0.8 } } },
      /unknown choice for risk/,
    ],
    [{ level: { type: 'score', score: 7, confidence: 0.5 } }, /malformed score for level/],
    [{ level: { type: 'score', score: 1 } }, /no confidence or probabilities for level/],
    [{ level: { type: 'noul', noul: 0.5 } }, /noul answer for level/],
  ];
  for (const [overrides, pattern] of cases) {
    const { gateway } = fakeGateway(wire(overrides));
    assertError(await createClassifier(gateway).classify(MODEL, CONTEXT), pattern);
  }
});

test('an unexpected reply shape gives an error result', async () => {
  const { gateway } = fakeGateway({ answers: 'nope' });
  assertError(await createClassifier(gateway).classify(MODEL, CONTEXT), /unexpected response/);
});

test('images give an error result without calling the gateway', async () => {
  const { gateway, calls } = fakeGateway(wire());
  const result = await createClassifier(gateway).classify(MODEL, {
    ...CONTEXT,
    images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
  });
  assertError(result, /image input/);
  assert.equal(calls.length, 0);
});

test('an abort gives an aborted result', async () => {
  const controller = new AbortController();
  const { gateway, calls } = fakeGateway(async () => {
    controller.abort();
    return null;
  });
  const result = await createClassifier(gateway, 1234).classify(MODEL, CONTEXT, {
    signal: controller.signal,
  });
  assertComplete(result);
  assert.equal(result.stopReason, 'aborted');
  assert.deepEqual(result.answers, {});
  assert.equal(typeof result.errorMessage, 'string');
  assert.equal(calls[0]?.options.signal, controller.signal);
  assert.equal(calls[0]?.options.timeoutMs, 1234);
});

test('an already aborted signal never calls the gateway', async () => {
  const { gateway, calls } = fakeGateway(wire());
  const result = await createClassifier(gateway).classify(MODEL, CONTEXT, {
    signal: AbortSignal.abort(),
  });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(calls.length, 0);
});

test('gateway null gives an error result', async () => {
  const { gateway } = fakeGateway(null);
  assertError(await createClassifier(gateway).classify(MODEL, CONTEXT), /unavailable/);
});

test('a throwing gateway still resolves to an error result', async () => {
  const { gateway } = fakeGateway(async () => {
    throw new Error('boom');
  });
  const result = await createClassifier(gateway).classify(MODEL, CONTEXT);
  assertError(result, /classifier failed/);
});

test('registration shape', async () => {
  const registered: [string, PiProviderConfig][] = [];
  const pi = {
    registerProvider: (name: string, config: PiProviderConfig) => registered.push([name, config]),
  } as unknown as PiAPI;
  const { gateway, calls } = fakeGateway(wire());
  registerClassifier(pi, { gateway, url: 'http://127.0.0.1:8765' });
  assert.equal(calls.length, 0, 'registration does no network I/O');
  assert.equal(registered.length, 1);
  const [name, config] = registered[0] ?? ['', {}];
  assert.equal(name, 'local-decider');
  assert.equal(config.baseUrl, 'http://127.0.0.1:8765');
  assert.equal(config.apiKey, PLACEHOLDER_API_KEY);
  assert.equal(config.authHeader, false);
  assert.deepEqual(config.models, [
    {
      type: 'classifier',
      id: 'active',
      name: 'local-decider (active engine)',
      api: 'local-decider-systemone',
      input: ['text'],
      contextWindow: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
  assert.deepEqual(Object.keys(config.classifiers ?? {}), ['local-decider-systemone']);
  const result = await config.classifiers?.['local-decider-systemone']?.classify(MODEL, CONTEXT);
  assert.equal(result?.stopReason, 'stop');
  assert.equal(calls.length, 1);
});
