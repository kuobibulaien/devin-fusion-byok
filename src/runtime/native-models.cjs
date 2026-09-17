'use strict';
const fs = require('node:fs');
const { runtimeIdentity, controlFile, PORT } = require('./backend.cjs');
async function readNativeModels({ root, port = PORT, signal, request = fetch }) {
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000);
  const base = 'http://127.0.0.1:' + port;
  const read = async (url, headers) => {
    const response = await request(url, { signal: timeout, headers, redirect: 'error' });
    if (!response.ok) throw new Error('native_catalog_unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('native_catalog_too_large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const health = await read(base + '/health');
  const expected = runtimeIdentity(root);
  if (health.service !== expected.service || health.rootId !== expected.rootId || !health.instanceId) throw new Error('native_catalog_identity');
  if (health.nativeModelsProtocol !== 1) return { status: 'unsupported', models: [] };
  const control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
  if (control.rootId !== health.rootId || control.instanceId !== health.instanceId || control.sourceId !== health.sourceId || !/^[a-f0-9]{64}$/.test(control.token || '')) throw new Error('native_catalog_identity');
  const data = await read(base + '/_runtime/native-models', { authorization: 'Bearer ' + control.token });
  if (data.instanceId !== health.instanceId || !Array.isArray(data.models)) throw new Error('native_catalog_identity');
  const models = data.models.map(entry => {
    if (!entry || typeof entry.uid !== 'string' || !entry.uid || entry.uid.length > 256 || /^(?:fusion-)?dfbyok-/.test(entry.uid) ||
      typeof entry.disabled !== 'boolean' || typeof entry.isModelRouter !== 'boolean' || !Array.isArray(entry.harnessUids) ||
      entry.harnessUids.some(uid => typeof uid !== 'string')) throw new Error('native_catalog_invalid');
    const next = { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label : entry.uid,
      disabled: entry.disabled, isModelRouter: entry.isModelRouter, harnessUids: entry.harnessUids };
    const d = entry.sidekickDimension;
    if (d && Number.isSafeInteger(d.order) && d.order >= 0 && d.order <= 0x7fffffff && typeof d.name === 'string' && d.name &&
      (d.fastModeOrder === undefined || Number.isSafeInteger(d.fastModeOrder) && d.fastModeOrder >= 0))
      next.sidekickDimension = { order: d.order, name: d.name, fastModeOrder: d.fastModeOrder };
    if (entry.fusionMetadata !== undefined) {
      if (!Array.isArray(entry.fusionMetadata)) throw new Error('native_catalog_invalid');
      const validMeta = [];
      const seenKeys = new Set();
      for (const item of entry.fusionMetadata) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string' ||
            !Number.isSafeInteger(item.order) || item.order < 0 || item.order > 0x7fffffff ||
            typeof item.name !== 'string' ||
            (item.controlType !== undefined && (!Number.isSafeInteger(item.controlType) || item.controlType < 0 || item.controlType > 0x7fffffff)) ||
            seenKeys.has(item.key)) {
          throw new Error('native_catalog_invalid');
        }
        seenKeys.add(item.key);
        validMeta.push({ key: item.key, order: item.order, name: item.name, controlType: item.controlType ?? 0 });
      }
      next.fusionMetadata = validMeta;
    }
    if (Number.isSafeInteger(entry.maxTokens) && entry.maxTokens > 0) next.maxTokens = entry.maxTokens;
    if (Number.isSafeInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0) next.maxOutputTokens = entry.maxOutputTokens;
    if (entry.supportsImages === true) next.supportsImages = true;
    return next;
  });
  return { status: models.length ? 'ready' : 'empty', models };
}
module.exports = { readNativeModels };
