'use strict';

// /models commonly reports IDs only. Keep provider-specific overrides explicit;
// use the standard GPT/o reasoning controls only for recognizable base IDs.
function modelEfforts(model) {
  if (model.effortMode === 'none') return [null];
  if (Array.isArray(model.efforts) && model.efforts.length) return [...new Set(model.efforts)];
  if (model.effortMode === 'manual') return [null];
  const id = String(model.id || '').split('/').at(-1);
  if (/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(id) &&
      !/(?:^|-)(?:none|minimal|low|medium|high|xhigh|max|ultra)(?:-|$)/i.test(id)) {
    // The null variant retains previously saved UIDs and provider-default behavior.
    return [null, 'low', 'medium', 'high', 'xhigh'];
  }
  return [null];
}

function modelSupportsImages(model) {
  return true;
}

module.exports = { modelEfforts, modelSupportsImages };
