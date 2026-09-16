'use strict';

const crypto = require('node:crypto');
const { parseFields, str, num, s, v, m } = require('./protocol/wire.cjs');
const { modelEfforts, modelSupportsImages } = require('./model-capabilities.cjs');

const OWN_GROUP = 'Devin Fusion BYOK';
const SIDEKICK_HARNESSES = ['swe-1p6', 'swe-1p5'];
const ownUid = uid => typeof uid === 'string' && /^(?:dfbyok-|fusion-dfbyok-)/.test(uid);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
const concat = parts => Buffer.concat(parts);
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fallback;

function stableOrders(keys) {
  const result = new Map(), used = new Set();
  for (const key of [...new Set(keys)].sort()) {
    let order = 0x10000000 + (parseInt(digest(key).slice(0, 8), 16) % 0x10000000);
    while (used.has(order)) order = order === 0x1fffffff ? 0x10000000 : order + 1;
    result.set(key, order); used.add(order);
  }
  return result;
}

function effortMetadata(effort) {
  const names = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
  const orders = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6, minimal: 7 };
  const key = effort || 'none';
  return { order: orders[key] ?? 100 + parseInt(digest(key).slice(0, 6), 16), name: names[key] || key, controlType: 1 };
}

function encodeFamily(family) {
  return concat([s(1, family.modelFamilyLabel), ...family.entries.map(entry => m(2,
    concat([s(1, entry.key), m(2, concat([v(1, entry.value.order || 0), s(2, entry.value.name || ''), v(3, entry.value.controlType || 0)]))])))]);
}

function encodeConfig(config) {
  const info = config.modelInfo;
  const features = info.modelFeatures;
  const infoRaw = concat([
    v(3, info.modelType), v(4, info.maxTokens),
    m(6, concat([v(8, 1), ...(features.supportsImages ? [v(11, 1)] : []), v(12, 1),
      ...(features.supportsThinking ? [v(15, 1)] : []), v(21, 1)])),
    v(13, info.maxOutputTokens), s(17, info.modelUid), s(18, info.inferenceServerUrl),
    ...info.harnessUids.map(uid => s(20, uid)),
    ...(info.displayOption ? [v(22, info.displayOption)] : []),
    s(23, info.modelFamilyUid), ...(info.isModelRouter ? [v(25, 1)] : []),
  ]);
  return concat([s(1, config.label), ...(config.supportsImages ? [v(5, 1)] : []),
    v(10, config.provider), v(18, config.maxTokens),
    s(22, config.modelUid), m(23, infoRaw), m(30, encodeFamily(config.modelFamilyMetadata))]);
}

function configFor({ uid, label, family, familyUid, contextWindow, maxOutputTokens, effort, fusion, supportsImages, inferenceServerUrl }) {
  const json = {
    label, modelUid: uid, provider: fusion ? 1 : 2,
    maxTokens: contextWindow, supportsImages: !!supportsImages,
    modelInfo: {
      modelUid: uid, modelType: 2, maxTokens: contextWindow,
      maxOutputTokens,
      inferenceServerUrl,
      harnessUids: fusion ? ['fusion'] : [...SIDEKICK_HARNESSES],
      displayOption: fusion ? 3 : 0, modelFamilyUid: familyUid, isModelRouter: !!fusion,
      modelFeatures: { zeroShotCapable: true, supportsImages: !!supportsImages, supportsToolCalls: true,
        supportsParallelToolCalls: true, supportsThinking: !!effort && effort !== 'none' },
    },
    modelFamilyMetadata: family,
  };
  return { uid, label, effort, kind: fusion ? 'fusion' : 'model', json, raw: encodeConfig(json) };
}

