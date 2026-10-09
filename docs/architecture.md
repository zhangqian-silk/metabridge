# 架构、插件与配置归属

## 当前推荐链路

```text
Codex
  └─ metabridge :8318（默认只监听 loopback）
      ├─ 官方模型 → 官方 Codex 订阅接口
      ├─ 原生 API / gateway → 配置指定的上游（direct）
      └─ CPA 托管模型 → CPA :8317（cpa）
          ├─ cmd/* → Command Code
          ├─ gateway/* → Responses 网关
          ├─ fusecode/* → FuseCode Claude
          └─ factory/* → Factory 适配层 :8319 → Factory 网关

CPA 管理页面 → CPA 管理鉴权 → 账号额度插件
  ├─ Factory → 本机 Factory 适配层 → billing 接口
  └─ Command Code → 固定的 Command Code billing 接口
```

## Provider 策略与可选外挂

`via: "direct" | "cpa"` 明确下一跳的归属，实际地址由 `base_url` 指定。
此字段不决定模型路由、不创建 CPA、不复制上游凭据；模型选择仍由
`prefix` / `routeModels` 和兜底规则决定，不自动跨链路重试。

`requestMode` 与链路无关。新配置默认 `passthrough`，保留 JSON 转发、鉴权和
模型路由，不启用旧工具别名、sanitize 或厂商适配。只有显式 `adapt` 才使用旧兼容路径。
官方 `codex-subscription` 只能 `direct` + `passthrough`。
CPA provider 只能使用 Responses 协议；Claude/Chat 等转换交给 CPA。

`compaction` 独立于普通请求处理：

- `{ "mode": "passthrough" }`：压缩请求和不透明检查点交给上游。
- `{ "mode": "local", "stripImages": true }`：此 provider 的所有模型使用同模型摘要/检查点回放。
- `local` 加 `models`：仅匹配模型启用，其余透传；匹配去掉 bridge 前缀后的 ID。

省略 `via` 的旧文件保留原有 `adapt`/前缀压缩行为；显式 `via` 的文件默认
请求和压缩均透传。明确 `compaction` 后不再使用前缀隐式压缩规则。
不能仅因为模型支持 Responses 推理就假定它支持原生 Codex 压缩；能力由配置声明。
`/healthz` 提供有效策略供运维确认，不输出凭据。

CPA 账号额度插件、管理页 overlay 及其安装、升级由独立外挂层管理：
不导入 bridge 主进程，不参与请求路由，不决定压缩策略。
未部署外挂时，官方/直连/CPA 推理链路仍可使用。
见 `integrations/README.md`；不新建桥接层插件系统或重复 CPA 管理 API。

以上端口是示例默认值，不代表应将所有服务暴露到内网。要开放 CPA 管理页面，
应显式配置监听地址、远程管理和安全管理密码。不要沿用测试密码。

## 代码边界

```text
server.js / sync-catalog.js       兼容启动入口
src/
  bridge/                        HTTP 服务编排、路由和目录合并
  core/                          文件配置、通用压缩、工具名兼容
  adapters/{openai,command-code,factory}/
                                 各上游协议和能力适配
  catalog/                       客户端模型目录同步
config/{bridge,providers,catalogs}/
                                 部署示例及静态目录，不存真实凭据
integrations/cpa/
  account-quota/                 CPA Go 额度插件
  quota-ui/                      CPA 管理页 overlay
  scripts/                       外挂安装和 overlay 构建准备
scripts/ / deploy/ / test/        运维命令、服务单元、回归验证
```

依赖方向：编排层使用核心与适配器；核心只依赖核心；适配器不导入编排层。
`src/` 不加载 CPA 外挂或部署示例，运行时默认值由对应源码模块持有。
`test/architecture.test.js` 检查相对模块依赖及兼容入口，防止目录重新混用。
模块分层不要求额外进程或新的插件框架。

| 组件 | 位置 | 负责 | 不负责 |
| --- | --- | --- | --- |
| bridge | `src/bridge/server.js` / `src/core/provider-config.js` | 模型目录合并、展示顺序、路由、文件凭据解析 | 第三方账号登录、账号池、额度计费 |
| 官方订阅转发 | `src/adapters/openai/subscription.js` | 当前客户端 OAuth 与允许的头字段透传 | 复制登录文件、刷新 token、转成 Platform API key |
| 压缩兼容 | `src/core/compaction.js` | 普通摘要请求转成 `mb-cmp1` 检查点，并回放新窗口 | 对所有请求截断历史、替官方订阅解密 |
| Factory 适配层 | `src/adapters/factory/server.js` / `src/adapters/factory/gateway.js` / `src/adapters/factory/attachments.js` / `src/adapters/factory/instructions.js` | 网关协议边界、身份字段、出站图像优化 | 启动 Droid agent、修改原始附件、接管 Codex 工具循环 |
| Factory 查询与转换 | `src/adapters/factory/api.js` / `src/adapters/factory/quota.js` | 只读额度查询及 CPA 展示数据规范化 | 充值、重置额度、模型推理 |
| CPA 账号额度插件 | `integrations/cpa/account-quota/` | Go shared library；注册只读 management/quota 接口 | 转换推理协议、修改 provider、读取浏览器提供的上游 key |
| CPA 管理页 overlay | `integrations/cpa/quota-ui/` | React 卡片、翻译、刷新/错误状态和连接切换隔离 | 独立服务、保存第三方凭据 |
| 历史适配器 | `src/adapters/command-code/client.js` / `src/adapters/command-code/search.js` / `src/core/tool-names.js` | 兼容旧直连配置 | 在推荐的 CPA passthrough 路径自动启用 |

