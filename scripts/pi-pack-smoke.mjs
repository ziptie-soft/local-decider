// Run against the extracted npm tarball of packages/pi-plugin, not the development checkout.
// Imports the shipped TypeScript entry (Node strips types outside node_modules) and activates it
// with a fake pi API that records registrations. Activation must not use the network.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = process.argv[2];
assert.ok(pkg, 'expected extracted package directory');

let fetches = 0;
globalThis.fetch = () => {
  fetches++;
  throw new Error('activation must not call fetch');
};

const calls = [];
const pi = new Proxy(
  {},
  {
    get: (_target, method) => {
      if (typeof method !== 'string') return undefined;
      return (...args) => {
        calls.push({ method, args });
        return undefined;
      };
    },
  },
);

const mod = await import(pathToFileURL(join(pkg, 'extension/index.ts')).href);
assert.equal(typeof mod.default, 'function', 'default export must be the extension factory');
mod.default(pi);

const registered = (method, name) => calls.some((c) => c.method === method && c.args[0] === name);
assert.ok(registered('on', 'tool_call'), 'must register a tool_call handler');
assert.ok(registered('on', 'session_start'), 'must register a session_start handler');
assert.ok(registered('registerFlag', 'local-decider-mode'), 'must register the mode flag');
assert.ok(registered('registerCommand', 'local-decider'), 'must register the command');
assert.equal(fetches, 0, 'activation must not call fetch');
console.log('Packed pi extension smoke test passed');
