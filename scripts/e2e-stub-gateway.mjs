// A stand-in for the gateway and for the model API, for the secret-free install e2e. Hooks reach it
// through LOCAL_DECIDER_URL. It records every request and answers
//   GET  /health            ok
//   POST /v1/decide/:policy a valid, unenforced `log` verdict (the harness carries on unchanged)
//   POST /v1/outcomes       200
//   anything else           400 with an API-style error body, so a harness pointed at it as its
//                           model provider fails fast after its first hooks have run
import { createServer } from 'node:http';

const DECIDE = /^\/v1\/decide\/([^/?]+)/;

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A decision the client's validator accepts: shadow mode, nothing enforced, no answers. */
function abstainDecision(policy, request) {
  return {
    decisionId: `stub-${Date.now()}`,
    policy,
    ...(request.scope === undefined ? {} : { scope: request.scope }),
    action: 'log',
    enforced: false,
    mode: 'shadow',
    answers: {},
    rule: -1,
    engine: 'stub',
    model: 'stub',
    latencyMs: 0,
    cached: false,
  };
}

function readBody(req) {
  return new Promise((done) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        done(text === '' ? undefined : JSON.parse(text));
      } catch {
        done(undefined);
      }
    });
  });
}

/**
 * Start the stub on 127.0.0.1 and a free port. `calls` collects gateway requests
 * (`{ method, path, policy?, body }`), `modelRequests` everything else.
 */
export async function startStubGateway() {
  const calls = [];
  const modelRequests = [];
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const body = await readBody(req);
    const decide = DECIDE.exec(path);
    if (req.method === 'GET' && path === '/health') {
      calls.push({ method: req.method, path });
      reply(res, 200, { status: 'ok', engine: 'stub', model: 'stub', engineState: 'ready' });
    } else if (req.method === 'POST' && decide !== null) {
      const policy = decodeURIComponent(decide[1]);
      calls.push({ method: req.method, path, policy, body });
      reply(res, 200, abstainDecision(policy, body ?? {}));
    } else if (req.method === 'POST' && path === '/v1/outcomes') {
      calls.push({ method: req.method, path, body });
      reply(res, 200, { ok: true });
    } else {
      modelRequests.push({ method: req.method, path });
      reply(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'stub gateway: no model here' },
      });
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${String(port)}`,
    calls,
    modelRequests,
    close: () => new Promise((done) => (server.closeAllConnections(), server.close(done))),
  };
}
