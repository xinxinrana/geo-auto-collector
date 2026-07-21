# ChatGPT DOM 结构侦查

- **侦查时间**: 2026-07-21
- **来源页面**: https://chatgpt.com/(已登录)
- **快照文件**: `dev/snapshots/chatgpt_2026-07-21T02-44-30.html` (687 KB)
- **侦查手段**: CDP → 输入问题 → 提交 → 等答案 → 问题文本反查 → 分析祖先链

## 核心结论

ChatGPT 的 DOM 有**极其明确的语义标注**,是 4 平台里侦查最愉快的:

- **每一「轮消息」都是一个 `<div data-turn-id-container="...">`** —— user 一个,assistant 一个,顺序排列。
- **`<section data-turn="user|assistant" data-testid="conversation-turn-N">`** 直接标注了每轮的角色和编号。
- **OpenAI 自己就标注了「截图目标」** —— `<div data-conversation-screenshot-content>` 是官方推荐的截图容器,专为 UI 截图设计。

```
main
└── ...
    └── (QA 边界容器,class 带随机 hash,不稳定)
        ├── <div data-turn-id-container="client-created-root">
        ├── <div data-turn-id-container="{user-uuid}">                    ← 每轮 user 消息
        │   └── section[data-turn="user"][data-testid="conversation-turn-1"]
        │       └── ...
        │           └── div[data-conversation-screenshot-content]         ← 官方截图容器
        │               └── div[data-message-author-role="user"]          ← 消息文本
        │                   └── (纯文本问题)
        ├── <div data-turn-id-container="request-WEB:{assistant-uuid}-0"> ← 紧跟的 assistant 消息
        │   └── section[data-turn="assistant"][data-testid="conversation-turn-2"]
        │       └── ...
        │           └── div[data-conversation-screenshot-content]         ← 官方截图容器
        │               └── div[data-message-author-role="assistant"]    ← 答案文本
        │                   └── .markdown / .prose (回答正文)
        └── ...
```

## 精确定位选择器(生产 adapter 用)

| 目标 | 选择器 | 说明 |
|---|---|---|
| **所有轮次(按顺序)** | `section[data-turn]` | 每个 section 是一轮消息(user 或 assistant) |
| **最后一轮 user** | `section[data-turn="user"]:last-of-type` | 或用 `data-testid=conversation-turn-{奇数}` |
| **最后一轮 assistant** | `section[data-turn="assistant"]:last-of-type` | 也可以走 `[data-message-author-role="assistant"]:last-of-type` |
| **一轮完整消息(QA 半边)** | `[data-turn-id-container="..."]` | 但一轮只含 user OR assistant,不是完整 QA |
| **完整 QA(问 + 答)** | 取最后一对 `data-turn="user"` + `data-turn="assistant"`,再算最小公共祖先 | 见下方「QA 定位算法」 |
| **问题文本** | `sectionUser.querySelector('[data-message-author-role="user"]')` | `innerText` 就是纯问题 |
| **答案文本容器** | `sectionAssistant.querySelector('[data-message-author-role="assistant"]')` | 内含 `.markdown` |
| **答案 markdown** | 上面结果的 `.querySelector('.markdown, .prose, [data-message-model-slug]')` | 未验证 slug 属性 |
| **截图目标(推荐)** | `section.querySelector('[data-conversation-screenshot-content]')` | OpenAI 官方标注 |

## QA 定位算法

因为 user 和 assistant 是**两个独立的 section**,QA = 相邻的一对。生产 adapter 逻辑:

```js
function findLastQA() {
  const userSections = [...document.querySelectorAll('section[data-turn="user"]')];
  const asstSections = [...document.querySelectorAll('section[data-turn="assistant"]')];
  const lastUser = userSections.at(-1);
  const lastAsst = asstSections.at(-1);
  if (!lastUser || !lastAsst) return null;
  // 最小公共祖先
  const chainU = ancestors(lastUser);
  const setA = new Set(ancestors(lastAsst));
  const qaContainer = chainU.find(n => setA.has(n));
  return { userSection: lastUser, assistantSection: lastAsst, qaContainer };
}
```

