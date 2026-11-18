import { beforeEach, describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { extractCode, reindent, identifiers } from '../src/inline/extract';
import { registerInlineEdit, type InlineEditDeps } from '../src/inline/inlineEdit';
import { createReviewService } from '../src/review';
import { createJournal } from '../src/review/journal';
import { AgentPanelProvider } from '../src/panel/agentPanel';
import type { PanelHost, ProposedChange, ReviewOutcome, RunHandle, RunResult, StartRunOptions } from '../src/shared/contracts';

const mocks = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  info: vi.fn(async () => undefined),
  error: vi.fn(async () => undefined),
  openDocument: vi.fn(),
  applyEdit: vi.fn(async () => true),
}));

vi.mock('vscode', () => {
  const disposable = () => ({ dispose() {} });
  return {
    commands: { registerCommand: mocks.registerCommand, executeCommand: vi.fn() },
    window: {
      activeTextEditor: undefined,
      showInputBox: async () => 'Change the value',
      showInformationMessage: mocks.info,
      showErrorMessage: mocks.error,
      setStatusBarMessage: disposable,
      createStatusBarItem: () => ({ ...disposable(), show() {}, hide() {} }),
      createTextEditorDecorationType: disposable,
      onDidChangeActiveTextEditor: disposable,
      onDidChangeVisibleTextEditors: disposable,
      tabGroups: { onDidChangeTabs: disposable },
    },
    workspace: {
      textDocuments: [],
      openTextDocument: mocks.openDocument,
      applyEdit: mocks.applyEdit,
      registerTextDocumentContentProvider: disposable,
      onDidChangeTextDocument: disposable,
    },
    languages: { registerCodeLensProvider: disposable },
    Uri: { parse: (s: string) => s, joinPath: (a: string, b: string) => a + '/' + b },
    Range: class {},
    Position: class { constructor(readonly line: number, readonly character: number) {} },
    WorkspaceEdit: class { replace() {} },
    EventEmitter: class { fire() {} dispose() {} },
    StatusBarAlignment: { Left: 1 },
    EndOfLine: { CRLF: 2 },
    OverviewRulerLane: { Left: 1, Right: 2 },
  };
});

const log = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = () => ({ subscriptions: [] } as unknown as vscode.ExtensionContext);
const uri = { scheme: 'file', fsPath: '/work/app.py', toString: () => 'file:///work/app.py' } as vscode.Uri;
const change: ProposedChange = {
  id: 'change', runId: 'run', source: 'inline', uri, relPath: 'app.py',
  originalText: 'x = 1', proposedText: 'x = 2', isNewFile: false,
};
const accepted: ReviewOutcome = { changeId: change.id, status: 'decided', accepted: [0], rejected: [], decisions: ['accepted'] };
const cancelled: ReviewOutcome = { ...accepted, status: 'cancelled', accepted: [], decisions: ['pending'] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { resolve, promise };
}

function textDocument(text: string, save = async () => true) {
  return {
    uri, save, getText: () => text, lineCount: 1, eol: 1, languageId: 'python',
    lineAt: () => ({ text, range: { end: new vscode.Position(0, text.length) } }),
    offsetAt: (p: vscode.Position) => p.character,
    positionAt: (n: number) => new vscode.Position(0, n),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(vscode.workspace, { textDocuments: [] });
});

describe('extractCode', () => {
  it('raw text without fence', () => expect(extractCode('x = 1').code).toBe('x = 1'));
  it('fence only so far', () => expect(extractCode('```python').code).toBe(''));
  it('streams inside fence', () => expect(extractCode('Sure:\n```py\na = 1\nb =').code).toBe('a = 1\nb ='));
  it('stops at closing fence', () => {
    const r = extractCode('```py\na\nb\n```\nDone.');
    expect(r).toEqual({ code: 'a\nb', fenced: true, closed: true });
  });
  it('hides partial closing fence', () => expect(extractCode('```\na\n``').code).toBe('a'));
});

describe('reindent', () => {
  it('adds base indentation', () => expect(reindent('a\n  b', '    x')).toBe('    a\n      b'));
  it('removes extra indentation', () => expect(reindent('    a\n      b', '  x')).toBe('  a\n    b'));
  it('noop when equal', () => expect(reindent('  a', '  x')).toBe('  a'));
});

describe('identifiers', () => {
  it('skips keywords', () => expect(identifiers('return foo_bar(self, Baz)')).toEqual(['foo_bar', 'Baz']));
});

function inlineRun() {
  Object.assign(vscode.window, {
    activeTextEditor: {
      document: textDocument('x = 1'),
      selection: { isEmpty: true, start: new vscode.Position(0, 0), end: new vscode.Position(0, 0) },
    },
  });
  const model = deferred<RunResult>();
  const decision = deferred<ReviewOutcome>();
  const stream = {
    done: decision.promise,
    update: vi.fn(),
    complete: vi.fn((_text: string) => decision.promise),
    cancel: vi.fn(() => decision.resolve(cancelled)),
  };
  const review = { beginStreaming: vi.fn(() => stream), apply: vi.fn(async () => null) };
  const cancel = vi.fn(async () => model.resolve({ status: 'cancelled', text: '', model: 'fake/model', modelsTried: [] }));
  const startRun = vi.fn((_opts: StartRunOptions) => ({ runId: 'run', kind: 'inline', done: model.promise, cancel }));
  let tracked!: RunHandle;
  const dispose = vi.fn();
  const trackRun = vi.fn((handle: RunHandle) => { tracked = handle; return { dispose }; });
  registerInlineEdit(ctx(), {
    trueforge: { startRun }, review, context: { findSymbol: () => [] }, workspaceRoot: '/work', log, trackRun,
  } as unknown as InlineEditDeps);
  const execute = mocks.registerCommand.mock.calls.at(-1)![1] as () => Promise<void>;
  return { execute, model, decision, stream, review, cancel, startRun, trackRun, dispose, stop: () => tracked.cancel() };
}

