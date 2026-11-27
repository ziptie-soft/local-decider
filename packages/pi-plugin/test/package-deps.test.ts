import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// pi installs an npm package without its devDependencies, and the extension must not need any
// runtime dependency: code shared with core is vendored under extension/core/ instead, and the pi
// API is described by local structural types (extension/pi-types.ts). Only node: modules are
// imported.
const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
};

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return /\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function bareImports(): Set<string> {
  const names = new Set<string>();
  for (const entry of manifest.files) {
    const path = join(root, entry);
    let files: string[];
    try {
      files = sourceFiles(path);
    } catch {
      continue;
    }
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\b(?:from|import)\s+'([^'.][^']*)'/g)) {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('node:')) names.add(packageName(specifier));
      }
    }
  }
  return names;
}

describe('published package', () => {
  it('imports only node: modules', () => {
    assert.deepEqual([...bareImports()], []);
  });

  it('has no runtime or peer dependencies to install', () => {
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
  });

  it('declares the extension entry and publishes it', () => {
    assert.deepEqual(manifest.pi?.extensions, ['./extension/index.ts']);
    assert.ok(statSync(join(root, 'extension/index.ts')).isFile());
    assert.ok(manifest.files.includes('extension/'));
  });
});

describe('extension/core', () => {
  const vendored = readdirSync(join(root, 'extension/core'));

  it('vendors core sources', () => {
    assert.ok(vendored.length > 0);
  });

  for (const file of vendored) {
    it(`${file} is a verbatim copy of packages/core/src/${file}`, () => {
      const copy = readFileSync(join(root, 'extension/core', file), 'utf8');
      const original = readFileSync(join(root, '../core/src', file), 'utf8');
      assert.equal(
        copy,
        original,
        `run: cp packages/core/src/${file} packages/pi-plugin/extension/core/`,
      );
    });
  }
});

describe('extension/launcher', () => {
  const vendored = readdirSync(join(root, 'extension/launcher'));

  it('vendors launcher sources', () => {
    assert.ok(vendored.length > 0);
  });

  for (const file of vendored) {
    it(`${file} is a verbatim copy of packages/launcher/src/${file}`, () => {
      const copy = readFileSync(join(root, 'extension/launcher', file), 'utf8');
      const original = readFileSync(join(root, '../launcher/src', file), 'utf8');
      assert.equal(
        copy,
        original,
        `run: cp packages/launcher/src/${file} packages/pi-plugin/extension/launcher/`,
      );
    });
  }
});
