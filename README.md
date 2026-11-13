# GEO 采集助手

让 Agent 通过本机 HTTP 或 CLI 操作已登录的 AI 对话网页（Perplexity、豆包），采集回答与可见引用。Chrome 侧栏提供相同的人工采集入口、任务查看、定位检查和报告导出。

版本由根目录 `manifest.json` 提供。当前支持 Perplexity 与豆包，平台以注册表形式定义在 `shared/protocol.js`。Perplexity 的扩展加载、采集链路、PNG 截图和恢复已在独立 Chromium 与本地测试页上验证；豆包适配器依据真机 DOM 锚点实现，需在已登录浏览器中验收。

## 环境与启动

- Node.js 24.13 或更高版本，低于 27；开发验证环境为 Node 26.12。
- Chrome 120 或更高版本。
- 已登录的 Perplexity 账号。

在项目根目录执行：

```bash
npm ci
./geo up
```

服务以前台进程运行，默认地址为 `http://127.0.0.1:8787`，按 `Ctrl+C` 停止。

在 Chrome 的 `chrome://extensions` 中开启开发者模式，选择“加载已解压的扩展程序”，加载本项目根目录。点击扩展图标打开侧栏，直接点击“连接”。CLI 与扩展均直接连接本机服务，无需认证或配对。

```bash
./geo status
./geo platforms
```

`extension.connected` 和 `extension.ready` 均为 `true` 后可以执行采集。服务在线、扩展连接和真实采集成功是不同状态。

服务数据默认保存到 `~/.geo-bridge`。可通过环境变量切换数据目录和端口；CLI、服务及侧栏必须使用同一配置：

```bash
export GEO_BRIDGE_HOME=/absolute/path/to/geo-data
export GEO_BRIDGE_PORT=8788
./geo up
```

## Agent 调用

帮助与文档在服务关闭时仍可读取：

```bash
./geo help
./geo docs connection
./geo docs run
```

新建标签页、提问并采集：

```bash
./geo run --platform perplexity --keyword "GEO 是什么" --wait 0 --idempotency-key research-001
```

使用响应中的真实任务 ID 查询：

```bash
./geo task <taskId>
./geo result <taskId>
./geo result <taskId> --view text --max-chars 4000
./geo result <taskId> --view citations
./geo events <taskId> --since 0 --wait 10000
```

`--wait` 的单位是毫秒，默认 0，只返回任务入口。可以指定 `--wait 240000` 等待终态；CLI 等待超时不取消页面任务。`--no-focus` 不主动前置标签页，不保证后台页面不会被浏览器冻结。

采集已有对话，不提交问题：

```bash
./geo collect --platform perplexity --wait 0
./geo collect --platform perplexity --tab-id 123 --no-focus --wait 0
```

多个 Perplexity 标签页时返回 `ambiguous_tabs` 和候选，必须用实际 `tabId` 指定目标。

## 检查与修复

```bash
./geo inspect --platform perplexity --field answer --tab-id 123 --wait 10000
./geo dom --platform perplexity --field answer --tab-id 123 --max-chars 6000 --wait 10000
./geo fix --platform perplexity --field input --selector 'textarea' --tab-id 123 --test-only --wait 10000
./geo result <testTaskId> --view data
```

保存时使用实测结果中的真实 `revision`，服务会重新验证页面并检查配置版本：

```bash
./geo fix --platform perplexity --field input --selector 'textarea' --tab-id 123 --save --expected-revision 0 --wait 10000
./geo anchors --wait 10000
```

`input`、`send`、`question`、`answer` 为四种角色。配置只修复定位，不自动适配新的生成状态或来源弹层交互。多个候选、错误轮次、过宽容器不会当作成功结果。

任务挂起时读取响应给出的诊断链接：

```bash
./geo diagnostic <taskId>
./geo diagnostic <taskId> --view full
```

## 停止、截图与导出

```bash
./geo stop --task-id <taskId> --wait 15000
./geo shot --platform perplexity --tab-id 123 --wait 10000
./geo result <shotTaskId> --view screenshot --out /tmp/geo-answer.png
```

停止命令只停止插件后续操作，不点击网站停止生成按钮。未获得 runner 的结束确认时，原任务保留执行归属。

截图使用 `chrome.debugger`，扩展因此声明 debugger 权限。截图不主动前置或滚动页面，DevTools、页面布局或虚拟化内容可能导致截图失败。只有截图成功才提供 PNG 下载链接。

侧栏可将选中结果导出为 JSON 和独立 HTML 报告。HTML 报告使用文本渲染，不执行网页采集到的 HTML。正文、原始回答 HTML、剪枝 QA DOM、引用和诊断也可通过结果视图获取。

## 能力与限制

| 能力 | MVP 范围 |
|---|---|
| 平台 | Perplexity（真实网站待验收）、豆包（真机锚点，待验收） |
| 采集 | 新对话提问；已有对话最后一轮采集 |
| 引用 | 回答内可见外部链接，不自动展开来源弹层；明确标记非完整来源列表 |
| 完成判断 | 当前轮次正文、生成/完成信号和稳定窗口共同验证 |
| 故障恢复 | 后台重连原 runner；上下文消失时中断，不自动重复提问 |
| 数据 | SQLite 和文件保存 bridge 结果，扩展 IndexedDB 保存本地结果与待同步事件 |
| 修复 | 单角色实测、显式保存、版本冲突检查、最近 20 次配置历史 |
| 截图 | 单独 shot 动作，失败不影响已有正文 |
| 人工入口 | 侧栏；采集需 bridge 在线，与 Agent 共用任务机制 |
| 暂未提供 | 批量任务、完整来源弹层采集、会话分组与 ZIP 打包 |

网页“点击发送”与本地数据库不是同一个事务。提交结果不确定时中断并报告，不自动重试发送。页面停止变化不直接代表回答完成；超时保存可用的部分正文，并标记 `complete: false`。

本机服务同时使用一个扩展连接。目录迁移或扩展卸载前，先停止原任务并备份数据。

## 开发验证

```bash
npm run check
npm test
```

测试使用临时目录、本机回环端口、真实 bridge/扩展/runner 代码及模拟 DOM、Chrome API 和 IndexedDB。不会打开或控制用户浏览器。

实际浏览器自动化测试需要 Playwright Chromium 和系统 `openssl`：

```bash
npm exec -- playwright install chromium
npm run test:browser
```

浏览器测试使用临时用户目录、无界面 Chromium 和本机 HTTPS 测试页。域名映射只作用于该测试浏览器进程；不使用用户账号。测试覆盖扩展真实加载、界面命令、采集与引用、PNG 下载、后台终止恢复、页面刷新中断和 HTML 报告下载。

本地测试页不代表当前 Perplexity 页面适配已通过。真实验收步骤见 [MVP 验收清单](docs/MVP验收清单.md)，架构见 [开发前技术调研与架构设计](docs/开发前技术调研与架构设计.md)。
