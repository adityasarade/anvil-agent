/**
 * Anvil activation: wires the context engine, the editor MCP server, the
 * TrueForge runtime, the per-hunk review service, inline edit and the agent panel.
 *
 *   VS Code (this extension)                         TrueForge (local, npx)
 *   ─────────────────────────                        ──────────────────────
 *   Agent panel / inline edit ── HTTP + SSE ───────▶ sessions, turns, agent loop,
 *        ▲   renders streamed events                  sub-agents, compaction, approvals
 *        │                                                    │
 *   per-hunk review ◀── tool approval (edit_file) ────────────┤
 *        │                                                    │ MCP (streamable HTTP)
 *   anvil-editor MCP server (127.0.0.1) ◀─────────────────────┘
 *     retrieve_context · search_code · find_symbol · read_file · edit_file · write_file · run_command …
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createContextEngine } from './context';
import { createTrueForgeService } from './trueforge';
import { createEditGate, startEditorMcpServer } from './mcp';
import { createReviewService } from './review';
import { registerInlineEdit } from './inline/inlineEdit';
import { AgentPanelProvider } from './panel/agentPanel';
import { buildAgentPrompt, formatK } from './host/prompt';
import { createLogger, setLogSink } from './shared/log';
import {
  EDIT_TOOLS,
  TOOL_NAMES,
  type AppliedChange,
  type AppliedChangeSummary,
  type ApprovalDecision,
  type ContextEngine,
  type EditorToolHost,
  type IndexStats,
  type Mention,
  type PanelHost,
  type PanelState,
  type RunHandle,
  type ToolCallInfo,
  type TrueForgeHealth,
  type UiEvent,
} from './shared/contracts';

const log = createLogger('anvil');

const EXCLUDED_DIRS = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|dist|build|\.tox|\.mypy_cache|\.pytest_cache|\.ruff_cache)(\/|$)/;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Anvil');
  ctx.subscriptions.push(channel);
  setLogSink((line) => channel.appendLine(line));

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    const msg = () => vscode.window.showWarningMessage('Anvil: open a folder to use the agent.');
    for (const id of ['anvil.inlineEdit', 'anvil.openPanel']) ctx.subscriptions.push(vscode.commands.registerCommand(id, msg));
    return;
  }
  const root = folder.uri.fsPath;
  const cfg = () => vscode.workspace.getConfiguration('anvil');

  /* ── Context engine ─────────────────────────────────────────────── */
  const context: ContextEngine = createContextEngine({ root });
  let indexStats: IndexStats | undefined;
  const indexing = context
    .build()
    .then((s) => {
      indexStats = s;
      log.info(`indexed ${s.files} files, ${s.chunks} chunks, ${s.symbols} symbols in ${s.buildMs} ms`);
      pushState();
    })
    .catch((e) => log.error('index build failed', e));
  const relOf = (uri: vscode.Uri) => path.relative(root, uri.fsPath).split(path.sep).join('/');
  const indexable = (uri: vscode.Uri) => uri.scheme === 'file' && uri.fsPath.startsWith(root) && !EXCLUDED_DIRS.test(relOf(uri));
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
  watcher.onDidCreate((u) => indexable(u) && context.refreshFile(relOf(u)).catch(() => {}));
  watcher.onDidChange((u) => indexable(u) && context.refreshFile(relOf(u)).catch(() => {}));
  watcher.onDidDelete((u) => indexable(u) && context.removeFile(relOf(u)));
  ctx.subscriptions.push(watcher);

  /* ── Review service (per-hunk diff review + undo journal) ───────── */
  const review = createReviewService(ctx, { workspaceRoot: root, log: createLogger('review') });

  /* ── Editor host shared by the MCP tools ────────────────────────── */
  const runs = new Map<string, { handle: RunHandle; kind: 'agent' | 'inline' }>();
  let panel: AgentPanelProvider | undefined;

  const resolvePath = (p: string): string => {
    const cleaned = p.trim().replace(/^["']|["']$/g, '');
    const abs = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.normalize(path.join(root, cleaned));
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path ${p} is outside the workspace`);
    return rel.split(path.sep).join('/');
  };

  const host: EditorToolHost = {
    workspaceRoot: root,
    context,
    review,
    get trueforge() {
      return trueforge;
    },
    emit(tfSessionId, e) {
      const bound = trueforge.runForSession(tfSessionId);
      if (!bound || bound.kind === 'agent') panel?.postEvent(e);
    },
    async readText(relPath) {
      const abs = path.join(root, relPath);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
      if (open) return open.getText();
      try {
        return await fs.promises.readFile(abs, 'utf8');
      } catch {
        return null;
      }
    },
    toUri: (relPath) => vscode.Uri.file(path.join(root, relPath)),
    resolvePath,
    diagnostics(relPath) {
      const entries = relPath
        ? [[vscode.Uri.file(path.join(root, relPath)), vscode.languages.getDiagnostics(vscode.Uri.file(path.join(root, relPath)))] as const]
        : vscode.languages.getDiagnostics();
      const lines: string[] = [];
      for (const [uri, diags] of entries) {
        for (const d of diags) {
          if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
          lines.push(`${relOf(uri)}:${d.range.start.line + 1}: ${vscode.DiagnosticSeverity[d.severity].toLowerCase()}: ${d.message}`);
        }
      }
      return lines.length ? lines.slice(0, 200).join('\n') : 'No errors or warnings.';
    },
    commandEnv() {
      const env = { ...process.env };
      for (const dir of ['.venv', 'venv']) {
        const bin = path.join(root, dir, process.platform === 'win32' ? 'Scripts' : 'bin');
        if (fs.existsSync(bin)) {
          env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
          env.VIRTUAL_ENV = path.join(root, dir);
          break;
        }
      }
      env.PYTHONDONTWRITEBYTECODE = '1';
      env.NO_COLOR = '1';
      return env;
    },
    commandTimeoutSeconds: () => cfg().get<number>('command.timeoutSeconds', 180),
  };

  /* ── MCP server + TrueForge runtime ─────────────────────────────── */
  const token = randomBytes(24).toString('hex');
  const gate = createEditGate(host);
  const mcp = await startEditorMcpServer(host, gate, { port: cfg().get<number>('mcp.port', 43117), token, log: createLogger('mcp') });
  ctx.subscriptions.push({ dispose: () => void mcp.dispose() });
  log.info(`editor MCP server listening on ${mcp.url}`);

  const trueforge = createTrueForgeService({
    agentsDir: path.join(ctx.extensionPath, 'agents'),
    settings: () => ({
      trueforgeUrl: cfg().get<string>('trueforgeUrl', 'http://127.0.0.1:8790'),
      models: cfg().get<string[]>('models', []),
      retryMaxAttempts: cfg().get<number>('retry.maxAttempts', 3),
      coderAgent: cfg().get<string>('agents.coder', 'anvil-coder'),
      inlineAgent: cfg().get<string>('agents.inline', 'anvil-inline'),
    }),
    mcp: () => ({ url: mcp.url, token }),
    log: createLogger('trueforge'),
  });

  /* ── Connection state ───────────────────────────────────────────── */
  let health: TrueForgeHealth = { ok: false, url: trueforge.baseUrl, error: 'connecting…' };
  let chain: string[] = [];
  let setupDone = false;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'anvil.selectModel';
  status.show();
  ctx.subscriptions.push(status);

  const refreshStatus = () => {
    if (!health.ok) {
      status.text = '$(debug-disconnect) Anvil: TrueForge offline';
      status.tooltip = `${health.url}\n${health.error ?? ''}\nRun: npm run trueforge`;
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      status.text = `$(flame) Anvil: ${chain[0]?.split('/').pop() ?? 'no model'}${chain.length > 1 ? ` +${chain.length - 1} fallback` : ''}`;
      status.tooltip = `TrueForge ${health.version ?? ''} at ${health.url}\nModel chain: ${chain.join(' → ') || 'none configured (npm run setup)'}\nClick to change`;
      status.backgroundColor = undefined;
    }
  };

  const connect = async (force = false): Promise<boolean> => {
    health = await trueforge.health().catch((e) => ({ ok: false, url: trueforge.baseUrl, error: String(e?.message ?? e) }));
    if (health.ok && (!setupDone || force)) {
      try {
        chain = await trueforge.modelChain();
        await trueforge.ensureSetup();
        setupDone = true;
        log.info(`connected to TrueForge ${health.version ?? ''}; model chain: ${chain.join(' → ')}`);
      } catch (e) {
        health = { ...health, error: String((e as Error)?.message ?? e) };
        log.error('TrueForge setup failed', e);
        vscode.window.showWarningMessage(`Anvil: ${health.error}`);
      }
    }
    if (!health.ok) setupDone = false;
    refreshStatus();
    pushState();
    return health.ok && setupDone;
  };
  void connect();
  const poll = setInterval(() => void (!setupDone ? connect() : trueforge.health().then((h) => { if (!h.ok) { health = h; setupDone = false; refreshStatus(); pushState(); } })), 10000);
  ctx.subscriptions.push({ dispose: () => clearInterval(poll) });

  /* ── Runs, cancellation, context key ────────────────────────────── */
  const setRunning = () => {
    void vscode.commands.executeCommand('setContext', 'anvil.running', runs.size > 0);
    pushState();
  };
  const trackRun = (handle: RunHandle): vscode.Disposable => {
    runs.set(handle.runId, { handle, kind: handle.kind });
    setRunning();
    const done = () => {
      if (!runs.has(handle.runId)) return;
      runs.delete(handle.runId);
      // A run that ended (done, error or cancelled) must not leave review editors or approval cards behind.
      review.cancelRun(handle.runId);
      gate.forgetRun(handle.runId);
      panel?.cancelApprovals(handle.runId);
      setRunning();
    };
    void handle.done.finally(done);
    return { dispose: done };
  };
  const cancelAll = async () => {
    const active = [...runs.values()];
    await Promise.all(
      active.map(async ({ handle }) => {
        review.cancelRun(handle.runId);
        gate.forgetRun(handle.runId);
        panel?.cancelApprovals(handle.runId);
        await handle.cancel();
      }),
    );
  };

  /* ── Agent panel ────────────────────────────────────────────────── */
  let sessionId: string | undefined;
  const sessionAllowedCommands = new Set<string>();

  const summarize = (c: AppliedChange): AppliedChangeSummary => {
    const before = (c.before ?? '').split(/\r?\n/);
    const after = c.after.split(/\r?\n/);
    const b = new Set(before);
    const a = new Set(after);
    return {
      id: c.id,
      runId: c.runId,
      relPath: c.relPath,
      hunksApplied: c.hunksApplied.length,
      hunksTotal: c.hunksTotal,
      linesAdded: after.filter((l) => !b.has(l)).length,
      linesRemoved: c.before === null ? 0 : before.filter((l) => !a.has(l)).length,
      undone: c.undone,
    };
  };

  function state(): PanelState {
    return {
      trueforge: health,
      models: chain,
      activeModel: chain[0],
      sessionId,
      sessionUrl: sessionId ? trueforge.sessionUrl(sessionId) : undefined,
      running: runs.size > 0,
      changes: review.journal.list().map(summarize),
      index: indexStats,
    };
  }
  function pushState() {
    panel?.postState(state());
  }
  ctx.subscriptions.push(review.journal.onDidChange(() => pushState()));

  const onApproval = async (call: ToolCallInfo, runId: string): Promise<ApprovalDecision> => {
    try {
      if (EDIT_TOOLS.includes(call.name)) {
        const sid = runs.get(runId)?.handle.sessionId ?? sessionId ?? '';
        return await gate.reviewToolCall(call, runId, sid);
      }
      if (call.name === TOOL_NAMES.runCommand) {
        const command = String(call.args.command ?? '');
        if (sessionAllowedCommands.has('*')) return { status: 'allow' };
        panel?.reveal();
        const answer = await panel!.requestApproval(call, runId);
        if (answer.decision === 'allow-session') sessionAllowedCommands.add('*');
        return answer.decision === 'deny'
          ? { status: 'deny', reason: answer.reason || `The user declined to run: ${command}` }
          : { status: 'allow' };
      }
      return { status: 'allow' };
    } catch (e) {
      log.error('approval handler failed', e);
      return { status: 'deny', reason: `Anvil could not review this call: ${(e as Error)?.message ?? e}` };
    }
  };

  const panelHost: PanelHost = {
    send(text: string, mentions: Mention[]) {
      void (async () => {
        if (runs.size > 0) {
          vscode.window.showInformationMessage('Anvil: a run is already in progress. Stop it first (Esc).');
          return;
        }
        if (!(await connect())) {
          vscode.window.showErrorMessage(`Anvil: TrueForge is not reachable at ${trueforge.baseUrl}. Start it with "npm run trueforge" and try again.`);
          return;
        }
        await indexing;
        const firstTurn = !sessionId;
        const built = buildAgentPrompt({
          text,
          mentions,
          context,
          firstTurn,
          repoMapTokens: cfg().get<number>('context.repoMapTokens', 1200),
        });
        const shownPrompt = built.attachedSummary
          ? `${text}\n\n[attached: ${built.attachedSummary} · ${formatK(built.attachedTokens)} tokens]`
          : text;
        const handle = trueforge.startRun({
          kind: 'agent',
          prompt: built.content,
          sessionId,
          onEvent: (e: UiEvent) => {
            if (e.type === 'run.started') {
              sessionId = e.sessionId;
              panel?.postEvent({ ...e, prompt: shownPrompt });
              pushState();
              return;
            }
            panel?.postEvent(e);
          },
          onApproval,
        });
        trackRun(handle);
        const result = await handle.done;
        if (result.sessionId) sessionId = result.sessionId;
        pushState();
      })().catch((e) => log.error('send failed', e));
    },
    cancel: () => void cancelAll(),
    newChat() {
      void cancelAll();
      sessionId = undefined;
      sessionAllowedCommands.clear();
      panel?.reset();
      pushState();
    },
    undo(changeId) {
      void review.journal.undo(changeId).then((ok) => {
        const c = review.journal.list().find((x) => x.id === changeId);
        if (ok && c) panel?.postEvent({ type: 'change.undone', runId: c.runId, changeId });
      });
    },
    undoRun(runId) {
      const ids = review.journal.list().filter((c) => c.runId === runId && !c.undone).map((c) => c.id);
      void review.journal.undoRun(runId).then(() => {
        for (const id of ids) {
          if (review.journal.list().find((c) => c.id === id)?.undone) panel?.postEvent({ type: 'change.undone', runId, changeId: id });
        }
      });
    },
    openChange(changeId) {
      const c = review.journal.list().find((x) => x.id === changeId);
      if (!c) return;
      const beforeUri = vscode.Uri.from({ scheme: 'anvil-before', path: '/' + c.relPath, query: `id=${c.id}` });
      void vscode.commands.executeCommand('vscode.diff', beforeUri, c.uri, `${c.relPath} (before ↔ after Anvil change)`);
    },
    openSession() {
      void vscode.env.openExternal(vscode.Uri.parse(sessionId ? trueforge.sessionUrl(sessionId) : trueforge.baseUrl));
    },
    selectModel: () => void vscode.commands.executeCommand('anvil.selectModel'),
    openFile(p, line) {
      void vscode.window.showTextDocument(vscode.Uri.file(path.join(root, p)), {
        selection: line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined,
        preview: true,
      });
    },
    suggest: (prefix) => context.suggest(prefix, 20),
    state,
  };

  panel = new AgentPanelProvider(ctx.extensionUri, panelHost);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // "before" side of the applied-change diff.
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('anvil-before', {
      provideTextDocumentContent(uri) {
        const id = new URLSearchParams(uri.query).get('id');
        return review.journal.list().find((c) => c.id === id)?.before ?? '';
      },
    }),
  );

  // Changes applied through the review (agent runs emit change.applied via the edit gate; inline edits show here too).
  ctx.subscriptions.push(review.onDidApply(() => pushState()));

  /* ── Inline edit ────────────────────────────────────────────────── */
  ctx.subscriptions.push(
    registerInlineEdit(ctx, { trueforge, review, context, workspaceRoot: root, log: createLogger('inline'), trackRun }),
  );

  /* ── Commands ───────────────────────────────────────────────────── */
  ctx.subscriptions.push(
    vscode.commands.registerCommand('anvil.openPanel', () => vscode.commands.executeCommand('anvil.agentPanel.focus')),
    vscode.commands.registerCommand('anvil.cancel', () => cancelAll()),
    vscode.commands.registerCommand('anvil.newChat', () => panelHost.newChat()),
    vscode.commands.registerCommand('anvil.openSession', () => panelHost.openSession()),
    vscode.commands.registerCommand('anvil.reconnect', async () => {
      const ok = await connect(true);
      vscode.window.showInformationMessage(ok ? `Anvil: connected to TrueForge (${chain.join(' → ')})` : `Anvil: TrueForge not reachable at ${trueforge.baseUrl}`);
    }),
    vscode.commands.registerCommand('anvil.reindex', async () => {
      indexStats = await context.build();
      vscode.window.showInformationMessage(`Anvil: indexed ${indexStats.files} files (${indexStats.chunks} chunks) in ${indexStats.buildMs} ms`);
      pushState();
    }),
    vscode.commands.registerCommand('anvil.selectModel', async () => {
      const models = await trueforge.listModels().catch(() => [] as string[]);
      if (!models.length) {
        vscode.window.showWarningMessage('Anvil: no models configured in TrueForge. Run "npm run setup" in the Anvil repo.');
        return;
      }
      const picked: string[] = [];
      for (const label of ['primary model', 'fallback model (Esc to finish)', 'second fallback (Esc to finish)']) {
        const options = models.filter((m) => !picked.includes(m));
        if (!options.length) break;
        const choice = await vscode.window.showQuickPick(options, {
          title: `Anvil: choose ${label}`,
          placeHolder: picked.length ? `Chain so far: ${picked.join(' → ')}` : 'Models configured in TrueForge',
        });
        if (!choice) break;
        picked.push(choice);
      }
      if (!picked.length) return;
      // Global target: never write .vscode/settings.json into the user's repository.
      await cfg().update('models', picked, vscode.ConfigurationTarget.Global);
      await connect(true);
      vscode.window.showInformationMessage(`Anvil: model chain ${picked.join(' → ')}`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('anvil.models') || e.affectsConfiguration('anvil.trueforgeUrl')) void connect(true);
    }),
  );

  void indexing;
}

export function deactivate(): void {}
