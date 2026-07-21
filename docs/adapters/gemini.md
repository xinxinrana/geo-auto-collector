# Gemini DOM 结构侦查

- **侦查时间**: 2026-07-21
- **来源页面**: https://gemini.google.com/app
- **快照文件**: `dev/snapshots/gemini_2026-07-21T02-30-28.html` (2028 KB)
- **侦查手段**: CDP → 输入问题 → 提交 → 等答案 → 通过问题文本反查用户气泡 → 兄弟遍历找回答节点 → 计算最小公共祖先

## 核心结论

**Gemini 每一轮问答被 Angular 组件 `.conversation-container` 完整包裹**,这是最理想的 QA 边界:

```
div.conversation-container.message-actions-hover-boundary        ← QA 最小公共祖先(每轮一个)
├── user-query                                                    ← 用户气泡容器
│   └── user-query-content
│       └── div.query-content
│           └── ...
│               └── p.query-text-line                             ← 问题纯文本(不含 UI 前缀)
└── model-response                                                ← 回答容器(自定义标签)
    └── response-container
        └── ...
            └── div.markdown.markdown-main-panel                  ← 回答正文 HTML
```

## 精确定位选择器(生产 adapter 用)

| 目标 | 选择器 | 说明 |
|---|---|---|
| **所有 QA 轮次(顺序)** | `div.conversation-container` | 每个 `<div>` = 一轮完整问答 |
| **最后一轮 QA** | `document.querySelectorAll('div.conversation-container').at(-1)` | 我们只关心最新 |
| **该轮的问题** | `qa.querySelector('p.query-text-line')` | `innerText` 就是干净问题文本 |
| **该轮的回答容器** | `qa.querySelector('model-response')` | 自定义标签,稳 |
| **该轮的回答正文** | `qa.querySelector('.markdown-main-panel, .markdown')` | 已实测存在 1021 字 |

## 忽略字段(易变)

Angular 生成的这些属性/类名**不能拿来定位**,平台每次编译都会变:
- 属性:`_ngcontent-ng-cXXXX`、`_nghost-ng-cXXXX`
- 类名:`ng-tns-cXXXXXXXXX-N`、`ng-star-inserted`、`enable-lr26-*`、`enable-luminous-*`
- id:`div.conversation-container` 的 `id="7aaf8624b4673a56"` —— **随机 hash,不要依赖**

## 已知稳定语义

- 自定义标签(Angular 组件名)是最稳的锚,来自源码组件名:`user-query`、`user-query-content`、`model-response`、`response-container`
- 语义化类名:`.conversation-container`、`.query-text-line`、`.query-text`、`.markdown-main-panel`
- 数据属性:`data-test-id="luminous-collapsed-bubble"`(用户气泡)、`data-test-id="prompt-copy-button"`(操作按钮)—— 存在但意义偏向按钮

## 图标/停止按钮参考

- 生成中:`button[aria-label="停止回答"]`(icon `stop`)
- 发送(输入后出现):`button[aria-label="发送"]`(icon `arrow_upward`)
- Send/Stop 按钮**只有输入非空 / 生成中才显示**

## 引用来源特点

Gemini 会把来源以行内链接 + 来源 chip 呈现,本次侦查里 QA 节点内**无 http 外链**(3 个页面外链都在侧栏),说明:
- 引用 chip 可能是 `<gem-icon-button>` 而非 `<a>`,展开后才出 URL —— 生产 adapter 需要点击「来源」按钮再抓
- 或者是纯品牌名文字,没有可跳转链接(本次答案中的"電子豹"、"新視野網頁設計"看起来是这种)

生产 adapter 里 `expandSources()` 已有点「来源」按钮的逻辑,保留;`extractCitations` 改成**只扫 QA 节点内**的 `<a>`,避免把侧栏历史链接算进来。

## 关键改造点(vs 当前 gemini.js)

1. **锚点从「按 CSS 选择器猜最新 model-response」改为「取 `div.conversation-container:last`」** —— 明确边界,不会误抓其他轮次。
2. **答案容器**:`qa.querySelector('.markdown-main-panel')` 直接命中,不用再按选择器优先级尝试。
3. **`inferKeyword`**:`qa.querySelector('.query-text-line').innerText` 即得,不需要剥离「你说」前缀(那个是屏幕阅读器专用的隐藏 span)。
4. **引用扫描**:只扫 `qa`,不扫全页。
5. **DOM 截图**:传 `qa` 给 html2canvas 生成截图,替代整页滚动。

## 侦查过程 trace(节选)

```
input_found {"tag":"DIV","cls":"ql-editor ql-blank textarea new-input-ui"}
typed
sent_via_enter
wait_done {"waited":20000,"prevLen":2800,"sawGenerating":true}
user_node_anchored {"tag":"P","cls":"query-text-line","textLen":19}
assistant_found_by_sibling {"hop":8,"tag":"MODEL-RESPONSE","textLen":1021}
qa_ancestor {"tag":"DIV","cls":"conversation-container ..."}
links {"inQA":0,"inPage":3}   ← 全页 3 个外链都不在 QA 内(侧栏),证实必须限定扫描范围
```

## 待验证

- **多轮对话**:一个会话内问 3 个问题时,`.conversation-container` 是否 3 个?(高度确信是,但没实测)
- **来源展开后**:点击「来源」按钮后,链接是否出现在 QA 节点子树内?
- **代码块 / 表格 / 图片**:本次答案只有文本,复杂内容形态还没侦查
