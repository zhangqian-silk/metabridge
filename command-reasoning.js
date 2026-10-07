'use strict';

const { reasoningForModel } = require('./provider-config');
const defaults = require('./providers/command-code.example.json');

function commandCodeReasoning(model, backend = defaults) {
  // Existing inline configurations keep the historical file-backed profile.
  // An explicit reasoningRules: [] opts out instead of inheriting it.
  const source = backend.reasoningRules === undefined && backend.reasoning === 'command-code'
    ? defaults : backend;
  const configured = reasoningForModel(source, model);
  if (configured) return configured;
  return typeof backend.reasoning === 'object' ? backend.reasoning : null;
}

function commandCodeEffort(payload, backend) {
  const policy = commandCodeReasoning(payload.model, backend);
  if (!policy) return undefined;
  const effort = payload.reasoning?.effort ?? policy.default;
  if (!policy.levels.includes(effort)) {
    const error = new Error(`Unsupported reasoning effort "${effort}" for ${payload.model}; supported: ${policy.levels.join(', ')}`);
    error.status = 400;
    throw error;
  }
  return effort;
}

module.exports = { commandCodeReasoning, commandCodeEffort };
