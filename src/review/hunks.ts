/**
 * Pure line-diff helpers (no vscode import). Text is modelled as an array of lines
 * (split on \n or \r\n, a trailing newline yields a final '' line) joined with the
 * original EOL, so applying every hunk reproduces the proposal exactly.
 */
import { diffArrays } from 'diff';
import type { Hunk } from '../shared/contracts';

export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** '' -> [] (no lines); otherwise split on LF/CRLF. */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r?\n/);
}

/** MAX unchanged lines between two changes that still get merged into one hunk. */
const MERGE_GAP = 1;

export function computeHunks(original: string, proposed: string): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  if (original === proposed) return [];
  const parts = diffArrays(a, b);

  interface Raw { o: number; n: number; del: string[]; add: string[] }
  const raws: Raw[] = [];
  let o = 0;
  let n = 0;
  let cur: Raw | null = null;
  for (const p of parts) {
    const vals = p.value as string[];
    if (p.added) {
      if (!cur) cur = { o, n, del: [], add: [] };
      cur.add.push(...vals);
      n += vals.length;
    } else if (p.removed) {
      if (!cur) cur = { o, n, del: [], add: [] };
      cur.del.push(...vals);
      o += vals.length;
    } else {
      if (cur) { raws.push(cur); cur = null; }
      o += vals.length;
      n += vals.length;
    }
  }
  if (cur) raws.push(cur);

  // Merge changes separated by <= MERGE_GAP unchanged lines.
  const merged: Raw[] = [];
  for (const r of raws) {
    const last = merged[merged.length - 1];
    if (last) {
      const lastEnd = last.o + last.del.length;
      const gap = r.o - lastEnd;
      if (gap <= MERGE_GAP) {
        const between = a.slice(lastEnd, r.o);
        last.del.push(...between, ...r.del);
        last.add.push(...between, ...r.add);
        continue;
      }
    }
    merged.push({ o: r.o, n: r.n, del: [...r.del], add: [...r.add] });
  }
  return merged.map((r, index) => ({
    index,
    oldStart: r.o + 1,
    oldLines: r.del,
    newStart: r.n + 1,
    newLines: r.add,
  }));
}

export function applyHunks(original: string, hunks: Hunk[], accepted: number[]): string {
  const eol = detectEol(original);
  const lines = splitLines(original);
  const acc = new Set(accepted);
  const out: string[] = [];
  let pos = 0;
  for (const h of [...hunks].sort((x, y) => x.oldStart - y.oldStart)) {
    const s = h.oldStart - 1;
    out.push(...lines.slice(pos, s));
    out.push(...(acc.has(h.index) ? h.newLines : h.oldLines));
    pos = s + h.oldLines.length;
  }
  out.push(...lines.slice(pos));
  return out.join(eol);
}

export interface TextEdit { start: number; end: number; text: string }

/**
 * Character-offset edits (against `original`) for the accepted hunks. Applying them
 * all at once gives the same text as applyHunks. Used to build a single WorkspaceEdit.
 */
export function hunkEdits(original: string, hunks: Hunk[], accepted: number[]): TextEdit[] {
  const eol = detectEol(original);
  const total = splitLines(original).length;
  const starts: number[] = [];
  const ends: number[] = [];
  if (total > 0) {
    starts.push(0);
    const re = /\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(original))) {
      ends.push(m.index);
      starts.push(m.index + m[0].length);
    }
    ends.push(original.length);
  }
  const len = original.length;
  const acc = new Set(accepted);
  const edits: TextEdit[] = [];
  for (const h of hunks) {
    if (!acc.has(h.index)) continue;
    const s = h.oldStart - 1;
    const e = s + h.oldLines.length;
    const nl = h.newLines;
    const body = nl.join(eol);
    if (e < total) {
      edits.push({ start: starts[s], end: starts[e], text: nl.length ? body + eol : '' });
    } else if (nl.length) {
      if (s === e) edits.push({ start: len, end: len, text: total > 0 ? eol + body : body });
      else edits.push({ start: starts[s], end: len, text: body });
    } else {
      edits.push({ start: s > 0 ? ends[s - 1] : 0, end: len, text: '' });
    }
  }
  return edits.sort((x, y) => x.start - y.start);
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  let out = '';
  let pos = 0;
  for (const e of [...edits].sort((x, y) => x.start - y.start)) {
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}
