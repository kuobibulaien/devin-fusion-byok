'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderPanel } = require('../src/panel/view.cjs');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {};
    this.classList = { add() {} }; this.style = {}; this.value = ''; this.textContent = ''; this.className = '';
    this.checked = false; this.disabled = false; this.open = false; }
  append(...children) { for (const child of children) if (child != null) this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  close() { this.open = false; }
  showModal() { this.open = true; }
  reportValidity() { return true; }
}

function collect(node, tag, predicate = () => true) {
  const found = [];
  if (node.tag === tag && predicate(node)) found.push(node);
  for (const child of node.children || []) found.push(...collect(child, tag, predicate));
  return found;
}

function panel() {
  const elements = new Map(), posts = [], listeners = [];
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); };
  const createElement = tag => {
    const node = new Element(tag);
    node.setAttribute = (key, value) => { node.attributes[key] = value; if (key === 'id' && !elements.has(value)) elements.set(value, node); };
    return node;
  };
  const document = { getElementById: byId, createElement, createTextNode: text => ({ textContent: text }),
    querySelectorAll: () => [] };
  vm.runInNewContext(renderPanel({ nonce: 'safe', cspSource: 'test:' }).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1],
    { acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: message => posts.push(message) }), document,
      window: { addEventListener: (name, listener) => { if (name === 'message') listeners.push(listener); } }, setTimeout: () => 0, clearTimeout() {} });
  return { byId, posts, receive: data => { for (const listener of listeners) listener(data); } };
}

const state = () => ({ enabled: true, providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1', apiFormat: 'openai',
  enabled: true, keyConfigured: true, models: [{ id: 'saved', label: 'Saved', enabled: true, efforts: [],
    contextWindow: 200000, maxOutputTokens: 32768 }] }], nativeModels: [], roleLists: { lead: [], sidekick: [] },
  fusionPresets: [], autoContinueStatus: 'unavailable' });

test('the add-model dialog renders the 131072-token output default and keeps saved values', () => {
  const { byId, posts, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  const add = collect(byId('models'), 'button', node => node.textContent === '手动添加')[0];
  assert.ok(add, 'the manual add button is rendered');
  add.listeners.click();
  const dialog = byId('editor-dialog');
  const numbers = collect(dialog, 'input', node => node.attributes.type === 'number');
  assert.deepEqual(numbers.map(node => node.value), ['272000', '131072']);
  assert.equal(posts.filter(message => message.type === 'addModel').length, 0);
});

test('the edit-model dialog renders the saved output limit unchanged', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  const edit = collect(byId('models'), 'button', node => String(node.attributes['aria-label'] || '').startsWith('编辑模型'))[0];
  assert.ok(edit, 'the edit button is rendered');
  edit.listeners.click();
  const numbers = collect(byId('editor-dialog'), 'input', node => node.attributes.type === 'number');
  assert.deepEqual(numbers.map(node => node.value), ['200000', '32768']);
});

test('the effort hint lists the Max preset and notes provider-dependent support', () => {
  const { byId, receive } = panel();
  receive({ data: { type: 'state', state: state() } });
  const edit = collect(byId('models'), 'button', node => String(node.attributes['aria-label'] || '').startsWith('编辑模型'))[0];
  assert.ok(edit, 'the edit button is rendered');
  edit.listeners.click();
  const hints = collect(byId('editor-dialog'), 'span', node => node.className === 'hint').map(node => node.textContent);
  const effortHint = hints.find(text => text.includes('XHigh'));
  assert.ok(effortHint, 'the effort hint is rendered');
  assert.ok(effortHint.includes('Max'), 'the automatic preset hint mentions Max');
  assert.ok(/供应商/.test(effortHint), 'the hint notes that the supported tiers depend on the provider');
});
