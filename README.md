# difftaro

A diff tool that runs entirely in your browser. Static HTML, CSS and JavaScript —
no external libraries, no build step, no server.

Double-click `index.html` and it works (`file://` is tested too). Nothing you paste
or drop on the page is ever sent over the network.

## Features

- **Text comparison** — paste into the two panes; the diff recomputes as you type.
- **File comparison** — drag and drop, or use "Open file" to read a local file
  (it is read in the browser, never uploaded).
- **JSON comparison** — parses and canonicalises both sides (consistent indentation,
  sorted keys) before diffing, so formatting and key order stop showing up as changes.
  Invalid JSON reports the position of the error and falls back to a plain text diff.
- **Two views** — side by side or inline, one click apart.
- **Word-level highlighting** — inside a changed line, only the parts that actually
  differ are marked.
- **Overview map** — a strip beside the diff that compresses the whole comparison into
  one column of coloured bands, so you can see at a glance where the changes are. The
  left half is the original and the right half the changed side; a box tracks the
  visible range, clicking or dragging jumps there, and hovering a band names its lines.
- **Change navigation** — consecutive changed lines count as one block; `↑` `↓`
  (`Alt` + `↑` / `Alt` + `↓`) step between them, with a "3 / 12" counter and the block
  you land on highlighted.
- **Options** — ignore whitespace, ignore case, word highlighting, show only changes
  (3 lines of context, click to expand), line wrapping.
- **Copy as a unified diff** — in a form `git apply` accepts.
- Light and dark themes, inputs and options remembered (localStorage), works on a phone.
- Shortcuts: `Ctrl`/`Cmd` + `Enter` to compare, `Alt` + `S` to swap sides,
  `Alt` + `↑` / `↓` to step through changes.

## Layout

```
index.html      the page
css/styles.css  styles (light and dark theme tokens)
js/diff.js      the diff engine (Myers O(ND), linear space) and word-level diffing
js/jsonutil.js  JSON canonicalisation and readable parse errors
js/model.js     edit script to displayable rows, collapsing, overview bands, unified diff
js/app.js       DOM wiring and rendering
test/           unit tests for the engine and the model, plus browser tests
```

`js/model.js` holds only pure logic that never touches the DOM, so it can be tested
without launching a browser. `js/app.js` is the layer that connects it to the page.

The engine is Myers' algorithm (the linear-space variant from the 1986 paper),
implemented from scratch. It searches the edit graph from both ends to find the middle
snake, then divides and conquers to build a minimal edit script. Memory is O(N+M) and
time is O(ND), so large files stay fast.

## Development

The site itself has no dependencies. Tests need Node.js 18 or newer, and the browser
tests need Playwright.

```bash
npm ci                                  # install Playwright (tests only)
npx playwright install chromium         # the browser itself (first time only)
npm test                                # everything (57 tests)
npm run test:unit                       # only the tests that need no browser
npm run test:ui                         # only the browser tests
npm run serve                           # serve locally (file:// works too)
```

Where Playwright is missing, **the browser tests skip themselves** and the unit tests
still run. GitHub Actions runs all of them on every push and pull request.

### What the tests cover

| File | Covers | Tests |
| --- | --- | --- |
| `test/diff.test.js` | the diff engine, tokenising, JSON canonicalisation | 14 |
| `test/model.test.js` | row building, collapsing, block numbering, unified diff, band merging | 25 |
| `test/ui.test.js` | rendering, escaping, the overview map, interaction and persistence, in a real browser | 18 |

Three things the unit tests are strict about:

- **Minimality** — an edit script must not merely be valid (reconstructs the second
  text, indices strictly increasing); its number of unchanged lines must equal the LCS
  length computed by dynamic programming, which makes it a *minimal* script. Checked
  across 750 randomly generated cases.
- **Patches that really apply** — the generated unified diff is run through a small
  patch applier inside the test, which must turn the original text into the changed one.
- **Overview map arithmetic** — band merging stays under its node budget however large
  the diff, `percent()` never emits an invalid length, and so on.

The browser tests collect console and page errors during every test and fail if there
are any. That check alone caught two implementation bugs.

## Publishing

The repository is only static files, so GitHub Pages serves it with no build step —
Settings → Pages, then pick the branch root (`/`). Pages is already enabled here and
deploys from `master`.

## License

MIT
