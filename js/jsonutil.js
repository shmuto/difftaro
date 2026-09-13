/*!
 * difftaro — JSON helpers
 *
 * Canonicalises JSON text so that two documents can be compared on structure
 * rather than on formatting. Exposes `JsonUtil` on the global object in the
 * browser, and CommonJS exports for the node test suite.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.JsonUtil = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Parse `text` and re-emit it with a stable 2-space layout.
   * When `sortKeys` is true, object keys are ordered lexicographically so that
   * a pure reordering of keys shows up as no difference at all.
   * Throws SyntaxError for invalid JSON.
   */
  function canonicalizeJson(text, sortKeys) {
    var value = JSON.parse(text);
    return JSON.stringify(sortKeys ? sortValue(value) : value, null, 2);
  }

  function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value === null || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) {
      out[key] = sortValue(value[key]);
    });
    return out;
  }

  /**
   * Turn a JSON.parse SyntaxError into a message that points at a line and
   * column, which is far more useful than a raw character offset.
   */
  function describeParseError(error, text) {
    var message = String(error && error.message ? error.message : error);
    var match = /position\s+(\d+)/i.exec(message);
    if (!match) return message;
    var position = Number(match[1]);
    var head = text.slice(0, position);
    var line = head.split(/\r\n|\r|\n/);
    var column = line[line.length - 1].length + 1;
    return message.replace(match[0], 'line ' + line.length + ', column ' + column);
  }

  return {
    canonicalizeJson: canonicalizeJson,
    describeParseError: describeParseError
  };
});
