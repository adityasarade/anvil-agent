import { describe, it, expect } from 'vitest';
import { extractCode, reindent, identifiers } from '../src/inline/extract';

describe('extractCode', () => {
  it('raw text without fence', () => expect(extractCode('x = 1').code).toBe('x = 1'));
  it('fence only so far', () => expect(extractCode('```python').code).toBe(''));
  it('streams inside fence', () => expect(extractCode('Sure:\n```py\na = 1\nb =').code).toBe('a = 1\nb ='));
  it('stops at closing fence', () => {
    const r = extractCode('```py\na\nb\n```\nDone.');
    expect(r).toEqual({ code: 'a\nb', fenced: true, closed: true });
  });
  it('hides partial closing fence', () => expect(extractCode('```\na\n``').code).toBe('a'));
});

describe('reindent', () => {
  it('adds base indentation', () => expect(reindent('a\n  b', '    x')).toBe('    a\n      b'));
  it('removes extra indentation', () => expect(reindent('    a\n      b', '  x')).toBe('  a\n    b'));
  it('noop when equal', () => expect(reindent('  a', '  x')).toBe('  a'));
});

describe('identifiers', () => {
  it('skips keywords', () => expect(identifiers('return foo_bar(self, Baz)')).toEqual(['foo_bar', 'Baz']));
});
