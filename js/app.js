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
  var model = window.DiffModel;
  var blockCount = 0;      // number of change blocks in the rendered diff
  var currentBlock = -1;   // the one the navigation buttons last jumped to
  var resizeTimer = null;

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
    els.overview = document.getElementById('overview');
    els.overviewBands = document.getElementById('overviewBands');
    els.overviewViewport = document.getElementById('overviewViewport');
    els.changeNav = document.getElementById('changeNav');
    els.changeCount = document.getElementById('changeCount');
    els.prevChange = document.getElementById('prevChange');
    els.nextChange = document.getElementById('nextChange');

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

    els.prevChange.addEventListener('click', function () { goToChange(-1); });
    els.nextChange.addEventListener('click', function () { goToChange(1); });
    els.output.addEventListener('scroll', updateViewport);
    els.overview.addEventListener('pointerdown', function (event) {
      els.overview.setPointerCapture(event.pointerId);
      scrollToOverview(event);
    });
    els.overview.addEventListener('pointermove', function (event) {
      if (event.buttons & 1) scrollToOverview(event);
    });

    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(buildOverview, 150);
    });

    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        run(true);
      } else if (event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        swap();
      } else if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        goToChange(1);
      } else if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault();
        goToChange(-1);
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
    var lines = value === '' ? 0 : model.splitLines(value).length;
    sides[key].counts.textContent =
      lines.toLocaleString() + model.plural(' line', lines) + ' · ' +
      value.length.toLocaleString() + model.plural(' character', value.length);
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
      resetOverview();
      return;
    }

    if (rawA === '' && rawB === '') {
      current = null;
      hideNotice();
      els.stats.textContent = '';
      els.output.innerHTML = '<p class="empty-state">Paste or drop two files to compare them.</p>';
      resetOverview();
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

    var linesA = model.splitLines(textA);
    var linesB = model.splitLines(textB);
    var ops = model.orderOps(window.DiffCore.diff(linesA.map(normalize), linesB.map(normalize)));

    current = {
      linesA: linesA,
      linesB: linesB,
      ops: ops,
      rows: model.buildRows(ops)
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

  function normalize(line) {
    return model.normalizeLine(line, options);
  }

  function normalizeToken(token) {
    return model.normalizeToken(token, options);
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function render() {
    if (!current) return;

    var rows = options.onlyChanges ? model.collapse(current.rows, CONTEXT, expandedGaps) : current.rows;
    var stats = model.summarise(current.rows);
    renderStats(stats);

    if (stats.added === 0 && stats.removed === 0 && stats.modified === 0) {
      els.output.innerHTML = '<p class="empty-state">No differences' +
        (options.mode === 'json' ? ' in the JSON structure.' : '.') + '</p>';
      resetOverview();
      return;
    }

    var limited = !renderAll && rows.length > MAX_ROWS;
    var shown = limited ? rows.slice(0, MAX_ROWS) : rows;

    blockCount = model.assignBlocks(shown);
    currentBlock = -1;
    els.output.innerHTML = options.view === 'split' ? renderSplit(shown) : renderInline(shown);
    buildOverview();
    updateChangeNav();

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
      html += '<tr ' + rowAttrs(row) + '>' +
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
        html += inlineRow(row, 'equal', row.a + 1, row.b + 1, '', cells.a);
      } else if (row.kind === 'del') {
        html += inlineRow(row, 'del', row.a + 1, '', '−', cells.a);
      } else if (row.kind === 'ins') {
        html += inlineRow(row, 'ins', '', row.b + 1, '+', cells.b);
      } else {
        html += inlineRow(row, 'del', row.a + 1, '', '−', cells.a);
        html += inlineRow(row, 'ins', '', row.b + 1, '+', cells.b);
      }
    }

    return html + '</tbody></table>';
  }

  function inlineRow(row, kind, lineA, lineB, sign, content) {
    return '<tr ' + rowAttrs(row, kind) + '>' +
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

  function rowAttrs(row, kind) {
    return 'class="row row--' + (kind || row.kind) + '"' +
      (row.block === undefined ? '' : ' data-block="' + row.block + '"');
  }

  var hasIndex = model.hasIndex;

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
      a: hasIndex(row.a) ? model.escapeHtml(textA) : '',
      b: hasIndex(row.b) ? model.escapeHtml(textB) : ''
    };
  }

  function segmentsHtml(segments, className) {
    var html = '';
    for (var i = 0; i < segments.length; i++) {
      var text = model.escapeHtml(segments[i].text);
      html += segments[i].changed ? '<mark class="' + className + '">' + text + '</mark>' : text;
    }
    return html;
  }

  /* ------------------------------------------------------------------ *
   * Overview map and change navigation
   * ------------------------------------------------------------------ */

  var MAX_BANDS = 500;

  /**
   * Draw the whole diff as a strip of coloured bands next to the scroll area,
   * so the shape and position of every change is visible at a glance. The
   * left half of the strip is the original, the right half the changed side.
   * Bands are measured from the rendered rows, so wrapped lines and collapsed
   * regions land in the right place.
   */
  function buildOverview() {
    var rows = els.output.querySelectorAll('tr[data-block]');
    var total = els.output.scrollHeight;

    if (!rows.length || !total) {
      resetOverview();
      return;
    }

    var base = els.output.getBoundingClientRect().top - els.output.scrollTop;
    var bands = [];

    for (var i = 0; i < rows.length; i++) {
      var rect = rows[i].getBoundingClientRect();
      var top = rect.top - base;
      var block = Number(rows[i].getAttribute('data-block'));
      var band = {
        top: top,
        bottom: top + rect.height,
        a: rows[i].classList.contains('row--del') || rows[i].classList.contains('row--mod'),
        b: rows[i].classList.contains('row--ins') || rows[i].classList.contains('row--mod'),
        from: block,
        to: block,
        lines: lineLabels(rows[i])
      };
      var last = bands[bands.length - 1];
      if (last && last.a === band.a && last.b === band.b && band.top - last.bottom <= 1) {
        extendBand(last, band);
      } else {
        bands.push(band);
      }
    }

    bands = model.mergeBands(bands, total, MAX_BANDS);

    var html = '';
    for (var j = 0; j < bands.length; j++) {
      html += '<div class="overview__band" data-from="' + bands[j].from +
        '" data-to="' + bands[j].to +
        '" title="' + model.escapeHtml(model.bandTitle(bands[j])) +
        '" style="top:' + model.percent(bands[j].top / total) + ';height:' +
        model.percent((bands[j].bottom - bands[j].top) / total) + '">' +
        (bands[j].a ? '<i class="a"></i>' : '') +
        (bands[j].b ? '<i class="b"></i>' : '') +
        '</div>';
    }

    els.overviewBands.innerHTML = html;
    els.overview.hidden = false;
    markCurrentBand();
    updateViewport();
  }

  /** The line numbers a rendered row covers, as shown in the gutters. */
  function lineLabels(tr) {
    var out = [];
    var gutters = tr.querySelectorAll('.ln');
    for (var i = 0; i < gutters.length; i++) {
      var value = Number(gutters[i].textContent);
      if (value) out.push(value);
    }
    return { first: Math.min.apply(null, out.concat(Infinity)), last: Math.max.apply(null, out.concat(0)) };
  }

  /** Grow a band so it also covers `next`. */
  function extendBand(band, next) {
    band.bottom = Math.max(band.bottom, next.bottom);
    band.a = band.a || next.a;
    band.b = band.b || next.b;
    band.from = Math.min(band.from, next.from);
    band.to = Math.max(band.to, next.to);
    band.lines.first = Math.min(band.lines.first, next.lines.first);
    band.lines.last = Math.max(band.lines.last, next.lines.last);
  }

  /** Ring the band that holds the change the navigation buttons are on. */
  function markCurrentBand() {
    var children = els.overviewBands.children;
    for (var i = 0; i < children.length; i++) {
      var from = Number(children[i].getAttribute('data-from'));
      var to = Number(children[i].getAttribute('data-to'));
      children[i].classList.toggle('is-current',
        currentBlock >= 0 && currentBlock >= from && currentBlock <= to);
    }
  }

  function updateViewport() {
    var pane = els.output;
    var ratio = pane.scrollHeight ? pane.clientHeight / pane.scrollHeight : 1;

    if (ratio >= 0.999) {
      els.overviewViewport.hidden = true;
      return;
    }

    els.overviewViewport.hidden = false;
    els.overviewViewport.style.top = model.percent(pane.scrollTop / pane.scrollHeight);
    els.overviewViewport.style.height = model.percent(ratio);
  }

  function resetOverview() {
    blockCount = 0;
    currentBlock = -1;
    els.overview.hidden = true;
    els.overviewBands.innerHTML = '';
    els.changeNav.hidden = true;
  }

  function scrollToOverview(event) {
    var rect = els.overview.getBoundingClientRect();
    var fraction = (event.clientY - rect.top) / rect.height;
    els.output.scrollTop = fraction * els.output.scrollHeight - els.output.clientHeight / 2;
  }

  function updateChangeNav() {
    els.changeNav.hidden = blockCount === 0;
    els.changeCount.textContent = currentBlock < 0
      ? blockCount.toLocaleString() + model.plural(' change', blockCount)
      : (currentBlock + 1) + ' / ' + blockCount;
  }

  /** Scroll to the next (or previous) change block, wrapping around. */
  function goToChange(step) {
    if (!blockCount) return;

    currentBlock = currentBlock < 0
      ? (step > 0 ? 0 : blockCount - 1)
      : (currentBlock + step + blockCount) % blockCount;

    var rows = els.output.querySelectorAll('tr[data-block="' + currentBlock + '"]');
    if (!rows.length) return;

    els.output.querySelectorAll('tr.is-current').forEach(function (row) {
      row.classList.remove('is-current');
    });
    rows.forEach(function (row) { row.classList.add('is-current'); });

    var base = els.output.getBoundingClientRect().top - els.output.scrollTop;
    var first = rows[0].getBoundingClientRect();
    var last = rows[rows.length - 1].getBoundingClientRect();
    var top = first.top - base;
    var height = last.top + last.height - base - top;

    els.output.scrollTop = Math.max(0, top - (els.output.clientHeight - height) / 2);
    markCurrentBand();
    updateChangeNav();
  }

  /* ------------------------------------------------------------------ *
   * Unified diff export
   * ------------------------------------------------------------------ */

  function copyUnified() {
    var text = current ? model.toUnifiedDiff(current.ops, current.linesA, current.linesB, {
      context: CONTEXT,
      nameA: sides.a.filename.textContent,
      nameB: sides.b.filename.textContent
    }) : '';
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
