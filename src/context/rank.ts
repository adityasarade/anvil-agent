import { posix as path } from 'node:path';
import type { Chunk, Source } from './parse';

const stop = new Set(('a an and are as at be by for from has if in into is it its of on or that the their then ' +
  'this to was which will with would add new must all any alongside other like well every also update appear ' +
  'covered containing prints treated treat').split(' '));

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 5 && /(?:sh|ch|ss|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3).replace(/([bdgmnprt])\1$/, '$1');
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && /[^su]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function terms(text: string): string[] {
  const words: string[] = [];
  for (const match of text.matchAll(/[a-zA-Z\d_]+(?:-[a-zA-Z\d_]+)*/g)) {
    const raw = match[0];
    const lower = raw.toLowerCase();
    const parts = raw.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[-_\s]+/);
    if (parts.length > 1) words.push(lower);
    for (const part of parts) if (part && !stop.has(part)) words.push(stem(part));
  }
  return words;
}

function analyze(text: string) {
  const weights = new Map(terms(text).map(t => [t, 1]));
  const exact = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^\w])(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`)/g)) {
    const value = (match[1] ?? match[2] ?? match[3]).toLowerCase();
    exact.add(value);
    for (const t of terms(value)) weights.set(t, 3);
  }
  for (const m of text.matchAll(/--[\w-]+|[A-Za-z_]\w*(?:\.\w+|-[\w-]+)*/g)) {
    if (/[_A-Z.\-]/.test(m[0]) && !/^[A-Z][a-z]+$/.test(m[0])) {
      exact.add(m[0].toLowerCase());
      for (const t of terms(m[0])) weights.set(t, Math.max(2, weights.get(t) ?? 0));
    }
  }
  if (/case[- ]insensitiv/i.test(text)) {
    for (const term of ['lower', 'casefold', 'tolowercase', 'ignorecase']) weights.set(term, 2);
  }
  return { weights, exact };
}

interface Posting { id: number; counts: number[] }
export interface Hit { chunk: Chunk; score: number }
export interface Candidate { file: Source; score: number; reasons: string[]; hits: Hit[] }

const boosts = [2.5, 3, 1.2, 1];
const basename = (p: string) => path.basename(p, path.extname(p));
const pairName = (p: string) => basename(p).replace(/^test_|_test$/g, '');

export class Catalog {
  readonly imports = new Map<string, Set<string>>();
  readonly incoming = new Map<string, Set<string>>();
  readonly pairs = new Map<string, Set<string>>();
  private readonly postings = new Map<string, Posting[]>();
  private readonly lengths: number[][] = [];
  private readonly averages = [0, 0, 0, 0];

  constructor(readonly files: Map<string, Source>) {
    const modules = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const [p, file] of files) {
      if (/\.pyi?$/.test(p)) {
        let module = p.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').replace(/^src\//, '').replaceAll('/', '.');
        modules.set(module, p);
        // Packages can be rooted below examples/ or in a monorepo.
        const dirs = p.split('/').slice(0, -1);
        let root = dirs.length;
        while (root && (files.has(dirs.slice(0, root).join('/') + '/__init__.py') ||
          files.has(dirs.slice(0, root).join('/') + '/__init__.pyi'))) root--;
        module = p.split('/').slice(root).join('.').replace(/\.pyi?$/, '').replace(/\.__init__$/, '');
        if (!modules.has(module)) modules.set(module, p);
      }
      if (!file.test && !file.doc) {
        const name = basename(p);
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(p);
      }
      const pathTerms = terms(p);
      for (const chunk of file.chunks) {
        const fields = [pathTerms, terms(chunk.owner?.qualifiedName ?? ''), terms(chunk.doc), terms(chunk.body)];
        const counts = new Map<string, number[]>();
        const lengths = fields.map((field, i) => {
          this.averages[i] += field.length;
          for (const term of field) {
            let tf = counts.get(term);
            if (!tf) counts.set(term, tf = [0, 0, 0, 0]);
            tf[i]++;
          }
          return field.length;
        });
        const id = this.lengths.push(lengths) - 1;
        for (const [term, tf] of counts) {
          let postings = this.postings.get(term);
          if (!postings) this.postings.set(term, postings = []);
          postings.push({ id, counts: tf });
        }
      }
    }
    for (let i = 0; i < 4; i++) this.averages[i] = this.averages[i] / this.lengths.length || 1;
    const link = (map: Map<string, Set<string>>, a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set());
      map.get(a)!.add(b);
    };
    for (const [p, f] of files) {
      const paired = new Set(f.test ? byName.get(pairName(p)) : []);
      for (const spec of f.imports) {
        const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
        let target: string | undefined;
        if (dots) {
          const base = p.split('/').slice(0, -dots);
          const mod = [...base, ...spec.slice(dots).split('.').filter(Boolean)].join('/');
          target = ['.py', '/__init__.py', '.pyi', '/__init__.pyi'].map(s => mod + s).find(s => files.has(s));
        } else target = modules.get(spec);
        if (!target || target === p) continue;
        link(this.imports, p, target);
        link(this.incoming, target, p);
        if (f.test && !files.get(target)!.test) paired.add(target);
      }
      for (const src of paired) { link(this.pairs, src, p); link(this.pairs, p, src); }
    }
  }

  rank(query: string, mentioned: string[] = []): Candidate[] {
    const { weights, exact } = analyze(query);
    const scores = new Float64Array(this.lengths.length);
    for (const [term, weight] of weights) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (this.lengths.length - list.length + 0.5) / (list.length + 0.5));
      for (const { id, counts } of list) {
        const lengths = this.lengths[id];
        let tf = 0;
        for (let i = 0; i < 4; i++) tf += boosts[i] * counts[i] / (0.25 + 0.75 * lengths[i] / this.averages[i]);
        scores[id] += weight * idf * 2.2 * tf / (1.2 + tf);
      }
    }
    const candidates = new Map<string, Candidate>();
    const identifiers = new Set([...query.toLowerCase().matchAll(/[\w.]+/g)].map(m => m[0]).filter(x => !stop.has(x)));
    const symbolParts = [...weights.keys()].filter(t => t.length >= 3 && !['test', 'doc', 'document'].includes(t));
    const siblingIntent = /\balongside\b|\blike (?:the )?other\b/i.test(query);
    const exactPatterns = [...exact].map(s => new RegExp('(?<![\\w])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'i'));
    let id = 0;
    for (const file of this.files.values()) {
      const reasons: string[] = [];
      const definitions = new Set<string>();
      const hits: Hit[] = [];
      for (const chunk of file.chunks) {
        let score = scores[id++];
        const name = chunk.owner?.name.toLowerCase() ?? '';
        if (name && (identifiers.has(name) || identifiers.has(chunk.owner!.qualifiedName.toLowerCase()))) {
          score += 18;
          definitions.add(chunk.owner!.qualifiedName);
        } else if (name && symbolParts.some(t => name.includes(t))) score += 3;
        for (const re of exactPatterns) if (re.test(chunk.text)) score += 5;
        hits.push({ chunk, score });
      }
      let siblingBoost = 0;
      if (siblingIntent && !file.test && !file.doc) {
        // A family shares a naming convention and a scope. A repeated argument
        // at one call site is stronger evidence than coincidental substrings.
        const groups = new Map<string, Set<string>>();
        for (const sym of file.symbols) {
          if (sym.kind !== 'function' && sym.kind !== 'method') continue;
          const parts = sym.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_').filter(Boolean);
          if (parts.length < 2) continue;
          const scope = sym.qualifiedName.slice(0, -sym.name.length);
          for (const [position, part] of [['prefix', parts[0]], ['suffix', parts.at(-1)!]]) {
            if (!symbolParts.includes(stem(part))) continue;
            const key = scope + ':' + position + ':' + part;
            if (!groups.has(key)) groups.set(key, new Set());
            groups.get(key)!.add(sym.name);
          }
        }
        for (const group of groups.values()) {
          if (group.size < 3) continue;
          const names = [...group];
          if (!siblingBoost) reasons.push('defines ' + names.slice(0, 4).join(', '));
          siblingBoost = Math.max(siblingBoost, 10);
          for (const h of hits) {
            if (group.has(h.chunk.owner?.name ?? '')) h.score += 7;
            const refs = [...new Set([...h.chunk.body.matchAll(/\(\s*([\w$]+)\s*[,)]/g)]
              .map(m => m[1]).filter(n => group.has(n)))];
            if (refs.length >= 2 && h.chunk.owner) {
              h.score += 20 * Math.min(4, refs.length);
              siblingBoost = 26;
              reasons[0] = 'defines ' + refs.slice(0, 4).join(', ') + ' (referenced in ' + h.chunk.owner.qualifiedName + ')';
            }
          }
        }
      }
      hits.sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start);
      const score = (hits[0]?.score ?? 0) + 0.35 * ((hits[1]?.score ?? 0) + (hits[2]?.score ?? 0)) + siblingBoost;
      const best = hits[0]?.chunk;
      if (best?.owner && definitions.has(best.owner.qualifiedName)) reasons.push('defines ' + best.owner.qualifiedName);
      if (hits[0]?.score) {
        const counts = new Map<string, number>();
        for (const t of terms(hits[0].chunk.text + ' ' + file.path)) {
          if (weights.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const matches = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
        if (!matches.length && best) {
          const literal = [...exact].find(t => best.text.toLowerCase().includes(t));
          if (literal) reasons.push('contains literal ' + JSON.stringify(literal));
          else if (best.owner) reasons.push('defines ' + best.owner.qualifiedName);
        }
        if (matches.length) reasons.push('matched: ' + matches.map(([t, n]) => t + ' x' + n).join(', '));
      }
      if (mentioned.includes(file.path)) reasons.unshift('mentioned by the user');
      candidates.set(file.path, { file, hits, reasons, score });
    }
    const sorted = () => [...candidates.values()].sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const ordered = sorted();
    const seeds = new Set([...mentioned, ...ordered.filter(c => !c.file.test && !c.file.doc && c.score > 0).slice(0, 3).map(c => c.file.path)]);
    if (ordered[0]?.score > 0) seeds.add(ordered[0].file.path);
    const bonus = new Map<string, { points: number; reason: string }>();
    function boost(p: string, points: number, reason: string) {
      if (points > (bonus.get(p)?.points ?? 0)) bonus.set(p, { points, reason });
    }
    for (const p of seeds) {
      const seed = candidates.get(p);
      if (!seed) continue;
      const score = Math.max(seed.score, mentioned.includes(p) ? ordered[0]?.score || 1 : 0);
      for (const dst of this.imports.get(p) ?? []) boost(dst, score * 0.3, 'imported by ' + p);
      for (const src of this.incoming.get(p) ?? []) boost(src, score * 0.3, 'imports ' + p);
      for (const pair of this.pairs.get(p) ?? []) {
        const factor = pairName(p) === pairName(pair) ? 0.72 : 0.33;
        boost(pair, score * factor, 'test pair of ' + p);
      }
      if (seed.file.doc || seed.file.test) continue;
      // Compound identifiers are distinctive in prose. Plain words such as
      // "command" count as symbol references only when typeset as code.
      const keyNames = [...new Set(seed.hits.slice(0, 6).map(h => h.chunk.owner?.name)
        .filter((s): s is string => !!s && /^[$\w]+$/.test(s) && s.length > 3 && !s.startsWith('__')))]
        .map(name => {
          const word = name.replace(/\$/g, '\\$');
          const pattern = /[_A-Z]/.test(name) ? '(?<![\\w])' + word + '(?![\\w])'
            : '[`.]' + word + '[`>]';
          return { name, pattern: new RegExp(pattern) };
        });
      for (const doc of ordered) {
        if (!doc.file.doc) continue;
        const sameTopic = basename(doc.file.path) === basename(p);
        for (const h of doc.hits) {
          const heading = h.chunk.owner?.name;
          if (!heading) continue;
          const symbol = keyNames.find(s => s.pattern.test(h.chunk.text))?.name;
          const term = terms(heading).find(t => weights.has(t));
          if (!term && !symbol) continue;
          const factor = sameTopic ? 0.68 : symbol ? 0.14 : 0.04;
          const evidence = symbol ? `mentions ${symbol} from ${p}` : `matches query term '${term}'`;
          boost(doc.file.path, score * factor, `docs section '${heading}' ${evidence}`);
          // Hits are already in lexical order. Prefer that order for ties.
          if (sameTopic || symbol) break;
        }
      }
    }
    for (const [p, { points, reason }] of bonus) {
      const c = candidates.get(p)!;
      c.score += points;
      c.reasons.unshift(reason);
    }
    return sorted();
  }
}
