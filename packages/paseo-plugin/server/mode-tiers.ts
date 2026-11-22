/**
 * Routing never raises a permission mode. Paseo ranks every built-in mode (`colorTier` in
 * `@getpaseo/protocol/provider-manifest`); this vendors that table for the 0.15 and 0.16 built-in
 * providers so the daemon bundle needs no runtime import. `test/mode-tiers.test.ts` pins it to the
 * devDependency, so a Paseo bump that changes a mode fails CI.
 */
import { applyPreset, type PresetTarget } from '../shared/presets.ts';

/** planning < safe < moderate < dangerous. */
const TIER = { planning: 0, safe: 1, moderate: 2, dangerous: 3 } as const;

export type ModeTier = (typeof TIER)[keyof typeof TIER];

interface ProviderModes {
  /** The mode the provider runs when none is set; null when the provider decides itself. */
  readonly defaultModeId: string | null;
  readonly modes: Readonly<Record<string, ModeTier>>;
}

const COPILOT = 'https://agentclientprotocol.com/protocol/session-modes#';

export const PROVIDER_MODES: Readonly<Record<string, ProviderModes>> = {
  claude: {
    defaultModeId: 'auto',
    modes: {
      plan: TIER.planning,
      default: TIER.safe,
      acceptEdits: TIER.moderate,
      auto: TIER.moderate,
      bypassPermissions: TIER.dangerous,
    },
  },
  codex: {
    defaultModeId: 'auto-review',
    modes: { 'auto': TIER.moderate, 'auto-review': TIER.moderate, 'full-access': TIER.dangerous },
  },
  copilot: {
    defaultModeId: `${COPILOT}agent`,
    modes: {
      [`${COPILOT}agent`]: TIER.moderate,
      [`${COPILOT}plan`]: TIER.planning,
      'allow-all': TIER.dangerous,
    },
  },
  opencode: { defaultModeId: null, modes: { build: TIER.moderate, plan: TIER.planning } },
  pi: { defaultModeId: null, modes: {} },
  omp: {
    defaultModeId: 'full',
    modes: { full: TIER.dangerous, write: TIER.moderate, ask: TIER.safe },
  },
};

/** The tier of `modeId`, or of the provider's default when unset; null when unknown. */
export function effectiveTier(provider: string, modeId: string | undefined): ModeTier | null {
  const entry = Object.hasOwn(PROVIDER_MODES, provider) ? PROVIDER_MODES[provider] : undefined;
  if (entry === undefined) {
    return null;
  }
  const mode = (modeId ?? '').trim() === '' ? entry.defaultModeId : (modeId ?? '').trim();
  if (mode === null || !Object.hasOwn(entry.modes, mode)) {
    return null;
  }
  return entry.modes[mode] ?? null;
}

interface ModeConfig {
  readonly provider: string;
  readonly model?: string;
  readonly modeId?: string;
  readonly thinkingOptionId?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly featureValues?: Record<string, unknown>;
}

export type ModeGuard =
  | { readonly kind: 'keep'; readonly target: PresetTarget }
  /** The target's mode was dropped; the agent keeps its own. */
  | { readonly kind: 'dropped'; readonly target: PresetTarget; readonly modeId: string }
  | { readonly kind: 'skip' };

/**
 * Compare the permission tier of the creator's config with the one the target would give. No
 * raise: keep. A raise on the same provider drops the target's mode; on another provider the
 * route is skipped (the new provider's default mode would apply). An unknown tier allows only a
 * model or thinking change on the same provider.
 */
export function guardMode(config: ModeConfig, target: PresetTarget): ModeGuard {
  const same = config.provider === target.provider;
  if (same && target.modeId === '') {
    return { kind: 'keep', target };
  }
  const before = effectiveTier(config.provider, config.modeId);
  const next = applyPreset(config, target);
  const after = effectiveTier(next.provider, next.modeId);
  if (before !== null && after !== null && after <= before) {
    return { kind: 'keep', target };
  }
  return same
    ? { kind: 'dropped', target: { ...target, modeId: '' }, modeId: target.modeId }
    : { kind: 'skip' };
}
