'use strict';

const test = require('node:test');
const assert = require('node:assert');
const DiffCore = require('../js/diff.js');
const model = require('../js/model.js');

/** The rows the UI would render for two texts, with default options. */
function rowsFor(textA, textB, options) {
  const linesA = model.splitLines(textA);
  const linesB = model.splitLines(textB);
  const opts = options || {};
  const ops = model.orderOps(DiffCore.diff(
    linesA.map((line) => model.normalizeLine(line, opts)),
    linesB.map((line) => model.normalizeLine(line, opts))
  ));
  return { ops, linesA, linesB, rows: model.buildRows(ops) };
}

const kinds = (rows) => rows.map((row) => row.kind).join(',');

test('splitLines drops only the empty line a trailing newline creates', () => {
  assert.deepStrictEqual(model.splitLines('a\nb\n'), ['a', 'b']);
  assert.deepStrictEqual(model.splitLines('a\nb'), ['a', 'b']);
  assert.deepStrictEqual(model.splitLines('a\n\n'), ['a', '']);
  assert.deepStrictEqual(model.splitLines(''), ['']);
  assert.deepStrictEqual(model.splitLines('a\r\nb\rc'), ['a', 'b', 'c']);
});

test('normalizeLine applies only the options that are on', () => {
  const line = '  Foo   Bar  ';
  assert.strictEqual(model.normalizeLine(line, {}), line);
  assert.strictEqual(model.normalizeLine(line, { ignoreWhitespace: true }), 'Foo Bar');
  assert.strictEqual(model.normalizeLine(line, { ignoreCase: true }), '  foo   bar  ');
  assert.strictEqual(
    model.normalizeLine(line, { ignoreWhitespace: true, ignoreCase: true }),
    'foo bar'
  );
});

test('normalizeToken collapses whitespace runs but keeps other tokens', () => {
  assert.strictEqual(model.normalizeToken('\t  ', { ignoreWhitespace: true }), ' ');
  assert.strictEqual(model.normalizeToken('\t  ', {}), '\t  ');
  assert.strictEqual(model.normalizeToken('Foo', { ignoreCase: true }), 'foo');
});

test('orderOps puts deletions before the insertions that replace them', () => {
  const ops = model.orderOps([
    { type: 'equal', a: 0, b: 0 },
    { type: 'insert', b: 1 },
    { type: 'delete', a: 1 },
    { type: 'insert', b: 2 },
    { type: 'delete', a: 2 },
    { type: 'equal', a: 3, b: 3 }
  ]);
  assert.deepStrictEqual(ops.map((op) => op.type),
    ['equal', 'delete', 'delete', 'insert', 'insert', 'equal']);
  // The indices inside each group keep their original order.
  assert.deepStrictEqual(ops.filter((o) => o.type === 'delete').map((o) => o.a), [1, 2]);
  assert.deepStrictEqual(ops.filter((o) => o.type === 'insert').map((o) => o.b), [1, 2]);
});

test('buildRows pairs deletions with insertions so both sides stay aligned', () => {
  const { rows } = rowsFor('a\nb\nc', 'a\nB\nc');
  assert.strictEqual(kinds(rows), 'equal,mod,equal');
  assert.deepStrictEqual(rows[1], { kind: 'mod', a: 1, b: 1 });
});

test('buildRows leaves the surplus side unpaired', () => {
  const { rows } = rowsFor('a\nb\nc\nd', 'a\nB\nC\nD\nE');
  assert.strictEqual(kinds(rows), 'equal,mod,mod,mod,ins');

  const removal = rowsFor('a\nb\nc\nd', 'a\nd');
  assert.strictEqual(kinds(removal.rows), 'equal,del,del,equal');
});

test('buildRows handles one-sided input', () => {
  assert.strictEqual(kinds(rowsFor('', 'x\ny').rows), 'mod,ins');
  assert.strictEqual(kinds(rowsFor('x\ny', '').rows), 'mod,del');
});

test('summarise counts each row kind', () => {
  const { rows } = rowsFor('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepStrictEqual(model.summarise(rows),
    { added: 1, removed: 0, modified: 1, unchanged: 3 });
});

test('assignBlocks numbers runs of consecutive changed rows', () => {
  const rows = [
    { kind: 'equal' }, { kind: 'del' }, { kind: 'ins' },
    { kind: 'equal' }, { kind: 'equal' },
    { kind: 'mod' },
    { kind: 'equal' }
  ];
  assert.strictEqual(model.assignBlocks(rows), 2);
  assert.deepStrictEqual(rows.map((row) => row.block), [undefined, 0, 0, undefined, undefined, 1, undefined]);
});

test('assignBlocks clears stale numbers when rows are re-used', () => {
  const rows = [{ kind: 'del', block: 7 }, { kind: 'equal', block: 7 }];
  assert.strictEqual(model.assignBlocks(rows), 1);
  assert.strictEqual(rows[0].block, 0);
  assert.strictEqual(rows[1].block, undefined);
});

