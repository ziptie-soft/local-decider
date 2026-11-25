import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseMode, resolveConfig } from '../extension/config.ts';

describe('mode precedence', () => {
  it('defaults to guard', () => {
    assert.equal(resolveConfig({}, {}).config.mode, 'guard');
  });
  it('uses the env when there is no flag', () => {
    assert.equal(resolveConfig({ LOCAL_DECIDER_PI_MODE: 'approve' }, {}).config.mode, 'approve');
  });
  it('lets the flag beat the env', () => {
    const { config } = resolveConfig({ LOCAL_DECIDER_PI_MODE: 'approve' }, { mode: 'off' });
    assert.equal(config.mode, 'off');
  });
  it('treats an empty env value as unset', () => {
    assert.equal(resolveConfig({ LOCAL_DECIDER_PI_MODE: '' }, {}).config.mode, 'guard');
  });
  it('turns an invalid env mode off with a warning', () => {
    const r = resolveConfig({ LOCAL_DECIDER_PI_MODE: 'yolo' }, {});
    assert.equal(r.config.mode, 'off');
    assert.equal(r.warnings.length, 1);
  });
  it('turns an invalid flag off even with a valid env', () => {
    const r = resolveConfig({ LOCAL_DECIDER_PI_MODE: 'guard' }, { mode: 'nope' });
    assert.equal(r.config.mode, 'off');
    assert.equal(r.warnings.length, 1);
  });
  it('turns a non-string flag off with a warning', () => {
    const r = resolveConfig({}, { mode: true });
    assert.equal(r.config.mode, 'off');
    assert.equal(r.warnings.length, 1);
  });
});

describe('url and token pairing', () => {
  it('defaults the url and passes the token', () => {
    const { config } = resolveConfig({ LOCAL_DECIDER_TOKEN: 't0k' }, {});
    assert.equal(config.url, 'http://127.0.0.1:8765');
    assert.equal(config.token, 't0k');
  });
  it('pairs the env url with the env token', () => {
    const { config } = resolveConfig(
      { LOCAL_DECIDER_URL: 'https://gw.example', LOCAL_DECIDER_TOKEN: 't0k' },
      {},
    );
    assert.equal(config.url, 'https://gw.example');
    assert.equal(config.token, 't0k');
  });
  it('has no token when none is set', () => {
    assert.equal('token' in resolveConfig({}, {}).config, false);
  });
  it('ignores empty values', () => {
    const { config } = resolveConfig({ LOCAL_DECIDER_URL: '', LOCAL_DECIDER_TOKEN: '' }, {});
    assert.equal(config.url, 'http://127.0.0.1:8765');
    assert.equal(config.token, undefined);
  });
});

describe('guard timeout', () => {
  it('defaults and fixes the other timeouts', () => {
    const { config, warnings } = resolveConfig({}, {});
    assert.equal(config.guardTimeoutMs, 1500);
    assert.equal(config.approveTimeoutMs, 10000);
    assert.equal(config.dialogTimeoutMs, 120000);
    assert.deepEqual(warnings, []);
  });
  it('accepts a positive integer up to 10000', () => {
    assert.equal(
      resolveConfig({ LOCAL_DECIDER_TIMEOUT_MS: '10000' }, {}).config.guardTimeoutMs,
      10000,
    );
    assert.equal(resolveConfig({ LOCAL_DECIDER_TIMEOUT_MS: '250' }, {}).config.guardTimeoutMs, 250);
  });
  for (const bad of ['0', '-5', '10001', '1.5', 'abc', '1e3']) {
    it(`warns and uses the default for ${bad}`, () => {
      const r = resolveConfig({ LOCAL_DECIDER_TIMEOUT_MS: bad }, {});
      assert.equal(r.config.guardTimeoutMs, 1500);
      assert.equal(r.warnings.length, 1);
    });
  }
});

describe('warnings', () => {
  it('never contain the token', () => {
    const r = resolveConfig(
      {
        LOCAL_DECIDER_TOKEN: 'sekret-token',
        LOCAL_DECIDER_PI_MODE: 'bad',
        LOCAL_DECIDER_TIMEOUT_MS: 'bad',
      },
      { mode: 'bad' },
    );
    assert.ok(r.warnings.length > 0);
    assert.ok(!r.warnings.join('\n').includes('sekret-token'));
  });
});

describe('parseMode', () => {
  it('parses valid modes', () => {
    assert.equal(parseMode('off'), 'off');
    assert.equal(parseMode(' Approve '), 'approve');
    assert.equal(parseMode('guard'), 'guard');
  });
  it('rejects anything else', () => {
    assert.equal(parseMode('x'), null);
    assert.equal(parseMode(undefined), null);
    assert.equal(parseMode(1), null);
  });
});
