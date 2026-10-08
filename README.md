# codex-metabridge

支持 provider 原生直连或经 CPA 接入的本地路由与兼容层。
每个 provider 独立声明链路、请求处理和压缩策略；CPA 插件与管理页扩展是可选外挂。
当前混合部署示例使用 `config/bridge/config.hybrid.example.json`，历史厂商直连适配器仅供旧配置兼容。

## Provider 链路与处理策略

| 配置 | 可选值 | 含义 |
| --- | --- | --- |
| `via` | `direct` / `cpa` | 直连上游 / 连接 CPA；`base_url` 指向对应服务，不自动部署 CPA |
| `requestMode` | `passthrough` / `adapt` | 普通请求透传 / 旧兼容适配；新链路默认透传 |
| `compaction.mode` | `passthrough` / `local` | 压缩交给上游 / metabridge 调用同模型总结并合成、回放检查点 |

链路与压缩策略互不绑定：直连或经 CPA 都可以启用本地压缩。
官方订阅只能直连、透传；原生支持压缩的 gateway 也应透传。
只支持普通推理的 API 可以启用 `local`，不需要厂商专属代码。
`compaction.models` 省略表示整个 provider 使用本地压缩；提供非空精确 ID/正则规则
则只处理匹配模型，其余透传。规则匹配去除 bridge 路由前缀后的上游模型 ID。
设置 `via` 的新配置不再因模型前缀自动启用压缩；未迁移的旧配置保留兼容行为。
`/healthz` 会显示每个 provider 的链路、请求模式和压缩策略。

模板：

- 官方直连：`config/providers/openai-subscription.hybrid.example.json`
- 普通 API / gateway 直连透传：`config/providers/responses.example.json` / `config/providers/gateway.example.json`
- 普通 API 直连、本地压缩：`config/providers/responses-local-compaction.example.json`
- CPA 接入、按模型本地压缩：`config/providers/cpa.example.json`

`config/bridge/config.mixed.example.json` 展示官方直连 + gateway 直连 + CPA 兜底同时存在。
复制对应模板到私有配置目录并填写地址/凭据；gateway 模板默认禁用，确认后再启用。
若 CPA 也暴露 `gateway/*`，直连 gateway 的前缀路由优先，CPA 同名条目不会重复展示。

本地压缩兼容当前 Codex 在 `/v1/responses` 中发送 `compaction_trigger` 的流程；
不是解密官方检查点，也不是自动探测上游能力。已有 `mb-cmp1` 会话仍需对应回放策略。

## 代码、插件与配置的边界

| 层 | 仓库位置 | 职责 |
| --- | --- | --- |
| bridge 编排与通用核心 | `src/bridge/`、`src/core/`、`src/catalog/` | 合并模型目录、路由、配置策略，以及显式配置的本地压缩兼容 |
| 上游适配器 | `src/adapters/openai/`、`command-code/`、`factory/` | 官方订阅鉴权透传、历史协议兼容、Factory 请求及附件适配；不是 CPA 插件或 Droid agent |
| CPA 账号额度插件 | `integrations/cpa/account-quota/` | Go 动态库，为 Factory / Command Code 注册只读额度及管理接口，不参与推理路由 |
| CPA 管理页扩展 | `integrations/cpa/quota-ui/` | 对固定版本的管理页源码应用额度卡片 overlay，不是独立 Web 服务 |
| 配置模板与模型目录 | `config/bridge/`、`config/providers/`、`config/catalogs/` | 无真实凭据的部署示例和模型元数据 |
| 运维与验证 | `scripts/`、`deploy/`、`test/` | 显式迁移、构建、部署、离线测试和需授权的真实接口验证 |

根目录 `server.js`、`sync-catalog.js` 仅保留兼容入口，不承载实现。
`src/core/` 不依赖编排或厂商适配器；适配器不反向依赖 bridge；
推理源码不导入 `integrations/` 或配置示例。这些边界由架构测试检查。
Command Code 运行时默认规则放在适配器内部，用户文件配置仍可覆盖。
CPA 安装和页面构建脚本归属 `integrations/cpa/scripts/`，旧脚本路径仅作兼容入口。

配置不会作为插件编译。真实配置、API key、OAuth 文件、日志、编译产物和本机
指令缓存留在用户目录，不提交到仓库。详细文件归属、构建、发布及回滚见
[架构与配置说明](docs/architecture.md) 和 [发布检查](docs/releasing.md)。

### Command Code 账号额度

CPA 额度页支持 Command Code 的 5 小时/周窗口、订阅/购买/免费余额和订阅周期结束时间。
凭据直接读取 CPA 配置中的唯一 Command Code key；不调用模型，不改变路由，
不向浏览器下发 key，不将未知值填成零。见 [Command Code 额度说明](docs/command-code-quota.md)。

### Factory 限额/历史消费查询

