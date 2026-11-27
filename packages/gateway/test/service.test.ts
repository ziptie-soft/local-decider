import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  launchdEnv,
  launchdExecBinary,
  launchdPlist,
  installedService,
  removeGatewayPidfile,
  staleServiceExec,
  startLaunchd,
  systemdExecBinary,
  systemdUnit,
  writeGatewayPidfile,
  serviceState,
  startInstalledService,
  stopService,
  type LaunchctlDeps,
} from '../src/service.ts';
import { tempPaths } from './helpers.ts';

const COMMAND = ['/opt/node/bin/node', '/app/cli.ts', 'gateway', 'run'];

describe('launchd environment', () => {
  it('builds a deduplicated PATH and passes data-dir variables through', () => {
    const env = launchdEnv(
      {
        HOME: '/Users/me',
        LOCAL_DECIDER_HOME: '/data',
        XDG_DATA_HOME: '/xdg',
        HF_HOME: '',
        LOCAL_DECIDER_TOKEN: 'secret',
        OPENAI_API_KEY: 'k',
      },
      '/opt/homebrew/bin/node',
      { uv: '/Users/me/.local/bin/uv' },
    );
    assert.equal(
      env['PATH'],
      '/opt/homebrew/bin:/Users/me/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    assert.deepEqual(
      Object.keys(env).toSorted(),
      ['HOME', 'LOCAL_DECIDER_HOME', 'PATH', 'XDG_DATA_HOME'].toSorted(),
    );
  });

  it('writes an escaped environment dict and never a token', () => {
    const paths = tempPaths();
    const env = launchdEnv({ HOME: '/Users/a&b', LOCAL_DECIDER_TOKEN: 'secret' }, '/n/node', {});
    const plist = launchdPlist(
      ['/n/node', '--env-file-if-exists=/c/env', '/app/cli.ts'],
      paths,
      env,
    );
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /<key>HOME<\/key>\s*<string>\/Users\/a&amp;b<\/string>/);
    assert.doesNotMatch(plist, /LOCAL_DECIDER_TOKEN|secret/);
    assert.match(plist, /<string>\/app\/cli\.ts<\/string>/);
    assert.match(plist, /--env-file-if-exists=\/c\/env/);
    assert.doesNotMatch(systemdUnit(COMMAND, paths), /env-file-if-exists/);
  });
});

interface Fake {
  readonly deps: LaunchctlDeps;
  readonly calls: string[];
  readonly sleeps: number[];
}

/** A fake launchctl: `print` follows `loaded`, `bootstrap` fails with the given outcomes first. */
function fake(options: {
  loaded: () => boolean;
  unload?: () => void;
  bootstrapFailures?: string[];
  plist: string;
}): Fake {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const failures = [...(options.bootstrapFailures ?? [])];
  const deps: LaunchctlDeps = {
    uid: 501,
    plist: options.plist,
    sleep: (ms) => void sleeps.push(ms),
    tryRun: (args) => {
      calls.push(args[0] ?? '');
      return args[0] === 'print' && options.loaded() ? 'state = running' : undefined;
    },
    run: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'bootstrap' && failures.length > 0) {
        throw Object.assign(new Error(failures.shift()), { status: 5 });
      }
      return '';
    },
  };
  return { deps, calls, sleeps };
}

function start(f: Fake, restart: boolean, paths = tempPaths()): string {
  return startLaunchd(COMMAND, paths, restart, f.deps, { PATH: '/bin' });
}

describe('startLaunchd', () => {
  it('bootstraps when not loaded', () => {
    const paths = tempPaths();
    const f = fake({ loaded: () => false, plist: join(paths.data, 'a.plist') });
    assert.match(start(f, false, paths), /loaded/);
    assert.deepEqual(f.calls, ['print', `bootstrap gui/501 ${join(paths.data, 'a.plist')}`]);
    assert.match(readFileSync(join(paths.data, 'a.plist'), 'utf8'), /--env-file-if-exists=/);
  });

  it('leaves an unchanged loaded agent alone, or kickstarts it on restart', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    start(fake({ loaded: () => false, plist }), false, paths);
    const idle = fake({ loaded: () => true, plist });
    assert.match(start(idle, false, paths), /already loaded/);
    assert.deepEqual(idle.calls, ['print']);
    const kick = fake({ loaded: () => true, plist });
    assert.match(start(kick, true, paths), /restarted/);
    assert.deepEqual(kick.calls, ['print', 'kickstart -k gui/501/dev.local-decider.gateway']);
  });

  it('boots out a changed plist, waits for the unload, then bootstraps', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    let prints = 0;
    const f = fake({ loaded: () => ++prints <= 3, plist });
    start(f, false, paths);
    assert.deepEqual(
      f.calls.filter((c) => c !== 'print'),
      ['bootout', `bootstrap gui/501 ${plist}`],
    );
    assert.deepEqual(f.sleeps, [100, 100]);
  });

  it('retries bootstrap on EIO and gives up after three retries', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    const eio = 'Bootstrap failed: 5: Input/output error';
    const ok = fake({ loaded: () => false, bootstrapFailures: [eio], plist });
    start(ok, false, paths);
    assert.deepEqual(ok.sleeps, [500]);
    const bad = fake({
      loaded: () => false,
      bootstrapFailures: [eio, eio, eio, eio],
      plist: `${plist}2`,
    });
    assert.throws(() => start(bad, false, paths), /after 4 attempt/);
    assert.deepEqual(bad.sleeps, [500, 500, 500]);
  });

  it('fails when launchd never unloads the old job', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    const f = fake({ loaded: () => true, plist });
    assert.throws(() => start(f, false, paths), /did not unload/);
    assert.equal(f.sleeps.length, 50);
  });
});

