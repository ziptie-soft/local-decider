/** The settings document, kept free of Paseo imports so tests can load it. */
import { z } from 'zod';

import {
  DEFAULT_GATEWAY_URL,
  PLUGIN_MODES,
  ROW_VISIBILITY,
  SIDEBAR_LABELS,
  SIDEBAR_POSITIONS,
  SIDEBAR_PRESS,
} from './constants.ts';

const mode = z.enum(PLUGIN_MODES).default('shadow');

/** A routing preset name, as in a policy's `route:<preset>` action. */
const presetName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);

/** `provider/model` from `providers.listModels()`, or '' for "not mapped". */
const preset = z
  .object({
    model: z.string().max(300).default(''),
    modeId: z.string().max(200).default(''),
  })
  .prefault({});

const sidebar = z
  .object({
    position: z.enum(SIDEBAR_POSITIONS).default('footer'),
    label: z.enum(SIDEBAR_LABELS).default('full'),
    press: z.enum(SIDEBAR_PRESS).default('popover'),
  })
  .prefault({});

const rows = z
  .object({
    show: z.enum(ROW_VISIBILITY).default('all'),
    /** Second line with model, latency and notes. */
    details: z.boolean().default(true),
    /** "Was this right?" buttons that report the true answer to the gateway. */
    feedback: z.boolean().default(true),
  })
  .prefault({});

export const settingsSchema = z.object({
  gatewayUrl: z.string().max(500).default(DEFAULT_GATEWAY_URL),
  modes: z.object({ 'turn-outcome': mode, 'permission': mode, 'routing': mode }).prefault({}),
  /**
   * Preset name → target. Names come from the routing policy the gateway runs (any variant, the
   * user's own included), so this is open-ended; v3's fixed fast/standard/deep keys still parse.
   */
  presets: z
    .record(presetName, preset)
    .refine((p) => Object.keys(p).length <= 64, { message: 'at most 64 presets' })
    .default({}),
  /**
   * Give Paseo agents `decide`, `explain` and `policies` as plugin tools, served through Paseo's
   * own `paseo` MCP server. Off by default: three tool descriptions cost context in every agent.
   */
  agentTools: z.boolean().default(false),
  /** Ask the gateway to load its model when Paseo (and so this plugin) starts. */
  preloadOnStart: z.boolean().default(false),
  sidebar,
  rows,
});

/**
 * v1 stored an engine preference; v2 a model, device and "keep after restarts" switch. The
 * gateway now owns and persists the engine and model choice, so v3 drops all four.
 */
export function migrateSettings(values: unknown): unknown {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return {};
  }
  const {
    engine: _engine,
    model: _model,
    device: _device,
    keepModel: _keepModel,
    ...rest
  } = values as Record<string, unknown>;
  return rest;
}

/**
 * v4 retired the injected gateway MCP server for the agent tools: `injectMcp: true` becomes
 * `agentTools: true` (an explicit `agentTools` wins), and `injectMcp` is dropped.
 */
function migrateInjectMcp(values: unknown): unknown {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return values;
  }
  const { injectMcp, ...rest } = values as Record<string, unknown>;
  return injectMcp === true && !('agentTools' in rest) ? { ...rest, agentTools: true } : rest;
}

export const SETTINGS_VERSION = 4;

/** `defineSettings` migrate hook: v3 drops the engine-choice fields, v4 swaps `injectMcp`. */
export function migrateStored(values: unknown, fromVersion: number): unknown {
  const v3 = fromVersion < 3 ? migrateSettings(values) : values;
  return fromVersion < 4 ? migrateInjectMcp(v3) : v3;
}

export type DeciderSettings = z.output<typeof settingsSchema>;
