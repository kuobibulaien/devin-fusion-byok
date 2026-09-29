'use strict';
// Locates the installed Devin picker logic by code shape instead of minified
// identifiers, which change on every Devin build.
const fs = require('node:fs');
const vm = require('node:vm');

const rendererFile = '/Applications/Devin.app/Contents/Resources/app/out/vs/workbench/windsurf-chat-client/index.js';
const available = fs.existsSync(rendererFile);
let cached;
const load = () => cached ??= fs.readFileSync(rendererFile, 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`function ${name} is unterminated`);
}

function required(match, what) {
  if (!match) throw new Error(`installed Devin anchor not found: ${what}`);
  return match;
}

// Family grouping + row selection: returns { group(models), rows(grouped) }.
function loadFamilyPicker() {
  const source = load();
  const grouping = required(source.match(/function (\w+)\(e\)\{let t=new Map,n=\[\];for\(let r of e\)\{let e=r\.familyUid;/), 'family grouping');
  const wrapper = required(source.match(new RegExp(`function (\\w+)\\(e,t\\)\\{let\\{families:n\\}=${grouping[1]}\\(t\\?\\?e\\)`)), 'grouped picker input');
  const rows = required(source.match(/function (\w+)\(e,t,n,r,i\)\{let\{fullFamilies:a,families:o,ordered:s\}=e/), 'picker rows');
  const start = source.indexOf(grouping[0]);
  const rowsStart = source.indexOf(rows[0], start);
  const end = rowsStart + functionSource(source, rows[1]).length;
  if (!(start >= 0 && rowsStart > start)) throw new Error('installed Devin family picker range');
  const api = vm.runInNewContext(`${source.slice(start, end)};({group:${wrapper[1]},rows:${rows[1]}})`);
  return { group: models => api.group(models), rows: models => api.rows(api.group(models), [], undefined, false) };
}

// ACP session option intersection: returns { options(session), filter(session, models) }.
function loadAcpPicker() {
  const source = load();
  const use = required(source.match(/let e=(\w+)\((\w+)\.options\);return (\w+)\.filter\(t=>e\.has\(t\.modelUid\)\|\|t\.disabled\)/), 'session/catalog intersection');
  const collector = required(source.match(new RegExp(`function ${use[1]}\\(e\\)\\{let t=new Set;for\\(let n of e\\)if\\((\\w+)\\(n\\)\\)`)), 'session option collector');
  const code = `${functionSource(source, collector[1])};${functionSource(source, use[1])};${use[1]}`;
  const collect = vm.runInNewContext(code);
  const select = new Function(use[1], use[2], use[3], use[0]);
  return { collect, filter: (session, models) => select(collect, session, models) };
}

// Recommended-group sorter that marks the router-only group as featured.
function loadGroupSorter() {
  const source = load();
  const hit = required(source.match(/function (\w+)\(e,t=\w+,n=\(\)=>!0\)\{return e\.map\(e=>\{let r=e\.groups\.map\(e=>\(\{groupName:e\.groupName,options:e\.options\.filter\(n\)\.map\(e=>t\(e\)\),isFeatured:!!\(e\.options\.length>0&&e\.options\.every\(e=>e\.modelInfo\?\.displayOption===(\w+)\.MODEL_ROUTER\)\)\|\|void 0/), 'featured group sorter');
  const sorter = vm.runInNewContext(`${functionSource(source, hit[1]).replace(/t=\w+,n=/, 't=e=>e,n=')};${hit[1]}`, { [hit[2]]: { MODEL_ROUTER: 3 } });
  return sorter;
}

module.exports = { rendererFile, available, loadFamilyPicker, loadAcpPicker, loadGroupSorter };
