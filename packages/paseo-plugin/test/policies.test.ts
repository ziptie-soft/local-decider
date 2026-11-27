import { ALLOW_THRESHOLD_FLOOR } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  listPolicyModes,
  listPolicyThresholds,
  listPolicyVariants,
  policyPrompt,
  reloadPolicies,
  routingSettings,
  setPolicyThresholds,
  setPolicyVariant,
  setRoutingPreset,
} from '../server/engines.ts';
import { ALLOW_THRESHOLD, GATEWAY_POLICIES, type PluginMode } from '../shared/constants.ts';
import {
  allowWarning,
  legacyPresetMoves,
  mismatchLabel,
  modeMismatchLine,
  modeMismatch,
  modeOutcome,
  modeRowHint,
  popoverRowLabel,
  parsePolicyModes,
  policyModeInputSchema,
  parsePolicyThresholds,
  parsePolicyVariants,
  parseRoutingSettings,
  presetRows,
  splitPresetRows,
  clampThreshold,
  parseThresholdInput,
  thresholdFloor,
  warningZones,
  thresholdLabel,
  thresholdText,
  type ThresholdSetting,
} from '../shared/policies.ts';
import { settingsSchema } from '../shared/settings-schema.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

describe('parsePolicyVariants', () => {
  it('returns the active variant and each variant with its routes', async () => {
    const body = await fakeGateway(() => null).policies();
    assert.deepEqual(parsePolicyVariants(body, 'routing'), {
      ok: true,
      error: null,
      active: 'routing-budget',
      variants: [
        { id: 'routing', description: 'Tiers.', routes: ['fast', 'deep'] },
        { id: 'routing-budget', description: 'Cheap first.', routes: ['cheap'] },
      ],
    });
  });

  it('treats an older gateway without variants as the policy alone', () => {
    const body = [{ id: 'routing', description: 'Tiers.', routes: ['fast'] }];
    const parsed = parsePolicyVariants(body, 'routing');
    assert.equal(parsed.active, 'routing');
    assert.deepEqual(
      parsed.variants.map((v) => v.id),
      ['routing'],
    );
  });

  it('reports a missing policy or list', () => {
    assert.equal(parsePolicyVariants(null, 'routing').ok, false);
    assert.match(
      parsePolicyVariants([{ id: 'permission' }], 'routing').error ?? '',
      /No "routing"/,
    );
  });
});

describe('presetRows', () => {
  it('lists the routes, then mapped presets the policy does not use', () => {
    const saved = {
      fast: { model: 'claude/haiku' },
      cheap: { model: 'claude/haiku' },
      deep: { model: '' },
      stale: { model: '' },
    };
    assert.deepEqual(presetRows(['deep', 'fast'], saved), [
      { name: 'deep', used: true },
      { name: 'fast', used: true },
      { name: 'cheap', used: false },
    ]);
  });
});

describe('splitPresetRows', () => {
  const rows = [
    { name: 'deep', used: true },
    { name: 'fast', used: true },
    { name: 'cheap', used: false },
    { name: 'old', used: false },
  ];

  it('keeps the active routes and titles the rest by count', () => {
    assert.deepEqual(splitPresetRows(rows), {
      active: ['deep', 'fast'],
      others: ['cheap', 'old'],
      title: '2 presets for routes not in this policy',
    });
    assert.equal(
      splitPresetRows(rows.slice(0, 3)).title,
      '1 preset for a route not in this policy',
    );
  });

  it('has no title when every preset is a route of the policy', () => {
    assert.deepEqual(splitPresetRows(rows.slice(0, 2)), {
      active: ['deep', 'fast'],
      others: [],
      title: null,
    });
    assert.deepEqual(splitPresetRows([]), { active: [], others: [], title: null });
  });
});

describe('settings presets', () => {
  it('keeps v3 fast/standard/deep settings and accepts any preset name', () => {
    const presets = { fast: { model: 'a/b' }, cheap: { model: 'c/d', modeId: 'auto' } };
    assert.deepEqual(settingsSchema.parse({ presets }).presets, {
      fast: { model: 'a/b', modeId: '' },
      cheap: { model: 'c/d', modeId: 'auto' },
    });
    assert.deepEqual(settingsSchema.parse({}).presets, {});
  });

  it('rejects names a policy action could not carry', () => {
    assert.equal(settingsSchema.safeParse({ presets: { 'Bad Name': {} } }).success, false);
  });
});

