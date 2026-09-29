'use strict';

// Shared by the extension host and the webview (injected via toString), so it
// must stay self-contained. Strips a pasted endpoint suffix, then appends /v1
// only when the path carries no version segment such as /v1, /v4 or /v1beta.
function normalizeBaseUrlPath(pathname) {
  const path = String(pathname || '').replace(/\/(?:responses|chat\/completions|messages|models)\/?$/, '').replace(/\/+$/, '');
  return path.split('/').some(segment => /^v\d+/i.test(segment)) ? path : path + '/v1';
}

module.exports = { normalizeBaseUrlPath };
