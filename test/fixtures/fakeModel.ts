/**
 * Deterministic fake OpenAI-compatible model server for TrueForge integration tests.
 *
 * Register it in TrueForge as a `custom` provider with base_url `http://127.0.0.1:<port>/v1`.
 * The behaviour is chosen by the request's `model` field (the provider's model_id):
 *
 *  - `script`       retrieve_context -> edit_file (2 far-apart edits) -> final text
 *  - `unauthorized` HTTP 401 (invalid API key), like a provider with a bad key
 *  - `scout`        create_sub_agent (sub-agent calls retrieve_context) -> edit_file -> final text
 *  - `slow`         streams text slowly (for cancellation tests)
 *  - `cmd`          run_command that sleeps 60 s (for cancellation of in-flight MCP calls)
 *  - `echo`         replies "echo: <last user message>" (fallback target)
 *
 * Only erasable TypeScript syntax is used so `node test/fixtures/fakeModel.ts` also works.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeModelRequest {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }>; tool_call_id?: string }>;
  tools: string[];
  at: number;
}

export interface FakeModelOptions {
  /** File edited by the `script` mode. */
  editPath?: string;
  /** Two [old,new] pairs applied by the `script` mode's edit_file call. */
  edits?: Array<{ old_text: string; new_text: string }>;
  /** Delay between streamed chunks in `slow` mode (ms). */
  slowChunkMs?: number;
  log?: (line: string) => void;
}

export interface FakeModelServer {
  url: string;
  port: number;
  requests: FakeModelRequest[];
  close(): Promise<void>;
}

const DEFAULT_EDITS = [
  { old_text: 'GREETING = "hello"', new_text: 'GREETING = "hello, world"' },
  { old_text: 'return a + b', new_text: 'return int(a) + int(b)' },
];

export async function startFakeModel(opts: FakeModelOptions = {}, port = 0): Promise<FakeModelServer> {
  const requests: FakeModelRequest[] = [];
  const editPath = opts.editPath ?? 'app.py';
  const edits = opts.edits ?? DEFAULT_EDITS;
  const slowMs = opts.slowChunkMs ?? 150;
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'script' }, { id: 'echo' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${req.url}` } }));
      return;
    }
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const tools: string[] = (body.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean);
    const entry: FakeModelRequest = { model: String(body.model), stream: !!body.stream, messages: body.messages ?? [], tools, at: Date.now() };
    requests.push(entry);
    opts.log?.(`[fake-model] ${entry.model} stream=${entry.stream} msgs=${entry.messages.length} tools=${tools.join(',')}`);

    if (entry.model === 'unauthorized') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: inval*****demo.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      return;
    }

    const plan = decide(entry, editPath, edits);
    if (entry.model === 'effect-fail' && entry.messages.some((m) => m.role === 'tool' && String(m.content).includes('Applied'))) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Model failed after the edit.' } }));
      return;
    }
    if (!entry.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion(entry.model, plan.text ?? 'ok')));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let closed = false;
    res.on('close', () => (closed = true));
    const send = (obj: unknown) => {
      if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: entry.model };
    const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

    if (entry.model === 'slow') {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      for (let i = 0; i < 400 && !closed; i++) {
        send({ ...base, choices: [{ index: 0, delta: { content: `word${i} ` }, finish_reason: null }] });
        await sleep(slowMs);
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
      if (!closed) res.end('data: [DONE]\n\n');
      return;
    }

    if (plan.toolCall) {
      const { name, args } = plan.toolCall;
      const argStr = JSON.stringify(args);
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: plan.text ?? null }, finish_reason: null }] });
      send({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }],
      });
      // Stream the arguments in a few pieces so argsChars grows on the client.
      const step = Math.max(8, Math.ceil(argStr.length / 4));
      for (let i = 0; i < argStr.length; i += step) {
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(i, i + step) } }] }, finish_reason: null }] });
        await sleep(5);
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
    } else {
      const text = plan.text ?? 'ok';
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Thinking about it. ' }, finish_reason: null }] });
      for (const piece of text.match(/.{1,16}/gs) ?? [text]) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        await sleep(3);
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
    }
    if (!closed) res.end('data: [DONE]\n\n');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}/v1`,
    port: actual,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

interface Plan {
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}

function lastUserText(req: FakeModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  }
  return '';
}

