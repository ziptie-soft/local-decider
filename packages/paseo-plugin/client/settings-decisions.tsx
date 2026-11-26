/**
 * Settings, Decisions: one card per decision kind with its mode. Hook kinds keep a Paseo mode and
 * set the gateway too; command risk only has the gateway's mode.
 */
import { useRpc } from '@getpaseo/plugin/client';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import {
  GATEWAY_POLICIES,
  HOOK_POLICIES,
  PLUGIN_MODES,
  type GatewayPolicy,
  type PluginMode,
} from '../shared/constants.ts';
import { DECISION_KINDS } from '../shared/decision-kinds.ts';
import { modeOutcome, modeRowHint, type ModeWriteResult } from '../shared/policies.ts';
import { policyModeRpc } from '../shared/rpc.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { useAction, useGatewayStatus, type Outcome } from './hooks.ts';
import { useGatewayModesState, type GatewayModes } from './policy-modes.ts';
import { choices, type Save, type SectionProps } from './settings-common.ts';
import { InlineMessage, Mono, type Theme } from './ui.tsx';

const MODE_OPTIONS = choices(PLUGIN_MODES, {
  off: 'Off',
  shadow: 'Shadow (record only)',
  act: 'Act',
});

type HookPolicy = (typeof HOOK_POLICIES)[number];

function hookPolicy(policy: GatewayPolicy): HookPolicy | null {
  return HOOK_POLICIES.find((id) => id === policy) ?? null;
}

interface Writes {
  /** The policy whose write is in flight, or null. */
  readonly busy: GatewayPolicy | null;
  /** The mode the select of the writing card shows until the refetch lands. */
  readonly pending: PluginMode | null;
  /** The outcome of the last write and the card it belongs under. */
  readonly last: { readonly policy: GatewayPolicy; readonly outcome: Outcome } | null;
  readonly write: (policy: GatewayPolicy, mode: PluginMode) => void;
}

interface CardProps {
  readonly theme: Theme;
  readonly policy: GatewayPolicy;
  readonly values: DeciderSettings;
  readonly writes: Writes;
  readonly gatewayMode: PluginMode | undefined;
  readonly modesLoaded: boolean;
  readonly reachable: boolean;
}

/** The mode a card shows: the saved Paseo mode, or the gateway's for command risk. */
function currentMode(policy: GatewayPolicy, props: CardProps): PluginMode {
  const hook = hookPolicy(policy);
  return hook === null ? (props.gatewayMode ?? 'off') : props.values.modes[hook];
}

/**
 * One write at a time for the whole section: saves the Paseo mode of a hook kind, then asks the
 * gateway to follow. While any card writes, every Mode select is disabled.
 *
 * Limitation: `save` writes the whole document against the revision on screen and takes no
 * updater, so `values` is the last render's. With one section-wide action a save waits for the
 * previous write and its invalidation to finish, so two cards cannot overwrite each other's key.
 */
function useModeWrites(values: DeciderSettings, save: Save): Writes {
  const setGatewayMode = useRpc(policyModeRpc);
  const action = useAction();
  const [pending, setPending] = useState<PluginMode | null>(null);
  const [owner, setOwner] = useState<GatewayPolicy | null>(null);
  const write = (policy: GatewayPolicy, mode: PluginMode): void => {
    if (action.busy !== null) {
      return;
    }
    setOwner(policy);
    setPending(mode);
    void action
      .run(policy, async () => {
        const hook = hookPolicy(policy);
        if (hook !== null) {
          save({ ...values, modes: { ...values.modes, [hook]: mode } });
        }
        let res: ModeWriteResult;
        try {
          res = await setGatewayMode({ policy, mode });
        } catch {
          res = { ok: false, unreachable: true };
        }
        return modeOutcome(policy, mode, res);
      })
      .finally(() => setPending(null));
  };
  const busy = GATEWAY_POLICIES.find((policy) => policy === action.busy) ?? null;
  const last =
    owner === null || action.outcome === null ? null : { policy: owner, outcome: action.outcome };
  return { busy, pending, last, write };
}

function DecisionCard(props: CardProps): ReactNode {
  const { theme, policy, writes } = props;
  const info = DECISION_KINDS[policy];
  const mine = writes.busy === policy;
  const mode = currentMode(policy, props);
  const row = modeRowHint(policy, {
    pluginMode: mode,
    gatewayMode: props.gatewayMode,
    modesLoaded: props.modesLoaded,
    reachable: props.reachable,
    busy: mine,
  });
  const outcome = writes.last?.policy === policy ? writes.last.outcome : null;
  return (
    <View accessible={false} role="group" aria-label={info.title}>
      <SettingsCard>
        <SettingsRow label={info.title} hint={`${info.decides} ${info.askedBy}`}>
          <Mono theme={theme}>{policy}</Mono>
        </SettingsRow>
        <SettingsSelect
          label="Mode"
          hint={row.hint}
          disabled={row.disabled || writes.busy !== null}
          value={mine ? (writes.pending ?? mode) : mode}
          options={MODE_OPTIONS}
          onValueChange={(next) => writes.write(policy, next)}
        />
        {outcome === null ? null : (
          <InlineMessage theme={theme} tone={outcome.tone} text={outcome.text} />
        )}
      </SettingsCard>
    </View>
  );
}

function cardsFor(
  theme: Theme,
  values: DeciderSettings,
  writes: Writes,
  modes: GatewayModes,
  modesLoaded: boolean,
  reachable: boolean,
): ReactNode[] {
  return GATEWAY_POLICIES.map((policy) => (
    <DecisionCard
      key={policy}
      theme={theme}
      policy={policy}
      values={values}
      writes={writes}
      gatewayMode={modes[policy]}
      modesLoaded={modesLoaded}
      reachable={reachable}
    />
  ));
}

export function DecisionsSection({
  theme,
  values,
  save,
}: SectionProps & { theme: Theme }): ReactNode {
  const { modes, loaded } = useGatewayModesState();
  const writes = useModeWrites(values, save);
  const status = useGatewayStatus();
  const reachable = status.data?.up !== false;
  return (
    <SettingsSection
      title="Decisions"
      info="Each decision local-decider makes, who asks for it and whether it acts. Shadow records what would have happened; Act lets it change what the agent does. Paseo's settings here also set the gateway, so Claude Code, Codex and pi outside Paseo follow them. A skipped decision changes nothing: the agent carries on as if it were Off. How sure the model must be is under Decision thresholds."
    >
      {reachable ? null : (
        <SettingsCard>
          <InlineMessage
            theme={theme}
            tone="warning"
            text="The gateway is unreachable, so every decision is skipped until it is back."
          />
        </SettingsCard>
      )}
      {cardsFor(theme, values, writes, modes, loaded, reachable)}
    </SettingsSection>
  );
}