describe('policy RPC handlers', () => {
  it('lists variants, chooses one and reloads through the gateway', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    assert.equal((await listPolicyVariants(d, 'routing')).active, 'routing-budget');
    assert.deepEqual(await setPolicyVariant(d, { policy: 'routing', variant: 'routing' }), {
      ok: true,
      error: null,
    });
    assert.deepEqual(await reloadPolicies(d), { ok: true, error: null, count: 3 });
    assert.deepEqual(gw.posts, [
      { name: 'setPolicyVariant', input: { policy: 'routing', variant: 'routing' } },
      { name: 'reloadPolicies', input: {} },
    ]);
  });

  it('fails cleanly without a gateway or when it refuses', async () => {
    assert.equal((await listPolicyVariants(deps(settings(), null), 'routing')).ok, false);
    const gw = {
      ...fakeGateway(() => null),
      reloadPolicies: async () => ({ ok: false as const, error: 'bad.yaml: invalid YAML' }),
    };
    assert.deepEqual(await reloadPolicies(deps(settings(), gw)), {
      ok: false,
      error: 'bad.yaml: invalid YAML',
      count: 0,
    });
  });
});

describe('rule thresholds', () => {
  const allow: ThresholdSetting = {
    key: 'verdict.allow',
    question: 'verdict',
    answer: 'allow',
    action: 'allow',
    kind: 'minProbability',
    default: 0.95,
    value: 0.95,
    floor: 0.8,
  };

  it('lists the thresholds of the variant answering, and sets them through the gateway', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    const permission = await listPolicyThresholds(d, 'permission');
    assert.equal(permission.policy, 'permission');
    assert.equal(permission.thresholds[0]?.value, 0.9);
    const routing = await listPolicyThresholds(d, 'routing');
    assert.deepEqual([routing.policy, routing.thresholds], ['routing-budget', []]);
    assert.equal((await listPolicyThresholds(deps(settings(), null), 'routing')).ok, false);
    assert.equal(parsePolicyThresholds([], 'permission').ok, false);
    const input = { policy: 'permission', thresholds: { 'verdict.allow': null } };
    assert.deepEqual(await setPolicyThresholds(d, input), { ok: true, error: null });
    assert.deepEqual(gw.posts, [{ name: 'setPolicyThresholds', input }]);
  });

  it('maps the gateway run mode of each hook policy, and flags an act mismatch', async () => {
    const listed = await listPolicyModes(
      deps(
        settings(),
        fakeGateway(() => null),
      ),
    );
    assert.deepEqual(listed, {
      ok: true,
      error: null,
      modes: { permission: 'shadow', routing: 'act' },
    });
    const down = await listPolicyModes(deps(settings(), null));
    assert.deepEqual([down.ok, down.modes], [false, {}]);
    assert.equal(parsePolicyModes([]).ok, false);
    assert.equal(modeMismatch('act', 'shadow'), true);
    assert.equal(modeMismatch('act', 'off'), true);
    assert.equal(modeMismatch('act', 'act'), false);
    assert.equal(modeMismatch('act', undefined), false);
    assert.equal(modeMismatch('shadow', 'off'), false);
    assert.equal(mismatchLabel('shadow'), 'act · gateway shadow');
  });

  it('describes a rule and steps within its floor', () => {
    assert.equal(thresholdLabel(allow), 'auto-allow when verdict is allow');
    assert.equal(thresholdText(allow), 'p(allow) ≥ 0.95');
    assert.equal(thresholdText({ ...allow, value: 0.9 }), 'p(allow) ≥ 0.90 (default 0.95)');
    assert.equal(
      thresholdLabel({ ...allow, action: 'route:fast', kind: 'minConfidence' }),
      'route to fast when verdict is allow',
    );
    assert.equal(thresholdFloor(allow), 0.8);
    assert.equal(thresholdFloor({ ...allow, action: 'deny', floor: 0 }), 0);
    assert.equal(clampThreshold(allow, 0.333), 0.8);
    assert.equal(clampThreshold(allow, 0.876), 0.88);
    assert.equal(clampThreshold(allow, 1.2), 1);
    assert.equal(clampThreshold({ ...allow, action: 'deny', floor: 0.554 }, 0.5), 0.554);
  });

  it('parses typed thresholds as fractions or percentages, refusing out-of-range text', () => {
    assert.deepEqual(parseThresholdInput(allow, '0.9'), { value: 0.9, error: null });
    assert.deepEqual(parseThresholdInput(allow, '.85'), { value: 0.85, error: null });
    assert.deepEqual(parseThresholdInput(allow, '90'), { value: 0.9, error: null });
    assert.deepEqual(parseThresholdInput(allow, '92%'), { value: 0.92, error: null });
    assert.deepEqual(parseThresholdInput(allow, '0,8'), { value: 0.8, error: null });
    assert.deepEqual(parseThresholdInput({ ...allow, action: 'deny', floor: 0.554 }, '0.554'), {
      value: 0.554,
      error: null,
    });
    assert.match(parseThresholdInput(allow, '0.4').error ?? '', /0\.80 to 1\.00/);
    assert.notEqual(parseThresholdInput(allow, 'abc').error, null);
    assert.notEqual(parseThresholdInput(allow, '150').error, null);
    assert.deepEqual(parseThresholdInput({ ...allow, action: 'deny', floor: 0 }, '0.3'), {
      value: 0.3,
      error: null,
    });
  });

  it('tints only the soft warning band of an auto-allow slider at the floor', () => {
    assert.deepEqual(warningZones(allow), [
      { from: ALLOW_THRESHOLD.floor, to: ALLOW_THRESHOLD.soft, strong: false },
    ]);
    assert.deepEqual(warningZones({ ...allow, floor: 0.85 }), [
      { from: 0.85, to: ALLOW_THRESHOLD.soft, strong: false },
    ]);
    assert.deepEqual(warningZones({ ...allow, floor: 0.95 }), []);
    assert.deepEqual(warningZones({ ...allow, action: 'deny' }), []);
    assert.equal(allowWarning(allow, 0.85)?.strong, false);
  });

  it('warns when the auto-allow threshold is lowered, never for deny', () => {
    assert.equal(allowWarning(allow), null);
    assert.equal(allowWarning({ ...allow, value: ALLOW_THRESHOLD.soft }), null);
    assert.equal(allowWarning({ ...allow, value: 0.85 })?.strong, false);
    assert.match(allowWarning({ ...allow, value: 0.85 })?.text ?? '', /without asking you/);
    assert.equal(allowWarning({ ...allow, value: 0.75 })?.strong, true);
    assert.match(allowWarning({ ...allow, value: 0.75 })?.text ?? '', /unsure/);
    assert.equal(allowWarning({ ...allow, action: 'deny', value: 0.3 }), null);
    const lowDefault = { ...allow, default: 0.85, value: 0.85 };
    assert.equal(allowWarning(lowDefault), null, 'the shipped default is not flagged');
    assert.equal(allowWarning({ ...lowDefault, value: 0.82 })?.strong, false);
    assert.equal(allowWarning({ ...lowDefault, value: 0.9 }), null);
  });

  it('shares the gateway floor', () => {
    assert.equal(ALLOW_THRESHOLD.floor, ALLOW_THRESHOLD_FLOOR);
  });
});

