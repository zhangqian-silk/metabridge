'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeRuntimeNote } = require('../scripts/write-runtime-note');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metabridge-notes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('runtime notes use the private user directory, never the working directory', t => {
  const home = setup(t);
  const cwd = path.join(home, 'repository');
  fs.mkdirSync(cwd);
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/write-runtime-note.js'), 'deployment'],
    { cwd, env: { ...process.env, HOME: home, MB_CONFIG_FILE: path.join(cwd, 'config.json') },
      input: '# Deployment\nTTL: 4h\n', encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const filename = path.join(home, '.metabridge/docs/deployment.md');
  assert.equal(fs.readFileSync(filename, 'utf8'), '# Deployment\nTTL: 4h\n');
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
});

test('runtime note replacement is explicit and retains the original privately', t => {
  const home = setup(t);
  const filename = writeRuntimeNote('deployment', 'original', { home });
  assert.throws(() => writeRuntimeNote('deployment', 'next', { home }), /exists/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'original');
  writeRuntimeNote('deployment', 'next', { home, replace: true });
  assert.equal(fs.readFileSync(filename, 'utf8'), 'next');
  const backups = fs.readdirSync(path.dirname(filename)).filter(name => name.startsWith('deployment.md.before-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(filename), backups[0]), 'utf8'), 'original');
  assert.equal(fs.statSync(path.join(path.dirname(filename), backups[0])).mode & 0o777, 0o600);
});

test('runtime notes reject traversal, oversized input and credential-shaped content before writing', t => {
  const home = setup(t);
  for (const name of ['../deployment', '/tmp/deployment', 'docs/deployment', '.hidden', '']) {
    assert.throws(() => writeRuntimeNote(name, 'note', { home }));
  }
  const secret = 'fk-' + 'A'.repeat(32);
  assert.throws(() => writeRuntimeNote('secret', secret, { home }), error => !error.message.includes(secret));
  assert.throws(() => writeRuntimeNote('large', 'a'.repeat(256 * 1024 + 1), { home }));
  assert.equal(fs.existsSync(path.join(home, '.metabridge')), false);
});

test('runtime notes cannot follow a docs-directory or destination symlink into a repository', t => {
  const home = setup(t);
  const root = path.join(home, '.metabridge');
  fs.mkdirSync(root);
  const repository = path.join(home, 'repository');
  fs.mkdirSync(repository);
  fs.symlinkSync(repository, path.join(root, 'docs'));
  assert.throws(() => writeRuntimeNote('deployment', 'note', { home }));
  assert.deepEqual(fs.readdirSync(repository), []);
  fs.unlinkSync(path.join(root, 'docs'));
  fs.mkdirSync(path.join(root, 'docs'));
  const target = path.join(repository, 'README.md');
  fs.writeFileSync(target, 'repository documentation');
  fs.symlinkSync(target, path.join(root, 'docs/deployment.md'));
  assert.throws(() => writeRuntimeNote('deployment', 'note', { home, replace: true }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'repository documentation');
});
