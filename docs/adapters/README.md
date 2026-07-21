# AI 平台 DOM 侦查方法论与状态

面向 v0.3 的**「精准 QA 节点定位」重构**的前置工作。目标:每个平台在**开发时**摸清 DOM 结构,把「最后一轮 QA 的 DOM 边界」硬编码进 adapter;运行时以「问题文本反查」作 fallback。

## 为什么需要这轮侦查

v0.2 的问题:
1. **答案容器抓不准** —— Gemini 早期版本用逗号组合选择器,`querySelectorAll` 按文档顺序返回,抢到了空的 footer。
2. **引用扫描抓全页** —— `extractCitations` 扫整个 `document.body`,把侧栏历史/导航的链接都算进去。
3. **截图非 QA 局部** —— 整页滚动分段截图,含侧栏、导航、其它历史消息。

v0.3 目标:
- 每个平台先摸清 DOM,写侦查文档。
- adapter 用**平台特化的精准选择器**定位 QA 容器,而非通用猜测。
- 答案 / 引用 / 截图**全部基于 QA 节点**。

## 侦查工具

- **[dev/cdp.js](../../dev/cdp.js)** — 轻量 CDP 客户端封装(Node 18+ 内置 WebSocket)
- **[dev/probe-dom.js](../../dev/probe-dom.js)** — 全流程侦查:打开平台首页 → 输入 → 发送 → 等答案 → 保存 HTML 快照 + 分析报告
- **[dev/probe-runtime.js](../../dev/probe-runtime.js)** — 页面内跑的分析器,包括问题文本反查、兄弟遍历找回答节点、最小公共祖先计算

### 使用方式

```bash
# 前置：Chrome 已带 --remote-debugging-port=9222 启动，profile 里已登录目标平台
node dev/probe-dom.js gemini
node dev/probe-dom.js chatgpt --question "GEO是什么"
```

产物:
- `dev/snapshots/{platform}_{timestamp}.html` — 完整 DOM 快照,长期存档
- `dev/snapshots/{platform}_{timestamp}.report.md` — 结构化分析报告

## 通用侦查算法

1. **输入问题 `Q`,发送,等答案生成完成**。
2. **文本反查用户气泡**:遍历 DOM(树遍历),找 `innerText` 归一化后包含 `Q` 且长度不超过 `Q * 8` 的最短元素。**必须限定在 `<main>` 内**(避免匹配到 sidebar 历史)。
3. **向后 / 向上找回答节点**:从用户气泡的下一个兄弟开始搜,找 `innerText.length > Q * 1.5` 且不包含 `Q` 的元素。找不到就往父层跳,继续搜父层的下一兄弟。
4. **计算最小公共祖先**:用户气泡与回答节点各自的祖先链,首个共同节点。
5. **产出候选选择器**:为三个关键节点各生成一组候选(id > data-* > 自定义标签 > 稳定 class)。
6. **验证引用扫描边界**:对比 QA 节点内 vs 全页的 http 链接数,量化「必须限定 QA 内扫描」的必要性。

## 关键教训

### 教训 1:文本反查必须限定 `<main>`
第一次 Perplexity 侦查在全页反查,匹配到 sidebar 里的历史条目(相同标题)。正确做法:先 `document.querySelector('main')`,只在 main 子树里搜。**所有平台适用**。

### 教训 2:忽略 Angular / React 的动态类名
Gemini 的类名带 `ng-tns-cXXX`、`ng-star-inserted`、`enable-lr26-*`,每次编译都变。选择器要用:
- 自定义标签(`user-query`、`model-response`)
- 稳定语义类(`.conversation-container`、`.markdown-main-panel`)
- `data-testid` / `data-message-author-role` 等语义属性

Tailwind 类名可用,但要选**语义类**(`.prose`、`.focus:outline-none`),不选布局类。

### 教训 3:`querySelectorAll` 用逗号组合 ≠ 选择器优先级
`document.querySelectorAll('A, B, C')` 按**文档顺序**返回全部匹配,不是先 A 后 B。如果要「优先 A,退化到 B」,必须逐个选择器 `querySelector` 尝试。这是 Gemini v0.2 空正文 bug 的根因。

### 教训 4:innerText 长度跳跃 = QA 边界
从用户气泡节点向父层走时,`innerText.length` 会**突然跳跃**(在 Perplexity 案例里从 16 → 857)。这个跳跃点就是 QA 容器的位置 —— 可作为 fallback 启发式。

## 平台侦查状态

| 平台 | 状态 | 快照 | 文档 |
|---|---|---|---|
| Gemini | ✅ 完成(含多轮验证 + 发送/停止) | `dev/snapshots/gemini_2026-07-21T02-30-28.html` | [gemini.md](gemini.md) |
| Perplexity | ✅ 完成(QA + 发送/停止) | `dev/snapshots/perplexity_collect_2026-07-21T02-35-13.html` | [perplexity.md](perplexity.md) |
| ChatGPT | ✅ 完成(单轮 + Web browsing 模式) | `dev/snapshots/chatgpt_2026-07-21T02-44-30.html` | [chatgpt.md](chatgpt.md) |
| 豆包 (Doubao) | ✅ 完成(QA + 发送/停止) | `dev/snapshots/doubao_collect_2026-07-21T03-01-50.html` | [doubao.md](doubao.md) |
| 元宝 (Yuanbao) | ✅ 完成(QA + 发送/停止) | `dev/snapshots/yuanbao_collect_2026-07-21T03-03-03.html` | [yuanbao.md](yuanbao.md) |
| Kimi | ✅ 完成(QA + 发送/停止) | `dev/snapshots/kimi_collect_2026-07-21T03-06-40.html` | [kimi.md](kimi.md) |
| Claude | ⏸️ 跳过 | — | [claude.md](claude.md) |

## 下一步

1. 在调试 Chrome profile 里补登录 ChatGPT / Claude,跑 `probe-dom.js` 完成剩余两个平台的侦查。
2. 基于文档结论重写 adapter 的 `findQANode(query)` / `answerRoot()` / `extractCitations()`。
3. 引入 DOM 截图库(计划用 `html2canvas`,~180KB UMD),替代整页滚动截图。
4. 更新 [common.js](../../src/content/common.js) 增加 `findQANodeByAnchor(query, root)` 通用工具:限定在 root 内(默认 `main`)做问题文本反查。

## 附:关于本次调试 Chrome

- 启动命令:`chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\Users\ASUS\geo-cdp-profile" ...`
- Profile 里已登录:Google 账号(Gemini)
- 未登录:ChatGPT / Claude / (Perplexity 有历史对话即可,不严格要求登录)
