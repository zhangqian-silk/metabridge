#!/usr/bin/env node
'use strict';
const os = require('node:os');
const path = require('node:path');
const { loadFactoryConfig } = require('../factory-api');
const { probeFactoryGateway } = require('../factory-gateway');
const { validateInstructionMode } = require('../factory-instructions');

async function main() {
  if (!process.argv.includes('--allow-inference')) {
    console.error('Requires --allow-inference: sends three small, potentially billable model requests; does not change CPA.');
    process.exitCode = 2;
    return;
  }
  const modeIndex = process.argv.indexOf('--instruction-mode');
  if (modeIndex !== -1 && !process.argv[modeIndex + 1]) throw new Error('missing instruction mode');
  const { config, key } = loadFactoryConfig(path.join(os.homedir(), '.config/cliproxyapi/quota/factory.json'));
  const instructionMode = validateInstructionMode(modeIndex === -1
    ? config.gateway?.instruction_mode : process.argv[modeIndex + 1]);
  const results = await probeFactoryGateway(key, { instructionMode, clientVersion: config.gateway?.client_version });
  console.log(JSON.stringify({ provider: 'factory', results,
    instructionMode, instructionPriorityPreserved: instructionMode !== 'fold_system_into_user',
    upstreamIdentityPrefixAdded: instructionMode === 'factory_prefix',
    activationAllowed: false, reason: 'full_Codex_tools_streaming_verification_required' }, null, 2));
  if (results.some(r => !r.verified)) process.exitCode = 1;
}

main().catch(() => {
  console.error('Factory probe unavailable; inspect private configuration, credentials and connectivity.');
  process.exitCode = 2;
});
