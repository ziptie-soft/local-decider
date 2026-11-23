import {
  canonicalJson,
  cutText,
  tokenAllowed,
  trimTrailingSlashes,
  type Question,
  type SystemOneRequest,
  type SystemOneResponse,
  type WireAnswer,
} from '@ziptie-soft/local-decider-core';
import { z } from 'zod';

import { defineEngine } from '../descriptor.ts';
import { displayUrl, postJson, type JsonRequestOptions } from '../http.ts';
import { isUnreachable, withTransientRetry } from '../retry.ts';
import { EngineError, type Engine, type EngineHealth, type EngineState } from '../types.ts';
import {
  optionMasses,
  parseTopLogprobs,
  renderPrompt,
  toWireAnswer,
  type RenderedPrompt,
  type TopLogprob,
} from './logprob.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const NO_LOGPROBS =
  'server returned no logprobs; LM Studio: use engine lmstudio (chat, maxTokens 8, /no_think), or use llama-server/Ollama/mlx_lm.server';
const START_HINT =
  'start LM Studio (lms server start), ollama serve, llama-server or mlx_lm.server';
const LM_STUDIO_AUTH_HINT =
  'LM Studio requires an API token: create one in LM Studio (Developer > Server Settings > Manage Tokens), set it as LM_API_TOKEN (or the variable named by tokenEnv) where the gateway runs, and restart the gateway';
const PROBE_QUESTION: Question = { type: 'noul', instructions: 'Say yes to confirm logprobs.' };

export const sharedShape = {
  url: z.url().default('http://127.0.0.1:1234/v1'),
  model: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^-\s][^\s]*$/),
  api: z.enum(['chat', 'completions']).default('chat'),
  maxTokens: z.number().int().min(1).max(32).default(1),
  promptSuffix: z.string().max(64).optional(),
  tokenEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
  topLogprobs: z.number().int().min(2).max(20).default(10),
  maxOptions: z.number().int().min(2).max(20).default(10),
  minCoverage: z.number().min(0).max(1).default(0.5),
  temperature: z.number().min(0.1).max(10).default(1),
  maxStateChars: z.number().int().min(1000).max(400_000).default(24_000),
  extraBody: z.record(z.string(), z.json()).default({}),
  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
};

const openaiCompatibleSchema = z.strictObject({
  type: z.literal('openai-compatible'),
  ...sharedShape,
});

/**
 * LM Studio returns logprobs only from chat completions with a few tokens, and a thinking model
 * needs `/no_think`; those are this engine's defaults.
 */
export const lmStudioSchema = z.strictObject({
  type: z.literal('lmstudio'),
  ...sharedShape,
  maxTokens: z.number().int().min(1).max(32).default(8),
  promptSuffix: z.string().max(64).default('/no_think'),
});

export type OpenAICompatibleEngineConfig =
  | z.infer<typeof openaiCompatibleSchema>
  | z.infer<typeof lmStudioSchema>;

function endpoint(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}${path}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function withSuffix(text: string, suffix: string | undefined): string {
  return suffix === undefined || suffix === '' ? text : `${text}\n${suffix}`;
}

function requestBody(config: OpenAICompatibleEngineConfig, prompt: RenderedPrompt): unknown {
  const common = {
    ...config.extraBody,
    model: config.model,
    max_tokens: config.type === 'lmstudio' ? config.maxTokens + 4 : config.maxTokens,
    temperature: 1,
    top_p: 1,
    stream: false,
  };
  return config.api === 'chat'
    ? {
        ...common,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: withSuffix(prompt.user, config.promptSuffix) },
        ],
        logprobs: true,
        top_logprobs: config.topLogprobs,
        ...(config.type === 'lmstudio' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }
    : {
        ...common,
        prompt: withSuffix(prompt.prompt, config.promptSuffix),
        logprobs: config.topLogprobs,
      };
}

