/**
 * Shared contracts between Anvil's modules. Every module codes against these
 * interfaces, so the context engine, the TrueForge runtime, the MCP tool server,
 * the review UI and the agent panel can be built and tested independently.
 *
 * Only `import type` from 'vscode' is allowed here, so the pure-Node modules
 * (src/context) can import this file in unit tests without a VS Code host.
 */
import type * as vscode from 'vscode';

/* ───────────────────────── Context engine (src/context, pure Node) ───────────────────────── */

export interface ContextEngineOptions {
  /** Absolute workspace root. All paths returned by the engine are POSIX paths relative to it. */
  root: string;
  /** Extra directory names to skip in addition to the built-in list (.git, node_modules, .venv, ...). */
  exclude?: string[];
  /** Files larger than this are skipped (default 512 KiB). */
  maxFileBytes?: number;
}

export type SymbolKind = 'function' | 'class' | 'method' | 'variable' | 'heading';

export interface SymbolDef {
  name: string;
  /** e.g. "FlaskGroup.__init__" for methods, the bare name otherwise. */
  qualifiedName: string;
  kind: SymbolKind;
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** First line of the definition, trimmed (e.g. "def get_debug_flag() -> bool:"). */
  signature: string;
}

export interface IndexStats {
  files: number;
  chunks: number;
  symbols: number;
  totalTokens: number;
  builtAt: number;
  buildMs: number;
}

export interface RetrievedSpan {
  startLine: number;
  endLine: number;
  symbol?: string;
  tokens: number;
  /** Excerpt text WITHOUT line-number prefixes. May be an outline (signatures only) when budget is tight. */
  text: string;
  /** 'code' = full excerpt, 'outline' = signatures/headings only. */
  mode: 'code' | 'outline';
}

export interface RetrievedFile {
  path: string;
  score: number;
  /** Human-readable evidence, e.g. "defines routes_command (built-in CLI command)", "test pair of src/flask/cli.py". */
  reasons: string[];
  spans: RetrievedSpan[];
}

export interface RetrievalOmission {
  path: string;
  score: number;
  /** Why it was left out, e.g. "over budget (would add 1,240 tokens)", "below relevance threshold". */
  reason: string;
}

export interface RetrievalResult {
  query: string;
  budgetTokens: number;
  usedTokens: number;
  files: RetrievedFile[];
  omitted: RetrievalOmission[];
  /** One-line description of the strategy, shown in the UI and returned to the model. */
  strategy: string;
  elapsedMs: number;
  indexStats: IndexStats;
}

export interface RetrieveOptions {
  budgetTokens?: number;
  /** Paths the user @-mentioned: always included first, and used as graph seeds. */
  mentionedPaths?: string[];
  maxFiles?: number;
}

