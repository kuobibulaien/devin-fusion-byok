'use strict';

function effortLabel(effort) {
  return effort == null ? '默认' : ({ none: '关闭', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' }[effort] || effort);
}

// Devin routes effort changes through variant UIDs. Keep those wire identities,
// but expose each provider/model family exactly once in management controls.
function modelChoices(models = []) {
  const choices = [], families = new Map();
  for (const model of models) {
    const familyUid = model.kind === 'model' ? model.json?.modelInfo?.modelFamilyUid || model.uid : model.uid;
    let choice = families.get(familyUid);
    if (!choice) {
      choice = { uid: model.uid, familyUid, label: model.kind === 'model' ? model.json?.modelFamilyMetadata?.modelFamilyLabel || model.label : model.label,
        kind: model.kind, variants: [] };
      families.set(familyUid, choice); choices.push(choice);
    }
    choice.variants.push({ uid: model.uid, effort: model.effort ?? null, label: effortLabel(model.effort), modelLabel: model.label });
  }
  return choices;
}

function presetChoices(items, catalog) {
  const labels = new Map();
  for (const choice of modelChoices(catalog.models)) for (const variant of choice.variants) labels.set(variant.uid, choice.label);
  const refs = new Map(Object.values(catalog.routes).map(route => [JSON.stringify([route.providerId, route.model, route.effort ?? null]), route.uid]));
  const groups = new Map();
  for (const item of items) {
    const ref = item.ref;
    const key = ref.nativeUid ? JSON.stringify(['native', ref.nativeUid]) : JSON.stringify(['provider', ref.providerId, ref.model]);
    let group = groups.get(key);
    if (!group) {
      group = { ref, label: ref.nativeUid ? item.label : labels.get(refs.get(JSON.stringify([ref.providerId, ref.model, ref.effort ?? null]))) || item.label, variants: [] };
      groups.set(key, group);
    }
    group.variants.push({ ref, label: effortLabel(ref.effort) });
  }
  return [...groups.values()];
}

function uniqueModelUids(uids, models) {
  const families = new Map();
  for (const choice of modelChoices(models)) for (const variant of choice.variants) families.set(variant.uid, choice.familyUid);
  const seen = new Set();
  return uids.filter(uid => {
    const family = families.get(uid) || uid;
    if (seen.has(family)) return false;
    seen.add(family); return true;
  });
}

module.exports = { effortLabel, modelChoices, presetChoices, uniqueModelUids };
