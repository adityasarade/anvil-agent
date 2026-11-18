/**
 * EditGate: the bridge between TrueForge tool approval and Anvil's per-hunk review.
 *
 *  1. TrueForge pauses on an edit_file/write_file call (tool.approval_required).
 *  2. The runtime calls reviewToolCall(): we compute the proposal from the tool args
 *     against the current buffer, open the per-hunk review and store the outcome.
 *     >= 1 hunk accepted -> allow, otherwise deny with a reason the model can act on.
 *  3. TrueForge then invokes the MCP tool; its handler calls applyReviewed(), which
 *     applies ONLY the accepted hunks (one undoable WorkspaceEdit via ReviewService)
 *     and tells the model exactly what landed. Unreviewed calls never write.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AppliedChange,
  ApprovalDecision,
  EditGate,
  EditorToolHost,
  Hunk,
  ProposedChange,
  ReviewOutcome,
  ToolCallInfo,
} from '../shared/contracts';
import { TOOL_NAMES } from '../shared/contracts';
import { computeHunks } from '../review/hunks';

interface Entry {
  key: string;
  sid: string;
  tool: string;
  relPath: string;
  runId: string;
  change: ProposedChange;
  outcome: ReviewOutcome;
  hunks: Hunk[];
  at: number;
}

export interface EditSpec {
  old_text: string;
  new_text: string;
}

export type EditResult = { ok: true; text: string } | { ok: false; reason: string };

export function createEditGate(host: EditorToolHost): EditGate {
  const entries = new Map<string, Entry>();
  let seq = 0;

  function deny(reason: string): ApprovalDecision {
    return { status: 'deny', reason };
  }

  async function reviewToolCall(call: ToolCallInfo, runId: string, tfSessionId: string): Promise<ApprovalDecision> {
    const tool = call.name;
    const args = call.args ?? {};
    if (tool !== TOOL_NAMES.editFile && tool !== TOOL_NAMES.writeFile) return deny(`${tool} is not an edit tool.`);

    let rel: string;
    try {
      rel = host.resolvePath(String(args.path ?? ''));
    } catch (err) {
      return deny(`Invalid path ${JSON.stringify(args.path)}: ${msgOf(err)}`);
    }
    if (!rel) return deny('A file path is required.');

    const current = await host.readText(rel);
    let proposed: string;
    let isNewFile = false;
    if (tool === TOOL_NAMES.editFile) {
      if (current === null) return deny(`${rel} does not exist, use write_file to create it.`);
      const edits = normalizeEdits(args.edits);
      if (typeof edits === 'string') return deny(edits);
      const res = applyTextEdits(current, edits, rel);
      if (!res.ok) return deny(res.reason);
      proposed = res.text;
    } else {
      if (typeof args.content !== 'string') return deny('write_file needs a string `content`.');
      isNewFile = current === null;
      proposed = args.content;
      if (isNewFile && proposed === '') return deny(`Refusing to create an empty file ${rel}; write at least one line (for example a comment).`);
    }

    const original = current ?? '';
    if (!isNewFile && proposed === original) return deny(`No changes: the proposed content of ${rel} is identical to the current file.`);

    const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : undefined;
    const change: ProposedChange = {
      id: randomUUID(),
      runId,
      source: 'agent',
      relPath: rel,
      uri: host.toUri(rel),
      originalText: original,
      proposedText: proposed,
      isNewFile,
      title: description ?? (isNewFile ? `Create ${rel}` : `Edit ${rel}`),
    };
    const hunks = computeHunks(original, proposed);

    let outcome: ReviewOutcome;
    try {
      outcome = await host.review.review(change);
    } catch (err) {
      return deny(`The review of ${rel} failed: ${msgOf(err)}`);
    }
    if (!outcome || outcome.status === 'cancelled') return deny('review cancelled');
    if (!outcome.accepted?.length) {
      const n = hunks.length || outcome.decisions?.length || 1;
      return deny(
        `User rejected all ${n} hunk${n === 1 ? '' : 's'} of the change to ${rel}. Do not propose the same change again; ask or try a different approach.`,
      );
    }

    const key = keyOf(tfSessionId, tool, args);
    entries.set(key, { key, sid: tfSessionId, tool, relPath: rel, runId, change, outcome, hunks, at: ++seq });
    return { status: 'allow' };
  }

  function findEntry(tool: string, args: Record<string, unknown>, sid: string | undefined): Entry | undefined {
    if (sid) {
      const exact = entries.get(keyOf(sid, tool, args));
      if (exact) return exact;
    } else {
      // No session header: only an exact args match (in any session) is trusted.
      const hash = argsHash(args);
      for (const e of entries.values()) if (e.tool === tool && e.key.endsWith(hash)) return e;
      return undefined;
    }
    let rel: string | undefined;
    try {
      rel = host.resolvePath(String(args.path ?? ''));
    } catch {
      return undefined;
    }
    let best: Entry | undefined;
    for (const e of entries.values()) {
      if (e.sid === sid && e.tool === tool && e.relPath === rel && (!best || e.at > best.at)) best = e;
    }
    return best;
  }

  async function applyReviewed(toolName: string, args: Record<string, unknown>, tfSessionId: string | undefined): Promise<string> {
    const entry = findEntry(toolName, args ?? {}, tfSessionId);
    if (!entry) return 'Not applied: this edit was not reviewed by the user.';
    entries.delete(entry.key);

    let applied: AppliedChange | null;
    try {
      applied = await host.review.apply(entry.change, entry.outcome);
    } catch (err) {
      return `Not applied: ${msgOf(err)} Re-read ${entry.relPath} with read_file and propose the edit again against its current text.`;
    }
    if (!applied) return `Not applied: no hunks of the change to ${entry.relPath} were accepted.`;

    const accepted = [...new Set(applied.hunksApplied)].sort((a, b) => a - b);
    const total = applied.hunksTotal || entry.hunks.length;
    let added = 0;
    let removed = 0;
    for (const h of entry.hunks) {
      if (!accepted.includes(h.index)) continue;
      added += h.newLines.length;
      removed += h.oldLines.length;
    }
    host.emit(tfSessionId ?? entry.sid, {
      type: 'change.applied',
      runId: entry.runId,
      change: {
        id: applied.id,
        runId: applied.runId,
        relPath: applied.relPath,
        hunksApplied: accepted.length,
        hunksTotal: total,
        linesAdded: added,
        linesRemoved: removed,
        undone: applied.undone,
      },
    });
    try {
      await host.context.refreshFile(entry.relPath);
    } catch {
      /* the index catches up on the next file event */
    }
    return describeApplied(entry, applied, accepted, total);
  }

  function forgetRun(runId: string): void {
    for (const [k, e] of entries) if (e.runId === runId) entries.delete(k);
  }

  return { reviewToolCall, applyReviewed, forgetRun };
}

