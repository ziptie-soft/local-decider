/**
 * Small, dependency-free gateway launcher shared by local-decider clients. It never reads
 * process.env: callers pass the environment explicitly so tests and hosts control child envs.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

import { gatewaySocketPath } from './socket-path.ts';
import { socketFetch } from './transport.ts';

export interface EngineStatus {
  readonly status: string;
  readonly engineState: string | null;
  readonly detail: string | null;
  readonly version?: string;
  readonly instance?: string;
}

export type LaunchStatus =
  | 'disabled'
  | 'remote'
  | 'running'
  | 'started'
  | 'service-started'
  | 'legacy'
  | 'port-busy'
  | 'mismatch'
  | 'stopped'
  | 'unsafe-path'
  | 'failed'
  | 'not-installed'
  | 'too-new'
  | 'not-published';

export interface LaunchResult {
  readonly ok: boolean;
  readonly status: LaunchStatus;
  readonly message: string;
  readonly engine?: EngineStatus | null;
  readonly guideUrl?: string;
}

export interface LauncherFs {
  mkdirSync(path: string, options: { recursive?: boolean; mode?: number }): unknown;
  openSync(path: string, flags: number, mode?: number): number;
  fstatSync(fd: number): {
    readonly uid: number;
    readonly mode: number;
    readonly size: number;
    isDirectory(): boolean;
    isFile(): boolean;
  };
  ftruncateSync(fd: number, length: number): void;
  closeSync(fd: number): void;
  fchmodSync(fd: number, mode: number): void;
  chmodSync(path: string, mode: number): void;
  readFileSync(pathOrFd: string | number, encoding: BufferEncoding): string;
  realpathSync(path: string): string;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
  writeSync(fd: number, data: string): number;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly windowsHide: true;
  readonly maxBuffer: number;
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error & { readonly killed?: boolean };
}>;

export interface LauncherDeps {
  readonly fetch?: typeof fetch;
  readonly execFile?: ExecFile;
  readonly fs?: LauncherFs;
  readonly now?: () => number;
  readonly home?: string;
  readonly uid?: number;
  readonly execPath?: string;
  readonly nodeReleaseName?: string;
  readonly nodeVersion?: string;
  readonly electronVersion?: string;
  readonly random?: () => string;
}

export interface LaunchOptions {
  readonly url: string;
  /** True only when no user URL setting selected this built-in local endpoint. */
  readonly defaultEndpoint?: boolean;
  readonly clientId?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly pinnedVersion: string;
  readonly guideUrl: string;
  readonly deps?: LauncherDeps;
}

interface DataPaths {
  readonly data: string;
  readonly run: string;
  readonly logs: string;
  readonly gateway: string;
}

const REGISTRY = 'https://registry.npmjs.org/@ziptie-soft/local-decider';
const REGISTRY_ROOT = 'https://registry.npmjs.org/';
const INSTALL_AGE_MS = 72 * 60 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 1000;
const ENSURE_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 600_000;
const LOG_LIMIT = 256 * 1024;
const MANUAL_START = 'local-decider gateway start';

const defaultFs: LauncherFs = {
  mkdirSync,
  openSync,
  fstatSync,
  ftruncateSync,
  closeSync,
  fchmodSync,
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
};

