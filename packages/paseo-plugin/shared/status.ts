/** What the status RPC returns: the gateway's `/health` as the plugin reads it. */
import { z } from 'zod';

import { progressSchema } from './machine.ts';
import { policyEngineSchema } from './policy-models.ts';

export const statusSchema = z.object({
  up: z.boolean(),
  status: z.enum(['ok', 'degraded', 'down']),
  engine: z.string().nullable(),
  engineTag: z.string().nullable(),
  /** `stopped|starting|ready|failed`, and why when not ready. */
  engineState: z.string().nullable(),
  detail: z.string().nullable(),
  model: z.string().nullable(),
  p50Ms: z.number().nullable(),
  /** Progress of a running benchmark, from `/health`; null otherwise. */
  benchmark: progressSchema.nullable(),
  /** The decisions with their own model, from `/health`; undefined from an older gateway. */
  policyEngines: z.array(policyEngineSchema).optional().catch(undefined),
  gatewayUrl: z.string(),
  /** The Unix socket the plugin reaches the gateway over; null over TCP or from an older plugin. */
  socket: z.string().nullable().default(null),
  /** Consecutive failed checks, for client-side backoff. */
  downStreak: z.number().int(),
  checkedAt: z.string(),
  launch: z
    .object({
      ok: z.boolean(),
      status: z.string(),
      message: z.string(),
      guideUrl: z.string().optional(),
    })
    .nullable(),
});

export type Status = z.output<typeof statusSchema>;
