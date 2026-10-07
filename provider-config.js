'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const filters = new WeakMap();
const reasoning = new WeakMap();
const routes = new WeakMap();
const compactions = new WeakMap();
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function resolveFile(file, parent) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('配置文件路径必须是非空字符串');
  return file.startsWith('~/')
    ? path.join(os.homedir(), file.slice(2))
    : path.resolve(path.dirname(parent), file);
}

function readJson(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // JSON parser errors can contain source snippets, including credentials.
    throw new Error(`配置文件 ${file} 无法读取或不是合法 JSON${error.code ? ` (${error.code})` : ''}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`配置文件 ${file} 必须是 JSON 对象`);
  }
  return value;
}

function loadProviders(config, configPath) {
  if (config.providerFiles !== undefined && config.backends !== undefined) {
    throw new Error('providerFiles 与 backends 不能同时配置，请选择一种来源');
  }
  let providers;
  if (config.providerFiles !== undefined) {
    if (!Array.isArray(config.providerFiles) || !config.providerFiles.length) {
      throw new Error('providerFiles 必须是非空文件路径数组');
    }
    const seen = new Set();
    providers = config.providerFiles.map(file => {
      const source = resolveFile(file, configPath);
      const canonical = fs.realpathSync(source);
      if (seen.has(canonical)) throw new Error(`providerFiles 重复引用 ${source}`);
      seen.add(canonical);
      const provider = readJson(source);
      Object.defineProperty(provider, '_sourceFile', { value: source });
      if (provider.auth?.file) provider.auth.file = resolveFile(provider.auth.file, source);
      return provider;
    });
  } else {
    providers = config.backends || [];
  }
  if (!Array.isArray(providers)) throw new Error('backends 必须是非空数组');
  return providers;
}

function normalizeProviderConnection(provider) {
  if (provider.base !== undefined && provider.base_url !== undefined) {
    throw new Error('base 与 base_url 不能同时配置');
  }
  const base = provider.base_url ?? provider.base;
  let url;
  try { url = new URL(base); } catch { throw new Error('base_url/base 必须是合法 http(s) URL'); }
  if (typeof base !== 'string' || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('base_url/base 需要 http(s) URL，不允许用户名、密码、query 或 hash');
  }
  provider.wire_api ??= 'responses';
  if (provider.wire_api !== 'responses') {
    throw new Error('wire_api 当前只支持 responses；上游协议适配通过 protocol 配置');
  }
  if (provider.env_key !== undefined || provider.env_http_headers !== undefined) {
    throw new Error('本项目从文件配置读取凭据和头部，请使用 auth/http_headers，不使用 env_key/env_http_headers');
  }
  const headers = provider.http_headers;
  if (headers !== undefined &&
      (!headers || typeof headers !== 'object' || Array.isArray(headers) ||
       Object.entries(headers).some(([name, value]) =>
         !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
         ['host', 'connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase()) ||
         typeof value !== 'string' || /[\r\n]/.test(value)))) {
    throw new Error('http_headers 必须是合法字符串头部对象，不可设置传输控制头');
  }
  if (provider.protocol === 'codex-subscription' && headers && Object.keys(headers).length) {
    throw new Error('订阅直连仅透传客户端批准头部，不允许额外 http_headers');
  }
  provider.base = base.replace(/\/+$/, '');
}

// base_url is a complete API root; legacy base still prepends the /v1 path.
function providerApiUrl(provider, pathname) {
  const root = (provider.base_url ?? provider.base).replace(/\/+$/, '');
  const suffix = provider.base_url !== undefined ? pathname.replace(/^\/v1(?=\/)/, '') : pathname;
  return `${root}${suffix}`;
}

// Connection topology is independent of request/compaction processing.
// Only explicitly declared chains opt into the safe new defaults; old files
// retain their legacy adapt behavior until migrated.
function normalizeProviderPolicy(provider) {
  const explicitChain = provider.via !== undefined;
  if (explicitChain && !['direct', 'cpa'].includes(provider.via)) {
    throw new Error('via 仅支持 direct（直连）或 cpa（经 CPA）');
  }
  provider.protocol ||= 'responses';
  if (provider.via === 'cpa' && provider.protocol !== 'responses') {
    throw new Error('via:"cpa" 必须使用 responses；厂商协议转换由 CPA 负责');
  }
  provider.requestMode ??= explicitChain || provider.protocol === 'codex-subscription'
    ? 'passthrough' : 'adapt';
  if (!['adapt', 'passthrough'].includes(provider.requestMode) ||
      (provider.requestMode === 'passthrough' &&
       (!['responses', 'codex-subscription'].includes(provider.protocol) ||
        provider.sanitize || provider.webSearch)) ||
      (provider.protocol === 'codex-subscription' && provider.requestMode !== 'passthrough')) {
    throw new Error('requestMode 需要 adapt/passthrough；passthrough 不允许 sanitize/webSearch；官方订阅必须 passthrough');
  }
  if (explicitChain && provider.compaction === undefined) provider.compaction = { mode: 'passthrough' };
}

function compileMatcher(rule) {
  if (typeof rule === 'string' && rule.trim()) return model => model === rule;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
      Object.keys(rule).some(k => !['regex', 'flags'].includes(k)) ||
      typeof rule.regex !== 'string' || !rule.regex.length || rule.regex.length > 512 ||
      (rule.flags !== undefined && typeof rule.flags !== 'string') ||
      !/^[imu]*$/.test(rule.flags || '')) {
    throw new Error('模型规则必须是精确 ID 或 {regex, flags}；正则 flags 只允许 i/m/u');
  }
  let regex;
  try { regex = new RegExp(rule.regex, rule.flags || ''); }
  catch { throw new Error('模型过滤或推理规则中的 regex 正则无效'); }
  return model => regex.test(model);
}

function compileCompaction(provider) {
  const policy = provider.compaction;
  if (policy === undefined) return;
  if (policy && typeof policy === 'object' && !Array.isArray(policy) &&
      policy.mode === 'passthrough' && Object.keys(policy).length === 1) {
    compactions.delete(provider);
    return;
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).some(k => !['mode', 'models', 'stripImages'].includes(k)) ||
      policy.mode !== 'local' ||
      (policy.models !== undefined && (!Array.isArray(policy.models) || !policy.models.length)) ||
      (policy.stripImages !== undefined && typeof policy.stripImages !== 'boolean') ||
      (provider.protocol ?? 'responses') !== 'responses') {
    throw new Error('compaction 支持 {mode:"passthrough"} 或 responses provider 的 {mode:"local", models?:非空规则数组, stripImages?:boolean}');
  }
  compactions.set(provider, policy.models === undefined ? [() => true] : policy.models.map(compileMatcher));
}

function compactionForModel(provider, model) {
  if (provider.protocol === 'codex-subscription' || typeof model !== 'string' || model.length > 2048) return null;
  return compactions.get(provider)?.some(match => match(model)) ? provider.compaction : null;
}

function usesLocalCompaction(provider, model) {
  if (provider.protocol === 'codex-subscription') return false;
  if (provider.compaction !== undefined) return compactionForModel(provider, model) !== null;
  return Boolean(provider.prefix && provider.requestMode !== 'passthrough');
}

function compileList(rules, label) {
  if (!Array.isArray(rules)) throw new Error(`${label} 必须是规则数组`);
  return rules.map(compileMatcher);
}

function compileRouteModels(provider) {
  if (provider.routeModels === undefined) return;
  if (provider.prefix || !Array.isArray(provider.routeModels) || !provider.routeModels.length) {
    throw new Error('routeModels 必须是非空规则数组，且不能与非空 prefix 并用');
  }
  routes.set(provider, compileList(provider.routeModels, 'routeModels'));
}

function matchesRoute(provider, model) {
  return typeof model === 'string' && model.length <= 2048 &&
    (routes.get(provider) || []).some(match => match(model));
}

function compileModelFilter(provider) {
  if (provider.modelAllowlist !== undefined && provider.modelFilter !== undefined) {
    throw new Error('modelAllowlist 与 modelFilter 不能同时配置，请迁移到 modelFilter.allow');
  }
  const spec = provider.modelFilter === undefined ? {} : provider.modelFilter;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
      Object.keys(spec).some(k => !['allow', 'deny'].includes(k))) {
    throw new Error('modelFilter 只支持 allow 和 deny');
  }
  // Keep the previous exact-ID contract for existing deployments.
  if (provider.modelAllowlist !== undefined &&
      (!Array.isArray(provider.modelAllowlist) ||
       provider.modelAllowlist.some(id => typeof id !== 'string' || !id.trim()))) {
    throw new Error('modelAllowlist 必须是模型 ID 字符串数组');
  }
  const allowSpec = provider.modelAllowlist ?? spec.allow;
  const allow = allowSpec === undefined ? null : compileList(allowSpec, 'modelFilter.allow');
  const deny = spec.deny === undefined ? [] : compileList(spec.deny, 'modelFilter.deny');
  const predicate = model => typeof model === 'string' && model.length > 0 &&
    model.length <= 2048 && !deny.some(match => match(model)) &&
    (allow === null || allow.some(match => match(model)));
  filters.set(provider, predicate);
  return predicate;
}

function isModelAllowed(provider, model) {
  return (filters.get(provider) || compileModelFilter(provider))(model);
}

function validateReasoningPolicy(policy) {
  if (!policy || !Array.isArray(policy.levels) || !policy.levels.length ||
      policy.levels.some(level => !EFFORTS.has(level)) ||
      new Set(policy.levels).size !== policy.levels.length ||
      !policy.levels.includes(policy.default)) {
    throw new Error('推理策略需要有效的 levels 和包含在其中的 default');
  }
}

function compileReasoningRules(provider) {
  if (provider.reasoningRules === undefined) {
    reasoning.set(provider, []);
    return [];
  }
  if (!Array.isArray(provider.reasoningRules)) throw new Error('reasoningRules 必须是数组');
  const rules = provider.reasoningRules.map(rule => {
    validateReasoningPolicy(rule);
    return { match: compileMatcher(rule.match), levels: [...rule.levels], default: rule.default };
  });
  reasoning.set(provider, rules);
  return rules;
}

function reasoningForModel(provider, model) {
  const rules = reasoning.get(provider) || compileReasoningRules(provider);
  const selected = rules.find(rule => rule.match(model));
  return selected ? { levels: [...selected.levels], default: selected.default } : null;
}

module.exports = {
  readJson, loadProviders, resolveFile, compileMatcher, compileModelFilter, isModelAllowed,
  compileReasoningRules, reasoningForModel, validateReasoningPolicy,
  normalizeProviderConnection, providerApiUrl, normalizeProviderPolicy,
  compileRouteModels, matchesRoute,
  compileCompaction, compactionForModel, usesLocalCompaction,
};
