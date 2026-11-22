import type { DecideRequest, FactGroup } from '@ziptie-soft/local-decider-core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Decider } from '../src/decider.ts';
import { DEFAULT_MODEL } from '../src/engines/strands/index.ts';
import type { Engine } from '../src/engines/types.ts';
import {
  parseEvalCases,
  runPolicyEval,
  type EvalFloors,
  type EvalResult,
  type PolicyEvalCase,
} from '../src/eval.ts';
import type { LogStore } from '../src/log-store.ts';
import { loadPolicyFile, type LoadedPolicy } from '../src/policies.ts';

const POLICIES_DIR = fileURLToPath(new URL('../../../policies/', import.meta.url));
export const FIXTURES_DIR = join(POLICIES_DIR, 'fixtures');
export const RECORDED_DIR = join(FIXTURES_DIR, 'recorded');

/** The engine and model whose answers the CI gate replays. */
export const EVAL_REFERENCE = {
  engine: 'strands-decider',
  model: DEFAULT_MODEL,
  device: 'cpu',
} as const;

const DEFAULT_MIN_PASS = 0.8;
const EVAL_TIMEOUT_MS = 120_000;

/** An engine may name the model by repo id or by its checkpoint's last path segment. */
export function isReferenceModel(model: string): boolean {
  return lastSegment(model) === lastSegment(EVAL_REFERENCE.model);
}

function lastSegment(name: string): string {
  return name.split('/').pop() ?? name;
}

/** A log that keeps nothing, so a run has no precedent and writes no shadow log. */
const NO_LOG: LogStore = {
  append: () => undefined,
  flush: () => undefined,
  findDecision: () => undefined,
  read: () => [],
  readRecent: () => [],
  iterateRecent: () => [],
  readVerifiedPrecedent: () => [],
  prune: async () => 0,
  close: () => undefined,
};

/** One policy in shadow mode with caching off, answered by `engine`. */
function deciderFor(
  policyId: string,
  engine: Engine,
  facts: readonly FactGroup[] | undefined,
): Decider {
  const policy = loadPolicyFile(join(POLICIES_DIR, `${policyId}.yaml`));
  const loaded: LoadedPolicy = {
    policy: { ...policy, cache: { ttlSeconds: 0 } },
    mode: 'shadow',
    source: policyId,
  };
  return new Decider({
    engine,
    policies: new Map([[policyId, loaded]]),
    log: NO_LOG,
    decisionTimeoutMs: EVAL_TIMEOUT_MS,
    ...(facts === undefined ? {} : { facts }),
  });
}

function readFixtureCases(policyId: string): PolicyEvalCase[] {
  const file = join(FIXTURES_DIR, `${policyId}.jsonl`);
  return parseEvalCases(readFileSync(file, 'utf8'), `${policyId}.jsonl`);
}

export interface EvalFixtureOptions {
  readonly report?: (line: string) => void;
  /** Called with the case id before its decision, e.g. to label a recording. */
  readonly onCase?: (id: string) => void;
  /** Fact groups the decider derives for policies with a `facts` section; default the shipped set. */
  readonly facts?: readonly FactGroup[];
}

/** Decide every case of `policies/fixtures/<policyId>.jsonl` through `engine`. */
export async function evalFixture(
  policyId: string,
  engine: Engine,
  options: EvalFixtureOptions = {},
): Promise<EvalResult[]> {
  const cases = readFixtureCases(policyId);
  const ids = new Map<DecideRequest['input'], string>(
    cases.map((testCase, index) => [testCase.input, testCase.id ?? String(index + 1)]),
  );
  const decider = deciderFor(policyId, engine, options.facts);
  return runPolicyEval(
    policyId,
    cases,
    (id, request) => {
      options.onCase?.(ids.get(request.input) ?? '');
      return decider.decide(id, request, new AbortController().signal);
    },
    options.report ?? (() => undefined),
  );
}

/** Floors from `policies/fixtures/gate.json`: `{ "<policy>": { "<class>": 0.8 } }`; default 0.8. */
export function floorsFor(policyId: string): EvalFloors {
  const file = join(FIXTURES_DIR, 'gate.json');
  const all: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const mine = (all as Record<string, Record<string, number> | undefined>)[policyId] ?? {};
  return { minPass: (cls) => mine[cls] ?? DEFAULT_MIN_PASS };
}
