/*!
 * difftaro — application shell
 *
 * Wires the DOM to the diff core: reads the two inputs (typed, pasted or
 * dropped as files), normalises them according to the options, runs the diff
 * and renders it either side by side or inline.
 */
(function () {
  'use strict';

  var CONTEXT = 3;             // unchanged lines kept around a change
  var MAX_ROWS = 20000;        // soft cap before we ask the user to confirm
  var AUTO_LIMIT = 1000000;    // characters; above this, compare on demand only
  var STORE_KEY = 'difftaro:v1';
  var STORE_INPUT_LIMIT = 200000;
  var WORD_SIMILARITY = 0.3;   // below this, a changed line is not word-diffed

  var options = {
    mode: 'text',
    view: 'split',
    ignoreWhitespace: false,
    ignoreCase: false,
    wordLevel: true,
    onlyChanges: false,
    wrap: true,
    sortKeys: true
  };

  var theme = 'auto';
  var expandedGaps = Object.create(null);
  var renderAll = false;
  var debounceTimer = null;
  var sides = {};
  var els = {};
  var current = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    els.output = document.getElementById('output');
    els.stats = document.getElementById('stats');
    els.notice = document.getElementById('notice');
    els.compare = document.getElementById('compareButton');
    els.copy = document.getElementById('copyButton');
    els.swap = document.getElementById('swapButton');
    els.themeToggle = document.getElementById('themeToggle');
    els.themeLabel = document.getElementById('themeLabel');

    ['a', 'b'].forEach(function (key) {
      var root = document.querySelector('.editor[data-side="' + key + '"]');
      sides[key] = {
        root: root,
        textarea: root.querySelector('textarea'),
        file: root.querySelector('[data-role="file"]'),
        filename: root.querySelector('[data-role="filename"]'),
        counts: root.querySelector('[data-role="counts"]'),
        error: root.querySelector('[data-role="error"]')
      };
      bindEditor(key);
    });

    bindControls();
    restore();
    applyTheme();
    syncControls();
    run(true);
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function bindEditor(key) {
    var side = sides[key];

    side.textarea.addEventListener('input', function () {
      side.filename.textContent = '';
      updateCounts(key);
      schedule();
    });

    side.root.querySelector('[data-action="open"]').addEventListener('click', function () {
      side.file.click();
    });

    side.root.querySelector('[data-action="clear"]').addEventListener('click', function () {
      side.textarea.value = '';
      side.filename.textContent = '';
      side.error.textContent = '';
      updateCounts(key);
      run(true);
      side.textarea.focus();
    });

    side.file.addEventListener('change', function () {
      if (side.file.files && side.file.files[0]) loadFile(key, side.file.files[0]);
      side.file.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      side.root.addEventListener(type, function (event) {
        event.preventDefault();
        side.root.classList.add('is-dragover');
      });
    });

    ['dragleave', 'drop'].forEach(function (type) {
      side.root.addEventListener(type, function (event) {
        if (type === 'dragleave' && side.root.contains(event.relatedTarget)) return;
        side.root.classList.remove('is-dragover');
      });
    });

    side.root.addEventListener('drop', function (event) {
      event.preventDefault();
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) loadFile(key, file);
    });
  }

  function bindControls() {
    document.querySelectorAll('.segmented [data-mode]').forEach(function (button) {
      button.addEventListener('click', function () {
        options.mode = button.getAttribute('data-mode');
        syncControls();
        run(true);
      });
    });

    document.querySelectorAll('[data-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        options.view = button.getAttribute('data-view');
        syncControls();
        render();
        persist();
      });
    });

    document.querySelectorAll('[data-option]').forEach(function (input) {
      input.addEventListener('change', function () {
        var name = input.getAttribute('data-option');
        options[name] = input.checked;
        if (name === 'wrap' || name === 'onlyChanges' || name === 'wordLevel') {
          expandedGaps = Object.create(null);
          render();
          persist();
        } else {
          run(true);
        }
      });
    });

    els.compare.addEventListener('click', function () { run(true); });
    els.swap.addEventListener('click', swap);
    els.copy.addEventListener('click', copyUnified);
    els.themeToggle.addEventListener('click', function () {
      theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
      applyTheme();
      persist();
    });

    els.output.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('.gap-button');
      if (!button) return;
      expandedGaps[button.getAttribute('data-gap')] = true;
      render();
    });

    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        run(true);
      } else if (event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        swap();
      }
    });
  }

  function syncControls() {
    document.body.setAttribute('data-mode', options.mode);
    document.querySelectorAll('.segmented [data-mode]').forEach(function (button) {
      var active = button.getAttribute('data-mode') === options.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-view]').forEach(function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-view') === options.view);
    });
    document.querySelectorAll('[data-option]').forEach(function (input) {
      input.checked = !!options[input.getAttribute('data-option')];
    });
    ['a', 'b'].forEach(updateCounts);
  }

  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    els.themeLabel.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
  }

  function swap() {
    var a = sides.a;
    var b = sides.b;
    var text = a.textarea.value;
    var name = a.filename.textContent;
    a.textarea.value = b.textarea.value;
    a.filename.textContent = b.filename.textContent;
    b.textarea.value = text;
    b.filename.textContent = name;
    run(true);
  }

  function loadFile(key, file) {
    var side = sides[key];
    var reader = new FileReader();
    side.error.textContent = '';
    reader.onerror = function () {
      side.error.textContent = 'Could not read ' + file.name;
    };
    reader.onload = function () {
      var text = String(reader.result);
      if (text.indexOf('\u0000') !== -1) {
        side.error.textContent = file.name + ' looks binary; comparing it as text.';
      }
      side.textarea.value = text;
      side.filename.textContent = file.name;
      updateCounts(key);
      run(true);
    };
    reader.readAsText(file);
  }

  function updateCounts(key) {
    var value = sides[key].textarea.value;
    var lines = value === '' ? 0 : splitLines(value).length;
    sides[key].counts.textContent =
      lines.toLocaleString() + plural(' line', lines) + ' · ' +
      value.length.toLocaleString() + plural(' character', value.length);
  }

  function plural(word, count) {
    return count === 1 ? word : word + 's';
  }

  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { run(false); }, 250);
  }

  /* ------------------------------------------------------------------ *
   * Diffing
   * ------------------------------------------------------------------ */

  function run(force) {
    clearTimeout(debounceTimer);
    persist();

    var rawA = sides.a.textarea.value;
    var rawB = sides.b.textarea.value;

    if (!force && rawA.length + rawB.length > AUTO_LIMIT) {
      current = null;
      showNotice('These inputs are large, so live comparison is paused. ' +
        'Press Compare (Ctrl/Cmd + Enter) to run it.');
      els.stats.textContent = '';
      els.output.innerHTML = '';
      return;
    }

    if (rawA === '' && rawB === '') {
      current = null;
      hideNotice();
      els.stats.textContent = '';
      els.output.innerHTML = '<p class="empty-state">Paste or drop two files to compare them.</p>';
      return;
    }

    var textA = rawA;
    var textB = rawB;
    var problems = [];

    if (options.mode === 'json') {
      var parsedA = toCanonicalJson(rawA, 'a');
      var parsedB = toCanonicalJson(rawB, 'b');
      textA = parsedA.text;
      textB = parsedB.text;
      if (parsedA.error) problems.push('Original: ' + parsedA.error);
      if (parsedB.error) problems.push('Changed: ' + parsedB.error);
    } else {
      sides.a.error.textContent = '';
      sides.b.error.textContent = '';
    }

    var linesA = splitLines(textA);
    var linesB = splitLines(textB);
    var ops = orderOps(window.DiffCore.diff(linesA.map(normalize), linesB.map(normalize)));

    current = {
      linesA: linesA,
      linesB: linesB,
      ops: ops,
      rows: buildRows(ops)
    };

    expandedGaps = Object.create(null);
    renderAll = false;

    if (problems.length) {
      showNotice('Invalid JSON, comparing the raw text instead — ' + problems.join(' · '));
    } else {
      hideNotice();
    }

    render();
  }

  function toCanonicalJson(raw, key) {
    var side = sides[key];
    side.error.textContent = '';
    if (raw.trim() === '') return { text: raw, error: null };
    try {
      return { text: window.JsonUtil.canonicalizeJson(raw, options.sortKeys), error: null };
    } catch (error) {
      var message = window.JsonUtil.describeParseError(error, raw);
      side.error.textContent = message;
      return { text: raw, error: message };
    }
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

  function splitLines(text) {
    var lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function normalize(line) {
    var value = line;
    if (options.ignoreWhitespace) value = value.replace(/\s+/g, ' ').trim();
    if (options.ignoreCase) value = value.toLowerCase();
    return value;
  }

  function normalizeToken(token) {
    var value = token;
    if (options.ignoreWhitespace && /^\s+$/.test(value)) value = ' ';
    if (options.ignoreCase) value = value.toLowerCase();
    return value;
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
  function collapse(rows) {
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
      var head = start === 0 ? 0 : CONTEXT;
      var tail = index === rows.length ? 0 : CONTEXT;

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

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function render() {
    if (!current) return;

    var rows = options.onlyChanges ? collapse(current.rows) : current.rows;
    var stats = summarise(current.rows);
    renderStats(stats);

    if (stats.added === 0 && stats.removed === 0 && stats.modified === 0) {
      els.output.innerHTML = '<p class="empty-state">No differences' +
        (options.mode === 'json' ? ' in the JSON structure.' : '.') + '</p>';
      return;
    }

    var limited = !renderAll && rows.length > MAX_ROWS;
    var shown = limited ? rows.slice(0, MAX_ROWS) : rows;

    els.output.innerHTML = options.view === 'split' ? renderSplit(shown) : renderInline(shown);

    if (limited) {
      showNotice('Showing the first ' + MAX_ROWS.toLocaleString() + ' of ' +
        rows.length.toLocaleString() + ' lines.',
        'Render everything', function () {
          renderAll = true;
          hideNotice();
          render();
        });
    }
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

  function renderStats(stats) {
    if (stats.added === 0 && stats.removed === 0 && stats.modified === 0) {
      els.stats.textContent = 'The two sides are identical' +
        (options.mode === 'json' ? ' once the JSON is canonicalised.' : '.');
      return;
    }
    els.stats.innerHTML =
      '<span class="stats__ins">+' + (stats.added + stats.modified) + ' added</span>' +
      '<span class="stats__del">−' + (stats.removed + stats.modified) + ' removed</span>' +
      '<span>' + stats.modified + ' modified</span>' +
      '<span>' + stats.unchanged + ' unchanged</span>';
  }

  function renderSplit(rows) {
    var html = '<table class="diff diff--split' + (options.wrap ? ' is-wrapped' : '') + '">' +
      '<colgroup><col class="col-ln"><col class="col-sign"><col>' +
      '<col class="col-ln"><col class="col-sign"><col></colgroup><tbody>';

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.kind === 'gap') {
        html += gapRow(row, 6);
        continue;
      }

      var cells = contentFor(row);
      html += '<tr class="row row--' + row.kind + '">' +
        '<td class="ln">' + (hasIndex(row.a) ? row.a + 1 : '') + '</td>' +
        '<td class="sign side--a">' + (row.kind === 'del' || row.kind === 'mod' ? '−' : '') + '</td>' +
        '<td class="code side--a">' + cells.a + '</td>' +
        '<td class="ln">' + (hasIndex(row.b) ? row.b + 1 : '') + '</td>' +
        '<td class="sign side--b">' + (row.kind === 'ins' || row.kind === 'mod' ? '+' : '') + '</td>' +
        '<td class="code side--b">' + cells.b + '</td>' +
        '</tr>';
    }

    return html + '</tbody></table>';
  }

  function renderInline(rows) {
    var html = '<table class="diff diff--inline' + (options.wrap ? ' is-wrapped' : '') + '">' +
      '<colgroup><col class="col-ln"><col class="col-ln"><col class="col-sign"><col></colgroup><tbody>';

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.kind === 'gap') {
        html += gapRow(row, 4);
        continue;
      }

      var cells = contentFor(row);
      if (row.kind === 'equal') {
        html += inlineRow('equal', row.a + 1, row.b + 1, '', cells.a);
      } else if (row.kind === 'del') {
        html += inlineRow('del', row.a + 1, '', '−', cells.a);
      } else if (row.kind === 'ins') {
        html += inlineRow('ins', '', row.b + 1, '+', cells.b);
      } else {
        html += inlineRow('del', row.a + 1, '', '−', cells.a);
        html += inlineRow('ins', '', row.b + 1, '+', cells.b);
      }
    }

    return html + '</tbody></table>';
  }

  function inlineRow(kind, lineA, lineB, sign, content) {
    return '<tr class="row row--' + kind + '">' +
      '<td class="ln">' + lineA + '</td>' +
      '<td class="ln">' + lineB + '</td>' +
      '<td class="sign">' + sign + '</td>' +
      '<td class="code">' + content + '</td>' +
      '</tr>';
  }

  function gapRow(row, columns) {
    return '<tr class="row row--gap"><td colspan="' + columns + '">' +
      '<button type="button" class="gap-button" data-gap="' + row.key + '">' +
      '⋯ ' + row.count.toLocaleString() + ' unchanged line' + (row.count === 1 ? '' : 's') +
      ' — click to expand</button></td></tr>';
  }

  function hasIndex(value) { return value !== undefined && value !== null; }

  /** Escaped (and, for modified pairs, word-highlighted) cell contents. */
  function contentFor(row) {
    var textA = hasIndex(row.a) ? current.linesA[row.a] : '';
    var textB = hasIndex(row.b) ? current.linesB[row.b] : '';

    if (row.kind === 'mod' && options.wordLevel) {
      var words = window.DiffCore.diffWords(textA, textB, normalizeToken);
      if (words.similarity >= WORD_SIMILARITY) {
        return { a: segmentsHtml(words.a, 'del'), b: segmentsHtml(words.b, 'ins') };
      }
    }

    return {
      a: hasIndex(row.a) ? escapeHtml(textA) : '',
      b: hasIndex(row.b) ? escapeHtml(textB) : ''
    };
  }

  function segmentsHtml(segments, className) {
    var html = '';
    for (var i = 0; i < segments.length; i++) {
      var text = escapeHtml(segments[i].text);
      html += segments[i].changed ? '<mark class="' + className + '">' + text + '</mark>' : text;
    }
    return html;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>]/g, function (char) {
      return char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;';
    });
  }

  /* ------------------------------------------------------------------ *
   * Unified diff export
   * ------------------------------------------------------------------ */

  function toUnifiedDiff() {
    if (!current) return '';

    var ops = current.ops;
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
        var line = ' ' + current.linesA[op.a];
        if (hunk) {
          if (hunk.trailing < CONTEXT) {
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
          if (pending.length > CONTEXT) pending.shift();
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
          hunk.lines.push('-' + current.linesA[op.a]);
          hunk.countA++;
        } else {
          hunk.lines.push('+' + current.linesB[op.b]);
          hunk.countB++;
        }
      }
    }
    flush();

    if (!hunks.length) return '';

    var nameA = sides.a.filename.textContent || 'original';
    var nameB = sides.b.filename.textContent || 'changed';
    var out = ['--- ' + nameA, '+++ ' + nameB];

    hunks.forEach(function (entry) {
      out.push('@@ -' + (entry.startA + 1) + ',' + entry.countA +
        ' +' + (entry.startB + 1) + ',' + entry.countB + ' @@');
      out.push.apply(out, entry.lines);
    });

    return out.join('\n') + '\n';
  }

  function copyUnified() {
    var text = toUnifiedDiff();
    if (!text) {
      flashButton(els.copy, 'Nothing to copy');
      return;
    }

    var done = function () { flashButton(els.copy, 'Copied'); };
    var fail = function () { flashButton(els.copy, 'Copy failed'); };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (legacyCopy(text)) done();
        else fail();
      });
    } else if (legacyCopy(text)) {
      done();
    } else {
      fail();
    }
  }

  function legacyCopy(text) {
    var helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
    document.body.removeChild(helper);
    return ok;
  }

  function flashButton(button, message) {
    var original = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', original);
    button.textContent = message;
    setTimeout(function () { button.textContent = original; }, 1400);
  }

  /* ------------------------------------------------------------------ *
   * Notices and persistence
   * ------------------------------------------------------------------ */

  function showNotice(message, actionLabel, action) {
    els.notice.textContent = message;
    if (actionLabel) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = actionLabel;
      button.addEventListener('click', action);
      els.notice.appendChild(button);
    }
    els.notice.hidden = false;
  }

  function hideNotice() {
    els.notice.hidden = true;
    els.notice.textContent = '';
  }

  function persist() {
    try {
      var payload = { options: options, theme: theme };
      var a = sides.a.textarea.value;
      var b = sides.b.textarea.value;
      if (a.length + b.length <= STORE_INPUT_LIMIT) {
        payload.inputs = { a: a, b: b };
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch (error) {
      /* storage is optional; ignore quota or privacy-mode failures */
    }
  }

  function restore() {
    var saved;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch (error) {
      saved = null;
    }
    if (!saved) return;

    if (saved.options) {
      Object.keys(options).forEach(function (key) {
        if (typeof saved.options[key] === typeof options[key]) options[key] = saved.options[key];
      });
    }
    if (saved.theme === 'light' || saved.theme === 'dark' || saved.theme === 'auto') {
      theme = saved.theme;
    }
    if (saved.inputs) {
      sides.a.textarea.value = saved.inputs.a || '';
      sides.b.textarea.value = saved.inputs.b || '';
    }
  }
})();
