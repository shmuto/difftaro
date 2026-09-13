/*!
 * difftaro — diff model
 *
 * Everything between the raw edit script and the DOM: ordering the script,
 * pairing deletions with insertions into displayable rows, collapsing
 * unchanged regions, numbering change blocks, folding the overview map's
 * bands and emitting a unified diff. All of it is pure, so it is exercised
 * directly by the node test suite rather than only through a browser.
 *
 * Exposes `DiffModel` on the global object in the browser, and CommonJS
 * exports for the tests.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DiffModel = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function hasIndex(value) {
    return value !== undefined && value !== null;
  }

  function splitLines(text) {
    var lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function normalizeLine(line, options) {
    var value = line;
    if (options.ignoreWhitespace) value = value.replace(/\s+/g, ' ').trim();
    if (options.ignoreCase) value = value.toLowerCase();
    return value;
  }

  function normalizeToken(token, options) {
    var value = token;
    if (options.ignoreWhitespace && /^\s+$/.test(value)) value = ' ';
    if (options.ignoreCase) value = value.toLowerCase();
    return value;
  }

  /**
   * The edit script may emit an insertion before the deletion it replaces.
   * Put deletions first inside every change block, the way diff(1) does, so
   * the exported patch reads conventionally.
   */
  function orderOps(ops) {
    var out = [];
    var index = 0;

    while (index < ops.length) {
      if (ops[index].type === 'equal') {
        out.push(ops[index]);
        index++;
        continue;
      }

      var deletions = [];
      var insertions = [];
      while (index < ops.length && ops[index].type !== 'equal') {
        if (ops[index].type === 'delete') deletions.push(ops[index]);
        else insertions.push(ops[index]);
        index++;
      }
      out = out.concat(deletions, insertions);
    }

    return out;
  }

  /**
   * Turn the flat edit script into displayable rows, pairing deletions with
   * the insertions that replaced them so both views stay aligned.
   */
  function buildRows(ops) {
    var rows = [];
    var index = 0;

    while (index < ops.length) {
      if (ops[index].type === 'equal') {
        rows.push({ kind: 'equal', a: ops[index].a, b: ops[index].b });
        index++;
        continue;
      }

      var deletions = [];
      var insertions = [];
      while (index < ops.length && ops[index].type !== 'equal') {
        if (ops[index].type === 'delete') deletions.push(ops[index].a);
        else insertions.push(ops[index].b);
        index++;
      }

      var pairs = Math.max(deletions.length, insertions.length);
      for (var i = 0; i < pairs; i++) {
        var a = i < deletions.length ? deletions[i] : null;
        var b = i < insertions.length ? insertions[i] : null;
        if (a !== null && b !== null) rows.push({ kind: 'mod', a: a, b: b });
        else if (a !== null) rows.push({ kind: 'del', a: a });
        else rows.push({ kind: 'ins', b: b });
      }
    }

    return rows;
  }

  /** Replace long runs of unchanged rows with collapsible gaps. */
  function collapse(rows, context, expandedGaps) {
    var out = [];
    var index = 0;

    while (index < rows.length) {
      if (rows[index].kind !== 'equal') {
        out.push(rows[index]);
        index++;
        continue;
      }

      var start = index;
      while (index < rows.length && rows[index].kind === 'equal') index++;
      var run = index - start;
      var head = start === 0 ? 0 : context;
      var tail = index === rows.length ? 0 : context;

      if (run <= head + tail + 1) {
        for (var i = start; i < index; i++) out.push(rows[i]);
        continue;
      }

      var gapStart = start + head;
      var gapEnd = index - tail;
      var key = gapStart + ':' + gapEnd;

      if (expandedGaps[key]) {
        for (var j = start; j < index; j++) out.push(rows[j]);
        continue;
      }

      for (var h = start; h < gapStart; h++) out.push(rows[h]);
      out.push({ kind: 'gap', key: key, count: gapEnd - gapStart });
      for (var t = gapEnd; t < index; t++) out.push(rows[t]);
    }

    return out;
  }

  /**
   * Number the change blocks: every run of consecutive changed rows is one
   * block, which is what the overview map and the navigation buttons address.
   * Returns how many there are.
   */
  function assignBlocks(rows) {
    var count = 0;
    var inBlock = false;

    for (var i = 0; i < rows.length; i++) {
      var changed = rows[i].kind === 'del' || rows[i].kind === 'ins' || rows[i].kind === 'mod';
      if (!changed) {
        delete rows[i].block;
        inBlock = false;
        continue;
      }
      if (!inBlock) {
        count++;
        inBlock = true;
      }
      rows[i].block = count - 1;
    }

    return count;
  }

  function summarise(rows) {
    var stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
    rows.forEach(function (row) {
      if (row.kind === 'ins') stats.added++;
      else if (row.kind === 'del') stats.removed++;
      else if (row.kind === 'mod') stats.modified++;
      else if (row.kind === 'equal') stats.unchanged++;
    });
    return stats;
  }

  function toUnifiedDiff(ops, linesA, linesB, settings) {
    if (!ops || !ops.length) return '';

    var context = settings && settings.context !== undefined ? settings.context : 3;
    var hunks = [];
    var hunk = null;
    var pending = [];

    function flush() {
      if (hunk) hunks.push(hunk);
      hunk = null;
    }

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === 'equal') {
        var line = ' ' + linesA[op.a];
        if (hunk) {
          if (hunk.trailing < context) {
            hunk.lines.push(line);
            hunk.countA++;
            hunk.countB++;
            hunk.trailing++;
          } else {
            flush();
            pending = [{ line: line, a: op.a, b: op.b }];
          }
        } else {
          pending.push({ line: line, a: op.a, b: op.b });
          if (pending.length > context) pending.shift();
        }
      } else {
        if (!hunk) {
          var first = pending[0];
          hunk = {
            startA: first ? first.a : (hasIndex(op.a) ? op.a : 0),
            startB: first ? first.b : (hasIndex(op.b) ? op.b : 0),
            countA: pending.length,
            countB: pending.length,
            lines: pending.map(function (entry) { return entry.line; }),
            trailing: 0
          };
          pending = [];
        }
        hunk.trailing = 0;
        if (op.type === 'delete') {
          hunk.lines.push('-' + linesA[op.a]);
          hunk.countA++;
        } else {
          hunk.lines.push('+' + linesB[op.b]);
          hunk.countB++;
        }
      }
    }
    flush();

    if (!hunks.length) return '';

    var nameA = (settings && settings.nameA) || 'original';
    var nameB = (settings && settings.nameB) || 'changed';
    var out = ['--- ' + nameA, '+++ ' + nameB];

    hunks.forEach(function (entry) {
      out.push('@@ -' + (entry.startA + 1) + ',' + entry.countA +
        ' +' + (entry.startB + 1) + ',' + entry.countB + ' @@');
      out.push.apply(out, entry.lines);
    });

    return out.join('\n') + '\n';
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>]/g, function (char) {
      return char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;';
    });
  }

  function plural(word, count) {
    return count === 1 ? word : word + 's';
  }

  function extend(band, next) {
    band.bottom = Math.max(band.bottom, next.bottom);
    band.a = band.a || next.a;
    band.b = band.b || next.b;
    band.from = Math.min(band.from, next.from);
    band.to = Math.max(band.to, next.to);
    band.lines.first = Math.min(band.lines.first, next.lines.first);
    band.lines.last = Math.max(band.lines.last, next.lines.last);
  }

  /** Fold near-neighbours together so a huge diff stays a handful of nodes. */
  function mergeBands(bands, total, maxBands) {
    var gap = Math.max(1, total / maxBands);
    var out = [];

    for (var i = 0; i < bands.length; i++) {
      var last = out[out.length - 1];
      if (last && bands[i].top - last.bottom <= gap) {
        extend(last, bands[i]);
      } else {
        out.push(bands[i]);
      }
    }

    return out;
  }

  function percent(fraction) {
    if (!isFinite(fraction)) return '0.000%';
    return (Math.max(0, Math.min(1, fraction)) * 100).toFixed(3) + '%';
  }

  function bandTitle(band) {
    var lines = band.lines.first === Infinity
      ? ''
      : band.lines.first === band.lines.last
        ? 'line ' + band.lines.first
        : 'lines ' + band.lines.first + '-' + band.lines.last;
    var blocks = band.from === band.to
      ? 'change ' + (band.from + 1)
      : 'changes ' + (band.from + 1) + '-' + (band.to + 1);
    return lines ? blocks + ' (' + lines + ')' : blocks;
  }

  return {
    hasIndex: hasIndex,
    splitLines: splitLines,
    normalizeLine: normalizeLine,
    normalizeToken: normalizeToken,
    orderOps: orderOps,
    buildRows: buildRows,
    collapse: collapse,
    assignBlocks: assignBlocks,
    summarise: summarise,
    toUnifiedDiff: toUnifiedDiff,
    escapeHtml: escapeHtml,
    plural: plural,
    mergeBands: mergeBands,
    percent: percent,
    bandTitle: bandTitle
  };
});
