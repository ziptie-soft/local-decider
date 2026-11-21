import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpOpen, parsePolicy, type DecideResponse } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMcpServer, parseMcpPolicies, policyInfo, type McpBackend } from '../src/mcp.ts';

function policy(id: string, extra = ''): ReturnType<typeof parsePolicy> {
  return parsePolicy(`
id: ${id}
version: 2
description: ${id} test
${extra}
state:
  maxTokens: 1000
  sections:
    - { label: Request, from: request }
questions:
  verdict:
    type: choice
    instructions: Judge.
    criteria: { allow: allow, ask: ask }
rules:
  - when: { question: verdict, answer: allow, minProbability: 0.8 }
    action: allow
default: ask
`);
}

const POLICIES = [
  policy('permission', 'mcp: false'),
  policy('command-risk', 'mcp: false'),
  policy('turn-outcome'),
];

async function connect(called: string[]): Promise<Client> {
  const backend: McpBackend = {
    async decide(id) {
      called.push(id);
      return { policy: id, action: 'allow' } as unknown as DecideResponse;
    },
    listPolicies: async () => POLICIES.map(policyInfo),
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(backend).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

describe('MCP tools', () => {
  it('refuses policies that harness hooks enforce', async () => {
    const called: string[] = [];
    const client = await connect(called);
    for (const id of ['permission', 'command-risk']) {
      const result = await client.callTool({
        name: 'decide',
        arguments: { policy: id, input: { request: 'ls' } },
      });
      assert.equal(result['isError'], true);
      assert.match(text(result), /not available through MCP/);
    }
    assert.deepEqual(called, []);
  });

  it('runs other policies', async () => {
    const called: string[] = [];
    const client = await connect(called);
    const result = await client.callTool({
      name: 'decide',
      arguments: { policy: 'turn-outcome', input: { request: 'x' } },
    });
    assert.notEqual(result['isError'], true);
    assert.deepEqual(called, ['turn-outcome']);
  });

  it('lists only open policies, with questions and options but no thresholds', async () => {
    const client = await connect([]);
    const raw = text(await client.callTool({ name: 'policies', arguments: {} }));
    const listed = JSON.parse(raw) as { id: string; questions: Record<string, unknown> }[];
    assert.deepEqual(
      listed.map((p) => p.id),
      ['turn-outcome'],
    );
    assert.deepEqual(listed[0]?.questions, {
      verdict: { instructions: 'Judge.', options: ['allow', 'ask'] },
    });
    assert.doesNotMatch(raw, /minProbability|threshold|rules|precedent|calibration/i);
  });

  it('defaults mcp to true', () => {
    assert.equal(mcpOpen(policy('plain')), true);
    assert.equal(mcpOpen(policy('closed', 'mcp: false')), false);
  });

  it('fails closed when an older gateway omits the mcp flag', async () => {
    const old = [{ id: 'turn-outcome', description: 'd', questions: {} }, 'junk', null];
    const parsed = parseMcpPolicies(old);
    assert.deepEqual(
      parsed.map((p) => [p.id, p.mcp]),
      [['turn-outcome', false]],
    );
    assert.deepEqual(parseMcpPolicies({ not: 'an array' }), []);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer({
      decide: async () => assert.fail('must not run'),
      listPolicies: async () => parsed,
    }).connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const result = await client.callTool({
      name: 'decide',
      arguments: { policy: 'turn-outcome', input: {} },
    });
    assert.equal(result['isError'], true);
    assert.match(text(result), /predates the mcp flag/);
  });
});
