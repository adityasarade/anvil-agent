import * as vscode from 'vscode';
import type {
  AppliedChange, HunkDecision, ProposedChange, ReviewOutcome, ReviewService, StreamingReview, Hunk,
} from '../shared/contracts';
import type { Logger } from '../shared/log';
import { applyHunks, computeHunks, hunkEdits } from './hunks';
import { buildView, pickHunk, type ViewModel } from './render';
import { createJournal, readCurrentText } from './journal';

const SCHEME = 'anvil-review';
const ORIG_SCHEME = 'anvil-original';
const PROP_SCHEME = 'anvil-proposed';
const NOOP = 'anvil.review._noop';
const UNDO_DECISION = 'anvil.review.undoDecision';

type BaseChange = Omit<ProposedChange, 'proposedText'>;

interface Session {
  id: string;
  runId: string;
  relPath: string;
  uri: vscode.Uri;
  title?: string;
  isNewFile: boolean;
  original: string;
  proposed: string;
  streaming: boolean;
  hunks: Hunk[];
  decisions: HunkDecision[];
  view: ViewModel;
  viewUri: vscode.Uri;
  resolved: boolean;
  resolve: (o: ReviewOutcome) => void;
  promise: Promise<ReviewOutcome>;
  lastDecided: number;
  tabSeen: boolean;
}

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse('data:image/svg+xml;utf8,' + encodeURIComponent(svg));
}
const MINUS = svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="3" y="7" width="10" height="2" fill="#e5534b"/></svg>');
const PLUS = svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="3" y="7" width="10" height="2" fill="#3fb950"/><rect x="7" y="3" width="2" height="10" fill="#3fb950"/></svg>');

