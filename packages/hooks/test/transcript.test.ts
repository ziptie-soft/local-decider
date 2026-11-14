import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseTurns, readSlice } from '../src/transcript.ts';
import {
  firstUserText,
  historyText,
  lastAssistantText,
  lastUserText,
  taskText,
} from '../src/turns.ts';

const dir = mkdtempSync(join(tmpdir(), 'ld-hooks-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const claudeLines = [
  { type: 'summary', summary: 'x' },
  { type: 'user', message: { role: 'user', content: 'Fix the failing test' } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
  { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Looking at the test.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ],
    },
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
];

const codexLines = [
  { type: 'session_meta', payload: { id: 's' } },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo' }],
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Add a flag' }],
    },
  },
  { type: 'event_msg', payload: { type: 'task_started' } },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Added --flag.' }],
    },
  },
];

function jsonl(lines: readonly unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

describe('parseTurns', () => {
  it('extracts Claude user/assistant text and skips tools, thinking and injected text', () => {
    const turns = parseTurns(jsonl(claudeLines));
    assert.deepEqual(turns, [
      { role: 'user', text: 'Fix the failing test' },
      { role: 'assistant', text: 'Looking at the test.' },
      { role: 'assistant', text: 'Done.' },
    ]);
    assert.equal(firstUserText(turns), 'Fix the failing test');
    assert.equal(lastUserText(turns), 'Fix the failing test');
    assert.equal(lastAssistantText(turns), 'Done.');
    assert.equal(
      historyText(turns),
      'User: Fix the failing test\nAssistant: Looking at the test.\nAssistant: Done.',
    );
  });

  it('formats task requests and bounds each one', () => {
    assert.equal(
      taskText('First task', 'Narrow it'),
      'First request: First task\nLatest request: Narrow it',
    );
    assert.equal(taskText('First task', 'First task'), 'First request: First task');
    assert.equal(taskText(undefined, 'Latest request'), 'Latest request: Latest request');
    assert.equal(taskText(undefined, undefined), undefined);
    const bounded = taskText('x'.repeat(1600), 'y'.repeat(1600)) ?? '';
    assert.equal(
      bounded.length,
      'First request: '.length + 1500 + '\nLatest request: '.length + 1500,
    );
  });

  it('extracts Codex response items', () => {
    assert.deepEqual(parseTurns(jsonl(codexLines)), [
      { role: 'user', text: 'Add a flag' },
      { role: 'assistant', text: 'Added --flag.' },
    ]);
  });

  it('preserves user markup while skipping recognized injected wrappers', () => {
    const turns = parseTurns(
      jsonl([
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<instruction>Only run tests</instruction>' }],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '<system-reminder>Injected text</system-reminder>' },
            ],
          },
        },
      ]),
    );
    assert.deepEqual(turns, [{ role: 'user', text: '<instruction>Only run tests</instruction>' }]);
    const wrappers = [
      '<user_instructions>Repo rules</user_instructions>',
      '<turn_aborted>interrupted</turn_aborted>',
      '<user_shell_command>ls</user_shell_command>',
      '<command-message>review</command-message>\n<command-name>/review</command-name>',
      '<task-notification>agent finished</task-notification>',
      '<bash-input>pwd</bash-input>',
    ];
    assert.deepEqual(
      parseTurns(jsonl(wrappers.map((content) => ({ message: { role: 'user', content } })))),
      [],
    );
  });

  it('ignores garbage lines', () => {
    assert.deepEqual(parseTurns('not json\n{"type":"user"}\n[1]\n\n'), []);
  });

  it('bounds history to the most recent turns', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      text: `${String(i)} ${'x'.repeat(500)}`,
    }));
    const text = historyText(turns, 2000);
    assert.ok(text.length < 2600);
    assert.ok(text.endsWith('x'));
    assert.ok(text.includes('User: 49 '));
    assert.ok(!text.includes('User: 0 '));
  });
});

