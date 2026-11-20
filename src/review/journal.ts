import * as vscode from 'vscode';
import type { AppliedChange, ChangeJournal } from '../shared/contracts';
import type { Logger } from '../shared/log';

/** Current text: loaded document (possibly dirty) first, else disk; null if the file does not exist. */
export async function readCurrentText(uri: vscode.Uri): Promise<string | null> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

export interface JournalImpl extends ChangeJournal {
  record(change: AppliedChange): void;
  dispose(): void;
}

export function createJournal(log: Logger): JournalImpl {
  const changes: AppliedChange[] = [];
  const emitter = new vscode.EventEmitter<void>();

  async function undo(changeId: string): Promise<boolean> {
    const c = changes.find((x) => x.id === changeId);
    if (!c || c.undone) return false;
    try {
      const current = await readCurrentText(c.uri);
      if (current !== c.after) {
        void vscode.window.showWarningMessage(
          `Anvil: can't undo the change to ${c.relPath} because the file was modified after it was applied. Nothing was changed.`,
        );
        return false;
      }
      if (c.before === null) {
        const edit = new vscode.WorkspaceEdit();
        edit.deleteFile(c.uri, { ignoreIfNotExists: true });
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('could not delete file');
      } else {
        const doc = await vscode.workspace.openTextDocument(c.uri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(c.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), c.before);
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('edit was rejected');
        try {
          if (!(await doc.save())) throw new Error(`Could not save ${c.relPath}`);
        } catch (error) {
          // Keep a failed undo retryable without overwriting concurrent user edits.
          if (doc.getText() === c.before) {
            const rollback = new vscode.WorkspaceEdit();
            rollback.replace(c.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(c.before.length)), c.after);
            await vscode.workspace.applyEdit(rollback);
          }
          throw error;
        }
      }
      c.undone = true;
      emitter.fire();
      log.info(`undone change ${c.id} (${c.relPath})`);
      return true;
    } catch (e) {
      log.error('undo failed', e);
      void vscode.window.showErrorMessage(`Anvil: undo failed for ${c.relPath}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  return {
    list: () => changes.slice(),
    undo,
    async undoRun(runId) {
      let n = 0;
      for (const c of changes.filter((x) => x.runId === runId && !x.undone).reverse()) {
        if (await undo(c.id)) n++;
      }
      return n;
    },
    onDidChange: emitter.event,
    record(change) {
      changes.push(change);
      emitter.fire();
    },
    dispose() {
      emitter.dispose();
    },
  };
}