describe('stale service ExecStart', () => {
  const unit = 'ExecStart="/old node/bin/node" /app/cli.js gateway run\nRestart=on-failure\n';

  it('parses the Node binary from a unit and a plist', () => {
    assert.equal(systemdExecBinary(systemdUnit(COMMAND, tempPaths())), '/opt/node/bin/node');
    assert.equal(systemdExecBinary(unit), '/old node/bin/node');
    assert.equal(launchdExecBinary(launchdPlist(COMMAND, tempPaths())), '/opt/node/bin/node');
    assert.equal(systemdExecBinary('[Unit]\n'), undefined);
  });

  it('warns with a restart hint when the binary is gone, read-only', () => {
    const reads: string[] = [];
    const hint = staleServiceExec('systemd', {
      unit: '/u/local-decider.service',
      read: (file) => (reads.push(file), unit),
      exists: () => false,
    });
    assert.match(hint ?? '', /\/old node\/bin\/node.*no longer exists.*gateway restart/);
    assert.deepEqual(reads, ['/u/local-decider.service']);
  });

  it('is silent when the binary exists, the unit is missing or no manager owns one', () => {
    assert.equal(
      staleServiceExec('systemd', { read: () => unit, exists: () => true, unit: '/u' }),
      undefined,
    );
    assert.equal(
      staleServiceExec('launchd', {
        plist: '/p',
        read: () => {
          throw new Error('ENOENT');
        },
      }),
      undefined,
    );
    assert.equal(staleServiceExec('pidfile'), undefined);
  });
});

describe('gateway pidfile ownership', () => {
  it('writes JSON after listen and removes only the matching process record', () => {
    const paths = tempPaths();
    writeGatewayPidfile(paths, process.pid, 43210);
    const file = join(paths.run, 'gateway.pid');
    const owner = JSON.parse(readFileSync(file, 'utf8')) as {
      pid: number;
      start: string;
      port: number;
    };
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.port, 43210);
    assert.equal(typeof owner.start, 'string');
    removeGatewayPidfile(paths);
    assert.throws(() => readFileSync(file), { code: 'ENOENT' });
  });

  it('preserves a foreign pidfile and covers pidfile gateways under each manager', () => {
    const paths = tempPaths();
    writeGatewayPidfile(paths, process.pid, 43210);
    const foreign = JSON.stringify({
      pid: process.pid,
      start: 'different-incarnation',
      port: 43211,
    });
    writeFileSync(join(paths.run, 'gateway.pid'), foreign, { mode: 0o600 });
    removeGatewayPidfile(paths);
    assert.equal(readFileSync(join(paths.run, 'gateway.pid'), 'utf8'), foreign);

    writeGatewayPidfile(paths, process.pid, 43210);
    assert.match(serviceState('pidfile', paths), /pidfile running/);
    const pidfileSignal: number[] = [];
    stopService('pidfile', paths, {
      kill: (pid) => {
        pidfileSignal.push(pid);
      },
    });
    assert.deepEqual(pidfileSignal, [process.pid]);

    writeGatewayPidfile(paths, process.pid, 43210);
    const systemdCalls: string[] = [];
    assert.match(
      serviceState('systemd', paths, {
        systemdTryRun: (args) => (systemdCalls.push(args.join(' ')), 'inactive'),
      }),
      /pidfile running/,
    );
    assert.deepEqual(systemdCalls, ['--user is-active local-decider']);
    const launchCalls: string[] = [];
    const launchctl: LaunchctlDeps = {
      uid: 501,
      tryRun: (args) => (
        launchCalls.push(args.join(' ')),
        args[0] === 'print' ? 'state = running' : undefined
      ),
      run: () => '',
      sleep: () => undefined,
    };
    assert.match(serviceState('launchd', paths, { launchctl }), /pidfile running/);
    assert.deepEqual(launchCalls, ['print gui/501/dev.local-decider.gateway']);

    const launchSignal: number[] = [];
    stopService('launchd', paths, {
      launchctl,
      kill: (pid) => {
        launchSignal.push(pid);
      },
    });
    assert.deepEqual(launchSignal, [process.pid]);

    const signalled: number[] = [];
    writeGatewayPidfile(paths, process.pid, 43210);
    const stopped = stopService('systemd', paths, {
      systemdTryRun: (args) => (systemdCalls.push(args.join(' ')), ''),
      kill: (pid) => {
        signalled.push(pid);
      },
    });
    assert.equal(stopped, 'stopped');
    assert.deepEqual(signalled, [process.pid]);
  });
});

describe('starting an installed service', () => {
  it('uses the manager and leaves the existing definition untouched', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'installed.plist');
    const content = launchdPlist(COMMAND, paths);
    writeFileSync(plist, content, { mode: 0o600 });
    assert.equal(installedService('launchd', { plist }), true);
    const calls: string[] = [];
    const launchctl: LaunchctlDeps = {
      uid: 501,
      plist,
      tryRun: (args) => (calls.push(args.join(' ')), undefined),
      run: (args) => (calls.push(args.join(' ')), ''),
      sleep: () => undefined,
    };
    startInstalledService('launchd', { launchctl });
    assert.deepEqual(calls, [
      'print gui/501/dev.local-decider.gateway',
      `bootstrap gui/501 ${plist}`,
    ]);
    assert.equal(readFileSync(plist, 'utf8'), content);

    startInstalledService('systemd', { systemdStart: () => calls.push('systemd start') });
    assert.equal(calls.at(-1), 'systemd start');
  });
});