/* ───────────────────────── messages ───────────────────────── */

function describeApplied(entry: Entry, applied: AppliedChange, accepted: number[], total: number): string {
  const rel = entry.relPath;
  const lines = countLines(applied.after);
  const fmtLines = lines.toLocaleString('en-US');
  if (entry.change.isNewFile) {
    return accepted.length >= total
      ? `Created ${rel} (${fmtLines} lines).`
      : `Created ${rel} with hunks ${accepted.map((i) => i + 1).join(',')} of ${total}${rejectedNote(entry, accepted)} File now has ${fmtLines} lines.`;
  }
  if (accepted.length >= total) {
    return `Applied ${total === 1 ? 'the change' : `all ${total} hunks`} to ${rel}. File now has ${fmtLines} lines.`;
  }
  return `Applied hunk${accepted.length === 1 ? '' : 's'} ${accepted.map((i) => i + 1).join(',')} of ${total} to ${rel}.${rejectedNote(entry, accepted)} File now has ${fmtLines} lines.`;
}

function rejectedNote(entry: Entry, accepted: number[]): string {
  const rejected = entry.hunks.filter((h) => !accepted.includes(h.index));
  if (!rejected.length) return '';
  const parts = rejected.map((h) => {
    const first = (h.oldLines.find((l) => l.trim()) ?? h.newLines.find((l) => l.trim()) ?? '').trim();
    const snippet = first.length > 60 ? first.slice(0, 57) + '…' : first;
    const where = !h.oldLines.length
      ? `insertion at line ${h.oldStart}`
      : h.oldLines.length === 1
        ? `line ${h.oldStart}`
        : `lines ${h.oldStart}-${h.oldStart + h.oldLines.length - 1}`;
    return `hunk ${h.index + 1} (${where}: '${snippet}')`;
  });
  return ` The user rejected ${parts.join(', ')}; do not re-propose ${rejected.length === 1 ? 'it' : 'them'} unless asked.`;
}

function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split(/\r?\n/).length;
  return /\r?\n$/.test(text) ? n - 1 : n;
}

/* ───────────────────────── keys ───────────────────────── */

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function argsHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex');
}

function keyOf(sid: string, tool: string, args: Record<string, unknown>): string {
  return `${sid}\u0000${tool}\u0000${argsHash(args)}`;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ───────────────────────── edit application ───────────────────────── */

function normalizeEdits(raw: unknown): EditSpec[] | string {
  let list = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return 'edit_file needs `edits`: an array of {old_text, new_text}.';
    }
  }
  if (!Array.isArray(list) || list.length === 0) return 'edit_file needs a non-empty `edits` array of {old_text, new_text}.';
  const out: EditSpec[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] as Record<string, unknown> | null;
    if (!e || typeof e.old_text !== 'string' || typeof e.new_text !== 'string') {
      return `edit ${i + 1}: each edit must be an object with string old_text and new_text.`;
    }
    out.push({ old_text: e.old_text, new_text: e.new_text });
  }
  return out;
}

