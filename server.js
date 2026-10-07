#!/usr/bin/env node
'use strict';

/**
 * codex-metabridge
 *
 * 本机多后端聚合代理：把多个 bridge/gateway 后端合并成单个
 * OpenAI 兼容 provider，对 Codex 只暴露一个 base_url。
 *
 * 路由规则：
 *   - 模型名以某后端的 prefix 开头 → 转发到该后端（去掉前缀）
 *   - 其余                        → 转发到 catch-all 后端（prefix 为空）
 *
 * 目录合并：
 *   GET /v1/models 返回所有后端目录的并集（按 priority 排序）。
 *
 * 鉴权：
 *   每个后端独立配置 auth 策略（keyfile / gateway / static / none），
 *   passthroughHeaders 控制是否透传入站请求头。
 *
 * 扩展性：
 *   加新 bridge 只需在 backends[] 里加一条配置，不需要改代码。
 *   auth / sanitize / reasoning 三类策略均可通过注册表扩展。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  buildCompactionItem,
  buildCompactionResponse,
  buildSummarizationPayload,
  hasCompactionTrigger,
  materializeLatestCompaction,
  newResponseId,
  summaryFromResponsesJson,
  summaryFromSse,
} = require('./compaction');

const {
  buildAliasMap,
  makeRespRewriter,
  rewriteRequestPayload,
} = require('./tool-names');
const execFileAsync = promisify(execFile);
const { commandFetch } = require('./command-code');
const { commandCodeReasoning } = require('./command-reasoning');
const { hasHostedSearch, commandSearchFetch } = require('./web-search');
const {
  readJson, loadProviders, compileMatcher, compileModelFilter, isModelAllowed,
  compileReasoningRules, reasoningForModel, validateReasoningPolicy,
  normalizeProviderConnection, providerApiUrl, normalizeProviderPolicy,
  compileRouteModels, matchesRoute,
  compileCompaction, compactionForModel, usesLocalCompaction,
} = require('./provider-config');
const {
  subscriptionHeaders, validateSubscriptionBackend, subscriptionFetch,
} = require('./codex-subscription');

// ============ 工具函数 ============

function expandHome(p) {
  if (typeof p === 'string' && p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * 解析布尔配置：环境变量优先，其次配置文件，最后默认值。
 * 两边都接受 "1"/"true"/"yes"/"on" 与 "0"/"false"/"no"/"off"——配置文件里写成字符串
 * 是很常见的手误，静默当成 false 比直接认下来更难查。空串按"没设置"处理。
 */
function parseBoolish(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

function resolveBool(envValue, fileValue, fallback) {
  return parseBoolish(envValue) ?? parseBoolish(fileValue) ?? fallback;
}

// ============ 配置 ============

function resolveConfigPath() {
  return process.env.MB_CONFIG_FILE || path.join(os.homedir(), '.metabridge', 'config.json');
}

// ============ gateway 凭据 ============
//
// 归属地是 metabridge 自己的 config.json：运行期只读 backends[].auth.key，
// 不会回头去读 Codex 的 config.toml 兜底。config.toml 只是一个"获取来源"，
// 且只在显式执行 `node server.js --import-gateway-key` 时被读一次。

// Codex 里携带 gateway 凭据的请求头名
const GATEWAY_HEADER = 'x-api-key';

/**
 * 判断是否是没被替换的占位符（config.example.json 里的 plat_xxxx...）。
 * 占位符按"没填"处理，否则每个 gateway 请求都会 401，排查成本很高。
 * 阈值取 12 个连续 x：真 key 是随机串，连撞 12 个 x 的概率可以忽略。
 */
function isPlaceholderKey(key) {
  if (typeof key !== 'string') return false;
  const k = key.trim();
  if (!k) return false;
  return /^(plat_)?x{4,}$/i.test(k) || /x{12,}/i.test(k);
}

/** Codex 配置文件路径（尊重 CODEX_HOME）。只被导入命令使用。 */
function codexConfigPath() {
  const home = process.env.CODEX_HOME
    ? expandHome(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

/**
 * 从 Codex 的 config.toml 里提取 gateway 凭据，供导入命令使用（运行期不调用）。
 * 命中形式：
 *   http_headers     = { "x-api-key" = "plat_..." }        → 字面量
 *   [model_providers.x.http_headers]
 *   "x-api-key" = "plat_..."                               → 字面量
 *   env_http_headers = { "x-api-key" = "GATEWAY_KEY_VAR" }   → 环境变量名
 *
 * 逐行扫描而不是完整 TOML 解析（本项目零依赖）：跨行 inline table 不会被识别，
 * 属已知取舍——取不到时导入命令会明确报错，让 agent 去找用户要 key。
 */
function readGatewayKeyFromCodexConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }

  const headerPattern = new RegExp(`["']?${GATEWAY_HEADER}["']?\\s*=\\s*["']([^"']+)["']`, 'i');
  let section = '';
  let literal = null;
  let fromEnv = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[+([^\]]+)\]+$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const headerMatch = line.match(headerPattern);
    if (!headerMatch) continue;

    const value = headerMatch[1].trim();
    if (!value || isPlaceholderKey(value)) continue;

    const isEnvRef = /env_http_headers/i.test(line) || /env_http_headers$/i.test(section);
    if (isEnvRef) {
      const fromProcess = (process.env[value] || '').trim();
      if (fromProcess && !fromEnv) fromEnv = fromProcess;
    } else if (!literal) {
      literal = value;
    }
  }

  return literal || fromEnv || null;
}

/**
 * gateway key 只有一个来源：本机 config.json 的 backends[].auth.key。
 * 缺失或仍是占位符时返回空 key，由调用方禁用后端并输出获取引导。
 */
function resolveGatewayKey(auth) {
  const explicit = typeof auth.key === 'string' ? auth.key.trim() : '';
  const placeholder = isPlaceholderKey(explicit);
  if (explicit && !placeholder) {
    return { key: explicit, source: 'config.json', placeholder: false };
  }
  return { key: '', source: null, placeholder };
}

/**
 * `node server.js --import-gateway-key [--from <file>] [--backend <name>] [--force]`
 *
 * 把 gateway 凭据从外部来源（默认 Codex 的 config.toml）写进 metabridge 自己的
 * config.json。这是唯一会去读外部配置的地方，且只在显式执行时跑一次——之后
 * 运行期只认 config.json，改 Codex 配置不再影响 metabridge。
 *
 * 相比 `grep x-api-key ...` 再手抄的好处：明文不会经过终端输出。
 * 执行完直接 exit，不会继续启动服务。
 */
