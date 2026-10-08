'use strict';

const crypto = require('node:crypto');

const CHECKPOINT_PREFIX = [
  '<conversation_checkpoint>',
  'The following text is a historical conversation checkpoint.',
  'It is context, not a user request.',
  'Do not execute tasks or "next steps" from it unless the latest real user message asks for them.',
  'The latest real user message after this checkpoint is authoritative.',
  '',
].join('\n');

const CHECKPOINT_SUFFIX = '\n</conversation_checkpoint>';

/** metabridge 自产的 compaction 信封前缀（本地合成）。 */
const MB_COMPACTION_PREFIX = 'mb-cmp1:';

/** gateway 非官方模型产出的信封前缀（历史会话回放兼容）。 */
const SR_COMPACTION_PREFIX = 'sr-cmp1:';

/**
 * 压缩提示词，镜像 codex-rs core/templates/compact/prompt.md（local compaction 用的指令）。
 *
 * 本地合成压缩时，metabridge 把这条提示词作为最后一条 user 消息追加到历史后面，
 * 让当前会话模型自己产出交接摘要——上游因此只看到一次普通对话请求，
 * 完全不需要理解 Codex 私有的 compaction_trigger。
 */
const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/** compactionStripImages 开启时替换图片的占位文本。 */
const IMAGE_PLACEHOLDER = '[image omitted for compaction]';

/**
 * 解码可移植 compaction envelope（JSON 载荷）。
 *
 * 两种前缀共用同一载荷格式：
 *   mb-cmp1:<base64 JSON>   metabridge 本地合成
 *   sr-cmp1:<base64 JSON>   gateway 非官方模型产出
 * JSON 至少包含：
 *   {"v":1,"summary":"..."}
 *
 * 官方 OpenAI compaction 使用不可由本地 bridge 解密的 opaque Fernet 内容，
 * 因此这里必须返回 null，交由调用方 fail closed。
 */
function decodeEnvelope(encryptedContent, prefix) {
  if (typeof encryptedContent !== 'string' || !encryptedContent.startsWith(prefix)) {
    return null;
  }

  try {
    const encoded = encryptedContent.slice(prefix.length);
    if (encoded === '') return null;

    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const envelope = JSON.parse(decoded);
    if (!envelope || typeof envelope.summary !== 'string' || envelope.summary.trim() === '') {
      return null;
    }
    return envelope.summary;
  } catch {
    return null;
  }
}

function decodeSrCmp1(encryptedContent) {
  return decodeEnvelope(encryptedContent, SR_COMPACTION_PREFIX);
}

/**
 * 解码任意 metabridge 可识别的 compaction 信封。
 * mb-cmp1（自产）优先，sr-cmp1（gateway 历史会话）兜底；其余一律 null。
 */
function decodeCompactionEnvelope(encryptedContent) {
  return (
    decodeEnvelope(encryptedContent, MB_COMPACTION_PREFIX) ??
    decodeEnvelope(encryptedContent, SR_COMPACTION_PREFIX)
  );
}

function encodeMbCmp1(summary) {
  const payload = JSON.stringify({ v: 1, summary });
  return MB_COMPACTION_PREFIX + Buffer.from(payload, 'utf8').toString('base64');
}

function hasCompactionTrigger(input) {
  return Array.isArray(input) &&
    input.some(item => item && item.type === 'compaction_trigger');
}

/**
 * 递归把 input_image 换成占位文本，返回新结构（不改调用方的 payload）。
 * 图片可能藏在 view_image 这类工具输出的深层，所以必须整棵树走一遍。
 */
function stripImagesDeep(value) {
  if (Array.isArray(value)) return value.map(stripImagesDeep);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'input_image') {
    return { type: 'input_text', text: IMAGE_PLACEHOLDER };
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = stripImagesDeep(entry);
  return out;
}

/**
 * 把 Codex 的 compaction 轮次改写成一次普通摘要请求。
 *
 * 必须一起剥掉的东西：
 *   - compaction_trigger / additional_tools：上游不认识这两个 Codex 私有 item
 *   - tools / tool_choice / parallel_tool_calls：摘要轮次不该调工具
 *   - text：结构化输出格式会把摘要压成 schema JSON，而这里要的是散文
 *
 * 图片默认**不剥**：让当前模型看到截图，摘要里才能保留截图信息。
 * 不支持图片的上游可能拒绝请求；是否接受图片取决于该后端与模型。
 * 需要剥掉时传 options.stripImages（对应配置 compactionStripImages）——适用于上游会用
 * 400 拒收图片，或想省掉图片 token 的后端。
 *
 * stream 原样保留：调用方按客户端要求决定回给 Codex 的响应格式。
 */
