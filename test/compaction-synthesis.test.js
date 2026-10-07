'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMPACT_PROMPT,
  IMAGE_PLACEHOLDER,
  buildCompactionItem,
  buildSummarizationPayload,
  decodeCompactionEnvelope,
  encodeMbCmp1,
  materializeLatestCompaction,
  summaryFromResponsesJson,
  summaryFromSse,
} = require('../compaction');

function sse(...events) {
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function completed(output, extra = {}) {
  return { id: 'resp_1', object: 'response', status: 'completed', output, ...extra };
}

function assistantText(text) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

test('mb-cmp1 信封可往返，且兼容 gateway 的 sr-cmp1', () => {
  const encoded = encodeMbCmp1('checkpoint 内容');
  assert.ok(encoded.startsWith('mb-cmp1:'));
  assert.equal(decodeCompactionEnvelope(encoded), 'checkpoint 内容');

  const srCmp1 = `sr-cmp1:${Buffer.from(
    JSON.stringify({ v: 1, summary: 'gateway 产出' }),
    'utf8'
  ).toString('base64')}`;
  assert.equal(decodeCompactionEnvelope(srCmp1), 'gateway 产出');
});

test('官方 Fernet 加密块与畸形信封一律解不出摘要', () => {
  assert.equal(decodeCompactionEnvelope('gAAAAABm-opaque-fernet-blob'), null);
  assert.equal(decodeCompactionEnvelope('mb-cmp1:'), null);
  assert.equal(decodeCompactionEnvelope('mb-cmp1:!!!not-base64!!!'), null);
  assert.equal(decodeCompactionEnvelope(undefined), null);
});

test('回放能物化 mb-cmp1 checkpoint', () => {
  const result = materializeLatestCompaction([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧问题' }] },
    { type: 'compaction', id: 'cmp_1', encrypted_content: encodeMbCmp1('本地摘要') },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '新问题' }] },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.input.length, 2);
  assert.equal(result.input[0].role, 'assistant');
  assert.match(result.input[0].content[0].text, /本地摘要/);
  assert.equal(result.input[1].content[0].text, '新问题');
});

test('摘要请求剥掉 trigger、工具面与结构化输出，并追加压缩提示词', () => {
  const built = buildSummarizationPayload({
    model: 'gpt-test',
    stream: true,
    tools: [{ type: 'function', name: 'shell' }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    text: { format: { type: 'json_schema' } },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '历史' }] },
      { type: 'additional_tools', tools: [{ type: 'function', name: 'apply_patch' }] },
      { type: 'compaction_trigger' },
    ],
  });

  assert.equal(built.tools, undefined);
  assert.equal(built.tool_choice, undefined);
  assert.equal(built.parallel_tool_calls, undefined);
  assert.equal(built.text, undefined);
  // stream 必须原样保留：调用方按客户端要求决定响应格式
  assert.equal(built.stream, true);

  const types = built.input.map(i => i.type);
  assert.ok(!types.includes('compaction_trigger'));
  assert.ok(!types.includes('additional_tools'));

  const last = built.input[built.input.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].text, COMPACT_PROMPT);
});

test('摘要请求原样保留图片，让摘要能描述截图内容', () => {
  const built = buildSummarizationPayload({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '看这张图' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
      { type: 'compaction_trigger' },
    ],
  });

  const blocks = built.input[0].content;
  assert.equal(blocks[0].text, '看这张图');
  // 摘要用的是会话当前的模型：图片能进历史就说明这个模型收得下，剥掉只会让摘要
  // 丢掉截图里的信息；图片支持由上游决定，不在这里假设它会静默丢图。
  assert.equal(blocks[1].type, 'input_image');
  assert.equal(blocks[1].image_url, 'data:image/png;base64,AAAA');
});

test('stripImages 开启后图片换成占位文本，嵌套的工具输出也要处理', () => {
  const original = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '看这张图' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
      {
        // view_image 的工具输出：图片藏在更深一层
        type: 'function_call_output',
        call_id: 'call_1',
        output: { content: [{ type: 'input_image', image_url: 'data:image/png;base64,BBBB' }] },
      },
      { type: 'compaction_trigger' },
    ],
  };

  const built = buildSummarizationPayload(original, { stripImages: true });

  const blocks = built.input[0].content;
  assert.equal(blocks[0].text, '看这张图');
  assert.deepEqual(blocks[1], { type: 'input_text', text: IMAGE_PLACEHOLDER });
  assert.deepEqual(built.input[1].output.content[0], { type: 'input_text', text: IMAGE_PLACEHOLDER });
  assert.equal(JSON.stringify(built).includes('base64,'), false);

  // 剥离只作用于发出去的副本，调用方的 payload 不能被改
  assert.equal(original.input[0].content[1].type, 'input_image');
  assert.equal(original.input[1].output.content[0].image_url, 'data:image/png;base64,BBBB');
});

test('原始 payload 不被摘要改写就地修改', () => {
  const original = {
    model: 'gpt-test',
    tools: [{ type: 'function', name: 'shell' }],
    input: [{ type: 'compaction_trigger' }],
  };
  buildSummarizationPayload(original);

  assert.equal(original.tools.length, 1);
  assert.equal(original.input.length, 1);
});

test('JSON 上游：从 assistant 文本提取摘要', () => {
  const result = summaryFromResponsesJson(
    completed([assistantText('第一段'), assistantText('第二段')])
  );
  assert.deepEqual(result, { ok: true, summary: '第一段第二段' });
});

test('JSON 上游：未完成或被截断时不产出摘要', () => {
  const incomplete = summaryFromResponsesJson({ status: 'incomplete', output: [assistantText('半截')] });
  assert.equal(incomplete.ok, false);

  const truncated = summaryFromResponsesJson(
    completed([assistantText('半截')], { incomplete_details: { reason: 'max_output_tokens' } })
  );
  assert.equal(truncated.ok, false);

  const empty = summaryFromResponsesJson(completed([assistantText('   ')]));
  assert.equal(empty.ok, false);
});

test('SSE 上游：累积 delta 并在 completed 时收口', () => {
  const body = sse(
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_text.delta', delta: '摘要前半' },
    { type: 'response.output_text.delta', delta: '摘要后半' },
    { type: 'response.completed', response: completed([]) }
  );

  assert.deepEqual(summaryFromSse(body), { ok: true, summary: '摘要前半摘要后半' });
});

test('SSE 上游：没有 delta 时回落到 completed 快照里的文本', () => {
  const body = sse({ type: 'response.completed', response: completed([assistantText('快照摘要')]) });
  assert.deepEqual(summaryFromSse(body), { ok: true, summary: '快照摘要' });
});

test('SSE 上游：失败、截断、无终止事件都必须 fail closed', () => {
  const failed = summaryFromSse(sse(
    { type: 'response.output_text.delta', delta: '半截' },
    { type: 'response.failed', response: { status: 'failed', error: { message: '上游炸了' } } }
  ));
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /上游炸了/);

  const truncated = summaryFromSse(sse(
    { type: 'response.output_text.delta', delta: '半截' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
  ));
  assert.equal(truncated.ok, false);

  const noTerminal = summaryFromSse(sse({ type: 'response.output_text.delta', delta: '半截' }));
  assert.equal(noTerminal.ok, false);
});

test('合成的 compaction item 自带 id 且可被回放解码', () => {
  const item = buildCompactionItem('本地摘要');
  assert.equal(item.type, 'compaction');
  assert.ok(item.id.startsWith('cmp_'));
  assert.equal(decodeCompactionEnvelope(item.encrypted_content), '本地摘要');
});
