/**
 * Environment variables an engine child may inherit from the gateway. Engines are third-party
 * servers, so they get the basics and the Hugging Face, Python, accelerator and linker variables
 * they need, not the gateway's bearer, report or `tokenEnv` secrets.
 */
export const ENGINE_ENV_ALLOW: readonly RegExp[] = [
  /^(?:PATH|HOME|USER|LANG|TMPDIR|TZ|VIRTUAL_ENV|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH)$/,
  /^(?:LC|XDG|HF|HUGGINGFACE|TRANSFORMERS|TORCH|PYTORCH|OMP|MKL)_/,
  /^(?:CUDA|NVIDIA|HIP|HSA|ROCM|ROCR|HCC|AMD|MTL|MLX|LLAMA|GGML|MIOPEN|NCCL|RCCL)_/,
  // Network access the user configured for first-run downloads. Proxy URLs may embed
  // user:pass, but the user set them for exactly this traffic, so they pass through.
  /^(?:(?:HTTP|HTTPS|ALL|NO)_PROXY|(?:http|https|all|no)_proxy)$/,
  /^(?:SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GPU_DEVICE_ORDINAL)$/,
  // PYTHON*, minus the two that run or import code before the engine's own.
  /^PYTHON(?!STARTUP$|PATH$)/,
];

/** Names that must never pass even when they match an allowed prefix (`HF_TOKEN` as a tokenEnv). */
const secretNames = new Set<string>(['LOCAL_DECIDER_TOKEN', 'LM_API_TOKEN']);

/** Replaces the config-named secrets (`tokenEnv`) to withhold; the built-in names always stay. */
export function setSecretEnvNames(names: Iterable<string>): void {
  secretNames.clear();
  for (const name of ['LOCAL_DECIDER_TOKEN', 'LM_API_TOKEN', ...names]) {
    secretNames.add(name);
  }
}

/** Every `tokenEnv` value anywhere in a parsed config. */
export function configTokenEnvNames(config: unknown): string[] {
  const names: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'tokenEnv' && typeof child === 'string' && child !== '') {
        names.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(config);
  return names;
}

/** The allowlisted slice of `base`, then the spec's own `extra` (trusted, so never filtered). */
export function engineChildEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      !secretNames.has(name) &&
      ENGINE_ENV_ALLOW.some((pattern) => pattern.test(name))
    ) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}