/** Build a secret-free catalog. Provider credentials stay solely in caller configuration. */
function buildCatalog(config = {}, nativeModels = []) {
  const models = [], routes = {}, fusions = {}, leads = [];
  const inferenceServerUrl = config.inferenceServerUrl || 'https://server.codeium.com';
  const inferenceUrl = new URL(inferenceServerUrl);
  if (!['http:', 'https:'].includes(inferenceUrl.protocol) || inferenceUrl.username || inferenceUrl.password) {
    throw new Error('Invalid inference server URL');
  }
  const providers = Array.isArray(config.providers) ? config.providers.filter(provider => provider && provider.enabled !== false) : [];
  const identities = new Set();
  for (const provider of providers) {
    if (typeof provider.id !== 'string' || !provider.id) throw new Error('Provider id is required');
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || model.enabled === false) continue;
      if (typeof model.id !== 'string' || !model.id) throw new Error('Model id is required');
      const key = JSON.stringify([provider.id, model.id]);
      if (identities.has(key)) throw new Error('Duplicate provider/model identity');
      identities.add(key);
      const prefix = provider.name || provider.id, sourceLabel = model.label || model.id;
      const familyLabel = sourceLabel.startsWith(prefix + ' · ') ? sourceLabel : `${prefix} · ${sourceLabel}`;
      const efforts = modelEfforts(model);
      for (const effort of efforts) {
        if (effort !== null && (typeof effort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(effort))) throw new Error('Invalid effort value');
        const uid = `dfbyok-${slug(provider.id)}-${slug(model.id)}-${digest([provider.id, model.id, effort]).slice(0, 16)}`;
        const contextWindow = positive(model.contextWindow, 272000);
        const maxOutputTokens = Math.min(positive(model.maxOutputTokens, 16384), contextWindow);
        const lead = { uid, key, familyLabel, providerId: provider.id, model: model.id, effort,
          contextWindow, maxOutputTokens, supportsImages: modelSupportsImages(model), inferenceServerUrl };
        leads.push(lead);
        routes[uid] = { uid, providerId: provider.id, model: model.id, effort, maxOutputTokens };
      }
    }
  }
  // Labels also identify entries in native sort groups. Disambiguate providers
  // with equal display names without changing stable routing identities.
  const familyKeys = new Map();
  for (const lead of leads) {
    if (!familyKeys.has(lead.familyLabel)) familyKeys.set(lead.familyLabel, new Set());
    familyKeys.get(lead.familyLabel).add(lead.key);
  }
  for (const lead of leads) if (familyKeys.get(lead.familyLabel).size > 1) lead.familyLabel += ` (${lead.providerId}/${lead.model})`;
  const leadOrders = stableOrders(leads.map(lead => lead.key));
  for (const lead of leads) {
    const effort = effortMetadata(lead.effort);
    models.push(configFor({ ...lead, label: lead.familyLabel + (lead.effort ? ` ${effort.name}` : ''),
      familyUid: 'dfbyok-family-' + digest(lead.key).slice(0, 16),
      family: { modelFamilyLabel: lead.familyLabel, entries: [{ key: 'Effort', value: effort }] } }));
  }
  const hiddenNativeModelUids = [];
  for (const uid of Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []) {
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid) || hiddenNativeModelUids.includes(uid)) continue;
    hiddenNativeModelUids.push(uid);
  }
  const hiddenSet = new Set(hiddenNativeModelUids);
  const eligibleNatives = new Map();
  for (const entry of Array.isArray(nativeModels) ? nativeModels : []) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid || uid.length > 256 || ownUid(uid) || uid.startsWith('fusion-') || eligibleNatives.has(uid)) continue;
    if (entry.disabled !== false || hiddenSet.has(uid) || entry.isModelRouter !== false) continue;
    const harnessUids = [...new Set((Array.isArray(entry.harnessUids) ? entry.harnessUids : [])
      .filter(harness => SIDEKICK_HARNESSES.includes(harness)))];
    if (!harnessUids.length) continue;
    eligibleNatives.set(uid, { uid, label: typeof entry.label === 'string' ? entry.label : '', harnessUids });
  }
  const sidekicks = [], seenSidekicks = new Set();
  const leadFamilies = new Map();
  for (const lead of leads) {
    if (!leadFamilies.has(lead.key)) leadFamilies.set(lead.key, []);
    leadFamilies.get(lead.key).push(lead);
  }
  const definitions = [...(Array.isArray(config.sidekicks) ? config.sidekicks : []),
    ...[...leadFamilies.values()].map(([lead]) => ({ providerId: lead.providerId, model: lead.model })),
    ...[...eligibleNatives.values()].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0).map(native => ({ nativeUid: native.uid }))];
  for (const sidekick of definitions) {
    let item;
    if (sidekick?.nativeUid) {
      if (typeof sidekick.nativeUid !== 'string' || !sidekick.nativeUid || sidekick.nativeUid.length > 256 || ownUid(sidekick.nativeUid)) throw new Error('Invalid native Sidekick uid');
      const native = eligibleNatives.get(sidekick.nativeUid);
      if (!native) continue;
      item = { uid: native.uid, label: native.label || native.uid, native: true, harnessUids: native.harnessUids };
    } else {
      const candidates = leadFamilies.get(JSON.stringify([sidekick?.providerId, sidekick?.model])) || [];
      const lead = candidates.find(item => !item.effort) || candidates.find(item => item.effort === 'high') || candidates[0];
      if (!lead) throw new Error('Sidekick references an unavailable configured model');
      item = { uid: lead.uid, label: lead.familyLabel, native: false, providerId: lead.providerId, model: lead.model };
    }
    if (!seenSidekicks.has(item.uid)) { sidekicks.push(item); seenSidekicks.add(item.uid); }
  }
  const sidekickOrders = stableOrders(sidekicks.map(item => item.uid));
  for (const lead of leads) for (const sidekick of sidekicks) {
    const uid = `fusion-${lead.uid}-sidekick-${digest(sidekick.uid).slice(0, 16)}`;
    const family = { modelFamilyLabel: 'Fusion', entries: [
      { key: 'Lead', value: { order: leadOrders.get(lead.key), name: lead.familyLabel, controlType: 3 } },
      { key: 'Effort', value: effortMetadata(lead.effort) },
      { key: 'Sidekick', value: { order: sidekick.native && sidekick.uid === 'swe-2-max' ? 3 : sidekickOrders.get(sidekick.uid), name: sidekick.label, controlType: 3 } },
      { key: 'Fast Mode', value: { order: 0, name: '', controlType: 2 } },
      { key: 'Recommended Sidekick', value: { order: 0, name: sidekick.label, controlType: 0 } },
    ] };
    const label = `Fusion (${lead.familyLabel}${lead.effort ? ' ' + effortMetadata(lead.effort).name : ''} + ${sidekick.label})`;
    models.push(configFor({ ...lead, uid, fusion: true, family, familyUid: 'fusion', label }));
    fusions[uid] = { uid, label, leadUid: lead.uid, sidekickUid: sidekick.uid, sidekickNative: sidekick.native,
      ...(sidekick.native ? { sidekickHarnessUids: sidekick.harnessUids } : {}) };
  }
  return { models, routes, fusions, sidekicks, hiddenNativeModelUids,
    defaultFusionUid: typeof config.defaultFusionUid === 'string' ? config.defaultFusionUid : undefined };
}

