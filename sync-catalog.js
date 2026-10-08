#!/usr/bin/env node
'use strict';

const catalog = require('./src/catalog/sync');
if (require.main === module) catalog.runCLI();
module.exports = catalog;
