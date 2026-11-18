/**
 * Plain-Node EditorToolHost for tests: a temp workspace on disk, a stub context engine
 * and a scriptable ReviewService that applies only the accepted hunks (using the same
 * pure hunk helpers as the real review UI).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AppliedChange,
  ContextEngine,
  EditorToolHost,
  ProposedChange,
  RetrievalResult,
  ReviewOutcome,
  ReviewService,
  TrueForgeService,
  UiEvent,
} from '../../src/shared/contracts';
import { applyHunks, computeHunks } from '../../src/review/hunks';

export type ReviewPolicy = (change: ProposedChange, hunkCount: number) => Promise<Omit<ReviewOutcome, 'changeId'>> | Omit<ReviewOutcome, 'changeId'>;

export const acceptOnly = (indices: number[]): ReviewPolicy => (_c, n) => {
  const accepted = indices.filter((i) => i < n);
  const rejected = [...Array(n).keys()].filter((i) => !accepted.includes(i));
  return {
    status: 'decided',
    decisions: [...Array(n).keys()].map((i) => (accepted.includes(i) ? 'accepted' : 'rejected')),
    accepted,
    rejected,
  };
};

export const acceptAll: ReviewPolicy = (_c, n) => acceptOnly([...Array(n).keys()])(_c, n);
export const rejectAll: ReviewPolicy = (_c, n) => acceptOnly([])(_c, n);

export interface TestHost extends EditorToolHost {
  root: string;
  emitted: Array<{ sid: string | undefined; event: UiEvent }>;
  reviews: ProposedChange[];
  applied: AppliedChange[];
  setPolicy(p: ReviewPolicy): void;
  setTrueForge(tf: TrueForgeService): void;
  write(rel: string, text: string): Promise<void>;
  read(rel: string): Promise<string | null>;
  cleanup(): void;
}

export function fakeRetrieval(query: string): RetrievalResult {
  return {
    query,
    budgetTokens: 4000,
    usedTokens: 120,
    files: [
      {
        path: 'app.py',
        score: 3.2,
        reasons: ['defines GREETING and add()'],
        spans: [{ startLine: 1, endLine: 4, tokens: 40, text: 'GREETING = "hello"', mode: 'code' }],
      },
    ],
    omitted: [{ path: 'README.md', score: 0.4, reason: 'below relevance threshold' }],
    strategy: 'stub retrieval for tests',
    elapsedMs: 1,
    indexStats: { files: 2, chunks: 2, symbols: 3, totalTokens: 200, builtAt: Date.now(), buildMs: 1 },
  };
}

export function createStubContext(): ContextEngine & { refreshed: string[] } {
  const refreshed: string[] = [];
  return {
    refreshed,
    build: async () => fakeRetrieval('').indexStats,
    refreshFile: async (p: string) => void refreshed.push(p),
    removeFile: () => undefined,
    retrieve: (q: string, opts?: { budgetTokens?: number }) => ({ ...fakeRetrieval(q), budgetTokens: opts?.budgetTokens ?? 4000 }),
    repoMap: () => 'app.py\n  GREETING\n  greet(name)\n  add(a, b)',
    findSymbol: (name: string) =>
      name === 'add' ? [{ name: 'add', qualifiedName: 'add', kind: 'function', path: 'app.py', startLine: 20, endLine: 21, signature: 'def add(a, b):' }] : [],
    listFiles: () => ['app.py'],
    searchText: (pattern: string) => (pattern === 'GREETING' ? [{ path: 'app.py', line: 1, text: 'GREETING = "hello"' }] : []),
    suggest: () => [],
    fileText: () => undefined,
    stats: () => fakeRetrieval('').indexStats,
  } as ContextEngine & { refreshed: string[] };
}

export function createTestHost(): TestHost {
  const root = mkdtempSync(path.join(os.tmpdir(), 'anvil-ws-'));
  const emitted: TestHost['emitted'] = [];
  const reviews: ProposedChange[] = [];
  const applied: AppliedChange[] = [];
  let policy: ReviewPolicy = acceptAll;
  let tf: TrueForgeService | undefined;

  const abs = (rel: string) => path.join(root, rel);
  const read = async (rel: string) => {
    try {
      return await fs.readFile(abs(rel), 'utf8');
    } catch {
      return null;
    }
  };
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
    await fs.writeFile(abs(rel), text, 'utf8');
  };

  const review: ReviewService = {
    async review(change) {
      reviews.push(change);
      const n = computeHunks(change.originalText, change.proposedText).length;
      return { changeId: change.id, ...(await policy(change, n)) };
    },
    beginStreaming() {
      throw new Error('not used in tests');
    },
    async apply(change, outcome) {
      if (outcome.status !== 'decided' || !outcome.accepted.length) return null;
      const hunks = computeHunks(change.originalText, change.proposedText);
      const current = await read(change.relPath);
      if (!change.isNewFile && current !== change.originalText) throw new Error(`${change.relPath} changed since the proposal was made; nothing was applied.`);
      const after = applyHunks(change.originalText, hunks, outcome.accepted);
      await write(change.relPath, after);
      const a: AppliedChange = {
        id: change.id,
        runId: change.runId,
        relPath: change.relPath,
        uri: change.uri,
        before: change.isNewFile ? null : change.originalText,
        after,
        hunksApplied: [...outcome.accepted].sort((x, y) => x - y),
        hunksTotal: hunks.length,
        appliedAt: Date.now(),
        undone: false,
      };
      applied.push(a);
      return a;
    },
    cancelRun() {},
    journal: { list: () => applied, undo: async () => false, undoRun: async () => 0, onDidChange: () => ({ dispose() {} }) } as any,
    onDidApply: (() => ({ dispose() {} })) as any,
  };

  const host: TestHost = {
    root,
    emitted,
    reviews,
    applied,
    workspaceRoot: root,
    context: createStubContext(),
    review,
    get trueforge() {
      if (!tf) throw new Error('trueforge not set');
      return tf;
    },
    emit(sid, event) {
      emitted.push({ sid, event });
    },
    readText: read,
    toUri: (rel) => ({ scheme: 'file', fsPath: abs(rel), path: abs(rel), toString: () => `file://${abs(rel)}` }) as any,
    resolvePath(p) {
      const cleaned = String(p).replace(/\\/g, '/').replace(/^\.\/+/, '');
      const full = path.resolve(root, cleaned);
      if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`path escapes the workspace: ${p}`);
      return path.relative(root, full).split(path.sep).join('/');
    },
    diagnostics: (rel) => (rel ? `${rel}: no problems` : 'workspace: no problems'),
    commandEnv: () => ({ ...process.env, ANVIL_TEST: '1' }),
    commandTimeoutSeconds: () => 30,
    setPolicy: (p) => void (policy = p),
    setTrueForge: (t) => void (tf = t),
    write,
    read,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return host;
}

export async function seed(host: TestHost, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) await host.write(rel, text);
}

export const APP_PY = [
  'GREETING = "hello"',
  '',
  '',
  'def greet(name):',
  '    return f"{GREETING}, {name}"',
  '',
  '',
  'def shout(name):',
  '    return greet(name).upper()',
  '',
  '',
  'def whisper(name):',
  '    return greet(name).lower()',
  '',
  '',
  'def repeat(name, n):',
  '    return " ".join(greet(name) for _ in range(n))',
  '',
  '',
  'def add(a, b):',
  '    return a + b',
  '',
].join('\n');
