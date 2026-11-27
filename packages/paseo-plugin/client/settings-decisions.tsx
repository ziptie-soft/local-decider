/**
 * Settings, Decisions: one card per decision kind with its mode. Hook kinds keep a Paseo mode and
 * set the gateway too; command risk only has the gateway's mode.
 */
import { openExternalUrl, useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
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
  MODELS_DOCS_URL,
  PLUGIN_MODES,
  type GatewayPolicy,
  type PluginMode,
} from '../shared/constants.ts';
import { DECISION_KINDS } from '../shared/decision-kinds.ts';
import { defaultModelView, type ModelOption } from '../shared/decision-models.ts';
import {
  holdState,
  HOLD_MAX_MS,
  modelSelectView,
  optionByValue,
  writeModel,
  type ModelSelectView,
} from '../shared/model-write.ts';
import { modeOutcome, modeRowHint, type ModeWriteResult } from '../shared/policies.ts';
import { policyModeRpc, policySelectionRpc } from '../shared/rpc.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { useAction, useEngines, useGatewayStatus, type Outcome } from './hooks.ts';
import { useGatewayModesState, type GatewayModes } from './policy-modes.ts';
import { choices, type Save, type SectionProps } from './settings-common.ts';
import { Badge, InlineMessage, Mono, type Theme, Value } from './ui.tsx';

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
  /** The card of the last write; with `held` it is the card whose choice is still shown. */
  readonly owner: GatewayPolicy | null;
  /** A write runs or its refetch has not landed (at most `HOLD_MAX_MS`): hold the choice. */
  readonly held: boolean;
  /** The mode the Mode select of the writing card shows until the refetch lands. */
  readonly pendingMode: PluginMode | null;
  /** The model the Model select of the writing card shows until the refetch lands. */
  readonly pendingModel: ModelOption | null;
  /** The outcome of the last write and the card it belongs under. */
  readonly last: { readonly policy: GatewayPolicy; readonly outcome: Outcome } | null;
  readonly write: (policy: GatewayPolicy, mode: PluginMode) => void;
  readonly writeModel: (policy: GatewayPolicy, option: ModelOption, now: ModelNow) => void;
}

/** What a model write needs to know about its card when it starts. */
interface ModelNow {
  readonly mode: PluginMode;
  readonly fallback: ModelSelectView['fallback'];
}

/** What the writing card shows until the refetch lands: the mode or the model being set. */
interface Pending {
  readonly mode: PluginMode | null;
  readonly model: ModelOption | null;
}

interface CardProps {
  readonly theme: Theme;
  readonly policy: GatewayPolicy;
  readonly values: DeciderSettings;
  readonly writes: Writes;
  readonly gatewayUrl: string;
  readonly gatewayMode: PluginMode | undefined;
  readonly modesLoaded: boolean;
  readonly reachable: boolean;
}

/** The mode a card shows: the saved Paseo mode, or the gateway's for command risk. */
function currentMode(policy: GatewayPolicy, props: CardProps): PluginMode {
  const hook = hookPolicy(policy);
  return hook === null ? (props.gatewayMode ?? 'off') : props.values.modes[hook];
}

/** Saves the Paseo mode of a hook kind, then asks the gateway to follow. */
async function modeTask(
  setGatewayMode: (input: { policy: GatewayPolicy; mode: PluginMode }) => Promise<ModeWriteResult>,
  save: () => void,
  policy: GatewayPolicy,
  mode: PluginMode,
): Promise<Outcome> {
  if (hookPolicy(policy) !== null) {
    save();
  }
  let res: ModeWriteResult;
  try {
    res = await setGatewayMode({ policy, mode });
  } catch {
    res = { ok: false, unreachable: true };
  }
  return modeOutcome(policy, mode, res);
}

/**
 * One write at a time for the whole section, a mode or a model: saves the Paseo mode of a hook
 * kind, then asks the gateway to follow, or asks it to switch the decision's model. While any card
 * writes, every Mode and Model select is disabled. The shared action refetches every query when a
 * write ends, so the rows show the gateway's state, not the choice.
 *
 * Limitation: `save` writes the whole document against the revision on screen and takes no
 * updater, so `values` is the last render's. With one section-wide action a save waits for the
 * previous write and its invalidation to finish, so two cards cannot overwrite each other's key.
 */
function useDecisionWrites(values: DeciderSettings, save: Save): Writes {
  const setGatewayMode = useRpc(policyModeRpc);
  const setSelection = useRpc(policySelectionRpc);
  const action = useAction();
  const [pending, setPending] = useState<Pending | null>(null);
  const [owner, setOwner] = useState<GatewayPolicy | null>(null);
  const start = (policy: GatewayPolicy, next: Pending, task: () => Promise<Outcome>): void => {
    if (action.busy !== null || pending !== null) {
      return;
    }
    setOwner(policy);
    setPending(next);
    // The refetch ends the hold; the timer bounds it, so a hung gateway cannot lock the selects.
    const timer = setTimeout(() => setPending(null), HOLD_MAX_MS);
    void action.run(policy, task).finally(() => {
      clearTimeout(timer);
      setPending(null);
    });
  };
  const write = (policy: GatewayPolicy, mode: PluginMode): void => {
    const saveMode = (): void => {
      const hook = hookPolicy(policy);
      if (hook !== null) {
        save({ ...values, modes: { ...values.modes, [hook]: mode } });
      }
    };
    start(policy, { mode, model: null }, () => modeTask(setGatewayMode, saveMode, policy, mode));
  };
  const writeOption = (policy: GatewayPolicy, option: ModelOption, now: ModelNow): void => {
    start(policy, { mode: null, model: option }, () =>
      writeModel(setSelection, policy, option, now.mode, now.fallback),
    );
  };
  const busy = GATEWAY_POLICIES.find((policy) => policy === action.busy) ?? null;
  const last =
    owner === null || action.outcome === null ? null : { policy: owner, outcome: action.outcome };
  return {
    busy,
    owner,
    held: pending !== null,
    pendingMode: pending?.mode ?? null,
    pendingModel: pending?.model ?? null,
    last,
    write,
    writeModel: writeOption,
  };
}

