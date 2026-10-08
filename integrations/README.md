# CPA 可选外挂

这里的扩展不属于 metabridge provider 推理链路。bridge 不加载 Go 动态库、
不托管 CPA 管理页面，也不要求安装这些扩展才能连接 CPA。

| 目录 | 宿主 | 职责 |
| --- | --- | --- |
| `cpa/account-quota/` | CPA 插件加载器 | Factory / Command Code 只读额度查询 |
| `cpa/quota-ui/` | CPA 上游管理页 | 额度卡片、刷新及错误展示 |
| `cpa/scripts/` | 运维命令 | 外挂安装、管理页 overlay 构建准备 |

provider 地址、模型映射、账号池和密钥由 CPA 私有配置管理；
bridge 文件仅声明到 CPA 的地址、访问凭据和本地处理策略。
不要把某个 gateway 的 URL/API key 写进外挂或 bridge 源码。

外挂部署是独立操作：

1. 构建 `integrations/cpa/account-quota/` Go shared library。
2. 用 `integrations/cpa/scripts/prepare-quota-ui.js` 对固定版本的管理页应用 overlay，再构建。
3. 用 `integrations/cpa/scripts/install-account-quota.js --activate --plugin /absolute/plugin.so --web /absolute/index.html`
   备份并安装产物，随后重启 CPA。

安装器不修改 provider、监听地址或管理密码。定制页面需要关闭自动覆盖更新。
插件 ID、产物名和 API 路径仍保留 `factory-quota`，兼容已有部署。
不在此新增一套插件管理服务；插件开关与加载继续由 CPA 负责。
