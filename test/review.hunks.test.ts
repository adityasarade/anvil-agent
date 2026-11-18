import { describe, it, expect } from 'vitest';
import { computeHunks, applyHunks, hunkEdits, applyTextEdits } from '../src/review/hunks';
import { buildView, pickHunk } from '../src/review/render';

const all = (h: { index: number }[]) => h.map((x) => x.index);

function check(orig: string, prop: string) {
  const hunks = computeHunks(orig, prop);
  expect(applyHunks(orig, hunks, all(hunks))).toBe(prop);
  expect(applyHunks(orig, hunks, [])).toBe(orig);
  expect(applyTextEdits(orig, hunkEdits(orig, hunks, all(hunks)))).toBe(prop);
  expect(applyTextEdits(orig, hunkEdits(orig, hunks, []))).toBe(orig);
  // every subset: edits agree with applyHunks
  if (hunks.length <= 6) {
    for (let mask = 0; mask < 1 << hunks.length; mask++) {
      const acc = hunks.filter((_, i) => mask & (1 << i)).map((h) => h.index);
      expect(applyTextEdits(orig, hunkEdits(orig, hunks, acc))).toBe(applyHunks(orig, hunks, acc));
    }
  }
  return hunks;
}

describe('computeHunks', () => {
  it('identical -> no hunks', () => expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([]));
  it('replacement', () => {
    const h = check('a\nb\nc\n', 'a\nX\nc\n');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ index: 0, oldStart: 2, oldLines: ['b'], newStart: 2, newLines: ['X'] });
  });
  it('pure insertion', () => {
    const h = check('a\nb\n', 'a\nnew\nb\n');
    expect(h).toHaveLength(1);
    expect(h[0].oldLines).toEqual([]);
    expect(h[0].newLines).toEqual(['new']);
    expect(h[0].oldStart).toBe(2);
  });
  it('pure deletion', () => {
    const h = check('a\nb\nc\n', 'a\nc\n');
    expect(h[0].oldLines).toEqual(['b']);
    expect(h[0].newLines).toEqual([]);
  });
  it('deletion at start and end', () => {
    check('a\nb\nc\n', 'b\nc\n');
    check('a\nb\nc\n', 'a\nb\n');
    check('a\nb\nc', 'a\nb');
    check('a', '');
  });
  it('merges changes separated by one unchanged line, not two', () => {
    expect(check('1\n2\n3\n4\n5\n', 'A\n2\nB\n4\n5\n')).toHaveLength(1);
    expect(check('1\n2\n3\n4\n5\n', 'A\n2\n3\nB\n5\n')).toHaveLength(2);
  });
  it('new file is one added hunk', () => {
    const h = check('', 'x\ny\n');
    expect(h).toHaveLength(1);
    expect(h[0].oldLines).toEqual([]);
    expect(h[0].newLines).toEqual(['x', 'y', '']);
    check('', 'x');
    check('', '');
  });
  it('CRLF preserved', () => {
    const o = 'a\r\nb\r\nc\r\n';
    const p = 'a\r\nX\r\nc\r\nd\r\n';
    const h = check(o, p);
    expect(applyHunks(o, h, all(h))).toBe(p);
    expect(applyHunks(o, h, [])).toBe(o);
  });
  it('missing trailing newline', () => {
    check('a\nb', 'a\nb\n');
    check('a\nb\n', 'a\nb');
    check('a\nb', 'a\nc');
  });
  it('random edits (property)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let t = 0; t < 400; t++) {
      const eol = rnd() < 0.3 ? '\r\n' : '\n';
      const n = Math.floor(rnd() * 12);
      const base = Array.from({ length: n }, (_, i) => 'l' + Math.floor(rnd() * 6) + '_' + i);
      let prop = base.slice();
      const edits = Math.floor(rnd() * 5);
      for (let e = 0; e < edits; e++) {
        const pos = Math.floor(rnd() * (prop.length + 1));
        const r = rnd();
        if (r < 0.34) prop.splice(pos, 1);
        else if (r < 0.67) prop.splice(pos, 0, 'new' + Math.floor(rnd() * 100));
        else if (pos < prop.length) prop[pos] = 'chg' + Math.floor(rnd() * 100);
      }
      const trailO = rnd() < 0.5 ? eol : '';
      const trailP = rnd() < 0.5 ? eol : '';
      const o = base.length ? base.join(eol) + trailO : '';
      const peol = o.includes(eol) ? eol : '\n'; // single-line originals carry no EOL info
      const p = prop.length ? prop.join(peol) + (trailP && peol) : '';
      check(o, p);
    }
  });
});

describe('render', () => {
  it('builds unified view and picks hunks', () => {
    const o = 'a\nb\nc\nd\ne\nf\n';
    const p = 'a\nB\nc\nd\ne\nF\nG\n';
    const hunks = computeHunks(o, p);
    expect(hunks).toHaveLength(2);
    const v = buildView(o, hunks);
    expect(v.text.split('\n').slice(0, 4)).toEqual(['a', 'b', 'B', 'c']);
    expect(v.regions[0]).toMatchObject({ start: 1, removed: 1, added: 1 });
    expect(pickHunk(v.regions, ['accepted', 'pending'], 1)).toBe(0);
    expect(pickHunk(v.regions, ['accepted', 'pending'], 0)).toBe(1);
    expect(pickHunk(v.regions, ['accepted', 'accepted'], 0)).toBeUndefined();
  });
});