新增独立文件配置 `config/providers/factory-quota.example.json` 和只读查询命令
`node scripts/query-factory-quota.js`，支持组织默认限额、个人覆盖限额和
当前凭据的历史 Factory Standard Credits 消费。详见 [Factory 接入说明](docs/factory-api.md)。
`quota.billingLimits` 另支持内部网关的 5 小时/周/月利用率和额外用量余额。
模型链路为 `Codex → metabridge → CPA → 本机 Factory 适配层 → Factory 网关`，
不运行 Droid agent。适配层只补充已验证的客户端版本字段与 Factory 身份提示前缀；
CPA 负责 Responses/Messages/Chat 协议转换，官方/CMD/Gateway 不经过该适配层。
已配置 53 个非 Gemini 模型；其中 GPT-6.1 Sol、Sonnet 5.5、Haiku 4.5、
GLM-5.3 已完成推理验证，其余按用户要求直接配置、不逐个验证。
`factory_prefix` 保留原生指令位置但增加上游身份文本，不等于原样转发；
`fold_system_into_user` 仍作为参考 pi 的显式探测选项，会改变指令优先级。
内部网关并非公开稳定 API。已新增只读 `factory-quota` CPA 动态库插件和
管理页 overlay，在 `#/quota` 显示单账号 Standard/Core 窗口、重置时间及额外余额。
缺失值保持未知，不伪造 OAuth 认证文件，不向浏览器下发 Factory key。
源码、构建部署和管理页升级注意事项见上述接入说明。

### 官方订阅直连 + CPA 托管第三方（推荐）

使用 `config/bridge/config.hybrid.example.json`，官方 provider 从
`config/providers/openai-subscription.hybrid.example.json` 复制，CPA provider 从
`config/providers/cpa.example.json` 复制。CPA 的客户端访问密钥放在个人配置引用的
`cpa-api-key` 文件（权限 0600），不是环境变量，也不是官方 OAuth 凭据。

链路：官方模型 → metabridge → 官方 Codex；其他模型 → metabridge → CPA → 上游。
CMD 的 Chat/Messages 适配、Gateway 的 Responses 接入、上游密钥、账号池和协议转换
由 CPA 管理。metabridge 的旧适配器保留给旧配置兼容，混合部署不再启用。

- `routeModels` 支持精确模型 ID 和 `{ "regex": "...", "flags": "i" }`。
  非空 `prefix` 优先，其次 `routeModels`，最后未配置 `routeModels` 的空前缀兜底。
  匹配后过滤拒绝、鉴权失败或上游失败均不回退其他 provider。
- 官方示例预留 GPT/o 系列名称；如果 CPA 有同名模型，在 CPA 内配置 `prefix`
  或 `alias` 区分。CPA 前缀是可选配置，并不是自动附加 provider 名称。
  例如 CPA 返回 `cmd/vendor/model`、`gateway/gpt-model`，这里原样保留，
  不额外加 `cpa/` 或 `openai/`。同一个 ID 无法同时指向两条链路。
- CPA 的 `requestMode: "passthrough"` 默认关闭 metabridge 的工具别名、压缩合成、
  压缩历史物化和 sanitize；可用 `compaction` 为 Factory/Fusecode Claude 显式开启
  仅摘要轮次和检查点回放的例外，普通推理仍保持直通。响应流不做工具名改写。
  请求仍进行 JSON 解析/序列化，
  不是原始 HTTP 字节或 TLS 连接透传。支持 Responses 和受限官方订阅 provider，不可叠加
  `sanitize`/`webSearch`。
- 模型目录只展示与实际路由一致的 provider 条目，同名官方模型不会重复展示。
  `displayPrefix: ""` 不添加展示前缀，`priority` 数值越小越靠前；
  可在 CPA 模型的 `display-name` 中设置 `cmd · model` 等标签。
- CPA 示例使用 `catalog.format: "codex"` 获取其 Codex 专用目录，保留工具能力、
  推理档位、上下文窗口等元数据；`catalog.clientVersion` 应与使用的客户端版本一致。
- 原 Command Code 的 metabridge `webSearch` Gateway 辅助链路不会自动迁移成 CPA
  原生搜索功能。需要在 CPA/上游单独确认搜索支持，不能把协议转换当成能力等价。

现有的单 CMD + 单 Gateway 文件配置可分阶段迁移（其他拓扑不会被脚本覆盖）：

```bash
NODE_USE_ENV_PROXY=1 node scripts/migrate-to-cpa.js
# 安装 CPA v8.0.12 二进制到 ~/.local/share/cliproxyapi/v8.0.12/ 后：
cp deploy/cliproxyapi.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cliproxyapi.service
# 先验证 CPA 的模型目录与真实请求，再激活：
node scripts/migrate-to-cpa.js --activate
systemctl --user restart metabridge.service
node scripts/verify-hybrid.js
```

