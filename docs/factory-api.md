# Factory Public API 接入与额度查询

核对日期：2026-10-03。来源：

- https://docs.factory.com/api-reference.md
- https://docs.factory.com/openapi.json
- https://docs.factory.com/api-reference/organization.md
- https://docs.factory.com/api-reference/analytics.md

## 接口边界

生产地址为 `https://api.factory.ai`，使用 `Authorization: Bearer <Factory API key>`。
Public API 也声明支持 JWT；本次配置只接入用户提供的 API key 文件，不读取 Droid
登录缓存，不实现 OAuth 登录或刷新。

公开 OpenAPI 是组织、服务账号、Droid 会话、计算机、CI 和 Wiki 管理契约，
没有 `/v1/models`、`/v1/chat/completions` 或 `/v1/responses`。
Droid 会话接口不是 OpenAI 模型协议，不能直接配置到 CPA 的
`openai-compatibility` / `codex` 后端。本次不增加不可工作的推理 provider、
不创建 Droid 会话，也不改变现有官方/CMD/Gateway 路由。
模型调用使用下述单独的内部 LLM 网关适配层，而不是 Public API 的会话接口。

## 支持的只读额度接口

| 查询 | 路径 | 含义 |
| --- | --- | --- |
| 默认限额 | `GET /api/v0/organization/usage/limits/global` | 无个人覆盖时的组织每用户 credits 限额，返回 `{limit}` |
| 个人覆盖 | `GET /api/v0/organization/usage/limits/users` | 返回 `{globalLimit,userLimits:[{email,limit}]}` |
| 当前凭据的个人消费 | `GET /api/v1/analytics/cost/me/query?queryKey=headline_daily&startDate=...&endDate=...` | 按天返回 `data:[{date,fsc}]` |

限额单位及消费单位为 Factory Standard Credits，不是美元余额，也不等同于原始
input/output token。`limit: null` 表示未配置该政策限额，不表示订阅无限。
个人覆盖中的 `null` 继承组织默认值；`0` 是有效限额，不使用真假值判断。

个人 Analytics 需要 Enterprise 组织启用 Analytics；User 角色只能查自己。
组织 Analytics 端点需要 Manager/Owner，本次不调用这些端点。组织限额接口可能
因角色权限返回 403；以服务端鉴权结果为准，不绕过限制。
配置 `quota.userEmail` 只选择组织政策中某个用户，并不证明其就是 key 的身份；
个人消费接口的身份由服务端根据 bearer 决定。本次不把这两者相减成剩余额度。

Analytics 使用 UTC，最多 90 天，最早从 2026-01-14 开始，只能查到昨天。
默认查询截至昨天所在月份的月初至昨天，包括 UTC 月初时查询上个月。
这不代表订阅账期；可设置 `quota.usage.startDate` / `endDate` 查询明确历史范围。
文档说明每日批处理有延迟，因此不能用于实时余额、5 小时/周剩余额度或重置倒计时。
文档只说明请求速率限制因套餐而异，没有可查询 RPM/TPM 限额的公开接口。

## 内部网关额度接口（可选）

`quota.billingLimits: true` 额外查询 `GET /api/billing/limits`。
此接口未列入 Factory Public OpenAPI，按实际观察到的响应进行严格解析，
不能承诺长期稳定。2026-10-03 当前 key 的只读查询返回 HTTP 200。

- `limits.standard/core.fiveHour/weekly/monthly.usedPercent`：使用百分比。
- `windowEnd` / `secondsRemaining`：重置信息，缺失/null 保持未知，不生成倒计时。
- `extraUsageBalanceCents`：额外用量美元余额，不是订阅 credits 总余额。
- `extraUsageAllowed`：是否允许额外用量，不代表不限额。

窗口缺失不填零；缺少全部已知窗口或响应不合法，报告不可用。
`realTimeBalance` 仍标记 unsupported，因为没有验证订阅的绝对剩余 credits。

## 文件配置与使用

`providers/factory-quota.example.json` 是独立查询配置，**不要加入 metabridge 的
`providerFiles`**，也不要作为 CPA 模型 provider 配置。

```bash
mkdir -p ~/.config/cliproxyapi/quota
cp providers/factory-quota.example.json ~/.config/cliproxyapi/quota/factory.json
chmod 600 ~/.config/cliproxyapi/quota/factory.json
# 使用编辑器把 Factory API key 写入同目录的 factory-api-key（不要提交到项目）。
# 然后 chmod 600 ~/.config/cliproxyapi/quota/factory-api-key
node scripts/query-factory-quota.js
# 或显式指定另一份配置：
node scripts/query-factory-quota.js --config /absolute/path/factory.json
```

