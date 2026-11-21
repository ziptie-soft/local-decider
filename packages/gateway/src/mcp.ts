import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  mcpOpen,
  type DecideRequest,
  type DecideResponse,
  type Policy,
} from '@ziptie-soft/local-decider-core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import type { Decider } from './decider.ts';
import { GATEWAY_VERSION } from './version.ts';

/** One question a policy asks, without its criteria text, rules or thresholds. */
export interface McpQuestionInfo {
  readonly instructions: string;
  readonly options: readonly string[];
}

/** What a policy shows to MCP clients: id, description, questions and their options. */
export interface McpPolicyInfo {
  readonly id: string;
  readonly description: string;
  /** False for policies a harness hook enforces; MCP neither lists nor runs them. */
  readonly mcp: boolean;
  readonly questions: Readonly<Record<string, McpQuestionInfo>>;
}

function optionsOf(question: Policy['questions'][string]): string[] {
  if (question.type === 'noul') {
    return ['true', 'false'];
  }
  return Array.isArray(question.criteria) ? [...question.criteria] : Object.keys(question.criteria);
}

/** The MCP-safe view of a policy; also the `questions` and `mcp` fields of `GET /v1/policies`. */
export function policyInfo(policy: Policy): McpPolicyInfo {
  return {
    id: policy.id,
    description: policy.description,
    mcp: mcpOpen(policy),
    questions: Object.fromEntries(
      Object.entries(policy.questions).map(([id, question]) => [
        id,
        { instructions: question.instructions, options: optionsOf(question) },
      ]),
    ),
  };
}

/**
 * Reads `GET /v1/policies` into MCP views. A policy without `mcp: true` (an older gateway) counts
 * as closed, so the stdio server fails closed.
 */
export function parseMcpPolicies(body: unknown): McpPolicyInfo[] {
  if (!Array.isArray(body)) {
    return [];
  }
  return body.flatMap((entry: unknown) => {
    const e = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    if (typeof e['id'] !== 'string' || typeof e['description'] !== 'string') {
      return [];
    }
    const questions = e['questions'];
    return [
      {
        id: e['id'],
        description: e['description'],
        mcp: e['mcp'] === true,
        questions:
          typeof questions === 'object' && questions !== null
            ? (questions as Record<string, McpQuestionInfo>)
            : {},
      },
    ];
  });
}

/** What the MCP tools need: the in-process decider, or a client of a running gateway. */
export interface McpBackend {
  decide(policy: string, request: DecideRequest, signal: AbortSignal): Promise<DecideResponse>;
  /** Every loaded policy, hook-enforced ones included (`mcp: false`); the tools filter them. */
  listPolicies(): Promise<readonly McpPolicyInfo[]>;
}

export function deciderBackend(decider: Decider): McpBackend {
  return {
    decide: (policy, request, signal) => decider.decide(policy, request, signal),
    listPolicies: async () =>
      [...decider.policies.values()].map(({ policy }) => policyInfo(policy)),
  };
}

/** Throws a tool error when `policy` is loaded but not open to MCP callers. */
async function assertMcpPolicy(backend: McpBackend, policy: string): Promise<void> {
  const found = (await backend.listPolicies()).find((p) => p.id === policy);
  if (found !== undefined && !found.mcp) {
    throw new Error(
      `policy "${policy}" is not available through MCP (enforced by harness hooks, or the gateway ` +
        'predates the mcp flag and must be updated); see the policies tool for the ones you can call',
    );
  }
}

function toolResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** One MCP server exposing `decide` (run a policy) and `policies` (list them). */
export function createMcpServer(backend: McpBackend): McpServer {
  const server = new McpServer({ name: 'local-decider', version: GATEWAY_VERSION });
  server.registerTool(
    'decide',
    {
      title: 'Local decision model',
      description:
        'Ask the local decision model a fixed-choice question through a policy. Returns the action, ' +
        'per-option probabilities and a calibrated confidence. Fast and local; no free text.',
      inputSchema: {
        policy: z
          .string()
          .describe('Policy id, e.g. turn-outcome, permission, routing, command-risk'),
        input: z
          .record(z.string(), z.unknown())
          .describe(
            "Structured input; keys follow the policy's state sections (see the policies tool)",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ policy, input }, extra) => {
      await assertMcpPolicy(backend, policy);
      const decision = await backend.decide(policy, { harness: 'mcp', input }, extra.signal);
      return toolResult(decision);
    },
  );
  server.registerTool(
    'policies',
    {
      title: 'List decision policies',
      description:
        'List the policies you can call: id, description, and each question with its options.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      toolResult(
        (await backend.listPolicies())
          .filter((p) => p.mcp)
          .map(({ id, description, questions }) => ({ id, description, questions })),
      ),
  );
  return server;
}

/** Stateless streamable HTTP: a fresh server and transport per request. */
export async function handleMcpHttp(
  decider: Decider,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(deciderBackend(decider));
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no sessionIdGenerator = stateless;
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function serveMcpStdio(backend: McpBackend): Promise<void> {
  await createMcpServer(backend).connect(new StdioServerTransport());
}
