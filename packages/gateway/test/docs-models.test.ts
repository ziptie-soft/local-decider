import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { allModels } from '../src/engines/registry.ts';

const DOC = new URL('../../../docs/models.md', import.meta.url);

/** First cells of the Markdown table in the "1. Models" section. */
function modelTableIds(markdown: string): string[] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith('1. Models')) ?? '';
  return section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => /^\|\s*`([^`]+)`/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

describe('docs/models.md', () => {
  it('lists every catalogue model in its models table, and nothing else', () => {
    const documented = modelTableIds(readFileSync(DOC, 'utf8'));
    assert.deepEqual(
      documented.toSorted(),
      allModels()
        .map((model) => model.id)
        .toSorted(),
    );
  });
});