`auth.file` 相对当前配置文件解析，支持绝对路径和 `~/`；只接受私有 key 文件
（Unix 权限不允许 group/other 读取），不使用环境变量取 key。
若网络必须通过环境代理，可在支持环境代理的 Node 版本执行
`NODE_USE_ENV_PROXY=1 node scripts/query-factory-quota.js`，仅代理使用环境配置。

四个查询可独立关闭，至少启用一个；旧配置不设置 `billingLimits` 时保持关闭。
没有组织管理权限时可关闭 `globalLimit`、
`userLimits`，仅开启 `personalUsage`；没有 Enterprise Analytics 时可反向关闭。
查询为手动触发，无后台定时任务、无额外监听端口。
API key 只发送到固定的官方 HTTPS origin，拒绝重定向。
401、403、429、网络错误和不合法响应均返回 `unavailable`，不会填成零；
合法空 Analytics 数据返回消费零。部分成功返回 `partial`，保留有效查询结果。
不输出 key、上游错误体或无关组织成员列表。

退出码：0 全部已启用查询成功；1 部分/全部查询失败；2 配置或凭据不可用。
脚本输出结构化 JSON，核心 `queryFactoryQuota` 已由下面的 CPA 额度集成复用。

### CPA 页面额度显示（2026-10-04 已部署）

模型适配层仍是独立 Node HTTP 服务，不是模型执行插件。
CPA 使用已有 `codex`、`claude`、`openai-compatibility` provider 连接该服务。

新增 `integrations/cpa-account-quota` Go 动态库插件，使用 CPA ABI 1 / JSON schema 6，
只声明 `quota_provider` 和 `management_api`。无模型执行、路由、认证登录能力。
插件通过标准 `quota.identifier/describe/fetch` 注册 Factory 额度能力，
可在 `GET /v0/management/quota/providers` 发现；不支持额度重置。

当前 Factory 是私有文件中的单账号 API key，不创建或伪造 OAuth/auth-file。
原生 `/quota/fetch` 要求运行时 auth_index，因此额外注册鉴权的单账号入口：
`GET /v0/management/plugins/factory-quota/account`。管理页通过 CPA 插件列表确认
插件已启用后调用该入口，在 `#/quota` 展示独立 Factory 卡片，不按模型/协议重复。

查询链路：浏览器（仅 CPA management key）→ CPA 插件 → 本机
`GET http://127.0.0.1:8319/v1/quota`（服务端文件 key）→ Factory billing。
Go 插件源码统一位于 `integrations/cpa-account-quota`；Factory 查询仅读取固定位置
的私有配置/凭据文件，使用无代理的本机 HTTP client，
拒绝重定向，25 秒超时、1 MiB 响应上限。不采纳浏览器提供的 URL、key 或账号。
metadata 中的 `local://…` 明确标识本地源码，不冒充已发布的 GitHub 插件。

`factory-quota-cpa.js` 复用 `queryFactoryQuota` / `normalizeBillingLimits`，
只查询 billing，不为页面重复查询组织成员/历史 Analytics。成功缓存 30 秒，
并发请求合并；失败不缓存、不返回旧成功数据。页面首开查询一次，有手动刷新，
不后台轮询。展示 standard/core 的 5 小时、周、月剩余比例，
重置时间与额外用量美元余额分别显示；未知窗口/时间保持未知，不推算绝对 credits。
API key 和组织/用户标识不下发到浏览器，查询失败不填零。

管理页采用官方源码 `ee79a794526a30c03748a8864a9ac6589a31833b` 上的小型 overlay，
维护在 `integrations/cpa-quota-ui`，复用 Card/Button/QuotaMeter 和现有主题，
覆盖四种语言、移动端单列、加载/错误/缺失值状态和连接切换隔离。
`scripts/prepare-factory-quota-ui.js` 只接受此固定版本，升级需重新审查 overlay。
部署会创建原配置、插件、management.html 的备份，并关闭管理页自动更新，
防止官方构建覆盖定制卡片；不改变管理密码、监听地址或任何模型 provider。
后续管理页升级需手动重建，不应直接开启自动更新而丢失此功能。

构建/部署示例（在管理页源码 checkout 中使用其锁定的 Bun 版本）：

