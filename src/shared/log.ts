/**
 * Tiny logger that writes to a VS Code output channel when available and to
 * the console otherwise (unit tests, scripts).
 */
export interface Logger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  debug(msg: string, ...rest: unknown[]): void;
}

type Sink = (line: string) => void;

let sink: Sink = (line) => console.log(line);

export function setLogSink(next: Sink): void {
  sink = next;
}

function fmt(level: string, scope: string, msg: string, rest: unknown[]): string {
  const extra = rest.length
    ? ' ' + rest.map((r) => (r instanceof Error ? r.stack ?? r.message : typeof r === 'string' ? r : safeJson(r))).join(' ')
    : '';
  return `${new Date().toISOString().slice(11, 23)} ${level} [${scope}] ${msg}${extra}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(scope: string): Logger {
  return {
    info: (m, ...r) => sink(fmt('INFO ', scope, m, r)),
    warn: (m, ...r) => sink(fmt('WARN ', scope, m, r)),
    error: (m, ...r) => sink(fmt('ERROR', scope, m, r)),
    debug: (m, ...r) => sink(fmt('DEBUG', scope, m, r)),
  };
}