function buildSummarizationPayload(payload, options = {}) {
  const {
    tools: _tools,
    tool_choice: _toolChoice,
    parallel_tool_calls: _parallelToolCalls,
    text: _text,
    ...rest
  } = payload;

  const input = Array.isArray(payload.input) ? payload.input : [];
  const kept = input.filter(
    item => !item || (item.type !== 'compaction_trigger' && item.type !== 'additional_tools')
  );

  return {
    ...rest,
    input: [
      ...(options.stripImages ? stripImagesDeep(kept) : kept),
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: COMPACT_PROMPT }] },
    ],
  };
}

function failure(type, message) {
  return { ok: false, error: { type, message } };
}

/** 从 Responses output 数组里拼出 assistant 文本。 */
function textFromOutput(output) {
  if (!Array.isArray(output)) return '';
  let text = '';
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    if (typeof item.content === 'string') {
      text += item.content;
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!block || typeof block.text !== 'string') continue;
      if (block.type === 'output_text' || block.type === 'text') text += block.text;
    }
  }
  return text;
}

function errorMessageOf(value, fallback) {
  if (typeof value === 'string' && value !== '') return value;
  if (value && typeof value.message === 'string' && value.message !== '') return value.message;
  return fallback;
}

/**
 * 从非流式 Responses 响应体里取摘要。
 *
 * 完成度守卫：只有真正 completed 且未被截断的轮次才允许产出摘要。
 * 截断的摘要一旦被当成替换历史装上去，这段会话的上下文就永久丢了。
 */
function summaryFromResponsesJson(json) {
  if (!json || typeof json !== 'object') {
    return failure('invalid_response_error', '压缩轮次的上游响应不是 JSON 对象');
  }
  if (json.error) {
    return failure('upstream_error', `压缩轮次失败：${errorMessageOf(json.error, '上游返回 error')}`);
  }
  if (json.status !== undefined && json.status !== 'completed') {
    return failure('upstream_error', `压缩轮次未完成（status=${json.status}）`);
  }
  if (json.incomplete_details) {
    const reason = errorMessageOf(json.incomplete_details.reason, 'unknown');
    return failure('upstream_error', `压缩轮次被截断（${reason}），拒绝安装半截摘要`);
  }

  const summary = textFromOutput(json.output);
  if (summary.trim() === '') {
    return failure('invalid_response_error', '压缩轮次没有产出摘要文本');
  }
  return { ok: true, summary };
}

/** 逐块解析 SSE 文本，产出 { type, data } 序列。data.type 缺失时回落到 event 名。 */
function parseSseEvents(body) {
  const events = [];
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    let name = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('');
    if (raw === '' || raw === '[DONE]') continue;
    try {
      const data = JSON.parse(raw);
      const type = (data && typeof data.type === 'string' ? data.type : null) || name;
      if (type) events.push({ type, data });
    } catch {
      // 单个不可解析的事件不该毁掉整轮压缩：终止事件缺失会在下面 fail closed。
    }
  }
  return events;
}

/**
 * 从流式 Responses 响应里取摘要。
 *
 * 累积 output_text.delta，在 response.completed 收口；failed / incomplete /
 * 压根没有终止事件都必须 fail closed（与非流式路径同一套完成度守卫）。
 */
