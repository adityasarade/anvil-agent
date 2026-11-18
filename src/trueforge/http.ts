/**
 * Minimal JSON client for the TrueForge settings/registry endpoints. Manifests are
 * kept in TrueForge's wire format (snake_case), exactly as in agents/*.json and
 * config/models*.json, so they are sent verbatim instead of through the SDK's
 * camelCase serializers. Session and turn traffic goes through the SDK (index.ts).
 */
import { errorMessage } from './errors';

export class TrueForgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'TrueForgeHttpError';
  }
}

export class TrueForgeUnreachableError extends Error {
  constructor(readonly baseUrl: string, cause: unknown) {
    super(
      `TrueForge is not reachable at ${baseUrl} (${errorMessage(cause)}). Start it with \`npm run trueforge\` ` +
        `(HOST=127.0.0.1 npx @truefoundry/trueforge@0.185.1) and check the anvil.trueforgeUrl setting.`,
    );
    this.name = 'TrueForgeUnreachableError';
  }
}

/** Extracts `{"error":{"message"}}` (TrueForge's error shape) from a response body. */
export function apiErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body ? body : undefined;
  const e = (body as { error?: unknown }).error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  const m = (body as { message?: unknown }).message;
  return typeof m === 'string' ? m : undefined;
}

export interface JsonRequestOptions {
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestJson<T = any>(baseUrl: string, method: string, path: string, opts: JsonRequestOptions = {}): Promise<T> {
  const url = baseUrl.replace(/\/+$/, '') + path;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: opts.body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new TrueForgeUnreachableError(baseUrl, err);
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg = apiErrorMessage(parsed) ?? `${res.status} ${res.statusText}`;
    throw new TrueForgeHttpError(res.status, method, path, parsed, `${method} ${path} failed (${res.status}): ${msg}`);
  }
  return parsed as T;
}
