import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mode = process.argv[2];
const env = { ...process.env };
if (mode === 'submission' && process.argv[3]) env.ANVIL_FLASK_ROOT = resolve(process.argv[3]);
const vitest = ['node_modules/vitest/vitest.mjs', 'run'];
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
switch (mode) {
  case 'unit':
    run(process.execPath, [...vitest, '--exclude', 'test/trueforge.e2e.test.ts', '--exclude', 'test/mcp.test.ts']);
    break;
  case 'integration':
    env.ANVIL_REQUIRE_INTEGRATION = '1';
    run(process.execPath, [...vitest, 'test/mcp.test.ts', 'test/trueforge.e2e.test.ts']);
    break;
  case 'flask':
    env.ANVIL_REQUIRE_INTEGRATION = '1';
    run(process.execPath, [...vitest, 'test/context.test.ts']);
    break;
  case 'submission': {
    env.ANVIL_REQUIRE_INTEGRATION = '1';
    mkdirSync('.artifacts', { recursive: true });
    writeFileSync('.artifacts/verification.json', JSON.stringify({ startedAt: new Date().toISOString(), automated: 'running or interrupted' }, null, 2));
    const flask = resolve(env.ANVIL_FLASK_ROOT || '.demo/flask');
    if (!existsSync(resolve(flask, 'src/flask/helpers.py'))) throw new Error('Run npm run demo:prepare first.');
    const status = spawnSync('git', ['-C', flask, 'status', '--porcelain'], { encoding: 'utf8' });
    if (status.status !== 0 || status.stdout.trim()) throw new Error('Use an unchanged pinned Flask fixture for submission checks. Set ANVIL_FLASK_ROOT to a separate fixture if your demo has changes.');
    const head = spawnSync('git', ['-C', flask, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.stdout.trim() !== '22d924701a6ae2e4cd01e9a15bbaf3946094af65') throw new Error('Flask fixture is not at the official pinned commit.');
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.']);
    run(process.execPath, [...vitest]);
    run('npm', ['run', 'package']);
    run(process.execPath, ['scripts/test-extension.mjs']);
    writeFileSync('.artifacts/verification.json', JSON.stringify({
      verifiedAt: new Date().toISOString(), automated: 'passed',
      editor: JSON.parse((await import('node:fs')).readFileSync('.artifacts/editor-result.json', 'utf8')),
      realModelRehearsal: 'Requires separate live A/B/C evidence; automated scripted models do not prove task completion.',
    }, null, 2));
    break;
  }
  default: throw new Error(`Unknown check mode: ${mode}`);
}
