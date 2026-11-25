import type { PiContext } from './pi-types.ts';

/** The title's first line is shown as the terminal status, so keep it short. */
export const MAX_TITLE_CHARS = 80;
/** Bound on the detail so one huge command cannot flood the dialog. */
const MAX_DETAIL_CHARS = 2000;

const ALLOW = 'Allow once';
const BLOCK = 'Block';

export type PermissionAnswer = 'allow' | 'decline' | 'unavailable';

export interface PermissionRequest {
  title: string;
  detail: string;
}

export interface PermissionOptions {
  timeoutMs: number;
}

// OSC (to BEL or ST), CSI, and other two-character escape sequences.
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\[[0-?]*[ -/]*[@-~]?|[@-Z\\-_])/g;
// C0 controls (except tab and newline), DEL and C1 controls.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Make untrusted text safe to show in a terminal: strip ANSI escapes and control characters, then
 * truncate to `max` characters with an ellipsis. Newlines and tabs survive only when `multiline`
 * is set; otherwise they become spaces.
 */
export function sanitizeForDisplay(
  text: string,
  max: number,
  options: { multiline?: boolean } = {},
): string {
  let clean = text.replace(ANSI, '').replace(/\r\n?/g, '\n');
  clean = options.multiline ? clean.replace(/\t/g, '  ') : clean.replace(/\s+/g, ' ').trim();
  clean = clean.replace(CONTROL, '');
  return truncate(clean, max);
}

function buildSignal(ctx: PiContext, timeoutMs: number): AbortSignal {
  const signals: AbortSignal[] = [];
  if (ctx.signal !== undefined) signals.push(ctx.signal);
  signals.push(AbortSignal.timeout(Math.max(1, timeoutMs)));
  return AbortSignal.any(signals);
}

/**
 * Ask the user whether a tool call may run. `unavailable` means no answer could be asked (headless
 * or the dialog failed), so the caller decides the fallback; an abort or timeout is a `decline`.
 */
export async function askPermission(
  ctx: PiContext,
  request: PermissionRequest,
  options: PermissionOptions,
): Promise<PermissionAnswer> {
  if (!ctx.hasUI) return 'unavailable';
  const title = sanitizeForDisplay(request.title, MAX_TITLE_CHARS);
  const detail = sanitizeForDisplay(request.detail, MAX_DETAIL_CHARS, { multiline: true });
  const signal = buildSignal(ctx, options.timeoutMs);
  try {
    const choice = await ctx.ui.select(`${title}\n${detail}`, [ALLOW, BLOCK], {
      blockedKind: 'permission',
      signal,
      timeout: Math.max(1, options.timeoutMs),
    });
    return choice === ALLOW && !signal.aborted ? 'allow' : 'decline';
  } catch {
    return signal.aborted ? 'decline' : 'unavailable';
  }
}
