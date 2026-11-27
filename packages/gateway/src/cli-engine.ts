import { parseArgs } from 'node:util';

import { asRecord, displayText } from './cli-support.ts';
import { DEFAULT_MODEL, type GatewayConfig } from './config.ts';
import { isOpenAILike } from './engine-discovery.ts';
import type { FlavorChoice } from './engine-flavor.ts';
import { autoTarget, type AutoInstall, type AutoTarget } from './engine-install-auto.ts';
import { defaultFlavor, type InstallFlavor } from './engine-install.ts';
import type { HostInfo } from './engines/descriptor.ts';
import { engineDescriptor } from './engines/registry.ts';

const FLAVORS: readonly InstallFlavor[] = ['cpu', 'mlx', 'cuda', 'rocm'];
const FLM_HOST_REFUSAL =
  'fastflowlm runs on Linux x86_64 with an AMD XDNA2 NPU; on macOS use strands-decider (MLX) or openai-compatible';
const LLAMA_HOST_REFUSAL =
  'llama-vulkan runs on Linux x86_64 with a Vulkan GPU; on macOS use strands-decider (MLX)';
const HOST_REFUSAL: Readonly<Record<string, string>> = {
  'fastflowlm': FLM_HOST_REFUSAL,
  'llama-vulkan': LLAMA_HOST_REFUSAL,
};

export class EngineInstallUsageError extends Error {
  override readonly name = 'EngineInstallUsageError';
  readonly exitCode = 2;
}

type UnknownRecord = Record<string, unknown>;

function engineLine(engine: UnknownRecord, activeId: string | undefined): string | undefined {
  const id = displayText(engine['id']);
  if (id === '') {
    return undefined;
  }
  const supported =
    typeof engine['supported'] === 'boolean'
      ? `supported: ${engine['supported'] ? 'yes' : 'no'}`
      : 'supported: unknown';
  const reason = engine['supported'] === false ? displayText(engine['unsupportedReason']) : '';
  const label = displayText(engine['label'], id);
  const detail = displayText(engine['detail']);
  const description = detail === '' ? label : `${label} — ${detail}`;
  return [
    id,
    supported,
    ...(activeId === id ? ['active'] : []),
    ...(reason === '' ? [] : [reason]),
    description,
  ].join(' | ');
}

function modelLines(models: readonly unknown[], engineId: string): string[] {
  return models.flatMap((model) => {
    const row = asRecord(model);
    if (row === undefined || row['engine'] !== engineId || typeof row['id'] !== 'string') {
      return [];
    }
    const installed =
      typeof row['installed'] === 'boolean'
        ? ` (${row['installed'] ? 'installed' : 'not installed'})`
        : '';
    return [`  ${row['id']}${installed}`];
  });
}

const ENGINE_STATE_TEXT: Readonly<Record<string, string>> = {
  ready: 'ready',
  starting: 'loading',
  stopped: 'loads on the first decision',
  failed: 'failed',
};

interface ModelRef {
  readonly engine: string;
  readonly model: string;
}

function ownModel(policy: UnknownRecord): ModelRef {
  const selection = asRecord(policy['selection']);
  return {
    engine: displayText(selection?.['engine'], displayText(policy['engine'], 'unknown')),
    model: displayText(selection?.['model'], displayText(policy['model'], 'unknown')),
  };
}

const modelText = (ref: ModelRef): string => `${ref.engine} ${ref.model}`;

/** An active decision: its lane state, or a note that it is the very model the default uses. */
function activeLine(id: string, policy: UnknownRecord, primary: ModelRef | undefined): string {
  const own = ownModel(policy);
  if (primary?.engine === own.engine && primary.model === own.model) {
    return `  ${id}: ${modelText(own)} (same as the default model)`;
  }
  const state = ENGINE_STATE_TEXT[displayText(policy['state'])];
  return `  ${id}: ${modelText(own)} (own model${state === undefined ? '' : `, ${state}`})`;
}

