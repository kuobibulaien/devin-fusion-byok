'use strict';
const { randomUUID } = require('node:crypto');
const { buildCatalog, buildRoleLists, refKey, presetUid, normalizeFusionConfig } = require('../catalog.cjs');
const { discover: discoverModels } = require('../config.cjs');
const { modelSupportsImages } = require('../model-capabilities.cjs');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
class PanelInputError extends Error {}
const fail = message => { throw new PanelInputError(message); };
function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(label + '无效。');
  return value.trim();
}
function baseUrl(value) {
  let url; try { url = new URL(text(value, 'API 地址', 2048)); } catch { fail('请填写完整的 http:// 或 https:// API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('API 地址不能包含登录信息、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/(responses|chat\/completions)\/?$/, '').replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}
function boolean(value, label) { if (typeof value !== 'boolean') fail(label + '无效。'); return value; }
function number(value, label) { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) fail(label + '必须是正整数。'); return value; }
function providerAt(config, id) { return config.providers.find(provider => provider.id === id) || fail('该供应商已不存在，请刷新面板。'); }
function modelPatch(input, previous) {
  const model = { ...previous };
  if (own(input, 'label')) model.label = text(input.label, '模型名称');
  if (own(input, 'enabled')) model.enabled = boolean(input.enabled, '启用状态');
  if (own(input, 'supportsImages')) { boolean(input.supportsImages, '图片支持'); model.supportsImages = true; }
  if (own(input, 'contextWindow')) model.contextWindow = number(input.contextWindow, '上下文长度');
  if (own(input, 'maxOutputTokens')) model.maxOutputTokens = number(input.maxOutputTokens, '最大输出长度');
  if (own(input, 'efforts')) {
    if (!Array.isArray(input.efforts) || input.efforts.some(v => !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(v))) fail('推理强度列表无效。');
    model.efforts = [...new Set(input.efforts)];
  }
  if (own(input, 'effortMode')) {
    if (!['auto', 'manual', 'none'].includes(input.effortMode)) fail('推理档位来源无效。');
    model.effortMode = input.effortMode;
  }
  if (model.maxOutputTokens > model.contextWindow) fail('最大输出长度不能超过上下文长度。');
  return model;
}
function cleanSidekicks(config) {
  const valid = (config.sidekicks || []).filter(sidekick =>
    (typeof sidekick?.nativeUid === 'string' && sidekick.nativeUid.length > 0 && sidekick.nativeUid.length <= 256 &&
      !/^(?:fusion-)?dfbyok-/.test(sidekick.nativeUid) && !sidekick.nativeUid.startsWith('fusion-')) ||
    config.providers.some(provider => provider.id === sidekick?.providerId && provider.enabled !== false &&
      provider.models.some(model => model.id === sidekick?.model && model.enabled !== false)));
  config.sidekicks = valid;
}
function publicState(config, selectedFusionUid, nativeModels = [], autoContinueStatus = 'unavailable') {
  const catalog = buildCatalog({ ...config, enabled: true }, nativeModels);
  const hidden = new Set(catalog.hiddenNativeModelUids || []);
  const eligible = new Set(catalog.sidekicks.filter(sidekick => sidekick.native).map(sidekick => sidekick.uid));
  const observed = new Set();
  const natives = [];
  for (const entry of nativeModels) {
    if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
    observed.add(entry.uid);
    natives.push({ uid: entry.uid, label: typeof entry.label === 'string' && entry.label ? entry.label : entry.uid,
      disabled: entry.disabled === true, hidden: hidden.has(entry.uid), eligible: eligible.has(entry.uid) });
  }
  for (const uid of hidden) if (!observed.has(uid)) natives.push({ uid, label: uid, disabled: false, hidden: true, eligible: false });
  const roleLists = buildRoleLists(config, nativeModels);
  return {
    enabled: config.enabled !== false,
    providers: config.providers.map(provider => ({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat, enabled: provider.enabled !== false, keyConfigured: !!provider.apiKey,
      models: provider.models.map(model => ({ id: model.id, label: model.label || model.id, enabled: model.enabled !== false,
        efforts: model.efforts || [], effortMode: model.effortMode || (model.efforts?.length ? 'manual' : 'auto'),
        contextWindow: model.contextWindow || 272000, maxOutputTokens: model.maxOutputTokens || 16384,
        supportsImages: modelSupportsImages(model) })) })),
    sidekicks: catalog.sidekicks.map(sidekick => sidekick.native
      ? { nativeUid: sidekick.uid, label: sidekick.label } : { providerId: sidekick.providerId, model: sidekick.model }),
    roleLists,
    fusionPresets: catalog.presetStates || [],
    presetCandidates: catalog.presetCandidates || { lead: [], sidekick: [] },
    migrationPending: !!catalog.migrationPending,
    selectedFusionUid: catalog.migratedFrom === selectedFusionUid ? catalog.defaultFusionUid : selectedFusionUid,
    nativeModels: natives,
    modelCount: Object.keys(catalog.routes).length,
    fusionCount: Object.keys(catalog.fusions).length,
    fusionChoices: Object.values(catalog.fusions).map(fusion => ({ uid: fusion.uid, label: fusion.label })),
    autoContinueOnProviderError: config.autoContinueOnProviderError === true,
    autoContinueUntilPlanComplete: config.autoContinueUntilPlanComplete === true,
    autoContinueStatus: typeof autoContinueStatus === 'string' ? autoContinueStatus : 'unavailable',
  };
}
function createManager({ read, write, discover = discoverModels, afterChange = async () => {}, selectFusion = async () => {}, selectedFusion = () => '', nativeModels = () => [], refreshNativeModels = async () => {}, nativeCatalogStatus = () => 'empty', autoContinueStatus = () => 'unavailable' }) {
  let queue = Promise.resolve();
  let pendingImport;
  const signature = provider => JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey]);
  const state = () => {
    const config = read(), result = publicState(config, selectedFusion(), nativeModels(), autoContinueStatus());
    result.nativeCatalogStatus = nativeCatalogStatus();
    const provider = config.providers.find(p => p.id === pendingImport?.providerId);
    result.importCandidates = provider && signature(provider) === pendingImport.signature ? {
      providerId: provider.id, token: pendingImport.token,
      models: pendingImport.models.map(model => ({ id: model.id, label: model.label || model.id,
        imported: provider.models.some(existing => existing.id === model.id) })),
    } : null;
    return result;
  };
  async function apply(type, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('操作参数无效。');
    if (type === 'ready' || type === 'refreshNativeModels') { await refreshNativeModels(); return state(); }
    let config = normalizeFusionConfig(read(), nativeModels());
    if (type === 'selectFusion') {
      if (config.enabled === false) fail('请先启用 Fusion BYOK。');
      if (!own(buildCatalog(config, nativeModels()).fusions, payload.uid)) fail('该 Fusion 组合已不可用，请重新选择。');
      await selectFusion(payload.uid); return state();
    }
    switch (type) {
      case 'saveFusionPreset': {
        if (config.enabled === false) fail('请先启用插件再编辑预设。');
        const presets = Array.isArray(config.fusionPresets) ? config.fusionPresets : [];
        const existing = payload.id ? presets.find(item => item.id === payload.id) : null;
        if (payload.id && !existing) fail('该预设已不存在，请刷新面板。');
        const name = text(payload.name, '预设名称', 80);
        if (presets.some(item => item !== existing && item.name?.trim().toLowerCase() === name.toLowerCase())) fail('预设名称不能重复。');
        const candidates = buildCatalog(config, nativeModels()).presetCandidates;
        const references = {};
        for (const role of ['lead', 'sidekick']) {
          const ref = payload[role];
          if (!refKey(ref) || ref.nativeUid && own(ref, 'effort')) fail(role + ' 模型参数无效。');
          const clean = ref.nativeUid ? { nativeUid: ref.nativeUid } : { providerId: ref.providerId, model: ref.model, effort: ref.effort ?? null };
          const match = candidates[role].find(item => refKey(item.ref) === refKey(clean) && (item.ref.effort ?? null) === (clean.effort ?? null));
          const unchanged = existing && refKey(existing[role]) === refKey(clean) && (existing[role].effort ?? null) === (clean.effort ?? null);
          if (!match && !unchanged) fail(role + ' 当前不可用，请重新选择。');
          references[role] = clean;
        }
        const preset = { id: existing?.id || randomUUID(), name, ...references };
        config.fusionPresets = existing ? presets.map(item => item === existing ? preset : item) : [...presets, preset];
        break;
      }
      case 'deleteFusionPreset': {
        const presets = Array.isArray(config.fusionPresets) ? config.fusionPresets : [];
        if (!presets.some(item => item.id === payload.id)) fail('该预设已不存在。');
        config.fusionPresets = presets.filter(item => item.id !== payload.id);
        if (config.defaultFusionUid === presetUid(payload.id)) delete config.defaultFusionUid;
        break;
      }
      case 'saveProvider': {
        const existing = payload.id ? providerAt(config, payload.id) : null;
        const name = text(payload.name, '供应商名称', 80), url = baseUrl(payload.baseUrl);
        if (!['openai-responses', 'openai'].includes(payload.apiFormat)) fail('请选择 Responses 或 Chat Completions。');
        if (own(payload, 'apiKey') && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 8192 || /[\r\n]/.test(payload.apiKey))) fail('API Key 无效。');
        const apiKey = payload.apiKey?.trim() || existing?.apiKey || '';
        if (existing) {
          const previousName = existing.name;
          Object.assign(existing, { name, baseUrl: url, apiFormat: payload.apiFormat, apiKey });
          if (name !== previousName) for (const model of existing.models) if (model.label?.startsWith(previousName + ' · ')) model.label = name + model.label.slice(previousName.length);
        } else config.providers.push({ id: 'provider-' + randomUUID(), name, baseUrl: url, apiFormat: payload.apiFormat, apiKey, enabled: true, models: [] });
        break;
      }
      case 'deleteProvider': providerAt(config, payload.id); config.providers = config.providers.filter(p => p.id !== payload.id); break;
      case 'setProviderEnabled': providerAt(config, payload.id).enabled = boolean(payload.enabled, '启用状态'); break;
      case 'refreshModels': {
        const original = providerAt(config, payload.providerId), fetched = structuredClone(original);
        pendingImport = undefined;
        await discover(fetched);
        // Read again after the network request so another window's edits survive.
        config = read(); const current = providerAt(config, payload.providerId);
        if (signature(current) !== signature(original)) fail('供应商配置刚刚发生变化，请重新刷新模型。');
        // Validate a private candidate catalog, without changing saved models.
        buildCatalog({ ...config, providers: [{ ...current, enabled: true, models: fetched.models }], sidekicks: [] });
        pendingImport = { providerId: current.id, signature: signature(current), token: randomUUID(), models: fetched.models };
        return state();
      }
      case 'importModels': {
        const provider = providerAt(config, payload.providerId);
        if (!pendingImport || pendingImport.providerId !== provider.id || pendingImport.token !== payload.token ||
            pendingImport.signature !== signature(provider)) fail('模型列表已失效，请重新获取后选择。');
        if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.some(id => typeof id !== 'string') ||
            new Set(payload.ids).size !== payload.ids.length) fail('请选择要导入的模型。');
        const candidates = new Map(pendingImport.models.map(model => [model.id, model]));
        if (payload.ids.some(id => !candidates.has(id))) fail('所选模型不在获取的列表中，请重新选择。');
        const existing = new Set(provider.models.map(model => model.id));
        for (const id of payload.ids) if (!existing.has(id)) {
          const candidate = candidates.get(id);
          provider.models.push({ ...candidate, label: provider.name + ' · ' + id, enabled: true });
        }
        break;
      }
      case 'updateModels': {
        const provider = providerAt(config, payload.providerId);
        if (!Array.isArray(payload.changes || []) || !Array.isArray(payload.removeIds || [])) fail('模型修改列表无效。');
        for (const change of payload.changes || []) {
          const index = provider.models.findIndex(m => m.id === change?.id);
          if (index < 0) fail('该模型已不存在，请刷新面板。');
          provider.models[index] = modelPatch(change, provider.models[index]);
        }
        provider.models = provider.models.filter(m => !(payload.removeIds || []).includes(m.id));
        break;
      }
      case 'addModel': {
        const provider = providerAt(config, payload.providerId), input = payload.model;
        const id = text(input?.id, '模型 ID');
        if (provider.models.some(m => m.id === id)) fail('该模型已经在列表中。');
        provider.models.push(modelPatch(input, { id, label: id, enabled: true, efforts: [], contextWindow: 272000, maxOutputTokens: 32768, source: 'manual' }));
        break;
      }
      case 'setSidekicks': {
        if (!Array.isArray(payload.sidekicks)) fail('Sidekick 列表无效。');
        const eligibleNatives = new Map(buildCatalog({ ...config, sidekicks: [] }, nativeModels()).sidekicks.filter(item => item.native).map(item => [item.uid, item]));
        config.sidekicks = payload.sidekicks.map(sidekick => {
          if (sidekick && typeof sidekick.nativeUid === 'string') {
            const native = eligibleNatives.get(sidekick.nativeUid);
            if (!native) fail('该官方模型当前不可用作 Sidekick，请刷新目录后重试。');
            return { nativeUid: native.uid, label: native.label };
          }
          const provider = providerAt(config, sidekick?.providerId);
          if (provider.enabled === false || !provider.models.some(m => m.id === sidekick.model && m.enabled !== false)) fail('Sidekick 必须是已启用的模型。');
          return { providerId: provider.id, model: sidekick.model };
        });
        break;
      }
      case 'setNativeModelHidden': {
        const uid = payload.uid;
        if (typeof uid !== 'string' || !uid || uid.length > 256 || /^(?:fusion-)?dfbyok-/.test(uid)) fail('模型标识无效。');
        const hidden = boolean(payload.hidden, '显示状态');
        if (hidden && !nativeModels().some(entry => entry?.uid === uid)) fail('该官方模型当前未出现在列表中，请刷新后重试。');
        const seen = new Set(), list = [];
        for (const value of Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []) {
          if (typeof value !== 'string' || !value || value.length > 256 || /^(?:fusion-)?dfbyok-/.test(value) || seen.has(value)) continue;
          seen.add(value); list.push(value);
        }
        if (hidden) { if (!seen.has(uid)) list.push(uid); config.hiddenNativeModelUids = list; }
        else config.hiddenNativeModelUids = list.filter(value => value !== uid);
        break;
      }
      case 'setRoleModel': {
        const role = payload.role;
        if (role !== 'lead' && role !== 'sidekick') fail('角色类型无效。');
        const enabled = boolean(payload.enabled, '启用状态');
        const model = payload.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) fail('模型参数无效。');
        const hasNative = typeof model.nativeUid === 'string' && !!model.nativeUid;
        const hasProvider = typeof model.providerId === 'string' && typeof model.model === 'string' && !!model.providerId && !!model.model;
        if ((hasNative && hasProvider) || (!hasNative && !hasProvider)) fail('模型身份无效。');
        const key = refKey(model);
        if (!key) fail('模型标识无效。');

        const currentRoles = buildRoleLists(config, nativeModels());
        const candidateList = currentRoles[role] || [];
        const candidate = candidateList.find(item => refKey(item.ref) === key);
        if (enabled && (!candidate || !candidate.available)) fail('该模型当前不可用，无法添加。');

        if (!config.roleExclusions) config.roleExclusions = { lead: [], sidekick: [] };
        if (!Array.isArray(config.roleExclusions[role])) config.roleExclusions[role] = [];

        const refToStore = hasNative ? { nativeUid: model.nativeUid } : { providerId: model.providerId, model: model.model };
        if (enabled) {
          config.roleExclusions[role] = config.roleExclusions[role].filter(r => refKey(r) !== key);
        } else {
          if (!config.roleExclusions[role].some(r => refKey(r) === key)) {
            config.roleExclusions[role].push(refToStore);
          }
        }
        break;
      }
      case 'setEnabled': config.enabled = boolean(payload.enabled, '启用状态'); break;
      case 'setAutoContinue': config.autoContinueOnProviderError = boolean(payload.enabled, '自动继续'); break;
      case 'setAutoContinueUntilPlanComplete': config.autoContinueUntilPlanComplete = boolean(payload.enabled, '完成待办时自动继续'); break;
      default: fail('不支持的操作。');
    }
    cleanSidekicks(config);
    buildCatalog(config, nativeModels()); // Validate the complete model graph before committing.
    write(config);
    if (type === 'importModels') pendingImport = undefined;
    await afterChange(type);
    return state();
  }
  return { state, dispatch(type, payload) {
    const operation = queue.then(() => apply(type, payload));
    queue = operation.catch(() => {}); return operation;
  } };
}
module.exports = { createManager, publicState, cleanSidekicks, PanelInputError };
