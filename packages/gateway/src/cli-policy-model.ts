import type { GatewayClient } from '@ziptie-soft/local-decider-core';
import { parseArgs } from 'node:util';

import { asRecord, displayText, UsageError } from './cli-support.ts';

type GatewayRequestResult = NonNullable<Awaited<ReturnType<GatewayClient['clearPolicySelection']>>>;

/** What a decision does when its own model cannot answer; the values of the config schema. */
const FALLBACKS = ['default', 'open'] as const;
type Fallback = (typeof FALLBACKS)[number];

/** The pseudo-engine that puts a decision back on the default model. */
const DEFAULT_ENGINE = 'default';

interface PolicyFlags {
  readonly policy?: string;
  readonly fallback?: Fallback;
  readonly device?: string;
  readonly positionals: readonly string[];
}

/**
 * Split `engine use` arguments into `--policy`, `--fallback` and `--device` and the positionals.
 * A `--fallback` without `--policy`, or a value the config schema does not know, is a usage error
 * (exit 2).
 */
export function parsePolicyFlags(args: readonly string[]): PolicyFlags {
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(args);
  } catch {
    throw new UsageError();
  }
  for (const name of ['policy', 'fallback']) {
    requireOnceWithValue(parsed.tokens, name);
  }
  const { policy, fallback, device } = parsed.values;
  if (fallback !== undefined && !FALLBACKS.includes(fallback as Fallback)) {
    throw new UsageError(`--fallback must be ${FALLBACKS.join(' or ')}, not "${fallback}"`);
  }
  if (fallback !== undefined && policy === undefined) {
    throw new UsageError('--fallback needs --policy <id>');
  }
  return {
    positionals: parsed.positionals,
    ...(policy === undefined ? {} : { policy }),
    ...(fallback === undefined ? {} : { fallback: fallback as Fallback }),
    ...(device === undefined ? {} : { device }),
  };
}

interface FlagToken {
  readonly kind: string;
  readonly name?: string;
  readonly value?: string | undefined;
}

interface ParsedFlags {
  readonly values: {
    readonly policy?: string;
    readonly fallback?: string;
    readonly device?: string;
  };
  readonly positionals: readonly string[];
  readonly tokens: readonly FlagToken[];
}

function parseFlags(args: readonly string[]): ParsedFlags {
  return parseArgs({
    args: [...args],
    options: {
      policy: { type: 'string' },
      fallback: { type: 'string' },
      device: { type: 'string' },
    },
    allowPositionals: true,
    tokens: true,
  });
}

/** A flag that is given at all is given once, with a value. */
function requireOnceWithValue(tokens: ParsedFlags['tokens'], name: string): void {
  const given = tokens.filter((token) => token.kind === 'option' && token.name === name);
  if (given.length > 1) {
    throw new UsageError(`--${name} was given more than once`);
  }
  const [only] = given;
  if (only?.kind === 'option' && only.value === '') {
    throw new UsageError(`--${name} needs a value`);
  }
}

/** A parsed `engine use`: the default model, or one decision's own model, or put it back. */
export type UseCommand =
  | {
      readonly kind: 'engine';
      readonly engine: string;
      readonly model: string;
      readonly device?: string;
    }
  | {
      readonly kind: 'policy';
      readonly policy: string;
      readonly engine: string;
      readonly model: string;
      readonly device?: string;
      readonly fallback?: Fallback;
    }
  | { readonly kind: 'clear'; readonly policy: string };

function clearCommand(flags: PolicyFlags): UseCommand {
  const { policy } = flags;
  if (policy === undefined) {
    throw new UsageError('"default" is only for --policy <id>');
  }
  if (flags.device !== undefined || flags.fallback !== undefined) {
    throw new UsageError('--device and --fallback do not apply to the default model');
  }
  return { kind: 'clear', policy };
}

/** `engine use <engine> <model> [--device D] [--policy ID [--fallback F]]`, or `default --policy ID`. */
export function parseUseCommand(args: readonly string[]): UseCommand {
  const flags = parsePolicyFlags(args);
  const [engine, ...rest] = flags.positionals;
  if (engine === DEFAULT_ENGINE) {
    if (rest.length > 0) {
      throw new UsageError();
    }
    return clearCommand(flags);
  }
  const [model, ...extra] = rest;
  if (engine === undefined || model === undefined || extra.length > 0) {
    throw new UsageError();
  }
  const device = flags.device === undefined ? {} : { device: flags.device };
  if (flags.policy === undefined) {
    return { kind: 'engine', engine, model, ...device };
  }
  return {
    kind: 'policy',
    policy: flags.policy,
    engine,
    model,
    ...device,
    ...(flags.fallback === undefined ? {} : { fallback: flags.fallback }),
  };
}

/** How a policy use ended: the line to print, and whether it worked. */
export interface PolicyUseOutcome {
  readonly ok: boolean;
  readonly message: string;
}

const record = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

function failure(result: GatewayRequestResult, refused: string): PolicyUseOutcome {
  if (result.status === 401) {
    return { ok: false, message: refused };
  }
  const error = record(result.body)['error'];
  return {
    ok: false,
    message: typeof error === 'string' ? error : JSON.stringify(record(result.body)),
  };
}

/** What the gateway says about the model a decision now has. */
function describeSelection(
  policy: string,
  command: Extract<UseCommand, { kind: 'policy' }>,
  body: Record<string, unknown>,
): string {
  const selection = record(body['selection']);
  const own = `${displayText(selection['engine'], command.engine)} ${displayText(selection['model'], command.model)}`;
  const status = body['status'];
  if (status === 'unavailable') {
    const reason = displayText(body['reason'], 'not available');
    const fallback = selection['fallback'] ?? command.fallback ?? 'default';
    return fallback === 'open'
      ? `${policy} wants ${own}, which is unavailable: ${reason}; its decisions are skipped.`
      : `${policy} wants ${own}, which is unavailable: ${reason}; the default model answers instead.`;
  }
  // The response does not say whether the model is also the default one or how it is loaded.
  return status === 'active'
    ? `${policy} now uses ${own} (loads when first needed).`
    : `${policy} now uses ${own}.`;
}

/** Run a `policy` or `clear` command against the gateway and say what happened. */
export async function runPolicyUse(
  client: Pick<GatewayClient, 'setPolicySelection' | 'clearPolicySelection'>,
  command: Exclude<UseCommand, { kind: 'engine' }>,
  gateway: { readonly url: string; readonly refused: string },
): Promise<PolicyUseOutcome> {
  const result =
    command.kind === 'clear'
      ? await client.clearPolicySelection(command.policy)
      : await client.setPolicySelection(command.policy, {
          engine: command.engine,
          model: command.model,
          ...(command.device === undefined ? {} : { device: command.device }),
          ...(command.fallback === undefined ? {} : { fallback: command.fallback }),
        });
  if (result === null) {
    return { ok: false, message: `gateway unreachable at ${gateway.url}` };
  }
  if (result.status < 200 || result.status >= 300) {
    return failure(result, gateway.refused);
  }
  // An accepted set whose model is unavailable still exits 0 on purpose: the choice is saved, and
  // the message says what answers meanwhile.
  return {
    ok: true,
    message:
      command.kind === 'clear'
        ? `${command.policy} now uses the default model.`
        : describeSelection(command.policy, command, record(result.body)),
  };
}
