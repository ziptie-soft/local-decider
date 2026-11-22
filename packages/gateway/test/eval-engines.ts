import {
  inputHash,
  type SystemOneRequest,
  type SystemOneResponse,
  type WireAnswer,
} from '@ziptie-soft/local-decider-core';

import { EngineError, type Engine, type EngineHealth } from '../src/engines/types.ts';

/** What the model saw: the state and the questions. The model name is not part of the key. */
export function recordingKey(request: SystemOneRequest): string {
  return inputHash({ state: request.state, questions: request.questions });
}

export interface RecordedCase {
  readonly id: string;
  readonly answers: Readonly<Record<string, WireAnswer>>;
}

export interface Recording {
  readonly version: 1;
  readonly engine: string;
  readonly model: string;
  readonly device?: string;
  readonly recordedAt: string;
  readonly cases: Readonly<Record<string, RecordedCase>>;
}

/** Answers from a recording; a request nobody recorded throws `EngineError('no recording')`. */
export class ReplayEngine implements Engine {
  readonly id: string;
  readonly model: string;
  /** Recording keys that answered a request. */
  readonly used = new Set<string>();
  readonly #recording: Recording;

  constructor(recording: Recording) {
    this.#recording = recording;
    this.id = recording.engine;
    this.model = recording.model;
  }

  async start(): Promise<void> {}

  health(): EngineHealth {
    return { state: 'ready', model: this.model };
  }

  async decide(request: SystemOneRequest): Promise<SystemOneResponse> {
    const key = recordingKey(request);
    const recorded = this.#recording.cases[key];
    if (recorded === undefined) {
      throw new EngineError('no recording');
    }
    this.used.add(key);
    return { model: this.model, answers: recorded.answers };
  }

  async stop(): Promise<void> {}
}

/** Wraps an engine and keeps each answer by recording key. Latency and usage are dropped. */
export class RecordingEngine implements Engine {
  readonly id: string;
  readonly model: string;
  /** The case id stored with the next answer; set it before each decision. */
  label = '';
  readonly cases = new Map<string, RecordedCase>();
  readonly #inner: Engine;

  constructor(inner: Engine) {
    this.#inner = inner;
    this.id = inner.id;
    this.model = inner.model;
  }

  async start(): Promise<void> {
    await this.#inner.start();
  }

  health(): EngineHealth {
    return this.#inner.health();
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    const response = await this.#inner.decide(request, signal);
    this.cases.set(recordingKey(request), { id: this.label, answers: response.answers });
    return response;
  }

  async stop(): Promise<void> {
    await this.#inner.stop();
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** Pretty JSON with sorted keys and cases ordered by id, so diffs between recordings stay small. */
export function serializeRecording(recording: Recording): string {
  const byId = Object.entries(recording.cases).toSorted(([, a], [, b]) => compare(a.id, b.id));
  const ordered = {
    version: recording.version,
    engine: recording.engine,
    model: recording.model,
    ...(recording.device === undefined ? {} : { device: recording.device }),
    recordedAt: recording.recordedAt,
    cases: Object.fromEntries(
      byId.map(([key, item]) => [key, { id: item.id, answers: sortKeys(item.answers) }]),
    ),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
