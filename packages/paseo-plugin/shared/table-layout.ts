/**
 * Layout numbers of the Decisions table and the rule for when its columns stack. Pure, so the
 * breakpoint is tested; the component only measures the card and asks.
 */
export const TABLE = {
  padding: 16,
  gap: 10,
  mode: 110,
  model: 220,
  /** The narrowest the description is given before the controls wrap under it. */
  description: 220,
} as const;

/** The Mode and Model chips side by side, as one group. */
export const CONTROLS_WIDTH = TABLE.mode + TABLE.gap + TABLE.model;

/** Below this card width the controls wrap under the description: the header is hidden. */
export const STACK_BELOW = TABLE.padding * 2 + TABLE.description + TABLE.gap + CONTROLS_WIDTH;

/** The card is too narrow for the columns, so a header row would not line up. */
export function tableStacked(width: number): boolean {
  return width < STACK_BELOW;
}

/** The column titles: the header row shows them, and the stacked layout repeats them as captions. */
export const COLUMN_LABELS = { decision: 'Decision', mode: 'Mode', model: 'Model' } as const;
