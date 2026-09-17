'use strict';
const { buildCatalog } = require('../../src/catalog.cjs');
const crypto = require('node:crypto');
const key = ref => JSON.stringify([ref.nativeUid || '', ref.providerId || '', ref.model || '', ref.effort ?? null]);
function withPresets(config, nativeModels = []) {
  const base = buildCatalog({ ...config, fusionPresets: [] }, nativeModels);
  const sidekicks = base.sidekicks.map(side => side.native ? { nativeUid: side.uid } : {
    providerId: side.providerId, model: side.model, effort: base.routes[side.uid].effort,
  });
  const officialNativeUids = new Set(nativeModels.filter(native => typeof native.uid === 'string' && native.uid.startsWith('fusion-') &&
    native.uid.includes('-sidekick-') && native.fusionMetadata?.some(item => item.key === 'Lead') && native.fusionMetadata?.some(item => item.key === 'Effort') &&
    (native.fusionMetadata.find(item => item.key === 'Fast Mode')?.order ?? 0) === 0).map(native => native.uid.slice('fusion-'.length, native.uid.lastIndexOf('-sidekick-'))));
  const officialLeadCandidates = (base.presetCandidates?.lead || []).filter(lead => !lead.ref?.nativeUid || officialNativeUids.has(lead.ref.nativeUid));
  return { ...config, fusionPresets: officialLeadCandidates.flatMap(lead => sidekicks.map(sidekick => {
    const id = crypto.createHash('sha256').update(key(lead.ref) + key(sidekick)).digest('hex').slice(0, 24);
    return { id, name: `Fixture ${id}`, lead: lead.ref, sidekick };
  })) };
}
module.exports = { withPresets };
