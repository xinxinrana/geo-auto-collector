# GEO 自动采集插件 v0.3.0

发布日期:2026-07-21
Chrome Manifest V3 扩展,面向个人 GEO(Generative Engine Optimization)检测。

> **合规约束**:采集结果仅用于用户自己的内容表现分析,不绕过平台权限或访问限制。所有操作模拟人工节奏,不高并发、不批量刷。

---

## v0.3 变更(本次)

### 新增平台(3 家)

| 平台 | 域名 | 全流程 | 采集当前页 | DOM 侦查 |
|---|---|---|---|---|
| 豆包 | doubao.com | ✅ | ✅ | ✅ |
| 元宝 | yuanbao.tencent.com | ✅ | ✅ | ✅ |
| Kimi | kimi.com | ✅ | ✅ | ✅ |

至此共 **7 家平台**(旧 4 + 新 3),其中 Claude 因未登录跳过。

### 精准 QA 节点定位

采集不再依赖"全局最后一条 markdown 类"这类通用猜测,而是基于**开发时侦查文档**的平台特化选择器锚定"最后一对 QA(问题气泡 + 回答节点)"。

各平台锚点(详见 `docs/adapters/`):

| 平台 | QA 边界选择器 | 用户识别 | 助手识别 | 答案文本 |
|---|---|---|---|---|
| Gemini | `.conversation-container` | `user-query` | `model-response` | `.markdown-main-panel` |
| ChatGPT | `[data-turn-id-container]` | `data-message-author-role=user` | `data-message-author-role=assistant` | `.markdown.prose` |
| Perplexity | `main .focus\:outline-none div.flex.flex-col.gap-y-md` | 子节点 [0] | 子节点 [1] | `.prose.dark:prose-invert` |
| 豆包 | `.list_items` | `.bg-g-send-msg-bubble-bg` | 其他 `.v_list_row` | `.md-box-root` |
| 元宝 | `.agent-chat__list__item__content` | `.agent-chat__bubble--human` | `.agent-chat__bubble--ai` | `.hyc-common-markdown`(最后一个,排除 CoT) |
| Kimi | `.chat-content-list` | `.chat-content-item-user` | `.chat-content-item-assistant` | `.segment-content-box` |

### 发送/停止按钮全部完成侦查

| 平台 | 发送按钮 | 停止按钮 | 状态切换机制 |
|---|---|---|---|
| Gemini | `button[aria-label*="Send" i]` | `button[aria-label*="Stop" i]` | 独立按钮切换 |
| ChatGPT | `button[data-testid=send-button]` | `[data-testid=stop-button]` | 独立按钮切换 |
| Perplexity | `button[aria-label="Submit"]` | `button[aria-label^="Stop response"]` | **同位置替换** (aria 变化) |
| 豆包 | button 内 svg 有 `.text-g-send-msg-btn-text` | `div.size-34.rounded-full` (svg path 以 `M12 0.5C18` 开头) | **同位置替换** |
| 元宝 | `a[class*="send-btn"]` 内 `.icon-send` | 同上 `a[class*=send-btn]` 内 `<svg><rect/>` | **图标切换**(同一个 a) |
| Kimi | `.send-button-container:not(.disabled)` | `.send-button-container.stop` | **class 切换**(同一个 div) |

### 引用扫描限定 QA 节点内

`common.js` 的 `extractCitations(opts)` 现在接受 `root` 参数;所有 adapter 调用时传 `qa.qaAncestor` 或 `qa.assistantItem`,避免扫到 sidebar / nav 里的历史外链。

### QA 节点截图(替代整页滚动)

新增 `src/lib/screenshot.js` 的 `captureQANode(tabId, windowId, selector)`:
1. adapter 返回 `qaSelector`
2. SW 滚动 QA 节点入视区
3. `chrome.tabs.captureVisibleTab` 拍一张 → OffscreenCanvas 按节点 rect 裁剪
4. 若节点高 > clientHeight,继续滚动分段拼接
5. 失败时静默退化到旧的 `captureFullPage`

**优势**:样式还原 100%(直接浏览器渲染),不用引入 html2canvas(~180KB + CSP 白名单)。

### 输入方法适配到各平台框架

- **豆包(React textarea)**:`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set` 触发 React 受控组件
- **元宝(Quill)**:`document.execCommand('insertText')` 或直接 innerHTML 都可
- **Kimi(Lexical)**:标准 `execCommand('insertText')`
- **Perplexity(contenteditable)**:标准 `execCommand('insertText')`

### 侦查工具(不进插件打包)

- [`dev/cdp.js`](../dev/cdp.js) — 极简 CDP 客户端(Node 18+ 内置 WebSocket)
- [`dev/probe-dom.js`](../dev/probe-dom.js) — 全流程侦查(输入→发送→等答案→分析)
- [`dev/probe-collect.js`](../dev/probe-collect.js) — 采集模式(已加载的对话页)
- [`dev/probe-buttons.js`](../dev/probe-buttons.js) — 专抓发送/停止按钮
- [`dev/verify-adapters.js`](../dev/verify-adapters.js) — 直接把 adapter 注入调试页面验证 collect 入口
- [`dev/snapshots/`](../dev/snapshots/) — 保留 6 个平台的 HTML 快照 + 分析 report

### DOM 侦查文档

`docs/adapters/` 目录下一平台一文档,记录:
- 平台栈 (React/Vue/Angular/Next.js)
- DOM 骨架(树形图)
- 精确选择器表(生产 adapter 用)
- 忽略字段(易变的构建 hash / 埋点属性)
- 输入方式(框架特化)
- 发送 / 停止按钮识别
- 引用来源特点
- 关键改造点

---

# GEO 自动采集插件 v0.2.0

发布日期:2026-07-21
Chrome Manifest V3 扩展,面向个人 GEO(Generative Engine Optimization)检测。

> **合规约束**:采集结果仅用于用户自己的内容表现分析,不绕过平台权限或访问限制。所有操作模拟人工节奏,不高并发、不批量刷。

---

## 一、当前能力总览

### 1.1 支持的 AI 平台(4 家)

| 平台 | 域名 | 全流程入口 | 采集当前页 | 备注 |
|---|---|---|---|---|
| Perplexity | perplexity.ai | ✅ | ✅ | 首发平台,选择器最稳 |
| ChatGPT | chatgpt.com / chat.openai.com | ✅ | ✅ | v0.2 新增 |
| Gemini | gemini.google.com | ✅ | ✅ | v0.2 新增(通过 CDP 实测调好) |
| Claude | claude.ai | ✅ | ⚠️ 未实测 | v0.2 新增,选择器基于常规约定 |