function rpcShape(rpc) {
  let value = typeof rpc === 'string' ? rpc : rpc?.path || rpc?.name || '';
  try { if (value.includes('://')) value = new URL(value).pathname; } catch { return null; }
  value = value.split('?')[0];
  const method = value.slice(value.lastIndexOf('/') + 1);
  if (method === 'GetUserStatus') return { status: true, field: 1, sorts: true };
  if (['GetCliModelConfigs', 'GetCascadeModelConfigs', 'GetCommandModelConfigs'].includes(method)) return { status: false, sorts: method === 'GetCascadeModelConfigs' };
  return null;
}

function rewriteMessage(data, number, transform, create = false) {
  const parsed = parseFields(data), matches = parsed.filter(field => field.number === number);
  if (matches.length > 1 || matches.some(field => field.wire !== 2)) throw new Error('Ambiguous catalog message');
  if (!matches.length) return create ? concat([data, m(number, transform(Buffer.alloc(0)))]) : data;
  return concat(parsed.map(field => field.number === number ? m(number, transform(field.value)) : field.raw));
}

// The server marks Fusion combinations the account cannot use as disabled.
// Report every native `fusion-` router uid and which are locked so assignment
// interception can fall back to the configured combination without affecting
// entries that remain enabled. Observation failures must never break rewriting.
function reportFusionStatus(entries, isJson, report) {
  if (typeof report !== 'function') return;
  try {
    const seen = [], locked = [];
    for (const entry of entries) {
      const uid = isJson ? entry?.modelUid ?? entry?.model_uid : str(entry, 22);
      if (typeof uid !== 'string' || !uid.startsWith('fusion-') || ownUid(uid)) continue;
      seen.push(uid);
      if (isJson ? entry.disabled === true : num(entry, 4) === 1) locked.push(uid);
    }
    if (seen.length) report(locked, seen);
  } catch {}
}

