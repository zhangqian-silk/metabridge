'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { optimizeAttachments, attachmentPolicy } = require('../src/adapters/factory/attachments');

async function image() {
  // Deterministic textured screenshot-like PNG; large enough to reproduce payload pressure.
  const width = 1600, height = 1200;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 41;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('all three protocols optimize every inline image without changing tools or caller history', async () => {
  const png = await image();
  const data = png.toString('base64');
  for (const protocol of ['messages', 'responses', 'chat']) {
    const part = protocol === 'messages'
      ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }
      : protocol === 'responses'
        ? { type: 'input_image', image_url: `data:image/png;base64,${data}`, detail: 'high' }
        : { type: 'image_url', image_url: { url: `data:image/png;base64,${data}`, detail: 'high' } };
    const field = protocol === 'responses' ? 'input' : 'messages';
    const original = { model: 'fixture', [field]: [{ role: 'user', content: [part, part, part, part] }],
      tools: [{ name: 'fixture', parameters: { example: { type: 'input_image',
        image_url: 'data:image/png;base64,AAAA' } } }] };
    const before = JSON.stringify(original);
    const { body, stats } = await optimizeAttachments(original);
    assert.equal(JSON.stringify(original), before);
    assert.deepEqual(body.tools, original.tools);
    assert.equal(stats.images, 4);
    assert.equal(stats.optimized, 4);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 4_000_000);
    const changed = body[field][0].content[0];
    const encoded = changed.source?.data ?? (typeof changed.image_url === 'string'
      ? changed.image_url.split(',')[1] : changed.image_url.url.split(',')[1]);
    const meta = await sharp(Buffer.from(encoded, 'base64')).metadata();
    assert.ok(meta.width <= 1568 && meta.height <= 1568);
    assert.ok(meta.width / meta.height > 1.32 && meta.width / meta.height < 1.34);
    if (protocol !== 'messages') assert.equal(changed.detail ?? changed.image_url.detail, 'high');
  }
});

test('document, audio, remote URLs, unknown formats, and malformed images are preserved, not truncated or fetched', async () => {
  const body = { input: [{ role: 'user', content: [
    { type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
    { type: 'input_audio', input_audio: { format: 'wav', data: 'AAAA' } },
    { type: 'input_image', image_url: 'https://private.example/image.png' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    { type: 'text', text: 'keep this text unchanged' },
  ] }] };
  const result = await optimizeAttachments(body);
  assert.deepEqual(result.body, body);
  assert.equal(result.stats.preservedAttachments, 2);
  assert.equal(result.stats.failedImages, 1);
});

test('small images, disabled policy, and tool result pairings are preserved', async () => {
  const data = (await sharp({ create: { width: 24, height: 24, channels: 3,
    background: 'white' } }).png().toBuffer()).toString('base64');
  const body = { input: [{ type: 'function_call', call_id: 'call', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call', output: [
      { type: 'input_image', image_url: `data:image/png;base64,${data}` },
    ] }] };
  assert.deepEqual((await optimizeAttachments(body)).body, body);
  assert.equal((await optimizeAttachments(body, { enabled: false })).body, body);
});

test('transparent images keep alpha and inline image files retain file metadata', async () => {
  const png = await sharp({ create: { width: 2400, height: 1200, channels: 4,
    background: { r: 20, g: 40, b: 70, alpha: 0.4 } } }).png().toBuffer();
  const body = { input: [{ role: 'user', content: [{ type: 'input_file',
    filename: 'diagram.png', file_data: `data:image/png;base64,${png.toString('base64')}` }] }] };
  const { body: result, stats } = await optimizeAttachments(body);
  assert.equal(stats.optimized, 1);
  const part = result.input[0].content[0];
  assert.equal(part.type, 'input_file');
  assert.equal(part.filename, 'diagram.png');
  assert.match(part.file_data, /^data:image\/png;base64,/);
  const decoded = await sharp(Buffer.from(part.file_data.split(',')[1], 'base64')).metadata();
  assert.equal(decoded.hasAlpha, true);
  assert.equal(decoded.width, 1568);
});

test('multi-page images are not silently reduced to the first page', async () => {
  const tiff = await sharp(Buffer.alloc(600 * 1200 * 3, 255),
    { raw: { width: 600, height: 1200, channels: 3, pageHeight: 600 } })
    .tiff().toBuffer();
  assert.equal((await sharp(tiff).metadata()).pages, 2);
  // An unsupported vector image is likewise preserved instead of rasterized.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"><rect width="2000" height="2000"/></svg>');
  const body = { messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: svg.toString('base64') } },
    { type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: tiff.toString('base64') } },
  ] }] };
  assert.deepEqual((await optimizeAttachments(body)).body, body);
});

test('invalid file policies fail early; aborted processing does not send upstream', async () => {
  for (const policy of [{ maxImageBytes: 0 }, { maxDimension: 'x' }, { enabled: 'yes' },
    { requestTargetBytes: 1 }, { jpegQuality: 101 }, { mystery: true }]) {
    assert.throws(() => attachmentPolicy(policy));
  }
  const signal = AbortSignal.abort();
  await assert.rejects(optimizeAttachments({ input: [] }, {}, { signal }));
});
