#!/usr/bin/env node
'use strict';

// Stable CLI/systemd entrypoint; orchestration lives in src/bridge.
require('./src/bridge/server');