function protoUid(entry) {
  const uids = parseFields(entry).filter(field => field.number === 22);
  if (uids.length !== 1 || uids[0].wire !== 2) return '';
  return uids[0].value.toString('utf8');
}

function protoDisabled(entry) {
  const flags = parseFields(entry).filter(field => field.number === 4);
  if (!flags.length) return false;
  if (flags.length !== 1 || flags[0].wire !== 0) return true;
  return Number(flags[0].value) !== 0;
}

function protoMetadata(entry) {
  const infos = parseFields(entry).filter(field => field.number === 23);
  if (infos.length !== 1 || infos[0].wire !== 2) return { harnessUids: [], isModelRouter: false };
  try {
    const inner = parseFields(infos[0].value);
    const harnesses = inner.filter(field => field.number === 20);
    if (harnesses.some(field => field.wire !== 2)) return { harnessUids: [], isModelRouter: false };
    const routers = inner.filter(field => field.number === 25);
    if (routers.length > 1 || routers.some(field => field.wire !== 0)) return { harnessUids: [], isModelRouter: false };
    return { harnessUids: harnesses.map(field => field.value.toString('utf8')), isModelRouter: routers.length === 1 && Number(routers[0].value) !== 0 };
  } catch { return { harnessUids: [], isModelRouter: false }; }
}

function jsonAliasValue(object, camel, snake) {
  const hasCamel = has(object, camel), hasSnake = has(object, snake);
  if (hasCamel && hasSnake && JSON.stringify(object[camel]) !== JSON.stringify(object[snake])) return { conflict: true };
  return { value: hasCamel ? object[camel] : object[snake], present: hasCamel || hasSnake };
}

function jsonMetadata(entry) {
  const empty = { harnessUids: [], isModelRouter: false };
  const info = jsonAliasValue(entry, 'modelInfo', 'model_info');
  if (info.conflict || !info.present || !info.value || typeof info.value !== 'object' || Array.isArray(info.value)) return empty;
  const harness = jsonAliasValue(info.value, 'harnessUids', 'harness_uids');
  const router = jsonAliasValue(info.value, 'isModelRouter', 'is_model_router');
  if (harness.conflict || router.conflict) return empty;
  if (harness.present && (!Array.isArray(harness.value) || harness.value.some(value => typeof value !== 'string'))) return empty;
  if (router.present && typeof router.value !== 'boolean') return empty;
  return { harnessUids: harness.present ? harness.value : [], isModelRouter: router.value === true };
}

function nativeEntries(entries, isJson) {
  const seen = [];
  for (const entry of entries) {
    let uid, label, disabled, meta;
    if (isJson) {
      uid = nativeUid(entry);
      label = typeof entry?.label === 'string' ? entry.label : '';
      disabled = has(entry, 'disabled') ? entry.disabled !== false : false;
      meta = jsonMetadata(entry);
    } else {
      uid = protoUid(entry);
      label = str(entry, 1);
      disabled = protoDisabled(entry);
      meta = protoMetadata(entry);
    }
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid)) continue;
    seen.push({ uid, label, disabled, harnessUids: meta.harnessUids, isModelRouter: meta.isModelRouter });
  }
  return seen;
}

function reportNativeModels(entries, isJson, report) {
  if (typeof report !== 'function') return;
  try { const seen = nativeEntries(entries, isJson); if (seen.length) report(seen); } catch {}
}

