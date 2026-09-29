'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBaseUrlPath } = require('../src/panel/base-url.cjs');

test('appends /v1 only when the path has no version segment', () => {
  const cases = [
    ['', '/v1'], ['/', '/v1'], ['/api', '/api/v1'], ['/openai/', '/openai/v1'],
    ['/v1', '/v1'], ['/v1/', '/v1'], ['/api/paas/v4', '/api/paas/v4'], ['/v1beta/openai', '/v1beta/openai'],
    ['/v1/responses', '/v1'], ['/v1/chat/completions/', '/v1'], ['/v1/models', '/v1'], ['/chat/completions', '/v1'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeBaseUrlPath(input), expected, input);
});

test('survives injection into the webview via toString', () => {
  const copy = new Function('return ' + normalizeBaseUrlPath.toString())();
  assert.equal(copy('/api'), '/api/v1');
});