function shortTitle(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function createReviewService(ctx: vscode.ExtensionContext, opts: { workspaceRoot: string; log: Logger }): ReviewService {
  const { log } = opts;
  const sessions = new Map<string, Session>(); // unresolved only
  const snapshots = new Map<string, { original: string; proposed: string }>(); // for side-by-side after resolution
  const queue: Session[] = [];
  let active: Session | null = null;
  let pumping = false;

  const contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  const lensEmitter = new vscode.EventEmitter<void>();
  const applyEmitter = new vscode.EventEmitter<AppliedChange>();
  const journal = createJournal(log);
  const disposables: vscode.Disposable[] = [contentEmitter, lensEmitter, applyEmitter, { dispose: () => journal.dispose() }];

  /* ───────────── decorations ───────────── */
  const mk = (o: vscode.DecorationRenderOptions) => vscode.window.createTextEditorDecorationType({ isWholeLine: true, ...o });
  const removedDeco = mk({ backgroundColor: 'rgba(229,83,75,0.20)', gutterIconPath: MINUS, gutterIconSize: 'contain', overviewRulerColor: 'rgba(229,83,75,0.8)', overviewRulerLane: vscode.OverviewRulerLane.Left });
  const addedDeco = mk({ backgroundColor: 'rgba(63,185,80,0.20)', gutterIconPath: PLUS, gutterIconSize: 'contain', overviewRulerColor: 'rgba(63,185,80,0.8)', overviewRulerLane: vscode.OverviewRulerLane.Right });
  const removedFaded = mk({ backgroundColor: 'rgba(229,83,75,0.07)', opacity: '0.5', textDecoration: 'line-through', gutterIconPath: MINUS, gutterIconSize: 'contain' });
  const addedFaded = mk({ backgroundColor: 'rgba(63,185,80,0.07)', opacity: '0.5', textDecoration: 'line-through', gutterIconPath: PLUS, gutterIconSize: 'contain' });
  disposables.push(removedDeco, addedDeco, removedFaded, addedFaded);

  const sessionOf = (uri: vscode.Uri): Session | undefined => {
    if (uri.scheme !== SCHEME) return undefined;
    const id = new URLSearchParams(uri.query).get('id');
    return id ? sessions.get(id) : undefined;
  };

  function decorate(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== SCHEME) return;
    const s = sessionOf(editor.document.uri);
    const rem: vscode.Range[] = [], remF: vscode.Range[] = [], add: vscode.Range[] = [], addF: vscode.Range[] = [];
    if (s) {
      const last = editor.document.lineCount - 1;
      for (const r of s.view.regions) {
        const d = s.decisions[r.hunk] ?? 'pending';
        for (let i = 0; i < r.removed; i++) {
          const l = r.start + i;
          if (l <= last) (d === 'accepted' ? remF : rem).push(new vscode.Range(l, 0, l, 0));
        }
        for (let i = 0; i < r.added; i++) {
          const l = r.start + r.removed + i;
          if (l <= last) (d === 'rejected' ? addF : add).push(new vscode.Range(l, 0, l, 0));
        }
      }
    }
    editor.setDecorations(removedDeco, rem);
    editor.setDecorations(removedFaded, remF);
    editor.setDecorations(addedDeco, add);
    editor.setDecorations(addedFaded, addF);
  }
  const decorateAll = () => vscode.window.visibleTextEditors.forEach(decorate);

  /* ───────────── providers ───────────── */
  const viewProvider: vscode.TextDocumentContentProvider = {
    onDidChange: contentEmitter.event,
    provideTextDocumentContent(uri) {
      return sessionOf(uri)?.view.text ?? '';
    },
  };
  const snap = (uri: vscode.Uri, which: 'original' | 'proposed') => {
    const id = new URLSearchParams(uri.query).get('id') ?? '';
    const sn = snapshots.get(id);
    const s = sessions.get(id);
    return sn ? sn[which] : s ? (which === 'original' ? s.original : s.proposed) : '';
  };

  const lensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensEmitter.event,
    provideCodeLenses(doc) {
      const s = sessionOf(doc.uri);
      if (!s) return [];
      const lenses: vscode.CodeLens[] = [];
      const top = new vscode.Range(0, 0, 0, 0);
      const lens = (range: vscode.Range, title: string, command: string, args?: unknown[], tooltip?: string) =>
        lenses.push(new vscode.CodeLens(range, { title, command, arguments: args, tooltip }));
      const a = { changeId: s.id };
      if (s.streaming) {
        lens(top, '⟳ Generating… · Stop (Esc)', 'anvil.cancel');
        return lenses;
      }
      lens(top, `Anvil review · ${shortTitle(s.title ?? s.relPath)} · ${s.hunks.length} hunk${s.hunks.length === 1 ? '' : 's'}`, NOOP);
      lens(top, 'Accept all', 'anvil.review.acceptAll', [a]);
      lens(top, 'Reject all', 'anvil.review.rejectAll', [a]);
      lens(top, 'Side-by-side', 'anvil.review.openSideBySide', [a]);
      for (const r of s.view.regions) {
        const range = new vscode.Range(r.start, 0, r.start, 0);
        const arg = { changeId: s.id, index: r.hunk };
        const d = s.decisions[r.hunk] ?? 'pending';
        if (d === 'accepted') lens(range, '✓ Accepted · undo decision', UNDO_DECISION, [arg]);
        else if (d === 'rejected') lens(range, '✗ Rejected · undo decision', UNDO_DECISION, [arg]);
        else {
          lens(range, '✓ Accept', 'anvil.review.acceptHunk', [arg]);
          lens(range, '✗ Reject', 'anvil.review.rejectHunk', [arg]);
          lens(range, `Hunk ${r.hunk + 1}/${s.hunks.length} · +${r.added} −${r.removed}`, NOOP);
        }
      }
      return lenses;
    },
  };

  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, viewProvider),
    vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, { provideTextDocumentContent: (u) => snap(u, 'original') }),
    vscode.workspace.registerTextDocumentContentProvider(PROP_SCHEME, { provideTextDocumentContent: (u) => snap(u, 'proposed') }),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, lensProvider),
  );

  /* ───────────── editor plumbing ───────────── */
  const viewUriFor = (c: BaseChange) =>
    vscode.Uri.from({ scheme: SCHEME, path: '/' + c.relPath.replace(/^\/+/, ''), query: 'id=' + encodeURIComponent(c.id) });
  const sideUri = (scheme: string, s: Session) =>
    vscode.Uri.from({ scheme, path: '/' + s.relPath.replace(/^\/+/, ''), query: 'id=' + encodeURIComponent(s.id) });

  const findTabs = (pred: (t: vscode.Tab) => boolean) =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(pred));
  const isViewTab = (s: Session) => (t: vscode.Tab) =>
    t.input instanceof vscode.TabInputText && t.input.uri.toString() === s.viewUri.toString();

  function setContext(): void {
    const on = vscode.window.activeTextEditor?.document.uri.scheme === SCHEME;
    void vscode.commands.executeCommand('setContext', 'anvil.reviewActive', on);
  }

  function refresh(s: Session, content: boolean): void {
    if (content) contentEmitter.fire(s.viewUri);
    lensEmitter.fire();
    decorateAll();
  }

  function recompute(s: Session): void {
    s.hunks = computeHunks(s.original, s.proposed);
    s.view = buildView(s.original, s.hunks);
    if (!s.streaming) s.decisions = s.hunks.map(() => 'pending' as HunkDecision);
  }

  function regionRange(s: Session, hunk: number): vscode.Range {
    const r = s.view.regions[hunk];
    if (!r) return new vscode.Range(0, 0, 0, 0);
    return new vscode.Range(r.start, 0, r.start + Math.max(0, r.removed + r.added - 1), 0);
  }

  async function show(s: Session): Promise<void> {
    const real = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === s.uri.toString());
    const column = real?.viewColumn ?? vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
    const doc = await vscode.workspace.openTextDocument(s.viewUri);
    if (s.resolved) return;
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false, preserveFocus: false });
    s.tabSeen = true;
    if (s.resolved) { await closeEditors(s); return; }
    decorate(editor);
    revealHunk(editor, s, s.streaming ? undefined : 0);
  }

  function revealHunk(editor: vscode.TextEditor, s: Session, hunk: number | undefined): void {
    if (hunk === undefined || !s.view.regions.length) return;
    const range = regionRange(s, hunk);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  function editorOf(s: Session): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === s.viewUri.toString());
  }

  async function closeEditors(s: Session): Promise<void> {
    const tabs = findTabs((t) =>
      isViewTab(s)(t) ||
      (t.input instanceof vscode.TabInputTextDiff &&
        t.input.original.scheme === ORIG_SCHEME &&
        new URLSearchParams(t.input.original.query).get('id') === s.id));
    if (tabs.length) {
      try { await vscode.window.tabGroups.close(tabs); } catch (e) { log.warn('closing review tab failed', e); }
    }
  }

  /* ───────────── lifecycle ───────────── */
  function newSession(c: BaseChange, proposed: string, streaming: boolean): Session {
    let resolve!: (o: ReviewOutcome) => void;
    const promise = new Promise<ReviewOutcome>((r) => (resolve = r));
    const s: Session = {
      id: c.id, runId: c.runId, relPath: c.relPath, uri: c.uri, title: c.title, isNewFile: c.isNewFile,
      original: c.originalText, proposed, streaming, hunks: [], decisions: [], view: { text: '', regions: [] },
      viewUri: viewUriFor(c), resolved: false, resolve, promise, lastDecided: 0, tabSeen: false,
    };
    recompute(s);
    sessions.set(s.id, s);
    snapshots.set(s.id, { original: s.original, proposed });
    if (snapshots.size > 50) snapshots.delete(snapshots.keys().next().value as string);
    return s;
  }

  function enqueue(s: Session): void {
    queue.push(s);
    void pump();
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (!active && queue.length) {
        const next = queue.shift()!;
        if (next.resolved) continue;
        active = next;
        try {
          await show(next);
        } catch (e) {
          log.error('failed to open review editor', e);
          void vscode.window.showErrorMessage(`Anvil: could not open the review for ${next.relPath}. No files were changed.`);
          finish(next, 'cancelled', false);
        }
      }
    } finally {
      pumping = false;
    }
  }

  function outcomeOf(s: Session, status: 'decided' | 'cancelled'): ReviewOutcome {
    const decisions = s.decisions.map((d) => (status === 'cancelled' || s.streaming ? 'pending' : d)) as HunkDecision[];
    const idx = (k: HunkDecision) => decisions.flatMap((d, i) => (d === k ? [i] : []));
    return { changeId: s.id, status, decisions, accepted: status === 'decided' ? idx('accepted') : [], rejected: status === 'decided' ? idx('rejected') : [] };
  }

  /** Resolves the session and tears down its UI. Safe to call twice. */
  function finish(s: Session, status: 'decided' | 'cancelled', reveal = true): void {
    if (s.resolved) return;
    s.resolved = true;
    const outcome = outcomeOf(s, status);
    sessions.delete(s.id);
    const qi = queue.indexOf(s);
    if (qi >= 0) queue.splice(qi, 1);
    const wasActive = active === s;
    const column = editorOf(s)?.viewColumn;
    lensEmitter.fire();
    s.resolve(outcome);
    void (async () => {
      try {
        if (s.tabSeen) await closeEditors(s);
        if (status === 'decided' && reveal && !s.isNewFile && s.tabSeen) {
          const line = Math.max(0, (s.hunks[s.lastDecided]?.oldStart ?? 1) - 1);
          await vscode.window.showTextDocument(s.uri, {
            viewColumn: column, preview: false, selection: new vscode.Range(line, 0, line, 0),
          }).then((ed) => ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter));
        }
      } catch (e) {
        log.debug('post-resolve UI step failed', e);
      } finally {
        if (wasActive) { active = null; }
        void pump();
      }
    })();
  }

  function decide(s: Session, index: number, d: HunkDecision): void {
    if (s.resolved || s.streaming || !s.hunks[index]) return;
    s.decisions[index] = d;
    s.lastDecided = index;
    if (s.decisions.every((x) => x !== 'pending')) {
      finish(s, 'decided');
      return;
    }
    refresh(s, false);
  }

  function setAll(s: Session, d: HunkDecision): void {
    if (s.resolved || s.streaming) return;
    s.decisions = s.hunks.map(() => d);
    s.lastDecided = 0;
    finish(s, 'decided');
  }

  /* ───────────── commands ───────────── */
  type HunkArg = { changeId?: string; index?: number } | undefined;
  function target(arg: HunkArg): { s: Session; index: number } | undefined {
    const s = (arg?.changeId ? sessions.get(arg.changeId) : undefined) ?? active ?? undefined;
    if (!s || s.resolved || s.streaming) return undefined;
    if (typeof arg?.index === 'number') return { s, index: arg.index };
    const ed = vscode.window.activeTextEditor;
    const line = ed && ed.document.uri.toString() === s.viewUri.toString() ? ed.selection.active.line : undefined;
    const index = pickHunk(s.view.regions, s.decisions, line);
    return index === undefined ? undefined : { s, index };
  }
  function sessionArg(arg: HunkArg): Session | undefined {
    const s = (arg?.changeId ? sessions.get(arg.changeId) : undefined) ?? active ?? undefined;
    return s && !s.resolved ? s : undefined;
  }
  const cmd = (id: string, fn: (...a: any[]) => unknown) => disposables.push(vscode.commands.registerCommand(id, fn));

  cmd('anvil.review.acceptHunk', (arg: HunkArg) => { const t = target(arg); if (t) decide(t.s, t.index, 'accepted'); });
  cmd('anvil.review.rejectHunk', (arg: HunkArg) => { const t = target(arg); if (t) decide(t.s, t.index, 'rejected'); });
  cmd(UNDO_DECISION, (arg: HunkArg) => {
    const t = target(arg);
    if (t && typeof arg?.index === 'number') { t.s.decisions[t.index] = 'pending'; refresh(t.s, false); }
  });
  cmd('anvil.review.acceptAll', (arg: HunkArg) => { const s = sessionArg(arg); if (s) setAll(s, 'accepted'); });
  cmd('anvil.review.rejectAll', (arg: HunkArg) => { const s = sessionArg(arg); if (s) setAll(s, 'rejected'); });
  cmd('anvil.review.openSideBySide', async (arg: HunkArg) => {
    const s = sessionArg(arg);
    if (!s) return;
    snapshots.set(s.id, { original: s.original, proposed: s.proposed });
    await vscode.commands.executeCommand('vscode.diff', sideUri(ORIG_SCHEME, s), sideUri(PROP_SCHEME, s),
      `Anvil: ${s.relPath} (original ↔ proposed)`, { preview: false });
  });
  cmd(NOOP, () => undefined);
  cmd('anvil.undoLastChange', async () => {
    const last = journal.list().filter((c) => !c.undone).sort((a, b) => a.appliedAt - b.appliedAt).pop();
    if (!last) { void vscode.window.showInformationMessage('Anvil: no applied changes to undo.'); return; }
    if (await journal.undo(last.id)) void vscode.window.showInformationMessage(`Anvil: undid the change to ${last.relPath}.`);
  });

  /* ───────────── events ───────────── */
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(setContext),
    vscode.window.onDidChangeVisibleTextEditors(() => { decorateAll(); setContext(); }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== SCHEME) return;
      const s = sessionOf(e.document.uri);
      decorateAll();
      const ed = s && editorOf(s);
      if (s && ed && s.streaming && s.view.regions.length) {
        // follow the stream: keep the latest hunk in view
        const r = s.view.regions[s.view.regions.length - 1];
        const l = Math.min(r.start + r.removed + r.added, ed.document.lineCount - 1);
        ed.revealRange(new vscode.Range(l, 0, l, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const t of e.closed) {
        if (!(t.input instanceof vscode.TabInputText) || t.input.uri.scheme !== SCHEME) continue;
        const s = sessionOf(t.input.uri);
        if (!s || s.resolved || s !== active) continue;
        // the user closed the review tab without deciding: treat as cancel (nothing is written)
        setTimeout(() => {
          if (!s.resolved && !findTabs(isViewTab(s)).length) {
            log.info(`review tab closed by user: ${s.relPath}`);
            finish(s, 'cancelled', false);
          }
        }, 300);
      }
    }),
  );
  setContext();

  /* ───────────── service ───────────── */
  function review(change: ProposedChange): Promise<ReviewOutcome> {
    const s = newSession(change, change.proposedText, false);
    if (s.hunks.length === 0) { finish(s, 'decided', false); return s.promise; }
    enqueue(s);
    return s.promise;
  }

  function beginStreaming(change: BaseChange): StreamingReview {
    const s = newSession(change, change.originalText, true);
    enqueue(s);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (s.resolved || !s.streaming) return;
      recompute(s);
      refresh(s, true);
    };
    return {
      done: s.promise,
      update(text) {
        if (s.resolved || !s.streaming) return;
        s.proposed = text;
        if (!timer) timer = setTimeout(flush, 60);
      },
      complete(finalText) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        if (s.resolved) return s.promise;
        s.streaming = false;
        s.proposed = finalText;
        snapshots.set(s.id, { original: s.original, proposed: finalText });
        recompute(s);
        if (s.hunks.length === 0) {
          void vscode.window.showInformationMessage('No changes proposed');
          finish(s, 'decided', false);
          return s.promise;
        }
        refresh(s, true);
        const ed = editorOf(s);
        if (ed) revealHunk(ed, s, 0);
        return s.promise;
      },
      cancel() {
        if (timer) { clearTimeout(timer); timer = undefined; }
        s.streaming = false;
        finish(s, 'cancelled', false);
      },
    };
  }

  function cancelRun(runId: string): void {
    for (const s of [...sessions.values()]) {
      if (s.runId === runId) finish(s, 'cancelled', false);
    }
  }

  async function apply(change: ProposedChange, outcome: ReviewOutcome, signal?: AbortSignal): Promise<AppliedChange | null> {
    if (signal?.aborted || outcome.status !== 'decided' || outcome.accepted.length === 0) return null;
    if (outcome.changeId !== change.id) throw new Error('The review does not belong to this proposal.');
    const hunks = computeHunks(change.originalText, change.proposedText);
    const accepted = outcome.accepted.filter((i) => i >= 0 && i < hunks.length);
    if (!accepted.length) return null;
    const uri = change.uri;
    let after: string;
    const expected = change.isNewFile && accepted.length === hunks.length ? change.proposedText : applyHunks(change.originalText, hunks, accepted);
    const record = (text: string): AppliedChange => {
      const applied: AppliedChange = {
        id: change.id, runId: change.runId, relPath: change.relPath, uri,
        before: change.isNewFile ? null : change.originalText, after: text,
        hunksApplied: accepted.slice().sort((a, b) => a - b), hunksTotal: hunks.length, appliedAt: Date.now(), undone: false,
      };
      journal.record(applied);
      applyEmitter.fire(applied);
      return applied;
    };

    // A failed save must not strand an edit outside the undo journal. Restore only
    // our exact result, so a concurrent user edit is never overwritten by recovery.
    async function saveOrRecover(doc: vscode.TextDocument): Promise<void> {
      try {
        if (!await doc.save()) throw new Error('save returned false');
      } catch (error) {
        let restored = !change.isNewFile && doc.getText() === change.originalText;
        if (doc.getText() === expected) {
          try {
            const rollback = new vscode.WorkspaceEdit();
            if (change.isNewFile) rollback.deleteFile(uri);
            else rollback.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(expected.length)), change.originalText);
            restored = await vscode.workspace.applyEdit(rollback);
            if (!change.isNewFile) restored = restored && doc.getText() === change.originalText;
          } catch { /* retain a recovery record below */ }
        }
        if (!restored) {
          record(doc.getText());
          void vscode.window.showErrorMessage(`Anvil: saving ${change.relPath} failed. The remaining change is recorded in Changes; use Undo to recover.`);
        }
        throw new Error(`Could not save ${change.relPath}. ${restored ? 'The Anvil edit was rolled back.' : 'A recovery change remains in Changes; use Undo.'} (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    if (change.isNewFile) {
      const existing = await readCurrentText(uri);
      if (signal?.aborted) return null;
      if (existing !== null) throw new Error(`${change.relPath} already exists; refusing to overwrite it.`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      if (signal?.aborted) return null;
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { overwrite: false, contents: Buffer.from(expected, 'utf8') });
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected creating ${change.relPath}.`);
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) await saveOrRecover(doc);
      after = doc.getText();
    } else {
      const doc = await vscode.workspace.openTextDocument(uri); // open buffer if loaded, else disk
      if (signal?.aborted) return null;
      const current = doc.getText();
      if (current !== change.originalText) {
        throw new Error(`${change.relPath} changed since the proposal was made; nothing was applied.`);
      }
      const edit = new vscode.WorkspaceEdit();
      for (const e of hunkEdits(change.originalText, hunks, accepted)) {
        edit.replace(uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
      }
      if (signal?.aborted) return null;
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected the edit to ${change.relPath}.`);
      await saveOrRecover(doc);
      after = doc.getText(); // may differ from the plain result if format-on-save ran
    }

    const applied = record(after);
    log.info(`applied ${accepted.length}/${hunks.length} hunks to ${change.relPath}`);
    void vscode.window
      .showInformationMessage(`Applied ${accepted.length} of ${hunks.length} hunks to ${change.relPath}`, 'Undo')
      .then((choice) => { if (choice === 'Undo') void journal.undo(applied.id); });
    return applied;
  }

  ctx.subscriptions.push(...disposables);

  return {
    review,
    beginStreaming,
    apply,
    cancelRun,
    journal,
    onDidApply: applyEmitter.event,
  };
}