```bash
# 在项目 integrations/cpa-account-quota 目录：
go test ./...
go build -buildmode=c-shared -o /absolute/build/factory-quota.so .
# 回到项目根目录：
node scripts/prepare-factory-quota-ui.js /absolute/path/to/management-ui
# 在管理页 checkout：
bun install --frozen-lockfile
bun test tests/factoryQuota.test.ts
bun run lint
bun run build
# 回到项目根目录：
node scripts/install-factory-quota.js --activate \
  --plugin /absolute/build/factory-quota.so \
  --web /absolute/path/to/management-ui/dist/index.html
systemctl --user restart factory-proxy cliproxyapi
```

实际 CPA 插件发现与账号查询均返回 200。2026-10-04 查询时 Standard 三窗口剩余
99% 且有重置时间；Core 三窗口剩余 100%，无重置时间；额外用量余额 0 USD。
这些是当时的响应，不是静态页面默认值。额外用量允许为 true。
浏览器打开已部署的 `#/quota` 时进入登录页，需用户重新登录；未声称完成
登录后视觉/点击验证。后端、组件静态渲染、类型检查、lint、构建已验证。
官方管理页全量测试有一个 HTML 转义断言失败，未改动的同 commit 基线也失败，
对应冷却测试单独运行通过；没有为通过测试而修改或删除上游用例。

## 模型网关接入

模型网关与 Droid 会话分开，链路为 Codex → metabridge → CPA →
本机 Factory 适配层（127.0.0.1:8319）→ Factory LLM gateway，不启动 Droid。
参考源码如下；这些内部协议不是 Factory 对外承诺的稳定 API：

https://github.com/tjboudreaux/pi-provider-factory
https://github.com/1e0n/droid2api
https://github.com/JaydonZhao/factory2api

源码核对版本：pi `300c1c0`，droid2api `9613b95`，factory2api `0417403`。
有些同名 Droid proxy 项目是反方向 BYOK 适配或包装 `droid exec`，不用于本方案。
没有运行第三方仓库代码，也没有读取其抓包文件中的凭据。

| CPA 分组 | 适配层转发的上游请求 | 配置模型 |
| --- | --- | --- |
| `codex` | `/api/llm/o/v1/responses` | `gpt-6.1-sol` |
| `claude` | `/api/llm/a/v1/messages` | `claude-sonnet-5-5`、`claude-haiku-4-5-20251001` |
| `openai-compatibility` | `/api/llm/o/v1/chat/completions` | `glm-5.3` |

### 2026-10-04 模型目录扩充

根据 https://docs.factory.ai/models.md 的公开模型 ID，
`providers/factory-models.catalog.json` 配置了 53 个非 Gemini 模型：
16 个 Claude、18 个 GPT、3 个 Grok、16 个 Droid Core 模型，包括仍在目录中的
deprecated 模型。MiniMax 使用 Messages 协议但 `x-api-provider` 为 fireworks，
参考 pi 的路由实现；其余 Core 使用 Chat。Grok 的 xai 路由、较新 Core 的
fireworks 路由是未进行推理验证的配置假设，可在文件中修改。
目录中的可见模型不等于当前账号有权限，例如 Fable 可能需要组织管理员启用
数据保留政策。Gemini 六个模型未发布，因为适配层尚无对应原生协议路由。

按用户要求，新加入的 49 个模型不逐个调用验证。原来的 4 个模型验证结论不变，
不能把它们的成功推广到全部新模型。仅检查本机配置、服务健康和模型目录合并。

```bash
node scripts/configure-factory-models.js --activate
systemctl --user restart factory-proxy
node scripts/configure-factory-cpa.js --activate
systemctl --user restart cliproxyapi metabridge
node sync-catalog.js ~/.codex/model-catalogs/custom.json http://127.0.0.1:8318/v1/models
```

脚本只更新模型白名单，保留私有 key 文件引用和 quota 配置，创建 0600 备份；
不做推理调用。示例 quota 配置仍是四模型最小起步示例，扩展目录单独维护。

### 对照验证与 403 原因

此前 whoami/billing 成功但推理 403，不能据此认定 key 没有模型权限。
本次使用同一文件 key、同一 Haiku 模型进行对照：

- 无 Factory 前缀：即使提供兼容版本字段，自定义 system / 无 system 都仍为 403。
- 加 Factory 前缀，但 `X-Client-Version: 0.2.0`：400，明确要求 v0.57.0 或更新版本。
- 前缀 + `X-Factory-Client: cli` + `X-Client-Version: 0.162.1`：
  使用自己的 `User-Agent: metabridge-factory/0.2` 返回真实 200/SSE/OK。
