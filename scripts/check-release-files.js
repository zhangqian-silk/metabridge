#!/usr/bin/env node
'use strict';

// Supplementary release check. Never print matched secrets or file contents.
const { execFileSync } = require('node:child_process');

function forbiddenPath(filename) {
  const name = filename.replaceAll('\\', '/');
  return /(^|\/)(node_modules|dist|backups|coverage|\.cache|\.metabridge|\.config|auth)\//.test(name) ||
    (/(^|\/)(config\.json|base_instructions\.txt|proxy\.env|\.env(?:\..*)?)$/.test(name) &&
      !name.endsWith('/.env.example') && name !== '.env.example') ||
    /(?:-api-key|\.pem|\.key|\.so|\.dylib|\.dll|\.log|\.tar(?:\.gz)?)$/.test(name) ||
    /\.(?:backup|quota-backup|before)-/.test(name) ||
    (/^providers\/.*\.json$/.test(name) && !/\.(?:example|catalog)\.json$/.test(name));
}

function containsCredential(text) {
  return /(?:sk|fk)-[A-Za-z0-9_-]{24,}/.test(text) ||
    /(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,})/.test(text) ||
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(text);
}

function audit(files, read) {
  return files.flatMap(filename => {
    if (forbiddenPath(filename)) return [{ filename, reason: 'private-or-generated-path' }];
    if (containsCredential(read(filename))) return [{ filename, reason: 'credential-shaped-content' }];
    return [];
  });
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  // Check index blobs, not working-tree copies which may differ from the commit.
  const failures = audit(files, file => execFileSync('git', ['show', `:${file}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
  for (const failure of failures) console.error(`${failure.reason}: ${failure.filename}`);
  if (failures.length) process.exitCode = 1;
  else console.log(`Release file audit passed: ${files.length} files`);
}

if (require.main === module) {
  try { main(); }
  catch { console.error('Release audit failed; run from a Git checkout with readable staged files'); process.exitCode = 1; }
}
module.exports = { forbiddenPath, containsCredential, audit };
