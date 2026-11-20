import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const browser = process.env.ANVIL_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(browser)) throw new Error('Set ANVIL_CHROME to a Chrome/Chromium executable.');
const source = resolve(process.argv[2] || 'docs/submission/writeup.html');
const draft = !process.argv[3] && /FILL|DRAFT/.test(readFileSync(source, 'utf8'));
const output = resolve(process.argv[3] || resolve('.artifacts', draft ? 'anvil-writeup-DRAFT.pdf' : 'anvil-writeup.pdf'));
mkdirSync('.artifacts', { recursive: true });
const profile = mkdtempSync(resolve(tmpdir(), 'anvil-print-'));
const result = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--no-pdf-header-footer',
  `--user-data-dir=${profile}`, `--print-to-pdf=${output}`, pathToFileURL(source).href], { encoding: 'utf8', timeout: 45000 });
if (result.error || result.status !== 0 || !existsSync(output)) {
  throw new Error(`PDF export failed: ${result.error?.message || result.stderr?.trim() || `Chrome exit ${result.status}`}`);
}
console.log(`${draft ? 'DRAFT — complete team/model/timestamp fields before submission: ' : 'Exported: '}${output}`);
