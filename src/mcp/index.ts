/**
 * Anvil's editor MCP server. TrueForge connects to it over Streamable HTTP (stateful,
 * so `notifications/cancelled` reaches the running handler as `extra.signal`), and the
 * agent decides what to read and change through these tools.
 *
 * Pure Node: the editor is reached only through the injected EditorToolHost.
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { EditGate, EditorToolHost } from '../shared/contracts';
import { MCP_SERVER_NAME, TOOL_NAMES } from '../shared/contracts';
import type { Logger } from '../shared/log';
import { formatRetrieval } from '../context';
import { formatCommandResult, runShellCommand } from './runCommand';

export { createEditGate, applyTextEdits, stableStringify } from './editGate';

export const TOKEN_HEADER = 'x-anvil-token';
export const SESSION_HEADER = 'x-tfg-session-id';

const READ_MAX_LINES = 400;
const READ_MAX_CHARS = 20_000;
const SEARCH_MAX = 60;
const MAX_BUDGET = 5500;

export interface EditorMcpServerHandle {
  url: string;
  port: number;
  dispose(): Promise<void>;
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): ToolText {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolText {
  return { content: [{ type: 'text', text }], isError: true };
}

function headerOf(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  const v = headers?.[name];
  return Array.isArray(v) ? v[0] : v || undefined;
}

/** Splits text into lines; a trailing newline does not create an extra line. */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function formatFileSlice(rel: string, text: string, start?: number, end?: number): { text: string; isError: boolean } {
  const lines = toLines(text);
  const total = lines.length;
  if (total === 0) return { text: `${rel} (empty file)`, isError: false };
  const a = Math.max(1, Math.floor(start ?? 1));
  if (a > total) return { text: `start_line ${a} is past the end of ${rel} (${total} lines).`, isError: true };
  let b = Math.min(total, Math.floor(end ?? total));
  if (b < a) return { text: `end_line ${b} is before start_line ${a}.`, isError: true };
  let truncated = false;
  if (b - a + 1 > READ_MAX_LINES) {
    b = a + READ_MAX_LINES - 1;
    truncated = true;
  }
  const width = Math.max(4, String(b).length);
  const out: string[] = [];
  let chars = 0;
  let last = a - 1;
  for (let n = a; n <= b; n++) {
    const line = `${String(n).padStart(width)}| ${lines[n - 1]}`;
    if (chars + line.length + 1 > READ_MAX_CHARS && out.length > 0) {
      truncated = true;
      break;
    }
    out.push(line);
    chars += line.length + 1;
    last = n;
  }
  let body = `${rel} (lines ${a}-${last} of ${total})\n${out.join('\n')}`;
  if (truncated || last < (end ?? total) && last < total) {
    body += `\n[truncated at line ${last} (limit ${READ_MAX_LINES} lines / ${READ_MAX_CHARS.toLocaleString('en-US')} chars); call read_file with start_line=${last + 1} to continue]`;
  }
  return { text: body, isError: false };
}

