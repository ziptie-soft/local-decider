// Run against the extracted npm tarball, not the development checkout.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

const plugin = process.argv[2];
assert.ok(plugin, 'expected extracted plugin directory');
const transcript = join(dirname(plugin), 'transcript.jsonl');
writeFileSync(
  transcript,
  `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Check the current directory' } })}\n`,
);

const decision = {
  decisionId: '00000000-0000-4000-8000-000000000001',
  policy: 'permission',
  mode: 'act',
  action: 'allow',
  enforced: true,
  answers: {
    verdict: {
      type: 'choice',
      answer: 'allow',
      probabilities: { allow: 1, deny: 0 },
      confidence: 1,
    },
  },
  rule: -1,
  engine: 'fixture',
  model: 'fixture',
  latencyMs: 1,
  cached: false,
};
let response = decision;
const calls = [];
const server = createServer((req, res) => {
  calls.push(req.url);
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');

async function hook(event, payload) {
  const child = spawn('sh', [join(plugin, 'hooks/local-decider-hook.sh'), 'codex', event], {
    env: {
      ...process.env,
      LOCAL_DECIDER_URL: `http://127.0.0.1:${address.port}`,
      LOCAL_DECIDER_TIMEOUT_MS: '1000',
      LOCAL_DECIDER_HOST_POLICIES: '',
      LOCAL_DECIDER_TOKEN: '',
      LOCAL_DECIDER_GUARD: 'on',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(payload));
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(status, 0, stderr);
  return stdout;
}

try {
  const common = {
    session_id: 'pack-smoke',
    cwd: '/tmp',
    transcript_path: transcript,
    tool_name: 'Bash',
  };
  const denied = await hook('PreToolUse', {
    ...common,
    tool_input: { command: 'git push --force origin main' },
  });
  assert.equal(JSON.parse(denied).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(calls.length, 0, 'the guard must decide before contacting the gateway');

  const payload = { ...common, tool_input: { command: 'pwd' } };
  response = { ...decision, enforced: 'false' };
  assert.equal(
    await hook('PermissionRequest', payload),
    '',
    'malformed enforced value must abstain',
  );
  response = decision;
  const allowed = await hook('PermissionRequest', payload);
  assert.equal(JSON.parse(allowed).hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(calls, ['/v1/decide/permission', '/v1/decide/permission']);
  console.log('Packed Codex hook smoke test passed');
} finally {
  server.close();
}