function runImportGatewayKey(argv) {
  const opts = { from: null, backend: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') opts.from = argv[++i];
    else if (argv[i] === '--backend') opts.backend = argv[++i];
    else if (argv[i] === '--force') opts.force = true;
  }

  const configPath = resolveConfigPath();
  let cfg;
  try {
    cfg = readJson(configPath);
  } catch (e) {
    console.error(`导入失败：读不到配置 ${configPath}（${e.message}）`);
    console.error('  先创建：mkdir -p ~/.metabridge && cp config.example.json ~/.metabridge/config.json');
    process.exit(1);
  }
  let providers;
  try { providers = loadProviders(cfg, configPath); }
  catch (error) {
    console.error(`导入失败：${error.message}`);
    process.exit(1);
  }

  const gateways = providers.filter(b => b.auth && b.auth.type === 'gateway');
  if (gateways.length === 0) {
    console.error(`导入失败：${configPath} 里没有 auth.type=gateway 的后端，先加一个 gateway 条目`);
    process.exit(1);
  }
  const target = opts.backend
    ? gateways.find(b => b.name === opts.backend)
    : (gateways.length === 1 ? gateways[0] : null);
  if (!target) {
    const names = gateways.map(b => b.name).join(', ');
    console.error(opts.backend
      ? `导入失败：没有名为 "${opts.backend}" 的 gateway 后端（可选：${names}）`
      : `导入失败：有多个 gateway 后端（${names}），用 --backend <name> 指定`);
    process.exit(1);
  }

  const source = opts.from ? expandHome(opts.from) : codexConfigPath();
  const key = readGatewayKeyFromCodexConfig(source);
  if (!key) {
    console.error(`导入失败：${source} 里没有找到可用的 ${GATEWAY_HEADER}`);
    console.error('  这台机器大概率没配过 gateway：找用户 / gateway 平台要 key，填进 backends[].auth.key');
    process.exit(1);
  }

  const current = typeof target.auth.key === 'string' ? target.auth.key.trim() : '';
  if (current === key) {
    console.log(`无需导入：后端 "${target.name}" 的 key 已经和 ${source} 一致`);
    process.exit(0);
  }
  if (current && !isPlaceholderKey(current) && !opts.force) {
    console.error(`导入中止：后端 "${target.name}" 已有一把不同的 key，加 --force 才覆盖`);
    process.exit(1);
  }

  const destination = target._sourceFile || configPath;
  const document = target._sourceFile ? readJson(destination) : cfg;
  if (target._sourceFile) document.auth.key = key;
  else target.auth.key = key;
  fs.writeFileSync(destination, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(destination, 0o600);
  } catch (_) {
    /* 权限收紧失败不阻断导入 */
  }

  console.log(`已导入 gateway 凭据 → ${destination}`);
  console.log(`  来源: ${source}`);
  console.log(`  后端: ${target.name}`);
  console.log(`  key : ${key.slice(0, 5)}…（${key.length} 字符，明文未打印）`);
  console.log('  之后运行期只读这份配置，不会再回头读 Codex 配置');
  process.exit(0);
}

/**
 * 后端组合校验：全局官方目录需要可路由的 catch-all。
 *
 * 没有 catch-all 后端时：
 *   - 启用官方模型 → 致命。可使用订阅直连或兼容网关。
 *   - 只有带前缀的后端 → 提示。所有模型都必须带前缀路由，没有兜底后端。
 *
 * compaction 不在这份清单里：remote compaction v2 由 metabridge 本地合成
 * （synthesizeCompaction），压缩不依赖 gateway。
 */
function validateBackendCombination(cfg) {
  const enabled = cfg.backends.filter(b => b.enabled);
  if (enabled.some(b => !b.prefix)) return;

  const prefixed = enabled.filter(b => b.prefix);
  const officialEnabled = !cfg.officialModels || cfg.officialModels.enabled !== false;

  if (officialEnabled) {
    const disabledGateways = cfg.backends
      .filter(b => !b.enabled && b.auth && b.auth.type === 'gateway')
      .map(b => b.name);
    const lines = [
      '配置错误：officialModels.enabled=true 但没有可用的 catch-all 后端（订阅直连或兼容网关）',
    ];
    if (disabledGateways.length) {
      lines.push(`  gateway 后端 "${disabledGateways.join('", "')}" 因缺少 ${GATEWAY_HEADER} 已被禁用`);
    }
    lines.push(
      '  原因：官方模型需要订阅直连或兼容网关路由，不能隐式回退第三方后端',
      '  解决（二选一）：',
      '    A. 配置 codex-subscription catch-all，或提供兼容网关的凭据',
      '       gateway 网关可用 node server.js --import-gateway-key 导入凭据',
      '    B. 只用第三方模型：把 officialModels.enabled 设为 false'
    );
    console.error(lines.join('\n'));
    process.exit(1);
  }

  if (prefixed.length) {
    console.error([
      `警告：只有带前缀的后端（${prefixed.map(b => b.name).join(', ')}），没有 catch-all 后端`,
      `  所有模型都必须带前缀路由（${prefixed.map(b => b.prefix).join(', ')}），不带前缀的模型名会被拒绝`,
      '  上下文压缩不受影响：metabridge 本地合成 compaction，不需要 gateway 兜底',
    ].join('\n'));
  }
}

/**
 * 校验配置，规范化后端默认值。
 * 致命错误（零后端、未知策略）直接 exit(1)。
 */