describe('routing settings in config.yaml', () => {
  it('reads Paseo presets and the file, and maps presets through the gateway', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    assert.deepEqual(await routingSettings(d), {
      ok: true,
      error: null,
      file: '/home/u/.config/local-decider/config.yaml',
      presets: { cheap: { model: 'claude/haiku' } },
    });
    await setRoutingPreset(d, { preset: 'deep', model: 'codex/gpt-5.5', mode: 'full-access' });
    await setRoutingPreset(d, { preset: 'cheap', mode: '' });
    assert.deepEqual(gw.posts, [
      {
        name: 'setRoutingPreset',
        input: { harness: 'paseo', preset: 'deep', model: 'codex/gpt-5.5', mode: 'full-access' },
      },
      { name: 'setRoutingPreset', input: { harness: 'paseo', preset: 'cheap' } },
    ]);
  });

  it('reports an older gateway without /v1/config', () => {
    assert.equal(parseRoutingSettings(null).ok, false);
    assert.deepEqual(parseRoutingSettings({ file: null, config: {} }).presets, {});
  });

  it('moves only mapped presets config.yaml does not have yet', () => {
    const saved = {
      fast: { model: 'claude/haiku', modeId: '' },
      deep: { model: 'codex/gpt-5.5', modeId: 'auto' },
      standard: { model: '', modeId: '' },
    };
    assert.deepEqual(legacyPresetMoves(saved, { fast: { model: 'x/y' } }), [
      { preset: 'deep', model: 'codex/gpt-5.5', mode: 'auto' },
    ]);
  });

  it('fetches the authoring prompt and its working directory', async () => {
    const d = deps(
      settings(),
      fakeGateway(() => null),
    );
    assert.deepEqual(await policyPrompt(d, 'routing'), {
      ok: true,
      error: null,
      prompt: '# Write a policy',
      cwd: '/home/u/.config/local-decider',
    });
    assert.equal((await policyPrompt(d, 'permission')).ok, false);
    assert.equal((await policyPrompt(deps(settings(), null), 'routing')).ok, false);
  });
});

