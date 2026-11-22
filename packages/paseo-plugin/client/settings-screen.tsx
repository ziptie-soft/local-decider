import type { PluginScreenProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from '@getpaseo/plugin/client/ui';
import { Fragment, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { HOOK_POLICIES, PLUGIN_MODES } from '../shared/constants.ts';
import { modeMismatch } from '../shared/policies.ts';
import { policyModeRpc } from '../shared/rpc.ts';
import { deciderSettings } from '../shared/settings.ts';
import { normaliseBaseUrl } from '../shared/url.ts';
import { StatusSection } from './engine-state.tsx';
import { useGatewayModes } from './policy-modes.ts';
import { choices, type Save, type SectionProps } from './settings-common.ts';
import { RowsSection, SidebarSection } from './settings-display.tsx';
import { EngineSection } from './settings-engines.tsx';
import { PathsSection } from './settings-paths.tsx';
import { RoutingSection } from './settings-routing.tsx';
import { ThresholdsSection } from './settings-thresholds.tsx';
import { Page, type Theme } from './ui.tsx';

function GatewaySection({ values, save }: SectionProps): ReactNode {
  const [draft, setDraft] = useState(values.gatewayUrl);
  const normalised = normaliseBaseUrl(draft);
  return (
    <SettingsSection title="Advanced">
      <SettingsCard>
        <SettingsInput
          label="Gateway URL"
          hint="Reached from the daemon. Default http://127.0.0.1:8765. A remote gateway needs https, LOCAL_DECIDER_TOKEN and LOCAL_DECIDER_TOKEN_ORIGIN in the daemon's environment."
          initialValue={values.gatewayUrl}
          placeholder="http://127.0.0.1:8765"
          onChangeText={setDraft}
          error={normalised === null ? 'Enter an http(s) URL without credentials or query.' : null}
        />
        <SettingsAction
          label="Apply URL"
          actionLabel="Save"
          disabled={normalised === null || normalised === values.gatewayUrl}
          onPress={() => {
            if (normalised !== null) {
              save({ ...values, gatewayUrl: normalised });
            }
          }}
        />
        <SettingsSwitch
          label="Agent tools (decide, explain)"
          hint="Gives agents opened from now on three tools through Paseo's own paseo MCP server: local_decider_decide, local_decider_explain and local_decider_policies. Answers are advisory and never enforced; the gateway address and tokens stay in the plugin. Costs a few tool descriptions of context per agent; Codex agents can't use them yet."
          value={values.agentTools}
          onValueChange={(agentTools: boolean) => save({ ...values, agentTools })}
        />
        <SettingsSwitch
          label="Daily review"
          hint="Once a day (and 30 s after you turn it on) the plugin fetches the gateway's review of the last 24 h and shows the disagreements in the status popover and Details page. Read-only: no agent, no model, hashes and ids only. Off means no timer."
          value={values.dailyReview}
          onValueChange={(dailyReview: boolean) => save({ ...values, dailyReview })}
        />
        <SettingsSwitch
          label="Load the model when Paseo starts"
          hint="Off: the gateway loads the model on the first decision (~5 s on FastFlowLM, longer on CPU). On: it is loaded at Paseo start and still unloads after the idle time."
          value={values.preloadOnStart}
          onValueChange={(preloadOnStart: boolean) => save({ ...values, preloadOnStart })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** A warning hint when the plugin is in act but the gateway is not; nothing otherwise. */
function mismatchHint(
  mode: 'off' | 'shadow' | 'act',
  gatewayMode: 'off' | 'shadow' | 'act' | undefined,
): { hint?: string } {
  return modeMismatch(mode, gatewayMode) && gatewayMode !== undefined
    ? {
        hint: `Warning: the gateway runs this policy in ${gatewayMode}, so its decisions are not enforced. Choose Act again to set the gateway too.`,
      }
    : {};
}

function PolicySection({ values, save }: SectionProps): ReactNode {
  const setGatewayMode = useRpc(policyModeRpc);
  const gatewayModes = useGatewayModes();
  return (
    <SettingsSection
      title="Policies"
      info="Shadow records what would have happened. Act lets the decider change Paseo's behaviour. Choosing a mode here sets it in the gateway too. How sure the model must be is under Decision thresholds."
    >
      <SettingsCard>
        {HOOK_POLICIES.map((policy) => (
          <Fragment key={policy}>
            <SettingsSelect
              label={policy}
              {...mismatchHint(values.modes[policy], gatewayModes[policy])}
              value={values.modes[policy]}
              options={choices(PLUGIN_MODES, {
                off: 'Off',
                shadow: 'Shadow (record only)',
                act: 'Act (when the gateway does)',
              })}
              onValueChange={(mode) => {
                save({ ...values, modes: { ...values.modes, [policy]: mode } });
                // The gateway's own mode decides whether a decision is enforced: keep both in step.
                void setGatewayMode({ policy, mode });
              }}
            />
          </Fragment>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function Message({ theme, text }: { theme: Theme; text: string }): ReactNode {
  return (
    <View style={{ padding: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{text}</Text>
    </View>
  );
}

/**
 * Sections run from what a user is most likely to change to what they rarely touch: health, how
 * each policy acts, routing and the model, how decisions show up, then connection details.
 */
export function SettingsScreen({ theme, navigation }: PluginSurfaceProps): ReactNode {
  const settings = useSettings(deciderSettings);
  if (settings.status === 'loading') {
    return <Loading />;
  }
  if (settings.status === 'error') {
    return <Message theme={theme} text={`Settings unavailable: ${settings.error}`} />;
  }
  if (settings.status === 'invalid') {
    return (
      <SettingsSection title="Settings">
        <SettingsAction
          label="Stored settings are invalid"
          hint={settings.error}
          actionLabel="Reset to defaults"
          onPress={() => void settings.reset()}
        />
      </SettingsSection>
    );
  }
  const { values, revision } = settings;
  const save: Save = (next) => {
    void settings.save(next, revision);
  };
  return (
    <View style={{ gap: 16 }}>
      {settings.saveError === null ? null : <Message theme={theme} text={settings.saveError} />}
      <StatusSection theme={theme} gatewayUrl={values.gatewayUrl} />
      <PolicySection values={values} save={save} />
      <RoutingSection
        theme={theme}
        navigation={navigation}
        gatewayUrl={values.gatewayUrl}
        values={values}
        save={save}
      />
      <EngineSection theme={theme} gatewayUrl={values.gatewayUrl} />
      <RowsSection values={values} save={save} />
      <SidebarSection values={values} save={save} />
      <GatewaySection values={values} save={save} />
      <ThresholdsSection theme={theme} gatewayUrl={values.gatewayUrl} />
      <PathsSection theme={theme} gatewayUrl={values.gatewayUrl} />
      <SettingsSection title="Reset">
        <SettingsCard>
          <SettingsAction
            label="Restore defaults"
            hint="Every setting on this page, on this host. The gateway keeps its own config.yaml and logs."
            actionLabel="Reset"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

/** The settings as a regular plugin screen (opened from the sidebar popover), with scrolling. */
export function SettingsPage(props: PluginScreenProps): ReactNode {
  return (
    <Page theme={props.theme} compact={props.layout.compact}>
      <SettingsScreen {...props} />
    </Page>
  );
}