function defaultFusion(catalog) {
  const uid = catalog?.defaultFusionUid;
  if (typeof uid !== 'string' || !has(catalog?.fusions, uid)) return null;
  const fusion = catalog.fusions[uid];
  return fusion?.sidekickNative === false && has(catalog?.routes, fusion.leadUid) && has(catalog?.routes, fusion.sidekickUid) ? fusion : null;
}

function augmentProtoList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const parsed = parseFields(data), existingLabels = new Set(models.map(model => model.label));
  const entries = parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  reportFusionStatus(entries, false, onFusionStatus);
  reportNativeModels(entries, false, onNativeModels);
  const hidden = new Set(catalog.hiddenNativeModelUids || []);
  const retainedLabels = new Set(models.map(model => model.label));
  const hiddenLabels = new Set();
  const preserved = [];
  for (const field of parsed) {
    if (field.number === 1 && field.wire === 2) {
      const uid = str(field.value, 22), label = str(field.value, 1);
      if (ownUid(uid)) { existingLabels.add(label); continue; }
      if (hidden.has(protoUid(field.value))) { if (label) hiddenLabels.add(label); continue; }
      retainedLabels.add(label);
    }
    preserved.push(field);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const labels = models.map(model => model.label);
  const group = concat([s(1, OWN_GROUP), ...labels.map(label => s(2, label))]);
  let sorts = 0;
  const result = preserved.map(field => {
    if (!hasSorts || field.number !== 2 || field.wire !== 2) return field.raw;
    sorts++;
    const parts = parseFields(field.value).filter(part => {
      if (part.number !== 2 || part.wire !== 2 || str(part.value, 1) !== OWN_GROUP) return true;
      return !parseFields(part.value).filter(value => value.number === 2 && value.wire === 2)
        .every(value => existingLabels.has(value.value.toString('utf8')));
    });
    const position = parts.findIndex(part => part.number === 2 && part.wire === 2);
    const rewritten = parts.map(part => {
      if (!hiddenLabels.size || part.number !== 2 || part.wire !== 2) return part;
      const inner = parseFields(part.value);
      const kept = inner.filter(value => !(value.number === 2 && value.wire === 2 && hiddenLabels.has(value.value.toString('utf8'))));
      return kept.length === inner.length ? part : { raw: m(2, concat(kept.map(value => value.raw))) };
    });
    if (labels.length) rewritten.splice(position < 0 ? rewritten.length : position, 0, { raw: m(2, group) });
    return m(2, concat(rewritten.map(part => part.raw)));
  });
  const promoted = models.find(model => model.uid === defaultFusion(catalog)?.uid);
  const own = [...(promoted ? [promoted] : []), ...models.filter(model => model !== promoted)].map(model => m(1, model.raw));
  result.splice(Math.max(preserved.findIndex(field => field.number === 1 && field.wire === 2), 0), 0, ...own);
  if (hasSorts && !sorts && labels.length) result.push(m(2, concat([s(1, OWN_GROUP), m(2, group)])));
  return concat(result);
}