脚本生成 `~/.config/cliproxyapi/config.json`（JSON 是合法 YAML，CPA v8 可读取），
只监听 loopback，管理接口关闭；密钥、配置与备份使用 0600，旧主配置和 provider
文件备份在 `~/.metabridge/backups/before-cpa-*`。上游 key 从现有文件迁入 CPA 的
`api-keys.openai-compatibility`（CMD Chat API）和 `api-keys.codex`（Gateway Responses API）。
CPA `access.api-keys` 是 bridge → CPA 的独立访问凭据；不导入官方订阅账号。
CMD 白/黑名单在迁移时筛选为 CPA 的 `models` 配置，推理档位迁入 `thinking.levels`；
新增模型需要更新 CPA 配置，不会因上游列表增加而自动开放。

Gemini 的 Codex 图像工具 schema 兼容规则也放在 CPA `payload` 中：
`config/providers/cpa-gemini-payload.example.json` 保留工具和 nullable 数组含义，
只把 `referenced_image_paths` 的数组 `items` 移到 `anyOf` 的数组分支，
避免 Command Code → Gemini 转换后出现 `any_of` 的非法并列字段。
不影响官方/Gateway/其他 CMD 模型。`verify-hybrid.js` 是显式执行的真实推理测试，
使用客户端已有登录，不读取 `auth.json`，不修改永久 Codex 配置。

本机多后端聚合代理：把多个后端（Responses 兼容服务、gateway、Command Code 等）合并成单个 provider，供 Codex CLI 使用。Responses 兼容后端只需改配置；Command Code 通过内置协议适配接入。

## 功能与边界

- 将多个后端的模型目录与可选的官方模型目录合并，供 Codex 在一个模型选择器中使用。
- 按模型名前缀分流请求，各后端使用独立凭据；不匹配前缀的请求走 catch-all 后端。
- 支持 Responses JSON / SSE 转发、长工具名兼容、带前缀后端的本地 compaction 合成与回放。
- 内置 Command Code 的 Chat / Anthropic 协议适配，以及可选的搜索代执行。
- 核心转发使用 Node.js 内置模块；Factory 图像优化使用锁定版本的 `sharp`。

支持可选的 `codex-subscription` 官方订阅直连：透传当前 Codex 客户端的 OAuth 鉴权，
无需 gateway，也不将订阅转换成 Platform API key。bridge 不负责登录、刷新 token 或账号池。
官方与第三方目录可以同时出现；目录中出现模型不等于账号具有相应权限或额度。

## 快速开始

需要 Node.js >= 20.9，推荐 Node.js 24；先执行 `npm ci`。
加载官方目录还需要已安装的 Codex CLI，且支持
`codex debug models --bundled`。只使用第三方后端时可关闭官方目录。

在项目目录执行：

```bash
mkdir -p ~/.metabridge/providers
cp config/bridge/config.example.json ~/.metabridge/config.json
cp config/providers/openai-subscription.example.json ~/.metabridge/providers/openai-subscription.json
cp config/providers/command-code.example.json ~/.metabridge/providers/command-code.json
chmod 600 ~/.metabridge/config.json ~/.metabridge/providers/*.json
```

已有配置时不要直接覆盖。编辑 `~/.metabridge/config.json`，填写自己可访问的后端与凭据。
默认示例启用订阅直连，Command Code 默认关闭，准备好 key 后才能启用。
`config/providers/` 下提供第三方 Responses 和通用网关模板；其中占位地址不是可用服务，
需要填写自己的服务地址和凭据。
至少需要一个可用后端。

仅使用一个第三方 Responses 服务时，可使用：

```json
{
  "host": "127.0.0.1",
  "port": 8318,
  "providerFiles": ["providers/responses.json"]
}
```

将 `config/providers/responses.example.json` 复制到上述文件，修改地址、前缀、过滤条件及
`enabled: true`。把密钥单独保存到 `keyfile` 并设置权限 `600`，不要提交到仓库。
新配置的 `base_url` 是完整 API 根地址，例如 `https://provider.example.com/v1`；
代理只追加 `/models`、`/responses` 等资源路径，不重复添加 `/v1`。
旧 `base`（不含末尾 `/v1`）继续兼容，但不可与 `base_url` 同时配置。
`reasoning: "none"` 是保守的目录策略；支持哪些推理档位应以所用服务为准。

```bash
npm start
```

另开终端验证：

```bash
curl -sS --noproxy '*' http://localhost:8318/healthz
curl -sS --noproxy '*' http://localhost:8318/v1/models
```

`/healthz` 包含各后端目录状态；目录拉取失败时会报告 degraded。它不是模型推理或订阅额度验证。

### 接入 Codex

在用户级 `~/.codex/config.toml` 中配置：

