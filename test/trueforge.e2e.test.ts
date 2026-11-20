/**
 * End-to-end: a private TrueForge 0.185.1 + a deterministic fake OpenAI-compatible model
 * + Anvil's editor MCP server + the TrueForge runtime. Skips cleanly when TrueForge
 * cannot be started (no network for npx, port taken, ...).
 */
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDecision, EditGate, RetrievalResult, RunHandle, ToolCallInfo, TrueForgeService, UiEvent } from '../src/shared/contracts';
import { EDIT_TOOLS } from '../src/shared/contracts';
import type { Logger } from '../src/shared/log';
import { createTrueForgeService, type TrueForgeSettings } from '../src/trueforge';
import { createEditGate, startEditorMcpServer, type EditorMcpServerHandle } from '../src/mcp';
import { startFakeModel, type FakeModelServer } from './fixtures/fakeModel';
import { startTrueForge, type TrueForgeProcess } from './fixtures/trueforge';
import { APP_PY, acceptAll, acceptOnly, createTestHost, rejectAll, seed, type TestHost } from './fixtures/host';

vi.mock('../src/context', () => ({
  formatRetrieval: (r: RetrievalResult) => `Relevant files for "${r.query}": ${r.files.map((f) => `${f.path} (${f.reasons.join('; ')})`).join(', ')}`,
}));

const logLines: string[] = [];
const log: Logger = {
  info: (m) => void logLines.push(`INFO ${m}`),
  warn: (m) => void logLines.push(`WARN ${m}`),
  error: (m, ...r) => void logLines.push(`ERROR ${m} ${r.map(String).join(' ')}`),
  debug: () => undefined,
};

const TOKEN = `tok-${Math.random().toString(36).slice(2)}`;
const MCP_NAME = 'anvil-editor-9876';
let tf: TrueForgeProcess | undefined;
let fake: FakeModelServer;
let host: TestHost;
let gate: EditGate;
let mcp: EditorMcpServerHandle;
let service: TrueForgeService;
const settings: TrueForgeSettings = {
  trueforgeUrl: 'http://127.0.0.1:8791',
  models: ['fake/script', 'fake/echo'],
  retryMaxAttempts: 3,
  coderAgent: 'anvil-coder',
  inlineAgent: 'anvil-inline',
};

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${tf!.url}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j as T;
}

async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function models(...names: string[]) {
  return names.map((n) => ({ model_id: n, name: n, properties: { context_length: 32000, max_output_tokens: 4000 } }));
}

beforeAll(async () => {
  // Short paused-turn keepalive so the offload/re-subscribe path is exercised (the launcher script uses 3600).
  tf = await startTrueForge(await closedPort(), { TURN_PAUSED_KEEPALIVE_SECONDS: '2' });
  if (!tf) {
    if (process.env.ANVIL_REQUIRE_INTEGRATION === '1') throw new Error('Required TrueForge integration runtime failed to start.');
    return;
  }
  settings.trueforgeUrl = tf.url;
  fake = await startFakeModel({ editPath: 'app.py', slowChunkMs: 100 });
  await api('PUT', '/api/v1/settings/model-providers', {
    manifest: { type: 'custom', name: 'fake', base_url: fake.url, models: models('script', 'scout', 'multi', 'cmd', 'fail-cmd', 'echo', 'unauthorized', 'slow', 'effect-fail') },
  });
  await api('PUT', '/api/v1/settings/model-providers', {
    manifest: { type: 'custom', name: 'down', base_url: `http://127.0.0.1:${await closedPort()}/v1`, models: models('down') },
  });
  host = createTestHost();
  gate = createEditGate(host);
  mcp = await startEditorMcpServer(host, gate, { port: 0, token: TOKEN, name: MCP_NAME, log });
  service = createTrueForgeService({
    agentsDir: fileURLToPath(new URL('../agents', import.meta.url)),
    settings: () => settings,
    mcp: () => ({ url: mcp.url, token: TOKEN }),
    mcpServerName: MCP_NAME,
    log,
  });
  host.setTrueForge(service);
  await service.ensureSetup();
}, 240_000);

