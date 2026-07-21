# 元宝 (Yuanbao / 腾讯) DOM 结构侦查

- **侦查时间**: 2026-07-21
- **来源页面**: https://yuanbao.tencent.com/chat/{智能体id}/{对话id}
- **快照文件**: `dev/snapshots/yuanbao_collect_2026-07-21T03-03-03.html`
- **侦查手段**: CDP → 打开真实对话 → 沿助手答案容器往上追踪祖先链
- **平台栈**: Next.js + Quill 编辑器 + 自研 UI 库(`agent-chat__*` 前缀)+ 自研 markdown(`hyc-*` 前缀)

## 核心结论

元宝**没有 `<main>` 标签**,但类名极其规范,**`agent-chat__*` 前缀标记消息级结构,`hyc-*` 前缀标记 markdown 渲染**:

```
body
└── ...
    └── .agent-chat__list__container(或类似)
        └── .agent-chat__list__item                          ← 一条消息的顶级
            └── .agent-chat__list__item__content            ← 消息内容容器(QA 半边)
                └── .agent-chat__bubble.agent-chat__bubble--human     ← 用户气泡
                    └── (纯文本问题)
                └── .agent-chat__bubble.agent-chat__bubble--ai       ← 或助手气泡
                    └── .agent-chat__bubble__content
                        └── .agent-chat__conv--ai__speech_show[data-conv-index][data-speech-index]
                            └── .hyc-component-deepsearch-cot          ← 思考过程(可选)
                            └── .hyc-common-markdown                   ← 主回答 markdown
                                └── .hyc-content-md.hyc-content-md-done   ← markdown 完成态
                                    └── (回答正文,含 .ybc-p 段落等)
                        └── .agent-chat__conv--ai__toolbar[data-conv-index][data-speech-index]  ← 引用来源工具栏
                            └── .agent-chat__conv--ai__promptHintV2      ← 相关问题推荐
```

## 精确定位选择器(生产 adapter 用)

| 目标 | 选择器 | 说明 |
|---|---|---|
| **所有消息** | `.agent-chat__list__item__content` | 每个 = 一条消息 |
| **用户气泡** | `.agent-chat__bubble--human` 或 `.agent-chat__conv--human` | user 消息识别 |
| **助手气泡** | `.agent-chat__bubble--ai` 或 `.agent-chat__conv--ai--multiple` | assistant 消息识别 |
| **助手答案容器** | `.agent-chat__conv--ai__speech_show[data-conv-index][data-speech-index]` | **关键锚点**,含 data 属性 |
| **回答文本** | `qa.querySelector('.hyc-common-markdown')` 或 `.hyc-content-md.hyc-content-md-done` | markdown 渲染完成态 |
| **段落文本** | `.ybc-p` | markdown 内 `<p>` 转成的元素 |
| **CoT 思考过程** | `.hyc-component-deepsearch-cot` | 深度思考模式的展示 |
| **引用/工具栏** | `.agent-chat__conv--ai__toolbar` | 含 sources 和相关问题 |
| **相关问题** | `.agent-chat__conv--ai__promptHintV2--hint` | 每个是一个推荐问题 |

## 关键锚点(data 属性 = 最稳定)

- `data-conv-index` —— 对话在会话中的编号
- `data-speech-index` —— 消息编号(可能是 conv 的子编号)
- `data-trace-id` —— 追踪 id,用于分析
- 侧栏历史项: `data-item-id`(对话 uuid)、`data-item-name`(标题)

## 忽略字段(易变)

- **数据埋点属性**: `dt-exposure`、`dt-page-id`、`dt-mod-id`、`dt-agent-id`、`dt-cid`、`dt-ext1`、`dt-ext5`、`data-hy-exposured` —— 埋点用,值随时变
- **CSS Modules 类名**: `.hyc-common-markdown-style-cot` 等长后缀,构建可能变
- **Next.js 生成属性**: `data-n-g`、`data-n-p`、`data-n-css`、`data-next-*`、`data-nscript`

## 已知稳定语义

- **`agent-chat__` 前缀**: 消息级 UI 组件
  - `agent-chat__bubble` / `__bubble--ai` / `__bubble--human`
  - `agent-chat__conv--human` / `agent-chat__conv--ai` / `--ai--multiple`
  - `agent-chat__list__item` / `__list__item__content`
  - `agent-chat__conv--ai__speech_show`
  - `agent-chat__conv--ai__toolbar` / `__promptHintV2`
- **`hyc-` 前缀**: markdown 渲染(HYC = hunyuan chat?)
  - `hyc-common-markdown` / `hyc-content-md` / `hyc-content-md-done`
  - `hyc-component-deepsearch-cot` / `hyc-component-deepsearch-cot__think`
- **`ybc-` 前缀**: 元素级 typography
  - `ybc-p` (段落)

## 输入框

- `div[contenteditable=true]` (Quill 编辑器,`data-prevent-quill-blur` 属性)
- 1 个可见输入,无 `<textarea>`