```toml
model_provider = "metabridge"

[model_providers.metabridge]
name = "OpenAI"
base_url = "http://localhost:8318/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

这是官方订阅与第三方并存的示例，订阅登录仍由客户端通过 `codex login` 管理。
只使用第三方时可设 `name = "metabridge"`、`requires_openai_auth = false`。
订阅后端使用内置的受限头部透传，不设置 `passthroughHeaders: true`；
第三方后端使用自己的凭据。不要对不可信服务开启通用鉴权透传。

现有 gateway 兼容方案使用 provider `name = "OpenAI"`，以保留其所需的 Codex 元数据并进入
remote compaction 路径；这属于客户端兼容配置，不会把第三方模型变成官方模型。
客户端版本差异可能影响模型展示和压缩行为，请以所安装客户端验证结果为准。

修改 provider / `base_url` 后需要重新启动相应客户端；不要中止仍有活跃任务的进程。
若已配置 `model_catalog_json`，必须同步这份静态目录，单独更新 `/v1/models` 不会覆盖它。

### 接入 Command Code（`cmd/`）

Command Code 从在线 `/provider/v1/models` 拉取目录。复制
`config/providers/command-code.example.json` 为 `~/.metabridge/providers/command-code.json`，
将这个路径加入主配置的 `providerFiles`，准备好密钥后启用。文件中的基础连接设置为：

```json
{
  "name": "command-code",
  "base_url": "https://api.commandcode.ai/provider/v1",
  "wire_api": "responses",
  "prefix": "cmd/",
  "protocol": "command-code",
  "auth": { "type": "keyfile", "file": "~/.metabridge/command-code-api-key" },
  "priority": 45,
  "reasoning": "command-code",
  "enabled": true
}
```

将自己的 Command Code API key 单独保存在该 `keyfile`，文件权限建议设为 `600`，不要提交密钥。
此后端默认关闭，准备好 key 后再启用。`base_url` 含完整 `/provider/v1`；
客户端 wire API 仍为 Responses，上游 Chat/Messages 转换由 `protocol: "command-code"` 处理。

模型按 `priority` 升序排列。如果 Codex 配置了 `model_catalog_json` 静态目录，仅清理
`models_cache.json` 不会更新该文件：需要同步允许的条目，再重新加载客户端配置。

重启后检查 `/healthz` 的 `backends.command-code` 和 `/v1/models`。模型名的大小写与
内部 `/` 保持原样。模板默认只允许四个示例模型，不代表当前套餐权限；按自己的套餐修改。
只使用 Command Code 时，`providerFiles` 只引用该文件即可。

分发时只剥离最外层 `cmd/`。Command Code 不提供 Responses 接口，因此本项目将 Codex `/v1/responses` 请求转换为上游原生协议：Claude → `/v1/messages`，其他模型 → `/v1/chat/completions`，再将结果转换回 Responses JSON / SSE。支持文本、图片、function / namespace / custom 工具（含 `apply_patch`），以及本地 compaction 合成与回放。图片是否可用仍取决于所选模型。

#### 白名单、黑名单与正则过滤

所有 provider 使用相同的 `modelFilter`，目录展示与实际调用共用规则。
规则匹配剥离路由前缀后的原始模型 ID；字符串是区分大小写的精确匹配，
对象是 JavaScript 正则。例如：

```json
"modelFilter": {
  "allow": ["zai-org/GLM-5.3", { "regex": "^deepseek/", "flags": "i" }],
  "deny": [{ "regex": "(preview|experimental)$", "flags": "i" }]
}
```

`deny` 优先；`allow` 中任意一条匹配即可。省略 `allow` 表示不限制允许范围，
`allow: []` 表示全部禁止；仅设置 `deny` 即黑名单模式。非法规则在启动时拒绝。
正则采用搜索匹配，完整匹配请加 `^` / `$`；flags 只允许 `i/m/u`，不接受 `g/y`。
正则配置必须可信：长度限制不能防止所有灾难性回溯，不提供 RE2 或执行超时隔离。
被禁止的模型隐藏且请求返回 `403 model_not_allowed`，不会回退其他后端。
旧 `modelAllowlist` 精确名单仍兼容，但不能与 `modelFilter` 同时配置。

套餐范围需按所用供应商的套餐说明和在线 API 精确 ID 核对；目录存在或调用成功不等于
套餐内免费。模板只是选择示例，不自动抓取套餐网页或扩展到上游新增模型。

逐模型推理档位同样在文件中配置，第一条匹配规则生效：

```json
"reasoningRules": [
  { "match": { "regex": "^deepseek/" }, "levels": ["low", "high", "max"], "default": "high" }
],
"messagesModels": [{ "regex": "^(anthropic/)?claude-", "flags": "i" }]
```

`messagesModels` 控制 Command Code 哪些模型使用 Messages，其余使用 Chat；
空数组表示全部使用 Chat。`reasoningRules` 同时决定目录档位和 Command Code 请求参数。
模板内有四个示例模型的精确规则；新模型的支持档位应由使用者核实。

### 不经 gateway 的官方订阅直连

参考 [Codex 自定义 provider 鉴权](https://learn.chatgpt.com/docs/auth#alternative-model-providers)
和 [OpenCodex 的 Direct 模式](https://opencodex.me/guides/providers/)，新增
`protocol: "codex-subscription"`。客户端继续管理官方登录，bridge 将当前请求的 Bearer
和 `ChatGPT-Account-Id` 等批准头部透传到固定的
`https://chatgpt.com/backend-api/codex`，不读取磁盘 token，不存储或转换订阅凭据。