export interface TextMatch {
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface MentionSuggestion {
  kind: 'file' | 'symbol';
  /** What the user sees, e.g. "cli.py" or "get_debug_flag". */
  label: string;
  /** Secondary text, e.g. "src/flask/cli.py" or "function · src/flask/helpers.py:27". */
  detail?: string;
  /** Value inserted after '@', e.g. "src/flask/cli.py" or "get_debug_flag". */
  value: string;
}

export interface ContextEngine {
  build(): Promise<IndexStats>;
  refreshFile(relPath: string): Promise<void>;
  removeFile(relPath: string): void;
  retrieve(query: string, opts?: RetrieveOptions): RetrievalResult;
  /** Compact ranked outline of the repository (paths + top-level symbols), within budget. */
  repoMap(opts?: { budgetTokens?: number; focusPaths?: string[]; query?: string }): string;
  findSymbol(name: string, limit?: number): SymbolDef[];
  /** Simple glob ('**', '*', '?') or substring filter over indexed relative paths. */
  listFiles(pattern?: string, limit?: number): string[];
  /** In-memory search over indexed files. */
  searchText(pattern: string, opts?: { regex?: boolean; caseSensitive?: boolean; glob?: string; maxResults?: number }): TextMatch[];
  /** @-mention autocomplete (files and symbols), best matches first. */
  suggest(prefix: string, limit?: number): MentionSuggestion[];
  /** Returns the indexed text of a file, or undefined if not indexed. */
  fileText(relPath: string): string | undefined;
  stats(): IndexStats;
}

/* ───────────────────────── Review (src/review, VS Code) ───────────────────────── */

export type HunkDecision = 'pending' | 'accepted' | 'rejected';

export interface Hunk {
  index: number;
  /** 1-based line in the ORIGINAL text where the removed block starts (or the insertion point). */
  oldStart: number;
  /** Lines removed from the original (no trailing newlines). */
  oldLines: string[];
  /** 1-based line in the PROPOSED text where the added block starts. */
  newStart: number;
  /** Lines added in the proposal (no trailing newlines). */
  newLines: string[];
}

export interface ProposedChange {
  id: string;
  runId: string;
  source: 'agent' | 'inline';
  /** POSIX path relative to the workspace root. */
  relPath: string;
  uri: vscode.Uri;
  /** Text the proposal was computed against (open buffer if dirty, else disk). '' for new files. */
  originalText: string;
  proposedText: string;
  isNewFile: boolean;
  /** Short description from the model/tool call, shown in the review header. */
  title?: string;
}

export interface ReviewOutcome {
  changeId: string;
  status: 'decided' | 'cancelled';
  decisions: HunkDecision[];
  accepted: number[];
  rejected: number[];
}

export interface AppliedChange {
  id: string;
  runId: string;
  relPath: string;
  uri: vscode.Uri;
  /** Full text before the change; null if the file did not exist. */
  before: string | null;
  after: string;
  hunksApplied: number[];
  hunksTotal: number;
  appliedAt: number;
  undone: boolean;
}

export interface StreamingReview {
  /** Replace the live preview with the latest full proposed text (throttled internally). */
  update(proposedText: string): void;
  /** Stream finished: compute hunks, show per-hunk controls, resolve when the user has decided. */
  complete(finalProposedText: string): Promise<ReviewOutcome>;
  /** Abort: close the preview, nothing is written. */
  cancel(): void;
}

export interface ChangeJournal {
  list(): AppliedChange[];
  /** Restores `before` (deletes the file if it did not exist). Refuses if the file changed since. */
  undo(changeId: string): Promise<boolean>;
  /** Undo every not-yet-undone change of a run, newest first. Returns how many were undone. */
  undoRun(runId: string): Promise<number>;
  readonly onDidChange: vscode.Event<void>;
}

export interface ReviewService {
  /** Opens the per-hunk review UI for a fully known proposal; resolves when every hunk is decided or the review is cancelled. */
  review(change: ProposedChange): Promise<ReviewOutcome>;
  /** Live-updating preview for streamed proposals (inline edit). */
  beginStreaming(change: Omit<ProposedChange, 'proposedText'>): StreamingReview;
  /**
   * Applies ONLY the accepted hunks in one WorkspaceEdit, saves the document, records it in the journal.
   * Refuses (throws) if the file's current text no longer equals change.originalText.
   * Returns null when no hunk was accepted.
   */
  apply(change: ProposedChange, outcome: ReviewOutcome): Promise<AppliedChange | null>;
  /** Cancels every pending review belonging to a run (closes the review editors, resolves them as 'cancelled'). */
  cancelRun(runId: string): void;
  readonly journal: ChangeJournal;
  readonly onDidApply: vscode.Event<AppliedChange>;
}

/* ───────────────────────── TrueForge runtime (src/trueforge) ───────────────────────── */

export type RunKind = 'agent' | 'inline';

export interface ToolCallInfo {
  callId: string;
  /** 'main', a sub-agent thread id, or null. Must be echoed back in approvals. */
  threadId: string | null;
  /** Real tool name (unwrapped from deferred `call_tool` if needed), e.g. "edit_file". */
  name: string;
  /** MCP server name when the tool is an MCP tool. */
  server?: string;
  args: Record<string, unknown>;
}

export type ApprovalDecision = { status: 'allow' } | { status: 'deny'; reason: string };

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/** Normalised events emitted by the runtime and tool layer, consumed by the panel and inline UI. */
export type UiEvent =
  | { type: 'run.started'; runId: string; kind: RunKind; sessionId: string; model: string; sessionUrl: string; prompt: string }
  | { type: 'text.delta'; runId: string; threadId: string | null; messageId: string; text: string }
  | { type: 'reasoning.delta'; runId: string; threadId: string | null; messageId: string; text: string }
  | { type: 'tool.call'; runId: string; threadId: string | null; callId: string; name: string; server?: string; args?: Record<string, unknown>; argsChars?: number; status: 'streaming' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied' }
  | { type: 'tool.result'; runId: string; threadId: string | null; callId: string; name: string; ok: boolean; summary: string }
  | { type: 'context.selected'; runId: string; result: RetrievalResult }
  | { type: 'subagent.started'; runId: string; threadId: string; name: string; input: string }
  | { type: 'subagent.done'; runId: string; threadId: string; ok: boolean; output: string }
  | { type: 'compaction'; runId: string; threadId: string | null; phase: 'started' | 'finished'; contextTokens?: number; thresholdTokens?: number; durationMs?: number }
  | { type: 'approval.requested'; runId: string; call: ToolCallInfo; kind: 'edit' | 'command' | 'other' }
  | { type: 'approval.resolved'; runId: string; callId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'model.retry'; runId: string; model: string; attempt: number; maxAttempts: number; delayMs: number; error: string }
  | { type: 'model.fallback'; runId: string; from: string; to: string; error: string }
  | { type: 'change.applied'; runId: string; change: AppliedChangeSummary }
  | { type: 'change.undone'; runId: string; changeId: string }
  | { type: 'run.done'; runId: string; status: 'done' | 'cancelled' | 'error'; model: string; text: string; error?: string; modelsTried: string[]; usage?: UsageInfo; elapsedMs: number };

export interface AppliedChangeSummary {
  id: string;
  runId: string;
  relPath: string;
  hunksApplied: number;
  hunksTotal: number;
  linesAdded: number;
  linesRemoved: number;
  undone: boolean;
}

export interface RunResult {
  status: 'done' | 'cancelled' | 'error';
  text: string;
  model: string;
  sessionId?: string;
  error?: string;
  modelsTried: string[];
}

export interface RunHandle {
  readonly runId: string;
  readonly kind: RunKind;
  /** Set once the TrueForge session exists. */
  readonly sessionId: string | undefined;
  /** Cancels the TrueForge turn (POST /sessions/{id}/cancel) and resolves pending approvals as denied. */
  cancel(): Promise<void>;
  readonly done: Promise<RunResult>;
}

export interface StartRunOptions {
  kind: RunKind;
  /** Full user message content (already including any attached context blocks). */
  prompt: string;
  /** Continue an existing TrueForge session (agent panel follow-ups). */
  sessionId?: string;
  onEvent(e: UiEvent): void;
  /** Called for every tool call TrueForge pauses for approval. Must not throw. */
  onApproval(call: ToolCallInfo, runId: string): Promise<ApprovalDecision>;
}

export interface TrueForgeHealth {
  ok: boolean;
  url: string;
  version?: string;
  error?: string;
}

export interface TrueForgeService {
  readonly baseUrl: string;
  health(): Promise<TrueForgeHealth>;
  /** Registers the editor MCP server (current port + token) and upserts the bundled agent definitions. Idempotent. */
  ensureSetup(): Promise<void>;
  /** Model names configured in TrueForge (GET /api/v1/models). */
  listModels(): Promise<string[]>;
  /** Ordered model chain actually used (anvil.models filtered to configured models, or all configured). */
  modelChain(): Promise<string[]>;
  startRun(opts: StartRunOptions): RunHandle;
  /** Run currently bound to a TrueForge session id (used by MCP handlers via x-tfg-session-id). */
  runForSession(sessionId: string | undefined): { runId: string; kind: RunKind } | undefined;
  sessionUrl(sessionId: string): string;
}

/* ───────────────────────── MCP editor tools (src/mcp) ───────────────────────── */

export const MCP_SERVER_NAME = 'anvil-editor';

/** Names of the MCP tools Anvil exposes to TrueForge. Approval-gated: edit_file, write_file, run_command. */
export const TOOL_NAMES = {
  retrieveContext: 'retrieve_context',
  repoMap: 'repo_map',
  searchCode: 'search_code',
  findSymbol: 'find_symbol',
  readFile: 'read_file',
  listFiles: 'list_files',
  editFile: 'edit_file',
  writeFile: 'write_file',
  runCommand: 'run_command',
  getDiagnostics: 'get_diagnostics',
} as const;

export const EDIT_TOOLS: readonly string[] = [TOOL_NAMES.editFile, TOOL_NAMES.writeFile];
export const APPROVAL_TOOLS: readonly string[] = [TOOL_NAMES.editFile, TOOL_NAMES.writeFile, TOOL_NAMES.runCommand];

/** What the MCP tool handlers need from the editor. Implemented in src/extension.ts. */
export interface EditorToolHost {
  readonly workspaceRoot: string;
  readonly context: ContextEngine;
  readonly review: ReviewService;
  readonly trueforge: TrueForgeService;
  /** Emit a UI event into the run bound to this TrueForge session (no-op if none). */
  emit(tfSessionId: string | undefined, e: UiEvent): void;
  /** Current text: open (possibly dirty) buffer first, else disk. null if the file does not exist. */
  readText(relPath: string): Promise<string | null>;
  /** Diagnostics as text, for one file or the whole workspace. */
  diagnostics(relPath?: string): string;
  /** Environment for run_command (PATH with workspace .venv/bin prepended, etc.). */
  commandEnv(): NodeJS.ProcessEnv;
  commandTimeoutSeconds(): number;
}

/**
 * The bridge between TrueForge approvals and the per-hunk review:
 * at approval time the proposal is built from the tool arguments and reviewed;
 * when TrueForge then invokes the MCP tool, the stored outcome is applied.
 */
export interface EditGate {
  /** Called from onApproval for edit tools. Runs the review; stores the outcome; returns allow (>=1 hunk accepted) or deny. */
  reviewToolCall(call: ToolCallInfo, runId: string, tfSessionId: string): Promise<ApprovalDecision>;
  /** Called by the edit tool handlers. Applies the stored outcome for these args; returns the text for the model. */
  applyReviewed(toolName: string, args: Record<string, unknown>, tfSessionId: string | undefined): Promise<string>;
  /** Drops stored outcomes for a run (on cancel). */
  forgetRun(runId: string): void;
}

/* ───────────────────────── Agent panel (src/panel + src/webview) ───────────────────────── */

export interface Mention {
  kind: 'file' | 'symbol';
  value: string;
}

export interface PanelState {
  trueforge: TrueForgeHealth;
  models: string[];
  activeModel?: string;
  sessionId?: string;
  sessionUrl?: string;
  running: boolean;
  changes: AppliedChangeSummary[];
  index?: IndexStats;
}

/** Messages webview -> extension. */
export type PanelToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string; mentions: Mention[] }
  | { type: 'cancel' }
  | { type: 'newChat' }
  | { type: 'approval'; callId: string; decision: 'allow' | 'deny' | 'allow-session'; reason?: string }
  | { type: 'openChange'; changeId: string }
  | { type: 'undo'; changeId: string }
  | { type: 'undoRun'; runId: string }
  | { type: 'openSession' }
  | { type: 'selectModel' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'mentionQuery'; requestId: number; prefix: string };

/** Messages extension -> webview. */
export type HostToPanel =
  | { type: 'event'; event: UiEvent }
  | { type: 'state'; state: PanelState }
  | { type: 'mentionResults'; requestId: number; items: MentionSuggestion[] }
  | { type: 'reset' };

/** What the panel provider needs from the extension. Implemented in src/extension.ts. */
export interface PanelHost {
  send(text: string, mentions: Mention[]): void;
  cancel(): void;
  newChat(): void;
  undo(changeId: string): void;
  undoRun(runId: string): void;
  openChange(changeId: string): void;
  openSession(): void;
  selectModel(): void;
  openFile(path: string, line?: number): void;
  suggest(prefix: string): MentionSuggestion[];
  state(): PanelState;
}