function jsonKey(object, camel, snake) { return has(object, snake) && !has(object, camel) ? snake : camel; }
function nativeUid(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const camel = entry.modelUid, snake = entry.model_uid;
  if (has(entry, 'modelUid') && has(entry, 'model_uid') && camel !== snake) return '';
  const uid = camel ?? snake;
  return typeof uid === 'string' ? uid : '';
}
function augmentJsonList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid catalog JSON');
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const modelsKey = jsonKey(data, 'clientModelConfigs', 'client_model_configs');
  const sortsKey = jsonKey(data, 'clientModelSorts', 'client_model_sorts');
  const existing = data[modelsKey] || [], sorts = data[sortsKey] || [];
  if (!Array.isArray(existing) || !Array.isArray(sorts)) throw new Error('Invalid catalog list');
  reportFusionStatus(existing, true, onFusionStatus);
  reportNativeModels(existing, true, onNativeModels);
  const hidden = new Set(catalog.hiddenNativeModelUids || []);
  const labels = models.map(model => model.label), existingLabels = new Set(labels);
  const retainedLabels = new Set(labels);
  const hiddenLabels = new Set();
  const kept = [];
  for (const model of existing) {
    if (ownUid(model?.modelUid ?? model?.model_uid)) { existingLabels.add(model?.label); continue; }
    if (hidden.has(nativeUid(model))) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (typeof model?.label === 'string') retainedLabels.add(model.label);
    kept.push(model);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const group = { groupName: OWN_GROUP, modelLabels: labels };
  const append = sort => ({ ...sort, groups: [...(labels.length ? [group] : []), ...(sort.groups || []).map(value => {
    const labelsKey = has(value, 'modelLabels') ? 'modelLabels' : has(value, 'model_labels') ? 'model_labels' : '';
    if (!labelsKey || !Array.isArray(value[labelsKey]) || !hiddenLabels.size) return value;
    const keptLabels = value[labelsKey].filter(label => !hiddenLabels.has(label));
    return keptLabels.length === value[labelsKey].length ? value : { ...value, [labelsKey]: keptLabels };
  }).filter(value =>
    (value.groupName ?? value.group_name) !== OWN_GROUP || !(value.modelLabels ?? value.model_labels ?? []).every(label => existingLabels.has(label)))] });
  const promoted = models.find(model => model.uid === defaultFusion(catalog)?.uid);
  return { ...data,
    [modelsKey]: [...(promoted ? [structuredClone(promoted.json)] : []),
      ...models.filter(model => model !== promoted).map(model => structuredClone(model.json)),
      ...kept],
    ...(hasSorts ? { [sortsKey]: sorts.length ? sorts.map(append) : (labels.length ? [{ name: OWN_GROUP, groups: [group] }] : sorts) } : {}),
  };
}

