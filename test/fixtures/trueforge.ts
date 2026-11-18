/**
 * Starts a private TrueForge (npx @truefoundry/trueforge@0.185.1) for integration tests,
 * on its own port and SQLite file so the developer's default database is never touched.
 * Resolves undefined (tests skip) when it cannot start.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TrueForgeProcess {
  url: string;
  port: number;
  sqlitePath: string;
  logs: string[];
  stop(): Promise<void>;
}

export const TRUEFORGE_VERSION = '0.185.1';

export function testDataDir(): string {
  return process.env.ANVIL_TF_TEST_DIR || path.join(os.tmpdir(), 'anvil-tf-test');
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* gone */
    }
  }
}

export async function startTrueForge(
  port = 8791,
  extraEnv: Record<string, string> = {},
  timeoutMs = 150_000,
): Promise<TrueForgeProcess | undefined> {
  const url = `http://127.0.0.1:${port}`;
  if (await healthy(url)) {
    console.warn(`[trueforge] something already answers on ${url}; refusing to reuse it`);
    return undefined;
  }
  const dir = testDataDir();
  mkdirSync(dir, { recursive: true });
  const sqlitePath = path.join(dir, `tf-${process.pid}-${Date.now()}.sqlite`);
  const logs: string[] = [];
  const child = spawn('npx', ['-y', `@truefoundry/trueforge@${TRUEFORGE_VERSION}`], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_PATH: sqlitePath,
      OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1","localhost"]',
      TURN_PAUSED_KEEPALIVE_SECONDS: '3600',
      MCP_REQUEST_TIMEOUT_MS: '600000',
      ACCESS_LOGS: 'false',
      ...extraEnv,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (b: Buffer) => {
    for (const line of b.toString('utf8').split('\n')) if (line.trim()) logs.push(line);
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => child.once('exit', () => ((exited = true), resolve())));

  const stop = async () => {
    if (!exited) {
      killTree(child, 'SIGTERM');
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
      if (!exited) killTree(child, 'SIGKILL');
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000))]);
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(sqlitePath + suffix, { force: true });
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      console.warn(`[trueforge] exited during startup:\n${logs.slice(-20).join('\n')}`);
      await stop();
      return undefined;
    }
    if (await healthy(url)) return { url, port, sqlitePath, logs, stop };
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[trueforge] did not become healthy within ${timeoutMs} ms:\n${logs.slice(-20).join('\n')}`);
  await stop();
  return undefined;
}
