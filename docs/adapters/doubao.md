# 豆包 (Doubao) DOM 结构侦查

- **侦查时间**: 2026-07-21
- **来源页面**: https://www.doubao.com/chat/{数字ID}
- **快照文件**: `dev/snapshots/doubao_collect_2026-07-21T03-01-50.html`
- **侦查手段**: CDP → 打开真实历史对话页 → 文本反查 → 沿祖先链追踪
- **平台栈**: React + Radix UI + Semi Design(字节自家 UI 库)+ 虚拟列表(v_list)

## 核心结论

豆包用**虚拟滚动列表**(`v_list`)承载所有消息,每条消息包在 `.v_list_row[data-observe-row="block_{id}"]` 里。

```
main.center-bg-RKltFg
└── ...
    └── div.list_items                                  ← 所有消息的容器(QA 最小公共祖先候选)
        ├── div.v_list_row (顶部占位)
        ├── div.v_list_row[data-observe-row="block_{userId}"]        ← 用户消息容器
        │   └── ...
        │       └── div[data-message-id="{userId}"][data-container-type="block-v2"]
        │           └── div[data-render-engine="node"][data-plugin-identifier="block_type:10000"]
        │               └── div.content-KTJ1Rj.bg-g-send-msg-bubble-bg    ← 用户气泡样式
        │                   └── div.container-qX9Csx.md-box-root         ← 用户文本
        └── div.v_list_row[data-observe-row="block_{asstId}"]        ← 助手消息容器(下一个兄弟)
            └── ...
                └── div[data-message-id="{asstId}"][data-container-type="block-v2"]
                    └── (回答正文,含 markdown 渲染)
```

## 精确定位选择器(生产 adapter 用)

| 目标 | 选择器 | 说明 |
|---|---|---|
| **所有消息(按顺序)** | `.list_items > div.v_list_row[data-observe-row^="block_"]` | 每个 = 一条消息(user 或 assistant) |
| **最后一条消息** | `[...document.querySelectorAll('...')].at(-1)` | |
| **最后一对 QA** | 取最后两条 v_list_row,倒数第二为 user,倒数第一为 assistant | 假设:user 后紧跟 assistant |
| **消息 id** | `row.querySelector('[data-message-id]').getAttribute('data-message-id')` | 每条消息唯一 |
| **消息类型** | `row.querySelector('[data-plugin-identifier]').getAttribute('data-plugin-identifier')` | `block_type:10000`(用户?), 其他值可能是助手 —— **需真机验证** |
| **消息文本容器** | `row.querySelector('.md-box-root')` | markdown 渲染主体 |
| **用户气泡样式** | `row.querySelector('.bg-g-send-msg-bubble-bg')` | 存在 = 是用户消息 |

## 关键锚点(data 属性 = 最稳定)

- `data-observe-row="block_{数字}"` —— 每条消息在虚拟列表中的锚
- `data-message-id="{数字}"` —— 消息唯一 id
- `data-container-type="block-v2"` —— 消息容器类型标记
- `data-render-engine="node"` —— 渲染引擎
- `data-plugin-identifier="block_type:10000"` —— **区分 user/assistant 的关键**(值待验证)
- `data-target-id="message-box-target-id"` —— 每条消息的 UI target
- `data-streaming="false"` —— 是否流式生成中(生产 adapter 判断生成完成用)

## 忽略字段(易变)

- **Semi Design 类名**: `.semi-input-textarea`、`.semi-icon` 等前缀是 UI 库版本相关,类名稳定但功能属性会变
- **Tailwind + CSS Modules 类名**: `.content-KTJ1Rj`、`.container-qX9Csx`、`.center-bg-RKltFg` —— `-XXXXX` 是 CSS Modules 哈希,构建时变
- **虚拟列表位置**: `style="transform: translate(0, var(--vlist-row-transform-y))"` 是滚动位置,不能用来定位

## 输入框

- **主输入**: `textarea.semi-input-textarea.semi-input-textarea-autosize`
- **额外输入**: 页面顶部/底部各一个,`textarea` 共 2 个
- **React 兼容输入**: 需要用 `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set` 调用 native setter 才能触发 React state 更新 —— **直接 `input.value = ""` 不生效**

## 发送按钮

**已侦查完成(2026-07-21)**:

