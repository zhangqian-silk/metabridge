#!/usr/bin/env node
'use strict';
// Explicit live inference diagnostic. Never print/copy account keys or transcript.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeCompactionEnvelope } = require('../src/core/compaction');

async function post(body) {
  const response = await fetch('http://127.0.0.1:8318/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error(`Response HTTP ${response.status}`);
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => {
      try { return JSON.parse(l.slice(5)); } catch { return null; }
    });
    if (events.some(e => e?.type === 'response.failed')) throw new Error('Summary failed');
    const completed = events.find(e => e?.type === 'response.completed')?.response;
    if (!completed) throw new Error('No terminal completion');
    return completed;
  }
  return JSON.parse(text);
}

async function main() {
  if (!process.argv.includes('--allow-inference')) throw new Error('Explicit inference permission required');
  const source = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (!source) throw new Error('Requires existing CPA request log path');
  const request = fs.readFileSync(source, 'utf8').split('\n').flatMap(line => {
    if (!line.startsWith('{')) return [];
    try { const body = JSON.parse(line); return body.input && body.model?.startsWith('factory/claude-') ? [body] : []; }
    catch { return []; }
  })[0];
  if (!request || !request.input.some(i => i.type === 'compaction_trigger')) throw new Error('No matching compaction request');
  const compacted = await post({ ...request, stream: true });
  const checkpoint = compacted.output?.find(i => i.type === 'compaction');
  const summary = decodeCompactionEnvelope(checkpoint?.encrypted_content);
  if (!summary) throw new Error('No portable checkpoint');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-compaction-check-'));
  fs.writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600 });
  console.log(JSON.stringify({ stage: 'compaction', model: request.model, ok: true,
    summaryCharacters: summary.length, verificationDirectory: directory }));
  const marker = `RESUME_OK_${crypto.randomBytes(8).toString('hex')}`;
  const tools = [{ type: 'function', name: 'verify_checkpoint', description: 'Return the checkpoint verification marker.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false }];
  const input = [checkpoint, { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'Do not continue the historical task. Call verify_checkpoint exactly once. Then reply only with the marker returned by that tool.' }] }];
  const first = await post({ model: request.model, input, tools, stream: true });
  const call = first.output?.find(i => i.type === 'function_call' && i.name === 'verify_checkpoint');
  if (!call?.call_id) throw new Error('Replay did not produce expected tool call');
  const final = await post({ model: request.model, stream: true, tools, input: [...input, ...first.output,
    { type: 'function_call_output', call_id: call.call_id, output: marker }] });
  const answer = final.output?.filter(i => i.type === 'message')
    .flatMap(i => i.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('').trim();
  if (answer !== marker) throw new Error('Tool result did not round-trip');
  console.log(JSON.stringify({ stage: 'checkpoint-replay-tool-loop', ok: true }));
}
main().catch(() => {
  console.error('CPA compaction verification failed; transcript and credentials are not logged');
  process.exitCode = 1;
});