- 不需要复制完整旧 SDK 元数据、Factory CLI User-Agent、创建会话或运行 Droid。
- 4 个配置模型已分别验证原生网关输出，以及 CPA 的 Responses 流式输出。
- 4 个模型均已通过真实 Codex CLI 的工具回合：本地 shell 读取随机标记文件，
  tool result 回传后模型返回精确标记；不是只验证聊天文字。
- 全部 140 项项目测试通过；运行目录合计 32 个模型，原有 11 个官方模型和
  17 个 CMD/Gateway 模型保留。CPA 原有非 Factory 配置与备份逐项比较保持不变。

版本字段是显式配置的网关兼容版本，不是本适配层的程序版本。
这是观察到的兼容条件，不是对 Factory 所有账号/模型的权限或稳定性承诺。

### 指令模式与边界

`gateway.instruction_mode`：

- `preserve`：纯转换函数/探测工具默认，原样指令；当前网关对照返回 403。
- `fold_system_into_user`：参考 pi，把 system/developer 文本包装为
  `<system>…</system>` 后放入首条 user，改变指令优先级；当前账号对照仍为 403。
- `factory_prefix`：当前部署模式。在 Responses `instructions`、Messages
  `system` 或 Chat 首条 system 前加
  `You are Droid, an AI software engineering agent built by Factory.`，
  保留原始指令、developer 消息、缓存元数据、图片、工具定义与工具回合。
  这是上游身份文本兼容，并不是运行 Droid；但会改变模型身份，不能称为原样转发。

适配层服务仅接受 `factory_prefix` 配置；其他模式保留用于探测与对照。
固定上游 HTTPS origin，拒绝重定向；按文件中的 `gateway.models` 白名单
验证协议和模型，不接受客户端的 org、凭据覆盖或任意 URL。
本机入口要求 Bearer key，与配置的 key 比较；CPA 的 Claude 分组需显式带 Bearer。
仅支持 native Responses/Messages/Chat，保留 SSE 字节与错误状态，
不重试、不切账号、不执行工具、不保存请求正文，客户端断开即取消上游。
凭据更换后重启适配层及重新生成 CPA 配置。

### 部署与验证

`providers/factory-quota.example.json` 包含完整 gateway 文件配置；
`providers/cpa-factory.example.json` 是对应的 CPA 片段，不能直接覆盖现有配置。
部署命令：

```bash
# 准备私有 factory.json / factory-api-key 后，先运行原生适配层验证。
NODE_USE_ENV_PROXY=1 node scripts/start-factory-proxy.js
# 原生流式验证通过后启用持久服务；按本机 Node 安装修改 unit 的 ExecStart。
cp deploy/factory-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now factory-proxy.service
# 必须确认没有临时实例占用 8319，再启动持久服务。
node scripts/configure-factory-cpa.js --activate
systemctl --user restart cliproxyapi.service
systemctl --user restart metabridge.service
node sync-catalog.js ~/.codex/model-catalogs/custom.json http://127.0.0.1:8318/v1/models
# 显式允许计费；验证实际 Codex 工具调用/结果回放。
node scripts/verify-factory-codex.js --allow-inference
```

如果主机禁止 Linux user namespaces，默认 read-only sandbox 无法执行工具；
仅在隔离且可信的验证环境，可显式加 `--allow-unsandboxed-test`。
该选项只作用于临时测试 CLI，不修改全局 Codex 权限。
测试要求实际 shell 读取随机标记文件并返回该标记，不把仅有 HTTP 200 当成成功。
测试不会复制登录 token，保留私有临时 fixture/catalog 供诊断。

CPA 配置脚本只替换 `factory-openai/factory-anthropic/factory-core` 分组项，
保留已有 provider、payload 修复及访问凭据；写入前生成 0600 原配置备份，
使用临时文件原子替换。Claude base-url 是适配层根 URL（CPA 追加
`/v1/messages?beta=true`），其他分组 base-url 为 `/v1`。
目录保留单个 `factory/` 路由前缀，展示名为 `factory · model`。
未知模型需要先验证再添加文件白名单，不从截图猜测 API ID。
全部推理档位、图像、服务端内建搜索和 compaction 不在本次实测覆盖内，
不承诺它们都能通过该内部网关；官方订阅路线仍原样直连。
