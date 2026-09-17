'use strict';
const { buildCatalog } = require('../../src/catalog.cjs');
const crypto = require('node:crypto');
const key = ref => JSON.stringify([ref.nativeUid || '', ref.providerId || '', ref.model || '', ref.effort ?? null]);
function withPresets(config, nativeModels = []) {
  const base = buildCatalog({ ...config, fusionPresets: [] }, nativeModels);
  const sidekicks = base.sidekicks.map(side => side.native ? { nativeUid: side.uid } : {
    providerId: side.providerId, model: side.model, effort: base.routes[side.uid].effort,
  });
  return { ...config, fusionPresets: (base.presetCandidates?.lead || []).flatMap(lead => sidekicks.map(sidekick => {
    const id = crypto.createHash('sha256').update(key(lead.ref) + key(sidekick)).digest('hex').slice(0, 24);
    return { id, name: `Fixture ${id}`, lead: lead.ref, sidekick };
  })) };
}
module.exports = { withPresets };
