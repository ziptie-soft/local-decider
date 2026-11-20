import type { ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();
let installed = false;

/** Signals the child's process group (it is a group leader) so grandchildren go too. */
export function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    // already gone
  }
}

function killAll(signal: NodeJS.Signals): void {
  for (const child of children) {
    killChild(child, signal);
  }
}

function onSignal(signal: NodeJS.Signals): void {
  killAll('SIGTERM');
  // Only ours is listening: restore the default so the process still ends.
  if (process.listenerCount(signal) === 1) {
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  }
}

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  process.on('exit', () => killAll('SIGTERM'));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // A closed terminal: the engines no longer share its group, so reap them here.
  process.on('SIGHUP', onSignal);
}

/** Tracks a supervised child until it exits; one set of process handlers serves every engine. */
export function trackChild(child: ChildProcess): void {
  install();
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', () => children.delete(child));
}

export function trackedChildCount(): number {
  return children.size;
}
