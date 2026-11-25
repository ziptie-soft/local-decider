/**
 * Structural types for the slice of the pi extension API this package uses. pi is not a dependency
 * (pi loads the extension itself and supplies the objects), so these mirror pi's types, narrowed to
 * what we call or read. Each comment cites the pi source it was checked against: pi v1.6.1,
 * `packages/coding-agent/src/core/extensions/types.ts` (written `types.ts`), `session-manager.ts`
 * and `packages/ai/src/types.ts` (written `ai/types.ts`).
 *
 * Mirrors only: when pi changes, update the types here, not the callers.
 */

// ---------------------------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------------------------

/**
 * The `tool_call` event, fired after argument validation and before execution. `toolName` and
 * `input` are a union per built-in tool in pi (types.ts:1222-1300); we read them untyped and
 * classify by name. `input` is mutable and not revalidated. `parentToolCallId` is set when another
 * tool (a codemode script) issued the call, whose `toolCallId` is then `<parent id>/<n>`
 * (types.ts:1222-1232, 409-420).
 */
export interface ToolCallEvent {
  type: 'tool_call';
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Return value of a `tool_call` handler: `block` stops execution (types.ts:1483-1491). */
export interface ToolCallResult {
  block?: boolean;
  reason?: string;
  /** Stop the agent after the batch when every blocked result in it sets this. */
  terminate?: boolean;
}

// ---------------------------------------------------------------------------------------------
// UI and context
// ---------------------------------------------------------------------------------------------

/**
 * Options for the dialog methods (types.ts:116-126). `timeout` auto-dismisses the dialog (select
 * then resolves `undefined`). `blockedKind` is reported as the program status with the first line
 * of the title; pi's own default is `'question'` for `select`. Its type is `ProgramStatus['kind']`
 * in pi; we only use `'permission'`, the others listed are the ones we saw in pi's docs.
 */
export interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
  blockedKind?: 'permission' | 'question' | 'auth';
}

/** `ctx.ui` (types.ts:169-180, 186): the members we call. */
export interface PiUI {
  /** Resolves the chosen option, or `undefined` on Esc, timeout or abort. */
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  /** `undefined` clears the status. */
  setStatus(key: string, text: string | undefined): void;
}

/** `ctx.mode` (types.ts:349). `hasUI` is false in print and json mode. */
export type PiMode = 'tui' | 'rpc' | 'json' | 'print';

/**
 * `ctx.sessionManager` (types.ts:361, session-manager.ts:245-262 `ReadonlySessionManager`):
 * getSessionId() at session-manager.ts:1164, getCwd() at :1152, buildContextEntries() at :1507.
 */
export interface PiSessionManager {
  getSessionId(): string;
  getCwd(): string;
  /** The entries that make up the model's context for the current branch, oldest first. */
  buildContextEntries(): readonly PiSessionEntry[];
}

/**
 * `ExtensionContext` (types.ts:351-391): the members we read. Discrepancy: pi declares `signal` as
 * `AbortSignal | undefined` (present, possibly undefined; undefined when the agent is not
 * streaming), the plan called it optional.
 */
export interface PiContext {
  ui: PiUI;
  mode: PiMode;
  hasUI: boolean;
  cwd: string;
  signal?: AbortSignal | undefined;
  sessionManager: PiSessionManager;
}

// ---------------------------------------------------------------------------------------------
// Session entries (what buildContextEntries() returns)
// ---------------------------------------------------------------------------------------------

/** `TextContent` (ai/types.ts:436-440). */
export interface PiTextContent {
  type: 'text';
  text: string;
}

/** `ImageContent` (ai/types.ts:452-456). */
export interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * `UserMessage` (ai/types.ts:593-597): `content` is a string or text and image parts.
 */
export interface PiUserMessage {
  role: 'user';
  content: string | readonly (PiTextContent | PiImageContent)[];
  timestamp: number;
}

/**
 * `AssistantMessage` (ai/types.ts:599-629): parts are text, thinking and tool calls. We type the
 * parts as `{ type: string }` plus an optional `text`, so extraction reads `type === 'text'`.
 */
export interface PiAssistantMessage {
  role: 'assistant';
  content: readonly { type: string; text?: string }[];
  timestamp: number;
}

/**
 * Any other `AgentMessage` (ai/types.ts:673 `Message` also has `system` and `toolResult`; apps can
 * add custom roles, agent types.ts:374): only the role is relied on.
 */
