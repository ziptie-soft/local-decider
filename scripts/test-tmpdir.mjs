// Loaded with `node --import` by every package's test script. Tests make their scratch
// directories with mkdtemp(tmpdir()); pointing TMPDIR at one directory per run keeps them
// all in one place, and removing it on exit stops them from piling up in the system /tmp.
// The test runner's file processes inherit TMPDIR, so their directories land inside too.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ld-run-'));
process.env['TMPDIR'] = root;
process.env['TMP'] = root;
process.env['TEMP'] = root;
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