/** Calls an MCP tool directly when it is preloaded, else through the deferred `call_tool` meta-tool. */
function toolCall(req: FakeModelRequest, name: string, args: Record<string, unknown>): Plan['toolCall'] {
  if (req.tools.includes(name)) return { name, args };
  const direct = req.tools.find((t) => t.endsWith(name));
  if (direct) return { name: direct, args };
  return { name: 'call_tool', args: { mcp_server: 'anvil-editor', tool_name: name, input: args } };
}

function decide(req: FakeModelRequest, editPath: string, edits: Array<{ old_text: string; new_text: string }>): Plan {
  if (req.model === 'echo') return { text: `echo: ${lastUserText(req).slice(0, 200)}` };
  if (req.model === 'effect-fail') return { toolCall: toolCall(req, 'edit_file', { path: editPath, edits }) };
  if (req.model === 'cmd' || req.model === 'fail-cmd') {
    // Runs a long command (for cancellation tests); the pid lands in child.pid in the workspace.
    const ran = req.messages.some((m) => (m.tool_calls ?? []).some((tc) => tc.function.name.endsWith('run_command') || tc.function.arguments.includes('run_command')));
    if (!ran && req.tools.length) return { toolCall: toolCall(req, 'run_command', { command: req.model === 'fail-cmd' ? 'echo verification-failed; exit 7' : 'sleep 60 & echo $! > child.pid; wait', timeout_seconds: 120 }) };
    return { text: 'command finished' };
  }
  if (req.model !== 'script' && req.model !== 'scout' && req.model !== 'multi') return { text: `model ${req.model} says hi` };
  // Requests without tools (e.g. session title generation) just get text.
  if (!req.tools.length) return { text: 'Anvil test session' };

  // Which tools have already been called in this turn (after the last user message)?
  let lastUser = -1;
  req.messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  const called: string[] = [];
  let lastToolContent = '';
  for (const m of req.messages.slice(lastUser + 1)) {
    for (const tc of m.tool_calls ?? []) {
      let n = tc.function.name;
      if (n === 'call_tool') {
        try {
          n = JSON.parse(tc.function.arguments).tool_name ?? n;
        } catch {
          /* keep */
        }
      }
      called.push(n);
    }
    if (m.role === 'tool') lastToolContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  }
  if (req.model === 'scout') {
    const isSubAgent = !req.tools.includes('create_sub_agent');
    if (isSubAgent) {
      if (!called.some((n) => n.endsWith('retrieve_context'))) {
        return { toolCall: toolCall(req, 'retrieve_context', { query: lastUserText(req).slice(0, 200) }) };
      }
      return { text: `${editPath}:1-21 - defines GREETING and add()\nRejected: README.md` };
    }
    if (!called.includes('create_sub_agent')) {
      return { text: 'Delegating the search.', toolCall: { name: 'create_sub_agent', args: { name: 'context-scout', input: `Find the code for: ${lastUserText(req).slice(0, 200)}` } } };
    }
  } else if (!called.some((n) => n.endsWith('retrieve_context'))) {
    return { text: 'Let me find the relevant code.', toolCall: toolCall(req, 'retrieve_context', { query: lastUserText(req).slice(0, 200), budget_tokens: 2000 }) };
  }
  if (req.model === 'multi') {
    const writes = called.filter(name => name.endsWith('edit_file') || name.endsWith('write_file')).length;
    if (writes === 0) return { toolCall: toolCall(req, 'edit_file', { path: editPath, edits: edits.slice(0, 1) }) };
    if (writes === 1) return { toolCall: toolCall(req, 'write_file', { path: 'tests/test_app.py', content: 'def test_greeting():\n    assert True\n' }) };
    if (writes === 2) return { toolCall: toolCall(req, 'write_file', { path: 'docs/usage.md', content: '# Greeting\n\nThe greeting says hello, world.\n' }) };
    if (!called.some(name => name.endsWith('run_command'))) return { toolCall: toolCall(req, 'run_command', { command: 'node -e "process.stdout.write(\'verified\')"' }) };
    return { text: 'Scripted three-file protocol test completed.' };
  }
  if (!called.some((n) => n.endsWith('edit_file'))) {
    return { toolCall: toolCall(req, 'edit_file', { path: editPath, edits, description: 'Greeting and int addition' }) };
  }
  return { text: `Finished. Tool said: ${lastToolContent.slice(0, 400)}` };
}

function completion(model: string, text: string) {
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Standalone: `node test/fixtures/fakeModel.ts [port]`
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] ?? 0);
  startFakeModel({ log: (l) => console.log(l) }, port).then((s) => console.log(`fake model listening on ${s.url}`));
}