Go 源码位于 `integrations/cpa/account-quota/`；插件 ID、文件名
`factory-quota.so` 和 `/v0/management/plugins/factory-quota/*` 路径保持兼容，
避免升级导致配置和页面失联。插件支持 Factory 和 Command Code。
目录改名不是额外进程或第二套插件。

## 配置边界

| 配置/数据 | 仓库模板 | 运行时位置 | 所有者 |
| --- | --- | --- | --- |
| bridge 主配置 | `config/bridge/config.hybrid.example.json` | `~/.metabridge/config.json` | metabridge |
| bridge provider | `config/providers/*.example.json` | `~/.metabridge/providers/*.json` | metabridge |
| 本机部署/验证记录 | 无部署状态模板 | `~/.metabridge/docs/*.md` | 操作者 |
| CPA provider、上游 key、账号池、插件开关 | CPA 模板片段与显式迁移脚本 | `~/.config/cliproxyapi/config.json` | CPA |
| bridge → CPA 访问密钥 | 仅 `auth.file` 引用 | `~/.metabridge/cpa-api-key` | 本机部署 |
| Factory 网关与额度配置 | `config/providers/factory-quota.example.json` | `~/.config/cliproxyapi/quota/factory.json` | Factory 适配层 |
| Factory 凭据 | 仅 `auth.file` 引用 | 上述配置引用的私有 key 文件 | 本机部署 |
| Command Code 额度凭据 | 无重复 key 文件 | CPA 中唯一的 `command-code` provider key | CPA |
| Factory 模型目录 | `config/catalogs/factory-models.catalog.json` | 经显式配置脚本导入 | 静态元数据，不含凭据 |
| systemd 单元 | `deploy/*.service` / `*.timer` | `~/.config/systemd/user/` | 运维 |
| 管理页与动态库 | 只提交 overlay / Go 源码 | CPA 的 `static/management.html` / `plugins/factory-quota.so` | 构建产物 |

`base_url`、`wire_api`、过滤规则、正则、模型前缀及展示优先级都属于配置；
不是把用户 URL、key 或模型清单写入插件源码。真实配置文件和凭据使用 0600，
用户目录 0700，不提交到 Git。

Factory 与 Command Code 的额度接口实现属于插件/适配代码。查询使用固定、
已验证的账号接口和服务端配置来源；不允许浏览器替换目标 URL。
当前 Command Code 多 key 会显式失败，不猜测账号、不错误合并余额。

## 运行时记录与仓库文档

仓库 `docs/` 描述接口、配置语义、限制和可复用的部署/验证步骤，不存放
某台机器的账号数量、启用模型、监听状态、路由策略、TTL 或额度快照。
这些事实只写入私有运行记录；配置修改不需要同步修改仓库说明或模板。

`scripts/write-runtime-note.js <name>` 从 stdin 接受操作者准备的 Markdown，
写入 `~/.metabridge/docs/<name>.md`，与 cwd 和 `MB_CONFIG_FILE` 的位置无关。
默认拒绝覆盖，`--replace` 才允许原子替换，并保留 0600 备份。
目录为 0700；拒绝路径穿越、符号链接目标、超过 256 KiB 的内容及已知凭据形态。
它不读取账号配置、不查询上游、不由服务或配置命令自动调用。
记录不得包含凭据，形态检查不能保证发现所有秘密。
`.metabridge/` 已被 Git 忽略，发布检查也拒绝此目录。

bridge 主配置仍可通过 `MB_CONFIG_FILE` 指定；
此变量不会把运行记录重定向到配置所在目录或仓库。
CPA 自有配置继续由 `~/.config/cliproxyapi/` 管理，不迁移凭据或改变服务链路。

## 压缩与附件边界

默认 CPA 推理保持 passthrough。模板为 `factory/claude-*` 和
`fusecode/claude-*` 显式开启本地压缩例外：移除摘要请求的工具定义和历史图像，
调用同一个模型总结，包装成检查点。后续请求仅回放摘要与新消息。
未完成、截断或畸形摘要不会安装为检查点。

Factory 出站图像优化只改变发送副本，不修改用户原文件或 Codex 历史。
不能等同于 PDF、音频、视频的通用压缩，也不会绕过上游自身的请求限制。
详见 `cpa-compaction.md` 和 `factory-attachments.md`。

## 部署与回滚

- 配置变更：修改对应私有配置，再重启其所属服务；不重建插件。
- 插件变更：在 `integrations/cpa/account-quota` 执行 Go 测试与 shared library 构建。
- 页面变更：向固定的 CPA 管理页 commit 应用 overlay，执行 Bun 测试、lint、构建。
- 插件/页面部署：使用 `integrations/cpa/scripts/install-account-quota.js --activate` 安装备份后的产物，
  重启 CPA；不改变监听地址、管理密码或模型 provider。
- 插件 ID 保持 `factory-quota`。升级时安装到相同位置，不新建重复插件。
- 产物回滚：使用安装器保存的配置、动态库及 HTML 备份，重启 CPA。
- 已有 `mb-cmp1` 会话需要保留检查点回放适配，不能简单删掉压缩策略后继续同一会话。

上游 CPA 管理页不随仓库 vendoring；只维护固定 commit 的 overlay。
管理页自动更新需保持关闭，升级时先重新审查 overlay 与 ABI，再手动重建。
