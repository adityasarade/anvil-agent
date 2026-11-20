import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createContextEngine, estimateTokens, formatRetrieval } from '../src/context';
import { parseFile } from '../src/context/parse';
import { Catalog } from '../src/context/rank';
import { retrieve } from '../src/context/retrieve';
import type { RetrievalResult } from '../src/shared/contracts';

const taskB = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const flask = resolve(process.env.ANVIL_FLASK_ROOT || '.demo/flask');
if (process.env.ANVIL_REQUIRE_INTEGRATION === '1' && !existsSync(join(flask, 'src/flask/helpers.py'))) {
  throw new Error(`Pinned Flask fixture missing at ${flask}. Run npm run demo:prepare.`);
}

describe.skipIf(!existsSync(flask))('Flask context index', () => {
  const engine = createContextEngine({ root: flask });
  let task: RetrievalResult;
  beforeAll(async () => {
    const stats = await engine.build();
    console.log(`Flask: ${stats.files} files, ${stats.symbols} symbols, ${stats.chunks} chunks in ${stats.buildMs.toFixed(1)} ms`);
    task = engine.retrieve(taskB, { budgetTokens: 4000 });
    console.log(task.strategy, task.usedTokens + '/' + task.budgetTokens + ' tokens, ' + task.elapsedMs.toFixed(1) + ' ms');
    for (const f of task.files) console.log(f.path, f.score.toFixed(1), f.reasons.join('; '));
  });
  it('builds within the indexing deadline', () => { expect(engine.stats().buildMs).toBeLessThan(2000); });
  it('surfaces implementation, paired tests and documentation in the first five files', () => {
    const paths = task.files.slice(0, 5).map(f => f.path);
    expect(paths).toEqual(expect.arrayContaining(['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']));
    expect(task.usedTokens).toBeLessThanOrEqual(4000);
    expect(task.elapsedMs).toBeLessThan(100);
    for (const f of task.files) expect(f.reasons.some(r => /matched:|defines |test pair of|imports |imported by|docs section/.test(r))).toBe(true);
    expect(task.files[0].spans.some(s => s.text.includes('add_command'))).toBe(true);
  });
  it('places the mentioned file first and selects the flag implementation', () => {
    const result = engine.retrieve("Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.", { mentionedPaths: ['src/flask/helpers.py'] });
    const [file] = result.files;
    const [def] = engine.findSymbol('get_debug_flag');
    expect(file.path).toBe('src/flask/helpers.py');
    expect(file.reasons).toContain('mentioned by the user');
    expect(file.spans.some(s => s.startLine <= def.startLine && s.endLine >= def.endLine)).toBe(true);
  });
  it('finds definitions with inclusive source line ranges', () => {
    const [flag] = engine.findSymbol('get_debug_flag');
    expect(flag.path).toBe('src/flask/helpers.py');
    const lines = engine.fileText(flag.path)!.split('\n');
    expect(flag.startLine).toBe(lines.findIndex(s => s.startsWith('def get_debug_flag(')) + 1);
    expect(flag.endLine).toBe(lines.findIndex(s => s.includes('val.lower()') && s.trim().startsWith('return')) + 1);
    expect(engine.findSymbol('FlaskGroup')[0]).toMatchObject({ path: 'src/flask/cli.py', kind: 'class' });
  });
  it('renders every file and numbers the actual source lines within the transport cap', () => {
    const text = formatRetrieval(task);
    expect(text.length).toBeLessThan(Math.min(20000, 4 * task.budgetTokens));
    expect(estimateTokens(text)).toBe(task.usedTokens);
    for (const file of task.files) expect(text).toContain('## ' + file.path);
    expect(text).toMatch(/L\d+-\d+ \[code\]\n`{3,}\n *\d+\| /);
    expect(text).toContain('Omitted:');
    expect(text).toMatch(/Read exact ranges with read_file before editing\.$/);
    for (const budgetTokens of [0, 10, 90, 250, 1000, 50000]) {
      const res = engine.retrieve('FlaskGroup', { budgetTokens });
      const formatted = formatRetrieval(res);
      expect(formatted.length).toBeLessThanOrEqual(Math.max(0, Math.min(19999, 4 * budgetTokens - 1)));
      expect(res.usedTokens).toBeLessThanOrEqual(budgetTokens);
      for (const f of res.files) expect(formatted).toContain(f.path);
    }
  });
});

it('parses decorated classes, async methods, continuations and nested declarations', () => {
  const source = [
    'LIMIT = (', '    12', ')', '', '@outer(', '    "class",', ')', 'class Widget:',
    '    @wrap', '    async def render(', '        self, value: str,', '    ) -> str:',
    '        """Example:', 'def fake():', '        """', '        def normalize():',
    '            return value.strip()', '        return normalize()', '', '    class Inner:',
    '        def ping(self):', '            pass', '', 'def finish():', '    pass', ''
  ].join('\n');
  const { symbols, chunks } = parseFile('widget.py', source);
  expect(symbols.map(s => [s.qualifiedName, s.kind, s.startLine, s.endLine])).toEqual([
    ['LIMIT', 'variable', 1, 3], ['Widget', 'class', 5, 22], ['Widget.render', 'method', 9, 18],
    ['Widget.render.normalize', 'function', 16, 17], ['Widget.Inner', 'class', 20, 22],
    ['Widget.Inner.ping', 'method', 21, 22], ['finish', 'function', 24, 25]
  ]);
  expect(chunks.every(c => estimateTokens(c.text) <= 400)).toBe(true);
});

it('ranks rare terms and boosted symbol fields above incidental body matches', () => {
  const source = [
    parseFile('parser.py', 'def decode_invoice():\n    return 0'),
    parseFile('notes.txt', 'decode_invoice sometimes appears here'),
    parseFile('unrelated.txt', 'decode and decode again')
  ];
  const catalog = new Catalog(new Map(source.map(f => [f.path, f])));
  expect(catalog.rank('invoice').map(c => c.file.path)).toEqual(['parser.py', 'notes.txt', 'unrelated.txt']);
  expect(catalog.rank('decode_invoice')[0].reasons).toContain('defines decode_invoice');
});

it('keeps graph, stats, search and map consistent across incremental changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anvil-context-'));
  try {
    await mkdir(join(root, 'pkg'));
    await Promise.all(Object.entries({
      'pkg/__init__.py': '', 'pkg/a.py': 'from . import b\n\ndef caller():\n    return b.ident()',
      'pkg/b.py': 'def ident():\n    return 42', 'test_b.py': 'from pkg.b import ident',
      '.gitignore': 'private*.py\n', 'private1.py': 'secret', 'binary.txt': '\0data',
      'guide.rst': 'Identity\n========\nA section about ident.'
    }).map(([p, t]) => writeFile(join(root, p), t)));
    const engine = createContextEngine({ root });
    await engine.build();
    expect(engine.listFiles('**/?.py')).toEqual(['pkg/a.py', 'pkg/b.py']);
    expect(engine.stats().files).toBe(5);
    expect(engine.findSymbol('Identity')[0].kind).toBe('heading');
    expect(engine.searchText('IDENT()', { glob: '*.py' })[0]).toMatchObject({ path: 'pkg/a.py', line: 4 });
    expect(engine.searchText('^def.*ident', { regex: true })).toHaveLength(1);
    expect(engine.suggest('iden').some(s => s.kind === 'symbol' && s.value === 'ident')).toBe(true);
    const r = engine.retrieve('ident', { mentionedPaths: ['pkg/b.py'] });
    expect(r.files.find(f => f.path === 'pkg/a.py')?.reasons).toContain('imports pkg/b.py');
    expect(r.files.find(f => f.path === 'test_b.py')?.reasons).toContain('test pair of pkg/b.py');
    expect(engine.repoMap({ budgetTokens: 20, focusPaths: ['pkg/b.py'] })).toMatch(/^pkg\/b.py\n +1\| def ident/);
    const before = engine.stats().symbols;
    await writeFile(join(root, 'pkg/b.py'), 'def renamed():\n    return 0');
    await engine.refreshFile('pkg/b.py');
    expect(engine.findSymbol('ident').some(s => s.name === 'ident')).toBe(false);
    expect(engine.stats().symbols).toBe(before);
    engine.removeFile('pkg/b.py');
    expect(engine.stats().files).toBe(4);
    expect(engine.fileText('pkg/b.py')).toBeUndefined();
    expect(engine.retrieve('renamed').files).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reserves a numbered signature when a full mentioned definition exceeds the budget', () => {
  const body = Array.from({ length: 35 }, (_, i) => '    widget.step(' + i + ')').join('\n');
  const source = ['one.py', 'two.py'].map(p => parseFile(p, '@decorator\ndef widget():\n' + body));
  const catalog = new Catalog(new Map(source.map(f => [f.path, f])));
  const stats = { files: 2, symbols: 2, chunks: 2, totalTokens: 500, builtAt: 0, buildMs: 0 };
  const result = retrieve(catalog, stats, 'widget', { budgetTokens: 120, maxFiles: 1, mentionedPaths: ['two.py'] });
  expect(result.files.map(f => f.path)).toEqual(['two.py']);
  expect(result.files[0].spans[0]).toMatchObject({ mode: 'outline', startLine: 2, endLine: 2, text: 'def widget():' });
  expect(result.omitted).toContainEqual(expect.objectContaining({ path: 'one.py', reason: 'maxFiles limit (1)' }));
  expect(formatRetrieval(result)).toMatch(/L2-2 \[outline\][\s\S]*2\| def widget/);
  expect(result.usedTokens).toBeLessThanOrEqual(120);
});

it('uses BM25 document frequency and term saturation on bare text', () => {
  const texts = ['common common common common', 'common isotope isotope', 'common dust', 'common dust dust dust'];
  const files = texts.map((text, n) => parseFile(n + '.txt', text));
  const catalog = new Catalog(new Map(files.map(f => [f.path, f])));
  const result = catalog.rank('common isotope');
  expect(result[0].file.path).toBe('1.txt');
  expect(result[1].file.path).toBe('0.txt');
  expect(result[0].score).toBeGreaterThan(result[1].score);
});
