'use strict';

/**
 * 工具名兼容层：>64 字符的 MCP 工具名在请求侧改写为别名，响应侧还原。
 *
 * 背景：Codex 内置 codex_apps 连接器把 MCP 工具暴露为
 * mcp__<connector>__<server>__<tool>，其中若干工具全名达到 65/66 字符，
 * 超过模型 API 对 function name 的 64 字符上限，请求会被下游拒绝
 * （所有后端一视同仁，这是模型 API 的通用限制）。
 *
 * 别名只存在于「metabridge → 上游」这一跳：响应侧会还原成原名，所以
 * codex_core 存进历史的始终是原名。别名不需要跨请求稳定，也不需要能被
 * 反解——还原靠的是同一次请求里根据 tools 列表建的反向映射。
 *
 * 命名策略：MCP 工具名的头部段（mcp、连接器名）对同一连接器下的所有工具
 * 完全相同，没有任何区分度；尾部段才是真正的动词。所以砍头部、保尾部，
 * 而不是像早期实现那样保留头部、把动词截断成 execute_docume 这种。
 */

const crypto = require('crypto');

const MAX_TOOL_NAME = 64;
const ALIAS_HASH_LEN = 5;

/** sha1 前 52 位 → base36 定长 n 位，字符集 [0-9a-z] 天然合法。 */
function shortHash(name, n = ALIAS_HASH_LEN) {
  const hex = crypto.createHash('sha1').update(name).digest('hex').slice(0, 13);
  return BigInt(`0x${hex}`).toString(36).padStart(n, '0').slice(-n);
}

/**
 * 候选别名，由短到长。取第一个「不超限且不撞名」的候选即可。
 *
 * 以 mcp__codex_apps__codex_document_control__get_document_tool_schemas 为例：
 *   1. codex_document_control__get_document_tool_schemas   ← 砍掉 mcp 与连接器段
 *   2. codex_apps__codex_document_control__get_...         ← 撞名时逐层加回
 *   3. get_document_tool_schemas                           ← 仍撞名才只留动词
 *
 * 至少保留一层命名空间，让模型仍能看出工具归属；只有前面都撞名时才退到裸动词。
 */
function aliasCandidates(name) {
  const segs = name.split('__').filter(Boolean);
  if (segs.length < 2) return [];
  const parts = segs[0] === 'mcp' ? segs.slice(1) : segs;
  const tool = parts[parts.length - 1];
  const ns = parts.slice(0, -1);

  const out = [];
  for (let keep = Math.min(1, ns.length); keep <= ns.length; keep += 1) {
    out.push([...ns.slice(ns.length - keep), tool].join('__'));
  }
  if (ns.length) out.push(tool);
  return out;
}

/**
 * 兜底：截断 + 短哈希，恰好 64 字符。
 * 只有名字里没有 `__` 分隔、或单个动词段本身就超过 64 时才会走到这里。
 */
function aliasFallback(name) {
  return `${name.slice(0, MAX_TOOL_NAME - ALIAS_HASH_LEN - 1)}_${shortHash(name)}`;
}

/**
 * 给一个工具名取别名。taken 是本次请求里已被占用的名字集合
 * （所有真实工具名 + 已分配的别名），用来避免撞名。
 */
function aliasFor(name, taken = new Set()) {
  if (name.length <= MAX_TOOL_NAME) return name;
  for (const cand of aliasCandidates(name)) {
    if (cand.length <= MAX_TOOL_NAME && !taken.has(cand)) return cand;
  }
  return aliasFallback(name);
}

/** 收集 tools 列表里出现的所有工具名（含 namespace 工具的嵌套 tools）。 */
function collectToolNames(tools, out = []) {
  if (!Array.isArray(tools)) return out;
  for (const t of tools) {
    if (!t) continue;
    if (typeof t.name === 'string') out.push(t.name);
    if (t.function && typeof t.function.name === 'string') out.push(t.function.name);
    if (Array.isArray(t.tools)) collectToolNames(t.tools, out);
  }
  return out;
}

