import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function outgoingOptions(request: Request, socketPath: string): RequestOptions {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  return {
    socketPath,
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
  };
}

function asHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, values] of Object.entries(input)) {
    for (const value of values === undefined ? [] : Array.isArray(values) ? values : [values]) {
      headers.append(name, value);
    }
  }
  return headers;
}

async function responseBody(
  response: IncomingMessage,
  signal: AbortSignal,
  redirect: NonNullable<RequestInit['redirect']>,
): Promise<Response> {
  const status = response.statusCode ?? 500;
  if (redirect === 'error' && status >= 300 && status < 400) {
    response.destroy();
    throw new TypeError('redirects are not supported by socketFetch');
  }
  const parts: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of response) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += part.byteLength;
    if (byteCount > MAX_RESPONSE_BYTES) {
      response.destroy(new Error('socketFetch response exceeded 8 MiB'));
      throw new Error('socketFetch response exceeded 8 MiB');
    }
    parts.push(part);
  }
  if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  return new Response(status === 204 || status === 304 ? null : Buffer.concat(parts), {
    status,
    ...(response.statusMessage === undefined ? {} : { statusText: response.statusMessage }),
    headers: asHeaders(response.headers),
  });
}

/** A fetch-shaped Node HTTP transport for the gateway's private Unix socket. */
export function socketFetch(socketPath: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal = request.signal;
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    const options = outgoingOptions(request, socketPath);
    const headers = options.headers as Record<string, string>;
    if (body !== undefined && !request.headers.has('content-length')) {
      headers['content-length'] = String(body.byteLength);
    }
    const req = httpRequest(options);
    const abort = (): void => {
      req.destroy(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const response = new Promise<Response>((resolve, reject) => {
        req.once('error', reject);
        req.once('response', (incoming) => {
          void responseBody(incoming, signal, request.redirect).then(resolve, reject);
        });
      });
      if (body !== undefined) req.write(body);
      req.end();
      return await response;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
}
