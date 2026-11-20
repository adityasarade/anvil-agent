// Opt-in live model rehearsal. Runs in an isolated editor profile and Flask
// fixture. The test supplies the exact prompt; actual TrueForge models decide edits.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const inlinePrompt = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const agentPrompt = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

exports.run = async function () {
  const task = process.env.ANVIL_LIVE_TASK;
  const checks = [];
  const events = [];
  let timer;
  let deadline;
  let api;
  let configuration;
  let previousModels;
  const extension = vscode.extensions.getExtension('team-anvil.anvil-agent');
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const python = path.join(root, '.venv/bin/python');
  const saveReport = data => fs.writeFileSync(process.env.ANVIL_EDITOR_RESULT, JSON.stringify({
    token: process.env.ANVIL_EDITOR_TOKEN, task, editor: vscode.env.appName, version: vscode.version, checks,
    events, ...data,
  }, null, 2));
  function verify(which) {
    const result = spawnSync(python, [path.join(extension.extensionPath, 'scripts/demo/verify-flask.py'), which, '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    checks.push(result.stdout.trim());
  }
  try {
    assert(fs.existsSync(python), 'Prepare the pinned Flask fixture before live rehearsal');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim(), '', 'Use a clean fixture; existing work was left untouched');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    assert.equal(head.stdout.trim(), '22d924701a6ae2e4cd01e9a15bbaf3946094af65', 'Wrong Flask revision');
    api = await extension.activate();
    deadline = setTimeout(() => void vscode.commands.executeCommand('anvil.cancel'), 18 * 60_000);
    configuration = vscode.workspace.getConfiguration('anvil');
    previousModels = configuration.get('models', []);
    if (process.env.ANVIL_LIVE_COMPACT === '1') {
      await configuration.update('agents.inline', 'anvil-inline-direct', vscode.ConfigurationTarget.Global);
      await configuration.update('context.budgetTokens', 1000, vscode.ConfigurationTarget.Global);
      await configuration.update('context.repoMapTokens', 400, vscode.ConfigurationTarget.Global);
      await configuration.update('context.compactionTokens', 3500, vscode.ConfigurationTarget.Global);
      await configuration.update('modelParams', { 'groq/qwen3-8-27b': { max_tokens: 1536, reasoning_effort: 'none' } }, vscode.ConfigurationTarget.Global);
    }
    const normalModels = JSON.parse(process.env.ANVIL_LIVE_MODELS || '["google-gemini/gemini-flash-lite-latest","groq/gpt-oss-120b","google-gemini/gemini-flash-latest"]');
    const models = task === 'C' ? ['anvil-demo-failure/unreachable', ...normalModels] : normalModels;
    await configuration.update('models', models, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('anvil.reconnect');
    await vscode.commands.executeCommand('anvil.openPanel');
    // Automate the same CodeLens commands the reviewer uses. Streaming previews
    // expose no accept command, so they cannot be accepted before completion.
    let deciding = false;
    timer = setInterval(async () => {
      if (deciding) return;
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== 'anvil-review') return;
      deciding = true;
      try {
        const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', editor.document.uri);
        const command = lenses?.find(lens => lens.command?.command === (task === 'C' ? 'anvil.review.rejectAll' : 'anvil.review.acceptAll'))?.command;
        if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
      } finally { deciding = false; }
    }, 100);
    const onEvent = event => {
      events.push(event);
      if (['run.started', 'run.done', 'model.retry', 'model.fallback', 'tool.result', 'context.selected', 'subagent.done'].includes(event.type)) saveReport({ status: 'running' });
    };
    if (task === 'B') {
      const handle = await api.runAgent(agentPrompt, onEvent);
      const result = await handle.done;
      assert.equal(result.status, 'done', result.error || 'Agent did not finish');
      assert(events.some(event => event.type === 'text.delta'), 'No streaming events');
      const sessionId = handle.sessionId;
      assert(sessionId, 'No TrueForge session');
      checks.push(`TrueForge session: ${api.trueforge.sessionUrl(sessionId)}`);
      verify('B');
    } else {
      const uri = vscode.Uri.file(path.join(root, 'src/flask/helpers.py'));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);
      const lines = document.getText().split(/\r?\n/);
      const start = lines.findIndex(line => line.startsWith('def get_debug_flag('));
      const end = lines.findIndex((line, index) => index > start && line.startsWith('def ')) - 1;
      assert(start >= 0 && end > start, 'Could not select get_debug_flag');
      let last = end;
      while (!lines[last].trim()) last--;
      editor.selection = new vscode.Selection(start, 0, last, lines[last].length);
      await api.inlineEdit(inlinePrompt, onEvent);
      const done = events.filter(event => event.type === 'run.done').at(-1);
      assert.equal(done?.status, 'done', done?.error || 'Inline generation did not finish');
      assert(events.some(event => event.type === 'text.delta'), 'No streaming events');
      if (task === 'A') {
        verify('A');
        const change = api.review.journal.list().filter(item => !item.undone).at(-1);
        assert(change, 'Inline edit was not applied');
        assert(await api.review.journal.undo(change.id), 'Undo failed');
        verify('C');
        checks.push('Task A applied and verified, then undone to restore clean fixture');
      } else {
        assert(events.some(event => event.type === 'model.fallback' && event.from === 'anvil-demo-failure/unreachable'), 'No automatic fallback from the broken provider');
        assert(events.some(event => event.type === 'model.retry'), 'No visible retry/backoff');
        assert.equal(api.review.journal.list().length, 0, 'Rejected proposal unexpectedly applied');
        verify('C');
        checks.push('Primary failed, retries and fallback succeeded, proposal rejected');
      }
    }
    saveReport({ status: 'passed' });
  } catch (error) {
    await vscode.commands.executeCommand('anvil.cancel');
    saveReport({ status: 'failed', error: error.stack || String(error) });
    throw error;
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    if (configuration && previousModels) {
      await configuration.update('models', previousModels, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('anvil.reconnect');
    }
  }
};
