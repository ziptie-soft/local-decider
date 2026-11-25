/**
 * Caps on the policy input keys a client sends, applied once per client path before the body is
 * serialised. A multi-megabyte `tool_input` must not become a multi-megabyte request: the gateway
 * truncates again for the model, but it should never have to receive the excess. No node imports:
 * the Paseo plugin vendors this file with `truncate.ts` and `canonical.ts`.
 */
import { canonicalJson } from './canonical.ts';
import { cutText, type KeepSide } from './truncate.ts';

/** Per-key caps in characters. */
export const INPUT_CAPS: Readonly<Record<string, number>> = {
  project: 1024,
  tool: 512,
  task: 4000,
  history: 8000,
  request: 8000,
  command: 8000,
  prompt: 6000,
  lastMessage: 6000,
  subject: 4096,
};

const DEFAULT_CAP = 6000;

/** Keys whose most recent end matters more than the start. */
const KEEP_TAIL = new Set(['history']);

function serialise(value: unknown): string {
  try {
    return typeof value === 'string' ? value : canonicalJson(value);
  } catch {
    return '';
  }
}

function capValue(key: string, value: unknown): unknown {
  const cap = INPUT_CAPS[key] ?? DEFAULT_CAP;
  const text = serialise(value);
  if (text.length <= cap) {
    return value;
  }
  const keep: KeepSide = KEEP_TAIL.has(key) ? 'tail' : 'ends';
  return cutText(text, cap, keep);
}

/**
 * Cap every key of a policy input. Strings over their cap keep both ends (`history` keeps its
 * tail) with the truncation marker; objects are serialised canonically first. A `subject` over
 * its cap is dropped, which disables precedent for that call rather than matching a cut subject.
 * Objects within their cap are kept as they are; numbers and booleans pass through.
 */
export function capInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      value === undefined ||
      value === null ||
      (typeof value !== 'object' && typeof value !== 'string')
    ) {
      out[key] = value;
    } else if (key === 'subject') {
      const text = serialise(value);
      if (text.length <= (INPUT_CAPS['subject'] ?? DEFAULT_CAP)) {
        out[key] = value;
      }
    } else {
      out[key] = capValue(key, value);
    }
  }
  return out;
}