- 输入框空态时,输入区右下角**没有**发送按钮;输入非空后,同位置出现 `<div class="send-btn-wrapper">` 包裹的 `<button>`,SVG 图标 class 含 **`text-g-send-msg-btn-text`**(是最稳定的锚,豆包内部叫 "g-send-msg-btn")
- 生产 adapter 定位方式:
  ```js
  // 首选: 通过 SVG icon 特征
  const sendBtn = [...document.querySelectorAll('button')].find(b => {
    const svg = b.querySelector('svg');
    return svg && /send-msg-btn/i.test(svg.getAttribute('class') || '');
  });
  // 或: 通过 wrapper 类名
  const sendWrap = document.querySelector('div.send-btn-wrapper');
  const sendBtn2 = sendWrap && sendWrap.querySelector('button');
  ```
- **必须先输入内容再定位**,否则空态下按钮不存在
- **必须用 React native setter 输入**:
  ```js
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, question);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  ```

## 停止按钮

**已侦查完成(2026-07-21)**:

- 生成开始后,原发送按钮位置(x=1414, y=830 附近)**被同位置替换**为:
  ```html
  <div class="size-34 rounded-full hover:bg-dbx-fill-trans-20-hover bg-dbx-fill-trans-20 overflow-hidden cursor-pointer"
       data-state="closed" data-trigger-type="hover">
    <svg class="block size-18"><path d="M12 0.5C18.3513 0.5 23.5 5.64873 23.5 12..." /></svg>
  </div>
  ```
- **特征**:
  - 位置:输入区右下角(与发送键同位置替换)
  - 类:`size-34.rounded-full` + `cursor-pointer`
  - SVG path 以 `M12 0.5C18.3513 0.5 23.5 5.64873` 开头(表示圆圈,里面套方形 = 停止图标)
  - **无 aria-label/testid**,通过 Radix UI 的 `data-state`+`data-trigger-type` 标记
- 生产 adapter 判断生成中的最稳定方式:
  ```js
  function isGenerating() {
    const sendBtn = document.querySelector('div.send-btn-wrapper button');
    if (sendBtn) return false; // send-btn-wrapper 只在非生成态存在
    // 或直接查同位置有没有停止 icon
    const stopIcon = [...document.querySelectorAll('div.size-34.rounded-full.cursor-pointer svg')]
      .find(s => (s.querySelector('path')?.getAttribute('d') || '').startsWith('M12 0.5C18'));
    return !!stopIcon;
  }
  function clickStop() {
    const stopIcon = [...document.querySelectorAll('div.size-34.rounded-full.cursor-pointer')]
      .find(d => (d.querySelector('svg path')?.getAttribute('d') || '').startsWith('M12 0.5C18'));
    if (stopIcon) stopIcon.click();
  }
  ```

## 引用来源

- **本次侦查页面无引用**(闲聊类问题)
- 豆包一般无 web browsing,答案里罕见 http 外链
- 若有,应扫**当前 QA `.v_list_row` 内**的 `<a>`,不扫全页

## 登录墙

- URL 特征: `/login`、`from_login=1`
- 未登录时页面 UI 会显示登录弹窗,DOM 特征未侦查

## 关键改造点(vs 未来 doubao.js adapter)

1. **QA 边界**:取 `.list_items` 内最后两个 `.v_list_row[data-observe-row^=block_]`,通过 `data-plugin-identifier` 区分 user/assistant。
2. **答案容器**:`row.querySelector('.md-box-root')` 直接命中 markdown 主体。
3. **`inferKeyword`**:用户消息 `.v_list_row` 的 `.md-box-root` 的 `innerText`。
4. **输入方法**:必须用 React native setter,不能直接 `.value=`。
5. **发送按钮**:需要真机再摸清 —— 用**位置(输入区最右下)**或**SVG icon path** 兜底。
6. **截图**:直接传 QA `.v_list_row` 的最小公共祖先(或 `.list_items` 的最后两个 row)给 html2canvas。

## 待验证

- **`data-plugin-identifier` 值枚举**:确认 `block_type:10000` 是 user 还是 assistant;助手的值(可能是 `block_type:10001` 或其他)
- **发送按钮的稳定标识**:真机 devtools 或点开 React DevTools 查
- **多轮对话时** `.v_list_row` 是否为每条消息一个(虚拟列表可能只渲染可视区)
- **流式生成中的 `data-streaming` 变化**:验证是否可靠判断生成完成