function stateText(state: SystemOneRequest['state'], maxChars: number): string {
  return cutText(typeof state === 'string' ? state : canonicalJson(state), maxChars);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function responseUsage(
  response: unknown,
): { readonly input?: number; readonly output?: number } | undefined {
  const usage = record(record(response)?.['usage']);
  if (usage === undefined) {
    return undefined;
  }
  const input = tokenCount(usage['prompt_tokens']) ?? tokenCount(usage['input_tokens']);
  const output = tokenCount(usage['completion_tokens']) ?? tokenCount(usage['output_tokens']);
  return input === undefined && output === undefined
    ? undefined
    : { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
}

interface UsageTotals {
  input?: number;
  output?: number;
}

function addUsage(
  totals: UsageTotals,
  usage: { readonly input?: number; readonly output?: number } | undefined,
): void {
  if (usage?.input !== undefined) {
    totals.input = (totals.input ?? 0) + usage.input;
  }
  if (usage?.output !== undefined) {
    totals.output = (totals.output ?? 0) + usage.output;
  }
}

function systemOneResponse(
  model: string,
  answers: Record<string, WireAnswer>,
  totals: UsageTotals,
): SystemOneResponse {
  const usage = {
    ...(totals.input === undefined ? {} : { input_tokens: totals.input }),
    ...(totals.output === undefined ? {} : { output_tokens: totals.output }),
  };
  return {
    model,
    answers,
    ...(Object.keys(usage).length === 0 ? {} : { usage }),
  };
}

function lowCoverageDetail(coverage: number): string {
  return `low option coverage ${coverage.toFixed(2)} (thinking model? set extraBody)`;
}

export const openaiCompatibleEngine = defineEngine({
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  description:
    'Scores options from the logprobs of an OpenAI-compatible server you run; not calibrated',
  configSchema: openaiCompatibleSchema,
  selectable: true,
  supports: () => ({ ok: true }),
  tag: () => 'LLM',
  calibrated: false,
  models: [],
  create: (config, ctx) => new OpenAICompatibleEngine(config, ctx.env),
});

/** LM Studio's own token variable, read by its SDKs; the fallback when `tokenEnv` is unset. */
const LM_STUDIO_TOKEN_ENV = 'LM_API_TOKEN';

/**
 * The bearer token for an endpoint, only over HTTPS or loopback: the `tokenEnv` variable, or for
 * LM Studio `LM_API_TOKEN` when no variable is configured.
 */
export function endpointToken(
  engine: string,
  url: string,
  tokenEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const name = tokenEnv ?? (engine === 'lmstudio' ? LM_STUDIO_TOKEN_ENV : undefined);
  return name === undefined || !tokenAllowed(url) ? undefined : env[name];
}

/** A chat-completions or completions endpoint scored by the probability of one option token. */
export class OpenAICompatibleEngine implements Engine {
  readonly id: string;
  readonly model: string;
  readonly #config: OpenAICompatibleEngineConfig;
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  #state: EngineState = 'stopped';
  #detail: string | undefined;

  constructor(
    config: OpenAICompatibleEngineConfig,
    env: NodeJS.ProcessEnv = process.env,
    doFetch: typeof fetch = globalThis.fetch,
  ) {
    this.#config = config;
    this.id = config.type;
    this.#url = config.url;
    this.model = config.model;
    this.#fetch = doFetch;
    this.#token = endpointToken(config.type, config.url, config.tokenEnv, env);
  }

  async start(): Promise<void> {
    this.#state = 'starting';
    try {
      const response = await this.#complete(renderPrompt(PROBE_QUESTION, 'probe'));
      if (parseTopLogprobs(response).length === 0) {
        throw new EngineError(NO_LOGPROBS);
      }
      this.#state = 'ready';
      this.#detail = undefined;
    } catch (error) {
      this.#state = 'failed';
      this.#detail = this.#startFailure(error);
    }
  }

  #startFailure(error: unknown): string {
    const message = this.#errorMessage(error);
    if (message.startsWith('engine unreachable:')) {
      return `no server at ${displayUrl(this.#url)}; ${START_HINT}`;
    }
    const status = error instanceof EngineError ? error.httpFailure?.status : undefined;
    const rejected = status === 401 || status === 403;
    return rejected && this.#config.type === 'lmstudio'
      ? `${message}; ${LM_STUDIO_AUTH_HINT}`
      : message;
  }

  health(): EngineHealth {
    return {
      state: this.#state,
      model: this.model,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    };
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    if (this.#state !== 'ready') {
      throw new EngineError(`engine ${this.#state}`);
    }
    const state = stateText(request.state, this.#config.maxStateChars);
    this.#detail = undefined;
    try {
      const result = await this.#decideQuestions(request, state, signal);
      this.#state = 'ready';
      return systemOneResponse(this.model, result.answers, result.usage);
    } catch (error) {
      const message = this.#errorMessage(error);
      // HTTP errors and busy mean the server answered; only a transport failure that survived
      // the retries flips the engine.
      if (!signal.aborted && isUnreachable(error)) {
        this.#state = 'failed';
        this.#detail = message;
      }
      throw new EngineError(message);
    }
  }

  async stop(): Promise<void> {
    this.#state = 'stopped';
    this.#detail = undefined;
  }

  async #decideQuestions(
    request: SystemOneRequest,
    state: string,
    signal: AbortSignal,
  ): Promise<{ readonly answers: Record<string, WireAnswer>; readonly usage: UsageTotals }> {
    const answers: Record<string, WireAnswer> = {};
    const usage: UsageTotals = {};
    for (const [id, question] of Object.entries(request.questions)) {
      signal.throwIfAborted();
      const response = await this.#complete(renderPrompt(question, state), signal);
      addUsage(usage, responseUsage(response));
      this.#addAnswer(answers, id, question, parseTopLogprobs(response));
    }
    return { answers, usage };
  }

  #addAnswer(
    answers: Record<string, WireAnswer>,
    id: string,
    question: Question,
    entries: readonly TopLogprob[],
  ): void {
    if (entries.length === 0) {
      this.#detail = NO_LOGPROBS;
      return;
    }
    const masses = optionMasses(question, entries, this.#config);
    const answer = toWireAnswer(question, masses);
    if (answer !== undefined) {
      answers[id] = answer;
    } else if (masses !== undefined && masses.coverage < masses.minCoverage) {
      this.#detail = lowCoverageDetail(masses.coverage);
    }
  }

  #complete(prompt: RenderedPrompt, signal?: AbortSignal): Promise<unknown> {
    const path = this.#config.api === 'chat' ? '/chat/completions' : '/completions';
    const body = requestBody(this.#config, prompt);
    let timedOut = false;
    const attempt = async (): Promise<unknown> => {
      const timeout = AbortSignal.timeout(this.#config.requestTimeoutMs);
      try {
        return await postJson(
          endpoint(this.#url, path),
          body,
          this.#requestOptions(signal, timeout),
        );
      } catch (error) {
        timedOut = timeout.aborted;
        if (timedOut && isUnreachable(error)) {
          // The request may have reached the model: not a transport failure, never retried.
          throw new EngineError(
            `engine timed out after ${String(this.#config.requestTimeoutMs)} ms`,
          );
        }
        throw error;
      }
    };
    // Only a transport failure is retried: the request never reached a model, so no tokens ran.
    return withTransientRetry(attempt, signal, {
      isTransient: (e) => !timedOut && isUnreachable(e),
    });
  }

  #requestOptions(signal: AbortSignal | undefined, timeout: AbortSignal): JsonRequestOptions {
    return {
      token: this.#token,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      maxBytes: MAX_RESPONSE_BYTES,
      fetch: this.#fetch,
    };
  }

  #errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.#token === undefined || this.#token === ''
      ? message
      : message.replaceAll(this.#token, '[REDACTED]');
  }
}
