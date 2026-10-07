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

| 组件 | 位置 | 负责 | 不负责 |
| --- | --- | --- | --- |
| bridge | 根目录 `server.js` / `provider-config.js` | 模型目录合并、展示顺序、路由、文件凭据解析 | 第三方账号登录、账号池、额度计费 |
| 官方订阅转发 | `codex-subscription.js` | 当前客户端 OAuth 与允许的头字段透传 | 复制登录文件、刷新 token、转成 Platform API key |
| 压缩兼容 | `compaction.js` | 普通摘要请求转成 `mb-cmp1` 检查点，并回放新窗口 | 对所有请求截断历史、替官方订阅解密 |
| Factory 适配层 | `factory-proxy.js` / `factory-gateway.js` / `factory-attachments.js` / `factory-instructions.js` | 网关协议边界、身份字段、出站图像优化 | 启动 Droid agent、修改原始附件、接管 Codex 工具循环 |
| Factory 查询与转换 | `factory-api.js` / `factory-quota-cpa.js` | 只读额度查询及 CPA 展示数据规范化 | 充值、重置额度、模型推理 |
| CPA 账号额度插件 | `integrations/cpa-account-quota/` | Go shared library；注册只读 management/quota 接口 | 转换推理协议、修改 provider、读取浏览器提供的上游 key |
| CPA 管理页 overlay | `integrations/cpa-quota-ui/` | React 卡片、翻译、刷新/错误状态和连接切换隔离 | 独立服务、保存第三方凭据 |
| 历史适配器 | `command-code.js` / `web-search.js` / `tool-names.js` | 兼容旧直连配置 | 在推荐的 CPA passthrough 路径自动启用 |

Go 源码目录改名为 `cpa-account-quota`，但已部署的插件 ID、文件名
`factory-quota.so` 和 `/v0/management/plugins/factory-quota/*` 路径保持兼容，
避免升级导致配置和页面失联。插件支持 Factory 和 Command Code。
目录改名不是额外进程或第二套插件。

## 配置边界

| 配置/数据 | 仓库模板 | 运行时位置 | 所有者 |
| --- | --- | --- | --- |
| bridge 主配置 | `config.hybrid.example.json` | `~/.metabridge/config.json` | metabridge |
| bridge provider | `providers/*.example.json` | `~/.metabridge/providers/*.json` | metabridge |
| CPA provider、上游 key、账号池、插件开关 | CPA 模板片段与显式迁移脚本 | `~/.config/cliproxyapi/config.json` | CPA |
| bridge → CPA 访问密钥 | 仅 `auth.file` 引用 | `~/.metabridge/cpa-api-key` | 本机部署 |
| Factory 网关与额度配置 | `providers/factory-quota.example.json` | `~/.config/cliproxyapi/quota/factory.json` | Factory 适配层 |
| Factory 凭据 | 仅 `auth.file` 引用 | 上述配置引用的私有 key 文件 | 本机部署 |
| Command Code 额度凭据 | 无重复 key 文件 | CPA 中唯一的 `command-code` provider key | CPA |
| Factory 模型目录 | `providers/factory-models.catalog.json` | 经显式配置脚本导入 | 静态元数据，不含凭据 |
| systemd 单元 | `deploy/*.service` / `*.timer` | `~/.config/systemd/user/` | 运维 |
| 管理页与动态库 | 只提交 overlay / Go 源码 | CPA 的 `static/management.html` / `plugins/factory-quota.so` | 构建产物 |

`base_url`、`wire_api`、过滤规则、正则、模型前缀及展示优先级都属于配置；
不是把用户 URL、key 或模型清单写入插件源码。真实配置文件和凭据使用 0600，
用户目录 0700，不提交到 Git。

Factory 与 Command Code 的额度接口实现属于插件/适配代码。查询使用固定、
已验证的账号接口和服务端配置来源；不允许浏览器替换目标 URL。
当前 Command Code 多 key 会显式失败，不猜测账号、不错误合并余额。

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
- 插件变更：在 `integrations/cpa-account-quota` 执行 Go 测试与 shared library 构建。
- 页面变更：向固定的 CPA 管理页 commit 应用 overlay，执行 Bun 测试、lint、构建。
- 插件/页面部署：使用 `scripts/install-factory-quota.js --activate` 安装备份后的产物，
  重启 CPA；不改变监听地址、管理密码或模型 provider。
- 插件 ID 保持 `factory-quota`。升级时安装到相同位置，不新建重复插件。
- 产物回滚：使用安装器保存的配置、动态库及 HTML 备份，重启 CPA。
- 已有 `mb-cmp1` 会话需要保留检查点回放适配，不能简单删掉压缩策略后继续同一会话。

上游 CPA 管理页不随仓库 vendoring；只维护固定 commit 的 overlay。
管理页自动更新需保持关闭，升级时先重新审查 overlay 与 ABI，再手动重建。
