import type { SymbolDef } from '../shared/contracts';

export const estimateTokens = (text: string) => Math.ceil(text.length / 3.8);

export interface Definition extends SymbolDef {
  /** Where the signature lives when a decorator precedes it. */
  signatureLine: number;
  signatureEndLine: number;
}

export interface Chunk {
  start: number;
  end: number;
  text: string;
  doc: string;
  body: string;
  owner?: Definition;
}

export interface Source {
  path: string;
  text: string;
  lines: string[];
  symbols: Definition[];
  chunks: Chunk[];
  imports: string[];
  test: boolean;
  doc: boolean;
}

interface Structure {
  symbols: Definition[];
  imports: string[];
  comments: Map<number, string>;
}

function python(path: string, lines: string[]): Structure {
  const symbols: Definition[] = [];
  const imports: string[] = [];
  const comments = new Map<number, string>();
  const scopes: { indent: number; def: Definition }[] = [];
  let decorator: { indent: number; start: number } | undefined;
  let delimiter = '';
  let depth = 0;
  let continued = false;
  let lastStatement = 0;
  let importStart = -1;
  let signature: Definition | undefined;
  // Lex strings and comments before counting brackets. Only the first physical
  // line of a logical statement can introduce a scope or close an outer one.
  const lex = /("""|'''|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|#.*|[()[\]{}])/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const begins = !delimiter && !depth && !continued;
    if (begins && (!trimmed || trimmed.startsWith('#'))) {
      if (trimmed) comments.set(i, trimmed);
      continue;
    }
    if (begins) {
      const indent = line.slice(0, line.search(/\S/)).replace(/\t/g, '        ').length;
      while (scopes.length && scopes[scopes.length - 1].indent >= indent) {
        scopes.pop()!.def.endLine = lastStatement;
      }
      if (trimmed.startsWith('@')) {
        if (decorator?.indent !== indent) decorator = { indent, start: i + 1 };
      } else {
        const decl = /^(?:async\s+)?(class|def)\s+([\w]+)/.exec(trimmed);
        const constant = indent ? null : /^([A-Z][A-Z_\d]*)\s*(?:=(?!=)|:)/.exec(trimmed);
        if (decl || constant) {
          const parent = scopes.at(-1)?.def;
          const name = decl?.[2] ?? constant![1];
          const kind = constant ? 'variable' : decl![1] === 'class' ? 'class'
            : parent?.kind === 'class' ? 'method' : 'function';
          const def: Definition = {
            path, name, kind, signature: trimmed, signatureLine: i + 1, signatureEndLine: i + 1,
            qualifiedName: parent ? parent.qualifiedName + '.' + name : name,
            startLine: decorator?.indent === indent ? decorator.start : i + 1, endLine: i + 1
          };
          signature = def;
          symbols.push(def);
          scopes.push({ indent, def });
        }
        decorator = undefined;
      }
      if (/^(?:from|import)\s/.test(trimmed)) importStart = i;
    }
    lastStatement = i + 1;
    let pos = 0;
    let prose = '';
    while (pos < line.length) {
      if (delimiter) {
        let close = line.indexOf(delimiter, pos);
        while (close >= 0 && /(?:^|[^\\])(?:\\\\)*\\$/.test(line.slice(0, close))) {
          close = line.indexOf(delimiter, close + 1);
        }
        if (close < 0) { prose += line.slice(pos); break; }
        pos = close + delimiter.length;
        prose += line.slice(0, pos);
        delimiter = '';
      }
      lex.lastIndex = pos;
      const token = lex.exec(line);
      if (!token) break;
      pos = lex.lastIndex;
      const value = token[0];
      if (value === '"""' || value === "'''") delimiter = value;
      else if (value[0] === '#') { prose += value; break; }
      else if ('([{'.includes(value)) depth++;
      else if (')]}'.includes(value)) depth = Math.max(0, depth - 1);
    }
    if (prose) comments.set(i, prose);
    continued = /\\\s*$/.test(line) && !prose;
    if (signature) {
      signature.signatureEndLine = i + 1;
      if (!depth && !continued && !delimiter) signature = undefined;
    }
    if (importStart >= 0 && !depth && !continued && !delimiter) {
      const statement = lines.slice(importStart, i + 1).map(s => s.replace(/#.*/, '')).join(' ').replace(/[()\\]/g, '');
      const from = /^\s*from\s+([.\w]+)\s+import\s+(.+)/.exec(statement);
      if (from) {
        imports.push(from[1]);
        for (const item of from[2].split(',')) {
          imports.push(from[1] + (from[1].endsWith('.') ? '' : '.') + item.trim().split(/\s/)[0]);
        }
      } else {
        for (const item of statement.replace(/^\s*import\s+/, '').split(',')) imports.push(item.trim().split(/\s/)[0]);
      }
      importStart = -1;
    }
  }
  for (const scope of scopes) scope.def.endLine = lastStatement;
  return { symbols, comments, imports };
}

function other(path: string, lines: string[], doc: boolean): Structure {
  const symbols: Definition[] = [];
  const adornment = /^([=~^*+#`:"'.\-])\1{2,}$/;
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    let name: string | undefined;
    let kind: Definition['kind'] = 'heading';
    if (doc) {
      if (path.endsWith('.md')) {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
        if (marker && (!fence || marker.startsWith(fence))) { fence = fence ? '' : marker; continue; }
      }
      if (fence || !line || /^\s/.test(raw) || adornment.test(line)) continue;
      const next = lines[i + 1]?.trim() ?? '';
      if (path.endsWith('.md')) {
        name = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
        if (!name && /^(?:=+|-+)$/.test(next)) name = line;
      } else if (adornment.test(next) && next.length >= line.length) name = line;
    } else if (/\.[cm]?[jt]sx?$/.test(path)) {
      const match = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|function\*?|interface|type|const|let)\s+([\w$]+)/.exec(raw);
      if (match) {
        name = match[2];
        kind = match[1] === 'class' ? 'class' : /function|=>/.test(line) ? 'function' : 'variable';
      }
    }
    if (name) {
      if (symbols.length) symbols[symbols.length - 1].endLine = i;
      symbols.push({ path, name, qualifiedName: name, kind, signature: line, signatureLine: i + 1, signatureEndLine: i + 1,
        startLine: i + 1, endLine: lines.length });
    }
  }
  return { symbols, imports: [], comments: new Map() };
}

export function parseFile(path: string, text: string): Source {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const doc = /\.(rst|md)$/i.test(path);
  const py = /\.pyi?$/.test(path);
  const { symbols, imports, comments } = py ? python(path, lines) : other(path, lines, doc);
  const chunks: Chunk[] = [];
  // Segment at scope boundaries, including the return from a method to its class.
  const boundaries = new Set([1, lines.length + 1]);
  const starts = new Map<number, Definition>();
  for (const def of symbols) {
    boundaries.add(def.startLine);
    boundaries.add(def.endLine + 1);
    starts.set(def.startLine, def);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const active: Definition[] = [];
  for (let j = 0; j + 1 < points.length; j++) {
    let start = points[j];
    while (active.length && active.at(-1)!.endLine < start) active.pop();
    const def = starts.get(start);
    if (def) active.push(def);
    const owner = active.at(-1);
    const stop = points[j + 1] - 1;
    while (start <= stop) {
      if (!lines[start - 1].trim()) { start++; continue; }
      let end = start;
      let chars = lines[start - 1].length;
      while (end < stop && end - start < 59 && chars + lines[end].length + 1 <= 1520) {
        chars += lines[end++].length + 1;
      }
      let last = end;
      while (last > start && !lines[last - 1].trim()) last--;
      const excerpt = lines.slice(start - 1, last).join('\n');
      const notes: string[] = [];
      const code: string[] = [];
      for (let n = start; n <= last; n++) {
        const line = lines[n - 1];
        const note = comments.get(n - 1);
        if (note) notes.push(note);
        code.push(note ? line.replace(note, '') : line);
      }
      if (excerpt.length > 1520) {
        for (let offset = 0; offset < excerpt.length; offset += 1520) {
          const part = excerpt.slice(offset, offset + 1520);
          chunks.push({ start, end: last, text: part, body: notes.length ? '' : part, doc: notes.length ? part : '', owner });
        }
      } else {
        chunks.push({ start, end: last, text: excerpt, doc: notes.join('\n'), body: code.join('\n'), owner });
      }
      start = end + 1;
    }
  }
  return { path, text, lines, chunks, symbols, imports, doc,
    test: /(?:^|\/)tests?\/|(?:^|\/)test_[^/]+\.py$|_test\.py$/.test(path) };
}
