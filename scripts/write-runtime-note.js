#!/usr/bin/env node
'use strict';

// Explicit operator notes only. Services/configuration commands never call this.
// The destination is independent of cwd and MB_CONFIG_FILE (which may be in a checkout).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { containsCredential } = require('./check-release-files');
const MAX_BYTES = 256 * 1024;

function privateDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid runtime note directory');
  fs.chmodSync(directory, 0o700);
}

function writeRuntimeNote(name, markdown, { home = os.homedir(), replace = false } = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) {
    throw new Error('invalid runtime note name');
  }
  if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > MAX_BYTES ||
      containsCredential(markdown)) {
    throw new Error('invalid runtime note content; do not include credentials');
  }
  const root = path.join(home, '.metabridge');
  const directory = path.join(root, 'docs');
  privateDirectory(root);
  privateDirectory(directory);
  const filename = path.join(directory, `${name}.md`);
  let existing;
  try { existing = fs.lstatSync(filename); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('invalid runtime note destination');
  }
  if (existing && !replace) throw new Error('runtime note exists; use --replace explicitly');
  if (!existing) {
    fs.writeFileSync(filename, markdown, { mode: 0o600, flag: 'wx' });
    return filename;
  }
  const suffix = randomUUID();
  const backup = `${filename}.before-${suffix}`;
  fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  const temporary = path.join(directory, `.${name}-${suffix}.tmp`);
  try {
    fs.writeFileSync(temporary, markdown, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return filename;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--replace')) {
    throw new Error('usage: write-runtime-note.js <name> [--replace] < note.md');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('runtime note too large');
    chunks.push(chunk);
  }
  const filename = writeRuntimeNote(args[0], Buffer.concat(chunks).toString('utf8'),
    { replace: args[1] === '--replace' });
  console.log(`Runtime note saved: ${filename}`);
}
if (require.main === module) main().catch(() => {
  console.error('Runtime note not saved; use a valid name, credential-free input and explicit --replace for updates');
  process.exitCode = 1;
});
module.exports = { writeRuntimeNote };
