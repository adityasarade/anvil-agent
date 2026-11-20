const vscode = require('vscode');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');

exports.run = async function () {
  const checks = [];
  const token = process.env.ANVIL_EDITOR_TOKEN;
  const resultPath = process.env.ANVIL_EDITOR_RESULT;
  const report = data => writeFileSync(resultPath, JSON.stringify({ token, editor: vscode.env.appName, version: vscode.version, checks, ...data }, null, 2));
  let uri;
  try {
    const extension = vscode.extensions.getExtension('team-anvil.anvil-agent');
    assert(extension, 'Development extension was not found');
    const { review, context } = await extension.activate();
    assert(review && context, 'Test-mode activation API missing');
    checks.push('activation');
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['anvil.inlineEdit', 'anvil.openPanel', 'anvil.cancel', 'anvil.review.acceptHunk', 'anvil.undoLastChange']) assert(commands.includes(name), name);
    await vscode.commands.executeCommand('anvil.openPanel');
    checks.push('panel and commands');
    uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `smoke-${token}.py`);
    const original = 'a = 1\n\n\nb = 2\n';
    const proposed = 'a = 10\n\n\nb = 20\n';
    await vscode.workspace.fs.writeFile(uri, Buffer.from(original));
    const change = { id: `smoke-${token}`, runId: `run-${token}`, source: 'agent', relPath: uri.path.split('/').pop(), uri, originalText: original, proposedText: proposed, isNewFile: false };
    const deciding = review.review(change);
    // Review commands work even before the tab finishes opening; wait for the actual
    // preview so we also validate virtual document rendering in the real editor.
    const end = Date.now() + 10000;
    while (vscode.window.activeTextEditor?.document.uri.scheme !== 'anvil-review') {
      if (Date.now() > end) throw new Error('Review preview did not open');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const preview = vscode.window.activeTextEditor.document;
    assert(preview.getText().includes('a = 10'));
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', preview.uri);
    assert(lenses.some(lens => lens.command?.command === 'anvil.review.acceptHunk'), 'Per-hunk CodeLens missing');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), original, 'Preview wrote to disk');
    await vscode.commands.executeCommand('anvil.review.acceptHunk', { changeId: change.id, index: 0 });
    await vscode.commands.executeCommand('anvil.review.rejectHunk', { changeId: change.id, index: 1 });
    const outcome = await deciding;
    assert.deepEqual(outcome.accepted, [0]);
    const applied = await review.apply(change, outcome);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), 'a = 10\n\n\nb = 2\n');
    checks.push('preview, CodeLens, partial acceptance and save');
    assert(await review.journal.undo(applied.id));
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), original);
    checks.push('undo');
    const controller = new AbortController();
    controller.abort();
    assert.equal(await review.apply(change, outcome, controller.signal), null);
    checks.push('cancel before application');
    const live = review.beginStreaming({ ...change, id: `stream-${token}` });
    live.update(proposed);
    live.cancel();
    assert.equal((await live.done).status, 'cancelled');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), original);
    checks.push('streaming review cancellation');
    report({ status: 'passed' });
  } catch (error) {
    report({ status: 'failed', error: error.stack || String(error) });
    throw error;
  } finally {
    if (uri) await vscode.workspace.fs.delete(uri).then(() => {}, () => {});
  }
};
