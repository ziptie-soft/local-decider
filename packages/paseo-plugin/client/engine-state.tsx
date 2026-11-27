/**
 * The default model's state and its one Load now / Unload button, and when to unload it while
 * idle. Shared by the settings and status screens.
 */
import { useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from '@getpaseo/plugin/client/ui';
import type { ReactNode } from 'react';

import type { ActiveEngine } from '../shared/engines.ts';
import {
  idleHint,
  idleOptions,
  idleValue,
  lifecycleLabel,
  parseIdleValue,
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
  return (
    <SettingsSelect
      label="Unload when idle"
      hint={idleHint(choice)}
      value={idleValue(choice, minutes)}
      options={idleOptions(choice, minutes)}
      disabled={action.busy !== null}
      onValueChange={(next) => {
        if (next === idleValue(choice, minutes)) {
          return;
        }
        const picked = parseIdleValue(next);
        void action.run('lifecycle', async () =>
          outcomeOf(
            await setLifecycle(picked),
            picked.lifecycle === 'lazy'
              ? lifecycleLabel('lazy', picked.idleUnloadMinutes)
              : 'Always loaded.',
          ),
        );
      }}
    />
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
          <SettingsAction
            label={row.label}
            hint={row.hint}
            actionLabel={isFetching ? 'Checking…' : 'Refresh'}
            disabled={isFetching}
            onPress={() => void refetch()}
          />
        }
      />
    </SettingsSection>
  );
}
