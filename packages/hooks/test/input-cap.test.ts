import type { DecideRequest, DecideResponse } from '@ziptie-soft/local-decider-core';
import {
  buildState,
  canonicalJson,
  parsePolicy,
  policySections,
} from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { mapEvent } from '../src/mapping.ts';
import { run } from '../src/run.ts';

const MIB3 = 3 * 1024 * 1024;

async function sentBody(harness: string, toolInput: unknown): Promise<string> {
  let body = '';
  const stdin = JSON.stringify({
    session_id: 's',
    cwd: '/work/app',
    tool_name: 'Bash',
    tool_input: toolInput,
  });
  await run(
    harness,
    'PreToolUse',
    stdin,
    {},
    {
      decide: async (_policy: string, request: DecideRequest): Promise<DecideResponse | null> => {
        body = JSON.stringify(request);
        return null;
      },
    },
  );
  return body;
}

const POLICIES = new URL('../../../policies/', import.meta.url);

function render(v: unknown): string {
  return v === undefined || v === null ? '' : typeof v === 'string' ? v : canonicalJson(v);
}

function stateOf(
  policyFile: string,
  input: Record<string, unknown>,
): ReturnType<typeof buildState> {
  const policy = parsePolicy(readFileSync(new URL(policyFile, POLICIES), 'utf8'), policyFile);
  const modelInput = { ...input };
  delete modelInput['subject'];
  return buildState(policySections(policy, modelInput, render), policy.state.maxTokens);
}

describe('capped input reaches the state builder', () => {
  it('a padded permission request marks the critical Request section cut', () => {
    const hook = {
      cwd: '/work/app',
      tool_name: 'Bash',
      tool_input: { command: `rm -rf build; ${'x'.repeat(MIB3)}` },
    };
    const { input } = mapEvent('PermissionRequest', hook, () => null);
    assert.equal(typeof input['request'], 'string');
    const built = stateOf('permission.yaml', input);
    assert.ok(built.truncated.includes('Request'));
    assert.equal(built.criticalCut, true);
  });

  it('a padded command-risk command marks the critical Command section cut', () => {
    const { input } = mapEvent(
      'PreToolUse',
      { cwd: '/work/app', tool_name: 'Bash', tool_input: { command: 'y'.repeat(MIB3) } },
      () => null,
    );
    const built = stateOf('command-risk.yaml', input);
    assert.equal(built.criticalCut, true);
  });

  it('an object request under its cap stays an object', () => {
    const { input } = mapEvent(
      'PermissionRequest',
      { cwd: '/work/app', tool_name: 'Bash', tool_input: { command: 'ls' } },
      () => null,
    );
    assert.deepEqual(input['request'], { command: 'ls' });
  });
});

describe('hook input caps', () => {
  for (const harness of ['claude', 'codex']) {
    for (const [name, big] of [
      ['string', 'x'.repeat(MIB3)],
      ['object', { command: 'x'.repeat(MIB3) }],
    ] as const) {
      it(`${harness}: a 3 MiB ${name} tool_input becomes a small body`, async () => {
        const body = await sentBody(harness, big);
        assert.ok(body.length > 0, 'the gateway was called');
        assert.ok(body.length < 256 * 1024, `body is ${String(body.length)} chars`);
      });
    }
  }
});
