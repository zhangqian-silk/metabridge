#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function mergeQuotaPlugin(config, directory) {
  const next = structuredClone(config);
  next.plugins ??= {};
  next.plugins.enabled = true;
  next.plugins.dir ??= directory;
  next.plugins.configs ??= {};
  next.plugins.configs['factory-quota'] = {
    ...(next.plugins.configs['factory-quota'] ?? {}), enabled: true,
  };
  next.management ??= {};
  // Otherwise CPA's periodic updater would replace the custom quota UI.
  next.management['disable-auto-update-panel'] = true;
  return next;
}

function backup(filename, stamp, privateFile = false) {
  if (!fs.existsSync(filename)) return;
  const target = `${filename}.quota-backup-${stamp}`;
  fs.copyFileSync(filename, target, fs.constants.COPYFILE_EXCL);
  if (privateFile) fs.chmodSync(target, 0o600);
}
function atomicCopy(source, target) {
  const temp = `${target}.quota-${process.pid}.tmp`;
  fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
  fs.renameSync(temp, target);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--activate')) throw new Error('Explicit --activate required');
  const plugin = args[args.indexOf('--plugin') + 1];
  const web = args[args.indexOf('--web') + 1];
  if (!args.includes('--plugin') || !args.includes('--web') ||
      !path.isAbsolute(plugin) || !path.isAbsolute(web) ||
      !fs.statSync(plugin).isFile() || !fs.statSync(web).isFile()) throw new Error('Build artifacts required');
  const directory = path.join(os.homedir(), '.config/cliproxyapi');
  const filename = path.join(directory, 'config.json');
  const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const next = mergeQuotaPlugin(current, path.join(directory, 'plugins'));
  const pluginDirectory = path.resolve(directory, next.plugins.dir);
  fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
  const pluginTarget = path.join(pluginDirectory, 'factory-quota.so');
  const webTarget = path.join(directory, 'static/management.html');
  const stamp = Date.now();
  backup(filename, stamp, true);
  backup(pluginTarget, stamp);
  backup(webTarget, stamp);
  atomicCopy(plugin, pluginTarget);
  atomicCopy(web, webTarget);
  const temp = `${filename}.quota-${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, filename);
  console.log('Factory quota plugin and management UI saved; backups retained; restart CPA to activate');
}
function runCLI() {
  try { main(); } catch {
    console.error('Factory quota installation failed; inspect files before retrying');
    process.exitCode = 1;
  }
}
if (require.main === module) runCLI();
module.exports = { mergeQuotaPlugin, runCLI };
