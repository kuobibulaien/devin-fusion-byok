'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function readConfig(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
function importLegacy() {
  try {
    const data = readConfig(path.join(os.homedir(), '.cwindsurf/providers.json'));
    const providers = (Array.isArray(data) ? data : data.providers).filter(p => p.enabled !== false).map(p => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl.replace(/\/$/, ''), apiKey: p.apiKey,
      apiFormat: p.type === 'openai-responses' ? 'openai-responses' : 'openai',
      models: (p.models || []).map(m => ({ id: m.id, label: m.name || m.id, efforts: m.effortLevels || [], contextWindow: 272000, maxOutputTokens: 131072 }))
    }));
    return { enabled: true, providers, sidekicks: [], roleExclusions: { lead: [], sidekick: [] } };
  } catch { return { enabled: true, providers: [], sidekicks: [], roleExclusions: { lead: [], sidekick: [] } }; }
}
async function discover(provider) {
  const anthropic = provider.apiFormat === 'anthropic';
  const headers = anthropic ? { 'anthropic-version': '2023-06-01', 'x-api-key': provider.apiKey } : { Authorization: 'Bearer ' + provider.apiKey };
  const listed = [];
  let after = null;
  // Anthropic's /models is paginated; OpenAI-compatible providers return a single page.
  for (let page = 0; page < 20; page++) {
    const url = new URL(provider.baseUrl.replace(/\/$/, '') + '/models');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    if (anthropic) { url.searchParams.set('limit', '1000'); if (after) url.searchParams.set('after_id', after); }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('获取模型失败：HTTP ' + response.status);
    const json = await response.json();
    if (!Array.isArray(json.data)) throw new Error('API 未返回模型列表');
    listed.push(...json.data);
    if (!anthropic || !json.has_more || typeof json.last_id !== 'string' || json.last_id === after) break;
    after = json.last_id;
  }
  const old = new Map(provider.models.map(m => [m.id, m]));
  const limits = new Map(listed.filter(m => m && typeof m.id === 'string').map(m => [m.id, m]));
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  provider.models = [...new Set(listed.map(m => m?.id).filter(id => typeof id === 'string' && id.length <= 256))].map(id => {
    if (old.has(id)) return old.get(id);
    const info = limits.get(id);
    const contextWindow = positive(info.max_input_tokens) ?? 272000;
    const maxOutputTokens = Math.min(positive(info.max_tokens) ?? 131072, contextWindow);
    return { id, label: provider.name + ' · ' + id, efforts: [], contextWindow, maxOutputTokens };
  });
  return provider.models.length;
}
function updateSidekicks(config) {
  const available = config.providers.flatMap(p => p.models.filter(m => /(?:^|[-/])swe[-_]?2.*max/i.test(m.id)).map(m => ({ providerId: p.id, model: m.id })));
  config.sidekicks = available;
}
module.exports = { readConfig, writeConfig, importLegacy, discover, updateSidekicks };