export interface PiOtherMessage {
  role: string;
  content?: unknown;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiOtherMessage;

/** `SessionMessageEntry` (session-manager.ts:64-67), carried inside every `SessionEntry`. */
export interface PiSessionMessageEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  /** ISO timestamp (session-manager.ts:57-62). */
  timestamp: string;
  message: PiMessage;
}

/**
 * `SessionEntry` (session-manager.ts:183-194) is a union of message, thinking_level_change,
 * model_change, usage, compaction, branch_summary, custom, custom_message, context_edit, label and
 * session_info entries. Only `message` entries matter here; the others are matched by `type`.
 */
export interface PiOtherSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type PiSessionEntry = PiSessionMessageEntry | PiOtherSessionEntry;

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** `session_start` (types.ts:781-787): startup, reload, new, resume or fork. */
export interface SessionStartEvent {
  type: 'session_start';
  reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
  previousSessionFile?: string;
}

/**
 * `session_shutdown` (types.ts:850-855): fired before the extension runtime is torn down for quit,
 * reload or session replacement (new, resume, fork).
 */
export interface SessionShutdownEvent {
  type: 'session_shutdown';
  reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork';
  targetSessionFile?: string;
}

/** `session_before_switch` (types.ts:797-801): before `new` or `resume`; cancellable in pi. */
export interface SessionBeforeSwitchEvent {
  type: 'session_before_switch';
  reason: 'new' | 'resume';
  targetSessionFile?: string;
}

/** `session_before_fork` (types.ts:804-808); cancellable in pi. */
export interface SessionBeforeForkEvent {
  type: 'session_before_fork';
  entryId: string;
  position: 'before' | 'at';
}

/**
 * Every event name we may listen to (pi's session event names are `session_start`,
 * `session_before_switch`, `session_before_fork`, `session_shutdown`; there is no
 * `session_switch` or `session_fork`). Prefer `session_shutdown` plus `session_start` for state
 * resets: pi tears the runtime down and starts it again on new, resume, fork and reload.
 */
export interface PiEventMap {
  tool_call: ToolCallEvent;
  session_start: SessionStartEvent;
  session_shutdown: SessionShutdownEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_fork: SessionBeforeForkEvent;
}

export type PiEventName = keyof PiEventMap;

/** Handler result per event: only `tool_call` has one we use (types.ts:1715, 1641). */
export interface PiEventResultMap {
  tool_call: ToolCallResult | undefined;
  session_start: undefined;
  session_shutdown: undefined;
  session_before_switch: undefined;
  session_before_fork: undefined;
}

/**
 * `ExtensionHandler<E, R>` (types.ts:1641): `(event, ctx) => Promise<R | void> | R | void`.
 * Handlers run in load order and for `tool_call` the first block wins. pi has no runner timeout
 * and an uncaught error in a `tool_call` handler blocks the tool.
 */
export type PiHandler<N extends PiEventName> = (
  event: PiEventMap[N],
  ctx: PiContext,
) => Promise<PiEventResultMap[N] | void> | PiEventResultMap[N] | void;

// ---------------------------------------------------------------------------------------------
// Commands and flags
// ---------------------------------------------------------------------------------------------

/** `RegisteredCommand.handler` (types.ts:1623-1630): `args` is the raw text after the name. */
export type PiCommandHandler = (args: string, ctx: PiContext) => Promise<void>;

/** `registerCommand` options (types.ts:1734: `Omit<RegisteredCommand, 'name' | 'sourceInfo'>`). */
export interface PiCommandOptions {
  description?: string;
  handler: PiCommandHandler;
}

/** `registerFlag` options (types.ts:1746-1760): a boolean or string flag. */
export type PiFlagOptions =
  | { description?: string; type: 'boolean'; default?: boolean }
  | { description?: string; type: 'string'; default?: string };

// ---------------------------------------------------------------------------------------------
// Classifier provider (ai/types.ts:696-762, 363-376, 920-925; types.ts:1988-2096)
// ---------------------------------------------------------------------------------------------

/** `JsonValue` / `JsonObject` (ai/types.ts:504-506). */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** `ClassifierChoiceQuestion` (ai/types.ts:696-700). */
export interface ClassifierChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** `ClassifierScoreQuestion` (ai/types.ts:702-706). */
export interface ClassifierScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

