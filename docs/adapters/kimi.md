# Kimi (Moonshot) DOM 结构侦查

- **侦查时间**: 2026-07-21
- **来源页面**: https://www.kimi.com/chat/{uuid}?chat_enter_method=history
- **快照文件**: `dev/snapshots/kimi_collect_2026-07-21T03-06-40.html`
- **侦查手段**: CDP → 打开真实对话 → 手动定位消息类容器 → 追踪父子结构
- **平台栈**: Vue 3(`data-v-*` scoped 属性)+ Lexical 编辑器 + 自研 UI

## 核心结论

Kimi 有**极其规范的语义类名**,是新增三平台里侦查最愉快的:

```
body (没有 <main>)
└── ...
    └── .chat-content-container                       ← 整个对话容器
        └── .chat-content-list                        ← 消息列表(QA 最小公共祖先候选)
            ├── .chat-content-item.chat-content-item-user       ← 用户消息
            │   └── .segment.segment-user
            │       └── .segment-container
            │           └── .segment-content
            │               └── .user-content
            │                   └── .segment-content-box
            │                       └── (纯文本问题)
            └── .chat-content-item.chat-content-item-assistant  ← 助手消息(下一个兄弟)
                └── .segment.segment-assistant
                    └── ... (类似结构,含 markdown)
```

## 精确定位选择器(生产 adapter 用)

| 目标 | 选择器 | 说明 |
|---|---|---|
| **消息列表容器** | `.chat-content-list` | 所有消息的父,QA 边界候选 |
| **所有消息** | `.chat-content-list > .chat-content-item` | 按顺序,每个是一条 |
| **最后一对 QA** | `list.children` 倒数 2 个 | 假设 user 在前,assistant 在后 |
| **用户消息** | `.chat-content-item-user` | user 消息识别 |
| **助手消息** | `.chat-content-item-assistant` | assistant 消息识别 |
| **消息内部段**: | `.segment` + `.segment-user`/`.segment-assistant` | 语义子容器 |
| **文本气泡** | `.user-content` / (助手对应类,待验证) | markdown 渲染区 |
| **段落容器** | `.segment-content-box` | 文本包装 |

## 关键锚点(**类名 = 最稳定,Vue 无 data 属性可锚**)

Kimi 用 `data-v-{hash}` 作为 Vue scoped style 标记,**这些属性值每次构建变**,不能锚定。但**语义类名极稳**:

- `chat-content-container` / `chat-content-list` / `chat-content-item`
- `chat-content-item-user` / `chat-content-item-assistant`
- `segment` / `segment-user` / `segment-assistant`
- `segment-container` / `segment-content` / `segment-content-box`
- `user-content`

**这些语义类名的命名规则清晰**,大概率跟随代码结构变动很小。

## 忽略字段(易变)

- **所有 `data-v-{hash}` 属性**:Vue scoped style 用,每次构建 hash 变。也是 Kimi 页面上唯一的 data-* 属性(除少数功能性,如 `data-lexical-editor=true`)
- **`data-lexical-editor="true"`**:Lexical 编辑器标记,可用于识别输入框

## 输入框

- **主输入**: `div[contenteditable=true][data-lexical-editor=true]`
- Lexical 编辑器,类似 React ProseMirror 需要特殊处理输入
- 输入方法:直接 `document.execCommand('insertText')` 应该可行(Lexical 支持标准 input 事件)

## 发送按钮

**已侦查完成(2026-07-21)**:

- Kimi 发送按钮 = `<div class="send-button-container">`
- **稳定锚**:类名 `.send-button-container` (Vue 组件类,不带 hash 后缀)
- 内部图标:`<svg class="iconify send-icon">`(纸飞机)
- 空态:附加 `.disabled` 类:`send-button-container disabled`
- 生产 adapter 定位方式:
  ```js
  const sendBtn = document.querySelector('.send-button-container:not(.disabled)');
  sendBtn && sendBtn.click();
  ```
- **输入方式** (Lexical 编辑器):
  ```js
  const editor = document.querySelector('[data-lexical-editor=true]');
  editor.focus();
  document.execCommand('insertText', false, question);
  ```

## 停止按钮

**已侦查完成(2026-07-21)**:

- 生成开始后,**同一个 `.send-button-container` 添加 `.stop` 类**:
  - 空态: `.send-button-container.disabled`
  - 有输入: `.send-button-container`
  - 生成中: `.send-button-container.disabled.stop` ← **`.stop` 类是关键锚**
- 内部 SVG 保持 `.send-icon` class(图标未替换,只是通过 `.stop` 修饰视觉)
- 生产 adapter 判断:
  ```js
  function isGenerating() {
    return !!document.querySelector('.send-button-container.stop');
  }
  function clickStop() {
    const btn = document.querySelector('.send-button-container.stop');
    if (btn) btn.click();
  }
  ```

**Kimi 是四个新平台里状态最清晰的** —— 同一个 div 元素,通过 3 个 class 组合表达 4 种状态。

## 引用来源

- 本次侦查是"Token价值重塑"闲聊类,QA 内无外链
- Kimi 有 Web Search 功能,搜索模式下答案会带引用
- **待真机侦查搜索模式的引用 DOM**

## 关键改造点(vs 未来 kimi.js adapter)

1. **QA 边界**:`.chat-content-list` 最后两个 `.chat-content-item`(user + assistant)。
2. **答案文本**:`.chat-content-item-assistant .segment-content-box`(或类似 markdown 容器)。
3. **`inferKeyword`**:`.chat-content-item-user .user-content` 的 `innerText`。
4. **引用扫描**:限定在 assistant 消息的 `.chat-content-item` 内。
5. **截图**:传最后一对 `.chat-content-item`(user+assistant) 的最小公共祖先,或就是 `.chat-content-list` 的最后两个子元素范围。

## 关键侦查数据

```
用户消息父容器: .chat-content-list
├── .chat-content-item.chat-content-item-user       len=4130
└── .chat-content-item.chat-content-item-assistant  len=3467

用户消息内部:
.chat-content-item-user
└── .segment.segment-user
    └── .segment-container
        └── .segment-content
            └── .user-content
                └── .segment-content-box
                    (问题文本)
```

## 待验证

- **发送/停止按钮**:必须真机侦查
- **助手消息内部结构**:侦查只详细看了 user 侧,assistant 侧类名镜像应该是 `.segment-assistant` / `assistant-content` 但需要验证
- **搜索模式引用**:Kimi 搜索模式下答案的引用元素 DOM
- **URL / 登录墙特征**:未登录时页面 UI
- **`data-v-{hash}` 稳定性**:Vue scoped style hash 是否长期不变(不建议依赖)
