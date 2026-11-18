/**
 * Error classification for model failures reported by TrueForge (`turn.done` with
 * status "error", or HTTP errors when creating a session).
 *
 *  - 'auth'      bad/missing key, forbidden, unknown model: retrying the same model is pointless.
 *  - 'transient' connection refused, DNS, timeouts, 408/409/429/5xx: retry with backoff, then fall back.
 *  - 'model'     any other "[Model Error]": no retry, fall back to the next model.
 *  - 'other'     not a model problem (harness/tool/iteration limit): stop, do not fall back.
 */
export type ErrorClass = 'auth' | 'transient' | 'model' | 'other';

const AUTH_RE =
  /\b(401|403)\b|invalid[\s_-]*(x-)?(api[\s_-]*)?key|incorrect api key|api key not valid|api_key_invalid|unauthori[sz]ed|forbidden|permission[\s_-]denied|authentication|no api key|missing api key/i;
const MODEL_404_RE = /\b404\b|model[^.]{0,40}(not found|does not exist|not exist|unknown)|unknown model|not supported for|is not found/i;
const TRANSIENT_RE =
  /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR|socket hang up|timed?[\s-]?out|timeout|cannot connect|connection (error|closed|reset|refused)|network|fetch failed|\((408|409|429|5\d\d)\)|\b(408|409|429|500|502|503|504|520|521|522|523|524|529|530)\b|rate[\s_-]?limit|too many requests|overloaded|unavailable|resource[\s_-]exhausted|quota|try again/i;

export function isModelError(message: string): boolean {
  return /\[model error\]/i.test(message);
}

/**
 * Classifies a failure. Turn errors only count as model failures when TrueForge tagged
 * them "[Model Error]"; pass `modelError: true` for errors that are model-specific by
 * construction (e.g. session creation rejected the model).
 */
export function classifyError(message: string, opts: { modelError?: boolean } = {}): ErrorClass {
  const msg = message ?? '';
  const modelish = opts.modelError ?? isModelError(msg);
  if (!modelish) return 'other';
  if (AUTH_RE.test(msg) || MODEL_404_RE.test(msg)) return 'auth';
  if (TRANSIENT_RE.test(msg)) return 'transient';
  return 'model';
}

/** Short single-line version of an error message for UI events. */
export function shortError(message: string, max = 240): string {
  const one = String(message ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    const code = (cause as { code?: string } | undefined)?.code ?? (err as { code?: string }).code;
    return [err.message, causeMsg && causeMsg !== err.message ? causeMsg : '', code && !err.message.includes(code) ? code : '']
      .filter(Boolean)
      .join(': ');
  }
  return String(err);
}

/** True when the error means we could not reach TrueForge itself (not a model failure). */
export function isConnectionError(err: unknown): boolean {
  const msg = errorMessage(err);
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up|UND_ERR_CONNECT|Network error/i.test(msg);
}
