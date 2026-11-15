#!/usr/bin/env node
// Stand-in for the user in the harness e2e run: a Claude Code PermissionRequest command hook that
// denies `chmod` and allows everything else, so the run exercises both verdicts without a human.
// harness-e2e.mjs passes it to `claude` through `--settings`; it is never installed anywhere.
//
// Reads the hook payload from stdin and appends `{ts, tool_name, behavior, command}` (command cut
// to 40 characters, no other tool input) to $LD_E2E_APPROVER_LOG when that is set.
import { appendFileSync } from 'node:fs';

const LOG_COMMAND_CHARS = 40;

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function bashCommand(input) {
  const command = input.tool_input?.command;
  return input.tool_name === 'Bash' && typeof command === 'string' ? command.trim() : '';
}

function record(entry) {
  const log = process.env.LD_E2E_APPROVER_LOG;
  if (!log) {
    return;
  }
  try {
    appendFileSync(log, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Logging is best effort; the verdict still goes out.
  }
}

const input = await readInput();
const command = bashCommand(input);
const decision = /^chmod(\s|$)/.test(command)
  ? { behavior: 'deny', message: 'e2e approver denies chmod' }
  : { behavior: 'allow' };
record({
  ts: new Date().toISOString(),
  tool_name: typeof input.tool_name === 'string' ? input.tool_name : '',
  behavior: decision.behavior,
  ...(command ? { command: command.slice(0, LOG_COMMAND_CHARS) } : {}),
});
process.stdout.write(
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`,
);