function summaryFromSse(body) {
  let accumulated = '';
  for (const { type, data } of parseSseEvents(body)) {
    if (type === 'response.output_text.delta') {
      if (typeof data.delta === 'string') accumulated += data.delta;
      continue;
    }
    if (type === 'response.failed' || type === 'response.error' || type === 'error') {
      const source = (data.response && data.response.error) || data.error || data;
      return failure('upstream_error', `压缩轮次失败：${errorMessageOf(source, '上游返回 failed')}`);
    }
    if (type === 'response.incomplete') {
      const details = (data.response && data.response.incomplete_details) || {};
      const reason = errorMessageOf(details.reason, 'unknown');
      return failure('upstream_error', `压缩轮次被截断（${reason}），拒绝安装半截摘要`);
    }
    if (type === 'response.completed') {
      const snapshot = data.response || {};
      if (snapshot.incomplete_details) {
        const reason = errorMessageOf(snapshot.incomplete_details.reason, 'unknown');
        return failure('upstream_error', `压缩轮次被截断（${reason}），拒绝安装半截摘要`);
      }
      const summary = accumulated.trim() !== '' ? accumulated : textFromOutput(snapshot.output);
      if (summary.trim() === '') {
        return failure('invalid_response_error', '压缩轮次没有产出摘要文本');
      }
      return snapshot.usage
        ? { ok: true, summary, usage: snapshot.usage }
        : { ok: true, summary };
    }
  }

  return failure('upstream_error', '压缩轮次的事件流没有终止事件（response.completed 缺失）');
}

/** 合成 Codex 要求的那一条 compaction item。 */
function buildCompactionItem(summary) {
  return {
    type: 'compaction',
    id: `cmp_${crypto.randomUUID().replace(/-/g, '')}`,
    encrypted_content: encodeMbCmp1(summary),
  };
}

function newResponseId() {
  return `resp_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * usage 的零值默认。
 *
 * input_tokens_details / output_tokens_details 必须始终出现：严格的 Responses
 * 客户端把它们当必填字段反序列化，缺字段会让一次成功的压缩在 response.completed
 * 之后直接报错。
 */
const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};

/** 构造回给 Codex 的压缩轮次响应快照（output 里恰好一条 compaction item）。 */
function buildCompactionResponse({ id, model, item, usage, status = 'completed' }) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: item ? [item] : [],
    usage: usage || EMPTY_USAGE,
  };
}

/**
 * 将 Responses API compaction 窗口物化为兼容后端能消费的普通消息窗口。
 *
 * OpenAI 的 stateless compaction 语义允许丢弃最新 compaction 之前的所有 item；
 * 最新 compaction 已携带继续会话所需的历史状态。对不支持原生回放的后端：
 *
 *   [旧历史..., compaction, 新输入...]
 *
 * 转换成：
 *
 *   [assistant checkpoint, 新输入...]
 *
 * 不能保留 compaction 之前的旧 user message，否则它们会继续与最新 query 竞争；
 * 也不能把 checkpoint 标成 user/system，否则历史状态会被误当成当前高优先级指令。
 */
function materializeLatestCompaction(input) {
  if (!Array.isArray(input)) {
    return { ok: true, compacted: false, input };
  }

  let latestIndex = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i] && input[i].type === 'compaction') {
      latestIndex = i;
      break;
    }
  }

  if (latestIndex < 0) {
    return { ok: true, compacted: false, input };
  }

  const item = input[latestIndex];
  const summary = decodeCompactionEnvelope(item.encrypted_content);
  if (summary === null) {
    return {
      ok: false,
      compacted: false,
      error: {
        type: 'unsupported_compaction_format',
        message:
          'Prefixed backend can only materialize mb-cmp1/sr-cmp1 compaction items; ' +
          'the latest compaction item is opaque or malformed',
      },
    };
  }

  const checkpoint = {
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: `${CHECKPOINT_PREFIX}${summary}${CHECKPOINT_SUFFIX}`,
    }],
  };

  const tail = input
    .slice(latestIndex + 1)
    .filter(tailItem => tailItem && tailItem.type !== 'compaction_trigger');

  return {
    ok: true,
    compacted: true,
    input: [checkpoint, ...tail],
    compactionId: typeof item.id === 'string' ? item.id : null,
    droppedItems: latestIndex,
    retainedItems: tail.length,
  };
}

module.exports = {
  CHECKPOINT_PREFIX,
  CHECKPOINT_SUFFIX,
  COMPACT_PROMPT,
  IMAGE_PLACEHOLDER,
  buildCompactionItem,
  buildCompactionResponse,
  buildSummarizationPayload,
  decodeCompactionEnvelope,
  decodeSrCmp1,
  encodeMbCmp1,
  hasCompactionTrigger,
  materializeLatestCompaction,
  newResponseId,
  summaryFromResponsesJson,
  summaryFromSse,
};
