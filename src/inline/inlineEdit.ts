import * as vscode from 'vscode';
import * as path from 'path';
import type { ContextEngine, RunHandle, ReviewService, TrueForgeService, UiEvent, ToolCallInfo, ApprovalDecision, SymbolDef } from '../shared/contracts';
import { APPROVAL_TOOLS } from '../shared/contracts';
import type { Logger } from '../shared/log';
import { extractCode, identifiers, reindent } from './extract';

export interface InlineEditDeps {
  trueforge: TrueForgeService;
  review: ReviewService;
  context: ContextEngine;
  workspaceRoot: string;
  log: Logger;
  trackRun(handle: RunHandle): vscode.Disposable;
}

let counter = 0;
const short = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function registerInlineEdit(ctx: vscode.ExtensionContext, deps: InlineEditDeps): vscode.Disposable {
  let running = false;
  const d = vscode.commands.registerCommand('anvil.inlineEdit', async () => {
    if (running) {
      void vscode.window.showInformationMessage('Anvil: an inline edit is already running. Press Esc to stop it.');
      return;
    }
    running = true;
    try {
      await runInline(deps);
    } catch (e) {
      deps.log.error('inline edit failed', e);
      void vscode.window.showErrorMessage(`Anvil inline edit failed: ${e instanceof Error ? e.message : String(e)}. No files were changed.`);
    } finally {
      running = false;
    }
  });
  ctx.subscriptions.push(d);
  return d;
}

function findDefinitions(deps: InlineEditDeps, selected: string, relPath: string, a: number, b: number): string {
  try {
    const out: string[] = [];
    const seen = new Set<string>();
    let chars = 0;
    for (const name of identifiers(selected)) {
      let defs: SymbolDef[] = [];
      defs = deps.context.findSymbol(name, 2);
      for (const def of defs) {
        if (def.path === relPath && def.startLine >= a && def.startLine <= b) continue;
        const line = `- ${def.signature}  (${def.path}:${def.startLine})`;
        if (seen.has(line)) continue;
        if (chars + line.length > 2400) return out.join('\n'); // ~600 tokens
        seen.add(line);
        out.push(line);
        chars += line.length + 1;
      }
    }
    return out.join('\n');
  } catch {
    return '';
  }
}