function registerTools(server: McpServer, host: EditorToolHost, gate: EditGate, log: Logger): void {
  const sessionOf = (extra: { requestInfo?: { headers?: Record<string, string | string[] | undefined> } }) =>
    headerOf(extra.requestInfo?.headers, SESSION_HEADER);

  const guard = async (name: string, fn: () => Promise<ToolText>): Promise<ToolText> => {
    try {
      return await fn();
    } catch (err) {
      log.warn(`tool ${name} failed: ${(err as Error)?.message ?? err}`);
      return fail(`${name} failed: ${(err as Error)?.message ?? String(err)}`);
    }
  };

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    TOOL_NAMES.retrieveContext,
    {
      title: 'Retrieve context',
      description:
        'Find the code relevant to a task. Ranks the workspace (identifiers, symbols, imports, test/doc pairing) and returns the best files ' +
        'with line-numbered excerpts inside a token budget, plus why each file was chosen and what was left out. Call this FIRST with the ' +
        "user's request (or a focused sub-question) before searching or reading files.",
      inputSchema: {
        query: z.string().min(1).describe('The task or question in natural language, e.g. the user request verbatim.'),
        budget_tokens: z.number().int().positive().optional().describe('Token budget for the excerpts (default 4000, max 5500).'),
      },
      annotations: readOnly,
    },
    async ({ query, budget_tokens }, extra) =>
      guard(TOOL_NAMES.retrieveContext, async () => {
        const sid = sessionOf(extra);
        const budgetTokens = Math.max(500, Math.min(budget_tokens ?? 4000, MAX_BUDGET));
        const result = host.context.retrieve(query, { budgetTokens });
        const run = host.trueforge.runForSession(sid);
        host.emit(sid, { type: 'context.selected', runId: run?.runId ?? '', result });
        return ok(formatRetrieval(result));
      }),
  );

  server.registerTool(
    TOOL_NAMES.repoMap,
    {
      title: 'Repository map',
      description:
        'Compact ranked outline of the repository: file paths with their top-level classes/functions. Optionally focused on a path or topic. ' +
        'Use it to orient yourself in an unfamiliar codebase.',
      inputSchema: {
        focus: z.string().optional().describe('Optional path (e.g. "src/flask") or topic (e.g. "cli commands") to rank first.'),
        budget_tokens: z.number().int().positive().optional().describe('Token budget (default 1200, max 5500).'),
      },
      annotations: readOnly,
    },
    async ({ focus, budget_tokens }) =>
      guard(TOOL_NAMES.repoMap, async () => {
        const budgetTokens = Math.max(200, Math.min(budget_tokens ?? 1200, MAX_BUDGET));
        let focusPaths: string[] | undefined;
        if (focus && /[/.]/.test(focus)) {
          try {
            focusPaths = [host.resolvePath(focus)];
          } catch {
            focusPaths = undefined;
          }
        }
        const map = host.context.repoMap({ budgetTokens, focusPaths, query: focus || undefined });
        return ok(map || '(no indexed files)');
      }),
  );

  server.registerTool(
    TOOL_NAMES.searchCode,
    {
      title: 'Search code',
      description:
        'Search the workspace text (literal by default, or a JavaScript regex). Returns up to 60 matches as "path:line: text". ' +
        'Use it to confirm where an identifier, string or pattern is used.',
      inputSchema: {
        query: z.string().min(1).describe('Literal text, or a regex when regex=true.'),
        regex: z.boolean().optional().describe('Treat query as a regular expression.'),
        glob: z.string().optional().describe('Limit to paths matching this glob, e.g. "tests/**/*.py".'),
        max_results: z.number().int().positive().optional().describe('Maximum matches (default 40, max 60).'),
      },
      annotations: readOnly,
    },
    async ({ query, regex, glob, max_results }) =>
      guard(TOOL_NAMES.searchCode, async () => {
        const maxResults = Math.min(max_results ?? 40, SEARCH_MAX);
        if (regex) {
          try {
            new RegExp(query);
          } catch (err) {
            return fail(`Invalid regex: ${(err as Error).message}`);
          }
        }
        const matches = host.context.searchText(query, { regex: !!regex, glob: glob || undefined, maxResults });
        if (!matches.length) return ok(`No matches for ${JSON.stringify(query)}${glob ? ` in ${glob}` : ''}.`);
        const lines = matches.slice(0, maxResults).map((m) => {
          const t = m.text.trim();
          return `${m.path}:${m.line}: ${t.length > 200 ? t.slice(0, 197) + '…' : t}`;
        });
        if (matches.length >= maxResults) lines.push(`[showing the first ${maxResults} matches; narrow the query or add a glob]`);
        return ok(lines.join('\n'));
      }),
  );

  server.registerTool(
    TOOL_NAMES.findSymbol,
    {
      title: 'Find symbol',
      description:
        'Look up where a function, class, method or variable is defined. Returns "kind qualifiedName — path:start-end — signature" per match. ' +
        'Accepts bare names ("get_debug_flag") or qualified ones ("FlaskGroup.__init__").',
      inputSchema: { name: z.string().min(1).describe('Symbol name to look up.') },
      annotations: readOnly,
    },
    async ({ name }) =>
      guard(TOOL_NAMES.findSymbol, async () => {
        const defs = host.context.findSymbol(name, 20);
        if (!defs.length) return ok(`No symbol named ${JSON.stringify(name)} is indexed. Try search_code.`);
        return ok(defs.map((d) => `${d.kind} ${d.qualifiedName} — ${d.path}:${d.startLine}-${d.endLine} — ${d.signature}`).join('\n'));
      }),
  );

  server.registerTool(
    TOOL_NAMES.readFile,
    {
      title: 'Read file',
      description:
        'Read a workspace file with line numbers ("  42| code"), including unsaved editor changes. Always pass start_line/end_line around ' +
        'what you need; output is capped at 400 lines / 20,000 chars. When editing, copy old_text WITHOUT the "  42| " prefix.',
      inputSchema: {
        path: z.string().min(1).describe('Path relative to the workspace root.'),
        start_line: z.number().int().positive().optional().describe('First line (1-based, default 1).'),
        end_line: z.number().int().positive().optional().describe('Last line (inclusive).'),
      },
      annotations: readOnly,
    },
    async ({ path: p, start_line, end_line }) =>
      guard(TOOL_NAMES.readFile, async () => {
        const rel = host.resolvePath(p);
        const text = await host.readText(rel);
        if (text === null) return fail(`File not found: ${rel}. Use list_files or search_code to find the right path.`);
        const r = formatFileSlice(rel, text, start_line, end_line);
        return r.isError ? fail(r.text) : ok(r.text);
      }),
  );

  server.registerTool(
    TOOL_NAMES.listFiles,
    {
      title: 'List files',
      description: 'List indexed workspace files, optionally filtered by a glob ("src/**/*.py") or a substring ("cli").',
      inputSchema: { pattern: z.string().optional().describe('Glob or substring filter.') },
      annotations: readOnly,
    },
    async ({ pattern }) =>
      guard(TOOL_NAMES.listFiles, async () => {
        const limit = 300;
        const files = host.context.listFiles(pattern || undefined, limit + 1);
        if (!files.length) return ok(pattern ? `No files match ${JSON.stringify(pattern)}.` : 'No files are indexed.');
        const shown = files.slice(0, limit);
        return ok(shown.join('\n') + (files.length > limit ? `\n[more than ${limit} files; use a narrower pattern]` : ''));
      }),
  );

  server.registerTool(
    TOOL_NAMES.getDiagnostics,
    {
      title: 'Get diagnostics',
      description: 'Errors and warnings reported by the editor (language servers, linters) for one file or the whole workspace.',
      inputSchema: { path: z.string().optional().describe('File to check; omit for the whole workspace.') },
      annotations: readOnly,
    },
    async ({ path: p }) =>
      guard(TOOL_NAMES.getDiagnostics, async () => {
        const rel = p ? host.resolvePath(p) : undefined;
        const text = host.diagnostics(rel);
        return ok(text && text.trim() ? text : `No diagnostics${rel ? ` for ${rel}` : ''}.`);
      }),
  );

  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

  const applyEdit = (name: string) => async (args: Record<string, unknown>, extra: { signal: AbortSignal; requestInfo?: { headers?: Record<string, string | string[] | undefined> } }) =>
    guard(name, async () => {
      if (extra.signal.aborted) return fail('Not applied: the request was cancelled.');
      const text = await gate.applyReviewed(name, args, sessionOf(extra));
      return text.startsWith('Not applied') ? fail(text) : ok(text);
    });

  server.registerTool(
    TOOL_NAMES.editFile,
    {
      title: 'Edit file',
      description:
        'Change an existing file by exact text replacement. Each edit\'s old_text must match the current file exactly once (copy it from ' +
        'read_file without the line-number prefix; keep it short but unique). Put all edits for one file in one call. The user reviews ' +
        'the change hunk by hunk; only accepted hunks are applied and the result says which ones.',
      inputSchema: {
        path: z.string().min(1).describe('File path relative to the workspace root.'),
        edits: z
          .array(z.object({ old_text: z.string().describe('Exact existing text to replace.'), new_text: z.string().describe('Replacement text.') }))
          .min(1)
          .describe('Replacements applied in order.'),
        description: z.string().optional().describe('One-line summary shown to the user in the review.'),
      },
      annotations: destructive,
    },
    applyEdit(TOOL_NAMES.editFile),
  );

  server.registerTool(
    TOOL_NAMES.writeFile,
    {
      title: 'Write file',
      description:
        'Create a new file with the given content (or fully replace a small file). Prefer edit_file for existing files. The user reviews it before it is written.',
      inputSchema: {
        path: z.string().min(1).describe('File path relative to the workspace root.'),
        content: z.string().describe('Complete file content.'),
        description: z.string().optional().describe('One-line summary shown to the user in the review.'),
      },
      annotations: destructive,
    },
    applyEdit(TOOL_NAMES.writeFile),
  );

  server.registerTool(
    TOOL_NAMES.runCommand,
    {
      title: 'Run command',
      description:
        'Run a shell command (bash) in the workspace, e.g. the relevant tests: "python -m pytest tests/test_cli.py -q". The user approves ' +
        'each command. Returns the exit code, duration and the last 8,000 characters of combined stdout/stderr. Avoid interactive or long-running servers.',
      inputSchema: {
        command: z.string().min(1).describe('Shell command line.'),
        cwd: z.string().optional().describe('Working directory relative to the workspace root (default: the root).'),
        timeout_seconds: z.number().int().positive().optional().describe('Kill the command after this many seconds.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ command, cwd, timeout_seconds }, extra) =>
      guard(TOOL_NAMES.runCommand, async () => {
        const rel = cwd ? host.resolvePath(cwd) : '';
        const dir = path.resolve(host.workspaceRoot, rel);
        const root = path.resolve(host.workspaceRoot);
        if (dir !== root && !dir.startsWith(root + path.sep)) return fail(`cwd must stay inside the workspace (${cwd}).`);
        const timeoutSeconds = Math.max(1, Math.min(timeout_seconds ?? host.commandTimeoutSeconds(), 3600));
        log.info(`run_command in ${rel || '.'}: ${command}`);
        const res = await runShellCommand(command, { cwd: dir, env: host.commandEnv(), timeoutSeconds, signal: extra.signal });
        const text = formatCommandResult(res);
        return res.exitCode === 0 ? ok(text) : { ...ok(text), isError: res.aborted || res.timedOut ? true : undefined };
      }),
  );
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export async function startEditorMcpServer(
  host: EditorToolHost,
  gate: EditGate,
  opts: { port: number; token: string; log: Logger },
): Promise<EditorMcpServerHandle> {
  const { log, token } = opts;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<McpServer>();
  const sockets = new Set<Socket>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') return sendJson(res, 404, { error: 'not found' });
      const presented = headerOf(req.headers, TOKEN_HEADER);
      if (!presented || !safeEqual(presented, token)) {
        log.warn(`rejected MCP request without a valid ${TOKEN_HEADER}`);
        return sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: `Unauthorized: missing or invalid ${TOKEN_HEADER}` }, id: null });
      }

      const mcpSid = headerOf(req.headers, 'mcp-session-id');
      let transport = mcpSid ? transports.get(mcpSid) : undefined;
      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = await readBody(req);
        } catch {
          return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
        }
      }

      if (!transport) {
        if (mcpSid) {
          // Unknown session (e.g. the extension restarted): 404 tells the client to re-initialize.
          return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        }
        const isInit = req.method === 'POST' && (Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body));
        if (!isInit) {
          return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session id' }, id: null });
        }
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, t);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });
        const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } });
        registerTools(mcp, host, gate, log);
        servers.add(mcp);
        t.onclose = () => {
          if (t.sessionId) transports.delete(t.sessionId);
          servers.delete(mcp);
        };
        await mcp.connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error(`MCP request failed: ${(err as Error)?.message ?? err}`);
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  let bound = 0;
  let lastErr: unknown;
  for (let p = opts.port; p <= opts.port + 10; p++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, '127.0.0.1');
      });
      bound = (server.address() as AddressInfo).port;
      break;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || opts.port === 0) throw err;
      log.warn(`port ${p} is busy; trying ${p + 1}`);
    }
  }
  if (!bound) throw new Error(`No free port for the MCP server in ${opts.port}-${opts.port + 10}: ${(lastErr as Error)?.message}`);

  const url = `http://127.0.0.1:${bound}/mcp`;
  log.info(`editor MCP server listening on ${url}`);

  return {
    url,
    port: bound,
    async dispose() {
      for (const t of transports.values()) await t.close().catch(() => undefined);
      transports.clear();
      for (const s of servers) await s.close().catch(() => undefined);
      servers.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
    },
  };
}
