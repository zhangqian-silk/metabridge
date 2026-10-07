# Factory attachment transport

Factory image optimization runs in `factory-proxy.js`, after CPA's native protocol
conversion and instruction adaptation, immediately before the upstream upload.
It applies to **all configured Factory models** on Messages, Responses, and Chat
Completions. It does not change official subscription traffic or other CPA providers.
The existing local summary/checkpoint mechanism remains separate and unchanged.

Configure `gateway.attachment_optimization` in the existing Factory config file:

```json
{
  "enabled": true,
  "maxDimension": 1568,
  "maxImageBytes": 512000,
  "requestTargetBytes": 4000000,
  "jpegQuality": 80
}
```

These are optimization targets, not local rejection limits. The defaults are used
when the field is absent; `enabled: false` disables processing. Restart
`factory-proxy.service` after changing configuration.

Inspired by Oh My Pi's `packages/coding-agent/src/utils/image-resize.ts`, this
implementation downsizes oversized raster images with aspect ratio preserved,
tries PNG and JPEG, and chooses a smaller representation. Transparent images
retain alpha via PNG. Base64 expansion and non-image JSON overhead are considered
when allocating a per-image byte target. A bounded dimension ladder makes a
best-effort attempt; it is **not a guarantee** that every request fits upstream.
Small images remain byte-for-byte unchanged. Identical images are processed only
once per request. JPEG/downscaling can reduce small-text legibility.

Supported representations:

- Anthropic `image.source` with Base64 data, including nested tool-result images.
- Responses `input_image.image_url` data URIs, including tool-result image arrays.
- Chat Completions `image_url` data URIs.
- Responses `input_file.file_data` containing an image data URI.

Only the outgoing request copy changes. Original files, stored history, message
ordering, image count, tool-call/result IDs, tool definitions, and image `detail`
are preserved. No remote URLs are fetched and no caller-provided paths are read.
Encoder metadata is not retained. Multi-page/animated images, SVG, undecodable
images, PDF/document files, audio/video, external references and unknown formats
remain unchanged: they are not truncated, dropped, summarized or flattened into
one page/frame. A PDF/audio/video compressor or an upstream file-upload mechanism
would be a separate format-specific feature and is not implemented here.

Image decoding has a 64-megapixel safety bound and a ten-second per-operation
timeout. When processing fails, the original image is sent upstream rather than
introducing another request rejection policy. Disconnects stop the upload; upstream
errors, including 413, remain authoritative. Logs contain only counts and byte
sizes, never attachment content or account identifiers. There is no retry loop.

The pinned `sharp` dependency requires Node >=20.9. Install with
`npm ci --ignore-scripts`; the supported platform's prebuilt packages are used.

Verification:

```sh
node --test test/factory-attachments.test.js test/factory-proxy.test.js
node scripts/verify-factory-attachments.js /absolute/path/to/existing-CPA-error.log
```

Add `--allow-inference` to the second command for one live transport verification
through metabridge → CPA → Factory. It reuses the original image/history payload,
disables tool calls and asks for a verification marker instead of continuing the
old task. It consumes model quota; the default is offline-only.

With `--allow-inference --codex`, the diagnostic additionally extracts the original
images to a private temporary directory and checks an actual Codex CLI image turn
and a fixture-file tool round trip. This explicitly uses the existing unsandboxed
test option for hosts where Codex's read-only sandbox cannot initialize; the
prompt authorizes reading only the generated test fixture, not the historical task.
