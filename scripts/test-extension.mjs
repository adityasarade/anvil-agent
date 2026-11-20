import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const task = process.env.ANVIL_LIVE_TASK;
const label = process.env.ANVIL_LIVE_LABEL || task;
if (label && !/^[A-Za-z0-9-]+$/.test(label)) throw new Error('ANVIL_LIVE_LABEL may contain only letters, digits, and hyphens.');
if (process.env.npm_lifecycle_event === 'test:live' && !task) throw new Error('Choose a task: ANVIL_LIVE_TASK=A|B|C npm run test:live');
if (task && !['A', 'B', 'C'].includes(task)) throw new Error('ANVIL_LIVE_TASK must be A, B, or C.');
const candidates = [process.env.ANVIL_EDITOR_CLI,
  '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
].filter(Boolean);
const cli = candidates.find(existsSync);
if (!cli) throw new Error('Set ANVIL_EDITOR_CLI to the absolute path of a VS Code-compatible editor CLI.');
const workspace = task ? resolve(process.env.ANVIL_FLASK_ROOT || (task === 'C' ? '.demo/flask-resilience' : '.demo/flask')) : resolve('.artifacts/editor-workspace');
mkdirSync(workspace, { recursive: true });
const resultFile = resolve(task ? `.artifacts/live-${label}-result.json` : '.artifacts/editor-result.json');
const token = `${Date.now()}-${process.pid}`;
const child = spawn(cli, [
  '--new-window', '--wait', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  '--user-data-dir', resolve(task ? `.artifacts/live-${label}-profile` : '.artifacts/editor-profile'),
  '--extensions-dir', resolve('.artifacts/editor-extensions'),
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${resolve(task ? 'extension-test/live.cjs' : 'extension-test/smoke.cjs')}`, workspace,
], { stdio: 'inherit', env: { ...process.env, ANVIL_EDITOR_RESULT: resultFile, ANVIL_EDITOR_TOKEN: token } });
const timeoutMs = task ? 20 * 60_000 : 120_000;
const timeout = setTimeout(() => { child.kill(); console.error(`Editor test timed out after ${timeoutMs / 1000} seconds.`); process.exitCode = 1; }, timeoutMs);
child.once('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
child.once('exit', code => {
  clearTimeout(timeout);
  let result;
  try { result = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* missing report fails below */ }
  if (code !== 0 || result?.token !== token || result?.status !== 'passed') {
    console.error('Editor smoke test failed:', result?.error || `exit ${code}; no matching successful report`);
    process.exitCode = 1;
  } else console.log(`Editor smoke test passed in ${result.editor} ${result.version}: ${result.checks.join(', ')}`);
});