test('collapse keeps context around every change and folds the rest', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ kind: 'equal', a: i, b: i });
  rows[15] = { kind: 'mod', a: 15, b: 15 };

  const out = model.collapse(rows, 3, {});
  assert.strictEqual(out.filter((row) => row.kind === 'gap').length, 2);
  assert.strictEqual(out.filter((row) => row.kind === 'equal').length, 6);

  const gaps = out.filter((row) => row.kind === 'gap');
  assert.strictEqual(gaps[0].count, 12);   // rows 0-11, keeping 12,13,14
  assert.strictEqual(gaps[1].count, 11);   // rows 19-29, keeping 16,17,18
  assert.strictEqual(gaps[0].count + gaps[1].count + 6 + 1, rows.length);
});

test('collapse leaves short unchanged runs alone', () => {
  const rows = [
    { kind: 'mod' },
    { kind: 'equal' }, { kind: 'equal' }, { kind: 'equal' }, { kind: 'equal' },
    { kind: 'mod' }
  ];
  const out = model.collapse(rows, 3, {});
  assert.strictEqual(out.filter((row) => row.kind === 'gap').length, 0,
    'a 4-line run between two changes fits in 3 + 3 lines of context');
  assert.strictEqual(out.length, rows.length);
});

test('collapse expands the gaps the reader has opened', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ kind: 'equal', a: i, b: i });
  rows[15] = { kind: 'mod', a: 15, b: 15 };

  const collapsed = model.collapse(rows, 3, {});
  const key = collapsed.find((row) => row.kind === 'gap').key;
  const expanded = model.collapse(rows, 3, { [key]: true });

  assert.strictEqual(expanded.filter((row) => row.kind === 'gap').length, 1);
  assert.strictEqual(expanded.length, collapsed.length + 12 - 1);
});

test('collapse folds an entirely unchanged diff into one gap', () => {
  const rows = [{ kind: 'equal' }, { kind: 'equal' }, { kind: 'equal' }];
  const out = model.collapse(rows, 3, {});
  assert.deepStrictEqual(out, [{ kind: 'gap', key: '0:3', count: 3 }],
    'with no change to sit next to, there is no context worth keeping');
});

test('escapeHtml neutralises markup in both content and attributes', () => {
  assert.strictEqual(model.escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(model.escapeHtml('a && b'), 'a &amp;&amp; b');
  assert.strictEqual(model.escapeHtml(''), '');
});

test('plural only adds an s when it should', () => {
  assert.strictEqual(model.plural(' line', 1), ' line');
  assert.strictEqual(model.plural(' line', 0), ' lines');
  assert.strictEqual(model.plural(' line', 2), ' lines');
});

/* ---------------------------------------------------------------- *
 * Unified diff
 * ---------------------------------------------------------------- */

test('toUnifiedDiff emits a well-formed patch', () => {
  const a = Array.from({ length: 14 }, (_, i) => 'line ' + (i + 1));
  const b = a.slice();
  b[1] = 'LINE TWO';
  b[11] = 'line 12 changed';
  b.push('line 15');

  const { ops } = rowsFor(a.join('\n'), b.join('\n'));
  const patch = model.toUnifiedDiff(ops, a, b, { context: 3 });
  const lines = patch.split('\n');

  assert.strictEqual(lines[0], '--- original');
  assert.strictEqual(lines[1], '+++ changed');
  assert.strictEqual(patch.endsWith('\n'), true);

  const hunks = lines.filter((line) => line.startsWith('@@'));
  assert.strictEqual(hunks.length, 2);
  assert.strictEqual(hunks[0], '@@ -1,5 +1,5 @@');

  // Every hunk header must match the body it introduces.
  let index = lines.findIndex((line) => line.startsWith('@@'));
  while (index !== -1 && index < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index]);
    assert.ok(header, 'hunk header is well formed: ' + lines[index]);
    let removed = 0;
    let added = 0;
    let cursor = index + 1;
    for (; cursor < lines.length && !lines[cursor].startsWith('@@') && lines[cursor] !== ''; cursor++) {
      if (lines[cursor].startsWith('-')) removed++;
      else if (lines[cursor].startsWith('+')) added++;
      else { removed++; added++; }
    }
    assert.strictEqual(removed, Number(header[2]), 'old line count matches the hunk body');
    assert.strictEqual(added, Number(header[4]), 'new line count matches the hunk body');
    index = lines.findIndex((line, i) => i >= cursor && line.startsWith('@@'));
  }
});

