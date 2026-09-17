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
function refKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return '';
  const hasNative = typeof ref.nativeUid === 'string' && ref.nativeUid.length > 0 && ref.nativeUid.length <= 256 && !ownUid(ref.nativeUid);
  const hasProvider = typeof ref.providerId === 'string' && typeof ref.model === 'string' && ref.providerId.length > 0 && ref.model.length > 0;
  if (hasNative && !ref.providerId && !ref.model) return JSON.stringify(['native', ref.nativeUid]);
  if (hasProvider && !ref.nativeUid) return JSON.stringify(['provider', ref.providerId, ref.model]);
  return '';
}

function presetUid(id) {
  return 'fusion-dfbyok-preset-' + digest(['preset', id]).slice(0, 24);
}

function normalizeFusionConfig(config, nativeModels = []) {
  if (Object.hasOwn(config, 'fusionPresets') || config.enabled === false) return config;
  const catalog = buildCatalog(config, nativeModels);
  if (!catalog.migrationPending) {
    config.fusionPresets = catalog.savedPresets;
    if (catalog.migratedFrom) config.defaultFusionUid = catalog.defaultFusionUid;
  }
  return config;
}

function stableOrders(keys, reserved) {
  const result = new Map(), used = new Set(reserved || []);
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

function discoverOfficialRoles(nativeModels, hiddenSet, config = {}) {
  const observed = Array.isArray(nativeModels) ? nativeModels : [];
  const observedUids = new Set();
  const nativeModelsMap = new Map();
  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (uid && uid.length <= 256 && !ownUid(uid) && !uid.startsWith('fusion-')) {
      observedUids.add(uid);
      nativeModelsMap.set(uid, entry);
    }
  }

  const reservedOrders = new Set(), reservedLeadOrders = new Set();
  const leadNamesByOrder = new Map(), leadClaimsByTuple = new Map();
  const sidekickClaimsByUid = new Map(), sidekickClaimsByOrder = new Map();
  const officialCombos = [];

  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid.startsWith('fusion-') || ownUid(uid)) continue;
    const marker = uid.lastIndexOf('-sidekick-');
    if (marker < 0 || marker <= 'fusion-'.length) continue;

    const fusionMeta = Array.isArray(entry.fusionMetadata) ? entry.fusionMetadata : null;
    let leadDim = fusionMeta?.find(d => d.key === 'Lead');
    let effortDim = fusionMeta?.find(d => d.key === 'Effort');
    let sidekickDim = fusionMeta?.find(d => d.key === 'Sidekick');
    let fastModeDim = fusionMeta?.find(d => d.key === 'Fast Mode');

    if (!sidekickDim && entry.sidekickDimension) {
      sidekickDim = { order: entry.sidekickDimension.order, name: entry.sidekickDimension.name, controlType: 3 };
      fastModeDim = { order: entry.sidekickDimension.fastModeOrder ?? 0 };
    }

    if (leadDim && Number.isSafeInteger(leadDim.order) && leadDim.order >= 0 && leadDim.order <= 0x7fffffff) {
      reservedLeadOrders.add(leadDim.order);
    }
    if (sidekickDim && Number.isSafeInteger(sidekickDim.order) &&
        sidekickDim.order >= 0 && sidekickDim.order <= 0x7fffffff) {
      reservedOrders.add(sidekickDim.order);
    }

    const leadCandidate = uid.slice('fusion-'.length, marker);
    const sideCandidate = uid.slice(marker + '-sidekick-'.length);
    const leadKnown = observedUids.has(leadCandidate);
    const sideKnown = observedUids.has(sideCandidate);

    officialCombos.push({
      entry, uid, leadCandidate, sideCandidate, leadKnown, sideKnown,
      disabled: entry.disabled === true,
      fastModeOrder: fastModeDim ? fastModeDim.order : 0,
      leadDim, effortDim, sidekickDim,
    });

    if (fastModeDim && fastModeDim.order !== 0) continue;
    if (entry.disabled !== false) continue;
    if (!Array.isArray(entry.harnessUids) || !entry.harnessUids.includes('fusion')) continue;

    const sideNative = sideKnown ? nativeModelsMap.get(sideCandidate) : null;
    if (sideKnown && sideNative.disabled === false && sideNative.isModelRouter === false && sideNative.harnessUids?.length && !hiddenSet.has(sideCandidate)) {
      if (sidekickDim && Number.isSafeInteger(sidekickDim.order) && sidekickDim.name) {
        if (!sidekickClaimsByUid.has(sideCandidate)) {
          sidekickClaimsByUid.set(sideCandidate, { orders: new Set(), names: new Set() });
        }
        const rec = sidekickClaimsByUid.get(sideCandidate);
        rec.orders.add(sidekickDim.order);
        rec.names.add(sidekickDim.name);
        if (!sidekickClaimsByOrder.has(sidekickDim.order)) sidekickClaimsByOrder.set(sidekickDim.order, new Set());
        sidekickClaimsByOrder.get(sidekickDim.order).add(sideCandidate);
      }
    }

    if (!leadKnown || !sideKnown) continue;
    const leadNative = nativeModelsMap.get(leadCandidate);
    if (leadNative.disabled !== false || leadNative.isModelRouter !== false || !leadNative.harnessUids?.length || hiddenSet.has(leadCandidate)) continue;
    if (sideNative.disabled !== false || sideNative.isModelRouter !== false || !sideNative.harnessUids?.length || hiddenSet.has(sideCandidate)) continue;

    if (leadDim && Number.isSafeInteger(leadDim.order) && leadDim.name &&
        effortDim && Number.isSafeInteger(effortDim.order) && effortDim.name) {
      if (!leadNamesByOrder.has(leadDim.order)) leadNamesByOrder.set(leadDim.order, new Set());
      leadNamesByOrder.get(leadDim.order).add(leadDim.name);

      if (!leadClaimsByTuple.has(leadCandidate)) {
        leadClaimsByTuple.set(leadCandidate, {
          leadOrder: leadDim.order, leadName: leadDim.name,
          effortOrder: effortDim.order, effortName: effortDim.name,
          harnesses: new Set(),
          tuples: new Set(),
        });
      }
      const rec = leadClaimsByTuple.get(leadCandidate);
      rec.tuples.add(leadDim.order + ':' + effortDim.order + ':' + leadDim.name + ':' + effortDim.name);
      rec.harnesses.add(JSON.stringify(entry.harnessUids));
    }
  }

  const inconsistentLeadOrders = new Set();
  for (const [order, names] of leadNamesByOrder) {
    if (names.size > 1) inconsistentLeadOrders.add(order);
  }

  const leadConflicts = new Set();
  const uidByTuple = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (rec.tuples.size !== 1 || rec.harnesses.size !== 1 || inconsistentLeadOrders.has(rec.leadOrder)) {
      leadConflicts.add(uid);
      continue;
    }
    const tupleKey = rec.leadOrder + ':' + rec.effortOrder;
    if (uidByTuple.has(tupleKey)) {
      leadConflicts.add(uid);
      leadConflicts.add(uidByTuple.get(tupleKey));
    } else {
      uidByTuple.set(tupleKey, uid);
    }
  }

  const sidekickConflicts = new Set();
  for (const uids of sidekickClaimsByOrder.values()) if (uids.size > 1) for (const u of uids) sidekickConflicts.add(u);
  for (const [u, rec] of sidekickClaimsByUid) {
    if (rec.orders.size !== 1 || rec.names.size !== 1) sidekickConflicts.add(u);
  }

  const eligibleNativeLeads = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (leadConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const harnesses = JSON.parse([...rec.harnesses][0]);
    eligibleNativeLeads.set(uid, {
      uid, label: native.label || uid,
      leadDimension: { order: rec.leadOrder, name: rec.leadName, controlType: 3 },
      effortDimension: { order: rec.effortOrder, name: rec.effortName, controlType: 1 },
      leadHarnessUids: harnesses,
      maxTokens: native.maxTokens,
      maxOutputTokens: native.maxOutputTokens,
      supportsImages: native.supportsImages,
    });
  }

  const eligibleNativeSidekicks = new Map();
  for (const [uid, rec] of sidekickClaimsByUid) {
    if (sidekickConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const sidekickOrder = [...rec.orders][0];
    const sidekickName = [...rec.names][0];
    eligibleNativeSidekicks.set(uid, {
      uid, label: sidekickName || native.label || uid,
      dimension: { order: sidekickOrder, name: sidekickName },
      harnessUids: native.harnessUids,
    });
  }

  const hiddenFusionUids = [];
  if (config.enabled !== false) {
    const leadExclusions = new Set((Array.isArray(config.roleExclusions?.lead) ? config.roleExclusions.lead : []).map(refKey));
    const sidekickExclusions = new Set((Array.isArray(config.roleExclusions?.sidekick) ? config.roleExclusions.sidekick : []).map(refKey));
    for (const combo of officialCombos) {
      if (combo.disabled) {
        hiddenFusionUids.push(combo.uid);
        continue;
      }
      if (combo.leadDim && Number.isSafeInteger(combo.leadDim.order) &&
          combo.effortDim && Number.isSafeInteger(combo.effortDim.order)) {
        let leadExcluded = false;
        for (const [leadUid, native] of eligibleNativeLeads) {
          if (native.leadDimension && native.leadDimension.order === combo.leadDim.order &&
              native.effortDimension && native.effortDimension.order === combo.effortDim.order) {
            if (leadExclusions.has(refKey({ nativeUid: leadUid })) || hiddenSet.has(leadUid)) {
              leadExcluded = true; break;
            }
          }
        }
        if (leadExcluded) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
      if (combo.sidekickDim && Number.isSafeInteger(combo.sidekickDim.order)) {
        let sideExcluded = false;
        for (const [sideUid, native] of eligibleNativeSidekicks) {
          if (native.dimension && native.dimension.order === combo.sidekickDim.order) {
            if (sidekickExclusions.has(refKey({ nativeUid: sideUid })) || hiddenSet.has(sideUid)) {
              sideExcluded = true; break;
            }
          }
        }
        if (sideExcluded) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
      if (combo.leadKnown && combo.sideKnown) {
        const leadRef = refKey({ nativeUid: combo.leadCandidate });
        const sideRef = refKey({ nativeUid: combo.sideCandidate });
        const leadNative = nativeModelsMap.get(combo.leadCandidate);
        const sideNative = nativeModelsMap.get(combo.sideCandidate);
        const leadDisabled = leadNative?.disabled === true || leadNative?.isModelRouter === true || hiddenSet.has(combo.leadCandidate);
        const sideDisabled = sideNative?.disabled === true || sideNative?.isModelRouter === true || hiddenSet.has(combo.sideCandidate);
        if (leadDisabled || sideDisabled || leadExclusions.has(leadRef) || sidekickExclusions.has(sideRef)) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
    }
  }

  return { eligibleNativeLeads, eligibleNativeSidekicks, reservedOrders, reservedLeadOrders, hiddenFusionUids };
}

function buildRoleLists(config = {}, nativeModels = []) {
  const hiddenSet = new Set(Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []);
  const { eligibleNativeLeads, eligibleNativeSidekicks } = discoverOfficialRoles(nativeModels, hiddenSet, config);
  const leadExclusions = new Set((Array.isArray(config.roleExclusions?.lead) ? config.roleExclusions.lead : []).map(refKey));
  const sidekickExclusions = new Set((Array.isArray(config.roleExclusions?.sidekick) ? config.roleExclusions.sidekick : []).map(refKey));

  const providers = Array.isArray(config.providers) ? config.providers : [];
  const leadList = [], sidekickList = [];
  const seenLeadKeys = new Set(), seenSidekickKeys = new Set();

  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string') continue;
    const providerEnabled = provider.enabled !== false;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || typeof model.id !== 'string') continue;
      const ref = { providerId: provider.id, model: model.id };
      const key = refKey(ref);
      const prefix = provider.name || provider.id, sourceLabel = model.label || model.id;
      const label = sourceLabel.startsWith(prefix + ' · ') ? sourceLabel : `${prefix} · ${sourceLabel}`;
      const available = providerEnabled && model.enabled !== false;

      if (!seenLeadKeys.has(key)) {
        seenLeadKeys.add(key);
        leadList.push({
          ref, label, native: false,
          available, selected: available && !leadExclusions.has(key),
          ...(available ? {} : { disabled: true, reason: '已在供应商中停用' }),
        });
      }
      if (!seenSidekickKeys.has(key)) {
        seenSidekickKeys.add(key);
        sidekickList.push({
          ref, label, native: false,
          available, selected: available && !sidekickExclusions.has(key),
          ...(available ? {} : { disabled: true, reason: '已在供应商中停用' }),
        });
      }
    }
  }

  for (const nativeLead of eligibleNativeLeads.values()) {
    const ref = { nativeUid: nativeLead.uid };
    const key = refKey(ref);
    seenLeadKeys.add(key);
    leadList.push({
      ref, label: nativeLead.label || nativeLead.uid, native: true,
      available: true, selected: !leadExclusions.has(key),
    });
  }

  for (const nativeSidekick of eligibleNativeSidekicks.values()) {
    const ref = { nativeUid: nativeSidekick.uid };
    const key = refKey(ref);
    seenSidekickKeys.add(key);
    sidekickList.push({
      ref, label: nativeSidekick.label || nativeSidekick.uid, native: true,
      available: true, selected: !sidekickExclusions.has(key),
    });
  }

  for (const ref of Array.isArray(config.roleExclusions?.lead) ? config.roleExclusions.lead : []) {
    const key = refKey(ref);
    if (!key || seenLeadKeys.has(key)) continue;
    seenLeadKeys.add(key);
    leadList.push({
      ref, label: ref.nativeUid || ((ref.providerId || '') + ' · ' + (ref.model || '')),
      native: !!ref.nativeUid, available: false, selected: false,
      disabled: true, reason: '当前未在可用列表中',
    });
  }
  for (const ref of Array.isArray(config.roleExclusions?.sidekick) ? config.roleExclusions.sidekick : []) {
    const key = refKey(ref);
    if (!key || seenSidekickKeys.has(key)) continue;
    seenSidekickKeys.add(key);
    sidekickList.push({
      ref, label: ref.nativeUid || ((ref.providerId || '') + ' · ' + (ref.model || '')),
      native: !!ref.nativeUid, available: false, selected: false,
      disabled: true, reason: '当前未在可用列表中',
    });
  }

  return { lead: leadList, sidekick: sidekickList };
}