const execFile: ExecFile = (file, args, options) =>
  new Promise((resolvePromise) => {
    nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
      if (error !== null) {
        resolvePromise({ stdout, stderr, error });
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

function result(
  status: LaunchStatus,
  message: string,
  engine?: EngineStatus | null,
  guideUrl?: string,
): LaunchResult {
  const listenerUp = status === 'running' || status === 'started' || status === 'service-started';
  const ok = listenerUp && engine?.status !== 'down';
  return {
    ok,
    status,
    message,
    ...(engine === undefined ? {} : { engine }),
    ...(guideUrl === undefined ? {} : { guideUrl }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function engineStatus(value: Record<string, unknown>): EngineStatus {
  return {
    status: value['status'] as string,
    engineState: typeof value['engineState'] === 'string' ? value['engineState'] : null,
    detail: typeof value['detail'] === 'string' ? value['detail'] : null,
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
    ...(typeof value['instance'] === 'string' ? { instance: value['instance'] } : {}),
  };
}

function loopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  );
}

export function isLoopbackUrl(value: string): boolean {
  try {
    return loopback(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isDefaultEndpoint(options: LaunchOptions): boolean {
  return (
    options.defaultEndpoint ??
    ((options.env['LOCAL_DECIDER_URL']?.trim() ?? '') === '' &&
      options.url === 'http://127.0.0.1:8765')
  );
}

function dataDirectory(options: LaunchOptions, deps: LauncherDeps): string {
  const home = deps.home ?? homedir();
  return (
    options.env['LOCAL_DECIDER_HOME'] ??
    join(options.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'local-decider')
  );
}

function ensurePrivateDir(path: string, fs: LauncherFs, uid: number): void {
  let fd: number | undefined;
  try {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    fd = fs.openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new UnsafePathError(path);
    }
  } catch (error) {
    if (error instanceof UnsafePathError) throw error;
    throw new UnsafePathError(path);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

class UnsafePathError extends Error {
  constructor(path: string) {
    super(`unsafe private directory: ${path}`);
  }
}

function privateDirectories(data: string, fs: LauncherFs, uid: number): DataPaths {
  const paths = {
    data,
    run: join(data, 'run'),
    logs: join(data, 'logs'),
    gateway: join(data, 'gateway'),
  };
  for (const path of Object.values(paths)) ensurePrivateDir(path, fs, uid);
  return paths;
}

function absolutePath(value: string | undefined): value is string {
  return value !== undefined && value !== '' && isAbsolute(value);
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const fromPath = (env['PATH'] ?? '')
    .split(delimiter)
    .filter((entry) => entry !== '' && isAbsolute(entry));
  return [...fromPath, '/opt/homebrew/bin', '/usr/local/bin'];
}

function readableFile(path: string, fs: LauncherFs): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return false;
    if (['.js', '.mjs', '.cjs'].includes(extname(path))) return true;
    const firstLine = fs.readFileSync(fd, 'utf8').split(/\r?\n/, 1)[0] ?? '';
    return /^#!.*\bnode(?:\s|$)/i.test(firstLine);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findCli(options: LaunchOptions, data: string, fs: LauncherFs): string | null {
  const managed = join(
    data,
    'gateway',
    options.pinnedVersion,
    'node_modules',
    '@ziptie-soft',
    'local-decider',
    'dist',
    'cli.js',
  );
  const candidates = [
    ...(absolutePath(options.env['LOCAL_DECIDER_BIN']) ? [options.env['LOCAL_DECIDER_BIN']] : []),
    managed,
    ...pathEntries(options.env).map((entry) => join(entry, 'local-decider')),
  ];
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      // Keep searching; a dangling or unreadable executable is not an installation.
      continue;
    }
    if (readableFile(resolved, fs)) return resolved;
  }
  return null;
}

function parseVersion(value: string): [number, number, number] | null {
  const found = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (found === null) return null;
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}

function supportedNode(version: string): boolean {
  const found = parseVersion(version);
  if (found === null) return false;
  return (
    found[0] > 24 || (found[0] === 24 && found[1] > 15) || (found[0] === 24 && found[1] === 15)
  );
}

async function checkNode(
  file: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  run: ExecFile,
): Promise<string | null> {
  try {
    const { stdout, error } = await run(file, ['--version'], {
      cwd,
      env,
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 4096,
    });
    return error === undefined && supportedNode(stdout) ? file : null;
  } catch {
    return null;
  }
}

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child['NODE_OPTIONS'];
  delete child['NODE_PATH'];
  return child;
}

async function findNode(
  options: LaunchOptions,
  cwd: string,
  run: ExecFile,
  deps: LauncherDeps,
): Promise<string | null> {
  const runtimeIsNode =
    (deps.nodeReleaseName ?? process.release.name) === 'node' &&
    (deps.electronVersion ?? process.versions['electron']) === undefined;
  const execPath = deps.execPath ?? process.execPath;
  if (runtimeIsNode && supportedNode(deps.nodeVersion ?? process.versions.node)) return execPath;
  const env = cleanEnv(options.env);
  for (const dir of pathEntries(options.env)) {
    const candidate = join(dir, 'node');
    if (!isAbsolute(candidate)) continue;
    const found = await checkNode(candidate, cwd, env, run);
    if (found !== null) return found;
  }
  return null;
}

function npmCli(node: string): string {
  const prefix = dirname(dirname(node));
  return join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function readJsonFile(path: string, fs: LauncherFs): unknown {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function installVerified(root: string, version: string, fs: LauncherFs): boolean {
  const packageDir = join(root, 'node_modules', '@ziptie-soft', 'local-decider');
  const manifest = readJsonFile(join(packageDir, 'package.json'), fs);
  return (
    record(manifest) &&
    manifest['version'] === version &&
    readableFile(join(packageDir, 'dist', 'cli.js'), fs)
  );
}

async function registryAge(
  version: string,
  now: number,
  fetcher: typeof fetch,
): Promise<'ok' | 'too-new' | 'not-published'> {
  try {
    const response = await fetcher(REGISTRY, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 'not-published';
    const metadata: unknown = await response.json();
    const time =
      record(metadata) && record(metadata['time']) ? metadata['time'][version] : undefined;
    if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) return 'not-published';
    return now - Date.parse(time) >= INSTALL_AGE_MS ? 'ok' : 'too-new';
  } catch {
    return 'not-published';
  }
}

function createStage(gatewayDir: string, fs: LauncherFs, random: () => string): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const stage = join(gatewayDir, `.tmp-${random()}`);
    try {
      fs.mkdirSync(stage, { mode: 0o700 });
      return stage;
    } catch (error) {
      if (!record(error) || error['code'] !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not create a unique gateway install stage');
}

function stageDirs(stage: string, fs: LauncherFs, uid: number): void {
  for (const path of ['home', 'tmp', 'cache']) ensurePrivateDir(join(stage, path), fs, uid);
}

function installAgeResult(
  age: 'ok' | 'too-new' | 'not-published',
  options: LaunchOptions,
): LaunchResult | null {
  if (age === 'ok') return null;
  if (age === 'too-new') {
    return result(
      'too-new',
      'the pinned gateway release is younger than 72 hours',
      null,
      options.guideUrl,
    );
  }
  return result(
    'not-published',
    'the pinned gateway release could not be verified in npm registry metadata',
    null,
    options.guideUrl,
  );
}

async function executeNpmInstall(
  options: LaunchOptions,
  stage: string,
  node: string,
  npm: string,
  now: number,
  run: ExecFile,
): Promise<LaunchResult | null> {
  const environment: NodeJS.ProcessEnv = {
    HOME: join(stage, 'home'),
    PATH: dirname(node),
    TMPDIR: join(stage, 'tmp'),
    LANG: 'C',
    LC_ALL: 'C',
  };
  const cutoff = new Date(now - INSTALL_AGE_MS).toISOString();
  const args = [
    npm,
    'install',
    '--prefix',
    stage,
    '--no-save',
    '--ignore-scripts',
    '--omit=dev',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    `--registry=${REGISTRY_ROOT}`,
    `--userconfig=${join(stage, 'user.npmrc')}`,
    `--globalconfig=${join(stage, 'global.npmrc')}`,
    `--cache=${join(stage, 'cache')}`,
    '--strict-ssl=true',
    `--before=${cutoff}`,
    `@ziptie-soft/local-decider@${options.pinnedVersion}`,
  ];
  const installed = await run(node, args, {
    cwd: stage,
    env: environment,
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return installed.error === undefined
    ? null
    : result('failed', 'npm failed while installing the pinned gateway', null, options.guideUrl);
}

function discardInstallPrivateFiles(stage: string, fs: LauncherFs): void {
  for (const path of ['home', 'tmp', 'cache', 'user.npmrc', 'global.npmrc']) {
    fs.rmSync(join(stage, path), { recursive: true, force: true });
  }
}

function promoteInstall(
  stage: string,
  destination: string,
  version: string,
  fs: LauncherFs,
  guideUrl: string,
): LaunchResult | null {
  if (!installVerified(stage, version, fs)) {
    return result(
      'failed',
      'npm completed but the installed gateway did not match the pinned version',
      null,
      guideUrl,
    );
  }
  try {
    fs.renameSync(stage, destination);
    return null;
  } catch {
    return installVerified(destination, version, fs)
      ? null
      : result(
          'failed',
          'could not publish the verified staged gateway installation',
          null,
          guideUrl,
        );
  }
}

async function installGateway(
  options: LaunchOptions,
  dirs: DataPaths,
  node: string,
  fs: LauncherFs,
  run: ExecFile,
  deps: LauncherDeps,
): Promise<LaunchResult | null> {
  const now = (deps.now ?? Date.now)();
  const age = await registryAge(options.pinnedVersion, now, deps.fetch ?? globalThis.fetch);
  const ageResult = installAgeResult(age, options);
  if (ageResult !== null) return ageResult;
  const npm = npmCli(node);
  if (!readableFile(npm, fs)) {
    return result(
      'failed',
      'npm-cli.js was not found beside the selected Node installation',
      null,
      options.guideUrl,
    );
  }
  const stage = createStage(
    dirs.gateway,
    fs,
    deps.random ?? (() => randomBytes(16).toString('hex')),
  );
  try {
    const uid =
      deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : userInfo().uid);
    ensurePrivateDir(stage, fs, uid);
    stageDirs(stage, fs, uid);
    const destination = join(dirs.gateway, options.pinnedVersion);
    const installResult = await executeNpmInstall(options, stage, node, npm, now, run);
    if (installResult !== null) return installResult;
    discardInstallPrivateFiles(stage, fs);
    return promoteInstall(stage, destination, options.pinnedVersion, fs, options.guideUrl);
  } catch (error) {
    return result(
      'failed',
      error instanceof Error ? error.message : 'gateway installation failed',
      null,
      options.guideUrl,
    );
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function probe(
  url: string,
  fetcher: typeof fetch,
  clientId: string,
): Promise<EngineStatus | null> {
  try {
    const response = await fetcher(new URL('/health', url), {
      method: 'GET',
      redirect: 'error',
      headers: { 'x-local-decider-client': clientId },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const value: unknown = await response.json();
    return record(value) && typeof value['status'] === 'string' ? engineStatus(value) : null;
  } catch {
    return null;
  }
}

function logAttempt(data: string, status: LaunchStatus, fs: LauncherFs, now: number): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      join(data, 'logs', 'launcher.log'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    if (fs.fstatSync(fd).size > LOG_LIMIT) {
      fs.ftruncateSync(fd, 0);
    }
    fs.writeSync(fd, `${new Date(now).toISOString()} ${status}\n`);
  } catch {
    // Logging must never block a client launch.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fromEnsure(output: string, guideUrl: string): LaunchResult {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1)
    return result('failed', 'gateway ensure returned an invalid response', null, guideUrl);
  try {
    const value: unknown = JSON.parse(lines[0] ?? '');
    if (
      !record(value) ||
      typeof value['listener'] !== 'string' ||
      typeof value['message'] !== 'string'
    ) {
      return result('failed', 'gateway ensure returned an invalid response', null, guideUrl);
    }
    const status = value['listener'] as LaunchStatus;
    const known: readonly string[] = [
      'running',
      'started',
      'service-started',
      'legacy',
      'remote',
      'port-busy',
      'mismatch',
      'stopped',
      'unsafe-path',
      'failed',
    ];
    if (!known.includes(status))
      return result('failed', 'gateway ensure returned an unknown status', null, guideUrl);
    const engine =
      record(value['engine']) && typeof value['engine']['status'] === 'string'
        ? engineStatus(value['engine'])
        : null;
    return result(status, value['message'], engine, guideUrl);
  } catch {
    return result('failed', 'gateway ensure returned an invalid response', null, guideUrl);
  }
}

function manualInstall(options: LaunchOptions): LaunchResult {
  return result(
    'not-installed',
    `gateway is not installed; run: npm install -g @ziptie-soft/local-decider@${options.pinnedVersion}, then ${MANUAL_START}`,
    null,
    options.guideUrl,
  );
}

interface LaunchAttempt {
  readonly result: LaunchResult;
  readonly data: string;
  readonly logSafe: boolean;
}

function canLog(data: string, fs: LauncherFs, uid: number): boolean {
  try {
    privateDirectories(data, fs, uid);
    return true;
  } catch {
    return false;
  }
}

function failedLaunch(error: unknown, guideUrl: string): LaunchResult {
  const message = error instanceof Error ? error.message : 'gateway launcher failed';
  const status = message.includes('unsafe private directory') ? 'unsafe-path' : 'failed';
  return result(status, message, null, guideUrl);
}

async function quickOutcome(
  options: LaunchOptions,
  deps: LauncherDeps,
): Promise<LaunchResult | null> {
  const autostart = options.env['LOCAL_DECIDER_AUTOSTART']?.toLowerCase();
  if (autostart === '0' || autostart === 'off' || autostart === 'false') {
    return result('disabled', 'gateway auto-start is disabled');
  }
  if (!isLoopbackUrl(options.url)) {
    return result('remote', 'gateway URL is not loopback; remote gateways are never started');
  }
  const useSocket = isDefaultEndpoint(options);
  const clientId = options.clientId ?? 'launcher/0.0.0';
  const runDir = join(dataDirectory(options, deps), 'run');
  const path = useSocket ? gatewaySocketPath(runDir) : null;
  const fetcher = deps.fetch ?? (path === null ? globalThis.fetch : socketFetch(path));
  const foundHealth = await probe(options.url, fetcher, clientId);
  if (foundHealth !== null) return result('running', 'gateway is answering /health', foundHealth);
  if (path === null || deps.fetch !== undefined) return null;
  const tcpHealth = await probe(options.url, globalThis.fetch, clientId);
  if (tcpHealth === null) return null;
  if (tcpHealth.instance === undefined) {
    return result(
      'legacy',
      `an older gateway runs on :${new URL(options.url).port || '8765'} without a socket; run \`local-decider gateway restart\``,
    );
  }
  return result('failed', 'gateway answers TCP but its default Unix socket is unavailable');
}

interface PreparedGateway {
  readonly cli: string;
  readonly node: string;
  readonly runDir: string;
}

async function prepareGateway(
  options: LaunchOptions,
  paths: DataPaths,
  fs: LauncherFs,
  deps: LauncherDeps,
  run: ExecFile,
): Promise<PreparedGateway | LaunchResult> {
  let cli = findCli(options, paths.data, fs);
  let node: string | null = null;
  if (cli === null && options.env['LOCAL_DECIDER_AUTOINSTALL'] === '1') {
    node = await findNode(options, paths.run, run, deps);
    if (node === null) {
      return result(
        'failed',
        'Node.js 24.15 or newer is required to install the gateway',
        null,
        options.guideUrl,
      );
    }
    const installed = await installGateway(options, paths, node, fs, run, deps);
    if (installed !== null) return installed;
    cli = findCli(options, paths.data, fs);
  }
  if (cli === null) return manualInstall(options);
  node ??= await findNode(options, paths.run, run, deps);
  if (node === null) {
    return result(
      'failed',
      'Node.js 24.15 or newer is required to start the gateway',
      null,
      options.guideUrl,
    );
  }
  return { cli, node, runDir: paths.run };
}

async function ensureGateway(
  options: LaunchOptions,
  prepared: PreparedGateway,
  run: ExecFile,
): Promise<LaunchResult> {
  const defaultEndpoint = isDefaultEndpoint(options);
  const url = defaultEndpoint ? null : ensureArgumentUrl(options.url);
  if (!defaultEndpoint && url === null)
    return result(
      'failed',
      'gateway URL cannot be passed safely to the gateway CLI',
      null,
      options.guideUrl,
    );
  const args = [prepared.cli, 'gateway', 'ensure'];
  if (url !== null) args.push('--url', url);
  args.push('--json');
  const executed = await run(prepared.node, args, {
    cwd: prepared.runDir,
    env: cleanEnv(options.env),
    timeout: ENSURE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (executed.error?.killed === true) {
    return result(
      'failed',
      'gateway ensure exceeded its 45 second timeout',
      null,
      options.guideUrl,
    );
  }
  return fromEnsure(executed.stdout, options.guideUrl);
}

function ensureArgumentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function performAttempt(
  options: LaunchOptions,
  deps: LauncherDeps,
  fs: LauncherFs,
): Promise<LaunchAttempt> {
  const quick = await quickOutcome(options, deps);
  const data = dataDirectory(options, deps);
  const uid =
    deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : userInfo().uid);
  if (quick !== null) return { result: quick, data, logSafe: canLog(data, fs, uid) };
  let logSafe = false;
  try {
    const dirs = privateDirectories(data, fs, uid);
    logSafe = true;
    const run = deps.execFile ?? execFile;
    const prepared = await prepareGateway(options, dirs, fs, deps, run);
    if ('status' in prepared) return { result: prepared, data, logSafe };
    return { result: await ensureGateway(options, prepared, run), data, logSafe };
  } catch (error) {
    return { result: failedLaunch(error, options.guideUrl), data, logSafe };
  }
}

/**
 * Probe, locate (or opt-in install), and ask the gateway CLI to ensure its configured listener.
 * All failures are returned as values so callers can preserve their normal fail-open behavior.
 */
export async function launchGateway(options: LaunchOptions): Promise<LaunchResult> {
  const deps = options.deps ?? {};
  const fs = deps.fs ?? defaultFs;
  const now = (deps.now ?? Date.now)();
  let attempt: LaunchAttempt = {
    result: result('failed', 'gateway launcher failed', null, options.guideUrl),
    data: '',
    logSafe: false,
  };
  try {
    attempt = await performAttempt(options, deps, fs);
  } catch (error) {
    attempt = { result: failedLaunch(error, options.guideUrl), data: '', logSafe: false };
  } finally {
    if (attempt.logSafe) {
      try {
        logAttempt(attempt.data, attempt.result.status, fs, now);
      } catch {
        // A log failure must not escape the launch API.
      }
    }
  }
  return attempt.result;
}
