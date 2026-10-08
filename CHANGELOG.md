# Changelog

## Unreleased — 项目分层

- 源码按 `src/bridge`、`src/core`、`src/adapters` 与 `src/catalog` 归属整理。
- 部署模板集中到 `config/`，运行时默认规则不再导入部署示例。
- CPA 插件、管理页 overlay 及构建安装脚本集中到 `integrations/cpa/`。
- 根目录服务/目录同步入口、旧外挂命令入口及私有运行配置路径保持兼容。
- 新增模块依赖边界回归测试，同步更新 CI、发布审计和分层文档。

## Unreleased — Provider 策略分离

- `via` 明确原生直连或 CPA 接入，不再按 provider 名称猜测链路。
- 请求模式与压缩模式独立；新链路默认透传，可为整个 provider 或指定模型启用本地压缩。
- 官方订阅强制直连透传，旧配置保留兼容；健康检查展示策略。
- 新增混合链路及直连本地压缩模板，普通 gateway 模板改为厂商无关配置。
- CPA 插件、管理页构建和安装继续作为独立可选外挂，不加载到 bridge 进程。

## Unreleased — 首次完整项目导入

### bridge 与配置

- 官方 Codex 订阅直接转发，CPA 托管第三方 provider；模型目录合并并保留路由隔离。
- 文件配置支持 `base_url` / `wire_api`、凭据文件、展示前缀、优先级与正则白/黑名单。
- CPA 普通请求 passthrough；Factory/FuseCode Claude 使用显式本地摘要与检查点回放。
- 旧 Command Code、gateway、工具别名及搜索适配保留为旧配置兼容，不自动用于 CPA 路径。

### Factory 网关

- 通过本机适配层接入 Factory 模型，不启动 Droid agent。
- 出站图片按配置优化体积；保留原始历史/文件，动画与未支持附件格式维持原样。
- 公开配置使用可提交的 `factory-models.catalog.json`，避免模型目录被忽略后缺失。

### CPA 插件与管理页

- `integrations/cpa/account-quota` 提供只读 Factory / Command Code 账号额度插件。
- 保留旧 `factory-quota` 插件 ID、动态库文件名和接口路径以兼容现有部署。
- `integrations/cpa/quota-ui` 为固定 commit 的管理页提供额度卡片 overlay。
- Command Code 展示窗口用量、余额池和订阅周期；未知值不伪造为零。
- 管理接口受 CPA 鉴权保护，第三方凭据不下发到浏览器，插件不改模型路由。

### 发布与验证

- 区分源码、模板、私有运行配置和编译产物，补充架构及发布/回滚文档。
- 新增提交文件审计与 Node / Go / 管理页 overlay CI，不调用真实付费推理接口。
- 管理页专项测试、lint、构建可验证；固定上游版本的全量测试基线限制单独披露。