`catalog.source: "codex"` 加载 CLI 内置目录，第三方用 `cmd/`、`ext/` 等独立前缀，
所以官方与第三方可以同时出现在合并目录中。若客户端使用静态目录，仍需同步该文件。
`catalog.source: "static"` 也可显式配置目录，但两种来源都不验证账号权限。

此路径仅支持原生 Codex HTTP/SSE 的 Responses 与 `/responses/compact`；
不实现 WebSocket，也不是任意 API 客户端的订阅转换器。请求内容保持原生，
不使用第三方的本地压缩、工具别名或 gateway 清洗。Platform `sk-` API key 不适用于此路径。
禁止重定向和任意远程目标，测试允许回环地址。订阅文件须使用 `auth.type: "none"`，
不能开启通用 `passthroughHeaders` 或 `sanitize`。

实际可用性取决于客户端版本、账号权限、网络和官方接口。可使用下面的独立验证脚本，
通过客户端现有 ChatGPT 登录发送一次最小真实请求，不读取 token、不修改正式配置或重启服务：

```bash
node scripts/verify-subscription.js
# 可指定本机内置目录中存在且账号有权限的模型：
node scripts/verify-subscription.js your-model-id
```

该验证会消耗少量订阅额度，默认模型为 `gpt-5.6-sol`，90 秒超时；临时目录与进程在退出时清理。
脚本同时加入一个不可调用的模拟第三方目录条目，验证目录并存与客户端目录解析，
但不证明真实第三方模型调用可用。

网络出口必须经过 HTTP(S) 代理时，在支持环境代理的 Node.js 版本中显式启用
`NODE_USE_ENV_PROXY=1`，并通过 `NO_PROXY` / `no_proxy` 排除回环地址。
例如本机 Node.js v24.20.0 的验证命令（保留已有代理地址，仅调整本次进程环境）：

```bash
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost NODE_USE_ENV_PROXY=1 \
  node scripts/verify-subscription.js
```

2026-10-02 本机验证：以上命令通过现有 ChatGPT 登录，经临时 bridge 请求
`gpt-5.6-sol`，返回 `METABRIDGE_OK`。未使用 gateway，未修改正式配置或重启现有服务。
本次真实验证覆盖目录解析、鉴权和流式推理；原生 compact 与真实第三方调用仍只有模拟测试，
不代表所有模型、订阅套餐或客户端版本都通过了验证。

### Command Code 当前适配边界

Command Code 可配置搜索代执行，目标可以是 Responses 网关或订阅直连后端，
主对话模型保持不变。请指定账号可用且支持原生搜索的模型：

```json
"webSearch": {
  "backend": "openai-subscription",
  "model": "your-search-model-id",
  "maxSearches": 3,
  "timeoutMs": 60000
}
```

启用后，`web_search` / 两种 preview 工具被转换为内部 function。bridge 截获查询，
使用目标模型的原生 `web_search` 执行，再将结果回传原模型，不移交整个会话。
原工具的域名、位置、缓存/实时访问等选项保留。强制搜索通过提示及结果校验落实，
不强制主模型 function choice。超限、重复查询、上游失败或搜索未执行均明确失败。

搜索目标使用自己的凭据；订阅目标使用当前客户端鉴权，旧 gateway 目标保留订阅鉴权透传。
普通第三方目标默认不接收客户端 OAuth 头。不传 Command Code key，
不额外读取磁盘 token。仅有第三方 key 不足以访问订阅目标。
主模型与搜索模型分别受各自 provider 的过滤规则约束；搜索模型在启动时校验，
不隐式切换或降级到其他模型。

启用搜索的路径按轮缓冲主模型输出来判断是否需执行搜索，期间有 SSE 心跳；搜索过程输出 `web_search_call` 事件，结果摘要以带来源的 commentary 消息写入历史，供后续对话及压缩使用。内部搜索函数不会交给 Codex 执行；同轮出现普通编码工具时，完成搜索后将普通调用返回 Codex，不在 bridge 执行它们。未声明搜索工具的请求仍走原流式路径。

搜索消耗目标后端的额度，用量单独记录在服务日志中，主响应 usage 仅累计主模型。
单次搜索默认 60 秒超时，整个代执行请求最多 5 分钟；客户端取消会中止活动请求。
配置修改后重启 metabridge。

- Command Code 将 `reasoning.effort` 转换为 `reasoning_effort`，未指定时使用文件中的默认值，
  不支持的档位明确报错。旧 `reasoning: "command-code"` 配置回退到 JSON 模板的档位；
  未匹配的模型不注入未验证参数。显式 `reasoningRules: []` 可关闭模板规则。
