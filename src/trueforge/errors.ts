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
  // Sleeping cannot fix an oversized request. These errors can also mention
  // quota or "try again", so classify them before the transient patterns.
  if (/\b413\b|request (?:is )?too large|context_length_exceeded|maximum context length|exceeds? (?:the )?(?:model'?s? )?context/i.test(msg)) return 'model';
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

const RATE_LIMIT_RE = /\b429\b|quota|rate[\s_-]?limit|resource[\s_-]?exhausted|too many requests/i;
const OVERLOAD_RE = /\b(503|529)\b|high demand|overloaded|unavailable/i;

/** Provider quota / rate-limit errors: worth more patience than a dropped connection. */
export function isRateLimited(message: string): boolean {
  return RATE_LIMIT_RE.test(message ?? '');
}

/**
 * Backoff before retrying the same model. Free tiers reset per minute, so a 1-2 s retry
 * after a quota error is wasted: honour the provider's retry hint when it gives one,
 * otherwise wait 15s/30s/60s for quota errors, 5s/10s/20s for overload, and
 * base·2^n (1s/2s/4s) for connection errors. `base` scales everything (tests use a tiny base).
 */
export function retryDelayMs(message: string, attempt: number, base = 1000): number {
  const msg = message ?? '';
  const scale = base / 1000;
  const hint = /(?:retry|try again) (?:in|after) ([\d.]+)\s*s/i.exec(msg) ?? /"?retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i.exec(msg);
  if (hint) return Math.round(Math.min(60_000, parseFloat(hint[1]) * 1000 + 500) * scale);
  if (RATE_LIMIT_RE.test(msg)) return Math.round(Math.min(60_000, 15_000 * 2 ** (attempt - 1)) * scale);
  if (OVERLOAD_RE.test(msg)) return Math.round(Math.min(30_000, 5_000 * 2 ** (attempt - 1)) * scale);
  return base * 2 ** (attempt - 1);
}