afterAll(async () => {
  await mcp?.dispose();
  await fake?.close();
  await tf?.stop();
  host?.cleanup();
}, 30_000);

beforeEach(async (ctx) => {
  if (!tf) {
    ctx.skip();
    return;
  }
  await seed(host, { 'app.py': APP_PY });
  host.emitted.length = 0;
  host.reviews.length = 0;
  host.applied.length = 0;
  host.setPolicy(acceptAll);
  settings.models = ['fake/script', 'fake/echo'];
  settings.retryMaxAttempts = 3;
});

interface Started {
  handle: RunHandle;
  events: UiEvent[];
}

function start(
  prompt: string,
  opts: { kind?: 'agent' | 'inline'; sessionId?: string; onApproval?: (call: ToolCallInfo, runId: string, h: RunHandle) => Promise<ApprovalDecision> } = {},
): Started {
  const events: UiEvent[] = [];
  let handle!: RunHandle;
  handle = service.startRun({
    kind: opts.kind ?? 'agent',
    prompt,
    sessionId: opts.sessionId,
    onEvent: (e) => events.push(e),
    onApproval: (call, runId) =>
      opts.onApproval
        ? opts.onApproval(call, runId, handle)
        : EDIT_TOOLS.includes(call.name)
          ? gate.reviewToolCall(call, runId, handle.sessionId!)
          : Promise.resolve({ status: 'allow' }),
  });
  return { handle, events };
}

