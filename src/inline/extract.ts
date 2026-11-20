/** Pure helpers for inline edit (no vscode import). */

/** Code from a (possibly still streaming) model reply: after the first ``` line, up to the closing fence. */
export function extractCode(text: string): { code: string; fenced: boolean; closed: boolean } {
  const lines = text.split(/\r?\n/);
  const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/;
  const i = lines.findIndex((line) => opening.test(line));
  if (i < 0) {
    if (text.trimStart().startsWith('```')) return { code: '', fenced: true, closed: false };
    return { code: text, fenced: false, closed: false };
  }
  const marker = opening.exec(lines[i])![1];
  let body = lines.slice(i + 1);
  const closing = new RegExp('^' + marker[0] + '{' + marker.length + ',}$');
  const j = body.findIndex((line) => closing.test(line.trim()));
  if (j >= 0) return { code: body.slice(0, j).join('\n'), fenced: true, closed: true };
  if (body.length && new RegExp('^' + marker[0] + '{1,' + (marker.length - 1) + '}$').test(body[body.length - 1])) body = body.slice(0, -1);
  return { code: body.join('\n'), fenced: true, closed: false };
}

function baseIndent(lines: string[]): string | undefined {
  const l = lines.find((x) => x.trim() !== '');
  return l === undefined ? undefined : /^[ \t]*/.exec(l)![0];
}

/** Re-indent `code` so its first non-empty line has the same indentation as `originalFirst`. */
export function reindent(code: string, originalFirst: string): string {
  const lines = code.split('\n');
  const have = baseIndent(lines);
  const want = /^[ \t]*/.exec(originalFirst)![0];
  if (have === undefined || have === want) return code;
  // a first line that is only whitespace (still streaming) gives no reliable signal
  return lines
    .map((l) => {
      if (l.trim() === '') return l;
      return want + (l.startsWith(have) ? l.slice(have.length) : l.trimStart());
    })
    .join('\n');
}

const KEYWORDS = new Set(['the', 'and', 'for', 'not', 'null', 'true', 'false', 'None', 'True', 'False', 'self', 'this', 'return', 'const', 'let', 'var', 'function', 'class', 'def', 'if', 'else', 'elif', 'while', 'with', 'from', 'import', 'export', 'new', 'async', 'await', 'try', 'catch', 'except', 'finally', 'raise', 'throw', 'yield', 'lambda', 'pass', 'break', 'continue', 'int', 'str', 'bool', 'string', 'number', 'void', 'any', 'undefined', 'print', 'len', 'range', 'type', 'in', 'is', 'as', 'or']);

export function identifiers(code: string, max = 30): string[] {
  const seen = new Set<string>();
  for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    if (!KEYWORDS.has(m[0])) seen.add(m[0]);
    if (seen.size >= max) break;
  }
  return [...seen];
}
