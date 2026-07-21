# Perplexity DOM 结构侦查

- **侦查时间**: 2026-07-21
- **来源页面**: https://www.perplexity.ai/search/{uuid}
- **快照文件**: `dev/snapshots/perplexity_collect_2026-07-21T02-35-13.html`
- **侦查手段**: CDP → 打开一个真实历史对话页 → 在 `<main>` 内做文本反查 → 追踪祖先链 → 定位 QA 容器

## 核心结论

**Perplexity 的 QA 结构比 Gemini 「无骨」得多** —— 没有语义化的自定义标签,全靠 `<div>` + Tailwind 类名。但**每一轮 QA 的边界是明确的**:

```
main
└── ... (多层布局包装)
    └── div.focus:outline-none                           ← 语义容器(存在 outline 焦点管理)
        └── div.flex.flex-col.@3xl:gap-y-lg.gap-y-md    ← 每一轮 QA 的容器
            ├── [0] div.bg-base.erp-sidecar:pt-0        ← 用户气泡区(纯文本问题)
            └── [1] div.gap-y-sm.flex.flex-col          ← 答案区
                └── ...
                    └── div.prose.dark:prose-invert.inline    ← 回答正文(704 字实测)
```

## 精确定位选择器(生产 adapter 用)

| 目标 | 选择器 | 说明 |
|---|---|---|
| **每轮 QA 容器** | `main .focus\\:outline-none div.flex.flex-col.gap-y-md` | Tailwind 类名组合作 anchor |
| **最后一轮 QA** | 上面结果的 `.at(-1)` | 多轮时取最新 |
| **该轮的问题** | `qa.children[0]`(第一个 div) | `innerText` 就是问题 |
| **该轮的答案容器** | `qa.children[1]`(第二个 div) | 包含 prose + 引用 + 相关问题 |
| **该轮的答案正文** | `qa.querySelector('.prose.dark\\:prose-invert')` | 或退化到 `.prose` |
| **推断关键词** | `document.title`(去掉尾部品牌) 或 `qa.children[0].innerText` | Perplexity 会把首个问题作为 tab 标题 |

## 关键约束:必须限定在 `<main>` 内做文本反查

**教训**:第一次尝试用问题文本在全页反查,匹配到了 **sidebar 里的历史条目**(同样的问题标题会出现在 sidebar 的 `<a aria-label="...">`)。

正确做法:反查前先 `document.querySelector('main')`,只在 `<main>` 子树里搜。所有平台都应遵循此原则 —— sidebar / nav 里往往有历史对话标题,是常见误匹配源。

## 忽略字段(易变)

- Tailwind 类名不算「稳」,但类名组合(如 `.focus:outline-none` + `.flex.flex-col.gap-y-md`)相对稳定,因为它们对应组件的**语义结构**而非视觉。
- 只要 Perplexity 不重构组件层级,这套选择器就成立。

## 已知稳定语义

- `<main>` 元素:大页面框架的锚
- `.focus:outline-none` + `.flex.flex-col.gap-y-md`:每轮 QA 的语义容器组合
- `.prose.dark:prose-invert`:Tailwind 官方 typography 插件的类,答案文本区
- `.bg-base`(问题气泡区)、`.gap-y-sm.flex.flex-col`(答案区):稳定的结构类

## 引用来源特点

- QA 内直接 `<a href="http...">` 抓不到(0 个) —— Perplexity 的来源以 chip 形态存在于 `.gap-y-sm.flex.flex-col` 的一个子区块
- 生产 adapter 里 `expandSources()` 已有点「来源」按钮逻辑,保留
- **引用扫描必须限定在 QA 节点内**,不能扫全页(Perplexity 的 sidebar 里全是外链)

## 输入框

- 顶部和底部各一个,都是 `div[role=textbox][contenteditable=true]`
- 有两个可见输入框时,取**在 `<main>` 内且靠近底部的那个**(followup 输入框)
- **输入方法**:`focus()` 后 `document.execCommand('insertText', false, question)` 有效

## 发送按钮

**已侦查完成(2026-07-21)**:

- 发送按钮 = `button[aria-label="Submit"]`
- 空态时按钮存在但含 `pointer-events-none` 类(点击无效)
- 输入后 `pointer-events-none` 被移除,可点击
- 生产 adapter 定位方式:
  ```js
  const sendBtn = document.querySelector('button[aria-label="Submit"]');
  if (sendBtn && getComputedStyle(sendBtn).pointerEvents !== 'none') sendBtn.click();
  ```

## 停止按钮

**已侦查完成(2026-07-21)**:

- 生成开始后 (~1s 内),**发送按钮从 DOM 上消失,被替换为**:
  - `button[aria-label="Stop response (Esc)"]`
  - `aria-label` 以 **"Stop response"** 开头,是最稳定的锚
- 生成完成后,该按钮消失,`button[aria-label="Submit"]` 重新出现(pointer-events-none 状态)
- 生产 adapter 判断:
  ```js
  function isGenerating() {
    return !!document.querySelector('button[aria-label^="Stop response"]');
  }
  function clickStop() {
    const btn = document.querySelector('button[aria-label^="Stop response"]');
    if (btn) btn.click();
  }
  ```
- 也支持键盘 `Esc` 停止(aria-label 里显式提示 `Esc`)

## 关键改造点(vs 当前 perplexity.js)

1. **锚点改为「QA 容器 last」** —— `main .focus\\:outline-none div.flex.flex-col.gap-y-md` 的 `.at(-1)`,精确边界。
2. **答案容器**:`qa.children[1].querySelector('.prose')`,精准无干扰。
3. **文本反查作为 fallback** —— 若上述选择器某天失效,用问题文本在 `<main>` 内反查(务必限定 `<main>`,避 sidebar)。
4. **引用扫描**:只扫 `qa`,不扫全页。
5. **`inferKeyword`**:优先 `qa.children[0].innerText`,退化到 `document.title` 去掉 Perplexity 尾巴。
6. **DOM 截图**:传 `qa` 给 html2canvas。

## 待验证

- **多轮对话**:侦查页面只有 1 轮 QA,未验证多轮时 `.flex.flex-col.gap-y-md` 是否也是每轮一个(**高度可信** —— `focus:outline-none` 的一个 child 是一轮 QA 结构)。
- **代码块 / 表格**:未侦查。
- **来源展开后**:未点击「来源」按钮,链接暴露到 QA 子树的具体形态未知。
- **输入 + 全流程**:侦查中输入受阻(只进了单个字符「G」),需要单独查明 Perplexity 输入框的字符投递机制。

## 侦查数据关键节选

```
祖先链(用户气泡 → main):
  1. DIV bg-base                             textLen=16   ← 问题气泡本体
  2. DIV flex flex-col @3xl:gap-y-lg gap-y-md  textLen=857 ← QA 容器(问 + 答)
  3. DIV focus:outline-none                  textLen=857  ← 语义容器
  4. DIV w-full flex flex-col                textLen=857
  ... (往上都是布局包装,文本长度不变)
  12. DIV @container isolate                 textLen=857  ← 主内容框
  13. DIV mx-auto size-full max-w-none       textLen=966  ← 加入了页头/工具栏
```

从 textLen 从 16 → 857 的**跳跃点**就是 QA 边界。这个数字跳跃可以作为运行时锚定的 fallback 启发式:「从问题节点向上走,找 innerText 长度第一次显著跳跃(3 倍以上)的那一层」。