async function runInline(deps: InlineEditDeps): Promise<void> {
  const { review, trueforge, log } = deps;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Anvil: open a file and select some code first.');
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  let startLine = sel.start.line;
  let endLine = sel.end.line;
  if (!sel.isEmpty && sel.end.character === 0 && endLine > startLine) endLine--;
  endLine = Math.min(endLine, doc.lineCount - 1);

  const instruction = (
    await vscode.window.showInputBox({ title: 'Anvil: Edit selection', placeHolder: 'Describe the change…', ignoreFocusOut: true })
  )?.trim();
  if (!instruction) return;

  const original = doc.getText();
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  // The document may have changed while the input box was open; recompute against the live document.
  startLine = Math.min(startLine, doc.lineCount - 1);
  endLine = Math.min(Math.max(endLine, startLine), doc.lineCount - 1);
  const selStart = doc.offsetAt(new vscode.Position(startLine, 0));
  const selEnd = doc.offsetAt(doc.lineAt(endLine).range.end);
  const beforeText = original.slice(0, selStart);
  const afterText = original.slice(selEnd);
  const selectedText = original.slice(selStart, selEnd);
  const firstLine = doc.lineAt(startLine).text;
  const a = startLine + 1;
  const b = endLine + 1;

  const relRaw = path.relative(deps.workspaceRoot, doc.uri.fsPath).split(path.sep).join('/');
  const relPath = relRaw.startsWith('..') || path.isAbsolute(relRaw) ? path.basename(doc.uri.fsPath) : relRaw;
  const lang = doc.languageId;

  const lines = (from: number, to: number) => doc.getText(new vscode.Range(from, 0, to, 0)).replace(/\r\n/g, '\n').replace(/\n$/, '');
  const beforeCtx = lines(Math.max(0, startLine - 40), startLine);
  const afterCtx = endLine + 1 < doc.lineCount ? lines(endLine + 1, Math.min(doc.lineCount, endLine + 16)) : '';
  const defs = findDefinitions(deps, selectedText, relPath, a, b);

  const fence = (t: string) => '````\n' + t + '\n````';
  const prompt = [
    `File: ${relPath} (${lang}) — lines ${a}-${b} selected`,
    '',
    'Code before the selection:',
    beforeCtx ? fence(beforeCtx) : '(start of file)',
    '',
    `Selected code (lines ${a}-${b}):`,
    fence(selectedText.replace(/\r\n/g, '\n')),
    '',
    'Code after the selection:',
    afterCtx ? fence(afterCtx) : '(end of file)',
    ...(defs ? ['', 'Related definitions:', defs] : []),
    '',
    `Instruction: ${instruction}`,
    '',
    `Reply with the complete replacement for lines ${a}-${b} in one \`\`\`${lang} fenced block and nothing else.`,
  ].join('\n');

  const changeId = `inline-${Date.now().toString(36)}-${++counter}`;
  const base = {
    id: changeId, runId: `inline-run-${changeId}`, source: 'inline' as const, relPath, uri: doc.uri,
    originalText: original, isNewFile: false, title: instruction,
  };
  const stream = review.beginStreaming(base);

  const build = (code: string): string => {
    let c = code.replace(/\r\n/g, '\n');
    c = reindent(c, firstLine);
    c = c.replace(/\n+$/, ''); // the selection excludes its final newline; the surrounding text keeps its own
    if (eol === '\r\n') c = c.replace(/\n/g, '\r\n');
    return beforeText + c + afterText;
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  status.text = '$(loading~spin) Anvil: generating… (Esc to stop)';
  status.tooltip = 'Click to stop';
  status.command = 'anvil.cancel';
  status.show();

  const byThread = new Map<string, string>();
  const lastMsg = new Map<string, string>();
  const currentText = (): string => {
    if (byThread.has('main')) return byThread.get('main')!;
    return byThread.values().next().value ?? '';
  };

  const onEvent = (e: UiEvent): void => {
    if (e.type === 'text.delta') {
      const key = e.threadId === null || e.threadId === 'main' ? 'main' : e.threadId;
      let t = byThread.get(key) ?? '';
      if (lastMsg.get(key) !== undefined && lastMsg.get(key) !== e.messageId) t += '\n';
      lastMsg.set(key, e.messageId);
      byThread.set(key, t + e.text);
      const { code } = extractCode(currentText());
      stream.update(code.trim() === '' ? original : build(code));
    } else if (e.type === 'model.retry') {
      vscode.window.setStatusBarMessage(
        `Anvil: ${e.model} failed (${short(e.error, 60)}) — retry ${e.attempt}/${e.maxAttempts} in ${Math.round(e.delayMs / 100) / 10}s`, 8000);
    } else if (e.type === 'model.fallback') {
      const msg = `Anvil: primary model ${e.from} failed (${short(e.error, 80)}) — switched to ${e.to}`;
      vscode.window.setStatusBarMessage(msg, 8000);
      void vscode.window.showInformationMessage(msg);
    }
  };

  const onApproval = async (call: ToolCallInfo): Promise<ApprovalDecision> =>
    APPROVAL_TOOLS.includes(call.name) ? { status: 'deny', reason: 'inline edit is read-only' } : { status: 'allow' };

  let handle: RunHandle | undefined;
  let tracker: vscode.Disposable | undefined;
  try {
    handle = trueforge.startRun({ kind: 'inline', prompt, onEvent, onApproval });
    tracker = deps.trackRun(handle);
    let result;
    try {
      result = await handle.done;
    } catch (e) {
      result = { status: 'error' as const, text: '', model: '', error: e instanceof Error ? e.message : String(e), modelsTried: [] };
    }
    status.hide();

    if (result.status === 'cancelled') {
      stream.cancel();
      void vscode.window.showInformationMessage('Anvil: cancelled — no changes were made.');
      return;
    }
    if (result.status === 'error') {
      stream.cancel();
      void vscode.window.showErrorMessage(`Anvil inline edit failed: ${result.error ?? 'unknown error'}. No files were changed.`);
      return;
    }
    const text = currentText() || result.text || '';
    const { code } = extractCode(text);
    if (!code.trim()) {
      stream.cancel();
      void vscode.window.showWarningMessage('Anvil: the model returned no code. No files were changed.');
      return;
    }
    const finalProposed = build(code);
    const outcome = await stream.complete(finalProposed);
    if (outcome.status === 'cancelled' || outcome.accepted.length === 0) return;
    try {
      await review.apply(
        { ...base, runId: handle.runId, proposedText: finalProposed },
        outcome,
      );
    } catch (e) {
      log.error('inline apply failed', e);
      void vscode.window.showErrorMessage(`Anvil: could not apply the edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    status.dispose();
    tracker?.dispose();
  }
}
