#!/usr/bin/env node
'use strict';
// Reads an existing private failure log. Prints sizes/status only, never transcript or media.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { optimizeAttachments } = require('../src/adapters/factory/attachments');
const { loadFactoryConfig } = require('../src/adapters/factory/api');

async function main() {
  const source = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (!source) throw new Error('Existing CPA failure log required');
  const request = fs.readFileSync(source, 'utf8').split('\n').flatMap(line => {
    if (!line.startsWith('{')) return [];
    try {
      const value = JSON.parse(line);
      return value.input && value.model?.startsWith('factory/') ? [value] : [];
    } catch { return []; }
  })[0];
  if (!request) throw new Error('No matching Factory request');
  const { config } = loadFactoryConfig(path.join(os.homedir(), '.config/cliproxyapi/quota/factory.json'));
  const { stats } = await optimizeAttachments(request, config.gateway.attachment_optimization);
  console.log(JSON.stringify({ stage: 'offline-optimization', ...stats }));
  if (!process.argv.includes('--allow-inference')) return;
  // Keep the real image/history payload, but prohibit tools and historical task execution.
  const input = [...request.input, { role: 'user', content: [{ type: 'input_text',
    text: 'Transport verification only. Do not continue any historical task or call tools. Reply exactly ATTACHMENT_TRANSPORT_OK.' }] }];
  const response = await fetch('http://127.0.0.1:8318/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, input, tool_choice: 'none', stream: true }),
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error(`Inference HTTP ${response.status}`);
  const text = await response.text();
  const events = text.split('\n').filter(line => line.startsWith('data:')).flatMap(line => {
    try { return [JSON.parse(line.slice(5))]; } catch { return []; }
  });
  const completed = events.find(event => event.type === 'response.completed')?.response;
  if (!completed || events.some(event => event.type === 'response.failed' || event.type === 'error')) {
    throw new Error('No successful terminal event');
  }
  const answer = completed.output?.filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text')
    .map(part => part.text).join('').trim();
  if (answer !== 'ATTACHMENT_TRANSPORT_OK') throw new Error('Verification marker missing');
  console.log(JSON.stringify({ stage: 'bridge-cpa-factory-roundtrip', status: response.status, ok: true }));
  if (process.argv.includes('--codex')) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-attachment-check-'));
    const images = [];
    function collect(value) {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (!value || typeof value !== 'object') return;
      if (value.type === 'input_image' && typeof value.image_url === 'string') {
        const match = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(value.image_url);
        if (match) {
          const filename = path.join(directory, `image-${images.length}.${match[1]}`);
          fs.writeFileSync(filename, Buffer.from(match[2], 'base64'), { mode: 0o600 });
          images.push(filename);
        }
      } else Object.values(value).forEach(collect);
    }
    collect(request.input);
    if (!images.length) throw new Error('No CLI image fixtures');
    const child = spawn(process.execPath, [path.join(__dirname, 'verify-factory-codex.js'),
      '--allow-inference', '--allow-unsandboxed-test', request.model,
      ...images.flatMap(filename => ['--image', filename])], { stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw new Error('Codex verification failed');
    console.log(JSON.stringify({ stage: 'codex-cli-images', ok: true, images: images.length,
      verificationDirectory: directory }));
  }
}
main().catch(error => {
  // Only diagnostic categories/HTTP status; do not expose library/upstream exception content.
  console.error('Factory attachment verification failed',
    /^Inference HTTP \d+$/.test(error.message) ? error.message : '');
  process.exitCode = 1;
});
