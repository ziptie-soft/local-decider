/**
 * The file paths a Codex `apply_patch` call touches. A single linear pass with no regular
 * expressions, so a padded payload cannot make it slow. No `node:` imports.
 */
const MARKERS = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '];

/**
 * Targets named by the patch's file header lines, in order; `[]` when there are none; `null` when
 * there are more than `max`. Scans even without `*** Begin Patch` (a heredoc may wrap the patch).
 */
export function patchTargets(text: string, max = 256): string[] | null {
  const targets: string[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end).trim();
    const marker = MARKERS.find((m) => line.startsWith(m));
    if (marker !== undefined) {
      if (targets.length >= max) {
        return null;
      }
      targets.push(line.slice(marker.length).trim());
    }
    start = end + 1;
  }
  return targets;
}
