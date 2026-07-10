# GEO 自动采集插件 — 实施方案（MV3 + Perplexity 优先）

## 决策
- **形态**：纯 Manifest V3 Chrome 插件，本地 unpacked 安装（不上架）
- **MVP 平台**：Perplexity 优先跑通全链路，再扩 ChatGPT / Gemini / Claude
- **复用**：`0601AKK` 的 CDP 方案里平台无关的核心逻辑（生成完成判定 / 引用提取 / 拟人节奏 / 状态机 / 数据模型）翻译成 JS 复用

## 目录结构
```
0709GEO插件/
├── manifest.json                 # MV3 清单
├── src/
│   ├── background/
│   │   └── service-worker.js     # 任务调度器：串行队列、tab 管理、保活、状态机
│   ├── content/
│   │   ├── common.js             # waitAnswerComplete / isGenerating / 拟人输入 / 截图协助
│   │   └── adapters/
│   │       └── perplexity.js     # Perplexity adapter（MVP）
│   ├── popup/
│   │   ├── popup.html            # 关键词输入 + 平台选择 + 进度
│   │   ├── popup.js
│   │   └── popup.css
│   ├── lib/
│   │   ├── jszip.min.js          # 打包导出
│   │   └── screenshot.js         # captureVisibleTab 分段滚动 + canvas 拼接
│   ├── export/
│   │   └── html-template.js      # 生成结果 HTML
│   └── storage/
│       └── db.js                 # IndexedDB 存截图/大数据 + chrome.storage 存任务状态
└── docs/
```

## 核心模块设计

### 1. Adapter 接口（从现有 Python ask_*() 迁移）
```js
const PerplexityAdapter = {
  match: (url) => url.includes('perplexity.ai'),
  waitReady: async () => {...},
  inputPrompt: async (text) => {...},   // contenteditable：execCommand('insertText') 逐字符 + dispatch InputEvent
  submit: async () => {...},            // Enter
  waitAnswerComplete: async () => {...},// 迁移 wait_generation()
  expandSources: async () => {...},     // 点"N 个来源"，多备用文案
  extract: () => ({ text, citations, domHtml }), // 迁移 domains_from_page()
}
```

### 2. waitAnswerComplete（直接迁移 wait_generation 逻辑）
组合信号，取保守者：
- 停止按钮存在/消失（`button[aria-label*=Stop]` 等，复用现有选择器）
- innerText 长度连续 N 次（stable_needed）不变
- 达到 min_chars 阈值（Perplexity ≥1200）
- max_wait 超时兜底（Perplexity 180s）
- 全程没见过停止按钮 → 要求更长稳定窗口兜底

### 3. 截图（唯一新技术点）
插件不能改 viewport，改用：
- `chrome.tabs.captureVisibleTab`（视口截图）
- 分段：滚动 → 截图 → 滚动 → 截图，节流 ~500ms/张（避频控）
- OffscreenCanvas 纵向拼接成整图 PNG
- 命名 `{qid}_{platform}_{ts}.png`

### 4. 拟人节奏（参数直接照搬）
- 逐字符输入 50–150ms/字
- 关键词间随机 8–15s
- 严格串行，单 tab，不并发
- 提交后随机滚动

### 5. Service Worker 调度 + 保活
- 任务队列串行执行，状态机：pending→running→done/failed/login_required
- 用长连接 port + `chrome.alarms` 防 SW 在 300s 长等待中休眠
- 停止/重试/跳过控制

### 6. 数据模型（复用 records.json 结构）
```
{ platform, keyword, timestamp, status, answerText, answerChars,
  citations:[{domain,count,sampleUrl}], domHtml, screenshotId }
```
- 任务状态 → chrome.storage.local
- 截图二进制 + domHtml → IndexedDB

### 7. 导出
- html-template.js 生成结果 HTML（检测时间/平台/关键词/正文/引用/DOM/截图索引）
- JSZip 打包 `report.html + screenshots/*.png` → chrome.downloads 下载 zip

## 分阶段
| 阶段 | 内容 |
|---|---|
| **M1 骨架** | manifest + popup 输入 UI + SW 空调度 + Perplexity adapter 打通"输入→提交→判完成→提取正文" |
| **M2 采集完整** | 引用提取 + 截图拼接 + 单关键词完整数据落库 |
| **M3 批量+导出** | 串行队列 + 进度/停止/重试 + JSZip 导出 HTML+截图 |
| **M4 扩平台** | ChatGPT / Gemini / Claude adapter（复用现有选择器与参数） |
| **M5 稳健化** | 异常处理、历史记录、adapter 健康检测、风控节流 |

## 需验证的两个插件端新点
1. Perplexity contenteditable 受控输入是否被 React 正确接收（execCommand vs dispatch InputEvent）
2. captureVisibleTab 分段滚动拼接的对齐与频控

## 待确认
- Chrome 安装路径 / 是否已有 JSZip 本地文件（否则我从 CDN 取一份放 lib/）
- 关键词批量上限、单条超时默认值是否沿用现有（Perplexity 180s / min 1200 字）
