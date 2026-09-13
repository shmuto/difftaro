'use strict';

/**
 * Browser tests for everything the pure model cannot cover: rendering,
 * escaping, the overview map's geometry, scrolling, the clipboard and the
 * options that only exist as DOM state.
 *
 * They need Playwright and a chromium build. Without them the whole file
 * skips, so `npm test` still runs the rest of the suite.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { serve } = require('./helpers/server.js');
const { launch } = require('./helpers/browser.js');

const ROOT = path.join(__dirname, '..');

/** 300 numbered lines with changes scattered through them. */
function sample() {
  const before = [];
  for (let i = 1; i <= 300; i++) before.push('row ' + i + ': value = ' + i * 3 + ';');
  const after = before.slice();
  after[4] = 'row 5: value = 999;';
  after[5] = 'row 6: value = 998;';
  after.splice(60, 0, 'row 60b: inserted', 'row 60c: inserted', 'row 60d: inserted');
  after.splice(120, 4);
  after[200] = 'row 198: rewritten entirely';
  return { before: before.join('\n'), after: after.join('\n') };
}

describe('browser UI', { concurrency: 1 }, () => {
  let browser = null;
  let server = null;
  let skip = null;

  before(async () => {
    const result = await launch();
    if (result.skip) {
      skip = result.skip;
      return;
    }
    browser = result.browser;
    server = await serve(ROOT);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.close();
  });

  /** A fresh page with empty storage; fails the test on any page error. */
  async function open(t, viewport) {
    const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 1000 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
    const page = await context.newPage();

    const problems = [];
    page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push('console: ' + message.text());
    });

    await page.goto(server.origin + '/index.html');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    t.after(async () => {
      await context.close();
      assert.deepStrictEqual(problems, [], 'the page logged no errors');
    });

    return page;
  }

  async function compare(page, a, b) {
    await page.fill('#inputA', a);
    await page.fill('#inputB', b);
    await page.click('#compareButton');
  }

  const geometry = (page) => page.evaluate(() => {
    const pane = document.getElementById('output');
    return { top: pane.scrollTop, height: pane.scrollHeight, client: pane.clientHeight };
  });

  test('renders a side-by-side diff with word-level highlighting', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await compare(page, 'const a = 1;\nkeep\ngone', 'const a = 2;\nkeep');

    assert.strictEqual(await page.locator('.diff--split').count(), 1);
    assert.strictEqual(await page.locator('tr.row--mod').count(), 1);
    assert.strictEqual(await page.locator('tr.row--del').count(), 1);
    assert.deepStrictEqual(
      await page.locator('.row--mod .side--a mark').allTextContents(), ['1']);
    assert.deepStrictEqual(
      await page.locator('.row--mod .side--b mark').allTextContents(), ['2']);
    assert.match(await page.textContent('#stats'), /1 modified/);
  });

  test('escapes markup instead of rendering it', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await compare(page, '<script>alert(1)</script>', '<img src=x onerror=alert(2)>');

    assert.strictEqual(await page.locator('#output script, #output img').count(), 0);
    assert.match(await page.textContent('.diff'), /<script>alert\(1\)<\/script>/);
  });

  test('switches to the inline view', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await compare(page, 'a\nb\nc', 'a\nB\nc');
    await page.click('[data-view="inline"]');

    assert.strictEqual(await page.locator('.diff--inline').count(), 1);
    // A modified line becomes a removal row followed by an addition row.
    assert.strictEqual(await page.locator('.diff--inline tr').count(), 4);
    assert.strictEqual(await page.locator('.diff--inline tr.row--del').count(), 1);
    assert.strictEqual(await page.locator('.diff--inline tr.row--ins').count(), 1);
  });

  test('collapses unchanged regions and expands them on click', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    const lines = Array.from({ length: 40 }, (_, i) => 'line ' + i);
    const changed = lines.slice();
    changed[20] = 'changed';
    await compare(page, lines.join('\n'), changed.join('\n'));

    const full = await page.locator('.diff tr').count();
    await page.check('[data-option="onlyChanges"]');
    assert.strictEqual(await page.locator('tr.row--gap').count(), 2);
    assert.ok(await page.locator('.diff tr').count() < full);
    assert.match(await page.textContent('.gap-button'), /unchanged lines/);

    await page.locator('.gap-button').first().click();
    assert.strictEqual(await page.locator('tr.row--gap').count(), 1);
  });

  test('draws an overview band for every change, in the right place', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    const { before, after } = sample();
    await compare(page, before, after);

    assert.strictEqual(await page.locator('.overview__band').count(), 4);
    assert.deepStrictEqual(
      await page.locator('.overview__band').evaluateAll((els) => els.map((el) => el.title)),
      [
        'change 1 (lines 5-6)',
        'change 2 (lines 61-63)',
        'change 3 (lines 118-121)',
        'change 4 (lines 201-202)'
      ]);

    // A pure insertion paints only the right half, a pure deletion only the left.
    const halves = await page.locator('.overview__band').evaluateAll((els) =>
      els.map((el) => Array.from(el.children).map((child) => child.className).join('+')));
    assert.deepStrictEqual(halves, ['a+b', 'b', 'a', 'a+b']);

    // Each band sits at the same fraction of the strip as its rows do of the pane.
    const placement = await page.evaluate(() => {
      const pane = document.getElementById('output');
      const base = pane.getBoundingClientRect().top - pane.scrollTop;
      const firstChange = document.querySelector('tr[data-block="0"]');
      return {
        rowFraction: (firstChange.getBoundingClientRect().top - base) / pane.scrollHeight,
        bandFraction: parseFloat(document.querySelector('.overview__band').style.top) / 100
      };
    });
    assert.ok(Math.abs(placement.rowFraction - placement.bandFraction) < 0.005,
      'band ' + placement.bandFraction + ' tracks row ' + placement.rowFraction);
  });

  test('the overview viewport box tracks the scroll position', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    const { before, after } = sample();
    await compare(page, before, after);

    const box = () => page.evaluate(() => {
      const el = document.getElementById('overviewViewport');
      return { hidden: el.hidden, top: parseFloat(el.style.top), height: parseFloat(el.style.height) };
    });

    const start = await box();
    assert.strictEqual(start.hidden, false);
    assert.strictEqual(start.top, 0);
    assert.ok(start.height > 0 && start.height < 100);

    const size = await geometry(page);
    await page.evaluate((to) => { document.getElementById('output').scrollTop = to; },
      size.height / 2);
    // The box follows the pane's scroll event, which lands on the next tick.
    await page.waitForFunction(() =>
      parseFloat(document.getElementById('overviewViewport').style.top) > 0);
    const middle = await box();
    assert.ok(Math.abs(middle.top - 50) < 1, 'box moved to ' + middle.top + '%');
  });

  test('clicking and dragging the overview scrolls the pane', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    const { before, after } = sample();
    await compare(page, before, after);
    await page.locator('#overview').scrollIntoViewIfNeeded();

    const strip = await page.locator('#overview').boundingBox();
    const expected = async (fraction) => {
      const size = await geometry(page);
      return Math.max(0, Math.min(size.height - size.client, fraction * size.height - size.client / 2));
    };

    await page.mouse.click(strip.x + strip.width / 2, strip.y + strip.height * 0.8);
    assert.ok(Math.abs((await geometry(page)).top - await expected(0.8)) < 2);

    await page.mouse.click(strip.x + strip.width / 2, strip.y + strip.height * 0.1);
    assert.ok(Math.abs((await geometry(page)).top - await expected(0.1)) < 2);

    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height * 0.6, { steps: 6 });
    await page.mouse.up();
    assert.ok(Math.abs((await geometry(page)).top - await expected(0.6)) < 2);
  });

  test('steps through the changes and wraps around', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    const { before, after } = sample();
    await compare(page, before, after);

    assert.strictEqual((await page.textContent('#changeCount')).trim(), '4 changes');

    await page.click('#nextChange');
    assert.strictEqual((await page.textContent('#changeCount')).trim(), '1 / 4');
    assert.strictEqual(await page.locator('.overview__band.is-current').count(), 1);

    await page.click('#nextChange');
    await page.click('#nextChange');
    assert.strictEqual((await page.textContent('#changeCount')).trim(), '3 / 4');
    assert.ok(await page.locator('tr.is-current').count() > 0);

    const visible = await page.evaluate(() => {
      const pane = document.getElementById('output').getBoundingClientRect();
      const row = document.querySelector('tr.is-current').getBoundingClientRect();
      return row.top >= pane.top && row.bottom <= pane.bottom;
    });
    assert.ok(visible, 'the current change is scrolled into view');

    await page.click('#nextChange');
    await page.click('#nextChange');
    assert.strictEqual((await page.textContent('#changeCount')).trim(), '1 / 4', 'wraps forwards');

    await page.click('#prevChange');
    assert.strictEqual((await page.textContent('#changeCount')).trim(), '4 / 4', 'wraps backwards');

    await page.keyboard.press('Alt+ArrowDown');
    assert.strictEqual((await page.textContent('#changeCount')).trim(), '1 / 4');
  });

  test('hides the map and the navigation when the sides match', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await compare(page, 'same\ntext', 'same\ntext');

    assert.strictEqual(await page.locator('#overview').isHidden(), true);
    assert.strictEqual(await page.locator('#changeNav').isHidden(), true);
    assert.match(await page.textContent('#output'), /No differences/);
  });

  test('ignores whitespace and case when asked', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await compare(page, 'Foo   Bar', '  foo bar  ');

    assert.match(await page.textContent('#stats'), /1 modified/);
    await page.check('[data-option="ignoreWhitespace"]');
    await page.check('[data-option="ignoreCase"]');
    assert.match(await page.textContent('#stats'), /identical/);
  });

  test('JSON mode compares structure, not formatting', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await page.click('[data-mode="json"]');
    await compare(page, '{"b":2,"a":1}', '{ "a": 1,\n  "b": 2 }');
    assert.match(await page.textContent('#stats'), /identical/);

    await compare(page, '{"a":1}', '{"a":2}');
    assert.match(await page.textContent('#stats'), /1 modified/);

    // Turning key sorting off makes a reordering visible again.
    await compare(page, '{"b":2,"a":1}', '{"a":1,"b":2}');
    await page.uncheck('[data-option="sortKeys"]');
    assert.doesNotMatch(await page.textContent('#stats'), /identical/);
  });

  test('reports invalid JSON and falls back to a text diff', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await page.click('[data-mode="json"]');
    await compare(page, '{"a": 1}', '{"a": }');

    assert.match(await page.textContent('#notice'), /Invalid JSON/);
    assert.match(await page.textContent('.editor[data-side="b"] [data-role="error"]'), /JSON/);
    assert.strictEqual(await page.locator('.diff').count(), 1, 'still shows a diff');
  });

  test('copies a unified diff to the clipboard', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    const lines = Array.from({ length: 10 }, (_, i) => 'line ' + (i + 1));
    const changed = lines.slice();
    changed[1] = 'LINE TWO';
    await compare(page, lines.join('\n'), changed.join('\n'));

    await page.click('#copyButton');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.strictEqual(text.split('\n')[0], '--- original');
    assert.match(text, /^@@ -1,5 \+1,5 @@$/m);
    assert.match(text, /^-line 2$/m);
    assert.match(text, /^\+LINE TWO$/m);
    assert.ok(text.indexOf('-line 2') < text.indexOf('+LINE TWO'), 'removals come first');
  });

  test('loads a file, names it, and uses the name in the patch', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await page.setInputFiles('.editor[data-side="a"] [data-role="file"]', {
      name: 'before.txt', mimeType: 'text/plain', buffer: Buffer.from('from a file\nsecond line\n')
    });
    await page.waitForFunction(() => document.getElementById('inputA').value.startsWith('from a file'));

    assert.strictEqual(
      await page.textContent('.editor[data-side="a"] [data-role="filename"]'), 'before.txt');
    assert.match(
      await page.textContent('.editor[data-side="a"] [data-role="counts"]'), /2 lines/);

    await page.fill('#inputB', 'from a file\nsecond line changed\n');
    await page.click('#compareButton');
    await page.click('#copyButton');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.strictEqual(text.split('\n')[0], '--- before.txt');
  });

  test('swaps the two sides', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    await compare(page, 'left', 'right');
    await page.click('#swapButton');
    assert.strictEqual(await page.inputValue('#inputA'), 'right');
    assert.strictEqual(await page.inputValue('#inputB'), 'left');
  });

  test('remembers inputs, options and theme across a reload', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t);
    // Differs by more than case, so the diff survives ignoreCase being on.
    await compare(page, 'kept\ntext', 'kept\nTEXT rewritten');
    await page.click('[data-view="inline"]');
    await page.check('[data-option="ignoreCase"]');
    await page.click('#themeToggle');   // auto -> light
    await page.click('#themeToggle');   // light -> dark

    await page.reload();
    assert.strictEqual(await page.inputValue('#inputA'), 'kept\ntext');
    assert.strictEqual(await page.getAttribute('html', 'data-theme'), 'dark');
    assert.strictEqual(await page.isChecked('[data-option="ignoreCase"]'), true);
    assert.strictEqual(await page.locator('.diff--inline').count(), 1);
  });

  test('fits a phone-sized screen without sideways scrolling', async (t) => {
    if (skip) return t.skip(skip);
    const page = await open(t, { width: 390, height: 844 });
    const { before, after } = sample();
    await compare(page, before, after);

    const width = await page.evaluate(() => [
      document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.strictEqual(width[0], width[1], 'no horizontal overflow');
    assert.ok(await page.locator('.overview__band').count() > 0, 'the map is still drawn');
  });

  test('works when the page is opened straight off disk', async (t) => {
    if (skip) return t.skip(skip);
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    await page.goto('file://' + path.join(ROOT, 'index.html'));
    await compare(page, 'one\ntwo', 'one\n2');

    assert.strictEqual(await page.locator('tr.row--mod').count(), 1);
    assert.deepStrictEqual(problems, []);
    await context.close();
  });
});