const MODES: readonly PluginMode[] = ['off', 'shadow', 'act'];
const HOOK_KIND = 'permission';

type WriteResult = Parameters<typeof modeOutcome>[2];
const hookText = (res: WriteResult): string => modeOutcome('turn-outcome', 'act', res).text;
const riskText = (res: WriteResult): string => modeOutcome('command-risk', 'off', res).text;
const parse = (policy: string): { success: boolean } =>
  policyModeInputSchema.safeParse({ policy, mode: 'off' });

describe('parsePolicyModes over the gateway kinds', () => {
  it('keeps command-risk with the three hook modes and drops unknown ids', () => {
    const body = [
      { id: 'command-risk', mode: 'off' },
      { id: 'permission', mode: 'act' },
      { id: 'routing', mode: 'shadow' },
      { id: 'turn-outcome', mode: 'off' },
      { id: 'nope', mode: 'act' },
    ];
    const parsed = parsePolicyModes(body);
    assert.deepEqual(parsed.modes, {
      'command-risk': 'off',
      'permission': 'act',
      'routing': 'shadow',
      'turn-outcome': 'off',
    });
    assert.equal(Object.hasOwn(parsed.modes, 'nope'), false);
  });
});

describe('modeMismatchLine', () => {
  it('warns when Paseo acts and the gateway does not, and offers Act', () => {
    for (const gateway of ['off', 'shadow'] as const) {
      const line = modeMismatchLine(HOOK_KIND, 'act', gateway);
      assert.equal(line?.tone, 'warning');
      assert.equal(
        line?.text,
        `The gateway runs this in ${gateway === 'off' ? 'Off' : 'Shadow'}, so its decisions are not enforced.`,
      );
      assert.deepEqual(line?.fix, { label: 'Set gateway to Act', mode: 'act' });
    }
  });

  it('warns when the gateway acts and Paseo does not, and offers the Paseo mode', () => {
    const off = modeMismatchLine(HOOK_KIND, 'off', 'act');
    assert.equal(
      off?.text,
      'Outside Paseo the gateway still runs this in Act, so Claude Code and Codex enforce it.',
    );
    assert.deepEqual(off?.fix, { label: 'Set gateway to Off', mode: 'off' });
    assert.deepEqual(modeMismatchLine(HOOK_KIND, 'shadow', 'act')?.fix, {
      label: 'Set gateway to Shadow',
      mode: 'shadow',
    });
    assert.equal(modeMismatchLine(HOOK_KIND, 'shadow', 'act')?.tone, 'warning');
  });

  it('does not warn for any other combination', () => {
    const quiet: [PluginMode, PluginMode | undefined][] = [
      ['act', 'act'],
      ['act', undefined],
      ['off', 'off'],
      ['off', 'shadow'],
      ['off', undefined],
      ['shadow', 'off'],
      ['shadow', 'shadow'],
      ['shadow', undefined],
    ];
    for (const [plugin, gateway] of quiet) {
      assert.equal(modeMismatchLine(HOOK_KIND, plugin, gateway), null);
    }
  });

  it('is always null for command-risk', () => {
    for (const plugin of MODES) {
      for (const gateway of [...MODES, undefined]) {
        assert.equal(modeMismatchLine('command-risk', plugin, gateway), null);
      }
    }
  });
});

