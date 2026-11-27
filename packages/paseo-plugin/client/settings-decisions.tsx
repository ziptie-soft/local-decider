/**
 * Settings, Decisions: one table with a row per decision kind, its mode and its model. Hook kinds
 * keep a Paseo mode and set the gateway too; command risk only has the gateway's mode.
 */
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsSection } from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import {
  GATEWAY_POLICIES,
  HOOK_POLICIES,
  PLUGIN_MODES,
  type GatewayPolicy,
  type PluginMode,
} from '../shared/constants.ts';
import { DECISION_KINDS, modeOptions } from '../shared/decision-kinds.ts';
import type { ModelOption } from '../shared/decision-models.ts';
import {
  holdState,
  HOLD_MAX_MS,
  modelSelectView,
  optionByValue,
  writeModel,
  type ModelSelectView,
} from '../shared/model-write.ts';
import {
  modeOutcome,
  modeRowHint,
  type ModeLine,
  type ModeWriteResult,
  type StatusLine,
} from '../shared/policies.ts';
import { policyModeRpc, policySelectionRpc } from '../shared/rpc.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { COLUMN_LABELS, TABLE, tableStacked } from '../shared/table-layout.ts';
import { ChipPicker } from './chip-picker.tsx';
import { useAction, useEngines, useGatewayStatus, type Outcome } from './hooks.ts';
import { useGatewayModesState } from './policy-modes.ts';
import type { Save, SectionProps } from './settings-common.ts';
import { Head, HeaderRow } from './table-parts.tsx';
import { Badge, Button, InlineMessage, type Theme } from './ui.tsx';

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
  /** The card is too narrow for a header: the chips carry their own captions. */
  readonly stacked: boolean;
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

const MODEL_NOTE =
  'Default follows the default model. An own model loads next to it and needs extra memory; at most 3 own models run at once.';
const MODES_LEGEND =
  'Off: not asked. Shadow: decides and records, changes nothing. Act: its decision takes effect.';
const OLDER_GATEWAY_LEGEND = 'Choosing a model per decision needs a newer local-decider gateway.';
const UNREACHABLE = 'The gateway is not running, so every decision is skipped until it is back.';
const INFO =
  'Each decision local-decider can make for your agents. Off: it is not asked. Shadow: it decides and records the result but changes nothing. Act: its decision takes effect. Modes set here also apply to the gateway, so Claude Code, Codex and pi outside Paseo follow them. A skipped decision changes nothing. Each decision uses the default model unless you give it its own; thresholds were tuned for the default model, so try an own model in Shadow first. Confidence thresholds are under Decision thresholds.';

function Cell({
  width,
  grow = false,
  children,
}: {
  width?: number;
  grow?: boolean;
  children: ReactNode;
}): ReactNode {
  if (grow) {
    return (
      <View style={{ flexGrow: 1, flexBasis: TABLE.description, minWidth: 0 }}>{children}</View>
    );
  }
  return <View style={{ width }}>{children}</View>;
}

function Controls({ wrap, children }: { wrap: boolean; children: ReactNode }): ReactNode {
  return (
    <View style={{ flexDirection: 'row', flexWrap: wrap ? 'wrap' : 'nowrap', gap: TABLE.gap }}>
      {children}
    </View>
  );
}

/** A chip column; stacked, its title moves inline before the chip and the pair never splits. */
function Column({
  theme,
  label,
  width,
  stacked,
  children,
}: {
  theme: Theme;
  label: string;
  width: number;
  stacked: boolean;
  children: ReactNode;
}): ReactNode {
  if (!stacked) {
    return <Cell width={width}>{children}</Cell>;
  }
  // The Model chip shrinks to the line (never past the card) down to `minModelChip`; the pair
  // wraps below that and may take the whole line up to its normal width.
  const flexible = width === TABLE.model;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        ...(flexible ? { flexGrow: 1, flexShrink: 1, maxWidth: '100%' } : {}),
      }}
    >
      <Head theme={theme} text={label} />
      <View
        style={
          flexible
            ? {
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: TABLE.minModelChip,
                minWidth: 0,
                maxWidth: width,
              }
            : { width }
        }
      >
        {children}
      </View>
    </View>
  );
}

function Header({ theme }: { theme: Theme }): ReactNode {
  const head = (text: string): ReactNode => <Head theme={theme} text={text} />;
  return (
    <HeaderRow>
      <Cell grow>{head(COLUMN_LABELS.decision)}</Cell>
      <Controls wrap={false}>
        <Cell width={TABLE.mode}>{head(COLUMN_LABELS.mode)}</Cell>
        <Cell width={TABLE.model}>{head(COLUMN_LABELS.model)}</Cell>
      </Controls>
    </HeaderRow>
  );
}

