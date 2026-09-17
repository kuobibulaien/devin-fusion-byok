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
      models: (p.models || []).map(m => ({ id: m.id, label: m.name || m.id, efforts: m.effortLevels || [], contextWindow: 272000, maxOutputTokens: 32768 }))
    }));
    return { enabled: true, providers, sidekicks: [], roleExclusions: { lead: [], sidekick: [] } };
  } catch { return { enabled: true, providers: [], sidekicks: [], roleExclusions: { lead: [], sidekick: [] } }; }
}
async function discover(provider) {
  const url = new URL(provider.baseUrl.replace(/\/$/, '') + '/models');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + provider.apiKey }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('获取模型失败：HTTP ' + response.status);
  const json = await response.json();
  if (!Array.isArray(json.data)) throw new Error('API 未返回模型列表');
  const old = new Map(provider.models.map(m => [m.id, m]));
  provider.models = [...new Set(json.data.map(m => m.id).filter(id => typeof id === 'string' && id.length <= 256))].map(id =>
    old.get(id) || { id, label: provider.name + ' · ' + id, efforts: [], contextWindow: 272000, maxOutputTokens: 32768 });
  return provider.models.length;
}
function updateSidekicks(config) {
  const available = config.providers.flatMap(p => p.models.filter(m => /(?:^|[-/])swe[-_]?2.*max/i.test(m.id)).map(m => ({ providerId: p.id, model: m.id })));
  config.sidekicks = available;
}
module.exports = { readConfig, writeConfig, importLegacy, discover, updateSidekicks };
