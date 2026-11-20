/**
 * run_command implementation: `/bin/bash -c <command>` in its own process group, so a
 * cancel (MCP notifications/cancelled -> AbortSignal) or a timeout kills the whole tree.
 */
import { spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  seconds: number;
  output: string;
}

const KEEP_CHARS = 64_000;

export function runShellCommand(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds: number; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > KEEP_CHARS * 2) output = output.slice(-KEEP_CHARS);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/bash', ['-c', command], {
        cwd: opts.cwd,
        env: opts.env,
        detached: true, // new process group: kill(-pid) reaches every descendant
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, signal: null, timedOut: false, aborted: false, seconds: 0, output: `failed to start: ${(err as Error).message}` });
      return;
    }

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 2000);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, opts.timeoutSeconds) * 1000);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer && !timedOut && !aborted) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, signal, timedOut, aborted, seconds: (Date.now() - started) / 1000, output: output + extra });
    };
    child.on('error', (err) => finish(null, null, `\n[spawn error] ${err.message}`));
    child.on('close', (code, sig) => finish(code, sig));
  });
}

export function formatCommandResult(r: CommandResult, tailChars = 8000): string {
  const secs = r.seconds < 10 ? r.seconds.toFixed(1) : Math.round(r.seconds).toString();
  let head = `exit code ${r.exitCode ?? (r.signal ? `none (killed by ${r.signal})` : 'unknown')} (${secs}s)`;
  if (r.timedOut) head += ' — timed out, process group killed';
  if (r.aborted) head += ' — cancelled, process group killed';
  const out = r.output;
  const tail = out.length > tailChars ? `[… ${out.length - tailChars} earlier chars omitted …]\n` + out.slice(-tailChars) : out;
  return tail.trim() ? `${head}\n${tail.replace(/\s+$/, '')}` : `${head}\n(no output)`;
}