## 发送按钮

**已侦查完成(2026-07-21)**:

- 元宝发送按钮是 `<a class="style__send-btn___RwTm5">`(CSS Modules 命名)
- **稳定锚**:`a[class*="send-btn"]`(前缀 `style__send-btn` 稳定,末尾 hash 会变)
- 内部图标发送态:`<span class="hyc-common-icon iconfont icon-send">` (纸飞机图标)
- 空态时按钮存在但**添加 `--disabled` 后缀类**:`style__send-btn___RwTm5 style__send-btn--disabled___mhfdQ`
- 生产 adapter 定位方式:
  ```js
  const sendBtn = document.querySelector('a[class*="send-btn"]:not([class*="send-btn--disabled"])');
  ```
- **输入方式** (Quill 编辑器):
  ```js
  const editor = document.querySelector('.ql-editor');
  editor.focus();
  document.execCommand('insertText', false, question);
  // 或者直接 innerHTML = '<p>' + question + '</p>'; 触发 input 事件也生效
  ```

## 停止按钮

**已侦查完成(2026-07-21)**:

- 生成开始后,**同一个 `<a class*="send-btn">` 的内部图标发生切换**:
  - 发送态: `<span class="hyc-common-icon iconfont icon-send">`
  - 生成中: `<svg><rect x="7.71448" y="7.71436" width="8.57143" height="8.57143" rx="1.5" fill="currentColor"/></svg>` (方块图标 = 停止)
- 类名保持 `style__send-btn___RwTm5`(生成期间不加 `--disabled`)
- 生成完成后恢复 icon-send 图标 + 加 `--disabled` 后缀类
- 生产 adapter 判断:
  ```js
  function isGenerating() {
    const btn = document.querySelector('a[class*="send-btn"]');
    if (!btn) return false;
    // 生成中: 内部是 svg 而非 icon-send span
    return !btn.querySelector('.icon-send') && !!btn.querySelector('svg rect');
  }
  function clickStop() {
    const btn = document.querySelector('a[class*="send-btn"]');
    if (btn && isGenerating()) btn.click();
  }
  ```

## 引用来源

- **不在助手答案容器 `.hyc-common-markdown` 内**,而是在**兄弟节点** `.agent-chat__conv--ai__toolbar` 里
- 生产 adapter 抓引用要抓 `.agent-chat__list__item__content` 或整个消息气泡范围内的 `<a href>`
- 元宝还有 "Sources" 展开列表(和 Perplexity 类似),可能需要点击展开

## 关键改造点(vs 未来 yuanbao.js adapter)

1. **QA 边界**:相邻两个 `.agent-chat__list__item__content`(user + ai),或取最小公共祖先。
2. **答案容器**:`aiMsg.querySelector('.agent-chat__conv--ai__speech_show')`(不含 toolbar/相关问题)。
3. **答案文本**:`.querySelector('.hyc-common-markdown')` 或 `.hyc-content-md-done`。
4. **`inferKeyword`**:用户气泡 `.agent-chat__bubble--human` 的 `innerText`。
5. **引用扫描**:扫 `.agent-chat__conv--ai__toolbar` + 主答案容器,包含 Sources 展开的链接。
6. **CoT 处理**:选择保留(存进 `answerHtml`)还是过滤(只留最终答案)。可以先都保留。
7. **截图**:传 `.agent-chat__list__item__content` 给 html2canvas。

## 侦查过程 trace

```
祖先链(答案 .hyc-common-markdown → 消息级):
  1. .hyc-common-markdown                            len=647
  2. .hyc-content-md.hyc-content-md-done             len=647
  3. .hyc-component-deepsearch-cot__think__content__item  len=647
  4. .hyc-component-deepsearch-cot__think__content   len=1131
  5. .hyc-component-deepsearch-cot__think            len=1173
  6. .hyc-component-deepsearch-cot                   len=3193   ← CoT 全部
  7. .agent-chat__speech-text--box                   len=3193
  8. div (empty class)                               len=3193
  9. .agent-chat__conv--ai__speech_show[data-conv-index]  len=3193   ← 消息答案容器
  10. .agent-chat__bubble__content                   len=3350
  11. .agent-chat__bubble.agent-chat__bubble--ai     len=3350   ← 助手气泡
  12. .agent-chat__list__item__content               len=3350   ← 消息容器(推荐边界)
```

## 待验证

- **发送/停止按钮**:必须真机侦查
- **多轮对话**:侦查页有 7 个 `.hyc-common-markdown`(说明是多轮),但每对 user/ai 的对应关系需要沿 `.agent-chat__list__item__content` 遍历验证
- **登录墙**:未登录时 UI 特征
- **URL 结构**:`chat/{agentId}/{convId}` 结构,`agentId=naQivTmsDa` 是「元宝助手」,可能有其他智能体如「读书」`agentId` 不同
