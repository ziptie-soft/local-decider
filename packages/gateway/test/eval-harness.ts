import type { DecideRequest, FactGroup, Policy } from '@ziptie-soft/local-decider-core';
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

export type FactsPosition = 'before' | 'after';

/**
 * The A/B variant: a policy that does not read `facts` gets a `Call facts` section when groups are
 * selected, before its last section (the request, which keeps first claim on the budget) or after
 * it. Shipped YAMLs are not touched, so a run without groups is the shipped policy.
 */
function withFactsSection(
  policy: Policy,
  facts: readonly FactGroup[] | undefined,
  position: FactsPosition,
): Policy {
  const sections = policy.state.sections;
  if (facts === undefined || facts.length === 0 || sections.some((s) => s.from === 'facts')) {
    return policy;
  }
  const section = { label: 'Call facts', from: 'facts', keep: 'head' as const, critical: false };
  const last = sections.length - 1;
  const placed =
    position === 'after'
      ? [...sections, section]
      : [...sections.slice(0, last), section, ...sections.slice(last)];
  return { ...policy, state: { ...policy.state, sections: placed } };
}

/** One policy in shadow mode with caching off, answered by `engine`. */
function deciderFor(
  policyId: string,
  engine: Engine,
  facts: readonly FactGroup[] | undefined,
  position: FactsPosition,
): Decider {
  const policy = loadPolicyFile(join(POLICIES_DIR, `${policyId}.yaml`));
  const loaded: LoadedPolicy = {
    policy: { ...withFactsSection(policy, facts, position), cache: { ttlSeconds: 0 } },
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

function readFixtureCases(policyId: string, dir: string): PolicyEvalCase[] {
  const file = join(dir, `${policyId}.jsonl`);
  return parseEvalCases(readFileSync(file, 'utf8'), `${policyId}.jsonl`);
}

export interface EvalFixtureOptions {
  readonly report?: (line: string) => void;
  /** Called with the case id before its decision, e.g. to label a recording. */
  readonly onCase?: (id: string) => void;
  /** Fact groups the decider derives for policies with a `facts` section; default the shipped set. */
  readonly facts?: readonly FactGroup[];
  /** Where an A/B facts section goes relative to the request; default before. */
  readonly factsPosition?: FactsPosition;
  /** Directory of `<policy>.jsonl` fixtures; default `policies/fixtures`. */
  readonly fixturesDir?: string;
}

/** Decide every case of `policies/fixtures/<policyId>.jsonl` through `engine`. */
export async function evalFixture(
  policyId: string,
  engine: Engine,
  options: EvalFixtureOptions = {},
): Promise<EvalResult[]> {
  const cases = readFixtureCases(policyId, options.fixturesDir ?? FIXTURES_DIR);
  const ids = new Map<DecideRequest['input'], string>(
    cases.map((testCase, index) => [testCase.input, testCase.id ?? String(index + 1)]),
  );
  const decider = deciderFor(policyId, engine, options.facts, options.factsPosition ?? 'before');
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