function policyLine(policy: UnknownRecord, primary: ModelRef | undefined): string | undefined {
  const id = displayText(policy['id']);
  if (id === '') {
    return undefined;
  }
  const status = policy['status'];
  const reason = displayText(policy['reason'], 'not available');
  if (status === 'unavailable') {
    const instead = policy['fallback'] === 'open' ? 'skipped' : 'default model';
    return `  ${id}: unavailable: ${reason} → ${instead}`;
  }
  if (status === 'off') {
    return `  ${id}: ${modelText(ownModel(policy))} (off, not loaded)`;
  }
  if (status === 'active') {
    return activeLine(id, policy, primary);
  }
  return `  ${id}: default model`;
}

/**
 * The "Decisions:" block: the policies that have a model of their own. A policy that is not in
 * `policies` uses the default model; a gateway that sends no `policies` has no per-policy info.
 */
function policyLines(policies: unknown, primary: ModelRef | undefined): string[] {
  if (!Array.isArray(policies)) {
    return [];
  }
  const lines = policies.flatMap((item) => {
    const policy = asRecord(item);
    const line = policy === undefined ? undefined : policyLine(policy, primary);
    return line === undefined ? [] : [line];
  });
  return lines.length === 0 ? ['Decisions: all use the default model'] : ['Decisions:', ...lines];
}

function primaryModel(active: UnknownRecord | undefined): ModelRef | undefined {
  const engine = displayText(active?.['engine']);
  const model = displayText(active?.['model']);
  return engine === '' || model === '' ? undefined : { engine, model };
}

/** Lenient plain-text view of a gateway engine catalog. */
export function formatEngineList(payload: unknown): string {
  const root = asRecord(payload);
  if (root === undefined || !Array.isArray(root['engines'])) {
    return 'gateway returned an invalid engine list';
  }
  const active = asRecord(root['active']);
  const activeId = typeof active?.['engine'] === 'string' ? active['engine'] : undefined;
  const primary = primaryModel(active);
  const models = Array.isArray(root['models']) ? root['models'] : [];
  const lines = root['engines'].flatMap((item) => {
    const engine = asRecord(item);
    if (engine === undefined) {
      return [];
    }
    const line = engineLine(engine, activeId);
    return line === undefined ? [] : [line, ...modelLines(models, String(engine['id']))];
  });
  return lines.length === 0
    ? 'no engines available'
    : [...lines, ...policyLines(root['policies'], primary)].join('\n');
}

export type InstallPlan =
  | {
      readonly engine: 'strands-decider';
      readonly flavor: InstallFlavor;
      readonly model?: string;
      /** One line explaining an automatic choice; absent for explicit ones. */
      readonly reason?: string;
    }
  | {
      readonly engine: 'fastflowlm';
      readonly model?: string;
      readonly noDownload: boolean;
      readonly reason?: string;
    }
  | {
      readonly engine: 'llama-vulkan';
      readonly model?: string;
      readonly noDownload: boolean;
      readonly reason?: string;
    };

function refusal(engine: string): never {
  if (engine === 'lmstudio') {
    throw new EngineInstallUsageError(
      'nothing to install for lmstudio: get LM Studio from https://lmstudio.ai/download, start its server (lms server start) and load a model',
    );
  }
  if (isOpenAILike(engine)) {
    throw new EngineInstallUsageError(
      `nothing to install for ${engine}: start your server and set engines.${engine}.url`,
    );
  }
  throw new EngineInstallUsageError(`nothing to install for ${engine}`);
}

interface InstallArgs {
  readonly 'engine'?: string;
  readonly 'flavor'?: string;
  readonly 'model'?: string;
  readonly 'no-download'?: boolean;
}

function parseInstallArgs(argv: readonly string[]): InstallArgs {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        'engine': { type: 'string' },
        'flavor': { type: 'string' },
        'model': { type: 'string' },
        'no-download': { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    throw new EngineInstallUsageError(error instanceof Error ? error.message : String(error));
  }
}

