/**
 * The gateway's decision kinds as the settings and the popover describe them. Askers and budgets
 * mirror hooks `mapping.ts` `EVENT_POLICY`, pi-plugin `gate.ts`, and the Paseo constants
 * `PERMISSION_DEADLINE_MS` (server/permission.ts), `ROUTING_BUDGET_MS` (server/routing.ts) and
 * `DECIDE_TIMEOUT_MS` (server/turn.ts); test/decision-kinds.test.ts catches drift.
 */
import type { GatewayPolicy, PluginMode } from './constants.ts';

export interface DecisionKindInfo {
  title: string;
  decides: string;
  askedBy: string;
  /** True when the plugin keeps its own mode for the kind (a hook policy). */
  pluginMode: boolean;
  /** What each mode means for this kind. */
  modes: Readonly<Record<PluginMode, string>>;
  /** Decision budgets in ms: the 1000 ms hooks, and Paseo's own (null: Paseo never asks). */
  budgets: { hooks: number; paseo: number | null };
}

export const DECISION_KINDS: Readonly<Record<GatewayPolicy, DecisionKindInfo>> = {
  'command-risk': {
    title: 'Command risk',
    decides: 'Flags risky shell commands and tool calls before they run.',
    askedBy: 'Asked by Claude Code, Codex and pi before each tool call, also inside Paseo agents.',
    pluginMode: false,
    modes: {
      off: 'Off: adds no prompts. Claude Code, Codex and pi still ask by their own permission rules.',
      shadow: 'Shadow: rates every call and records it; nothing is asked or blocked.',
      act: 'Act: asks you before calls it rates risky and blocks ones it rates dangerous. It never approves anything.',
    },
    budgets: { hooks: 1000, paseo: null },
  },
  'permission': {
    title: 'Permission',
    decides: 'Decides whether a permission request can be approved without asking you.',
    askedBy: 'Asked by Paseo, Claude Code and Codex when an agent requests permission.',
    pluginMode: true,
    modes: {
      off: 'Off: every permission request waits for you.',
      shadow: 'Shadow: records what it would approve; every request still waits for you.',
      act: 'Act: approves requests it is sure are safe; the rest wait for you.',
    },
    budgets: { hooks: 1000, paseo: 9500 },
  },
  'routing': {
    title: 'Routing',
    decides: 'Picks the model tier a new task starts on.',
    askedBy:
      'Asked by Paseo when a new agent starts, and by Claude Code and Codex when you send a prompt.',
    pluginMode: true,
    modes: {
      off: 'Off: new agents start on the model you chose.',
      shadow: 'Shadow: records the tier it would pick; agents start on the model you chose.',
      act: 'Act: new agents start on the preset the routing policy picks (see Routing).',
    },
    budgets: { hooks: 1000, paseo: 1500 },
  },
  'turn-outcome': {
    title: 'Turn outcome',
    decides: "Classifies how an agent's turn ended: done, needs input, stuck or failed.",
    askedBy:
      "Asked by Paseo when an agent's turn ends, and by Claude Code and Codex when a turn or subagent finishes.",
    pluginMode: true,
    modes: {
      off: 'Off: turns are not classified.',
      shadow: 'Shadow: records how each turn ended; the chat is unchanged.',
      act: 'Act: adds a note to the decision row in the chat when the agent waits for you, looks stuck or reports a failure.',
    },
    budgets: { hooks: 1000, paseo: 59_500 },
  },
};
