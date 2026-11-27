import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type FetchInput = string | URL | Request;

function requestUrl(input: FetchInput): URL {
  if (input instanceof Request) return new URL(input.url);
  return input instanceof URL ? input : new URL(input);
}

function headersOf(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function bodyOf(input: FetchInput, init: RequestInit): Promise<Buffer | undefined> {
  const body =
    init.body !== undefined ? init.body : input instanceof Request ? input.body : undefined;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(await new Response(body).arrayBuffer());
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, item);
  }
  return result;
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function readResponse(
  response: IncomingMessage,
  signal: AbortSignal | null,
  redirect: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const status = response.statusCode ?? 500;
    if (redirect === 'error' && status >= 300 && status < 400) {
      response.destroy();
      reject(new TypeError('redirects are not supported by socketFetch'));
      return;
    }
    response.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_RESPONSE_BYTES) {
        response.destroy(new Error('socketFetch response exceeded 8 MiB'));
        return;
      }
      chunks.push(bytes);
    });
    response.once('error', reject);
    response.once('end', () => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
      resolve(
        new Response(body, {
          status,
          ...(response.statusMessage === undefined ? {} : { statusText: response.statusMessage }),
          headers: responseHeaders(response.headers),
        }),
      );
    });
  });
}

function optionsFor(
  url: URL,
  init: RequestInit,
  input: FetchInput,
  headers: Record<string, string>,
  socketPath: string,
): RequestOptions {
  return {
    socketPath,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? (input instanceof Request ? input.method : 'GET'),
    headers,
  };
}

/** Fetch-compatible HTTP transport over a private Unix socket. It never follows redirects. */
export function socketFetch(socketPath: string): typeof fetch {
  return async (input: FetchInput, init: RequestInit = {}) => {
    const url = requestUrl(input);
    const headers = headersOf(input instanceof Request ? input.headers : undefined);
    Object.assign(headers, headersOf(init.headers));
    const body = await bodyOf(input, init);
    if (
      body !== undefined &&
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')
    ) {
      headers['content-length'] = String(body.length);
    }
    const signal =
      init.signal === undefined ? (input instanceof Request ? input.signal : null) : init.signal;
    if (signal?.aborted) throw abortError();
    const req = httpRequest(optionsFor(url, init, input, headers, socketPath));
    const abort = (): void => {
      req.destroy(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw abortError();
      const response = new Promise<Response>((resolve, reject) => {
        req.once('error', reject);
        req.once('response', (res) => {
          void readResponse(
            res,
            signal,
            init.redirect ?? (input instanceof Request ? input.redirect : 'follow'),
          ).then(resolve, reject);
        });
      });
      if (body !== undefined) req.write(body);
      req.end();
      return await response;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };
}
