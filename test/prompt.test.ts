import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createContextEngine } from '../src/context';
import { buildAgentPrompt } from '../src/host/prompt';

it('attaches typed and selected mentions once, with a first-turn map and exact symbol location', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anvil-mentions-'));
  try {
    await writeFile(join(root, 'app.py'), 'def greet():\n    return "hello"\n');
    const context = createContextEngine({ root });
    await context.build();
    const built = buildAgentPrompt({ text: 'Change @app.py and @greet', mentions: [{ kind: 'file', value: 'app.py' }], context, firstTurn: true, repoMapTokens: 200 });
    expect(built.content.match(/<mentioned-file /g)).toHaveLength(1);
    expect(built.content).toContain('<repository-map');
    expect(built.content).toContain('<mentioned-symbol name="greet" kind="function" path="app.py" lines="1-2">');
    expect(built.content).toContain('2|     return "hello"');
    expect(built.attachedTokens).toBeGreaterThan(0);
    const followup = buildAgentPrompt({ text: 'Now @greet', mentions: [], context, firstTurn: false, repoMapTokens: 200 });
    expect(followup.content).not.toContain('<repository-map');
    expect(followup.content).toContain('<mentioned-symbol');
  } finally { await rm(root, { recursive: true, force: true }); }
});
