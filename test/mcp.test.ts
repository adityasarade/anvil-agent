/**
 * Editor MCP server + EditGate, in plain Node (no TrueForge, no VS Code):
 * edit matching, review gating, per-hunk apply messages, the HTTP/MCP surface
 * (token auth, x-tfg-session-id routing, annotations) and run_command cancellation.
 */
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EditGate, ReviewOutcome, RetrievalResult, ToolCallInfo, TrueForgeService } from '../src/shared/contracts';
import type { Logger } from '../src/shared/log';
import { applyTextEdits, createEditGate, formatFileSlice, startEditorMcpServer, type EditorMcpServerHandle } from '../src/mcp';
import { formatCommandResult, runShellCommand } from '../src/mcp/runCommand';
import { APP_PY, acceptAll, acceptOnly, createTestHost, rejectAll, seed, type TestHost } from './fixtures/host';

vi.mock('../src/context', () => ({
  formatRetrieval: (r: RetrievalResult) => `RETRIEVED(${r.query}; budget ${r.budgetTokens}): ${r.files.map((f) => f.path).join(', ')}`,
}));

const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const TOKEN = 'mcp-test-token';

const call = (name: string, args: Record<string, unknown>): ToolCallInfo => ({ callId: `c-${Math.random()}`, threadId: 'main', name, server: 'anvil-editor', args });

const EDITS = [
  { old_text: 'GREETING = "hello"', new_text: 'GREETING = "hello, world"' },
  { old_text: 'return a + b', new_text: 'return int(a) + int(b)' },
];

describe('applyTextEdits', () => {
  it('applies exact unique matches sequentially', () => {
    const r = applyTextEdits('a\nb\nc\n', [{ old_text: 'b', new_text: 'B' }, { old_text: 'B\nc', new_text: 'X' }], 'f.txt');
    expect(r).toEqual({ ok: true, text: 'a\nX\n' });
  });

  it('rejects ambiguous and missing old_text with precise, numbered reasons', () => {
    const amb = applyTextEdits('x = 1\nx = 1\n', [{ old_text: 'x = 1', new_text: 'x = 2' }], 'src/x.py');
    expect(amb).toEqual({ ok: false, reason: expect.stringContaining('edit 1: old_text matches 2 places in src/x.py') });
    const miss = applyTextEdits('a\nb\n', [{ old_text: 'a', new_text: 'A' }, { old_text: 'zzz', new_text: 'y' }], 'src/x.py');
    expect(miss.ok).toBe(false);
    expect(!miss.ok && miss.reason).toBe(
      'edit 2: old_text not found in src/x.py — re-read the exact lines with read_file and copy them verbatim (without the line-number prefix).',
    );
  });

  it('falls back to a whitespace-tolerant line match and maps indentation back', () => {
    const file = 'def f():\n    if x:\n        return 1   \n    return 2\n';
    const r = applyTextEdits(file, [{ old_text: 'if x:\n    return 1', new_text: 'if x and y:\n    return 10' }], 'f.py');
    expect(r).toEqual({ ok: true, text: 'def f():\n    if x and y:\n        return 10\n    return 2\n' });
  });

  it('strips read_file line-number prefixes copied into old_text', () => {
    const r = applyTextEdits('one\ntwo\nthree\n', [{ old_text: '   2| two\n   3| three', new_text: '   2| TWO\n   3| THREE' }], 'f.txt');
    expect(r).toEqual({ ok: true, text: 'one\nTWO\nTHREE\n' });
  });

  it('keeps CRLF files CRLF', () => {
    const r = applyTextEdits('a\r\nb\r\nc\r\n', [{ old_text: 'b\nc', new_text: 'B\nC' }], 'f.txt');
    expect(r).toEqual({ ok: true, text: 'a\r\nB\r\nC\r\n' });
  });

  it('refuses empty old_text', () => {
    expect(applyTextEdits('a', [{ old_text: '', new_text: 'x' }], 'f').ok).toBe(false);
  });
});

describe('formatFileSlice', () => {
  it('numbers lines, states the range and caps at 400 lines', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const r = formatFileSlice('big.txt', text, 10, 12);
    expect(r.text).toBe('big.txt (lines 10-12 of 1000)\n  10| line 10\n  11| line 11\n  12| line 12');
    const capped = formatFileSlice('big.txt', text);
    expect(capped.text.split('\n')[0]).toBe('big.txt (lines 1-400 of 1000)');
    expect(capped.text).toContain('call read_file with start_line=401 to continue');
    expect(formatFileSlice('big.txt', text, 2000).isError).toBe(true);
  });

  it('caps at 20,000 characters', () => {
    const text = Array.from({ length: 300 }, () => 'x'.repeat(200)).join('\n');
    const r = formatFileSlice('wide.txt', text);
    expect(r.text.length).toBeLessThan(20_500);
    expect(r.text).toMatch(/\[truncated at line \d+/);
  });
});