/** Accept decoded wire messages; framing/compression is exclusively the caller's responsibility. */
function augmentCatalog(data, { rpc, format = {}, catalog, onFusionStatus, onNativeModels } = {}) {
  if (rpc === '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return augmentLocalModelChoices(data, format, catalog);
  const shape = rpcShape(rpc);
  if (!shape || !catalog) return data;
  if (!catalog.models?.length && !catalog.hiddenNativeModelUids?.length &&
      typeof onFusionStatus !== 'function' && typeof onNativeModels !== 'function') return data;
  try {
    if (format.json === true) {
      if (!shape.status) return augmentJsonList(data, catalog, shape.sorts, onFusionStatus, onNativeModels);
      const statusKey = jsonKey(data, 'userStatus', 'user_status'), status = data?.[statusKey];
      if (!status || typeof status !== 'object' || Array.isArray(status)) return data;
      const configKey = jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data');
      return { ...data, [statusKey]: { ...status, [configKey]: augmentJsonList(status[configKey] || {}, catalog, true, onFusionStatus, onNativeModels) } };
    }
    if (!Buffer.isBuffer(data)) return data;
    if (!shape.status) return augmentProtoList(data, catalog, shape.sorts, onFusionStatus, onNativeModels);
    return rewriteMessage(data, shape.field, status => rewriteMessage(status, 33, list => augmentProtoList(list, catalog, true, onFusionStatus, onNativeModels), true));
  } catch { return data; }
}

function collectNativeModels(data, { rpc, format = {} } = {}) {
  const shape = rpcShape(rpc);
  if (!shape) return [];
  try {
    if (format.json === true) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
      let payload = data;
      if (shape.status) {
        const status = data[jsonKey(data, 'userStatus', 'user_status')];
        if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
        payload = status[jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data')] || {};
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      const list = payload[jsonKey(payload, 'clientModelConfigs', 'client_model_configs')];
      return Array.isArray(list) ? nativeEntries(list, true) : [];
    }
    if (!Buffer.isBuffer(data)) return [];
    if (!shape.status) return nativeEntries(parseFields(data).filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false);
    const statuses = parseFields(data).filter(field => field.number === 1);
    if (statuses.length !== 1 || statuses[0].wire !== 2) return [];
    const lists = parseFields(statuses[0].value).filter(field => field.number === 33);
    if (lists.length !== 1 || lists[0].wire !== 2) return [];
    return nativeEntries(parseFields(lists[0].value).filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false);
  } catch { return []; }
}

// The CLI intersects the model catalog with its configured choices. Register
// only locally routed BYOK models; native choices and every other setting stay
// byte-identical. A native Sidekick must already be in the native choice list.
function augmentLocalModelChoices(data, format, catalog) {
  if (!catalog?.models?.length) return data;
  try {
    const key = format.json ? jsonKey(data, 'allowedModelUids', 'allowed_model_uids') : null;
    const parsed = format.json ? null : parseFields(data);
    const entries = format.json ? data[key] : parsed.filter(f => f.number === 7).map(f => {
      if (f.wire !== 2) throw new Error('Invalid model choice');
      return f.value.toString('utf8');
    });
    // An absent or empty list is unrestricted; do not turn it into a restriction.
    if (entries === undefined || Array.isArray(entries) && entries.length === 0) return data;
    if (!Array.isArray(entries) || entries.some(uid => typeof uid !== 'string')) return data;
    const native = new Set(entries.filter(uid => !ownUid(uid)));
    const additions = catalog.models.filter(model => {
      if (!ownUid(model.uid)) return false;
      if (Object.hasOwn(catalog.routes, model.uid)) return true;
      const fusion = catalog.fusions[model.uid];
      return fusion && ownUid(fusion.leadUid) && Object.hasOwn(catalog.routes, fusion.leadUid) &&
        (fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid));
    }).map(model => model.uid);
    if (format.json) return { ...data, [key]: [...entries.filter(uid => !ownUid(uid)), ...additions] };
    return concat([...parsed.filter(f => !(f.number === 7 && ownUid(f.value.toString('utf8')))).map(f => f.raw), ...additions.map(uid => s(7, uid))]);
  } catch { return data; }
}

function assignmentUid(data, format, field, camel, snake) {
  if (format.json === true) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid assignment');
    if (has(data, camel) && has(data, snake) && data[camel] !== data[snake]) throw new Error('Ambiguous assignment');
    const value = data[camel] ?? data[snake] ?? '';
    if (typeof value !== 'string') throw new Error('Invalid assignment uid');
    return value;
  }
  const values = parseFields(data).filter(value => value.number === field);
  if (values.length > 1 || values.some(value => value.wire !== 2)) throw new Error('Ambiguous assignment');
  return values[0]?.value.toString('utf8') || '';
}

function resolveAssignment(data, format = {}, catalog, lockedFusionUids) {
  try {
    const router = assignmentUid(data, format, 2, 'modelRouterUid', 'model_router_uid');
    const leadRouter = assignmentUid(data, format, 6, 'fusionLeadRouterUid', 'fusion_lead_router_uid');
    const uid = leadRouter || router;
    let fusion = has(catalog?.fusions, uid) ? catalog.fusions[uid] : null;
    let redirected = false;
    // A locked official Fusion selection (free account) falls back to the
    // configured combination; enabled official entries keep their native path.
    if (!fusion && uid.startsWith('fusion-') && !ownUid(uid) && lockedFusionUids instanceof Set && lockedFusionUids.has(uid)) {
      fusion = defaultFusion(catalog);
      redirected = !!fusion;
    }
    if (!fusion) return null;
    const modelUid = leadRouter ? fusion.sidekickUid : fusion.leadUid;
    if (leadRouter && fusion.sidekickNative) {
      if (!Array.isArray(fusion.sidekickHarnessUids) || !fusion.sidekickHarnessUids.length) return null;
    } else if (!has(catalog.routes, modelUid)) return null;
    const harnessUids = leadRouter ? (fusion.sidekickNative ? fusion.sidekickHarnessUids : [...SIDEKICK_HARNESSES]) : ['fusion'];
    const result = format.json === true ? { assignment: { modelUid, harnessUids } }
      : m(1, concat([s(2, modelUid), ...harnessUids.map(harness => s(3, harness))]));
    if (redirected) Object.defineProperty(result, 'redirectedFrom', { value: uid });
    return result;
  } catch { return null; }
}

module.exports = { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels };
