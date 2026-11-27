const TITLE_PREFIX = 'local-decider: ';
const ALLOWED_TITLE = /[^A-Za-z0-9._:/@+\- ]/g;
const TITLE_LIMIT = 64;

/** Build a short title from configured ids; never include filesystem paths or request text. */
export function processTitle(engine: string, model: string): string {
  const safe = `${engine} ${model}`.replaceAll(ALLOWED_TITLE, '_').replaceAll(/\s+/g, ' ').trim();
  return `${TITLE_PREFIX}${safe}`.slice(0, TITLE_LIMIT);
}