describe('EditGate', () => {
  let host: TestHost;
  let gate: EditGate;
  beforeEach(async () => {
    host?.cleanup();
    host = createTestHost();
    await seed(host, { 'app.py': APP_PY });
    gate = createEditGate(host);
  });
  afterAll(() => host?.cleanup());

  it('denies edits to missing files, unmatched text and no-op changes without opening a review', async () => {
    expect(await gate.reviewToolCall(call('edit_file', { path: 'nope.py', edits: EDITS }), 'r1', 's1')).toEqual({
      status: 'deny',
      reason: 'nope.py does not exist, use write_file to create it.',
    });
    const miss = await gate.reviewToolCall(call('edit_file', { path: 'app.py', edits: [EDITS[0], { old_text: 'missing()', new_text: 'x' }] }), 'r1', 's1');
    expect(miss).toMatchObject({ status: 'deny', reason: expect.stringContaining('edit 2: old_text not found in app.py') });
    const same = await gate.reviewToolCall(call('edit_file', { path: 'app.py', edits: [{ old_text: 'return a + b', new_text: 'return a + b' }] }), 'r1', 's1');
    expect(same).toMatchObject({ status: 'deny', reason: expect.stringMatching(/^No changes/) });
    expect(host.reviews).toHaveLength(0);
  });

  it('accepting hunk 1 of 2 allows the call and applies only that hunk', async () => {
    host.setPolicy(acceptOnly([0]));
    const args = { path: 'app.py', edits: EDITS, description: 'greeting + ints' };
    expect(await gate.reviewToolCall(call('edit_file', args), 'run-1', 'sess-1')).toEqual({ status: 'allow' });
    expect(host.reviews[0]).toMatchObject({ relPath: 'app.py', source: 'agent', runId: 'run-1', isNewFile: false, title: 'greeting + ints', originalText: APP_PY });
    const msg = await gate.applyReviewed('edit_file', args, 'sess-1');
    expect(msg).toBe(
      "Applied hunk 1 of 2 to app.py. The user rejected hunk 2 (line 21: 'return a + b'); do not re-propose it unless asked. File now has 21 lines.",
    );
    const after = await host.read('app.py');
    expect(after).toContain('GREETING = "hello, world"');
    expect(after).toContain('    return a + b');
    expect(host.emitted.at(-1)).toMatchObject({
      sid: 'sess-1',
      event: { type: 'change.applied', runId: 'run-1', change: { relPath: 'app.py', hunksApplied: 1, hunksTotal: 2, linesAdded: 1, linesRemoved: 1 } },
    });
    expect((host.context as unknown as { refreshed: string[] }).refreshed).toEqual(['app.py']);
    // Consumed: a second call with the same args is not reviewed any more.
    expect(await gate.applyReviewed('edit_file', args, 'sess-1')).toBe('Not applied: this edit was not reviewed by the user.');
  });

  it('never writes unreviewed edits', async () => {
    expect(await gate.applyReviewed('edit_file', { path: 'app.py', edits: EDITS }, 'sess-1')).toBe('Not applied: this edit was not reviewed by the user.');
    expect(await gate.applyReviewed('write_file', { path: 'new.py', content: 'x = 1\n' }, undefined)).toMatch(/^Not applied/);
    expect(await host.read('app.py')).toBe(APP_PY);
    expect(await host.read('new.py')).toBeNull();
  });

  it('normalizes equivalent paths but never applies different proposal contents', async () => {
    const args = { path: 'app.py', edits: EDITS };
    const other = { path: 'app.py', edits: [{ old_text: 'return a + b', new_text: 'return b + a' }] };
    expect((await gate.reviewToolCall(call('edit_file', args), 'run-1', 'sess-1')).status).toBe('allow');
    expect((await gate.reviewToolCall(call('edit_file', other), 'run-2', 'sess-1')).status).toBe('allow');
    expect(await gate.applyReviewed('edit_file', { ...args, edits: [{ old_text: 'return a + b', new_text: 'return 999' }] }, 'sess-1')).toMatch(/^Not applied/);
    expect(await gate.applyReviewed('edit_file', args, undefined)).toMatch(/^Not applied/);
    expect(await host.read('app.py')).toBe(APP_PY);
    gate.forgetRun('run-2');
    expect(await gate.applyReviewed('edit_file', args, 'other-session')).toMatch(/^Not applied/);
    const msg = await gate.applyReviewed('edit_file', { path: './app.py', edits: EDITS, extra: true }, 'sess-1');
    expect(msg).toBe('Applied all 2 hunks to app.py. File now has 21 lines.');
  });

  it('invalidates a review that resolves after the run ends', async () => {
    let decide!: () => void;
    const pending = new Promise<void>(resolve => { decide = resolve; });
    host.setPolicy(async (change, n) => { await pending; return acceptAll(change, n); });
    const args = { path: 'app.py', edits: EDITS };
    const reviewed = gate.reviewToolCall(call('edit_file', args), 'late-run', 's');
    await vi.waitFor(() => expect(host.reviews).toHaveLength(1));
    gate.forgetRun('late-run');
    decide();
    expect((await reviewed).status).toBe('deny');
    expect(await gate.applyReviewed('edit_file', args, 's')).toMatch(/^Not applied/);
    expect(await host.read('app.py')).toBe(APP_PY);
  });

  it('passes cancellation into application and blocks an already-aborted MCP call', async () => {
    const args = { path: 'app.py', edits: EDITS };
    await gate.reviewToolCall(call('edit_file', args), 'cancelled-apply', 's');
    const controller = new AbortController();
    controller.abort();
    expect(await gate.applyReviewed('edit_file', args, 's', controller.signal)).toMatch(/cancelled/);
    expect(host.applied).toHaveLength(0);

    await gate.reviewToolCall(call('edit_file', args), 'in-flight', 's');
    let applySignal: AbortSignal | undefined;
    let release!: () => void;
    const opened = new Promise<void>(resolve => { release = resolve; });
    host.review.apply = async (_change, _outcome, signal) => { applySignal = signal; await opened; return null; };
    const applying = gate.applyReviewed('edit_file', args, 's');
    gate.forgetRun('in-flight');
    expect(applySignal?.aborted).toBe(true);
    release();
    await applying;
  });

  it('rejecting all hunks, cancelling the review, or forgetting the run never writes', async () => {
    host.setPolicy(rejectAll);
    expect(await gate.reviewToolCall(call('edit_file', { path: 'app.py', edits: EDITS }), 'r', 's')).toEqual({
      status: 'deny',
      reason: 'User rejected all 2 hunks of the change to app.py. Do not propose the same change again; ask or try a different approach.',
    });
    host.setPolicy(() => ({ status: 'cancelled', decisions: [], accepted: [], rejected: [] }) as Omit<ReviewOutcome, 'changeId'>);
    expect(await gate.reviewToolCall(call('edit_file', { path: 'app.py', edits: EDITS }), 'r', 's')).toEqual({ status: 'deny', reason: 'review cancelled' });
    host.setPolicy(acceptAll);
    const args = { path: 'app.py', edits: EDITS };
    expect((await gate.reviewToolCall(call('edit_file', args), 'run-x', 's')).status).toBe('allow');
    gate.forgetRun('run-x');
    expect(await gate.applyReviewed('edit_file', args, 's')).toMatch(/^Not applied/);
    expect(await host.read('app.py')).toBe(APP_PY);
  });

  it('refuses to apply when the file changed after the review', async () => {
    const args = { path: 'app.py', edits: EDITS };
    expect((await gate.reviewToolCall(call('edit_file', args), 'r', 's')).status).toBe('allow');
    await host.write('app.py', APP_PY + '# edited by the user\n');
    const msg = await gate.applyReviewed('edit_file', args, 's');
    expect(msg).toMatch(/^Not applied: app\.py changed since the proposal was made/);
    expect(await host.read('app.py')).toBe(APP_PY + '# edited by the user\n');
  });

  it('write_file creates new files after review', async () => {
    const args = { path: 'pkg/new_mod.py', content: 'def hello():\n    return 1\n' };
    expect(await gate.reviewToolCall(call('write_file', args), 'r', 's')).toEqual({ status: 'allow' });
    expect(host.reviews[0]).toMatchObject({ isNewFile: true, originalText: '', relPath: 'pkg/new_mod.py' });
    expect(await gate.applyReviewed('write_file', args, 's')).toBe('Created pkg/new_mod.py (2 lines).');
    expect(await host.read('pkg/new_mod.py')).toBe(args.content);
  });
});