/** A toned status line under a row; a mismatch carries the button that fixes it. */
function Line({
  theme,
  line,
  disabled,
  onFix,
}: {
  theme: Theme;
  line: ModeLine | StatusLine;
  disabled: boolean;
  onFix: (mode: PluginMode) => void;
}): ReactNode {
  const fix = 'fix' in line ? line.fix : undefined;
  const color = line.tone === 'warning' ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 6, alignItems: 'flex-start' }}>
      <Text accessibilityLiveRegion="polite" style={{ color, fontSize: 12 }}>
        {line.text}
      </Text>
      {fix === undefined ? null : (
        <Button
          theme={theme}
          variant="secondary"
          label={fix.label}
          disabled={disabled}
          onPress={() => onFix(fix.mode)}
        />
      )}
    </View>
  );
}

/** The Model chip, or plain `Default` when the gateway is too old to choose per decision. */
function ModelCell({
  theme,
  title,
  view,
  blocked,
  onChange,
}: {
  theme: Theme;
  title: string;
  view: ModelSelectView;
  blocked: boolean;
  onChange: (option: ModelOption) => void;
}): ReactNode {
  if (view.unsupported) {
    return (
      <Text
        accessibilityLabel={`${title} model: Default`}
        style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}
      >
        Default
      </Text>
    );
  }
  return (
    <ChipPicker
      theme={theme}
      title={`${title} model`}
      note={MODEL_NOTE}
      disabled={view.disabled || blocked}
      value={view.value}
      options={view.options}
      onChange={(next) => {
        const option = optionByValue(view.options, next);
        if (option !== undefined && next !== view.value) {
          onChange(option);
        }
      }}
    />
  );
}

function DecisionRow(props: CardProps): ReactNode {
  const { theme, policy, writes } = props;
  const info = DECISION_KINDS[policy];
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
  const pickMode = (next: string): void => {
    const picked = PLUGIN_MODES.find((m) => m === next);
    if (picked !== undefined) {
      writes.write(policy, picked);
    }
  };
  return (
    <View
      accessible={false}
      role="group"
      aria-label={info.title}
      style={{
        gap: 6,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: props.theme.colors.border,
      }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <Cell grow>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{info.title}</Text>
            {model.badge === null ? null : (
              <Badge theme={theme} tone={model.badge.tone} text={model.badge.text} />
            )}
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{info.decides}</Text>
        </Cell>
        <Controls wrap={props.stacked}>
          <Column
            theme={theme}
            label={COLUMN_LABELS.mode}
            width={TABLE.mode}
            stacked={props.stacked}
          >
            <ChipPicker
              theme={theme}
              title={`${info.title} mode`}
              note={info.askedBy}
              disabled={row.disabled || blocked}
              value={mine ? (writes.pendingMode ?? mode) : mode}
              options={modeOptions(policy)}
              onChange={pickMode}
            />
          </Column>
          <Column
            theme={theme}
            label={COLUMN_LABELS.model}
            width={TABLE.model}
            stacked={props.stacked}
          >
            <ModelCell
              theme={theme}
              title={info.title}
              view={model}
              blocked={blocked}
              onChange={(option) =>
                writes.writeModel(policy, option, { mode, fallback: model.fallback })
              }
            />
          </Column>
        </Controls>
      </View>
      {row.line === null ? null : (
        <Line
          theme={theme}
          line={row.line}
          disabled={blocked}
          onFix={(fixMode) => writes.write(policy, fixMode)}
        />
      )}
      {model.line === null ? null : (
        <Line theme={theme} line={model.line} disabled onFix={() => undefined} />
      )}
      {outcome === null || outcome.tone === 'success' ? null : (
        <View style={{ marginHorizontal: -16 }}>
          <InlineMessage theme={theme} tone={outcome.tone} text={outcome.text} />
        </View>
      )}
    </View>
  );
}

function Footer({ theme, older }: { theme: Theme; older: boolean }): ReactNode {
  const style = { color: theme.colors.foregroundMuted, fontSize: 12 } as const;
  return (
    <View
      style={{
        gap: 2,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      }}
    >
      <Text style={style}>{MODES_LEGEND}</Text>
      {older ? <Text style={style}>{OLDER_GATEWAY_LEGEND}</Text> : null}
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
  const engines = useEngines(values.gatewayUrl);
  const reachable = status.data?.up !== false;
  const [width, setWidth] = useState(Infinity);
  const stacked = tableStacked(width);
  const older = engines.data?.reachable === true && engines.data.policies === undefined;
  return (
    <SettingsSection title="Decisions" info={INFO}>
      <SettingsCard>
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {reachable ? null : <InlineMessage theme={theme} tone="warning" text={UNREACHABLE} />}
          {stacked ? null : <Header theme={theme} />}
          {GATEWAY_POLICIES.map((policy) => (
            <DecisionRow
              key={policy}
              theme={theme}
              policy={policy}
              values={values}
              writes={writes}
              gatewayUrl={values.gatewayUrl}
              gatewayMode={modes[policy]}
              modesLoaded={loaded}
              stacked={stacked}
              reachable={reachable}
            />
          ))}
          <Footer theme={theme} older={older} />
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}