function validateConfig(cfg) {
  if (!Array.isArray(cfg.backends) || cfg.backends.length === 0) {
    console.error('配置错误：backends 必须是非空数组');
    process.exit(1);
  }

  const seenNames = new Set();
  const seenPrefixes = new Set();
  let catchAllCount = 0;

  for (const b of cfg.backends) {
    // name 唯一性
    if (!b.name) {
      console.error('配置错误：每个后端必须有 name 字段');
      process.exit(1);
    }
    if (seenNames.has(b.name)) {
      console.error(`配置错误：后端 name "${b.name}" 重复`);
      process.exit(1);
    }
    seenNames.add(b.name);

    try {
      normalizeProviderConnection(b);
      normalizeProviderPolicy(b);
    }
    catch (error) {
      console.error(`配置错误：后端 "${b.name}"：${error.message}`);
      process.exit(1);
    }

    // 规范化默认值
    b.prefix ??= '';
    b.priority ??= 50;
    b.enabled = b.enabled !== false; // 默认 true
    b.passthroughHeaders = b.passthroughHeaders === true;
    b.sanitize = b.sanitize || null;
    b.reasoning = b.reasoning || 'full';
    try {
      if (typeof b.prefix !== 'string') throw new Error('prefix 必须是字符串');
      if (b.displayPrefix !== undefined && typeof b.displayPrefix !== 'string') {
        throw new Error('displayPrefix 必须是字符串，空字符串表示不显示前缀');
      }
      if (!Number.isSafeInteger(b.priority) || b.priority < 0) {
        throw new Error('priority 必须是非负整数，数值越小展示越靠前');
      }
      compileModelFilter(b);
      compileRouteModels(b);
      compileCompaction(b);
      compileReasoningRules(b);
      if (typeof b.reasoning === 'object') validateReasoningPolicy(b.reasoning);
      if (b.messagesModels !== undefined) {
        // Compile at startup; invalid matchers must never silently select a protocol.
        if (!Array.isArray(b.messagesModels)) throw new Error('messagesModels 必须是规则数组');
        b.messagesModels.forEach(compileMatcher);
      }
    } catch (error) {
      console.error(`配置错误：后端 "${b.name}"：${error.message}`);
      process.exit(1);
    }
    if (!['responses', 'command-code', 'codex-subscription'].includes(b.protocol)) {
      console.error(`配置错误：后端 "${b.name}" 的 protocol "${b.protocol}" 未知`);
      process.exit(1);
    }
    if (b.protocol === 'command-code' && !b.prefix) {
      console.error(`配置错误：Command Code 后端 "${b.name}" 必须配置非空 prefix（建议 cmd/）`);
      process.exit(1);
    }
    try {
      if (b.protocol === 'codex-subscription') validateSubscriptionBackend(b);
      const catalog = b.catalog || { source: 'remote' };
      if (!['remote', 'static', 'codex', 'none'].includes(catalog.source)) {
        throw new Error('catalog.source 必须是 remote/static/codex/none');
      }
      if (catalog.format !== undefined &&
          (catalog.source !== 'remote' || catalog.format !== 'codex' ||
           typeof catalog.clientVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(catalog.clientVersion))) {
        throw new Error('catalog.format=codex 需要 source=remote 和 clientVersion=x.y.z');
      }
      if (b.protocol === 'codex-subscription' && catalog.source === 'remote') {
        throw new Error('订阅目录需要 catalog.source=codex/static/none；不使用匿名远端 models 请求');
      }
      if (catalog.source === 'static' &&
          (!Array.isArray(catalog.models) ||
           catalog.models.some(m => !m || typeof m.id !== 'string' || !m.id.trim()) ||
           new Set(catalog.models.map(m => m.id)).size !== catalog.models.length)) {
        throw new Error('catalog.models 必须是无重复且含 id 的模型数组');
      }
    } catch (error) {
      console.error(`配置错误：后端 "${b.name}"：${error.message}`);
      process.exit(1);
    }

    // auth 校验
    if (!b.auth || !b.auth.type) {
      console.error(`配置错误：后端 "${b.name}" 缺少 auth.type`);
      process.exit(1);
    }
    if (!AUTH[b.auth.type]) {
      console.error(`配置错误：后端 "${b.name}" 的 auth.type "${b.auth.type}" 未知（支持：${Object.keys(AUTH).join(', ')}）`);
      process.exit(1);
    }
    if (b.auth.type === 'keyfile' && !b.auth.file) {
      console.error(`配置错误：后端 "${b.name}" 的 auth.type=keyfile 需要 file 字段`);
      process.exit(1);
    }
    if (b.auth.type === 'static' && b.enabled && !b.auth.key) {
      console.error(`配置错误：后端 "${b.name}" 的 auth.type=static 需要 key 字段`);
      process.exit(1);
    }
    // gateway 凭据只认显式 provider 配置，缺失或占位符则禁用
    if (b.auth.type === 'gateway') {
      const resolved = resolveGatewayKey(b.auth);
      b.auth.key = resolved.key;
      b.auth.keySource = resolved.source;
      if (!resolved.key) {
        const detail = resolved.placeholder
          ? 'auth.key 还是 config.example.json 里的占位符'
          : 'auth.key 为空';
        console.error([
          `警告：后端 "${b.name}" 没有可用的 ${GATEWAY_HEADER}（${detail}），已禁用`,
          '  凭据只从本机 provider 配置的 auth.key 读取，运行期不会去读 Codex 配置兜底',
          '  以前用过 gateway：node server.js --import-gateway-key （从 ~/.codex/config.toml 导入，不回显明文）',
          '  从零配置：找用户 / gateway 平台要 key 后填进对应 provider 的 auth.key',
        ].join('\n'));
        b.enabled = false;
      }
    }

    // sanitize 策略校验
    if (b.sanitize && !SANITIZERS[b.sanitize]) {
      console.error(`配置错误：后端 "${b.name}" 的 sanitize "${b.sanitize}" 未知（支持：${Object.keys(SANITIZERS).join(', ')}）`);
      process.exit(1);
    }

    // reasoning 策略校验
    if (typeof b.reasoning === 'string' && !REASONING[b.reasoning]) {
      console.error(`配置错误：后端 "${b.name}" 的 reasoning "${b.reasoning}" 未知（支持：${Object.keys(REASONING).join(', ')}）`);
      process.exit(1);
    }

    // prefix 检查
    if (b.prefix) {
      if (seenPrefixes.has(b.prefix)) {
        console.error(`警告：后端 "${b.name}" 的 prefix "${b.prefix}" 与之前的后端重复，先匹配的生效`);
      }
      seenPrefixes.add(b.prefix);
    } else if (b.routeModels === undefined) {
      catchAllCount++;
      if (catchAllCount > 1) {
        console.error(`警告：多个后端的 prefix 为空（catch-all），只有第一个生效`);
      }
    }
  }

  const enabledCount = cfg.backends.filter(b => b.enabled).length;
  if (enabledCount === 0) {
    console.error('配置错误：没有启用的后端（所有后端都被禁用）');
    process.exit(1);
  }

  for (const b of cfg.backends) {
    if (!b.webSearch) continue;
    const s = b.webSearch;
    const target = cfg.backends.find(candidate => candidate.name === s.backend);
    if (b.protocol !== 'command-code' || !target || !['responses', 'codex-subscription'].includes(target.protocol) ||
        target === b || !s.model || typeof s.model !== 'string' ||
        !isModelAllowed(target, s.model) || (b.enabled && !target.enabled)) {
      console.error(`配置错误：后端 "${b.name}" 的 webSearch 需要可用的 Responses 后端和允许的 model`);
      process.exit(1);
    }
    s.maxSearches ??= 3;
    s.timeoutMs ??= 60000;
    if (!Number.isInteger(s.maxSearches) || s.maxSearches < 1 || s.maxSearches > 8 ||
        !Number.isInteger(s.timeoutMs) || s.timeoutMs < 1000 || s.timeoutMs > 180000) {
      console.error(`配置错误：后端 "${b.name}" 的 webSearch.maxSearches 范围 1–8，timeoutMs 范围 1000–180000`);
      process.exit(1);
    }
  }
  validateBackendCombination(cfg);
}

function loadConfig() {
  const configPath = resolveConfigPath();
  let fileCfg;
  let backends;
  try {
    fileCfg = readJson(configPath);
    backends = loadProviders(fileCfg, configPath);
  } catch (error) {
    console.error(`配置错误：${error.message}`);
    process.exit(1);
  }

  const env = process.env;
  const cfg = {
    host: env.MB_HOST || fileCfg.host || '127.0.0.1',
    port: parseInt(env.MB_PORT || fileCfg.port || '8318', 10),
    catalogTtlMs: parseInt(env.MB_CATALOG_TTL_MS || fileCfg.catalogTtlMs || String(5 * 60 * 1000), 10),
    logLevel: env.MB_LOG_LEVEL || fileCfg.logLevel || 'info',
    // 压缩摘要请求是否剥掉图片。默认 false：摘要用的就是会话当前的模型，
    // 图片能进历史说明它收得下，剥掉只会让摘要丢掉截图信息。
    compactionStripImages: resolveBool(
      env.MB_COMPACTION_STRIP_IMAGES, fileCfg.compactionStripImages, false
    ),
    backends,
    // File providers own their catalog sources; retain the legacy global default
    // only for the existing inline format.
    officialModels: fileCfg.officialModels || { enabled: fileCfg.providerFiles === undefined },
    _configPath: configPath,
  };

  // 校验 + 规范化（AUTH/SANITIZERS/REASONING 注册表在下方定义，
  // 但函数声明会提升，所以这里可以引用）
  validateConfig(cfg);

  return cfg;
}

// ============ 常量 ============

// Codex 系统指令模板（base_instructions），每个 ModelInfo 条目必须携带
const BASE_INSTRUCTIONS = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'base_instructions.txt'), 'utf8');
  } catch (_) {
    return 'You are Codex, a helpful coding assistant.';
  }
})();

