import { posix as path } from 'node:path';
import type { ContextEngine, ContextEngineOptions, IndexStats, MentionSuggestion, SymbolDef, TextMatch } from '../shared/contracts';
import { estimateTokens, type Source } from './parse';
import { fileFilter, relative, scanner } from './scan';
import { Catalog } from './rank';
import { retrieve } from './retrieve';

export { estimateTokens } from './parse';
export { formatRetrieval } from './retrieve';

function fuzzyPrefix(prefix: string, candidate: string) {
  if (!candidate.startsWith(prefix[0])) return false;
  let next = 0;
  for (const c of candidate) {
    if (c === prefix[next] && ++next === prefix.length) return true;
  }
  return false;
}

export function createContextEngine(opts: ContextEngineOptions): ContextEngine {
  let files = new Map<string, Source>();
  let catalog: Catalog | undefined;
  let stats: IndexStats = { files: 0, symbols: 0, chunks: 0, totalTokens: 0, builtAt: 0, buildMs: 0 };
  let generation = 0;
  let version = 0;
  const changes = new Map<string, number>();
  let scan: ReturnType<typeof scanner> | undefined;
  function index() { return catalog ??= new Catalog(files); }
  function replace(p: string, file?: Source) {
    const old = files.get(p);
    if (!old && !file) return;
    if (file) files.set(p, file);
    else files.delete(p);
    catalog = undefined;
    stats = { ...stats, files: files.size,
      chunks: stats.chunks + (file?.chunks.length ?? 0) - (old?.chunks.length ?? 0),
      symbols: stats.symbols + (file?.symbols.length ?? 0) - (old?.symbols.length ?? 0),
      totalTokens: stats.totalTokens + estimateTokens(file?.text ?? '') - estimateTokens(old?.text ?? '') };
  }
  return {
    async build() {
      const epoch = ++generation;
      const start = performance.now();
      const snapshotVersion = version;
      const reader = await (scan = scanner(opts));
      const paths = await reader.paths();
      const next = new Map<string, Source>();
      // Bound in-flight reads even for repositories with thousands of files.
      for (let i = 0; i < paths.length; i += 32) {
        for (const f of await Promise.all(paths.slice(i, i + 32).map(p => reader.read(p, true)))) {
          if (f) next.set(f.path, f);
        }
      }
      if (epoch !== generation) return { ...stats };
      for (const [p, revision] of changes) {
        if (revision > snapshotVersion) {
          const newer = files.get(p);
          if (newer) next.set(p, newer);
          else next.delete(p);
        }
      }
      const built = new Catalog(next);
      files = next;
      catalog = built;
      stats = { files: files.size, symbols: 0, chunks: 0, totalTokens: 0, builtAt: Date.now(), buildMs: 0 };
      for (const f of files.values()) {
        stats.symbols += f.symbols.length;
        stats.chunks += f.chunks.length;
        stats.totalTokens += estimateTokens(f.text);
      }
      stats.buildMs = performance.now() - start;
      return { ...stats };
    },
    async refreshFile(raw) {
      const p = relative(raw);
      if (!p) return;
      const revision = ++version;
      changes.set(p, revision);
      const reader = await (scan ??= scanner(opts));
      const f = await reader.read(p);
      if (changes.get(p) === revision) replace(p, f);
    },
    removeFile(raw) {
      const p = relative(raw);
      if (p) { changes.set(p, ++version); replace(p); }
    },
    retrieve(query, options) {
      return retrieve(index(), { ...stats }, query, { ...options,
        mentionedPaths: options?.mentionedPaths?.map(p => relative(p) ?? p) });
    },
    repoMap(options = {}) {
      const budget = Math.max(0, options.budgetTokens ?? 1200);
      const focus = new Set(options.focusPaths?.map(relative));
      const lookup = index();
      const relevance = new Map(options.query ? lookup.rank(options.query).map(c => [c.file.path, c.score]) : []);
      const ranked = [...files.values()].map(f => ({ f, score: Math.log1p(lookup.incoming.get(f.path)?.size ?? 0) + (relevance.get(f.path) ?? 0) }))
        .sort((a, b) => Number(focus.has(b.f.path)) - Number(focus.has(a.f.path)) || b.score - a.score || a.f.path.localeCompare(b.f.path));
      const rows: string[] = [];
      let remaining = Math.floor(budget * 3.8);
      for (const { f } of ranked) {
        const first = f.path + '\n';
        if (first.length > remaining) continue;
        rows.push(first);
        remaining -= first.length;
        for (const s of f.symbols.filter(s => s.name === s.qualifiedName).slice(0, focus.has(f.path) ? 20 : 8)) {
          const signature = f.lines.slice(s.signatureLine - 1, s.signatureEndLine).map(line => line.trim()).join(' ');
          const line = '  ' + s.signatureLine + '| ' + signature + '\n';
          if (line.length > remaining) break;
          rows.push(line);
          remaining -= line.length;
        }
      }
      return rows.join('').trimEnd();
    },
    findSymbol(name, limit = 20) {
      const result: { rank: number; def: SymbolDef }[] = [];
      const lower = name.toLowerCase();
      for (const file of files.values()) for (const def of file.symbols) {
        const names = [def.name, def.qualifiedName];
        const parts = names.map(n => n.toLowerCase());
        const rank = names.includes(name) ? 0 : parts.includes(lower) ? 1 :
          parts.some(n => n.startsWith(lower)) ? 2 : parts.some(n => n.includes(lower)) ? 3 : 4;
        if (rank < 4) result.push({ rank, def });
      }
      return result.sort((a, b) => a.rank - b.rank || a.def.path.localeCompare(b.def.path) ||
        a.def.startLine - b.def.startLine).slice(0, Math.max(0, limit)).map(({ def }) => ({
          name: def.name, qualifiedName: def.qualifiedName, kind: def.kind, signature: def.signature,
          path: def.path, startLine: def.startLine, endLine: def.endLine
        }));
    },
    listFiles(pattern, limit = Infinity) {
      return [...files.keys()].filter(fileFilter(pattern)).sort().slice(0, Math.max(0, limit));
    },
    searchText(pattern, options = {}) {
      const results: TextMatch[] = [];
      if (!pattern || (options.maxResults ?? 50) <= 0) return results;
      let expr: RegExp;
      try {
        const source = options.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expr = new RegExp(source, options.caseSensitive ? '' : 'i');
      } catch { return results; }
      const filter = fileFilter(options.glob);
      for (const [p, f] of files) {
        if (!filter(p)) continue;
        for (let i = 0; i < f.lines.length; i++) {
          const line = f.lines[i];
          const match = expr.exec(line);
          if (!match) continue;
          const start = Math.max(0, match.index - 80);
          results.push({ path: p, line: i + 1, text: line.slice(start, start + 240).trim() });
          if (results.length >= (options.maxResults ?? 50)) return results;
        }
      }
      return results;
    },
    suggest(prefix, limit = 20) {
      const q = prefix.toLowerCase().replace(/^@/, '');
      const out: { score: number; item: MentionSuggestion }[] = [];
      for (const [p, f] of files) {
        const name = path.basename(p);
        const lower = p.toLowerCase();
        const score = name.toLowerCase() === q || lower === q ? 0 : name.toLowerCase().startsWith(q) ? 2 :
          lower.startsWith(q) || lower.includes('/' + q) ? 3 : lower.includes(q) ? 4 :
          fuzzyPrefix(q, name.toLowerCase()) || fuzzyPrefix(q, lower) ? 5 : 6;
        if (score < 6) out.push({ score, item: { kind: 'file', label: name, value: p, detail: p } });
        if (!q) continue;
        for (const s of f.symbols) {
          if (s.name.toLowerCase().startsWith(q) || s.qualifiedName.toLowerCase().startsWith(q)) {
            out.push({ score: s.name.toLowerCase() === q ? 0 : 2, item: { kind: 'symbol',
              label: s.qualifiedName, value: s.qualifiedName, detail: `${s.kind} · ${p}:${s.startLine}` } });
          }
        }
      }
      return out.sort((a, b) => a.score - b.score || a.item.label.length - b.item.label.length ||
        a.item.value.localeCompare(b.item.value)).slice(0, Math.max(0, limit)).map(o => o.item);
    },
    fileText(raw) { return files.get(relative(raw) ?? '')?.text; },
    stats() { return { ...stats }; }
  };
}