function supportedTarget(
  engine: string,
  host: HostInfo,
): 'strands-decider' | 'fastflowlm' | 'llama-vulkan' {
  if (engine !== 'strands-decider' && engine !== 'fastflowlm' && engine !== 'llama-vulkan') {
    return refusal(engine);
  }
  const descriptor = engineDescriptor(engine);
  if (descriptor === undefined) {
    return refusal(engine);
  }
  const support = descriptor.supports(host);
  const hostRefusal = HOST_REFUSAL[engine];
  if (hostRefusal !== undefined && (!support.ok || host.arch !== 'x64')) {
    throw new EngineInstallUsageError(hostRefusal);
  }
  if (!support.ok) {
    throw new EngineInstallUsageError(`${engine} is not supported: ${support.reason}`);
  }
  return engine;
}

function strandsPlan(
  values: InstallArgs,
  host: HostInfo,
  model: string | undefined,
  auto?: AutoTarget,
  hardware?: FlavorChoice,
): InstallPlan {
  if (values.flavor !== undefined && !FLAVORS.includes(values.flavor as InstallFlavor)) {
    throw new EngineInstallUsageError(`invalid strands-decider flavor "${values.flavor}"`);
  }
  // `--flavor` is authoritative; otherwise the ranked pick, then the hardware probe, then the host default.
  const flavor =
    (values.flavor as InstallFlavor | undefined) ??
    auto?.flavor ??
    hardware?.flavor ??
    defaultFlavor(host.platform, host.arch);
  const reason = auto?.reason ?? (values.flavor === undefined ? hardware?.reason : undefined);
  return {
    engine: 'strands-decider',
    flavor,
    ...(values['no-download'] === true || model === undefined ? {} : { model }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Whether this install is a strands-decider one with no `--flavor`, so the flavor comes from a
 * hardware probe. Parse errors are left for `planInstall` to report.
 */
export function wantsFlavorProbe(argv: readonly string[], configuredEngine: string): boolean {
  try {
    const values = parseInstallArgs(argv);
    return values.flavor === undefined && (values.engine ?? configuredEngine) === 'strands-decider';
  } catch {
    return false;
  }
}

function binaryPlan(
  engine: 'fastflowlm' | 'llama-vulkan',
  values: InstallArgs,
  model: string | undefined,
  auto?: AutoTarget,
): InstallPlan {
  if (values.flavor !== undefined) {
    throw new EngineInstallUsageError('--flavor is only valid for strands-decider');
  }

  return {
    engine,
    ...(model === undefined ? {} : { model }),
    noDownload: values['no-download'] === true,
    ...(auto === undefined ? {} : { reason: auto.reason }),
  };
}

function resolveAuto(
  auto: AutoInstall | undefined,
  host: HostInfo,
  flagged: string | undefined,
): AutoTarget | undefined {
  if (auto === undefined) {
    return undefined;
  }
  const target = autoTarget(auto, host, flagged);
  if (typeof target === 'string') {
    throw new EngineInstallUsageError(target);
  }
  return target;
}

/**
 * Parse an install request and reject unsupported targets before installer I/O starts.
 * Precedence: CLI flags, then explicit config, then `auto` (the ranked recommendation), which
 * callers pass only when the config is not explicit. `hardware` (the flavor probed from the host)
 * only fills in a strands-decider flavor that neither `--flavor` nor `auto` chose.
 */
export function planInstall(
  argv: readonly string[],
  host: HostInfo,
  configuredEngine: string,
  configuredModel?: string,
  auto?: AutoInstall,
  hardware?: FlavorChoice,
): InstallPlan {
  const values = parseInstallArgs(argv);
  const picked = resolveAuto(auto, host, values.engine);
  const engine = supportedTarget(values.engine ?? picked?.engine ?? configuredEngine, host);
  const fromConfig =
    auto === undefined && engine === configuredEngine ? configuredModel : undefined;
  const model = values.model ?? fromConfig ?? picked?.model;
  return engine === 'strands-decider'
    ? strandsPlan(values, host, model, picked, hardware)
    : binaryPlan(engine, values, model, picked);
}

/**
 * True when the user chose an engine or model themselves (a `selection`, or `engine` settings
 * that differ from the defaults), so install follows it instead of the automatic ranking.
 */
export function configIsExplicit(config: GatewayConfig): boolean {
  return (
    (config.selection !== undefined && config.selection.mode !== 'auto') ||
    config.engine.type !== 'strands-decider' ||
    config.engine.model !== DEFAULT_MODEL
  );
}