const LINE_NO_PREFIX = /^\s*\d+\| ?/;

/**
 * Applies edits sequentially. Each old_text must match exactly once; if there is no exact
 * match, a whitespace-tolerant line match (indentation and trailing spaces ignored) is
 * tried and mapped back onto the real lines, re-indenting new_text by the same offset.
 */
export function applyTextEdits(text: string, edits: EditSpec[], relPath: string): EditResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let cur = text;
  for (let i = 0; i < edits.length; i++) {
    const n = i + 1;
    let oldText = edits[i].old_text.replace(/\r?\n/g, eol);
    let newText = edits[i].new_text.replace(/\r?\n/g, eol);
    if (!oldText.trim()) {
      return {
        ok: false,
        reason: `edit ${n}: old_text is empty — include the exact existing line(s) next to the insertion point, or use write_file for a new file.`,
      };
    }
    let res = replaceOnce(cur, oldText, newText, eol);
    if (res.kind === 'none' && looksLineNumbered(oldText)) {
      // The model copied read_file output including the "  42| " prefixes.
      oldText = stripLineNumbers(oldText, eol);
      if (looksLineNumbered(newText)) newText = stripLineNumbers(newText, eol);
      res = replaceOnce(cur, oldText, newText, eol);
    }
    if (res.kind === 'ok') {
      cur = res.text;
      continue;
    }
    if (res.kind === 'many') {
      return {
        ok: false,
        reason: `edit ${n}: old_text matches ${res.count} places in ${relPath} — include more surrounding lines so it matches exactly once.`,
      };
    }
    return {
      ok: false,
      reason: `edit ${n}: old_text not found in ${relPath} — re-read the exact lines with read_file and copy them verbatim (without the line-number prefix).`,
    };
  }
  return { ok: true, text: cur };
}

type ReplaceResult = { kind: 'ok'; text: string } | { kind: 'none' } | { kind: 'many'; count: number };

function replaceOnce(cur: string, oldText: string, newText: string, eol: string): ReplaceResult {
  const first = cur.indexOf(oldText);
  if (first >= 0) {
    const second = cur.indexOf(oldText, first + 1);
    if (second < 0) return { kind: 'ok', text: cur.slice(0, first) + newText + cur.slice(first + oldText.length) };
    let count = 0;
    for (let p = cur.indexOf(oldText); p >= 0; p = cur.indexOf(oldText, p + 1)) count++;
    return { kind: 'many', count };
  }
  return fuzzyReplace(cur, oldText, newText, eol);
}

function norm(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function leadingWs(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? '';
}

function fuzzyReplace(cur: string, oldText: string, newText: string, eol: string): ReplaceResult {
  const fileLines = cur.split(/\r?\n/);
  let oldLines = oldText.split(/\r?\n/);
  let newLines = newText.split(/\r?\n/);
  // Whole-line semantics: drop one trailing newline from both sides, and blank edges of old_text.
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === '') {
    oldLines = oldLines.slice(0, -1);
    if (newLines.length && newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1);
  }
  while (oldLines.length && !oldLines[0].trim()) oldLines = oldLines.slice(1);
  while (oldLines.length && !oldLines[oldLines.length - 1].trim()) oldLines = oldLines.slice(0, -1);
  if (!oldLines.length) return { kind: 'none' };

  const target = oldLines.map(norm);
  const matches: number[] = [];
  for (let p = 0; p + target.length <= fileLines.length; p++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (norm(fileLines[p + j]) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(p);
  }
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'many', count: matches.length };

  const p = matches[0];
  // Map indentation: the model's indentation of old_text vs the file's real indentation.
  const k = oldLines.findIndex((l) => l.trim());
  const given = leadingWs(oldLines[k]);
  const actual = leadingWs(fileLines[p + k]);
  const reindented =
    given === actual
      ? newLines
      : newLines.map((l) => {
          if (!l.trim()) return l;
          if (given && l.startsWith(given)) return actual + l.slice(given.length);
          if (!given) return actual + l;
          return l;
        });
  const out = [...fileLines.slice(0, p), ...reindented, ...fileLines.slice(p + oldLines.length)];
  return { kind: 'ok', text: out.join(eol) };
}

function looksLineNumbered(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => LINE_NO_PREFIX.test(l));
}

function stripLineNumbers(text: string, eol: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(LINE_NO_PREFIX, ''))
    .join(eol);
}