// 推理档位预设
const REASONING_PRESETS = {
  low: { effort: 'low', description: 'Fast responses with lighter reasoning' },
  medium: { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  high: { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  xhigh: { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  max: { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
  ultra: { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
};

// gateway 模型用全档位
const GATEWAY_REASONING = { levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'low' };

// 转发时需要跳过的 hop-by-hop 头
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'content-encoding', 'content-length', 'accept-encoding',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade',
]);

// 透传响应头时跳过的头
const SKIP_RESP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length',
]);

// ============ 策略注册表 ============

/**
 * 推理档位策略：根据后端类型和模型 ID 返回支持的档位列表。
 * 新策略只需在此注册，然后在后端配置中引用名称。
 */
const REASONING = {
  'command-code': (model, backend) => commandCodeReasoning(model, backend) || { levels: ['low'], default: 'low' },
  // 全档位（gateway 官方模型等）
  full: () => GATEWAY_REASONING,
  // 不支持推理档位
  none: () => ({ levels: ['low'], default: 'low' }),
};

/**
 * 请求体清理策略：转发前修改 payload。
 * 新策略只需在此注册，然后在后端配置中引用名称。
 */
const SANITIZERS = {
  /**
   * 清理 input 数组中 gateway 的 codex_passthrough 路由不接受的内容。
   *
   * 针对 Codex 核心问题（assign_missing_streamed_response_item_id 借用 ID）
   * 和 gateway 的 Zod schema 约束，case-by-case 处理：
   *
   * ID 处理：
   *   Case A: id 不以 rs_ 开头（fc_/call_ 等）→ 整个 item 移除
   *           原因：Codex 借用 bug 把 function_call 的 ID 赋给了 reasoning item。
   *           带非法 ID 的 reasoning item 会导致 gateway Zod 校验异常
   *           （content maxItems=0 报错）和模型无限思考循环，必须整个移除。
   *   Case B: id 以 rs_ 开头但 store=false → 移除 ID
   *           原因：gateway 在 store=false 时尝试按 id 查找已持久化 item，
   *           查不到报错（"Item with id 'rs_...' not found"）。
   *   Case C: id 以 rs_ 开头且 store 非 false → 保留（合法 ID，不动）。
   * 不需要清空 content：Codex 配置 name="OpenAI" 后 is_openai()=true，
   * Codex 保留 internal_chat_message_metadata_passthrough，gateway 走宽松校验。
   */
  gateway: (payload) => {
    if (!Array.isArray(payload.input)) return;
    const storeFalse = payload.store === false;
    let removedBorrowed = 0;
    let removedStoreId = 0;
    const kept = [];
    for (const item of payload.input) {
      if (!item || item.type !== 'reasoning') {
        kept.push(item);
        continue;
      }

      // Case A: 非 rs_ 前缀（fc_/call_ 等）→ 整个移除
      // Codex 借用 bug 产生的非法 ID，仅删 ID 留空壳会导致无限思考循环
      if (item.id && !item.id.startsWith('rs_')) {
        removedBorrowed++;
        continue;
      }

      // Case B: rs_ 前缀但 store=false → 移除 ID
      if (item.id && storeFalse) {
        delete item.id;
        removedStoreId++;
      }
      // Case C: rs_ 前缀且 store 非 false → 保留

      kept.push(item);
    }
    payload.input = kept;
    if (removedBorrowed > 0) {
      log(`sanitized ${removedBorrowed} borrowed reasoning item(s) removed (non-rs_ prefix)`);
    }
    if (removedStoreId > 0) {
      log(`sanitized ${removedStoreId} reasoning id(s) (store=false lookup prevention)`);
    }
  },
};

/**
 * 鉴权策略：返回转发到上游时的请求头。
 * 新策略只需在此注册，然后在后端配置中引用类型名。
 */
const AUTH = {
  // 从文件读取后端 Bearer token
  keyfile: (auth) => {
    const key = readKeyFile(auth.file);
    return key ? { authorization: `Bearer ${key}` } : {};
  },
  // gateway 专用：x-api-key（入站请求头通过 passthroughHeaders 透传）
  gateway: (auth) => {
    return auth.key ? { 'x-api-key': auth.key } : {};
  },
  // 静态 API key
  static: (auth) => ({
    [(auth.header || 'authorization').toLowerCase()]: `${auth.scheme || 'Bearer'} ${auth.key}`,
  }),
  // 无鉴权
  none: () => ({}),
};

/**
 * 组合后端的鉴权头：passthroughHeaders（可选）+ AUTH 策略。
 * req 为 null 时（目录拉取）跳过 passthroughHeaders。
 */
function buildAuthHeaders(backend, req) {
  if (backend.protocol === 'codex-subscription') return subscriptionHeaders(req?.headers);
  const h = (backend.passthroughHeaders && req) ? forwardableHeaders(req) : {};
  // Normalize casing so configured credentials override any incoming variants.
  for (const [name, value] of Object.entries(backend.http_headers || {})) h[name.toLowerCase()] = value;
  Object.assign(h, AUTH[backend.auth.type](backend.auth, req));
  return h;
}

/**
 * 解析后端的推理档位策略。
 * 字符串 → 查注册表；对象 → 直接使用；未配置 → 默认 full。
 */
function resolveReasoning(backend, modelId) {
  const configured = reasoningForModel(backend, modelId);
  if (configured) return configured;
  const r = backend.reasoning;
  if (!r) return GATEWAY_REASONING;
  if (typeof r === 'string') {
    const fn = REASONING[r];
    if (!fn) return GATEWAY_REASONING;
    return fn(modelId, backend);
  }
  return r; // 内联 { levels, default }
}

// ============ 日志 ============

function log(...args) {
  if (CFG.logLevel === 'silent') return;
  console.log(new Date().toISOString(), ...args);
}
function logError(...args) {
  if (CFG.logLevel === 'silent' || CFG.logLevel === 'error') return;
  console.error(new Date().toISOString(), '[ERROR]', ...args);
}

// ============ 上游凭证 ============

function readKeyFile(filePath) {
  try {
    return fs.readFileSync(expandHome(filePath), 'utf8').trim();
  } catch (_) {
    return null;
  }
}

// ============ 官方模型 ============

// 官方模型缓存：从 codex CLI 内置目录动态获取，不写死
let officialModelsCache = { at: 0, models: [] };
const OFFICIAL_TTL_MS = 60 * 60 * 1000; // 1 小时刷新一次

/**
 * 从 codex CLI 内置目录动态获取官方模型列表。
 * `codex debug models -c model_provider=openai` 输出内置的官方模型目录，
 * 不依赖外部 API，codex 升级后列表自动更新。
 */
async function fetchOfficialModels() {
  if (Date.now() - officialModelsCache.at < OFFICIAL_TTL_MS && officialModelsCache.models.length) {
    return officialModelsCache.models;
  }
  try {
    // 使用 --bundled 获取 Codex 内置的官方模型目录（随二进制发布）。
    // 不用 -c model_provider=openai 是因为它会走 provider 的 /v1/models，
    // 而 metabridge 自身就是 provider，会返回合并后的目录（含其他后端模型），
    // 不是纯官方列表。
    const { stdout } = await execFileAsync(
      'codex',
      ['debug', 'models', '--bundled'],
      {
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
      }
    );
    const parsed = JSON.parse(stdout);
    const models = (parsed.models || [])
      .filter((m) => m.slug && !m.slug.includes('/'))
      .map((m) => ({
        id: m.slug,
        context_window: m.context_window || m.max_context_window || null,
        priority: m.priority || 50,
        display_name: m.display_name || m.slug,
      }));
    if (models.length) {
      officialModelsCache = { at: Date.now(), models };
      log(`official models from codex CLI: ${models.length} models (${models.map((m) => m.id).join(', ')})`);
    }
    return models;
  } catch (e) {
    logError('failed to fetch official models from codex CLI:', e.message);
    return officialModelsCache.models; // 返回旧缓存（可能为空）
  }
}

// ============ ModelInfo 构造 ============

/**
 * 构造 codex models-manager 要求的完整 ModelInfo 条目。
 * 缺 required 字段会导致反序列化失败，所以这里把它们都填上。
 *
 * 有意不发 effective_context_window_percent：窗口和压缩时机完全交给 Codex 自己的
 * 默认行为（实测省略该字段时 Codex 填 95，与官方模型一致）。bridge 只把上游报的
 * context_window 原样透出，不做任何压制。
 */
function modelDisplayName(backend, model) {
  const label = backend.displayPrefix ?? backend.prefix.replace(/\/+$/, '');
  const name = model.display_name || model.id;
  return label ? `${label} · ${name}` : name;
}

function buildModelInfo(slug, displayName, contextWindow, reasoning, priority) {
  const levels = reasoning.levels.map((l) => REASONING_PRESETS[l]).filter(Boolean);
  return {
    slug,
    display_name: displayName,
    description: null,
    default_reasoning_level: reasoning.default,
    supported_reasoning_levels: levels,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: priority ?? 50,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: BASE_INSTRUCTIONS,
    include_skills_usage_instructions: false,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: contextWindow || null,
    max_context_window: contextWindow || null,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: false,
    use_responses_lite: false,
  };
}

// ============ 模型目录合并 ============

function providerPolicyStatus(backend) {
  return {
    via: backend.via || 'legacy-unspecified',
    requestMode: backend.requestMode,
    compaction: backend.compaction || {
      mode: backend.prefix && backend.requestMode !== 'passthrough' &&
        backend.protocol !== 'codex-subscription' ? 'local' : 'passthrough',
      legacy: true,
    },
  };
}

let catalogCache = {
  at: 0,
  merged: { models: [], data: [] },
  backends: {},   // name → { ok, base, prefix, models, error }
  official: { ok: false, count: 0, error: null },
  lastError: null,
};

async function fetchModels(backend, headers) {
  let url = providerApiUrl(backend, '/v1/models');
  if (backend.catalog?.format === 'codex') {
    url += `?client_version=${encodeURIComponent(backend.catalog.clientVersion)}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const json = await res.json();
  if (backend.catalog?.format === 'codex') {
    if (!Array.isArray(json.models)) throw new Error('Codex 上游目录缺少 models 数组');
    return json.models.map(info => {
      if (!info || typeof info.slug !== 'string' || !info.slug) throw new Error('Codex 上游目录包含无效 slug');
      const model = { id: info.slug, display_name: info.display_name,
        context_window: info.context_window, max_context_window: info.max_context_window };
      Object.defineProperty(model, '_codexInfo', { value: info });
      return model;
    });
  }
  return Array.isArray(json.data) ? json.data : [];
}

async function fetchBackendModels(backend) {
  const source = backend.catalog?.source || 'remote';
  if (source === 'static') return backend.catalog.models;
  if (source === 'none') return [];
  if (source === 'codex') {
    const models = await fetchOfficialModels();
    if (!models.length) throw new Error('Codex 内置目录为空或获取失败');
    return models;
  }
  return fetchModels(backend, buildAuthHeaders(backend, null));
}

// 从上游 OpenAI 格式的模型条目里提取上下文窗口大小
function ctxOf(m) {
  return m.context_window || m.max_context_window || m.context_length || m.max_tokens || null;
}

async function refreshCatalog() {
  const active = CFG.backends.filter((b) => b.enabled);
  const results = await Promise.allSettled(
    active.map((b) =>
      fetchBackendModels(b)
        .then((models) => ({ backend: b, models }))
    )
  );

  const allModels = [];
  const allData = [];
  const backendStatus = {};
  const errors = [];

  for (let i = 0; i < active.length; i++) {
    const b = active[i];
    const result = results[i];
    if (result.status === 'fulfilled') {
      const models = result.value.models.filter(m => isModelAllowed(b, m.id) &&
        route(b.prefix ? `${b.prefix}${m.id}` : m.id).backend === b);
      backendStatus[b.name] = {
        ok: true,
        base: b.base,
        ...providerPolicyStatus(b),
        prefix: b.prefix || (b.routeModels ? '(model rules)' : '(catch-all)'),
        models: models.length,
        error: null,
      };
      // 构造 ModelInfo 条目
      const infos = models.map((m) => {
        const slug = b.prefix ? `${b.prefix}${m.id}` : m.id;
        if (m._codexInfo) return { ...m._codexInfo, slug,
          display_name: modelDisplayName(b, m), priority: b.priority };
        return buildModelInfo(slug, modelDisplayName(b, m), ctxOf(m), resolveReasoning(b, m.id), b.priority);
      });
      allModels.push(...infos);
      // OpenAI 标准 data 数组
      allData.push(...models.map((m) => ({
        ...m,
        id: b.prefix ? `${b.prefix}${m.id}` : m.id,
        display_name: modelDisplayName(b, m),
        priority: b.priority,
        owned_by: m.owned_by ? `${b.name}:${m.owned_by}` : b.name,
      })));
    } else {
      const msg = result.reason && result.reason.message;
      backendStatus[b.name] = {
        ok: false,
        base: b.base,
        ...providerPolicyStatus(b),
        prefix: b.prefix || (b.routeModels ? '(model rules)' : '(catch-all)'),
        models: 0,
        error: msg,
      };
      errors.push(`${b.name}: ${msg}`);
    }
  }

  // 禁用的后端也出现在健康状态中
  for (const b of CFG.backends) {
    if (!b.enabled) {
      backendStatus[b.name] = {
        ok: false,
        base: b.base,
        ...providerPolicyStatus(b),
        prefix: b.prefix || (b.routeModels ? '(model rules)' : '(catch-all)'),
        models: 0,
        error: 'disabled',
      };
    }
  }

  // 官方模型（可选）
  let officialStatus = { ok: false, count: 0, error: null };
  if (CFG.officialModels && CFG.officialModels.enabled) {
    try {
      const target = CFG.backends.find(b => b.enabled && !b.prefix);
      const official = (await fetchOfficialModels()).filter(m => isModelAllowed(target, m.id));
      const officialInfos = official.map((m) =>
        buildModelInfo(m.id, modelDisplayName(target, m), m.context_window, resolveReasoning(target, m.id), target.priority)
      );
      allModels.unshift(...officialInfos.filter(m => !allModels.some(existing => existing.slug === m.slug)));
      allData.push(...official.filter(m => !allData.some(existing => existing.id === m.id))
        .map((m) => ({ id: m.id, object: 'model', owned_by: 'openai',
          display_name: modelDisplayName(target, m), priority: target.priority })));
      officialStatus = { ok: true, count: official.length, error: null };
    } catch (e) {
      officialStatus = { ok: false, count: 0, error: e.message };
      errors.push(`official: ${e.message}`);
    }
  }

  // 按 priority 稳定排序（数值小排前面）
  allModels.sort((a, b) => a.priority - b.priority);
  allData.sort((a, b) => a.priority - b.priority);

  catalogCache = {
    at: Date.now(),
    merged: { models: allModels, data: allData },
    backends: backendStatus,
    official: officialStatus,
    lastError: errors.length ? errors.join('; ') : null,
  };

  const activeNames = active.map((b) => b.name).join(', ');
  log(
    `catalog refreshed: ${allModels.length} models from [${activeNames}]` +
    (officialStatus.count > 0 ? ` + ${officialStatus.count} official` : '') +
    (catalogCache.lastError ? ` (degraded: ${catalogCache.lastError})` : '')
  );
  return catalogCache;
}

async function getCatalog() {
  if (Date.now() - catalogCache.at > CFG.catalogTtlMs) {
    try {
      await refreshCatalog();
    } catch (e) {
      logError('catalog refresh failed, serving stale:', e.message);
    }
  }
  return catalogCache;
}

// ============ 路由 ============

/**
 * 按模型名前缀匹配后端。
 * Prefix rules precede routeModels; only unrestricted empty prefixes are catch-alls.
 */
function route(model) {
  for (const b of CFG.backends) {
    if (b.enabled && b.prefix && typeof model === 'string' && model.startsWith(b.prefix)) {
      return { backend: b, upstreamModel: model.slice(b.prefix.length) };
    }
  }
  const matched = CFG.backends.find(b => b.enabled && matchesRoute(b, model));
  if (matched) return { backend: matched, upstreamModel: model };
  const fallback = CFG.backends.find((b) => b.enabled && !b.prefix && b.routeModels === undefined);
  if (fallback) return { backend: fallback, upstreamModel: model };
  return { backend: null, prefixes: CFG.backends.map((b) => b.prefix).filter(Boolean) };
}

// ============ HTTP 工具 ============

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 解压请求体（codex 直连 gateway 时会用 zstd 压缩）
function decompressBody(buf, encoding) {
  if (!encoding || encoding === 'identity') return buf;
  switch (encoding.toLowerCase()) {
    case 'zstd': return zlib.zstdDecompressSync(buf);
    case 'gzip': return zlib.gunzipSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    case 'br': return zlib.brotliDecompressSync(buf);
    default: throw new Error(`不支持的 content-encoding: ${encoding}`);
  }
}

/**
 * 收集入站请求的所有可转发头。
 * gateway 依赖 codex 专有头（originator、x-codex-*、session-id 等）
 * 来识别 codex_passthrough 路由，丢掉这些头会导致官方模型 404。
 */
function forwardableHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
  }
  return out;
}

function safeResponseHeaders(upstream) {
  const out = {};
  upstream.headers.forEach((v, k) => {
    if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

// 工具名兼容层：>64 字符的 MCP 工具名请求侧改别名、响应侧还原，见 tool-names.js。

/**
 * 把解析后的 payload 转发到上游，并把响应（含 SSE 流）透传回客户端。
 * headers 由调用方通过 buildAuthHeaders(backend, req) 预构建。
 * respRewriter 可选：对响应体（SSE 事件或 JSON）做工具名别名还原。
 */
async function forward(res, backend, headers, pathname, payload, accept, respRewriter, clientHeaders = {}) {
  const base = backend.base;
  const t0 = Date.now();
  let upstream;
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.once('close', onClose);
  if (backend.protocol === 'command-code') {
    if (pathname !== '/v1/responses') {
      res.off('close', onClose);
      return sendJson(res, 400, { error: { type: 'unsupported_endpoint', message: 'Command Code 适配后端请使用 /v1/responses' } });
    }
  }
  try {
    upstream = backend.protocol === 'command-code'
      ? await forwardCommandRequest(backend, headers, payload, clientHeaders, abort.signal)
      : await fetchNative(backend, headers, pathname, payload, { signal: abort.signal, accept });
  } catch (e) {
    res.off('close', onClose);
    if (res.destroyed) return;
    logError(`backend ${backend.name} (${base}) request failed:`, e.message);
    return sendJson(res, e.status || 502, {
      error: { message: `后端 ${backend.name} (${base})：${e.message}`,
        type: e.status === 401 ? 'unauthorized' : e.status === 400 ? 'invalid_request_error' : 'bad_gateway' },
    });
  }
  log(`forward ${backend.name} ${base}${pathname} -> ${upstream.status} ct=${upstream.headers.get('content-type')} (${Date.now() - t0}ms)`);

  res.writeHead(upstream.status, safeResponseHeaders(upstream));
  res.flushHeaders && res.flushHeaders();

  if (!upstream.body) {
    res.off('close', onClose);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (respRewriter) return res.end(respRewriter(buf.toString('utf8')));
    return res.end(buf);
  }

  // SSE / 流式透传：无改写器时逐块写入；有改写器时按事件边界缓冲，
  // 防止别名被 TCP 分包截断
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  let chunks = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      if (!respRewriter) {
        res.write(Buffer.from(value));
        continue;
      }
      sseBuf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
        const ev = sseBuf.slice(0, idx + 2);
        sseBuf = sseBuf.slice(idx + 2);
        res.write(respRewriter(ev));
      }
    }
    if (respRewriter && sseBuf) {
      res.write(respRewriter(sseBuf));
    }
  } catch (e) {
    logError('stream pipe interrupted:', e.message);
  } finally {
    res.off('close', onClose);
    log(`forward done: ${chunks} chunks (${Date.now() - t0}ms)`);
    res.end();
  }
}

function fetchNative(backend, headers, pathname, payload, { signal, accept } = {}) {
  if (backend.protocol === 'codex-subscription') {
    return subscriptionFetch(backend, headers, pathname, payload, { signal });
  }
  return fetch(providerApiUrl(backend, pathname), {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: accept || '*/*',
    },
    body: JSON.stringify(payload),
    signal,
  });
}

function forwardCommandRequest(backend, headers, payload, clientHeaders, signal) {
  if (!backend.webSearch || !hasHostedSearch(payload)) {
    return commandFetch(backend, headers, payload, { signal });
  }
  const settings = backend.webSearch;
  const target = CFG.backends.find(b => b.name === settings.backend && b.enabled);
  if (!target) throw new Error(`搜索后端 "${settings.backend}" 不可用`);
  // Use inbound Codex auth, NOT the outbound Command Code API key.
  const searchHeaders = {};
  if (target.protocol === 'codex-subscription') {
    Object.assign(searchHeaders, subscriptionHeaders(clientHeaders));
  } else if (target.auth.type === 'gateway' || target.passthroughHeaders) {
    // Preserve legacy gateway search auth, but don't leak OAuth to ordinary
    // third-party search targets that did not opt into header passthrough.
    for (const name of ['authorization', 'chatgpt-account-id', 'originator', 'user-agent']) {
      if (clientHeaders[name]) searchHeaders[name] = clientHeaders[name];
    }
  }
  Object.assign(searchHeaders, buildAuthHeaders(target, null));
  return commandSearchFetch(backend, headers, payload, {
    signal,
    search: {
      ...settings, base: target.base, headers: searchHeaders,
      request: (body, options) => fetchNative(target, searchHeaders, '/v1/responses', body, options),
      onUsage: ({ model, usage }) => log(`web search helper ${target.name}/${model} usage=${JSON.stringify(usage || {})}`),
    },
  });
}

// ============ Compaction 本地合成 ============

/** SSE 事件帧。data 里保留 type 字段，和官方 Responses API 的线格式一致。 */
function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

/**
 * 压缩轮次可能跑很久（整段历史），期间必须有字节流动来重置 Codex 的空闲计时器。
 * MB_COMPACTION_HEARTBEAT_MS 可调（客户端空闲超时不同，测试也用它压缩等待时间）。
 */
const COMPACTION_HEARTBEAT_MS = parseInt(process.env.MB_COMPACTION_HEARTBEAT_MS || '2000', 10);

/**
 * 本地合成 remote compaction v2。
 *
 * 不支持原生压缩的后端不认识 Codex 私有的 compaction_trigger，也产不出
 * compaction item。所以这里把压缩轮次改写成一次普通摘要请求发给**同一个后端的
 * 同一个模型**，再把摘要包成 mb-cmp1 信封，合成恰好一条 compaction item 返回。
 *
 * 于是：Codex 看到的是标准 remote compaction v2；后端看到的是一次普通对话；
 * 压缩不再需要 gateway 兜底，也不再需要另找一个多模态大窗口模型。
 *
 * 完成度守卫在 compaction.js 里：只有真正 completed 且未截断的轮次才产出摘要，
 * 否则报错——半截摘要一旦被 Codex 当作替换历史装上去，这段会话就永久丢了。
 */
async function synthesizeCompaction(res, req, backend, payload, policy = null) {
  const t0 = Date.now();
  const stripImages = policy ? policy.stripImages === true : CFG.compactionStripImages;
  const summarization = buildSummarizationPayload(payload, {
    stripImages,
  });
  if (backend.sanitize && SANITIZERS[backend.sanitize]) {
    SANITIZERS[backend.sanitize](summarization);
  }

  const streaming = payload.stream === true;
  const responseId = newResponseId();
  let heartbeat = null;

  // 客户端可能中途取消（Codex 里按 Esc）。取消后继续往已销毁的响应写会触发
  // 无人监听的 error 事件，直接把进程带走；同时上游那次摘要请求也该停掉，别白烧额度。
  const abort = new AbortController();
  let clientGone = false;
  const onClientClose = () => {
    clientGone = true;
    if (heartbeat) clearInterval(heartbeat);
    abort.abort();
  };
  res.on('close', onClientClose);

  const write = (chunk) => {
    if (clientGone || res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch (e) {
      clientGone = true;
      logError('compaction 响应写入失败:', e.message);
    }
  };

  // 流式客户端：先把头和 response.created 发出去，再开心跳，然后才去等上游。
  if (streaming) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders && res.flushHeaders();
    write(sseEvent('response.created', {
      response: buildCompactionResponse({
        id: responseId,
        model: payload.model,
        item: null,
        status: 'in_progress',
      }),
    }));
    heartbeat = setInterval(() => {
      write(sseEvent('response.heartbeat', {}));
    }, COMPACTION_HEARTBEAT_MS);
  }

  const fail = (status, error) => {
    if (clientGone) return;
    if (!streaming) return sendJson(res, status, { error });
    write(sseEvent('response.failed', {
      response: {
        ...buildCompactionResponse({
          id: responseId,
          model: payload.model,
          item: null,
          status: 'failed',
        }),
        error,
      },
    }));
    res.end();
  };

  try {
    log(
      `compaction 本地合成 → ${backend.name} model=${summarization.model}` +
      (stripImages ? '（仅摘要请求剥离图片，并用占位文本替代）' : '')
    );

    let upstream;
    try {
      upstream = backend.protocol === 'command-code'
        ? await commandFetch(backend, buildAuthHeaders(backend, req), summarization, { signal: abort.signal })
        : await fetch(providerApiUrl(backend, '/v1/responses'), {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(backend, req),
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify(summarization),
        signal: abort.signal,
      });
    } catch (e) {
      if (clientGone) {
        log(`compaction 被客户端取消（${Date.now() - t0}ms），上游请求已中止`);
        return;
      }
      logError(`compaction 上游 ${backend.name} 不可达:`, e.message);
      return fail(502, {
        type: 'compaction_upstream_unreachable',
        message: `压缩轮次的后端 ${backend.name} (${backend.base}) 不可达：${e.message}`,
      });
    }

    let bodyText;
    try {
      bodyText = await upstream.text();
    } catch (e) {
      if (clientGone) {
        log(`compaction 被客户端取消（${Date.now() - t0}ms），上游响应已丢弃`);
        return;
      }
      logError(`compaction 读取上游响应失败:`, e.message);
      return fail(502, {
        type: 'compaction_upstream_error',
        message: `读取压缩轮次的上游响应失败：${e.message}`,
      });
    }
    if (clientGone) {
      log(`compaction 被客户端取消（${Date.now() - t0}ms），不再回写`);
      return;
    }

    if (!upstream.ok) {
      logError(`compaction 上游 ${backend.name} 返回 ${upstream.status}: ${bodyText.slice(0, 500)}`);
      return fail(502, {
        type: 'compaction_upstream_error',
        message: `压缩轮次的后端 ${backend.name} 返回 ${upstream.status}：${bodyText.slice(0, 500)}`,
      });
    }

    const isSse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
    let result;
    if (isSse) {
      result = summaryFromSse(bodyText);
    } else {
      try {
        result = summaryFromResponsesJson(JSON.parse(bodyText || '{}'));
      } catch (e) {
        result = {
          ok: false,
          error: { type: 'invalid_response_error', message: `压缩轮次的上游响应不是合法 JSON：${e.message}` },
        };
      }
    }

    if (!result.ok) {
      logError(`compaction 合成失败（${result.error.type}）：${result.error.message}`);
      return fail(502, result.error);
    }

    const item = buildCompactionItem(result.summary);
    const response = buildCompactionResponse({
      id: responseId,
      model: payload.model,
      item,
      usage: result.usage,
    });
    log(
      `compaction 合成完成 ${item.id}（摘要 ${result.summary.length} 字符，` +
      `${backend.name}/${summarization.model}，${Date.now() - t0}ms）`
    );

    if (!streaming) return sendJson(res, 200, response);
    write(sseEvent('response.output_item.done', { output_index: 0, item }));
    write(sseEvent('response.completed', { response }));
    res.end();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    res.off('close', onClientClose);
  }
}

// ============ HTTP 服务 ============

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 健康检查
  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/')) {
    const cat = await getCatalog();
    return sendJson(res, 200, {
      ok: true,
      service: 'metabridge',
      backends: cat.backends,
      officialModels: cat.official,
      models: cat.merged.models.length,
      degraded: cat.lastError || undefined,
    });
  }

  // 模型列表（所有后端目录的并集）
  if (req.method === 'GET' && pathname === '/v1/models') {
    const cat = await getCatalog();
    return sendJson(res, 200, cat.merged);
  }

  // Responses / Chat Completions：按 model 前缀路由
  if (req.method === 'POST' && ['/v1/responses', '/v1/responses/compact', '/v1/chat/completions'].includes(pathname)) {
    let payload;
    try {
      const raw = await readBody(req);
      const encoding = (req.headers['content-encoding'] || '').toLowerCase();
      const bodyBuf = decompressBody(raw, encoding);
      payload = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};
    } catch (e) {
      return sendJson(res, 400, { error: { message: `请求体不是合法 JSON：${e.message}`, type: 'bad_request' } });
    }

    const r = route(payload.model);
    if (!r.backend) {
      return sendJson(res, 400, {
        error: {
          message: `没有匹配的后端处理模型 "${payload.model}"（可用前缀：${r.prefixes.join(', ') || '无'}）`,
          type: 'no_route',
        },
      });
    }

    payload.model = r.upstreamModel;

    const backend = r.backend;
    // Enforce before compaction/forwarding; never fall back to another backend.
    if (!isModelAllowed(backend, payload.model)) {
      return sendJson(res, 403, {
        error: {
          type: 'model_not_allowed',
          message: `后端 "${backend.name}" 不允许调用模型 "${payload.model}"`,
        },
      });
    }

    // Compaction 生成：后端不认识 compaction_trigger，压缩由 metabridge 本地合成。
    // 必须在物化之前判定——物化会把 trigger 一起丢掉。
    // A narrow per-model exception does not enable any other legacy adaptations
    // on a passthrough CPA route. Official subscription never takes this path.
    const compactionPolicy = compactionForModel(backend, payload.model);
    const localCompaction = usesLocalCompaction(backend, payload.model);
    const compactionTurn = pathname === '/v1/responses' && localCompaction &&
      hasCompactionTrigger(payload.input);

    // Compaction 回放：默认 catch-all 原样转发；仅匹配显式策略或旧适配后端时物化。
    // 使用最新 mb-cmp1/sr-cmp1 checkpoint 替换整个旧窗口：
    //   [旧历史..., compaction, 新输入...] → [assistant checkpoint, 新输入...]
    // checkpoint 绝不能是 user/system；旧 user query 也不能继续保留。
    if (pathname === '/v1/responses' && Array.isArray(payload.input) && localCompaction) {
      const materialized = materializeLatestCompaction(payload.input);
      if (!materialized.ok) {
        return sendJson(res, 400, { error: materialized.error });
      }
      if (materialized.compacted) {
        payload.input = materialized.input;
        log(
          `compaction ${materialized.compactionId || '(no id)'} 物化为历史 assistant checkpoint` +
          ` → ${backend.name}（丢弃旧 item ${materialized.droppedItems} 个，保留新 item ${materialized.retainedItems} 个）`
        );
      }
    }

    // 本地合成走独立链路：它要读上游响应体，不能用 forward() 的裸透传。
    if (compactionTurn) {
      return synthesizeCompaction(res, req, backend, payload, compactionPolicy);
    }

    // 构建转发头（含 passthroughHeaders + auth）
    const headers = buildAuthHeaders(backend, req);

    // 应用 sanitize 策略
    if (backend.sanitize && SANITIZERS[backend.sanitize]) {
      SANITIZERS[backend.sanitize](payload);
    }

    log(`${backend.name} ← ${pathname} model=${payload.model}`);

    // 工具名兼容层：>64 字符的 MCP 工具名在请求侧改别名、响应侧还原。
    // 设 METABRIDGE_DISABLE_TOOL_REWRITE=1 可关闭。
    let respRewriter = null;
    if (backend.protocol !== 'codex-subscription' && backend.requestMode !== 'passthrough' && process.env.METABRIDGE_DISABLE_TOOL_REWRITE !== '1') {
      const { fwd, rev } = buildAliasMap(payload.tools);
      if (fwd.size) {
        rewriteRequestPayload(payload, fwd);
        respRewriter = makeRespRewriter(rev);
      }
    }
    return forward(res, backend, headers, pathname, payload, req.headers.accept, respRewriter, req.headers);
  }

  // 其他路径
  sendJson(res, 404, { error: { message: `不支持的路径：${req.method} ${pathname}`, type: 'not_found' } });
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/**
 * 查谁占着这个端口，用于 EADDRINUSE 的报错。
 * 拿不到就返回 null——识别不出占用者不该阻碍报错本身。
 */
async function findPortHolder(port) {
  let pid = null;
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp']);
    for (const line of stdout.split('\n')) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      const m = line.match(/pid=(\d+)/);
      if (m) { pid = m[1]; break; }
    }
  } catch {
    return null; // 没有 ss 或不可用
  }
  if (!pid) return null;

  let cmd = null;
  try {
    cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').replace(/\0/g, ' ');
  } catch {
    /* 读不到命令行不影响给出 pid */
  }
  return { pid, cmd };
}

// ============ 启动 ============

// 凭据导入模式：把 gateway key 从外部来源搬进 metabridge 自己的配置。
// 必须排在 loadConfig() 之前——缺 key 时 loadConfig 会直接 exit(1)，
// 那正是最需要跑这个命令的时候。
if (process.argv.includes('--import-gateway-key')) {
  runImportGatewayKey(process.argv.slice(2));
}

const CFG = loadConfig();

async function main() {
  log(`codex-metabridge 启动中，监听 ${CFG.host}:${CFG.port}`);
  log(`  配置文件: ${CFG._configPath}`);

  for (const b of CFG.backends) {
    const status = b.enabled ? 'enabled' : 'disabled';
    const prefix = b.prefix ? `"${b.prefix}"` : b.routeModels ? '(model rules)' : '(catch-all)';
    // 只打 key 的来源，绝不打 key 本身
    const keySource = b.auth.keySource ? `(key:${b.auth.keySource})` : '';
    log(`  backend ${b.name}: ${b.base} prefix=${prefix} auth=${b.auth.type}${keySource} priority=${b.priority} [${status}]`);
  }

  // listen 失败必须给出可执行的报错：裸栈回溯（Unhandled 'error' event）里读不出
  // "谁占着端口、Codex 现在连的是谁、下一步做什么"，而这三件事才是真正需要知道的。
  server.on('error', async (e) => {
    if (e && e.code === 'EADDRINUSE') {
      const holder = await findPortHolder(CFG.port);
      console.error([
        `配置错误：端口 ${CFG.host}:${CFG.port} 已被占用，metabridge 未能启动`,
        holder
          ? `  占用者：pid=${holder.pid}${holder.cmd ? ` ${holder.cmd}` : ''}`
          : `  占用者：未能识别，手动查：ss -tlnp | grep ':${CFG.port}'`,
        '  很可能是上一个 metabridge 实例还在跑——注意此时 Codex 连的仍是那个旧实例，',
        '  你刚做的改动不会生效（旧实例照常返回模型列表，不会报任何错）。',
        '  处理（二选一）：',
        holder
          ? `    A. 杀掉占用者再重启：kill ${holder.pid} && systemctl --user restart metabridge`
          : '    A. 杀掉占用者再重启：kill <pid> && systemctl --user restart metabridge',
        '    B. 换端口：改 config.json 的 port，同步 ~/.codex/config.toml 的 base_url，',
        '       然后杀掉 codex app-server 并删除 ~/.codex/models_cache.json',
      ].join('\n'));
    } else {
      console.error(`启动失败：监听 ${CFG.host}:${CFG.port} 出错：${e && e.message ? e.message : e}`);
    }
    process.exit(1);
  });

  server.listen(CFG.port, CFG.host, async () => {
    log(`已就绪: http://${CFG.host}:${CFG.port}`);
    try {
      await refreshCatalog();
    } catch (e) {
      logError('首次目录拉取失败:', e.message);
    }
    // 定期刷新目录
    setInterval(() => {
      refreshCatalog().catch((e) => logError('定时目录刷新失败:', e.message));
    }, CFG.catalogTtlMs).unref();
  });
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