- 私有 reasoning item、verbosity 等 Responses 专用字段仍不直接透传。主模型推理强度不影响搜索助手：`gpt-5.6-sol` 搜索仍固定为 `low`。HTTP 200 只证明参数被接受，不代表对所有题目都能保证推理 token 数或质量单调增加。
- custom 工具转换为包含 `input` 字符串的 function schema；原始 grammar 不由上游强制执行。文本增量实时转发，工具参数在完整收齐后返回。
- 未配置搜索代执行时，`web_search` 原样透传；`file_search` 及其他额外工具类型仍原样透传给上游，不因类型在本地拒绝，也不静默删除。上游是否支持由上游判断；Command Code 的 Chat 接口实测拒绝原始 `web_search`，因此需要上述代执行配置。function / custom / namespace 工具仍走原有转换。
- 不支持 `previous_response_id`，这类请求仍返回 400，需发送完整历史。模型白名单和鉴权不受工具透传策略影响。
- 本适配后端的客户端入口为 `/v1/responses`，不接受直接 `/v1/chat/completions` 请求；原有后端不受此限制。
- Claude 请求未指定输出上限时使用 `8192` tokens；上游截断返回 `incomplete`，压缩链路不会安装半截摘要。

开发验证：`node --test test/command-code.test.js` 覆盖协议转换及本地 HTTP 分发，`npm test` 跑全量回归。真实账号的权限、额度及模型调用仍需使用自己的 key 验证。

## 静态模型目录每小时增量同步

`sync-catalog.js` 按 `slug` 同步 metabridge `/v1/models` 到 Codex 静态目录。**已有模型仅保留本地 `context_window`、`max_context_window`**，例如 GPT-6 的 `950000` 窗口不会被覆盖；本地未设置的窗口字段使用上游值。其余字段完整替换为上游数据（包括名称、推理档位、提示词、能力和 `priority`），不再保留上游已不存在的旧字段。`effective_context_window_percent` 不在默认豁免范围内。新增模型使用上游配置。**模型范围和数组顺序完全以远端目录为准，源端已消失的旧模型会从本地目录移除**。

脚本不会修改 `config.toml`、清缓存或重启 Codex。同步前先检查 metabridge `/healthz`；上游报告 degraded、请求超时、失败、空目录或非法数据时保留本地文件，避免因已报告的后端故障误删模型。内容和顺序均无变化时不写文件。写入采用同目录临时文件加原子替换，并在写入前检查本地是否发生变化。最近一次变更前的目录（含被移除条目）保存在 `custom.json.sync-backup`。

gateway 组内沿用 gateway 上游顺序，不再受本地历史插入顺序影响，也不在末尾追加已下线的模型。即使只有顺序变化或模型移除、其他字段未变，也会同步写入。

后续需要额外豁免时，在同步 service 的 systemd override 中设置 `MB_CATALOG_EXTRA_PRESERVE_FIELDS`（逗号分隔的模型顶层字段，适用于所有已有模型）。例如：

```ini
[Service]
Environment=MB_CATALOG_EXTRA_PRESERVE_FIELDS=priority,effective_context_window_percent
```

默认没有额外豁免；这项设置不会取消两项上下文窗口保护，也不会给新模型强加本地值。保存 override 后执行 `systemctl --user daemon-reload`，下一次同步生效。

安装用户级定时器（先确认服务文件中的项目路径和静态目录路径与本机配置一致）：

```bash
cp deploy/metabridge-catalog-sync.service deploy/metabridge-catalog-sync.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now metabridge-catalog-sync.timer
systemctl --user start metabridge-catalog-sync.service
systemctl --user list-timers metabridge-catalog-sync.timer
journalctl --user -u metabridge-catalog-sync.service -n 20
```

每小时整点执行，错过的调度在用户服务管理器恢复后补执行一次。同一 oneshot 服务不会重叠运行；手动执行也建议用 `systemctl --user start`。修改了 `model_catalog_json` 或 metabridge 端口后，需同步修改 service 的参数。

## 配置与路由

只读取 `MB_CONFIG_FILE` 指定的配置，未设置时读取 `~/.metabridge/config.json`。
推荐使用非空 `providerFiles[]` 数组，每个文件是一个 provider JSON 对象。
文件顺序决定路由匹配顺序；路径相对于主配置，provider 的 `auth.file` 相对于该 provider
文件，支持绝对路径和 `~/`。重复文件、缺失文件或非法 JSON 启动失败，不会静默忽略。
旧内联 `backends[]` 仍兼容，不能与 `providerFiles` 同时配置；旧密钥相对路径行为不变。

顶层配置支持 `host`、`port`、`catalogTtlMs`、`logLevel`、
`compactionStripImages` 和 `providerFiles`。目录由各 provider 的 `catalog` 决定。
兼容的顶层 `officialModels.enabled` 在文件配置下默认关闭，在旧内联配置下默认开启；
它只追加 CLI 内置目录，不能替代订阅传输。运行参数可通过
`MB_HOST`、`MB_PORT`、`MB_CATALOG_TTL_MS`、`MB_LOG_LEVEL`、
`MB_COMPACTION_STRIP_IMAGES` 覆盖。修改后重启 metabridge。