/** The card's title row, with a badge when the decision's model has a problem. */
function CardHeader({
  theme,
  policy,
  badge,
}: {
  theme: Theme;
  policy: GatewayPolicy;
  badge: ModelSelectView['badge'];
}): ReactNode {
  const info = DECISION_KINDS[policy];
  return (
    <SettingsRow label={info.title} hint={`${info.decides} ${info.askedBy}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
        {badge === null ? null : <Badge theme={theme} tone={badge.tone} text={badge.text} />}
        <Mono theme={theme}>{policy}</Mono>
      </View>
    </SettingsRow>
  );
}

/** The Model select, or a static row when the gateway is too old to choose per decision. */
function ModelRow({
  theme,
  view,
  blocked,
  onChange,
}: {
  theme: Theme;
  view: ModelSelectView;
  blocked: boolean;
  onChange: (option: ModelOption) => void;
}): ReactNode {
  if (view.unsupported) {
    return (
      <SettingsRow label="Model" hint={view.hint}>
        <Value theme={theme} muted>
          Default model
        </Value>
      </SettingsRow>
    );
  }
  return (
    <SettingsSelect
      label="Model"
      hint={view.hint}
      disabled={view.disabled || blocked}
      value={view.value}
      options={view.options}
      onValueChange={(next) => {
        const option = optionByValue(view.options, next);
        if (option !== undefined && next !== view.value) {
          onChange(option);
        }
      }}
    />
  );
}

function DecisionCard(props: CardProps): ReactNode {
  const { theme, policy, writes } = props;
  const { mine, blocked } = holdState({
    policy,
    owner: writes.owner,
    holding: writes.held,
    busy: writes.busy,
  });
  const mode = currentMode(policy, props);
  const engines = useEngines(props.gatewayUrl);
  const model = modelSelectView({
    kind: policy,
    catalog: engines.data,
    reachable: props.reachable,
    mode,
    modesLoaded: props.modesLoaded,
    gatewayMode: props.gatewayMode,
    writing: mine ? writes.pendingModel : null,
  });
  const row = modeRowHint(policy, {
    pluginMode: mode,
    gatewayMode: props.gatewayMode,
    modesLoaded: props.modesLoaded,
    reachable: props.reachable,
    busy: mine && writes.pendingMode !== null,
  });
  const outcome = writes.last?.policy === policy ? writes.last.outcome : null;
  return (
    <View accessible={false} role="group" aria-label={DECISION_KINDS[policy].title}>
      <SettingsCard>
        <CardHeader theme={theme} policy={policy} badge={model.badge} />
        <SettingsSelect
          label="Mode"
          hint={row.hint}
          disabled={row.disabled || blocked}
          value={mine ? (writes.pendingMode ?? mode) : mode}
          options={MODE_OPTIONS}
          onValueChange={(next) => writes.write(policy, next)}
        />
        <ModelRow
          theme={theme}
          view={model}
          blocked={blocked}
          onChange={(option) =>
            writes.writeModel(policy, option, { mode, fallback: model.fallback })
          }
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
      gatewayUrl={values.gatewayUrl}
      gatewayMode={modes[policy]}
      modesLoaded={modesLoaded}
      reachable={reachable}
    />
  ));
}

/** The model every decision set to Default model uses, and where to change it. */
function DefaultModelCard({
  theme,
  gatewayUrl,
  gatewayUp,
}: {
  theme: Theme;
  gatewayUrl: string;
  gatewayUp: boolean;
}): ReactNode {
  const { data, isError } = useEngines(gatewayUrl);
  const view = defaultModelView(data, gatewayUp, isError);
  return (
    <View accessible={false} role="group" aria-label="Default model">
      <SettingsCard>
        <SettingsRow label="Default model" hint={view.hint}>
          <Value theme={theme}>{view.value}</Value>
        </SettingsRow>
        {view.more === null ? null : (
          <SettingsRow
            label="More models"
            hint="Download or benchmark them under Engine and model."
          >
            <Value theme={theme} muted>
              {view.more}
            </Value>
          </SettingsRow>
        )}
        <SettingsAction
          label="What are these models?"
          hint="Size, speed and which decisions each model suits."
          actionLabel="Open docs"
          onPress={() => void openExternalUrl(MODELS_DOCS_URL)}
        />
      </SettingsCard>
    </View>
  );
}

export function DecisionsSection({
  theme,
  values,
  save,
}: SectionProps & { theme: Theme }): ReactNode {
  const { modes, loaded } = useGatewayModesState();
  const writes = useDecisionWrites(values, save);
  const status = useGatewayStatus();
  const reachable = status.data?.up !== false;
  return (
    <SettingsSection
      title="Decisions"
      info="Each decision local-decider makes, who asks for it and whether it acts. Shadow records what would have happened; Act lets it change what the agent does. Paseo's settings here also set the gateway, so Claude Code, Codex and pi outside Paseo follow them. A skipped decision changes nothing: the agent carries on as if it were Off. How sure the model must be is under Decision thresholds. Decisions set to Default model use the model from Engine and model. Thresholds were tuned for the default model, so run a decision on its own model in Shadow first."
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
      <DefaultModelCard theme={theme} gatewayUrl={values.gatewayUrl} gatewayUp={reachable} />
      {cardsFor(theme, values, writes, modes, loaded, reachable)}
    </SettingsSection>
  );
}
