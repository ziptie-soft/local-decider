import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { optionAccessibilityLabel } from '../shared/chip-label.ts';
import {
  COLUMN_LABELS,
  CONTROLS_WIDTH,
  STACK_BELOW,
  TABLE,
  tableStacked,
} from '../shared/table-layout.ts';

describe('table layout', () => {
  it('keeps the two chips in one 340 px group', () => {
    assert.equal(CONTROLS_WIDTH, 340);
  });

  it('stacks below 602 px and not at it', () => {
    assert.equal(STACK_BELOW, 602);
    assert.equal(tableStacked(601), true);
    assert.equal(tableStacked(602), false);
    assert.equal(tableStacked(700), false);
  });
});

describe('model chip size', () => {
  it('shrinks to 120 px at least, and never past its normal width', () => {
    assert.equal(TABLE.minModelChip, 120);
    assert.ok(TABLE.minModelChip < TABLE.model);
  });
});

describe('column labels', () => {
  it('names the three columns once for the header and the captions', () => {
    assert.deepEqual(COLUMN_LABELS, { decision: 'Decision', mode: 'Mode', model: 'Model' });
  });
});

describe('optionAccessibilityLabel', () => {
  it('adds the detail after the label', () => {
    assert.equal(
      optionAccessibilityLabel({ label: 'Shadow', detail: 'Decides and records.' }),
      'Shadow. Decides and records.',
    );
    assert.equal(optionAccessibilityLabel({ label: 'Off' }), 'Off');
  });
});