后端至少需要 `name`、`base_url`（或旧 `base`）、`auth`：

| 字段 | 说明 |
| --- | --- |
| `base_url` | 完整 API 根地址，可含 `/v1` 或自定义路径，自动去掉末尾 `/`；不可含 URL 用户名、密码、query、hash |
| `base` | 兼容旧根地址格式，请求仍追加 `/v1/...`；不能与 base_url 同时配置 |
| `wire_api` | 默认且当前仅支持 `responses`；其他值启动时明确拒绝，不假装支持。上游特殊协议使用 protocol 适配 |
| `http_headers` | 可选文件配置请求头对象，值必须为字符串；auth 注入的凭据覆盖同名头部，不允许传输控制头 |
| `prefix` | 默认空字符串，表示 catch-all；非空前缀会加在目录模型 ID 前，转发时只剥掉这一层 |
| `displayPrefix` | 展示标签，格式为 `标签 · 模型名`；省略时使用去掉末尾 `/` 的路由 prefix，空字符串则不显示标签。不会改变模型 ID |
| `protocol` | 默认 `responses`；可选 `command-code`（必须有前缀）、`codex-subscription` |
| `catalog` | `source` 可选 `remote`（默认）、`static`、`codex`、`none`；static 需要 `models: [{"id": "..."}]`；订阅不能使用匿名 remote 目录 |
| `enabled` | 默认 `true` |
| `priority` | 默认 `50`，非负整数，越小越靠前，支持 `0`；同优先级保留配置文件与上游目录顺序 |
| `passthroughHeaders` | 默认 `false`；开启后透传入站请求头，再叠加该后端自己的鉴权头 |
| `reasoning` | `full`（默认）、`none`、`command-code`，或 `{ "levels": ["low", "high"], "default": "high" } |
| `sanitize` | 默认不清理；`gateway` 用于兼容该类网关的 reasoning item 约束 |
| `modelFilter` | 原始 ID 的 `allow` / `deny`，支持字符串和 `{regex, flags}` |
| `modelAllowlist` | 旧精确白名单兼容项，不能与 modelFilter 同时配置 |
| `reasoningRules` | 按精确 ID / 正则选择推理档位，第一条匹配生效 |
| `messagesModels` | Command Code 的 Messages 模型规则列表，其余走 Chat |
| `webSearch` | Command Code 的可选搜索代执行，配置见上文 |

鉴权类型：

- `keyfile`：通过 `file` 指定 Bearer token 文件。
- `static`：通过 `key` 指定凭据，可选 `header`、`scheme`。
- `gateway`：通过 `key` 设置 `x-api-key`；为空或占位符时禁用后端。
- `none`：不额外注入凭据；可配合 `passthroughHeaders` 透传入站鉴权。

运行时凭据来自 provider 文件或它明确引用的 keyfile，不支持 `env_key` /
`env_http_headers`；配置这些字段会明确报错，避免误以为环境变量已生效。
客户端的 `requires_openai_auth` 配置与上述上游凭据是两层不同设置，
bridge 不将 provider JSON 里的 name 当作客户端 `name="OpenAI"` 开关。

### Gateway（文件凭据）

`config/providers/gateway.example.json` 按 Responses 网关配置，示例为：

```json
{
  "name": "gateway",
  "base_url": "https://gateway.example.com/v1",
  "wire_api": "responses",
  "prefix": "gateway/",
  "displayPrefix": "gateway",
  "auth": { "type": "static", "key": "" },
  "catalog": { "source": "remote" },
  "passthroughHeaders": false,
  "http_headers": {},
  "reasoning": "full",
  "priority": 50,
  "enabled": false
}
```

复制为个人配置中的 `providers/gateway.json`，在 `auth.key` 填真实凭据并启用，
再加入主配置的 `providerFiles`。密钥作为 `Authorization: Bearer ...` 发送；
不读取 `GATEWAY_KEY`，也不使用旧的 `x-api-key`。也可改用
`auth: {"type": "keyfile", "file": "../gateway-api-key"}`，通过文件配置明确引用密钥文件。
默认不透传客户端 OAuth，也不启用额外清洗策略；
只有上游明确需要时才单独启用对应兼容设置。
目录与推理分别请求 `base_url + "/models"`、`base_url + "/responses"`。
示例地址只是占位符，不代表可用服务。迁移脚本保留用户配置的地址，不写入固定厂商域名。

已有个人配置包含该网关的 `auth.key` 时，可显式迁移并独立验证：

```bash
node scripts/configure-gateway.js
NODE_USE_ENV_PROXY=1 \
  NO_PROXY="${NO_PROXY},127.0.0.1,localhost" \
  no_proxy="${no_proxy:-${NO_PROXY}},127.0.0.1,localhost" \
  node scripts/verify-gateway.js
