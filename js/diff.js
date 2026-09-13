/*!
 * difftaro — diff core
 *
 * Dependency-free implementation of Myers' O(ND) difference algorithm
 * (linear space variant, Myers 1986 §4b) plus token-level helpers.
 *
 * Usable both as a classic browser script (exposes `DiffCore` on the global
 * object) and as a CommonJS module (for the node test suite).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DiffCore = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EQUAL = 'equal';
  var DELETE = 'delete';
  var INSERT = 'insert';

  /**
   * Diff two sequences of primitives (compared with ===).
   * Returns a flat, ordered list of edits:
   *   { type: 'equal',  a: indexInA, b: indexInB }
   *   { type: 'delete', a: indexInA }
   *   { type: 'insert', b: indexInB }
   */
  function diff(a, b) {
    var out = [];
    walk(a, b, 0, a.length, 0, b.length, out);
    return out;
  }

  function walk(a, b, lo1, hi1, lo2, hi2, out) {
    // Strip the common prefix.
    while (lo1 < hi1 && lo2 < hi2 && a[lo1] === b[lo2]) {
      out.push({ type: EQUAL, a: lo1, b: lo2 });
      lo1++;
      lo2++;
    }

    // Strip the common suffix (emitted after the middle part).
    var tail = [];
    while (lo1 < hi1 && lo2 < hi2 && a[hi1 - 1] === b[hi2 - 1]) {
      hi1--;
      hi2--;
      tail.push({ type: EQUAL, a: hi1, b: hi2 });
    }
    tail.reverse();

    var i, j;
    if (lo1 === hi1) {
      for (j = lo2; j < hi2; j++) out.push({ type: INSERT, b: j });
    } else if (lo2 === hi2) {
      for (i = lo1; i < hi1; i++) out.push({ type: DELETE, a: i });
    } else {
      var snake = middleSnake(a, b, lo1, hi1, lo2, hi2);
      var degenerate = !snake ||
        (snake.x0 === hi1 - lo1 && snake.y0 === hi2 - lo2) ||
        (snake.x1 === 0 && snake.y1 === 0);
      if (degenerate) {
        // Should not happen; kept so a pathological input degrades into a
        // valid (if coarse) diff instead of recursing forever.
        for (i = lo1; i < hi1; i++) out.push({ type: DELETE, a: i });
        for (j = lo2; j < hi2; j++) out.push({ type: INSERT, b: j });
      } else {
        walk(a, b, lo1, lo1 + snake.x0, lo2, lo2 + snake.y0, out);
        for (var s = 0; s < snake.x1 - snake.x0; s++) {
          out.push({ type: EQUAL, a: lo1 + snake.x0 + s, b: lo2 + snake.y0 + s });
        }
        walk(a, b, lo1 + snake.x1, hi1, lo2 + snake.y1, hi2, out);
      }
    }

    for (var t = 0; t < tail.length; t++) out.push(tail[t]);
  }

  /**
   * Find the middle snake of the optimal edit script for a[lo1,hi1) vs
   * b[lo2,hi2) by running the greedy edit-graph search forwards from (0,0)
   * and backwards from (N,M) until the two frontiers overlap.
   *
   * Coordinates in the result are relative to (lo1, lo2).
   */
  function middleSnake(a, b, lo1, hi1, lo2, hi2) {
    var N = hi1 - lo1;
    var M = hi2 - lo2;
    var delta = N - M;
    var odd = (delta & 1) !== 0;
    var maxD = Math.ceil((N + M) / 2);
    var offset = N + M + 1;
    var size = 2 * (N + M) + 3;
    var vf = new Int32Array(size);
    var vr = new Int32Array(size);

    vf[offset + 1] = 0;
    vr[offset + delta + 1] = N + 1;

    for (var d = 0; d <= maxD; d++) {
      var k, idx, x, y, sx, sy;

      // Forward frontier: furthest reaching x on each diagonal k = x - y.
      for (k = -d; k <= d; k += 2) {
        idx = offset + k;
        if (k === -d || (k !== d && vf[idx - 1] < vf[idx + 1])) {
          x = vf[idx + 1];
        } else {
          x = vf[idx - 1] + 1;
        }
        y = x - k;
        sx = x;
        sy = y;
        while (x < N && y < M && a[lo1 + x] === b[lo2 + y]) { x++; y++; }
        vf[idx] = x;
        // Overlap with the reverse frontier of the previous round.
        if (odd && k >= delta - (d - 1) && k <= delta + (d - 1) && x >= vr[idx]) {
          return { x0: sx, y0: sy, x1: x, y1: y };
        }
      }

      // Reverse frontier: nearest reaching x on each diagonal, from (N, M).
      for (k = delta - d; k <= delta + d; k += 2) {
        idx = offset + k;
        if (k === delta - d) {
          x = vr[idx + 1] - 1;
        } else if (k === delta + d) {
          x = vr[idx - 1];
        } else {
          x = Math.min(vr[idx + 1] - 1, vr[idx - 1]);
        }
        y = x - k;
        sx = x;
        sy = y;
        while (x > 0 && y > 0 && a[lo1 + x - 1] === b[lo2 + y - 1]) { x--; y--; }
        vr[idx] = x;
        if (!odd && k >= -d && k <= d && vf[idx] >= x) {
          return { x0: x, y0: y, x1: sx, y1: sy };
        }
      }
    }

    return null;
  }

  /**
   * Split a line into diffable tokens: identifier-ish runs, whitespace runs,
   * and every other character on its own (so CJK text highlights per glyph).
   */
  var TOKEN_RE = /[A-Za-z0-9_À-ɏͰ-ϿЀ-ӿ]+|\s+|[\s\S]/gu;

  function tokenize(line) {
    if (!line) return [];
    return line.match(TOKEN_RE) || [];
  }

  /**
   * Diff two lines token by token and return the segments to render on each
   * side: { a: [{text, changed}], b: [{text, changed}], similarity }.
   * `normalize` (optional) maps a token to the key used for comparison.
   */
  function diffWords(lineA, lineB, normalize) {
    var ta = tokenize(lineA);
    var tb = tokenize(lineB);
    var ka = normalize ? ta.map(normalize) : ta;
    var kb = normalize ? tb.map(normalize) : tb;
    var ops = diff(ka, kb);

    var segsA = [];
    var segsB = [];
    var common = 0;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === EQUAL) {
        push(segsA, ta[op.a], false);
        push(segsB, tb[op.b], false);
        common += ta[op.a].length;
      } else if (op.type === DELETE) {
        push(segsA, ta[op.a], true);
      } else {
        push(segsB, tb[op.b], true);
      }
    }

    var total = (lineA ? lineA.length : 0) + (lineB ? lineB.length : 0);
    return {
      a: segsA,
      b: segsB,
      similarity: total === 0 ? 1 : (2 * common) / total
    };
  }

  function push(list, text, changed) {
    var last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text: text, changed: changed });
  }

  return {
    EQUAL: EQUAL,
    DELETE: DELETE,
    INSERT: INSERT,
    diff: diff,
    tokenize: tokenize,
    diffWords: diffWords
  };
});
