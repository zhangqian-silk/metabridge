'use strict';

// Request-copy optimization, not context compaction or attachment truncation.
// Inspired by Oh My Pi's image-resize.ts: downsize and choose a smaller encoding.
const sharp = require('sharp');
const DEFAULTS = Object.freeze({
  enabled: true, maxDimension: 1568, maxImageBytes: 500 * 1024,
  requestTargetBytes: 4_000_000, jpegQuality: 80,
});

function attachmentPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key))) {
    throw new Error('invalid Factory attachment optimization configuration');
  }
  const policy = { ...DEFAULTS, ...value };
  if (typeof policy.enabled !== 'boolean' ||
      !Number.isInteger(policy.maxDimension) || policy.maxDimension < 256 || policy.maxDimension > 8192 ||
      !Number.isInteger(policy.maxImageBytes) || policy.maxImageBytes < 32768 ||
      !Number.isInteger(policy.requestTargetBytes) || policy.requestTargetBytes < 262144 ||
      !Number.isInteger(policy.jpegQuality) || policy.jpegQuality < 40 || policy.jpegQuality > 95) {
    throw new Error('invalid Factory attachment optimization configuration');
  }
  return policy;
}

function imageSlot(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  if (part.type === 'image' && part.source?.type === 'base64' &&
      typeof part.source.data === 'string' && /^image\//.test(part.source.media_type)) {
    return { data: part.source.data, mime: part.source.media_type, replace: (data, mime) =>
      ({ ...part, source: { ...part.source, data, media_type: mime } }) };
  }
  let uri;
  if (part.type === 'input_image') uri = part.image_url;
  if (part.type === 'image_url') uri = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  // Inline image files also retain their attachment representation.
  if (part.type === 'input_file') uri = part.file_data;
  const match = typeof uri === 'string' && /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(uri);
  if (!match) return null;
  return { mime: match[1], data: match[2], replace: (data, mime) => {
    const next = `data:${mime};base64,${data}`;
    if (part.type === 'input_file') return { ...part, file_data: next };
    if (typeof part.image_url === 'string') return { ...part, image_url: next };
    return { ...part, image_url: { ...part.image_url, url: next } };
  } };
}

async function optimizeAttachments(body, config, { signal } = {}) {
  const policy = attachmentPolicy(config);
  signal?.throwIfAborted();
  const stats = { images: 0, optimized: 0, failedImages: 0, preservedAttachments: 0,
    beforeBytes: Buffer.byteLength(JSON.stringify(body)), afterBytes: 0 };
  if (!policy.enabled) return { body, stats: { ...stats, afterBytes: stats.beforeBytes } };
  const slots = [];
  function collect(value) {
    if (Array.isArray(value)) { for (const entry of value) collect(entry); return; }
    if (!value || typeof value !== 'object') return;
    const slot = imageSlot(value);
    if (slot) { slots.push(slot); return; }
    if (['document', 'input_file', 'input_audio', 'audio', 'video', 'input_video', 'file'].includes(value.type)) {
      stats.preservedAttachments++;
      return;
    }
    for (const child of Object.values(value)) collect(child);
  }
  // Only message/history fields: do not rewrite schemas, metadata, or tool definitions.
  collect(body.input);
  collect(body.messages);
  stats.images = slots.length;
  const encodedBytes = slots.reduce((sum, slot) => sum + Buffer.byteLength(slot.data), 0);
  const nonImageBytes = Math.max(0, stats.beforeBytes - encodedBytes);
  // Account for Base64's 4/3 expansion and JSON/headroom. This is a target, NOT a rejection limit.
  const perImageBytes = slots.length ? Math.max(32768, Math.min(policy.maxImageBytes,
    Math.floor((policy.requestTargetBytes - nonImageBytes) * 0.70 / slots.length))) : policy.maxImageBytes;
  const memo = new Map();
  async function rewrite(value) {
    signal?.throwIfAborted();
    if (Array.isArray(value)) {
      const next = [];
      for (const entry of value) next.push(await rewrite(entry));
      return next;
    }
    if (!value || typeof value !== 'object') return value;
    const slot = imageSlot(value);
    if (slot) {
      // Never fetch remote media or read caller-supplied file paths.
      const cacheKey = `${slot.mime}:${slot.data}`;
      let result = memo.get(cacheKey);
      if (!memo.has(cacheKey)) {
        try {
          const input = Buffer.from(slot.data, 'base64');
          if (input.toString('base64') !== slot.data) throw new Error('invalid image encoding');
          const opts = { limitInputPixels: 64 * 1024 * 1024 };
          const meta = await sharp(input, opts).timeout({ seconds: 10 }).metadata();
          // Do not silently flatten multi-page/animated images or rasterize vector documents.
          if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'tiff', 'heif'].includes(meta.format) ||
              (meta.pages ?? 1) > 1) result = null;
          else if (input.length <= perImageBytes &&
              meta.width <= policy.maxDimension && meta.height <= policy.maxDimension) result = null;
          else {
            let dimension = policy.maxDimension;
            let best = { buffer: input, mime: slot.mime };
            const opaque = !meta.hasAlpha || (await sharp(input, opts).timeout({ seconds: 10 }).stats()).isOpaque;
            // A short bounded ladder; preserve transparent pixels with PNG.
            for (let attempt = 0; attempt < 3; attempt++) {
              signal?.throwIfAborted();
              const pipeline = () => sharp(input, opts).timeout({ seconds: 10 }).rotate()
                .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true });
              const png = await pipeline().png().toBuffer();
              if (png.length < best.buffer.length) best = { buffer: png, mime: 'image/png' };
              if (opaque) {
                const jpeg = await pipeline().removeAlpha().jpeg({ quality: policy.jpegQuality }).toBuffer();
                if (jpeg.length < best.buffer.length) best = { buffer: jpeg, mime: 'image/jpeg' };
              }
              if (best.buffer.length <= perImageBytes) break;
              dimension = Math.max(Math.min(512, policy.maxDimension), Math.floor(dimension * 0.75));
            }
            result = best.buffer.length < input.length
              ? { data: best.buffer.toString('base64'), mime: best.mime } : null;
          }
        } catch (error) {
          signal?.throwIfAborted();
          result = { failed: true };
        }
        memo.set(cacheKey, result);
      }
      if (result?.failed) stats.failedImages++;
      if (result?.data) {
        stats.optimized++;
        return slot.replace(result.data, result.mime);
      }
      return value;
    }
    if (['document', 'input_file', 'input_audio', 'audio', 'video', 'input_video', 'file'].includes(value.type)) {
      return value;
    }
    const next = { ...value };
    for (const [key, child] of Object.entries(value)) next[key] = await rewrite(child);
    return next;
  }
  const next = { ...body };
  if (body.input !== undefined) next.input = await rewrite(body.input);
  if (body.messages !== undefined) next.messages = await rewrite(body.messages);
  signal?.throwIfAborted();
  stats.afterBytes = Buffer.byteLength(JSON.stringify(next));
  return { body: next, stats };
}

module.exports = { optimizeAttachments, attachmentPolicy };