/** Build a secret-free catalog. Provider credentials stay solely in caller configuration. */
function buildCatalog(config = {}, nativeModels = []) {
  if (config.enabled === false) {
    return { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: [], hiddenFusionUids: [] };
  }
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
  const hiddenNativeModelUids = [];
  for (const uid of Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []) {
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid) || hiddenNativeModelUids.includes(uid)) continue;
    hiddenNativeModelUids.push(uid);
  }
  const hiddenSet = new Set(hiddenNativeModelUids);
  const { eligibleNativeLeads, eligibleNativeSidekicks, hiddenFusionUids } =
    discoverOfficialRoles(nativeModels, hiddenSet, config);

  // Labels also identify entries in native sort groups. Disambiguate providers
  // with equal display names without changing stable routing identities.
  const familyKeys = new Map();
  for (const lead of leads) {
    if (!familyKeys.has(lead.familyLabel)) familyKeys.set(lead.familyLabel, new Set());
    familyKeys.get(lead.familyLabel).add(lead.key);
  }
  for (const lead of leads) if (familyKeys.get(lead.familyLabel).size > 1) lead.familyLabel += ` (${lead.providerId}/${lead.model})`;
  for (const lead of leads) {
    const effort = effortMetadata(lead.effort);
    models.push(configFor({ ...lead, label: lead.familyLabel + (lead.effort ? ` ${effort.name}` : ''),
      familyUid: 'dfbyok-family-' + digest(lead.key).slice(0, 16),
      family: { modelFamilyLabel: lead.familyLabel, entries: [{ key: 'Effort', value: effort }] } }));
  }

  const leadExclusions = new Set((config.roleExclusions?.lead || []).map(refKey));
  const sidekickExclusions = new Set((config.roleExclusions?.sidekick || []).map(refKey));

  if (Array.isArray(config.sidekicks)) {
    for (const item of config.sidekicks) {
      if (item?.nativeUid) {
        if (typeof item.nativeUid !== 'string' || !item.nativeUid || item.nativeUid.length > 256 || ownUid(item.nativeUid)) {
          throw new Error('Invalid native Sidekick uid');
        }
      } else if (item?.providerId || item?.model) {
        if (typeof item.providerId !== 'string' || typeof item.model !== 'string' ||
            !leads.some(l => l.providerId === item.providerId && l.model === item.model)) {
          throw new Error('Sidekick references an unavailable configured model');
        }
      }
    }
  }

  const selectedImportedLeads = leads.filter(lead => !leadExclusions.has(refKey({ providerId: lead.providerId, model: lead.model })));
  const selectedNativeLeads = [...eligibleNativeLeads.values()].filter(native => !leadExclusions.has(refKey({ nativeUid: native.uid })));

  const sidekicks = [], seenSidekicks = new Set();
  const leadFamilies = new Map();
  for (const lead of leads) {
    if (!leadFamilies.has(lead.key)) leadFamilies.set(lead.key, []);
    leadFamilies.get(lead.key).push(lead);
  }
  for (const [key, candidates] of leadFamilies) {
    const lead = candidates.find(item => !item.effort) || candidates.find(item => item.effort === 'high') || candidates[0];
    if (!lead) continue;
    const ref = { providerId: lead.providerId, model: lead.model };
    if (!seenSidekicks.has(key) && !sidekickExclusions.has(refKey(ref))) {
      seenSidekicks.add(key);
      sidekicks.push({ uid: lead.uid, label: lead.familyLabel, native: false, providerId: lead.providerId, model: lead.model });
    }
  }
  for (const native of [...eligibleNativeSidekicks.values()].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)) {
    const ref = { nativeUid: native.uid };
    if (!seenSidekicks.has(native.uid) && !sidekickExclusions.has(refKey(ref))) {
      seenSidekicks.add(native.uid);
      sidekicks.push({ uid: native.uid, label: native.label, native: true, harnessUids: native.harnessUids, dimension: native.dimension });
    }
  }

  const importedCandidate = lead => ({ ...lead, native: false,
    ref: { providerId: lead.providerId, model: lead.model, effort: lead.effort },
    label: lead.familyLabel + (lead.effort ? ` · ${effortMetadata(lead.effort).name}` : ' · 默认档位') });
  const candidates = {
    lead: [...selectedImportedLeads.map(importedCandidate), ...selectedNativeLeads.map(native => ({
      ...native, native: true, ref: { nativeUid: native.uid },
      contextWindow: positive(native.maxTokens, 272000),
      maxOutputTokens: Math.min(positive(native.maxOutputTokens, 16384), positive(native.maxTokens, 272000)),
      inferenceServerUrl,
    }))],
    sidekick: [...leads.filter(lead => !sidekickExclusions.has(refKey(lead))).map(importedCandidate),
      ...sidekicks.filter(sidekick => sidekick.native).map(sidekick => ({ ...sidekick, ref: { nativeUid: sidekick.uid } }))],
  };
  const candidateKey = ref => refKey(ref) && !(ref.nativeUid && Object.hasOwn(ref, 'effort')) && JSON.stringify([refKey(ref), ref.nativeUid ? null : ref.effort ?? null]);
  const indexes = Object.fromEntries(Object.entries(candidates).map(([role, items]) => [role, new Map(items.map(item => [candidateKey(item.ref), item]))]));
  let savedPresets = Array.isArray(config.fusionPresets) ? config.fusionPresets : [];
  let migratedFrom;
  if (!Object.hasOwn(config, 'fusionPresets') && typeof config.defaultFusionUid === 'string') {
    const oldUid = config.defaultFusionUid;
    let lead, sidekick;
    if (oldUid.startsWith('fusion-dfbyok-native-')) {
      for (const native of candidates.lead.filter(item => item.native)) {
        const found = sidekicks.find(item => !item.native && oldUid === `fusion-dfbyok-native-${digest([native.uid, item.uid]).slice(0, 24)}`);
        if (found) { lead = native; sidekick = candidates.sidekick.find(item => item.uid === found.uid); break; }
      }
    } else {
      lead = candidates.lead.find(item => !item.native && oldUid.startsWith(`fusion-${item.uid}-sidekick-`));
      if (lead) sidekick = candidates.sidekick.find(item => oldUid === `fusion-${lead.uid}-sidekick-${digest(item.uid).slice(0, 16)}`);
    }
    if (lead && sidekick) {
      savedPresets = [{ id: 'legacy-default', name: '原默认组合', lead: lead.ref, sidekick: sidekick.ref }];
      migratedFrom = oldUid;
    }
  }
  const nameCounts = new Map(), idCounts = new Map();
  for (const preset of savedPresets) {
    if (typeof preset?.name === 'string') nameCounts.set(preset.name.trim().toLowerCase(), (nameCounts.get(preset.name.trim().toLowerCase()) || 0) + 1);
    if (typeof preset?.id === 'string') idCounts.set(preset.id, (idCounts.get(preset.id) || 0) + 1);
  }
  const presetStates = [];
  const labels = new Set([...models.map(item => item.label), ...nativeModels.map(item => item.label)]);
  const presetModels = [];
  for (const preset of savedPresets) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) continue;
    const valid = typeof preset.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(preset.id) && idCounts.get(preset.id) === 1 &&
      typeof preset.name === 'string' && preset.name.trim().length > 0 && preset.name.length <= 80 && !/[\u0000-\u001f]/.test(preset.name) && nameCounts.get(preset.name.trim().toLowerCase()) === 1;
    const lead = indexes.lead.get(candidateKey(preset.lead));
    const sidekick = indexes.sidekick.get(candidateKey(preset.sidekick));
    const uid = presetUid(preset.id);
    const available = !!(valid && lead && sidekick);
    presetStates.push({ id: preset.id, name: preset.name, lead: preset.lead, sidekick: preset.sidekick, uid, available,
      leadLabel: lead?.label, sidekickLabel: sidekick?.label,
      reason: !valid ? '预设名称或标识无效或重复' : !lead ? 'Lead 当前不可用或已从角色列表移除' : !sidekick ? 'Sidekick 当前不可用或已从角色列表移除' : '' });
    if (!available) continue;
    let label = preset.name.trim();
    if (labels.has(label)) label += ` · Fusion ${digest(preset.id).slice(0, 8)}`;
    labels.add(label);
    const family = { modelFamilyLabel: label, entries: [] };
    presetModels.push(configFor({ ...lead, uid, label, family, familyUid: `dfbyok-preset-family-${digest(preset.id).slice(0, 24)}`, fusion: true }));
    fusions[uid] = { uid, label, presetId: preset.id, leadUid: lead.uid, sidekickUid: sidekick.uid,
      leadNative: lead.native, sidekickNative: sidekick.native,
      ...(lead.native ? { leadHarnessUids: lead.leadHarnessUids } : {}),
      ...(sidekick.native ? { sidekickHarnessUids: sidekick.harnessUids } : {}) };
  }
  return { models: [...presetModels, ...models], routes, fusions, sidekicks, hiddenNativeModelUids, hiddenFusionUids,
    presetStates, savedPresets, migratedFrom,
    migrationPending: !Object.hasOwn(config, 'fusionPresets') && !!config.defaultFusionUid && !migratedFrom,
    presetCandidates: Object.fromEntries(Object.entries(candidates).map(([role, items]) => [role, items.map(item => ({ ref: item.ref, label: item.label }))])),
    defaultFusionUid: migratedFrom ? presetUid('legacy-default') : typeof config.defaultFusionUid === 'string' ? config.defaultFusionUid : undefined };
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
    const maxTokensFields = inner.filter(field => field.number === 4);
    const maxOutputFields = inner.filter(field => field.number === 13);
    const featuresFields = inner.filter(field => field.number === 6);
    let maxTokens, maxOutputTokens, supportsImages = false;
    if (maxTokensFields.length === 1 && maxTokensFields[0].wire === 0) {
      const val = Number(maxTokensFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxTokens = val;
    }
    if (maxOutputFields.length === 1 && maxOutputFields[0].wire === 0) {
      const val = Number(maxOutputFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxOutputTokens = val;
    }
    if (featuresFields.length === 1 && featuresFields[0].wire === 2) {
      const featInner = parseFields(featuresFields[0].value);
      const imgFields = featInner.filter(f => f.number === 11);
      if (imgFields.length === 1 && imgFields[0].wire === 0 && Number(imgFields[0].value) === 1) {
        supportsImages = true;
      }
    }
    return {
      harnessUids: harnesses.map(field => field.value.toString('utf8')),
      isModelRouter: routers.length === 1 && Number(routers[0].value) !== 0,
      ...(maxTokens ? { maxTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(supportsImages ? { supportsImages: true } : {}),
    };
  } catch { return { harnessUids: [], isModelRouter: false }; }
}

const CANONICAL_FAMILY_KEYS = new Set(['Lead', 'Effort', 'Sidekick', 'Fast Mode', 'Recommended Sidekick']);

function protoFusionMetadata(entry) {
  const families = parseFields(entry).filter(field => field.number === 30);
  if (!families.length) return null;
  if (families.length !== 1 || families[0].wire !== 2) return null;
  try {
    const parts = parseFields(families[0].value);
    if (parts.some(field => field.number === 2 && field.wire !== 2)) return null;
    const entries = [];
    const keys = new Set();
    for (const field of parts.filter(field => field.number === 2)) {
      const item = parseFields(field.value);
      const keyFields = item.filter(part => part.number === 1);
      if (keyFields.length !== 1 || keyFields[0].wire !== 2) return null;
      const key = keyFields[0].value.toString('utf8');
      if (!CANONICAL_FAMILY_KEYS.has(key)) continue;
      if (keys.has(key)) return null;
      keys.add(key);
      const valFields = item.filter(part => part.number === 2);
      if (valFields.length !== 1 || valFields[0].wire !== 2) return null;
      const dims = parseFields(valFields[0].value);
      const orders = dims.filter(part => part.number === 1);
      const names = dims.filter(part => part.number === 2);
      const controls = dims.filter(part => part.number === 3);
      if (orders.length !== 1 || orders[0].wire !== 0) return null;
      if (names.length > 1 || names.some(part => part.wire !== 2)) return null;
      if (controls.length > 1 || controls.some(part => part.wire !== 0)) return null;
      const order = Number(orders[0].value);
      const name = names.length ? names[0].value.toString('utf8') : '';
      const controlType = controls.length ? Number(controls[0].value) : 0;
      if (!Number.isSafeInteger(order) || order < 0 || order > 0x7fffffff) return null;
      if (!Number.isSafeInteger(controlType) || controlType < 0 || controlType > 0x7fffffff) return null;
      if (key !== 'Fast Mode' && !name) return null;
      entries.push({ key, order, name, controlType });
    }
    return entries.length ? entries : null;
  } catch { return null; }
}

function extractSidekickDimension(entries) {
  if (!Array.isArray(entries)) return null;
  const sidekick = entries.find(e => e.key === 'Sidekick');
  if (!sidekick || !sidekick.name) return null;
  const fastMode = entries.find(e => e.key === 'Fast Mode');
  return { order: sidekick.order, name: sidekick.name, fastModeOrder: fastMode ? fastMode.order : 0 };
}

function protoSidekick(entry) {
  return extractSidekickDimension(protoFusionMetadata(entry));
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
  const maxTokens = jsonAliasValue(info.value, 'maxTokens', 'max_tokens');
  const maxOutputTokens = jsonAliasValue(info.value, 'maxOutputTokens', 'max_output_tokens');
  const features = jsonAliasValue(info.value, 'modelFeatures', 'model_features');
  let supportsImages = false;
  if (!features.conflict && features.present && features.value && typeof features.value === 'object' && !Array.isArray(features.value)) {
    const img = jsonAliasValue(features.value, 'supportsImages', 'supports_images');
    if (!img.conflict && img.present && img.value === true) supportsImages = true;
  }
  return {
    harnessUids: harness.present ? harness.value : [],
    isModelRouter: router.value === true,
    ...(!maxTokens.conflict && maxTokens.present && Number.isSafeInteger(maxTokens.value) && maxTokens.value > 0 ? { maxTokens: maxTokens.value } : {}),
    ...(!maxOutputTokens.conflict && maxOutputTokens.present && Number.isSafeInteger(maxOutputTokens.value) && maxOutputTokens.value > 0 ? { maxOutputTokens: maxOutputTokens.value } : {}),
    ...(supportsImages ? { supportsImages: true } : {}),
  };
}

function jsonFusionMetadata(entry) {
  const meta = jsonAliasValue(entry, 'modelFamilyMetadata', 'model_family_metadata');
  if (meta.conflict || !meta.present || !meta.value || typeof meta.value !== 'object' || Array.isArray(meta.value)) return null;
  const list = meta.value.entries;
  if (!Array.isArray(list)) return null;
  const entries = [];
  const keys = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string') return null;
    const key = item.key;
    if (!CANONICAL_FAMILY_KEYS.has(key)) continue;
    if (keys.has(key)) return null;
    keys.add(key);
    const value = item.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const control = jsonAliasValue(value, 'controlType', 'control_type');
    if (control.conflict || (control.present && (!Number.isSafeInteger(control.value) || control.value < 0 || control.value > 0x7fffffff))) return null;
    if (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 0x7fffffff) return null;
    if (value.name !== undefined && typeof value.name !== 'string') return null;
    const name = typeof value.name === 'string' ? value.name : '';
    const controlType = control.present ? control.value : 0;
    if (key !== 'Fast Mode' && !name) return null;
    entries.push({ key, order: value.order, name, controlType });
  }
  return entries.length ? entries : null;
}

function jsonSidekick(entry) {
  return extractSidekickDimension(jsonFusionMetadata(entry));
}

function nativeEntries(entries, isJson) {
  const seen = [];
  for (const entry of entries) {
    let uid, label, disabled, meta, dimension, fusionMeta;
    if (isJson) {
      uid = nativeUid(entry);
      label = typeof entry?.label === 'string' ? entry.label : '';
      disabled = has(entry, 'disabled') ? entry.disabled !== false : false;
      meta = jsonMetadata(entry);
      fusionMeta = jsonFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
    } else {
      uid = protoUid(entry);
      label = str(entry, 1);
      disabled = protoDisabled(entry);
      meta = protoMetadata(entry);
      fusionMeta = protoFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
    }
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid)) continue;
    seen.push({
      uid, label, disabled, harnessUids: meta.harnessUids, isModelRouter: meta.isModelRouter,
      ...(dimension ? { sidekickDimension: dimension } : {}),
      ...(fusionMeta ? { fusionMetadata: fusionMeta } : {}),
      ...(meta.maxTokens ? { maxTokens: meta.maxTokens } : {}),
      ...(meta.maxOutputTokens ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      ...(meta.supportsImages ? { supportsImages: true } : {}),
    });
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
  return fusion?.sidekickNative === false && fusion?.leadNative !== true && has(catalog?.routes, fusion.leadUid) && has(catalog?.routes, fusion.sidekickUid) ? fusion : null;
}

function augmentProtoList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const parsed = parseFields(data), existingLabels = new Set(models.map(model => model.label));
  const entries = parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  reportFusionStatus(entries, false, onFusionStatus);
  reportNativeModels(entries, false, onNativeModels);
  const hiddenNative = new Set(catalog.hiddenNativeModelUids || []);
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const retainedLabels = new Set(models.map(model => model.label));
  const hiddenLabels = new Set();
  const preserved = [];
  for (const field of parsed) {
    if (field.number === 1 && field.wire === 2) {
      const uid = protoUid(field.value), label = str(field.value, 1);
      if (ownUid(uid)) { existingLabels.add(label); continue; }
      if (hiddenNative.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      if (hiddenFusion.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      retainedLabels.add(label);
    }
    preserved.push(field);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const labels = models.map(model => model.label);
  const groups = [{ name: '我的 Fusion', items: models.filter(model => model.kind === 'fusion') },
    { name: OWN_GROUP, items: models.filter(model => model.kind !== 'fusion') }]
    .filter(group => group.items.length).map(group => concat([s(1, group.name), ...group.items.map(model => s(2, model.label))]));
  let sorts = 0;
  const result = preserved.map(field => {
    if (!hasSorts || field.number !== 2 || field.wire !== 2) return field.raw;
    sorts++;
    const parts = parseFields(field.value).filter(part => {
      if (part.number !== 2 || part.wire !== 2 || ![OWN_GROUP, '我的 Fusion'].includes(str(part.value, 1))) return true;
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
    if (labels.length) rewritten.splice(position < 0 ? rewritten.length : position, 0, ...groups.map(group => ({ raw: m(2, group) })));
    return m(2, concat(rewritten.map(part => part.raw)));
  });
  const own = models.map(model => m(1, model.raw));
  result.splice(Math.max(preserved.findIndex(field => field.number === 1 && field.wire === 2), 0), 0, ...own);
  if (hasSorts && !sorts && labels.length) result.push(m(2, concat([s(1, OWN_GROUP), ...groups.map(group => m(2, group))])));
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
  const hiddenNative = new Set(catalog.hiddenNativeModelUids || []);
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const labels = models.map(model => model.label), existingLabels = new Set(labels);
  const retainedLabels = new Set(labels);
  const hiddenLabels = new Set();
  const kept = [];
  for (const model of existing) {
    const uid = nativeUid(model);
    if (ownUid(uid)) { existingLabels.add(model?.label); continue; }
    if (hiddenNative.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (hiddenFusion.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (typeof model?.label === 'string') retainedLabels.add(model.label);
    kept.push(model);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const groups = [{ groupName: '我的 Fusion', modelLabels: models.filter(model => model.kind === 'fusion').map(model => model.label) },
    { groupName: OWN_GROUP, modelLabels: models.filter(model => model.kind !== 'fusion').map(model => model.label) }].filter(group => group.modelLabels.length);
  const append = sort => ({ ...sort, groups: [...groups, ...(sort.groups || []).map(value => {
    const labelsKey = has(value, 'modelLabels') ? 'modelLabels' : has(value, 'model_labels') ? 'model_labels' : '';
    if (!labelsKey || !Array.isArray(value[labelsKey]) || !hiddenLabels.size) return value;
    const keptLabels = value[labelsKey].filter(label => !hiddenLabels.has(label));
    return keptLabels.length === value[labelsKey].length ? value : { ...value, [labelsKey]: keptLabels };
  }).filter(value =>
    ![OWN_GROUP, '我的 Fusion'].includes(value.groupName ?? value.group_name) || !(value.modelLabels ?? value.model_labels ?? []).every(label => existingLabels.has(label)))] });
  return { ...data,
    [modelsKey]: [...models.map(model => structuredClone(model.json)), ...kept],
    ...(hasSorts ? { [sortsKey]: sorts.length ? sorts.map(append) : (labels.length ? [{ name: OWN_GROUP, groups }] : sorts) } : {}),
  };
}

/** Accept decoded wire messages; framing/compression is exclusively the caller's responsibility. */
function augmentCatalog(data, { rpc, format = {}, catalog, onFusionStatus, onNativeModels } = {}) {
  if (rpc === '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return augmentLocalModelChoices(data, format, catalog);
  const shape = rpcShape(rpc);
  if (!shape || !catalog) return data;
  if (!catalog.models?.length && !catalog.hiddenNativeModelUids?.length && !catalog.hiddenFusionUids?.length &&
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
      if (!fusion) return false;
      if (fusion.leadNative) {
        if (!native.has(fusion.leadUid)) return false;
        return fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid);
      }
      return ownUid(fusion.leadUid) && Object.hasOwn(catalog.routes, fusion.leadUid) &&
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
    if (leadRouter) {
      if (fusion.sidekickNative) {
        if (!Array.isArray(fusion.sidekickHarnessUids) || !fusion.sidekickHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    } else {
      if (fusion.leadNative) {
        if (!Array.isArray(fusion.leadHarnessUids) || !fusion.leadHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    }
    let harnessUids;
    if (leadRouter) {
      harnessUids = fusion.sidekickNative ? fusion.sidekickHarnessUids : [...SIDEKICK_HARNESSES];
    } else {
      harnessUids = fusion.leadNative ? fusion.leadHarnessUids : ['fusion'];
    }
    const result = format.json === true ? { assignment: { modelUid, harnessUids } }
      : m(1, concat([s(2, modelUid), ...harnessUids.map(harness => s(3, harness))]));
    if (redirected) Object.defineProperty(result, 'redirectedFrom', { value: uid });
    return result;
  } catch { return null; }
}

module.exports = { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels, buildRoleLists, refKey, presetUid, normalizeFusionConfig };
