import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, type TestContext } from 'node:test';

import { socketFetch } from '../src/transport.ts';

const servers: Server[] = [];

function socketPath(test: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'ld-socket-fetch-'));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'gateway.sock');
}

async function listen(path: string, handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return server;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('socketFetch', () => {
  it('sends method, headers and body and returns a WHATWG Response', async (test) => {
    const path = socketPath(test);
    await listen(path, (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-check'], 'present');
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        res.setHeader('content-type', 'text/plain');
        res.end(`${body}:done`);
      });
    });
    const response = await socketFetch(path)('http://localhost/route?q=1', {
      method: 'POST',
      headers: { 'x-check': 'present' },
      body: 'payload',
    });
    assert.ok(response instanceof Response);
    assert.equal(await response.text(), 'payload:done');
    assert.equal(response.headers.get('content-type'), 'text/plain');
  });

  it('preserves method, headers and body from a Request input', async (test) => {
    const path = socketPath(test);
    await listen(path, (req, res) => {
      assert.equal(req.method, 'PUT');
      assert.equal(req.headers['x-check'], 'from-request');
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => res.end(body));
    });
    const request = new Request('http://localhost/request', {
      method: 'PUT',
      headers: { 'x-check': 'from-request' },
      body: 'request-body',
    });
    const response = await socketFetch(path)(request);
    assert.equal(await response.text(), 'request-body');
  });

  it('does not follow redirects and errors when redirect:error is requested', async (test) => {
    const path = socketPath(test);
    let redirected = 0;
    await listen(path, (req, res) => {
      if (req.url === '/next') redirected++;
      res.writeHead(302, { location: '/next' });
      res.end();
    });
    const fetcher = socketFetch(path);
    const response = await fetcher('http://localhost/start');
    assert.equal(response.status, 302);
    assert.equal(redirected, 0);
    await assert.rejects(fetcher('http://localhost/start', { redirect: 'error' }), /redirects/);
  });

  it('honors AbortSignal while the response is streaming', async (test) => {
    const path = socketPath(test);
    await listen(path, (_req, res) => {
      res.writeHead(200);
      res.write('waiting');
    });
    const controller = new AbortController();
    const pending = socketFetch(path)('http://localhost/wait', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, { name: 'AbortError' });
  });

  it('rejects responses larger than 8 MiB', async (test) => {
    const path = socketPath(test);
    await listen(path, (_req, res) => {
      res.writeHead(200, { 'content-length': String(8 * 1024 * 1024 + 1) });
      res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
    });
    await assert.rejects(socketFetch(path)('http://localhost/large'), /exceeded 8 MiB/);
  });
});
