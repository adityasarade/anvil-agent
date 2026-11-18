/** Pure model of the unified review document (no vscode import). */
import type { Hunk, HunkDecision } from '../shared/contracts';
import { splitLines } from './hunks';

export interface Region {
  hunk: number;
  /** 0-based first line of the hunk in the view (first removed line, else first added). */
  start: number;
  removed: number;
  added: number;
}

export interface ViewModel {
  text: string;
  regions: Region[];
}

/** Original text with each hunk in place: removed lines followed by added lines. */
export function buildView(original: string, hunks: Hunk[]): ViewModel {
  const lines = splitLines(original);
  const out: string[] = [];
  const regions: Region[] = [];
  let pos = 0;
  for (const h of hunks) {
    const s = h.oldStart - 1;
    out.push(...lines.slice(pos, s));
    regions.push({ hunk: h.index, start: out.length, removed: h.oldLines.length, added: h.newLines.length });
    out.push(...h.oldLines, ...h.newLines);
    pos = s + h.oldLines.length;
  }
  out.push(...lines.slice(pos));
  return { text: out.join('\n'), regions };
}

/** Hunk under `line`, else the first pending one, else undefined. */
export function pickHunk(regions: Region[], decisions: HunkDecision[], line: number | undefined): number | undefined {
  if (line !== undefined) {
    const r = regions.find((x) => line >= x.start && line < x.start + Math.max(1, x.removed + x.added));
    if (r) return r.hunk;
  }
  const p = decisions.findIndex((d) => d === 'pending');
  return p >= 0 ? p : undefined;
}