## 忽略字段(易变)

- **随机 hash 类名**:`.qMYqUG_convSearchResultHighlightRoot`、`.R6Vx5W_threadScrollVars`、`.fKQ0lq_Layout` —— 前缀是构建时哈希,每次发布可能变
- **turn-id 值**:`d6dbf2ed-fe1f-48e3-bf4a-1b6d5f01690a`、`request-WEB:{uuid}-0` —— 运行时生成,不能硬编码具体值(但**存在性**是稳的)

## 已知稳定语义

- **data-testid**:`conversation-turn-N`、`copy-turn-action-button`、`stop-button`、`send-button`
- **data-turn**:`user` / `assistant`
- **data-turn-id / data-turn-id-container**:每轮消息的容器锚
- **data-message-author-role**:`user` / `assistant`
- **data-message-id**:每条消息的 UUID
- **data-conversation-screenshot-content**:官方截图容器(重要!)

## 引用来源特点

**本次侦查里 QA 内 4 个链接,全页也是 4 个 —— ChatGPT 的引用完全在 QA 内**(和 Gemini/Perplexity 不同)。侦查到的引用:
- `https://developers.google.com/search/docs/fundamentals/ai-optimization-guide` (× 3,不同文本引用同 URL)
- `https://arxiv.org/abs/2607.14035`

意味着:**ChatGPT 引用抓取,限定 QA 内 vs 全页扫都不会漏,但**限定 QA 内更精确**(排除侧栏历史链接,虽然本次页面上没有)。

## 停止 / 发送 按钮

- **发送**:`button[data-testid="send-prompt"]` 或 `[aria-label="Send prompt"]`
  - 侦查中通过 `[aria-label*="Send"]` 命中 ✓
- **停止**:`button[data-testid="stop-button"]` (未在生成中捕获,但当前 adapter 用此选择器)

## 关键改造点(vs 当前 chatgpt.js)

1. **QA 边界**:改用**相邻 user/assistant section 的最小公共祖先**,而非「最后一条 assistant」。
2. **答案容器**:`assistantSection.querySelector('[data-message-author-role="assistant"] .markdown')` —— 明确定位。
3. **引用扫描**:只扫 QA 内,不扫全页。
4. **`inferKeyword`**:`userSection.querySelector('[data-message-author-role="user"]').innerText`。
5. **截图**:优先用 `assistantSection.querySelector('[data-conversation-screenshot-content]')` 作为截图目标(OpenAI 官方推荐容器),或用 QA 最小公共祖先。

## 侦查过程 trace

```
input_found {"tag":"DIV","cls":"ProseMirror ProseMirror-focused"}
typed
sent_via_button {"sel":"Send prompt"}
wait_done {"waited":86000,"prevLen":2064,"sawGenerating":true}
user_node_anchored {"tag":"DIV","cls":"","textLen":19}    ← 用户气泡 div,innerText 就是问题
assistant_found_by_sibling {"hop":0,"tag":"DIV","cls":"","textLen":1239}   ← 紧邻兄弟就是回答
qa_ancestor {"tag":"DIV","cls":"qMYqUG_convSearchResultHighlightRoot"}
links {"inQA":4,"inPage":4}
```

**86 秒的等待**说明 ChatGPT 用了 Web browsing / DeepResearch 模式(答案里有 "Worked for 41s")。**这个模式下引用会出现在 QA 内**(4 个链接,arxiv + Google 文档)。

## 待验证

- **多轮对话**:多问几次后,`section[data-turn]` 是否严格按顺序排列?(高度可信)
- **`data-message-model-slug`**:可能标注模型版本,方便侦查用了 GPT-4o / o1 / 等
- **代码块 / 表格 / 图片**:侦查文本内有 `Worked for 41s` 说明有可展开的思考过程,DOM 里叫 `data-writing-block`
- **Canvas / Artifacts**:ChatGPT 的 Canvas 功能可能是独立 iframe/组件,未侦查
- **无 browsing 时的引用**:纯 chat 无 web 搜索时,可能没有 `<a href="http...">`,只有纯文本
