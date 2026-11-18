import type { IndexStats, RetrieveOptions, RetrievedFile, RetrievedSpan, RetrievalResult } from '../shared/contracts';
import { estimateTokens, type Source } from './parse';
import { type Candidate, type Hit, Catalog } from './rank';

const hint = 'Read exact ranges with read_file before editing.';
const maxChars = (budget: number) => Math.max(0, Math.min(19999, Math.ceil(budget * 4) - 1));
const strategy = (chunks: number, budget: number, files: number, omitted: number) =>
  budget < 35 ? 'BM25F' : budget < 100 ? `BM25F + symbols + graph; ${files} selected, ${omitted} omitted` :
  `BM25F over ${chunks.toLocaleString('en-US')} chunks + symbol match + 1-hop import graph + test/docs pairing; budget ${budget.toLocaleString('en-US')} tok; ${files} files selected, ${omitted} omitted`;

function renderSpan(span: RetrievedSpan) {
  const fence = '`'.repeat(Math.max(3, ...(span.text.match(/`+/g) ?? []).map(m => m.length + 1)));
  const lines = span.text.split('\n').map((line, i) => String(span.startLine + i).padStart(4) + '| ' + line);
  return `L${span.startLine}-${span.endLine} [${span.mode}]\n${fence}\n${lines.join('\n')}\n${fence}`;
}

function title(f: RetrievedFile) {
  return `## ${f.path}  (${f.score.toFixed(1)}, ${f.reasons.join('; ')})`;
}

function format(result: RetrievalResult, limit: number) {
  const header = result.strategy + ' | ' + result.usedTokens + '/' + result.budgetTokens + ' tokens';
  const blocks = result.files.map(f => [title(f), ...f.spans.map(renderSpan)].join('\n'));
  const prefix = [header, ...blocks, 'Omitted:'].join('\n');
  const footer = '\n' + hint;
  let room = limit - prefix.length - footer.length;
  if (room < 0) {
    // Very small budgets may not hold even the fixed header and closing hint.
    return [header, ...result.files.map(f => f.path), hint].join('\n').slice(0, limit);
  }
  const omissions: string[] = [];
  for (const o of result.omitted) {
    const item = '\n- ' + o.path + ' — ' + o.reason;
    if (item.length > room || omissions.length >= 5) break;
    omissions.push(item);
    room -= item.length;
  }
  const remaining = result.omitted.length - omissions.length;
  const tail = remaining ? '\n… ' + remaining + ' more' : result.omitted.length ? '' : ' none';
  return prefix + omissions.join('') + (room >= tail.length ? tail : '') + footer;
}

export function formatRetrieval(result: RetrievalResult): string {
  return format(result, Math.min(maxChars(result.budgetTokens), Math.floor(result.budgetTokens * 3.8)));
}

function excerpt(hit: Hit, file: Source, outline: boolean): RetrievedSpan {
  const c = hit.chunk;
  const d = c.owner;
  const startLine = outline && d ? d.signatureLine : c.start;
  let endLine = outline ? (d?.signatureEndLine ?? startLine) : c.end;
  let text = c.text;
  if (outline) {
    text = file.lines.slice(startLine - 1, endLine).join('\n');
    if (text.length > 220) {
      endLine = startLine;
      text = file.lines[startLine - 1].slice(0, 217) + '…';
    }
  }
  return { startLine, endLine, symbol: d?.qualifiedName, text, mode: outline ? 'outline' : 'code', tokens: estimateTokens(text) };
}

export function retrieve(catalog: Catalog, stats: IndexStats, query: string, opts: RetrieveOptions = {}): RetrievalResult {
  const start = performance.now();
  const budget = Math.max(0, Math.floor(opts.budgetTokens ?? 4000));
  const maxFiles = Math.max(0, Math.floor(opts.maxFiles ?? 8));
  const mentioned = [...new Set(opts.mentionedPaths ?? [])];
  const ranked = catalog.rank(query, mentioned);
  const result: RetrievalResult = { query, budgetTokens: budget, usedTokens: 0, files: [], omitted: [],
    strategy: '', elapsedMs: 0, indexStats: stats };
  const preferred = new Set<Candidate>();
  function prefer(c?: Candidate) { if (c) preferred.add(c); }
  for (const p of mentioned) {
    const c = ranked.find(item => item.file.path === p);
    if (c) prefer(c);
    else result.omitted.push({ path: p, score: 0, reason: 'mentioned path is outside the index' });
  }
  if (/\b(?:add|implement|fix|change|update|refactor)\b/i.test(query)) {
    prefer(ranked.find(c => c.score > 0 && !c.file.doc && !c.file.test));
  }
  if (/\btests?(?:ed|ing)?\b/i.test(query)) prefer(ranked.find(c => c.file.test && c.score > 0));
  if (/\b(?:docs?|document(?:s|ed|ation|ing)?)\b/i.test(query)) prefer(ranked.find(c => c.file.doc && c.score > 0));
  const cutoff = (ranked[0]?.score ?? 0) * 0.12;
  const candidates = [...new Set([...preferred, ...ranked.filter(c => c.score > 0)])];
  // Charge the rendered envelope, fences and line numbers against the same
  // budget as the code. Reserve limited space for the highest-ranked omissions.
  const limit = Math.min(maxChars(budget), Math.floor(budget * 3.8));
  let room = limit - strategy(stats.chunks, budget, maxFiles, ranked.length + mentioned.length).length
    - (' | ' + budget + '/' + budget + ' tokens\nOmitted:\n' + hint).length - Math.min(420, Math.floor(limit * 0.06));
  const chosen: { c: Candidate; f: RetrievedFile }[] = [];
  const coverage = new Map<string, number>();
  const role = (c: Candidate) => c.file.test ? 'test' : c.file.doc ? 'docs' : 'source';
  const marginal = (c: Candidate) => c.score / (1 + 0.22 * (coverage.get(role(c)) ?? 0));
  for (let pos = 0; pos < candidates.length; pos++) {
    // Re-rank while there is room for another file. Once full, only the
    // omission ledger remains, so its iteration order is immaterial.
    if (chosen.length < maxFiles && room > 0 && !preferred.has(candidates[pos])) {
      let best = pos;
      for (let i = pos + 1; i < candidates.length; i++) {
        if (marginal(candidates[i]) > marginal(candidates[best])) best = i;
      }
      [candidates[pos], candidates[best]] = [candidates[best], candidates[pos]];
    }
    const c = candidates[pos];
    let reason = '';
    const best = c.hits[0];
    if (!best) reason = 'file contains no indexable lines';
    else if (!preferred.has(c) && c.score < cutoff) reason = `below relevance cutoff (${c.score.toFixed(1)} < ${cutoff.toFixed(1)})`;
    else if (chosen.length >= maxFiles) reason = `maxFiles limit (${maxFiles})`;
    else {
      const outline = excerpt(best, c.file, true);
      const f: RetrievedFile = { path: c.file.path, score: c.score, reasons: c.reasons, spans: [outline] };
      const cost = title(f).length + renderSpan(outline).length + 2;
      if (cost <= room) {
        chosen.push({ c, f });
        coverage.set(role(c), (coverage.get(role(c)) ?? 0) + 1);
        result.files.push(f);
        room -= cost;
      } else reason = 'over budget: would add ' + Math.ceil(cost / 3.8).toLocaleString('en-US') + ' tokens';
    }
    if (reason) result.omitted.push({ path: c.file.path, score: c.score, reason });
  }
  // Every admitted file already has one usable location. Upgrade that location,
  // then spend remaining space on complementary chunks with diminishing returns.
  for (const { c, f } of chosen) {
    const full = excerpt(c.hits[0], c.file, false);
    const extra = renderSpan(full).length - renderSpan(f.spans[0]).length;
    if (extra <= room) { f.spans[0] = full; room -= extra; }
  }
  const extra = chosen.flatMap(({ c, f }) => c.hits.slice(1, 12)
    .filter(h => h.score > 0).map((hit, i) => ({ hit, c, f, value: (hit.score + 0.15 * c.score) /
      ((1 + 0.35 * i) * Math.sqrt(120 + hit.chunk.text.length)) }))).sort((a, b) => b.value - a.value);
  for (const { hit, c, f } of extra) {
    if (f.spans.some(s => s.startLine <= hit.chunk.end && s.endLine >= hit.chunk.start)) continue;
    const span = excerpt(hit, c.file, false);
    const cost = renderSpan(span).length + 1;
    if (cost <= room) { f.spans.push(span); room -= cost; }
  }
  result.omitted.sort((a, b) => b.score - a.score);
  result.strategy = strategy(stats.chunks, budget, chosen.length, result.omitted.length);
  // The number of digits in the token count affects the rendered size.
  result.usedTokens = budget;
  for (let i = 0; i < 3; i++) result.usedTokens = estimateTokens(formatRetrieval(result));
  result.elapsedMs = performance.now() - start;
  return result;
}