test('toUnifiedDiff applies cleanly: patching a reproduces b', () => {
  const a = Array.from({ length: 40 }, (_, i) => 'row ' + i);
  const b = a.slice();
  b.splice(30, 2);
  b[20] = 'row 20 edited';
  b.splice(5, 0, 'inserted one', 'inserted two');

  const { ops } = rowsFor(a.join('\n'), b.join('\n'));
  const patch = model.toUnifiedDiff(ops, a, b, { context: 3 });
  assert.deepStrictEqual(applyPatch(a, patch), b);
});

test('toUnifiedDiff names the files when they came from disk', () => {
  const { ops } = rowsFor('a', 'b');
  const patch = model.toUnifiedDiff(ops, ['a'], ['b'], { nameA: 'old.txt', nameB: 'new.txt' });
  assert.strictEqual(patch.split('\n')[0], '--- old.txt');
  assert.strictEqual(patch.split('\n')[1], '+++ new.txt');
});

test('toUnifiedDiff returns nothing when there is nothing to patch', () => {
  const { ops } = rowsFor('same\ntext', 'same\ntext');
  assert.strictEqual(model.toUnifiedDiff(ops, ['same', 'text'], ['same', 'text'], {}), '');
  assert.strictEqual(model.toUnifiedDiff([], [], [], {}), '');
});

/** Minimal unified-diff applier, used to prove the patch is real. */
function applyPatch(source, patch) {
  const lines = patch.split('\n');
  const out = [];
  let cursor = 0;

  for (let i = 2; i < lines.length; i++) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]);
    if (!header) continue;
    const start = Number(header[1]) - 1;
    while (cursor < start) out.push(source[cursor++]);

    for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const line = lines[i];
      if (line === '') continue;
      const body = line.slice(1);
      if (line.startsWith('+')) {
        out.push(body);
      } else if (line.startsWith('-')) {
        assert.strictEqual(source[cursor], body, 'context of a removed line matches');
        cursor++;
      } else {
        assert.strictEqual(source[cursor], body, 'context line matches');
        out.push(source[cursor++]);
      }
    }
    i--;
  }

  while (cursor < source.length) out.push(source[cursor++]);
  return out;
}

/* ---------------------------------------------------------------- *
 * Overview map maths
 * ---------------------------------------------------------------- */

const band = (top, bottom, a, b, from, to) => ({
  top, bottom, a, b, from, to,
  lines: { first: from + 1, last: to + 1 }
});

test('mergeBands folds neighbours that are closer than the resolution', () => {
  const bands = model.mergeBands(
    [band(0, 4, true, false, 0, 0), band(5, 9, false, true, 1, 1)], 1000, 100);

  assert.strictEqual(bands.length, 1, 'a 1px gap at 10px resolution merges');
  assert.deepStrictEqual(
    { a: bands[0].a, b: bands[0].b, top: bands[0].top, bottom: bands[0].bottom },
    { a: true, b: true, top: 0, bottom: 9 });
  assert.deepStrictEqual(bands[0].lines, { first: 1, last: 2 });
  assert.strictEqual(bands[0].to, 1);
});

test('mergeBands keeps bands that are genuinely apart', () => {
  const bands = model.mergeBands(
    [band(0, 4, true, false, 0, 0), band(500, 504, false, true, 1, 1)], 1000, 100);
  assert.strictEqual(bands.length, 2);
  assert.strictEqual(bands[0].b, false);
  assert.strictEqual(bands[1].a, false);
});

test('mergeBands keeps a huge diff down to a bounded number of nodes', () => {
  const bands = [];
  for (let i = 0; i < 5000; i++) bands.push(band(i * 20, i * 20 + 10, true, true, i, i));
  const total = 5000 * 20;
  const merged = model.mergeBands(bands, total, 500);
  assert.ok(merged.length <= 500, 'merged down to ' + merged.length + ' bands');
  assert.strictEqual(merged[0].top, 0);
  assert.strictEqual(merged[merged.length - 1].bottom, bands[bands.length - 1].bottom);
});

test('percent clamps to the strip and stays a CSS length', () => {
  assert.strictEqual(model.percent(0), '0.000%');
  assert.strictEqual(model.percent(0.5), '50.000%');
  assert.strictEqual(model.percent(1), '100.000%');
  assert.strictEqual(model.percent(-3), '0.000%');
  assert.strictEqual(model.percent(42), '100.000%');
  assert.strictEqual(model.percent(NaN), '0.000%', 'an empty pane must not produce "NaN%"');
  assert.strictEqual(model.percent(Infinity), '0.000%');
});

test('bandTitle names the change and the lines it covers', () => {
  assert.strictEqual(model.bandTitle({ from: 0, to: 0, lines: { first: 5, last: 6 } }),
    'change 1 (lines 5-6)');
  assert.strictEqual(model.bandTitle({ from: 2, to: 4, lines: { first: 9, last: 9 } }),
    'changes 3-5 (line 9)');
  assert.strictEqual(model.bandTitle({ from: 0, to: 0, lines: { first: Infinity, last: 0 } }),
    'change 1');
});
