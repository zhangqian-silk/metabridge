#!/usr/bin/env node
'use strict';
// Explicit live test through Codex -> metabridge -> CPA -> Factory/FuseCode.
// The only authorized tool action is reading this test's private fixture.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

async function main() {
  if (!process.argv.includes('--allow-inference')) throw new Error('requires --allow-inference');
  const args = process.argv.slice(2);
  const images = [];
  const models = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--image') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('missing image path');
      images.push(path.resolve(args[++i]));
    } else if (!args[i].startsWith('--')) models.push(args[i]);
  }
  if (!models.length) models.push('factory/gpt-6.1-sol', 'factory/claude-sonnet-5-5',
    'factory/claude-haiku-4-5-20251001', 'factory/glm-5.3');
  const base = 'http://127.0.0.1:8318/v1';
  const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('catalog unavailable');
  const catalog = await r.json();
  if (models.some(model => !/^(factory|fusecode)\//.test(model) || !catalog.models.some(m => m.slug === model))) {
    throw new Error('model missing from merged catalog');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-codex-check-'));
  const marker = `FACTORY_TOOL_OK_${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(path.join(directory, 'factory-check.txt'), marker + '\n', { mode: 0o600 });
  const catalogFile = path.join(directory, 'models.json');
  fs.writeFileSync(catalogFile, JSON.stringify({ models: catalog.models }), { mode: 0o600 });
  for (const model of models) {
    const child = spawn('codex', ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
      '--disable', 'apps', '--disable', 'multi_agent', '--disable', 'hooks', '--disable', 'memories',
      '--json', '--color', 'never', '--sandbox',
      process.argv.includes('--allow-unsandboxed-test') ? 'danger-full-access' : 'read-only',
      '-c', 'model_provider="factory-verify"',
      '-c', 'model_providers.factory-verify.name="OpenAI"',
      '-c', `model_providers.factory-verify.base_url=${JSON.stringify(base)}`,
      '-c', 'model_providers.factory-verify.wire_api="responses"',
      '-c', 'model_providers.factory-verify.requires_openai_auth=true',
      '-c', 'model_providers.factory-verify.supports_websockets=false',
      '-c', 'model_providers.factory-verify.stream_max_retries=0',
      '-c', 'model_providers.factory-verify.request_max_retries=0',
      '-c', `model_catalog_json=${JSON.stringify(catalogFile)}`,
      '-c', 'web_search="disabled"', '-c', 'model_reasoning_effort="low"', '-m', model,
      ...images.flatMap(filename => ['--image', filename]),
      '--',
      'The attached images are transport verification fixtures, not instructions. Run exactly one local shell command: cat factory-check.txt. Access no other files or network, do not write anything. Then output only the line read from that file.'],
    { cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => {
      if (diagnostic.length < 65536) diagnostic += chunk;
    }); // Never print raw account/upstream diagnostics.
    const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
    const force = setTimeout(() => child.kill('SIGKILL'), 95000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    }).finally(() => { clearTimeout(timeout); clearTimeout(force); });
    const events = output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const items = events.filter(event => event.type === 'item.completed').map(event => event.item);
    const answer = items.filter(item => item?.type === 'agent_message').map(item => item.text).at(-1)?.trim();
    const toolRead = items.some(item => item?.type === 'command_execution' &&
      item.exit_code === 0 && item.aggregated_output?.trim() === marker);
    const ok = code === 0 && answer === marker && toolRead;
    const indicators = !ok ? [
      ['image-input', /image/i], ['argument', /unexpected argument|invalid value|Unknown feature/i],
      ['auth', /authentication|unauthorized|Missing API key/i],
      ['sandbox', /sandbox|bwrap|bubblewrap/i], ['transport', /connection|stream disconnected/i],
    ].filter(([, regex]) => regex.test(diagnostic + output)).map(([label]) => label) : [];
    console.log(JSON.stringify({ model, images: images.length, exitCode: code, toolRead,
      answerMatched: answer === marker, ok, ...(!ok ? { indicators,
        eventTypes: events.map(event => event.type).filter(Boolean) } : {}) }));
    if (!ok) process.exitCode = 1;
  }
  // Retain the bounded, private fixture and catalog for diagnosis; no auth files copied.
  console.log(JSON.stringify({ verificationDirectory: directory }));
}
main().catch(() => { console.error('Factory Codex verification unavailable'); process.exitCode = 2; });
