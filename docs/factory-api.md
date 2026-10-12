# Factory API、模型适配与额度查询

本文描述可复用的接口与配置方法，不记录某台机器已部署的账号、模型过滤、
路由策略、TTL、实时额度或验证结果。本机记录存放在 `~/.metabridge/docs/`，
维护方式见 [运行时文件归属](architecture.md#运行时记录与仓库文档)。

参考：

- https://docs.factory.com/api-reference.md
- https://docs.factory.com/openapi.json
- https://docs.factory.com/api-reference/organization.md
- https://docs.factory.com/api-reference/analytics.md

## 接口边界

Factory Public API 是组织、服务账号、Droid 会话等管理接口，不能直接当作
OpenAI Responses/Chat 或 Anthropic Messages 模型接口使用。
适配层不创建 Droid 会话、不启动 Droid agent、不读取 Droid 登录缓存。
模型调用使用独立的内部 LLM 网关；该网关不是公开稳定的 Public API 契约。

上游固定为 `https://api.factory.ai`，使用文件中的 Bearer API key，
拒绝重定向及客户端指定的上游 URL、组织、凭据覆盖。

## 私有配置

`config/providers/factory-quota.example.json` 是独立查询/代理配置模板，
不要加入 metabridge 的 `providerFiles`，也不要直接作为 CPA provider 配置。

```bash
mkdir -p ~/.config/cliproxyapi/quota
cp config/providers/factory-quota.example.json ~/.config/cliproxyapi/quota/factory.json
chmod 600 ~/.config/cliproxyapi/quota/factory.json
# 用编辑器将 API key 写入配置明确引用的私有 key 文件，不提交到仓库。
# 然后将该文件权限设为 0600。
node scripts/query-factory-quota.js
node scripts/query-factory-quota.js --config /absolute/path/factory.json
```

`auth.file` 相对配置文件解析，支持绝对路径和 `~/`。
Unix key 文件不允许 group/other 读取；不通过环境变量读取 key。
网络必须经过环境代理时，可在支持的 Node 版本设置 `NODE_USE_ENV_PROXY=1`；
环境变量只控制代理，不提供凭据。

## 只读额度接口

| 查询 | 路径 | 含义 |
| --- | --- | --- |
| 组织默认限额 | `/api/v0/organization/usage/limits/global` | 未设置个人覆盖时的每用户 Standard Credits 限额 |
| 个人覆盖 | `/api/v0/organization/usage/limits/users` | 默认限额和用户覆盖限额 |
| 当前凭据历史消费 | `/api/v1/analytics/cost/me/query` | `headline_daily` 按天返回消费 |
| 可选内部 billing | `/api/billing/limits` | Standard/Core 窗口利用率和额外用量余额 |

`globalLimit`、`userLimits`、`personalUsage`、`billingLimits` 可独立开关，
至少启用一个。旧配置未设置 `billingLimits` 时保持关闭。
组织限额可能因角色权限返回 403；个人 Analytics 需要组织启用对应能力。
`quota.userEmail` 只用于选择政策覆盖项，不证明它就是 key 的身份。
不把政策限额与历史消费相减成实时剩余额度。

组织限额/消费以 Factory Standard Credits 为单位，不是美元或原始 token。
`limit: null` 不代表订阅无限；个人覆盖的 null 继承默认限额，0 是有效值。
Analytics 使用 UTC 历史范围，最多 90 天、最早 2026-01-14、截至昨天；
默认取截至昨天所在月份的月初至昨天，不表示订阅账期。
可通过 `quota.usage.startDate/endDate` 指定历史范围。
日批处理数据不能用于实时余额或窗口重置倒计时。

内部 billing 不属于 Public OpenAPI，按响应严格解析：

- `limits.standard/core.fiveHour/weekly/monthly.usedPercent` 为使用百分比。
- `windowEnd` / `secondsRemaining` 为重置信息，缺失保持未知。
- `extraUsageBalanceCents` 为额外用量美元余额，不是订阅 credits 余额。
- `extraUsageAllowed` 不代表不限额。

缺失窗口不填零；缺少全部已知窗口或响应不合法时报告不可用。
公开接口未提供可验证的订阅绝对余额或 RPM/TPM 查询，不能推算。
401、403、429、网络错误和不合法响应均为 unavailable；部分成功保留有效结果。
合法空 Analytics 数据表示该历史范围消费为零。
不输出 key、上游错误体或无关组织成员列表。

查询脚本退出码：0 表示全部启用查询成功，1 表示部分或全部失败，
2 表示配置/凭据不可用。查询命令不会创建后台定时任务。

## 模型代理与 CPA

链路：客户端 → metabridge → CPA → 本机 Factory 适配层 → Factory LLM 网关。
CPA 负责协议转换，适配层只接收配置允许的原生模型/协议组合：

| CPA 分组 | 本机入口 | 上游路径 |
| --- | --- | --- |
| `codex` | `/v1/responses` | `/api/llm/o/v1/responses` |
| `claude` | `/v1/messages` | `/api/llm/a/v1/messages` |
| `openai-compatibility` | `/v1/chat/completions` | `/api/llm/o/v1/chat/completions` |

服务只监听 loopback，要求本机 Bearer key 与配置凭据一致。
`gateway.models` 决定允许的模型、协议和 `x-api-provider`；
`config/catalogs/factory-models.catalog.json` 提供候选元数据，不代表账号权限。
模型目录可见不证明可调用；内部网关及不同账号的兼容性需单独验证。

`gateway.instruction_mode`：

- `preserve`：探测/纯转换时原样保留指令。
- `fold_system_into_user`：探测选项，将 system/developer 文本折叠进 user，
  会改变指令优先级。
- `factory_prefix`：代理服务要求的模式，在原生指令位置补充 Factory 身份前缀，
  保留 developer、工具回合、缓存元数据和附件，但不能称为原样转发。

`gateway.client_version` 是显式的上游兼容版本，不是本适配层版本。
适配层不重试、不切账号、不执行工具、不保存请求正文。
保留上游 SSE 字节与错误状态；客户端断开即取消上游。
附件优化见 [Factory attachment transport](factory-attachments.md)。
凭据更换后需要重启对应代理，并重新生成该账号的 CPA 配置。

### 多账号与模型过滤

每个账号使用独立私有配置、key 文件、loopback 端口和服务实例。
配置内 `name` 仍为 `factory`；配置文件名使用 `factory.json` 或
`factory-<id>.json`，`<id>` 使用小写字母、数字及以单个连字符分隔的段。
各代理端口不得冲突。

```bash
# 对应代理应先启动并通过健康检查。
node scripts/configure-factory-cpa.js --activate
node scripts/configure-factory-cpa.js --activate --account factory-example
```

配置脚本只替换指定账号的三类 provider，保留其他账号、provider 和管理设置；
写入前创建 0600 备份，临时文件原子替换。
各账号拥有独立 provider 名称、base URL 和 Authorization，
共用 `factory/` 前缀时由 CPA 调度；余额不合并。
会话粘性、负载均衡及失败冷却由 CPA 私有配置控制，
不把某台机器的路由选择或 TTL 写入仓库默认值。
额度页仅查询展示，不按剩余额度参与调度。

metabridge 的 CPA provider 可用 `modelFilter.allow/deny` 控制对外模型目录和请求准入。
这是部署策略，应只编辑私有 `~/.metabridge/providers/cpa.json`，
不修改仓库模型元数据或共享模板来反映本机筛选结果。

### 部署与验证方法

`config/providers/cpa-factory.example.json` 是 CPA 片段，不能直接覆盖现有配置。
按本机 Node 安装位置调整服务单元后可使用：

```bash
NODE_USE_ENV_PROXY=1 node scripts/start-factory-proxy.js --config /absolute/path/factory.json
# 确认临时实例退出、端口空闲后再启用持久服务。
cp deploy/factory-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now factory-proxy.service
node scripts/configure-factory-cpa.js --activate
systemctl --user restart cliproxyapi metabridge
node sync-catalog.js ~/.codex/model-catalogs/custom.json http://127.0.0.1:8318/v1/models
```

上述端口和服务名是示例，按私有配置调整。
`configure-factory-models.js --activate` 使用静态候选目录更新默认账号模型列表，
保留 key 引用和 quota 配置并备份，不发送推理请求。
真实验证需要显式授权，会消耗额度：

```bash
node scripts/verify-factory-codex.js --allow-inference factory/your-configured-model
```

验证只授权读取私有 fixture 并完成工具结果回放，不延续用户历史任务，
不复制登录 token。HTTP 200 或目录可见不等于所有能力均通过验证。
测试结果、实际模型权限和部署状态写入本机运行记录，不维护在本文。

## CPA 额度外挂

`integrations/cpa/account-quota` 是 CPA ABI 1 / JSON schema 6 的 Go 动态库，
只声明 `quota_provider` / `management_api`，不参与模型执行、登录或路由。
插件保留 `factory-quota` 标识和产物名兼容已有安装，支持 Factory / Command Code。
接口需 CPA 管理鉴权，不接受浏览器指定的上游 URL、路径、账号或 key：

- `/v0/management/plugins/factory-quota/account`：默认账号，保留兼容。
- `/v0/management/plugins/factory-quota/accounts`：独立账号列表与额度。

多账号入口在固定私有 quota 目录发现严格命名的配置，最多 16 个账号，
配置备份不参与发现；并行读取各自本机 `/v1/quota`。
查询强制无代理的 loopback HTTP client、拒绝重定向、25 秒超时和 1 MiB 响应上限。
浏览器只收到本地账号标签和规范化额度，不收到 key 或上游账号身份。
一个账号失败不隐藏其他账号的有效结果，不把失败填成零。

每个代理只查询 billing，成功缓存 30 秒并合并并发请求；
失败不缓存、不冒充旧成功数据。页面首开查询和手动刷新，无后台轮询。
Standard / Droid Core 的 5 小时、每周、每月额度与重置时间分别显示，
两种类型使用独立额度，同一类型内的模型共享对应额度，不按模型重复计算。
Droid Core 卡片标明适用的 Core 模型示例；接口的 `displayName: "Core"` 保持兼容。
额外美元余额单独显示，不与订阅额度合并；缺失窗口和重置时间保持未知。
管理连接切换时隔离请求。

构建和安装示例：

```bash
# 在 integrations/cpa/account-quota 目录。
go test ./...
go build -buildmode=c-shared -o /absolute/build/factory-quota.so .
# 在项目根目录，对固定版本的管理页 checkout 应用 overlay。
node integrations/cpa/scripts/prepare-quota-ui.js /absolute/path/to/management-ui
# 在管理页 checkout 中使用其 packageManager 指定的 Bun 版本。
bun install --frozen-lockfile
bun test tests/factoryQuota.test.ts tests/commandQuota.test.ts
bun run lint
bun run build
# 在项目根目录安装产物。
node integrations/cpa/scripts/install-account-quota.js --activate \
  --plugin /absolute/build/factory-quota.so \
  --web /absolute/path/to/management-ui/dist/index.html
systemctl --user restart cliproxyapi
```

overlay 只接受准备脚本固定的上游 commit，升级需要重新审查。
安装器保留配置、插件和管理 HTML 备份，关闭管理页自动更新，
避免官方构建覆盖定制卡片；不修改模型 provider、管理密码或监听地址。
后台接口测试、静态渲染、类型检查、构建和登录后浏览器验证应分别记录，
不能用其中一项代替其他验证。
