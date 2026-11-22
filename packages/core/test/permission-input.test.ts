import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CALL_ID } from '../src/ids.ts';
import { INPUT_CAPS } from '../src/input-cap.ts';
import { buildPermissionInput, projectLabel } from '../src/permission-input.ts';

describe('projectLabel', () => {
  it('names the project by its last path segment', () => {
    assert.equal(projectLabel('/work/demo'), 'demo (/work/demo)');
    assert.equal(projectLabel('/work/demo///'), 'demo (/work/demo///)');
    assert.equal(projectLabel('/'), '/ (/)');
  });
});

describe('buildPermissionInput', () => {
  it('assembles the policy keys and leaves out empty values', () => {
    assert.deepEqual(
      buildPermissionInput({
        cwd: '/work/demo',
        tool: 'Bash',
        request: { command: 'ls' },
        subject: 'shell: ls',
        history: 'User: list',
        task: '',
      }),
      {
        project: 'demo (/work/demo)',
        history: 'User: list',
        tool: 'Bash',
        request: { command: 'ls' },
        subject: 'shell: ls',
      },
    );
    assert.deepEqual(buildPermissionInput({ request: undefined }), {});
  });

  it('caps each key and drops an over-cap subject', () => {
    const input = buildPermissionInput({
      request: { command: 'x'.repeat(20_000) },
      subject: 's'.repeat(10_000),
    });
    assert.equal(typeof input['request'], 'string');
    assert.ok(String(input['request']).length <= (INPUT_CAPS['request'] ?? 0));
    assert.equal('subject' in input, false);
  });
});

describe('CALL_ID', () => {
  it('accepts tool_use ids and rejects path-like or long ids', () => {
    assert.ok(CALL_ID.test('toolu_01-AbC'));
    assert.equal(CALL_ID.test('a/b'), false);
    assert.equal(CALL_ID.test('x'.repeat(129)), false);
  });
});