describe('inline review lifecycle', () => {
  it('clears the preview on retry and fallback, prefers the terminal text, and stays tracked until apply settles', async () => {
    const run = inlineRun();
    const apply = deferred<null>();
    run.review.apply.mockReturnValue(apply.promise);
    const done = run.execute();
    await vi.waitFor(() => expect(run.trackRun).toHaveBeenCalled());
    expect(run.review.beginStreaming).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run' }));
    const { onEvent } = run.startRun.mock.calls[0][0];
    const delta = { type: 'text.delta' as const, runId: 'run', threadId: 'main', messageId: 'm1', text: 'x = par' };
    onEvent(delta);
    onEvent({ type: 'model.retry', runId: 'run', model: 'fake/model', attempt: 2, maxAttempts: 2, delayMs: 1000, error: 'failed' });
    expect(run.stream.update).toHaveBeenLastCalledWith('x = 1');
    onEvent(delta);
    expect(run.stream.update).toHaveBeenLastCalledWith('x = par');
    onEvent({ type: 'model.fallback', runId: 'run', from: 'fake/model', to: 'fake/second', error: 'failed' });
    expect(run.stream.update).toHaveBeenLastCalledWith('x = 1');
    onEvent(delta);
    run.model.resolve({ status: 'done', text: 'x = 2', model: 'fake/second', modelsTried: [] });
    await vi.waitFor(() => expect(run.stream.complete).toHaveBeenCalledWith('x = 2'));
    run.decision.resolve(accepted);
    await vi.waitFor(() => expect(run.review.apply).toHaveBeenCalled());
    expect(run.dispose).not.toHaveBeenCalled();
    apply.resolve(null);
    await done;
    expect(run.dispose).toHaveBeenCalledOnce();
  });

  it('cancels the model when the streaming preview closes', async () => {
    const run = inlineRun();
    const done = run.execute();
    await vi.waitFor(() => expect(run.trackRun).toHaveBeenCalled());
    run.decision.resolve(cancelled);
    await done;
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(run.review.apply).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith('Anvil: cancelled — no changes were made.');
  });

  it('stops a pending hunk review after generation has finished', async () => {
    const run = inlineRun();
    const done = run.execute();
    run.model.resolve({ status: 'done', text: 'x = 2', model: 'fake/model', modelsTried: [] });
    await vi.waitFor(() => expect(run.stream.complete).toHaveBeenCalled());
    await run.stop();
    await done;
    expect(run.review.apply).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith('Anvil: cancelled — no changes were made.');
  });
});

describe('save failures', () => {
  it('rejects apply without recording an applied change when the document cannot save', async () => {
    mocks.openDocument.mockResolvedValue(textDocument(change.originalText, async () => false));
    const review = createReviewService(ctx(), { workspaceRoot: '/work', log });
    await expect(review.apply(change, accepted)).rejects.toThrow('Could not save app.py');
    expect(review.journal.list()).toEqual([]);
  });

  it('leaves the journal entry active when undo cannot save', async () => {
    const doc = textDocument(change.proposedText, async () => false);
    Object.assign(vscode.workspace, { textDocuments: [doc] });
    mocks.openDocument.mockResolvedValue(doc);
    const journal = createJournal(log);
    journal.record({
      id: change.id, runId: change.runId, uri, relPath: change.relPath,
      before: change.originalText, after: change.proposedText, hunksApplied: [0], hunksTotal: 1, appliedAt: 0, undone: false,
    });
    expect(await journal.undo(change.id)).toBe(false);
    expect(journal.list()[0].undone).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Could not save app.py'));
  });
});

it('does not commit an accepted inline edit if cancelled while opening the document', async () => {
  const document = deferred<ReturnType<typeof textDocument>>();
  mocks.openDocument.mockReturnValue(document.promise);
  const review = createReviewService(ctx(), { workspaceRoot: '/work', log });
  const cancel = new AbortController();
  const applying = review.apply(change, accepted, cancel.signal);
  cancel.abort();
  document.resolve(textDocument(change.originalText));
  await expect(applying).resolves.toBeNull();
  expect(mocks.applyEdit).not.toHaveBeenCalled();
});

it('denies pending command approvals when the panel is disposed', async () => {
  let close!: () => void;
  const view = {
    webview: {
      onDidReceiveMessage: () => ({ dispose() {} }),
      asWebviewUri: (u: vscode.Uri) => u,
    },
    onDidDispose: (fn: () => void) => { close = fn; return { dispose() {} }; },
  } as unknown as vscode.WebviewView;
  const panel = new AgentPanelProvider(uri, {} as PanelHost);
  panel.resolveWebviewView(view);
  const answer = panel.requestApproval({ callId: 'command', name: 'run_command', threadId: 'main', args: { command: 'pytest' } }, 'run');
  close();
  await expect(answer).resolves.toEqual({ decision: 'deny', reason: 'panel closed' });
});
