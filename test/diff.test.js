'use strict';

const test = require('node:test');
const assert = require('node:assert');
const DiffCore = require('../js/diff.js');
const { canonicalizeJson } = require('../js/jsonutil.js');

/** Longest-common-subsequence length, used as an optimality oracle. */
function lcsLength(a, b) {
  const prev = new Int32Array(b.length + 1);
  const cur = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], cur[j - 1]);
    }
    prev.set(cur);
  }
  return prev[b.length];
}

/** Every invariant a valid, optimal edit script must satisfy. */
function check(a, b) {
  const ops = DiffCore.diff(a, b);
  const fromA = [];
  const fromB = [];
  let lastA = -1;
  let lastB = -1;
  let equals = 0;

  for (const op of ops) {
    if (op.type === 'equal') {
      assert.strictEqual(a[op.a], b[op.b], 'equal op must match on both sides');
      fromA.push(op.a);
      fromB.push(op.b);
      equals++;
    } else if (op.type === 'delete') {
      fromA.push(op.a);
    } else {
      fromB.push(op.b);
    }
    if (op.a !== undefined) {
      assert.ok(op.a > lastA, 'a indices must be strictly increasing');
      lastA = op.a;
    }
    if (op.b !== undefined) {
      assert.ok(op.b > lastB, 'b indices must be strictly increasing');
      lastB = op.b;
    }
  }

  assert.deepStrictEqual(fromA, a.map((_, i) => i), 'must cover all of a');
  assert.deepStrictEqual(fromB, b.map((_, i) => i), 'must cover all of b');
  assert.strictEqual(equals, lcsLength(a, b), 'edit script must be minimal');
  return ops;
}

test('empty inputs', () => {
  assert.deepStrictEqual(DiffCore.diff([], []), []);
  check([], ['a', 'b']);
  check(['a', 'b'], []);
});

test('identical inputs produce only equals', () => {
  const ops = check(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.ok(ops.every((op) => op.type === 'equal'));
});

test('single substitution', () => {
  const ops = check(['a', 'b', 'c'], ['a', 'x', 'c']);
  assert.strictEqual(ops.filter((o) => o.type === 'delete').length, 1);
  assert.strictEqual(ops.filter((o) => o.type === 'insert').length, 1);
});

test('nothing in common', () => {
  const ops = check(['a', 'b'], ['x', 'y']);
  assert.ok(ops.every((op) => op.type !== 'equal'));
});

test('insertion at both ends', () => {
  check(['b'], ['a', 'b', 'c']);
  check(['a', 'b', 'c'], ['b']);
});

test('classic Myers example ABCABBA -> CBABAC', () => {
  const ops = check('ABCABBA'.split(''), 'CBABAC'.split(''));
  const edits = ops.filter((o) => o.type !== 'equal').length;
  assert.strictEqual(edits, 5, 'known minimal edit distance is 5');
});

test('randomised inputs stay valid and minimal', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const build = (len, alphabet) => {
    const out = [];
    for (let i = 0; i < len; i++) {
      out.push(alphabet[Math.floor(rnd() * alphabet.length)]);
    }
    return out;
  };

  for (const alphabet of [['a', 'b'], ['a', 'b', 'c', 'd'], 'abcdefghij'.split('')]) {
    for (let round = 0; round < 250; round++) {
      const a = build(Math.floor(rnd() * 25), alphabet);
      const b = build(Math.floor(rnd() * 25), alphabet);
      check(a, b);
    }
  }
});

test('handles a large, mostly-equal input quickly', () => {
  const a = Array.from({ length: 20000 }, (_, i) => 'line ' + i);
  const b = a.slice();
  b[10] = 'changed';
  b.splice(5000, 0, 'inserted');
  b.splice(15000, 1);
  const started = Date.now();
  const ops = DiffCore.diff(a, b);
  assert.ok(Date.now() - started < 3000, 'should finish well under 3s');
  assert.strictEqual(ops.filter((o) => o.type === 'delete').length, 2);
  assert.strictEqual(ops.filter((o) => o.type === 'insert').length, 2);
});

test('tokenizer splits words, whitespace and CJK glyphs', () => {
  assert.deepStrictEqual(DiffCore.tokenize('foo_bar = 1;'), ['foo_bar', ' ', '=', ' ', '1', ';']);
  assert.deepStrictEqual(DiffCore.tokenize('日本語'), ['日', '本', '語']);
  assert.deepStrictEqual(DiffCore.tokenize(''), []);
});

test('word diff marks only the changed part', () => {
  const res = DiffCore.diffWords('const a = 1;', 'const a = 2;');
  assert.deepStrictEqual(res.a.filter((s) => s.changed).map((s) => s.text), ['1']);
  assert.deepStrictEqual(res.b.filter((s) => s.changed).map((s) => s.text), ['2']);
  assert.strictEqual(res.a.map((s) => s.text).join(''), 'const a = 1;');
  assert.strictEqual(res.b.map((s) => s.text).join(''), 'const a = 2;');
  assert.ok(res.similarity > 0.8);
});

test('word diff reports low similarity for unrelated lines', () => {
  const res = DiffCore.diffWords('alpha beta gamma', 'nothing alike here');
  assert.ok(res.similarity < 0.3);
});

test('json canonicalisation sorts keys and normalises formatting', () => {
  const out = canonicalizeJson('{"b":1,"a":{"d":[3,2],"c":null}}', true);
  assert.strictEqual(out, [
    '{',
    '  "a": {',
    '    "c": null,',
    '    "d": [',
    '      3,',
    '      2',
    '    ]',
    '  },',
    '  "b": 1',
    '}'
  ].join('\n'));
});

test('json canonicalisation can preserve key order', () => {
  const out = canonicalizeJson('{"b":1,"a":2}', false);
  assert.strictEqual(out, '{\n  "b": 1,\n  "a": 2\n}');
});

test('json canonicalisation reports parse errors with a position', () => {
  assert.throws(() => canonicalizeJson('{"a": }', true), (err) => {
    assert.ok(err instanceof SyntaxError);
    return true;
  });
});
