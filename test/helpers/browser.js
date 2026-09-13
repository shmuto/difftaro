'use strict';

/**
 * Finding a usable Playwright. It is a devDependency, but some environments
 * (CI images, sandboxes) already have it installed globally with the browsers
 * in place, so fall back to that before giving up. When neither works the UI
 * tests skip instead of failing: the rest of the suite needs no browser.
 */

const { execSync } = require('node:child_process');
const path = require('node:path');

function candidates() {
  const found = [];

  try {
    found.push(require('playwright'));
  } catch (error) {
    /* not installed here; the global install below may still have it */
  }

  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    found.push(require(path.join(root, 'playwright')));
  } catch (error) {
    /* no global install either */
  }

  return found;
}

/**
 * Launch chromium, or say why it could not be launched. A local install whose
 * browsers were never downloaded is not fatal as long as another install has
 * them, which is the usual shape of a pre-provisioned CI image.
 * Resolves with { browser } or { skip: 'why' }.
 */
async function launch() {
  const found = candidates();
  if (!found.length) {
    return { skip: 'playwright is not installed (npm install)' };
  }

  let last = null;
  for (const playwright of found) {
    try {
      return { browser: await playwright.chromium.launch() };
    } catch (error) {
      last = error;
    }
  }

  return { skip: 'chromium is not available (npx playwright install chromium): ' + last.message.split('\n')[0] };
}

module.exports = { launch };
