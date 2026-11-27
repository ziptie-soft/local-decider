import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Paseo installs an npm plugin without its devDependencies and supplies only these host modules.
// The plugin imports nothing else: a runtime dependency would need a published npm-shrinkwrap.json
// for the Paseo plugin registry, so code shared with core is vendored under server/core/ instead.
const HOST_MODULES = [
  '@getpaseo/plugin',
  '@getpaseo/protocol',
  'react',
  'react-native',
  '@tanstack/react-query',
  'zod',
];

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files: string[];
  dependencies?: Record<string, string>;
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
      for (const match of source.matchAll(/\bfrom\s+'([^'.][^']*)'/g)) {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('node:')) names.add(packageName(specifier));
      }
    }
  }
  return names;
}

describe('published package', () => {
  it('imports only host modules', () => {
    const extra = [...bareImports()].filter((name) => !HOST_MODULES.includes(name));
    assert.deepEqual(extra, []);
  });

  it('has no runtime dependencies to install', () => {
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  });

  it('ships the listing overview, icon and media', () => {
    const plugin = JSON.parse(readFileSync(join(root, 'paseo-plugin.json'), 'utf8')) as {
      icon?: string;
      media?: string[];
    };
    const listing = ['OVERVIEW.md', plugin.icon ?? '', ...(plugin.media ?? [])];
    for (const path of listing) {
      assert.ok(statSync(join(root, path)).isFile(), `${path} is missing`);
      const published = manifest.files.some((entry) =>
        entry.endsWith('/') ? path.startsWith(entry) : path === entry,
      );
      assert.ok(published, `${path} is not covered by package.json files`);
    }
  });
});

describe('server/core', () => {
  for (const file of [
    'subject.ts',
    'canonical.ts',
    'truncate.ts',
    'input-cap.ts',
    'shell.ts',
    'paths.ts',
    'patch.ts',
    'block.ts',
    'guard.ts',
    'permission-input.ts',
  ]) {
    it(`${file} is a verbatim copy of packages/core/src/${file}`, () => {
      const copy = readFileSync(join(root, 'server/core', file), 'utf8');
      const original = readFileSync(join(root, '../core/src', file), 'utf8');
      assert.equal(
        copy,
        original,
        `run: cp packages/core/src/${file} packages/paseo-plugin/server/core/`,
      );
    });
  }
});

describe('server/launcher', () => {
  const vendored = readdirSync(join(root, 'server/launcher'));

  it('vendors launcher sources', () => {
    assert.ok(vendored.length > 0);
  });

  for (const file of vendored) {
    it(`${file} is a verbatim copy of packages/launcher/src/${file}`, () => {
      const copy = readFileSync(join(root, 'server/launcher', file), 'utf8');
      const original = readFileSync(join(root, '../launcher/src', file), 'utf8');
      assert.equal(
        copy,
        original,
        `run: cp packages/launcher/src/${file} packages/paseo-plugin/server/launcher/`,
      );
    });
  }
});
