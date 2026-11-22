/**
 * Counts of `[REDACTED:<kind>]` labels a redaction added, derived by comparing the value before
 * and after. This leaves `redactDeep` untouched (its output is recorded by the eval gate); the
 * counts only feed the explain view, so nested rules may count one secret once.
 */

const LABEL_RE = /\[REDACTED:([a-z0-9-]{1,40})\]/g;
const MAX_DEPTH = 64;

function countStrings(text: string, counts: Map<string, number>): void {
  for (const match of text.matchAll(LABEL_RE)) {
    const kind = match[1] as string;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
}

function countValue(
  value: unknown,
  counts: Map<string, number>,
  depth: number,
  path: Set<object>,
): void {
  if (typeof value === 'string') {
    countStrings(value, counts);
    return;
  }
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH || path.has(value)) {
    return;
  }
  path.add(value);
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) countValue(item, counts, depth + 1, path);
  } else {
    for (const [key, item] of Object.entries(value)) {
      countStrings(key, counts);
      countValue(item, counts, depth + 1, path);
    }
  }
  path.delete(value);
}

function labelCounts(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  countValue(value, counts, 0, new Set());
  return counts;
}

/**
 * Labels in `after` that are not in `before`, per kind (strings and keys alike). Labels already in
 * the input are not counted; the result is empty when nothing was redacted.
 */
export function redactionLabelCounts(before: unknown, after: unknown): Record<string, number> {
  const was = labelCounts(before);
  const result: Record<string, number> = {};
  for (const [kind, now] of labelCounts(after)) {
    const added = now - (was.get(kind) ?? 0);
    if (added > 0) result[kind] = added;
  }
  return result;
}
