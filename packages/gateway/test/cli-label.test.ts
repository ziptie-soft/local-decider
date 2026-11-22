import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { labelCommand, type LabelEnv } from '../src/cli-label.ts';
import { UsageError } from '../src/cli-support.ts';
import { ensureReportToken } from '../src/report-token.ts';
import { openLogStore } from '../src/sqlite-log.ts';
import { tempPaths, testConfig } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

const config = testConfig();
const NOW = Date.parse('2026-11-10T01:00:00.000Z');

interface Seen {
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let target: Server;
let url = '';
let seen: Seen[] = [];
let leaked = 0;
let status = 200;
let redirect = false;

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${String((s.address() as AddressInfo).port)}`),
    );
  });
}

before(async () => {
  target = createServer((_req, res) => {
    leaked += 1;
    res.end('{}');
  });
  const targetUrl = await listen(target);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ headers: req.headers, body });
      if (redirect) {
        res.writeHead(302, { location: `${targetUrl}/v1/outcomes` }).end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  url = await listen(server);
});
after(() => {
  server.close();
  target.close();
});

function seeded(extra: Record<string, unknown> = {}): ReturnType<typeof tempPaths> {
  const paths = tempPaths();
  const log = openLogStore(paths);
  log.append(makeShadowRecord('11111111-aaaa', { action: 'allow', precedentKey: 'k1', ...extra }));
  log.append(makeShadowRecord('22222222-bbbb', { harness: 'mcp' }));
  log.close();
  ensureReportToken(paths);
  seen = [];
  status = 200;
  redirect = false;
  return paths;
}

const run = (
  paths: ReturnType<typeof tempPaths>,
  args: string[],
  env: Partial<LabelEnv> = {},
): Promise<string> => labelCommand({ paths, config, args, url, now: NOW, ...env });

describe('label command', () => {
  it('posts a verified unsafe outcome with the report token and never prints the token', async () => {
    const paths = seeded();
    const token = ensureReportToken(paths);
    const out = await run(paths, ['11111111-aaaa', 'unsafe', '--yes']);
    assert.match(out, /labelled 11111111-aaaa unsafe/);
    assert.ok(!out.includes(token));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.headers['x-local-decider-report'], token);
    assert.deepEqual(JSON.parse(seen[0]?.body ?? ''), {
      decisionId: '11111111-aaaa',
      outcome: 'unsafe',
      source: 'user',
    });
  });

  it('rejects bad usage with exit 2 semantics', async () => {
    const paths = seeded();
    for (const args of [
      [],
      ['11111111-aaaa'],
      ['11111111-aaaa', 'decline'],
      ['11111111-aaaa', 'allow'],
      ['11111111-aaaa', 'unsafe', 'extra'],
      ['bad id!', 'unsafe'],
      ['11111111-aaaa', 'unsafe', '--bogus'],
    ]) {
      await assert.rejects(run(paths, args), UsageError, JSON.stringify(args));
    }
    assert.equal(seen.length, 0);
  });

  it('refuses a gateway that is not on this machine, without sending anything', async () => {
    const paths = seeded();
    await assert.rejects(
      run(paths, ['11111111-aaaa', 'unsafe', '--yes'], { url: 'http://example.com:8080' }),
      /labels need a local gateway/,
    );
    assert.equal(seen.length, 0);
  });

  it('refuses unknown decisions and probes', async () => {
    const paths = seeded();
    await assert.rejects(run(paths, ['nope', 'unsafe', '--yes']), /unknown decision/);
    await assert.rejects(run(paths, ['22222222-bbbb', 'unsafe', '--yes']), /probe/);
    await assert.rejects(run(tempPaths(), ['nope', 'unsafe', '--yes']), /unknown decision/);
    assert.equal(seen.length, 0);
  });

  it('needs --yes without a terminal, and asks on one', async () => {
    const paths = seeded();
    await assert.rejects(run(paths, ['11111111-aaaa', 'unsafe']), UsageError);
    assert.equal(
      await run(paths, ['11111111-aaaa', 'unsafe'], {
        isTty: true,
        confirm: () => Promise.resolve(false),
      }),
      'not labelled',
    );
    assert.equal(seen.length, 0);
    await run(paths, ['11111111-aaaa', 'unsafe'], {
      isTty: true,
      confirm: () => Promise.resolve(true),
    });
    assert.equal(seen.length, 1);
  });

  it('warns about a missing precedent key and an allow too old to replay', async () => {
    const paths = tempPaths();
    const log = openLogStore(paths);
    log.append(
      makeShadowRecord('33333333-cccc', { action: 'allow', ts: '2026-11-08T00:00:00.000Z' }),
    );
    log.close();
    ensureReportToken(paths);
    const out = await run(paths, ['33333333-cccc', 'unsafe', '--yes']);
    assert.match(out, /no precedent key/);
    assert.match(out, /older than 25 hours/);
  });

  it('fails without leaking the token when the gateway refuses or the token is missing', async () => {
    const paths = seeded();
    const token = ensureReportToken(paths);
    status = 401;
    await assert.rejects(run(paths, ['11111111-aaaa', 'unsafe', '--yes']), (error: unknown) => {
      return (
        error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes(token)
      );
    });
    const bare = tempPaths();
    const log = openLogStore(bare);
    log.append(makeShadowRecord('44444444-dddd', { action: 'allow' }));
    log.close();
    await assert.rejects(run(bare, ['44444444-dddd', 'unsafe', '--yes']), /report token missing/);
  });

  it('does not follow redirects, so the token never reaches another host', async () => {
    const paths = seeded();
    redirect = true;
    leaked = 0;
    await assert.rejects(run(paths, ['11111111-aaaa', 'unsafe', '--yes']));
    assert.equal(leaked, 0);
  });
});
