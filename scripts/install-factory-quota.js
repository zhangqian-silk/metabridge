#!/usr/bin/env node
'use strict';

// Compatibility entrypoint; the optional addon owns its installation.
const installer = require('../integrations/cpa/scripts/install-account-quota');
if (require.main === module) installer.runCLI();
module.exports = installer;
