/**
 * The default model's state and its one Load now / Unload button, and when to unload it while
 * idle. Shared by the settings and status screens.
 */
import { openExternalUrl, useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';

import type { ActiveEngine } from '../shared/engines.ts';
import {
  CUSTOM_IDLE,
  idleHint,
  idleOptions,
  idleValue,
  lifecycleLabel,
  parseIdleMinutes,
  parseIdleValue,
  type IdleChoice,
  type LifecycleChoice,
} from '../shared/lifecycle.ts';
import { engineLoadRpc, lifecycleRpc } from '../shared/rpc.ts';
import { defaultModelRow, gatewayRow } from '../shared/status-card.ts';
import { outcomeOf, useAction, useEngines, useGatewayStatus } from './hooks.ts';
import { InlineMessage, type Theme } from './ui.tsx';

type Action = ReturnType<typeof useAction>;

function ModelRow({
  catalog,
  catalogFailed,
  status,
  action,
}: {
  catalog: ReturnType<typeof useEngines>['data'];
  catalogFailed: boolean;
  status: ReturnType<typeof useGatewayStatus>['data'];
  action: Action;
}): ReactNode {
  const load = useRpc(engineLoadRpc);
  const row = defaultModelRow({ status, catalog, catalogFailed, busy: action.busy });
  const press = (): void => {
    void (row.action === 'unload'
      ? action.run('unload', async () => outcomeOf(await load({ action: 'unload' }), 'Unloaded.'))
      : action.run('load', async () =>
          outcomeOf(await load({ action: 'load' }), 'Loading the model.'),
        ));
  };
  return (
    <SettingsAction
      label="Default model"
      hint={row.hint}
      error={row.error}
      actionLabel={row.actionLabel}
      disabled={row.disabled}
      onPress={press}
    />
  );
}

function IdleRow({ active, action }: { active: ActiveEngine; action: Action }): ReactNode {
  const setLifecycle = useRpc(lifecycleRpc);
  const choice: LifecycleChoice = active.lifecycle ?? 'lazy';
  const minutes = active.idleUnloadMinutes;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState('');
  const apply = (picked: IdleChoice): void => {
    void action.run('lifecycle', async () =>
      outcomeOf(
        await setLifecycle(picked),
        picked.lifecycle === 'lazy'
          ? lifecycleLabel('lazy', picked.idleUnloadMinutes)
          : 'Always loaded.',
      ),
    );
  };
  const typed = parseIdleMinutes(draft);
  return (
    <>
      <SettingsSelect
        label="Unload when idle"
        hint={idleHint(choice)}
        value={custom ? CUSTOM_IDLE : idleValue(choice, minutes)}
        options={idleOptions(choice, minutes)}
        disabled={action.busy !== null}
        onValueChange={(next) => {
          if (next === CUSTOM_IDLE) {
            setDraft(idleValue(choice, minutes) === 'never' ? '' : idleValue(choice, minutes));
            setCustom(true);
            return;
          }
          setCustom(false);
          if (next !== idleValue(choice, minutes)) {
            apply(parseIdleValue(next));
          }
        }}
      />
      {custom ? (
        <>
          <SettingsInput
            label="Idle minutes"
            hint="Whole minutes, 1 to 1440."
            initialValue={draft}
            placeholder="15"
            onChangeText={setDraft}
          />
          <SettingsAction
            label="Custom idle time"
            hint={typed === null ? 'Type a number of minutes.' : lifecycleLabel('lazy', typed)}
            actionLabel="Save"
            disabled={action.busy !== null || typed === null}
            onPress={() => {
              if (typed !== null) {
                setCustom(false);
                apply({ lifecycle: 'lazy', idleUnloadMinutes: typed });
              }
            }}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * The default model row and the idle choice in one card, after `lead` (the settings page puts the
 * gateway row there; the status screen has its own).
 */
export function EngineControls({
  theme,
  gatewayUrl,
  lead,
}: {
  theme: Theme;
  gatewayUrl: string;
  lead?: ReactNode;
}): ReactNode {
  const status = useGatewayStatus();
  const engines = useEngines(gatewayUrl);
  const action = useAction();
  const active = engines.data?.active ?? null;
  return (
    <SettingsCard>
      {lead}
      <ModelRow
        catalog={engines.data}
        catalogFailed={engines.isError}
        status={status.data}
        action={action}
      />
      {active?.lifecycle == null ? null : <IdleRow active={active} action={action} />}
      {action.outcome === null || action.outcome.tone === 'success' ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </SettingsCard>
  );
}

/** The install guide link, shown while the gateway cannot be reached and auto-start gave one. */
function GuideRow({ url }: { url: string | undefined }): ReactNode {
  if (url === undefined) return null;
  return (
    <SettingsAction
      label="Set up the gateway"
      hint="Step-by-step install guide for local-decider with Paseo."
      actionLabel="Install guide"
      onPress={() => void openExternalUrl(url)}
    />
  );
}

/** Settings: the gateway, the default model and when it unloads, in one card. */
export function StatusSection({
  theme,
  gatewayUrl,
}: {
  theme: Theme;
  gatewayUrl: string;
}): ReactNode {
  const { data, isFetching, refetch } = useGatewayStatus();
  const row = gatewayRow(data);
  return (
    <SettingsSection title="Status">
      <EngineControls
        theme={theme}
        gatewayUrl={gatewayUrl}
        lead={
          <>
            <SettingsAction
              label={row.label}
              hint={row.hint}
              actionLabel={isFetching ? 'Checking…' : 'Refresh'}
              disabled={isFetching}
              onPress={() => void refetch()}
            />
            <GuideRow url={row.guideUrl} />
          </>
        }
      />
    </SettingsSection>
  );
}