/**
 * 从请求的 tools 列表构建双向映射（original → alias / alias → original）。
 *
 * 两遍扫描：先收齐所有工具名作为「已占用」基线——候选别名不能撞上请求里任何
 * 一个真实工具名，包括那些本身没超限、不参与改写的短名字；再按出现顺序给超限
 * 的名字分配别名，保证同一份 tools 列表得到同一套结果。
 */
function buildAliasMap(tools) {
  const fwd = new Map();
  const rev = new Map();
  const all = collectToolNames(tools);
  const taken = new Set(all);

  for (const name of all) {
    if (name.length <= MAX_TOOL_NAME || fwd.has(name)) continue;
    const alias = aliasFor(name, taken);
    fwd.set(name, alias);
    rev.set(alias, name);
    taken.add(alias);
  }

  return { fwd, rev };
}

/** 请求侧：改写 tools / tool_choice / input 历史里的 function_call 名。 */
function rewriteRequestPayload(payload, fwd) {
  if (!fwd.size) return;

  if (Array.isArray(payload.tools)) {
    const walk = (list) => {
      for (const t of list) {
        if (!t) continue;
        if (typeof t.name === 'string' && fwd.has(t.name)) t.name = fwd.get(t.name);
        if (t.function && typeof t.function.name === 'string' && fwd.has(t.function.name)) {
          t.function.name = fwd.get(t.function.name);
        }
        if (Array.isArray(t.tools)) walk(t.tools);
      }
    };
    walk(payload.tools);
  }

  // tool_choice：Responses 格式 {type:"function", name} / ChatCompletions 格式 {type:"function", function:{name}}
  const tc = payload.tool_choice;
  if (tc && typeof tc === 'object') {
    if (typeof tc.name === 'string' && fwd.has(tc.name)) tc.name = fwd.get(tc.name);
    if (tc.function && typeof tc.function.name === 'string' && fwd.has(tc.function.name)) {
      tc.function.name = fwd.get(tc.function.name);
    }
  }

  // Responses API 的 input 历史里有 function_call item，必须一起改，
  // 否则模型会看到"工具列表是别名、历史是原名"的不一致
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item && typeof item.name === 'string' && fwd.has(item.name)) {
        item.name = fwd.get(item.name);
      }
    }
  }
}

/** 响应侧：深度遍历 JSON，把别名还原成原名。 */
function rewriteToolNamesDeep(obj, rev) {
  if (Array.isArray(obj)) {
    for (const o of obj) rewriteToolNamesDeep(o, rev);
    return obj;
  }
  if (obj && typeof obj === 'object') {
    // Responses API: function_call item
    if (['function_call', 'custom_tool_call'].includes(obj.type) && typeof obj.name === 'string' && rev.has(obj.name)) {
      obj.name = rev.get(obj.name);
    }
    // Chat Completions: tool_calls[].function.name
    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        if (tc && tc.function && typeof tc.function.name === 'string' && rev.has(tc.function.name)) {
          tc.function.name = rev.get(tc.function.name);
        }
      }
    }
    for (const k of Object.keys(obj)) rewriteToolNamesDeep(obj[k], rev);
  }
  return obj;
}

/**
 * 构造响应改写器：按 SSE 事件边界处理，避免别名跨 chunk 被截断。
 * 返回 null 表示无需改写（没有超长工具名）。
 */
function makeRespRewriter(rev) {
  if (!rev.size) return null;
  return (text) => {
    if (text.includes('data:')) {
      return text.replace(/^data: ?(.+)$/gm, (line, jsonStr) => {
        try {
          return `data: ${JSON.stringify(rewriteToolNamesDeep(JSON.parse(jsonStr), rev))}`;
        } catch {
          return line; // [DONE] 等非 JSON 行原样透传
        }
      });
    }
    // 非 SSE 的 JSON 响应
    try {
      return JSON.stringify(rewriteToolNamesDeep(JSON.parse(text), rev));
    } catch {
      return text;
    }
  };
}

module.exports = {
  ALIAS_HASH_LEN,
  MAX_TOOL_NAME,
  aliasCandidates,
  aliasFallback,
  aliasFor,
  buildAliasMap,
  collectToolNames,
  makeRespRewriter,
  rewriteRequestPayload,
  rewriteToolNamesDeep,
  shortHash,
};
