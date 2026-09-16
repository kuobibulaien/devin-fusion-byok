'use strict';
const { matchesManaged } = require('./owned-settings.cjs');

// A strict JSON parser with JSONC comments/trailing commas and source offsets.
// Duplicate keys are rejected so restoration cannot edit an ambiguous setting.
function parse(source) {
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = () => { throw new Error('Settings JSONC cannot be edited safely'); };
  function whitespace() {
    for (;;) {
      while (/\s/.test(source[at] || '') && at < source.length) at++;
      if (source.slice(at, at + 2) === '//') { while (at < source.length && source[at] !== '\n') at++; continue; }
      if (source.slice(at, at + 2) === '/*') {
        const end = source.indexOf('*/', at + 2); if (end < 0) fail(); at = end + 2; continue;
      }
      return;
    }
  }
  function string() {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === '\\') { at++; continue; }
      if (char === '"') { try { return { value: JSON.parse(source.slice(start, at)), start, end: at }; } catch { fail(); } }
    }
    fail();
  }
  function value(depth = 0) {
    if (depth > 100) fail();
    whitespace(); const start = at, char = source[at];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const object = char === '{', close = object ? '}' : ']';
      const data = object ? Object.create(null) : [], children = [];
      at++; whitespace();
      while (source[at] !== close) {
        if (at >= source.length) fail();
        const propertyStart = at; let key;
        if (object) {
          if (source[at] !== '"') fail();
          key = string().value; whitespace();
          if (Object.hasOwn(data, key) || source[at++] !== ':') fail();
        } else key = data.length;
        const child = value(depth + 1); data[key] = child.value;
        const property = { key, start: propertyStart, end: child.end, node: child, comma: null };
        children.push(property); whitespace();
        if (source[at] === ',') { property.comma = at++; whitespace(); }
        else if (source[at] !== close) fail();
      }
      at++; return { start, end: at, value: data, children, object };
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!token) fail(); at += token[0].length;
    return { start, end: at, value: JSON.parse(token[0]) };
  }
  const root = value(); whitespace();
  if (at !== source.length || root.object !== true) fail();
  return root;
}

function restoreJsonc(source, changes) {
  const root = parse(source), edits = [];
  let count = 0;
  const keys = new Set();
  for (const change of changes) {
    const id = JSON.stringify(change.path);
    if (keys.has(id)) throw new Error('Duplicate owned setting');
    keys.add(id);
    let node = root, property, parent;
    for (const key of change.path) {
      parent = node; property = node?.object && node.children.find(child => child.key === key);
      node = property?.node; if (!node) break;
    }
    if (!node || !matchesManaged(change, node.value)) continue;
    if (change.original.exists) edits.push({ start: node.start, end: node.end, text: JSON.stringify(change.original.value) });
    else {
      edits.push({ start: property.start, end: property.end, text: '' });
      const index = parent.children.indexOf(property);
      const comma = property.comma ?? parent.children[index - 1]?.comma;
      if (comma != null) edits.push({ start: comma, end: comma + 1, text: '' });
    }
    count++;
  }
  // Several adjacent deleted properties can refer to the same separator.
  const unique = [...new Map(edits.map(edit => [edit.start + ':' + edit.end, edit])).values()].sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of unique) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  parse(result);
  return { text: result, count };
}
module.exports = { parse, restoreJsonc };
