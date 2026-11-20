import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelDescriptor } from './engines/descriptor.ts';
import { MODELS, hfDownloadArgs } from './engines/strands/models.ts';
import type { Paths } from './paths.ts';

export type InstallFlavor = 'cpu' | 'mlx' | 'cuda' | 'rocm';

export function defaultFlavor(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): InstallFlavor {
  return platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'cpu';
}

/** The pinned uv project shipped with the gateway (`engines/strands-decider`). */
function engineProjectDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'engines', 'strands-decider');
}

/**
 * `uv sync` the pinned project into ~/.local/share/local-decider/venvs/strands-decider, then
 * pre-download the adapter and base weights into the Hugging Face cache.
 */
export function installStrandsEngine(
  paths: Paths,
  flavor: InstallFlavor,
  model: string | undefined,
): void {
  const project = engineProjectDir();
  if (!existsSync(join(project, 'pyproject.toml'))) {
    throw new Error(`engine project not found at ${project}`);
  }
  const venv = join(paths.venvs, 'strands-decider');
  execFileSync('uv', ['sync', '--project', project, '--locked', '--extra', flavor], {
    stdio: 'inherit',
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv },
  });
  if (model !== undefined) {
    downloadStrandsModel(venv, model);
  }
}

/** The pinned downloads for a catalogue model; throws when the adapter's base is not catalogued. */
export function planCatalogueDownloads(
  entry: ModelDescriptor<'strands-decider'>,
  baseModel: string,
  /** `base_model_revision` from the adapter's provenance.json, when it names the same base. */
  provenanceRevision = '',
): string[][] {
  const artifacts = entry.artifacts ?? [];
  if (baseModel !== '' && !artifacts.includes(baseModel)) {
    throw new Error(
      `${entry.id} declares base_model ${baseModel}, which is not one of its pinned artifacts ` +
        `(${artifacts.join(', ')}); refusing to download it`,
    );
  }
  const pinned = entry.revisions?.[baseModel];
  if (provenanceRevision !== '' && pinned !== undefined && provenanceRevision !== pinned) {
    throw new Error(
      `catalogue pin drift: ${entry.id} provenance records ${baseModel}@${provenanceRevision} ` +
        `but the catalogue pins ${pinned}; refusing to download`,
    );
  }
  return artifacts.map((repo) => hfDownloadArgs(repo, entry.revisions?.[repo]));
}

function downloadStrandsModel(venv: string, model: string): void {
  const hf = join(venv, 'bin', 'hf');
  const entry = MODELS.find((m) => m.id === model);
  const baseInfo = (revision?: string): { base: string; provenanceRevision: string } => {
    const argv = [
      '-I',
      '-c',
      BASE_MODEL_SCRIPT,
      model,
      ...(revision === undefined ? [] : [revision]),
    ];
    const [base = '', provenanceRevision = ''] = execFileSync(join(venv, 'bin', 'python'), argv, {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    return { base: base.trim(), provenanceRevision: provenanceRevision.trim() };
  };
  if (entry === undefined) {
    console.warn(`warning: ${model} is not in the catalogue; its weights are unpinned`);
    execFileSync(hf, hfDownloadArgs(model), { stdio: 'inherit' });
    const info = baseInfo().base;
    if (info !== '') {
      execFileSync(hf, hfDownloadArgs(info), { stdio: 'inherit' });
    }
    return;
  }
  // Download the pinned adapter first, then validate its declared base before fetching the rest.
  const [adapter] = planCatalogueDownloads(entry, '');
  if (adapter !== undefined) {
    execFileSync(hf, adapter, { stdio: 'inherit' });
  }
  const { base, provenanceRevision } = baseInfo(entry.revisions?.[model]);
  const [, ...rest] = planCatalogueDownloads(entry, base, provenanceRevision);
  for (const args of rest) {
    execFileSync(hf, args, { stdio: 'inherit' });
  }
}

/**
 * Prints the adapter's `base_model` (strands_decider_config.json) and, when provenance.json names
 * the same base, its `base_model_revision`, one per line; each is empty when absent. argv[2] is
 * the adapter's pinned revision, when known.
 */
const BASE_MODEL_SCRIPT = `
import json, sys
from huggingface_hub import hf_hub_download
rev = sys.argv[2] if len(sys.argv) > 2 else None
base = ""
prov_rev = ""
try:
    cfg = json.load(open(hf_hub_download(sys.argv[1], "strands_decider_config.json", revision=rev)))
    base = cfg.get("base_model", "")
    try:
        prov = json.load(open(hf_hub_download(sys.argv[1], "provenance.json", revision=rev)))
        if prov.get("base_model") == base:
            prov_rev = prov.get("base_model_revision") or ""
    except Exception:
        pass
except Exception:
    pass
print(base)
print(prov_rev)
`;
