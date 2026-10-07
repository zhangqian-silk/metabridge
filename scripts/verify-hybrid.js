#!/usr/bin/env node
'use strict';

// Opt-in live smoke test. Login stays in Codex; no auth.json reads or token copies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const base = process.env.MB_VERIFY_BASE || 'http://127.0.0.1:8318/v1';
  const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('model catalog request failed');
  const catalog = await response.json();
  const models = process.argv.slice(2);
  if (!models.length) models.push('gpt-5.6-sol', 'cmd/google/gemini-3.8-flash',
    'gateway/model_api/experimental_0821');
  if (models.some(model => !catalog.models?.some(m => m.slug === model))) {
    throw new Error('requested test model is missing from merged catalog');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-hybrid-verify-'));
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exit; } finally { clearTimeout(force); }
  }
  const cancel = () => void stop();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const file = path.join(dir, 'models.json');
    fs.writeFileSync(file, JSON.stringify({ models: catalog.models }), { mode: 0o600 });
    for (const model of models) {
      child = spawn('codex', ['exec', '--ignore-user-config', '--ephemeral',
        '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never',
        '-c', 'model_provider="hybrid-verify"',
        '-c', 'model_providers.hybrid-verify.name="OpenAI"',
        '-c', `model_providers.hybrid-verify.base_url=${JSON.stringify(base)}`,
        '-c', 'model_providers.hybrid-verify.wire_api="responses"',
        '-c', 'model_providers.hybrid-verify.requires_openai_auth=true',
        '-c', 'model_providers.hybrid-verify.supports_websockets=false',
        '-c', `model_catalog_json=${JSON.stringify(file)}`,
        '-c', 'model_reasoning_effort="low"', '-m', model,
        'Reply exactly HYBRID_OK. Do not call tools or access files.'],
      { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', () => {}); // Avoid printing account or upstream diagnostics.
      const timeout = setTimeout(() => void stop(), 90000);
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve(code));
      }).finally(() => clearTimeout(timeout));
      const events = output.split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const answer = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message')
        .map(e => e.item.text).join('\n').trim();
      const ok = result === 0 && answer === 'HYBRID_OK';
      console.log(JSON.stringify({ model, exitCode: result, ok }));
      if (!ok && process.env.MB_VERIFY_DIAGNOSTICS === '1') {
        const errors = events.filter(e => ['error', 'turn.failed'].includes(e.type))
          .map(e => e.message || e.error?.message || e.type)
          .map(message => String(message).replace(/Bearer\s+\S+|sk-[\w-]+|eyJ[\w.-]+/g, '[REDACTED]'));
        console.log(JSON.stringify({ errors }));
      }
      if (!ok) throw new Error('Codex live hybrid test failed; inspect client diagnostics privately');
    }
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch(() => { console.error('Hybrid verification failed.'); process.exitCode = 1; });