```

迁移脚本第二个参数可以指定 provider 名称，默认 `gateway`；
验证脚本参数为 `[config路径] [上游模型ID] [provider名称]`，默认选目录首个模型。
迁移脚本备份个人配置，并将旧内联 provider 写为独立文件；保留其他 provider 设置、
原有路由前缀及顶层官方目录开关，不读取环境变量中的 API key，也不重启服务。
备份目录权限为 `700`，配置和备份文件权限为 `600`。验证脚本只引用实际 gateway 文件，
启动隔离临时进程测试目录和一次最小推理，会消耗少量网关额度；完成后清理临时进程与目录。
代理环境必须保留原有的 `NO_PROXY` / `no_proxy` 规则，以免内网网关被错误送往代理。

所有带前缀的后端按配置顺序匹配；无匹配时使用第一个启用的 catch-all。
不要重复配置前缀；多个 catch-all 也只有第一个生效。没有匹配路由时返回
`400 no_route`，不会自动切换其他后端。白名单禁止的模型返回 `403 model_not_allowed`。
开启兼容的顶层官方目录时必须有启用的 catch-all，否则启动失败。
使用 provider 自己的 `catalog.source: "codex"` 时也可通过显式前缀展示官方模型。

例如 Command Code 文件配置 `"prefix": "cmd/"`、`"displayPrefix": "cmd"`、
`"priority": 45` 时，请求模型 ID 仍为 `cmd/zai-org/GLM-5.3`，
模型选择器展示为 `cmd · zai-org/GLM-5.3`。可将展示标签改为任意字符串，
包括官方订阅配置 `"prefix": ""`、`"displayPrefix": "OpenAI"`。
`/v1/models` 的 `models` 和 `data` 都携带一致的展示名称、provider 优先级和排序。
若配置了静态 `model_catalog_json`，仍需同步目录后重新加载客户端才能看到新展示名称。

### 导入已有 gateway 凭据

仅当所用网关使用 `x-api-key` 时需要：

```bash
node server.js --import-gateway-key
node server.js --import-gateway-key --from /path/to/config.toml --backend gateway
```

来源默认是 `~/.codex/config.toml`（尊重 `CODEX_HOME`）；支持字面请求头和环境变量请求头。
文件配置下导入只修改对应 provider 文件的 `auth.key`，不重写主配置；
旧内联配置下仍修改 `backends[].auth.key`。运行期不读取 Codex 配置兜底。
已有不同凭据时默认拒绝覆盖；确认要替换时才添加 `--force`。导入日志不输出完整密钥。

## 通用压缩与工具兼容

非订阅后端的长 function / custom 工具名映射为稳定短别名，响应时还原。
订阅直连保持原生内容，不使用此兼容层。

带前缀的非订阅后端 `/v1/responses` 请求包含 `compaction_trigger` 时，metabridge 会调用
会话当前的模型生成摘要，合成为一个 compaction item；不依赖其他后端代压缩。
图片默认保留，不支持图片或需要减少图片 token 时可设置 `compactionStripImages: true`。
失败、截断或未完成的摘要不会安装成有效 checkpoint。

回放时将最新 `mb-cmp1:` / `sr-cmp1:` checkpoint 转换为历史 assistant 消息，
裁掉其之前的旧窗口，保留之后的新输入。不可解码的官方加密块或畸形信封明确返回
`unsupported_compaction_format`，不静默丢上下文；这种情况下应新开会话。
catch-all 后端不执行这套本地压缩和回放，需自行支持客户端发来的原生协议。
订阅直连不论是否带前缀都走官方原生压缩，包括 `/v1/responses/compact`。

## 部署与验证

`deploy/metabridge.service` 是用户级 systemd 模板，仅依赖网络，不依赖某个具体后端服务。
安装前将其中的项目路径改为实际路径：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/metabridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now metabridge
journalctl --user -u metabridge -n 50
```

`deploy/start.sh` 尝试加载 nvm；未安装时使用系统 Node.js。
后端服务应由使用者独立部署。修改后端配置后重启 metabridge；升级 Codex CLI 后也应
重启 metabridge，以刷新其加载的内置官方目录。

```bash
npm test
```

测试使用本地模拟后端，覆盖协议转换、目录同步、鉴权隔离、路由、压缩、工具名、
搜索代执行和端口冲突；不证明真实订阅权限、额度或第三方线上服务可用。

## 发布与安全

- 默认仅监听回环地址。本地代理没有额外的入站访问鉴权，不要未经保护暴露到公网。
- 不要提交实际配置、密钥文件、OAuth token、日志或模型目录备份。
- Responses 和网关模板均使用占位地址，部署前填写自己的服务地址与凭据。
  实际配置与密钥不应提交。
- 订阅直连不包含 OAuth 登录、账号池或自动刷新，使用客户端当前的订阅鉴权。
- 通用工具适配不保证所有后端支持图片、搜索或相同的推理参数；以实际所选模型为准。