describe('readSlice', () => {
  it('returns the whole small file as head and tail', () => {
    const path = join(dir, 'small.jsonl');
    writeFileSync(path, jsonl(claudeLines));
    const slice = readSlice(path);
    assert.equal(slice?.head, slice?.tail);
    assert.equal(parseTurns(slice?.tail ?? '').length, 3);
  });

  it('reads only bounded head and tail with whole lines', () => {
    const path = join(dir, 'big.jsonl');
    const filler = Array.from({ length: 400 }, (_, i) => ({
      type: 'assistant',
      message: { role: 'assistant', content: `middle ${String(i)} ${'y'.repeat(200)}` },
    }));
    writeFileSync(path, jsonl([claudeLines[1], ...filler, claudeLines[6]]));
    const slice = readSlice(path, 4096);
    assert.ok(slice !== null);
    assert.ok(slice.head.length <= 4096 && slice.tail.length <= 4096);
    assert.equal(firstUserText(parseTurns(slice.head)), 'Fix the failing test');
    assert.equal(lastAssistantText(parseTurns(slice.tail)), 'Done.');
    assert.ok(slice.tail.split('\n').every((l) => l === '' || l.startsWith('{')));
  });

  it('finds Codex conversation beyond large instruction and tool-output records', () => {
    const path = join(dir, 'codex-large-records.jsonl');
    writeFileSync(
      path,
      jsonl([
        {
          type: 'response_item',
          payload: { type: 'message', role: 'developer', content: 'instructions '.repeat(2000) },
        },
        ...codexLines,
        {
          type: 'response_item',
          payload: { type: 'function_call_output', output: 'x'.repeat(20000) },
        },
      ]),
    );
    const slice = readSlice(path);
    assert.equal(firstUserText(parseTurns(slice?.head ?? '')), 'Add a flag');
    assert.equal(lastUserText(parseTurns(slice?.tail ?? '')), 'Add a flag');
    assert.equal(lastAssistantText(parseTurns(slice?.tail ?? '')), 'Added --flag.');
    assert.ok(Buffer.byteLength(slice?.head ?? '') <= 16384);
    assert.ok(Buffer.byteLength(slice?.tail ?? '') <= 16384);
  });

  it('finds Claude conversation beyond large tool records', () => {
    const path = join(dir, 'claude-large-records.jsonl');
    const tool = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(20000) }] },
    };
    writeFileSync(path, jsonl([tool, ...claudeLines, tool]));
    const slice = readSlice(path);
    assert.equal(firstUserText(parseTurns(slice?.head ?? '')), 'Fix the failing test');
    assert.equal(lastAssistantText(parseTurns(slice?.tail ?? '')), 'Done.');
  });

  it('retains the first and latest requests when assistant history fills the output budget', () => {
    const path = join(dir, 'many-turns.jsonl');
    const replies = Array.from({ length: 100 }, (_, index) => ({
      type: 'assistant',
      message: { role: 'assistant', content: `${String(index)} ${'x'.repeat(200)}` },
    }));
    writeFileSync(
      path,
      jsonl([
        claudeLines[1],
        ...replies,
        { type: 'user', message: { role: 'user', content: 'Only update the test fixture' } },
        ...replies,
      ]),
    );
    const slice = readSlice(path, 4096);
    assert.equal(firstUserText(parseTurns(slice?.head ?? '')), 'Fix the failing test');
    assert.equal(lastUserText(parseTurns(slice?.tail ?? '')), 'Only update the test fixture');
    assert.equal(lastAssistantText(parseTurns(slice?.tail ?? '')), `99 ${'x'.repeat(200)}`);
    assert.ok(Buffer.byteLength(slice?.tail ?? '') <= 4096);
  });

  it('clips oversized conversation records into valid, byte-bounded JSONL', () => {
    const path = join(dir, 'long-user.jsonl');
    writeFileSync(
      path,
      jsonl([
        { type: 'user', message: { role: 'user', content: `Please review ${'🙂'.repeat(20000)}` } },
      ]),
    );
    const slice = readSlice(path, 256);
    assert.ok(firstUserText(parseTurns(slice?.head ?? ''))?.startsWith('Please review '));
    assert.ok(lastUserText(parseTurns(slice?.tail ?? ''))?.startsWith('Please review '));
    assert.ok(Buffer.byteLength(slice?.head ?? '') <= 256);
    assert.ok(Buffer.byteLength(slice?.tail ?? '') <= 256);
  });

  it('keeps a complete tail record whose start is exactly on the read boundary', () => {
    const path = join(dir, 'boundary.jsonl');
    const last = jsonl([{ type: 'user', message: { role: 'user', content: 'Latest request' } }]);
    writeFileSync(path, `${jsonl([{ type: 'tool', output: 'x'.repeat(20000) }])}${last}`);
    const slice = readSlice(path, Buffer.byteLength(last));
    assert.equal(lastUserText(parseTurns(slice?.tail ?? '')), 'Latest request');
  });

  it('returns empty context when useful records are beyond the fixed scan ceiling', () => {
    const path = join(dir, 'scan-ceiling.jsonl');
    const tool = { type: 'tool', output: 'x'.repeat(1024 * 1024 + 1) };
    writeFileSync(path, jsonl([tool, ...claudeLines, tool]));
    const slice = readSlice(path);
    assert.deepEqual(slice, { head: '', tail: '' });
  });

  it('rejects invalid output budgets', () => {
    const path = join(dir, 'small.jsonl');
    for (const bytes of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      assert.equal(readSlice(path, bytes), null);
    }
  });

  it('returns null for a missing file', () => {
    assert.equal(readSlice(join(dir, 'nope.jsonl')), null);
  });
});