const ofType = <T extends UiEvent['type']>(events: UiEvent[], t: T) => events.filter((e) => e.type === t) as Extract<UiEvent, { type: T }>[];

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function turnsOf(sid: string) {
  const r = await api<{ data: Array<{ id: string; previous_turn_id: string | null; created_at: string; state: { status: string; message?: string } }> }>('GET', `/api/v1/sessions/${sid}/turns`);
  return [...r.data].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

describe('TrueForge runtime + editor MCP server (live TrueForge)', () => {
  it('reports nonzero command exits as failed tool results through real TrueForge', async () => {
    settings.models = ['fake/fail-cmd'];
    const { handle, events } = start('Verify the change.');
    expect((await handle.done).status).toBe('done');
    const result = ofType(events, 'tool.result').find(event => event.name === 'run_command');
    expect(result).toMatchObject({ ok: false, summary: expect.stringContaining('exit code 7') });
  }, 30_000);

  it('executes a scripted three-file review loop and an approved verification command', async () => {
    // Protocol coverage only: scripted filenames are not evidence of real-model discovery.
    settings.models = ['fake/multi'];
    const { handle, events } = start('Update the greeting and include its tests and documentation.');
    const result = await handle.done;
    expect(result.status).toBe('done');
    expect(host.applied.map(change => change.relPath)).toEqual(['app.py', 'tests/test_app.py', 'docs/usage.md']);
    expect(host.reviews).toHaveLength(3);
    expect(ofType(events, 'approval.requested').map(event => event.kind)).toEqual(['edit', 'edit', 'edit', 'command']);
    expect(ofType(events, 'tool.result').some(event => event.name === 'run_command' && event.summary.includes('verified'))).toBe(true);
    expect(host.emitted.filter(item => item.event.type === 'change.applied')).toHaveLength(3);
  }, 60_000);

  it('health, model chain, MCP registration and tool listing', async () => {
    const h = await service.health();
    expect(h.ok).toBe(true);
    expect(h.version).toBe('0.185.1');
    expect(await service.listModels()).toEqual(expect.arrayContaining(['fake/script', 'fake/echo', 'fake/unauthorized', 'down/down']));
    expect(await service.modelChain()).toEqual(['fake/script', 'fake/echo']);
    settings.models = [];
    const all = await service.modelChain();
    expect(all).toEqual(expect.arrayContaining(['fake/script', 'down/down']));
    // TrueForge connects to our MCP server (token header) and lists the tools with annotations.
    const tools = JSON.stringify(await api('GET', `/api/v1/mcp-servers/${MCP_NAME}/tools`));
    for (const name of ['retrieve_context', 'repo_map', 'search_code', 'find_symbol', 'read_file', 'list_files', 'edit_file', 'write_file', 'run_command', 'get_diagnostics']) {
      expect(tools).toContain(name);
    }
    expect(tools).toContain('destructive');
    const agents = await api<{ data: Array<{ name: string; manifest: { model: { name: string } } }> }>('GET', '/api/v1/agents');
    const coder = agents.data.find((a) => a.name === 'anvil-coder');
    const inline = agents.data.find((a) => a.name === 'anvil-inline');
    expect(coder?.manifest.model.name).toBe('fake/script');
    expect(inline?.manifest.model.name).toBe('fake/script');
  });

  it('agent run: retrieve_context -> edit_file approval -> per-hunk review -> only accepted hunk applied', async () => {
    host.setPolicy(acceptOnly([0]));
    const { handle, events } = start('Make the greeting say hello world and make add() coerce its arguments to int');
    const result = await handle.done;
    if (result.status !== 'done' || process.env.ANVIL_TEST_TRACE) {
      console.log(result, logLines.slice(-30));
      console.log(events.map((e) => JSON.stringify(e).slice(0, 220)).join('\n'));
      console.log(fake.requests.map((r) => `${r.model} tools=${r.tools.join(',')} msgs=${r.messages.length}`).join('\n'));
    }
    expect(result.status).toBe('done');
    const sid = handle.sessionId!;
    expect(sid).toBeTruthy();

    const started = ofType(events, 'run.started')[0];
    expect(started.sessionUrl).toBe(`${tf!.url}/sessions/${sid}`);
    expect(started.model).toBe('fake/script');
    expect(events[0].type).toBe('run.started');

    // Streaming tool calls: first seen as 'streaming' with args growing, then running/done.
    const editCalls = ofType(events, 'tool.call').filter((e) => e.name === 'edit_file');
    expect(editCalls[0].status).toBe('streaming');
    expect(editCalls.map((e) => e.status)).toEqual(expect.arrayContaining(['streaming', 'awaiting-approval', 'running', 'done']));
    expect(Math.max(...editCalls.map((e) => e.argsChars ?? 0))).toBeGreaterThan(50);
    const ctxCalls = ofType(events, 'tool.call').filter((e) => e.name === 'retrieve_context');
    expect(ctxCalls.at(-1)?.status).toBe('done');

    // The MCP tool call carried x-tfg-session-id and was routed to this run.
    const ctxEmit = host.emitted.find((e) => e.event.type === 'context.selected');
    expect(ctxEmit?.sid).toBe(sid);
    expect(ctxEmit?.event.type === 'context.selected' && ctxEmit.event.runId).toBe(handle.runId);

    // Approval -> review -> allow.
    const req = ofType(events, 'approval.requested')[0];
    expect(req.kind).toBe('edit');
    expect(req.call.name).toBe('edit_file');
    expect(req.call.args.path).toBe('app.py');
    expect(req.call.threadId).toBe('main');
    expect(ofType(events, 'approval.resolved')[0]).toMatchObject({ decision: 'allow', callId: req.call.callId });
    expect(host.reviews).toHaveLength(1);

    // Only hunk 1 of 2 landed.
    const text = await host.read('app.py');
    expect(text).toContain('GREETING = "hello, world"');
    expect(text).toContain('    return a + b');
    expect(text).not.toContain('int(a)');
    const applied = host.emitted.find((e) => e.event.type === 'change.applied');
    expect(applied?.event).toMatchObject({ type: 'change.applied', runId: handle.runId, change: { relPath: 'app.py', hunksApplied: 1, hunksTotal: 2, linesAdded: 1, linesRemoved: 1 } });
    const editResult = ofType(events, 'tool.result').find((e) => e.name === 'edit_file');
    expect(editResult?.ok).toBe(true);
    expect(editResult?.summary).toContain('Applied hunk 1 of 2 to app.py');
    expect(editResult?.summary).toContain('rejected hunk 2');
    expect(host.context.refreshFile).toBeDefined();
    expect((host.context as unknown as { refreshed: string[] }).refreshed).toContain('app.py');

    // Final main-thread text (the model read the tool result) + streamed deltas.
    expect(result.text).toContain('Applied hunk 1 of 2 to app.py');
    expect(ofType(events, 'text.delta').length).toBeGreaterThan(1);
    expect(ofType(events, 'reasoning.delta').length).toBeGreaterThan(0);
    const done = ofType(events, 'run.done')[0];
    expect(done).toMatchObject({ status: 'done', model: 'fake/script', modelsTried: ['fake/script'] });
    expect(done.usage?.inputTokens).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe('run.done');
    expect(service.runForSession(sid)).toBeUndefined();
  }, 90_000);

  it('sub-agent scout: thread events, its MCP calls are routed to the run, then the main thread edits', async () => {
    settings.models = ['fake/scout'];
    const { handle, events } = start('Make the greeting say hello world');
    const result = await handle.done;
    expect(result.status).toBe('done');
    const sub = ofType(events, 'subagent.started')[0];
    expect(sub).toMatchObject({ name: 'context-scout' });
    expect(sub.input).toContain('Find the code for');
    expect(sub.threadId).not.toBe('main');
    const subCtx = ofType(events, 'tool.call').filter((e) => e.name === 'retrieve_context');
    expect(subCtx.every((e) => e.threadId === sub.threadId)).toBe(true);
    expect(subCtx.at(-1)?.status).toBe('done');
    const subDone = ofType(events, 'subagent.done')[0];
    expect(subDone).toMatchObject({ threadId: sub.threadId, ok: true });
    expect(subDone.output).toContain('app.py:1-21');
    expect(host.emitted.some((e) => e.sid === handle.sessionId && e.event.type === 'context.selected')).toBe(true);
    expect(ofType(events, 'approval.requested')[0].call.threadId).toBe('main');
    expect(await host.read('app.py')).toContain('return int(a) + int(b)');
  }, 90_000);

  it('a paused turn outlives the SSE stream: re-subscribes after the keepalive offload and completes', async () => {
    const { handle } = start('Make the greeting say hello world', {
      onApproval: async (call, runId, h) => {
        await new Promise((r) => setTimeout(r, 4500)); // > TURN_PAUSED_KEEPALIVE_SECONDS (2 s)
        return gate.reviewToolCall(call, runId, h.sessionId!);
      },
    });
    const result = await handle.done;
    expect(result.status).toBe('done');
    expect(logLines.some((l) => l.includes('re-subscribing'))).toBe(true);
    const text = await host.read('app.py');
    expect(text).toContain('GREETING = "hello, world"');
    expect(text).toContain('return int(a) + int(b)');
    expect(result.text).toContain('Applied all 2 hunks to app.py');
  }, 60_000);

  it('rejecting every hunk denies the call; nothing is written', async () => {
    host.setPolicy(rejectAll);
    const { handle, events } = start('Make the greeting say hello world');
    const result = await handle.done;
    expect(result.status).toBe('done');
    const resolved = ofType(events, 'approval.resolved')[0];
    expect(resolved.decision).toBe('deny');
    expect(resolved.reason).toContain('User rejected all 2 hunks of the change to app.py');
    expect(ofType(events, 'tool.call').filter((e) => e.name === 'edit_file').at(-1)?.status).toBe('denied');
    expect(await host.read('app.py')).toBe(APP_PY);
    expect(host.applied).toHaveLength(0);
  }, 90_000);

  it('cancel mid-stream is immediate, ends the TrueForge turn as cancelled and writes nothing', async () => {
    settings.models = ['fake/slow'];
    const { handle, events } = start('Write a long essay');
    await waitFor(() => ofType(events, 'text.delta').length >= 3);
    const t0 = Date.now();
    await handle.cancel();
    const result = await handle.done;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(result.status).toBe('cancelled');
    expect(ofType(events, 'run.done')[0].status).toBe('cancelled');
    const sid = handle.sessionId!;
    let turns = await turnsOf(sid);
    for (let i = 0; i < 40 && turns.at(-1)?.state.status !== 'cancelled'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      turns = await turnsOf(sid);
    }
    expect(turns.at(-1)?.state.status).toBe('cancelled');
    expect(await host.read('app.py')).toBe(APP_PY);
    await handle.cancel(); // idempotent, never throws
  }, 60_000);

  it('cancel while an edit awaits approval denies it and leaves the workspace unchanged', async () => {
    settings.models = ['fake/script'];
    const { handle, events } = start('Make the greeting say hello world', {
      onApproval: () => new Promise<ApprovalDecision>(() => undefined), // the user never decides
    });
    await waitFor(() => ofType(events, 'approval.requested').length > 0, 30_000);
    await handle.cancel();
    const result = await handle.done;
    expect(result.status).toBe('cancelled');
    expect(ofType(events, 'approval.resolved')[0]).toMatchObject({ decision: 'deny' });
    gate.forgetRun(handle.runId);
    expect(await gate.applyReviewed('edit_file', ofType(events, 'approval.requested')[0].call.args, handle.sessionId)).toMatch(/^Not applied/);
    let turns = await turnsOf(handle.sessionId!);
    for (let i = 0; i < 40 && turns.at(-1)?.state.status !== 'cancelled'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      turns = await turnsOf(handle.sessionId!);
    }
    expect(turns.at(-1)?.state.status).toBe('cancelled');
    expect(await host.read('app.py')).toBe(APP_PY);
  }, 60_000);

  it('cancel during an approved run_command: TrueForge cancels the MCP call and the process group is killed', async () => {
    settings.models = ['fake/cmd'];
    const pidFile = path.join(host.root, 'child.pid');
    rmSync(pidFile, { force: true });
    const { handle, events } = start('run the slow thing', { onApproval: async () => ({ status: 'allow' }) });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0, 30_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(ofType(events, 'approval.requested')[0]).toMatchObject({ kind: 'command', call: { name: 'run_command' } });
    await handle.cancel();
    expect((await handle.done).status).toBe('cancelled');
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 60_000);

  it('primary 401 -> automatic fallback to the second model in the same session, no retries', async () => {
    settings.models = ['fake/unauthorized', 'fake/echo'];
    const { handle, events } = start('hi there');
    const result = await handle.done;
    expect(result.status).toBe('done');
    expect(result.text).toBe('echo: hi there');
    expect(result.model).toBe('fake/echo');
    expect(result.modelsTried).toEqual(['fake/unauthorized', 'fake/echo']);
    expect(ofType(events, 'model.retry')).toHaveLength(0);
    const fb = ofType(events, 'model.fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ from: 'fake/unauthorized', to: 'fake/echo' });
    expect(fb[0].error).toMatch(/401|Incorrect API key/);
    // One session, failed turn then a clean retry on the fallback model.
    const turns = await turnsOf(handle.sessionId!);
    expect(turns.map((t) => t.state.status)).toEqual(['error', 'done']);
    const sess = await api<{ data: { agent: { type: string; spec: { model: { name: string } } } } }>('GET', `/api/v1/sessions/${handle.sessionId}`);
    expect(sess.data.agent.spec.model.name).toBe('fake/echo');
    expect(await host.read('app.py')).toBe(APP_PY);
  }, 60_000);

  it('ECONNREFUSED primary -> visible retries with 1 s / 2 s backoff, then fallback', async () => {
    settings.models = ['down/down', 'fake/echo'];
    const t0 = Date.now();
    const { handle, events } = start('ping');
    const result = await handle.done;
    expect(result.status).toBe('done');
    expect(result.text).toBe('echo: ping');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    const retries = ofType(events, 'model.retry');
    expect(retries.map((r) => [r.attempt, r.delayMs, r.maxAttempts])).toEqual([
      [2, 1000, 3],
      [3, 2000, 3],
    ]);
    expect(retries[0].error).toMatch(/ECONNREFUSED|Cannot connect/);
    const fb = ofType(events, 'model.fallback');
    expect(fb[0]).toMatchObject({ from: 'down/down', to: 'fake/echo' });
    expect(events.findIndex((e) => e.type === 'model.fallback')).toBeGreaterThan(events.findIndex((e) => e.type === 'model.retry'));
  }, 60_000);

  it('retries and falls back with the failed turn’s completed edit in history', async () => {
    settings.models = ['fake/effect-fail', 'fake/echo'];
    settings.retryMaxAttempts = 2;
    const requestStart = fake.requests.length;
    const { handle, events } = start('Make the greeting say hello world');
    const result = await handle.done;
    expect(result).toMatchObject({ status: 'done', model: 'fake/echo' });
    expect(ofType(events, 'model.retry')).toHaveLength(1);
    expect(ofType(events, 'model.fallback')).toHaveLength(1);
    expect(host.applied).toHaveLength(1);
    const continuations = fake.requests.slice(requestStart).filter((req) =>
      JSON.stringify(req.messages).includes('Continue the same task from where it stopped'));
    expect(continuations.map((req) => req.model)).toEqual(['effect-fail', 'echo']);
    for (const req of continuations) {
      expect(req.messages.find((m) => m.role === 'tool')?.content).toContain('Applied all 2 hunks to app.py');
    }
    const turns = await turnsOf(handle.sessionId!);
    expect(turns.map((t) => t.state.status)).toEqual(['error', 'error', 'done']);
    expect(turns.slice(1).map((t) => t.previous_turn_id)).toEqual([turns[0].id, turns[0].id]);
  }, 60_000);

  it('every model failing ends with a clear error naming each model', async () => {
    settings.models = ['fake/unauthorized'];
    const { handle, events } = start('hello');
    const result = await handle.done;
    expect(result.status).toBe('error');
    expect(result.error).toContain('fake/unauthorized');
    expect(result.error).toMatch(/401/);
    expect(ofType(events, 'run.done')[0]).toMatchObject({ status: 'error', modelsTried: ['fake/unauthorized'] });
  }, 30_000);

  it('follow-up turns reuse the session and continue from the last good turn', async () => {
    settings.models = ['fake/echo'];
    const first = start('first message');
    const r1 = await first.handle.done;
    expect(r1.status).toBe('done');
    const second = start('second message', { sessionId: first.handle.sessionId });
    const r2 = await second.handle.done;
    expect(r2.status).toBe('done');
    expect(second.handle.sessionId).toBe(first.handle.sessionId);
    const last = fake.requests.filter((r) => r.model === 'echo' && r.stream).at(-1)!;
    const contents = JSON.stringify(last.messages);
    expect(contents).toContain('first message');
    expect(contents).toContain('second message');
    expect((await turnsOf(first.handle.sessionId!)).length).toBe(2);
  }, 60_000);

  it('inline runs use the inline agent in a fresh session', async () => {
    settings.models = ['fake/echo'];
    const a = start('rewrite this', { kind: 'inline' });
    const ra = await a.handle.done;
    expect(ra.status).toBe('done');
    expect(ra.text).toBe('echo: rewrite this');
    const sess = await api<{ data: { metadata?: Record<string, string>; agent: { spec: { instructions: string; mcp_servers: Array<{ name: string }> } } } }>('GET', `/api/v1/sessions/${a.handle.sessionId}`);
    expect(sess.data.metadata?.anvil_agent).toBe('anvil-inline');
    expect(sess.data.agent.spec.mcp_servers.map((s) => s.name)).toEqual([MCP_NAME]);
    expect(sess.data.agent.spec.instructions).toContain(`read-only ${MCP_NAME} tools`);
  }, 30_000);
});