describe('modeRowHint', () => {
  const base = {
    pluginMode: 'shadow',
    gatewayMode: 'shadow',
    modesLoaded: true,
    reachable: true,
    busy: false,
  } as const;
  const NOT_LOADED = {
    text: 'The gateway has not loaded this policy, so it never runs.',
    tone: 'warning',
  };

  it('shows Saving… (muted) while a write is in flight', () => {
    for (const id of GATEWAY_POLICIES) {
      assert.deepEqual(modeRowHint(id, { ...base, busy: true }), {
        line: { text: 'Saving…', tone: 'muted' },
        disabled: false,
      });
    }
  });

  it('says nothing, and disables command-risk, while the gateway mode is unknown', () => {
    const asking = modeRowHint('command-risk', {
      ...base,
      gatewayMode: undefined,
      modesLoaded: false,
    });
    assert.deepEqual(asking, { line: null, disabled: true });
    assert.deepEqual(modeRowHint('command-risk', { ...base, reachable: false }), {
      line: null,
      disabled: true,
    });
  });

  it('warns that a loaded gateway with no entry for the policy never runs it', () => {
    assert.deepEqual(modeRowHint('command-risk', { ...base, gatewayMode: undefined }), {
      line: NOT_LOADED,
      disabled: true,
    });
    for (const id of GATEWAY_POLICIES.filter((kind) => kind !== 'command-risk')) {
      assert.deepEqual(modeRowHint(id, { ...base, gatewayMode: undefined }), {
        line: NOT_LOADED,
        disabled: false,
      });
    }
  });

  it('shows the mismatch of a hook kind with its fix', () => {
    const row = modeRowHint(HOOK_KIND, { ...base, pluginMode: 'act', gatewayMode: 'shadow' });
    assert.deepEqual(row.line, modeMismatchLine(HOOK_KIND, 'act', 'shadow'));
    assert.equal(row.disabled, false);
  });

  it('shows no line when the modes agree, and never the plain mode description', () => {
    for (const id of GATEWAY_POLICIES) {
      for (const mode of MODES) {
        const row = modeRowHint(id, { ...base, pluginMode: mode, gatewayMode: mode });
        assert.deepEqual(row, { line: null, disabled: false });
      }
    }
  });

  it('disables a hook kind too while the gateway is unreachable', () => {
    const row = modeRowHint(HOOK_KIND, { ...base, reachable: false });
    assert.deepEqual(row, { line: null, disabled: true });
  });

  it('says nothing about a hook kind while the gateway is unknown', () => {
    const row = modeRowHint(HOOK_KIND, {
      ...base,
      pluginMode: 'act',
      gatewayMode: undefined,
      modesLoaded: false,
    });
    assert.deepEqual(row, { line: null, disabled: false });
  });
});

describe('modeOutcome', () => {
  it('reports success for each kind and mode', () => {
    assert.deepEqual(modeOutcome('routing', 'shadow', { ok: true }), {
      tone: 'success',
      text: 'Routing is now Shadow.',
    });
    assert.deepEqual(modeOutcome('command-risk', 'act', { ok: true }), {
      tone: 'success',
      text: 'Command risk is now Act.',
    });
  });

  it('adds the own-rules note when command-risk is turned Off', () => {
    assert.equal(
      modeOutcome('command-risk', 'off', { ok: true }).text,
      'Command risk is now Off. Claude Code, Codex and pi may still ask by their own rules.',
    );
    assert.equal(modeOutcome('permission', 'off', { ok: true }).text, 'Permission is now Off.');
  });

  it('substitutes the reason on a hook-kind failure', () => {
    const tail = 'Claude Code and Codex outside Paseo keep the old mode.';
    assert.equal(
      hookText({ ok: false, error: 'bad mode' }),
      `Saved in Paseo, but the gateway refused: bad mode. ${tail}`,
    );
    assert.equal(
      hookText({ ok: false, error: null }),
      `Saved in Paseo, but the gateway refused: the gateway refused without a reason. ${tail}`,
    );
    assert.equal(
      hookText({ ok: false, unreachable: true }),
      `Saved in Paseo, but the gateway refused: the gateway is unreachable. ${tail}`,
    );
    assert.equal(modeOutcome('turn-outcome', 'act', { ok: false }).tone, 'error');
  });

  it('substitutes the reason on a command-risk failure', () => {
    assert.equal(
      riskText({ ok: false, error: 'no such policy' }),
      "Couldn't change Command risk: no such policy.",
    );
    assert.equal(
      riskText({ ok: false }),
      "Couldn't change Command risk: the gateway refused without a reason.",
    );
    assert.equal(
      riskText({ ok: false, unreachable: true }),
      "Couldn't change Command risk: the gateway is unreachable.",
    );
  });
});

describe('popoverRowLabel', () => {
  it('names the plugin mode of a hook kind', () => {
    assert.equal(popoverRowLabel('routing', 'shadow', 'shadow'), 'Routing: Shadow.');
    assert.equal(popoverRowLabel('routing', 'off', undefined), 'Routing: Off.');
  });

  it('adds the mismatch sentence when the plugin acts and the gateway does not', () => {
    assert.equal(
      popoverRowLabel('permission', 'act', 'shadow'),
      'Permission: Act. The gateway runs it in Shadow, so its decisions are not enforced.',
    );
  });

  it('shows the gateway mode of command-risk, or unknown', () => {
    assert.equal(popoverRowLabel('command-risk', undefined, 'off'), 'Command risk: Off.');
    assert.equal(
      popoverRowLabel('command-risk', undefined, undefined),
      'Command risk: mode unknown.',
    );
  });
});

describe('policyModeInputSchema', () => {
  it('accepts every gateway kind and rejects others', () => {
    assert.equal(parse('command-risk').success, true);
    for (const id of GATEWAY_POLICIES) {
      assert.equal(parse(id).success, true);
    }
    assert.equal(parse('nope').success, false);
  });
});
