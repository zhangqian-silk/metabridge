# 发布与 PR 检查

## 提交内容

提交源码、测试、无凭据配置模板、静态模型目录、部署脚本和文档。
不提交 `node_modules`、本机主配置、API/OAuth key、账户身份文件、日志、
`base_instructions.txt` 本机指令缓存、动态库或构建出的管理 HTML。
没有本机指令缓存时，bridge 使用代码中已有的最小默认指令。

`config/bridge/*.example.json` 与 `config/providers/*.example.json` 是模板，
`config/catalogs/*.catalog.json` 是可共享的模型元数据；
其他 `config/**/*.json` 和旧的 `providers/*.json` 路径默认不允许提交。
运行时仍使用 `~/.metabridge/` 下的私有配置；模板中的相对 `providers/` 引用
是用户目录路径，不是仓库目录。切勿用 `git add -f` 绕过忽略规则。
代码审查应分别检查 bridge、网关兼容、只读插件、页面 overlay 和部署配置。

## 离线检查

需要 Node.js 24（最低 20.9）和 Go 1.26：

```bash
npm ci
npm test
npm audit --omit=dev
node scripts/check-release-files.js
cd integrations/cpa/account-quota
go test -race ./...
go build -buildmode=c-shared -o /absolute/build/factory-quota.so .
```

`check-release-files.js` 检查 Git index 中的文件名和暂存内容，不显示匹配到的
秘密，只报告文件名与规则。它是补充检查，不替代人工审查和正式 secret scanning。
文件应先 stage 再运行；不能把已经进入 Git 历史的秘密仅从最新版本删除就算修复。

## 管理页构建

源码来自 `router-for-me/Cli-Proxy-API-Management-Center`，固定 commit：
`ee79a794526a30c03748a8864a9ac6589a31833b`。先在独立目录 checkout 此 commit，
不要覆盖已有工作目录。

```bash
node integrations/cpa/scripts/prepare-quota-ui.js /absolute/path/to/management-ui
cd /absolute/path/to/management-ui
bun install --frozen-lockfile
bun test tests/factoryQuota.test.ts tests/commandQuota.test.ts
bun run verify
```

使用管理页自身锁定的 Bun 1.3.14 / Node.js 24，不添加另一套依赖锁文件。
单文件输出为 `dist/index.html`，由安装器部署为 CPA 的 `management.html`。

已观察到固定版本的全量 Bun 测试存在一个冷却按钮 HTML 断言失败：
`cooldown section rendering > keeps the reset action contextual and exposes pending state`。
同 commit 的未修改基线全量测试也失败，单独运行对应测试通过。
不要删除/弱化上游测试；在 PR 中披露基线限制，并分别运行本次专项测试、lint、
type-check/build。UI ABI 或上游 commit 升级时需重新确认这一情况。

## 真实接口验证

推理验证脚本只在明确授权时使用 `--allow-inference`，会消耗对应账号额度。
只读额度查询不应发送模型推理请求。验证范围应包含：

- 官方订阅与第三方路由隔离，不自动回退到其他账号。
- Claude 摘要生成、检查点回放及工具往返。
- CPA 额度接口鉴权：未认证 401，合法管理凭据可查询，响应不含上游 key。
- 页面首开、手动刷新、失败状态、连接切换及未知额度值。

若浏览器远程调试要求用户授权，应等待授权，不能以静态组件测试代替完整浏览器验收。

## 合并

在独立分支提交，PR 指向仓库当前默认分支，不 force-push 默认分支。
合并前检查最新 head、CI、完整 diff、敏感文件排除及审查结论。
CI 分别验证 Node 核心、Go 额度插件和固定版本的管理页 overlay；
不会读取真实 key 或执行付费推理验证。
已部署的本机配置不自动被 Git 合并覆盖；后续部署应按组件分别执行。