/** `ClassifierBoolQuestion` (ai/types.ts:708-712). */
export interface ClassifierBoolQuestion {
  type: 'bool';
  instructions: string;
  criteria: { true: string; false: string };
}

export type ClassifierQuestion =
  | ClassifierChoiceQuestion
  | ClassifierScoreQuestion
  | ClassifierBoolQuestion;

/** `ClassifierContext` (ai/types.ts:716-724): `images` is only accepted by image-input models. */
export interface ClassifierContext {
  state: JsonObject;
  images?: PiImageContent[];
  questions: Record<string, ClassifierQuestion>;
}

/** `ClassifierChoiceAnswer` (ai/types.ts:726-731). */
export interface ClassifierChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** `ClassifierScoreAnswer` (ai/types.ts:733-737). */
export interface ClassifierScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
}

/** `ClassifierBoolAnswer` (ai/types.ts:739-742). */
export interface ClassifierBoolAnswer {
  type: 'bool';
  probability: number;
}

export type ClassifierAnswer =
  | ClassifierChoiceAnswer
  | ClassifierScoreAnswer
  | ClassifierBoolAnswer;

/** `ClassifierStopReason` (ai/types.ts:745). */
export type ClassifierStopReason = 'stop' | 'error' | 'aborted';

/** `Usage` (ai/types.ts:473-499): all of input, output, cache and cost are required. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    totalFromProvider?: boolean;
  };
}

/**
 * `ClassifierResult` (ai/types.ts:747-762): `api`, `provider`, `model`, `answers`, `stopReason`
 * and `timestamp` (ms since the epoch) are required on success and on error alike.
 */
export interface ClassifierResult {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  usage?: Usage;
  responseId?: string;
  stopReason: ClassifierStopReason;
  errorMessage?: string;
  timestamp: number;
}

/**
 * `ClassifierModel` (ai/types.ts:920-925 on `BaseModel`, ai/types.ts:861-872): the model object pi
 * passes to `classify`. `cost` is `ModelCost` in pi; we only need it to be an opaque record.
 */
export interface ClassifierModel {
  type: 'classifier';
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  input: ('text' | 'image')[];
  contextWindow: number;
  cost: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** `ClassifierOptions` (ai/types.ts:371-377, 164-176): the members we read. */
export interface ClassifierOptions {
  signal?: AbortSignal;
  apiKey?: string;
  temperature?: number;
}

/** `ProviderClassifier` (ai/types.ts:363-369): a provider's `classifiers[api]` entry. */
export interface PiProviderClassifier {
  classify(
    model: ClassifierModel,
    context: ClassifierContext,
    options?: ClassifierOptions,
  ): Promise<ClassifierResult>;
}

/**
 * `ProviderClassifierModelConfig` (types.ts:2092-2096 on `ProviderModelConfigBase`,
 * types.ts:2067-2080): `type: 'classifier'`, `contextWindow` required; `input` and `cost` come
 * from the base. `cost` is `ModelCost` in pi (per-million-token rates); zeros are accepted.
 */
export interface PiClassifierModelConfig {
  type: 'classifier';
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  input: ('text' | 'image')[];
  contextWindow: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  headers?: Record<string, string>;
}

/**
 * `ProviderConfig` (types.ts:1988-2046), narrowed to a keyless classifier provider. pi requires
 * `baseUrl` and `apiKey` when `models` is set (types.ts:1992-1996); `classifiers` is keyed by the
 * classifier api name. See `docs/research/pi-plugin-plan.md` for the placeholder-key note.
 */
export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: PiClassifierModelConfig[];
  classifiers?: Record<string, PiProviderClassifier>;
}

// ---------------------------------------------------------------------------------------------
// ExtensionAPI
// ---------------------------------------------------------------------------------------------

/**
 * `ExtensionAPI` (types.ts:1646-1931): only the members we call. `on` returns an unsubscribe
 * function (types.ts:1656, 1715); `getFlag` returns `boolean | string | undefined` (types.ts:1762);
 * `registerProvider(name, config)` is the second overload at types.ts:1916. The factory receives
 * this as `pi` and may be async (types.ts:2102).
 */
export interface PiAPI {
  on<N extends PiEventName>(event: N, handler: PiHandler<N>): () => void;
  registerFlag(name: string, options: PiFlagOptions): void;
  getFlag(name: string): boolean | string | undefined;
  registerCommand(name: string, options: PiCommandOptions): void;
  registerProvider(name: string, config: PiProviderConfig): void;
}
