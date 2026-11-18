/**
 * Builds the user message for an agent-panel turn: the user's request plus the
 * context Anvil attaches before the agent starts exploring on its own:
 *   level 0 - a ranked repository map (first turn of a session only),
 *   level 1 - explicit @file / @symbol mentions, resolved to code or outlines.
 * Automatic retrieval (level 2) happens inside the agent loop through the
 * retrieve_context MCP tool, so the model decides when it needs more.
 */
import type { ContextEngine, Mention } from '../shared/contracts';
import { estimateTokens } from '../context';

export interface BuiltPrompt {
  content: string;
  /** Short description of what was attached, for the panel ("repo map 1.1k tok · @src/flask/cli.py"). */
  attachedSummary: string;
  attachedTokens: number;
}

const MENTION_FILE_FULL_TOKENS = 1500;
const MENTION_SYMBOL_TOKENS = 1500;

export function buildAgentPrompt(opts: {
  text: string;
  mentions: Mention[];
  context: ContextEngine;
  firstTurn: boolean;
  repoMapTokens: number;
}): BuiltPrompt {
  const { context } = opts;
  const parts: string[] = [];
  const summary: string[] = [];
  let attachedTokens = 0;

  const mentions = dedupeMentions([...opts.mentions, ...parseInlineMentions(opts.text, context)]);
  const mentionedPaths: string[] = [];

  for (const m of mentions) {
    if (m.kind === 'file') {
      const text = context.fileText(m.value);
      if (text === undefined) continue;
      mentionedPaths.push(m.value);
      const tokens = estimateTokens(text);
      if (tokens <= MENTION_FILE_FULL_TOKENS) {
        parts.push(`<mentioned-file path="${m.value}" mode="full">\n${numbered(text, 1)}\n</mentioned-file>`);
        attachedTokens += tokens;
      } else {
        const outline = context.repoMap({ budgetTokens: 600, focusPaths: [m.value] });
        parts.push(
          `<mentioned-file path="${m.value}" mode="outline" note="file is ${tokens} tokens; read exact ranges with read_file">\n${outline}\n</mentioned-file>`,
        );
        attachedTokens += estimateTokens(outline);
      }
      summary.push(`@${m.value}`);
    } else {
      const def = context.findSymbol(m.value, 1)[0];
      if (!def) continue;
      const fileText = context.fileText(def.path) ?? '';
      const lines = fileText.split(/\r?\n/).slice(def.startLine - 1, def.endLine);
      let body = lines.join('\n');
      if (estimateTokens(body) > MENTION_SYMBOL_TOKENS) {
        body = lines.slice(0, 60).join('\n') + '\n# … truncated; use read_file for the rest';
      }
      parts.push(
        `<mentioned-symbol name="${def.qualifiedName}" kind="${def.kind}" path="${def.path}" lines="${def.startLine}-${def.endLine}">\n${numbered(body, def.startLine)}\n</mentioned-symbol>`,
      );
      attachedTokens += estimateTokens(body);
      summary.push(`@${m.value}`);
    }
  }

  if (opts.firstTurn && opts.repoMapTokens > 0) {
    const map = context.repoMap({ budgetTokens: opts.repoMapTokens, focusPaths: mentionedPaths, query: opts.text });
    if (map.trim()) {
      parts.unshift(
        `<repository-map note="ranked outline from Anvil's context engine; not the full code - use retrieve_context, search_code and read_file to look closer">\n${map}\n</repository-map>`,
      );
      const t = estimateTokens(map);
      attachedTokens += t;
      summary.unshift(`repo map ${formatK(t)} tok`);
    }
  }

  const content = parts.length
    ? `${opts.text}\n\n<attached-context>\n${parts.join('\n\n')}\n</attached-context>`
    : opts.text;
  return { content, attachedSummary: summary.join(' · '), attachedTokens };
}

/** Picks up "@path/to/file.py" or "@symbol" typed by hand (not chosen from the popup). */
function parseInlineMentions(text: string, context: ContextEngine): Mention[] {
  const out: Mention[] = [];
  for (const match of text.matchAll(/(^|\s)@([\w./-]+)/g)) {
    const value = match[2].replace(/[.,;:]+$/, '');
    if (context.fileText(value) !== undefined) out.push({ kind: 'file', value });
    else if (context.findSymbol(value, 1)[0]?.name === value) out.push({ kind: 'symbol', value });
  }
  return out;
}

function dedupeMentions(ms: Mention[]): Mention[] {
  const seen = new Set<string>();
  return ms.filter((m) => {
    const k = `${m.kind}:${m.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function numbered(text: string, start: number): string {
  return text
    .split(/\r?\n/)
    .map((l, i) => `${String(start + i).padStart(5)}| ${l}`)
    .join('\n');
}

export function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