describe('editor MCP server', () => {
  let host: TestHost;
  let gate: EditGate;
  let srv: EditorMcpServerHandle;
  let client: Client;

  async function connect(headers: Record<string, string>): Promise<Client> {
    const c = new Client({ name: 'anvil-test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers } }));
    return c;
  }
  const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

  beforeAll(async () => {
    host = createTestHost();
    await seed(host, { 'app.py': APP_PY });
    host.setTrueForge({ runForSession: (sid?: string) => (sid === 'sess-1' ? { runId: 'run-1', kind: 'agent' } : undefined) } as unknown as TrueForgeService);
    gate = createEditGate(host);
    srv = await startEditorMcpServer(host, gate, { port: 0, token: TOKEN, log });
    client = await connect({ 'x-anvil-token': TOKEN, 'x-tfg-session-id': 'sess-1' });
  });
  afterAll(async () => {
    await client?.close();
    await srv?.dispose();
    host?.cleanup();
  });

  it('rejects requests without the token and unknown MCP sessions', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(srv.url, { method: 'POST', headers, body })).status).toBe(401);
    expect((await fetch(srv.url, { method: 'POST', headers: { ...headers, 'x-anvil-token': 'wrong' }, body })).status).toBe(401);
    const unknown = await fetch(srv.url, {
      method: 'POST',
      headers: { ...headers, 'x-anvil-token': TOKEN, 'mcp-session-id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('lists the ten tools with read-only / destructive annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      ['edit_file', 'find_symbol', 'get_diagnostics', 'list_files', 'read_file', 'repo_map', 'retrieve_context', 'run_command', 'search_code', 'write_file'],
    );
    for (const n of ['retrieve_context', 'repo_map', 'search_code', 'find_symbol', 'read_file', 'list_files', 'get_diagnostics']) {
      expect(byName[n].annotations?.readOnlyHint).toBe(true);
    }
    for (const n of ['edit_file', 'write_file', 'run_command']) expect(byName[n].annotations?.destructiveHint).toBe(true);
    expect(byName.edit_file.description).toMatch(/hunk by hunk/);
  });

  it('retrieve_context clamps the budget and emits context.selected into the run of x-tfg-session-id', async () => {
    const r = await client.callTool({ name: 'retrieve_context', arguments: { query: 'greeting', budget_tokens: 99_999 } });
    expect(textOf(r)).toBe('RETRIEVED(greeting; budget 4000): app.py');
    const ev = host.emitted.find((e) => e.event.type === 'context.selected');
    expect(ev?.sid).toBe('sess-1');
    expect(ev?.event).toMatchObject({ type: 'context.selected', runId: 'run-1', result: { query: 'greeting', budgetTokens: 4000 } });
    host.contextBudgetTokens = () => 1800;
    expect(textOf(await client.callTool({ name: 'retrieve_context', arguments: { query: 'custom' } }))).toContain('budget 1800');
    expect(textOf(await client.callTool({ name: 'retrieve_context', arguments: { query: 'custom', budget_tokens: 5000 } }))).toContain('budget 1800');
    expect(textOf(await client.callTool({ name: 'retrieve_context', arguments: { query: 'custom', budget_tokens: 800 } }))).toContain('budget 800');
    host.contextBudgetTokens = () => 4000;
  });

  it('read_file / search_code / find_symbol / list_files / get_diagnostics / repo_map', async () => {
    expect(textOf(await client.callTool({ name: 'read_file', arguments: { path: 'app.py', start_line: 20, end_line: 21 } }))).toBe(
      'app.py (lines 20-21 of 21)\n  20| def add(a, b):\n  21|     return a + b',
    );
    const missing = await client.callTool({ name: 'read_file', arguments: { path: 'nope.py' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/File not found: nope\.py/);
    const escape = await client.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } });
    expect(escape.isError).toBe(true);
    expect(textOf(await client.callTool({ name: 'search_code', arguments: { query: 'GREETING' } }))).toBe('app.py:1: GREETING = "hello"');
    expect(textOf(await client.callTool({ name: 'find_symbol', arguments: { name: 'add' } }))).toBe('function add — app.py:20-21 — def add(a, b):');
    expect(textOf(await client.callTool({ name: 'list_files', arguments: {} }))).toBe('app.py');
    expect(textOf(await client.callTool({ name: 'get_diagnostics', arguments: { path: 'app.py' } }))).toBe('app.py: no problems');
    expect(textOf(await client.callTool({ name: 'repo_map', arguments: { focus: 'app.py' } }))).toContain('add(a, b)');
  });

  it('edit_file through MCP applies only reviewed hunks; unreviewed calls are refused', async () => {
    const refused = await client.callTool({ name: 'edit_file', arguments: { path: 'app.py', edits: EDITS } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('Not applied: this edit was not reviewed by the user.');
    host.setPolicy(acceptOnly([1]));
    expect(await gate.reviewToolCall(call('edit_file', { path: 'app.py', edits: EDITS }), 'run-1', 'sess-1')).toEqual({ status: 'allow' });
    const res = await client.callTool({ name: 'edit_file', arguments: { path: 'app.py', edits: EDITS } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^Applied hunk 2 of 2 to app\.py\. The user rejected hunk 1 \(line 1: 'GREETING = "hello"'\)/);
    expect(await host.read('app.py')).toContain('return int(a) + int(b)');
    await seed(host, { 'app.py': APP_PY });
  });

  it('matches canonical array and JSON-string edits even with a second approval for the same file', async () => {
    const args = { path: 'app.py', edits: EDITS, description: '17' };
    host.setPolicy(acceptAll);
    const extra = EDITS.map((e) => ({ ...e, line: 1 }));
    expect((await gate.reviewToolCall(call('edit_file', { ...args, edits: extra, description: 17 }), 'run-1', 'sess-1')).status).toBe('allow');
    expect((await gate.reviewToolCall(call('edit_file', { path: 'app.py', edits: EDITS.slice(0, 1) }), 'run-2', 'sess-1')).status).toBe('allow');
    const result = await client.callTool({ name: 'edit_file', arguments: { ...args, edits: JSON.stringify(EDITS) } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/^Applied all 2 hunks/);
    gate.forgetRun('run-2');
    await seed(host, { 'app.py': APP_PY });
  });

  it('run_command runs bash in the workspace and reports exit code + output tail', async () => {
    const r = await client.callTool({ name: 'run_command', arguments: { command: 'echo hi from $ANVIL_TEST; pwd; exit 3' } });
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toMatch(/^exit code 3 \(\d+\.\ds\)/);
    expect(t).toContain('hi from 1');
    expect(t).toContain(path.basename(host.root));
    const bad = await client.callTool({ name: 'run_command', arguments: { command: 'pwd', cwd: '../..' } });
    expect(bad.isError).toBe(true);
  });

  it('run_command is killed (whole process group) when TrueForge cancels the MCP request', async () => {
    const pidFile = path.join(host.root, 'child.pid');
    const ac = new AbortController();
    const pending = client.callTool(
      { name: 'run_command', arguments: { command: `sleep 60 & echo $! > ${pidFile}; wait` } },
      undefined,
      { signal: ac.signal, timeout: 120_000 },
    );
    const end = Date.now() + 10_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
      if (Date.now() > end) throw new Error('command did not start');
      await new Promise((r) => setTimeout(r, 50));
    }
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
    ac.abort();
    await expect(pending).rejects.toThrow();
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 20_000);

  it('tries the next ports when the requested one is busy', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as { port: number }).port;
    const other = await startEditorMcpServer(host, gate, { port: busy, token: TOKEN, log });
    try {
      expect(other.port).toBeGreaterThan(busy);
      expect(other.port).toBeLessThanOrEqual(busy + 10);
      expect(other.url).toBe(`http://127.0.0.1:${other.port}/mcp`);
    } finally {
      await other.dispose();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe('runShellCommand', () => {
  it('times out and kills the process group', async () => {
    const r = await runShellCommand('sleep 30', { cwd: process.cwd(), env: process.env, timeoutSeconds: 1 });
    expect(r.timedOut).toBe(true);
    expect(formatCommandResult(r)).toMatch(/timed out, process group killed/);
  }, 10_000);

  it('keeps only the last 8,000 characters of output', async () => {
    const r = await runShellCommand(`python3 -c "print('a'*20000 + 'END')"`, { cwd: process.cwd(), env: process.env, timeoutSeconds: 20 });
    const t = formatCommandResult(r);
    expect(t).toMatch(/^exit code 0/);
    expect(t).toContain('earlier chars omitted');
    expect(t.endsWith('END')).toBe(true);
    expect(t.length).toBeLessThan(8200);
  }, 20_000);
});
