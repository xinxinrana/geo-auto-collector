# DeepSeek

验证日期：2026-09-23。访问 `https://chat.deepseek.com/` 需要登录；用户在可见浏览器中完成人机验证。回答后地址为 `/a/chat/s/...`。

| 用途 | 已验证选择器 |
|---|---|
| 输入框 | `textarea[name="search"]` |
| 发送按钮 | `.ds-button--primary.ds-button--circle:not(.ds-button--disabled)` |
| 用户提问 | `.ds-collapsible-text` |
| 回答正文 | `.ds-assistant-message-main-content` |

DeepSeek 页面同时含有如 `_52c986b` 的哈希类名，适配器不依赖它们。输入使用原生 textarea setter 与 `input` 事件；该平台的发送按钮已验证可通过 `element.click()` 提交。问答位于虚拟列表，采集时只取当前可见的最后一条回答，并把用户提问和回答 DOM 一同保存。

已通过的验证：真实网页提问返回“DeepSeek适配验证成功”；适配器自动提问返回 `status=ok`、`answerChars=14`，采集当前页同样返回 `status=ok`、`answerChars=14`。未在独立的插件测试浏览器中重复登录，因此插件后台批量任务仍需在已登录的浏览器中复测。

复现：先登录 DeepSeek 并刷新插件，在平台控制台选择“DeepSeek”，输入 `请只回答：DeepSeek适配验证成功` 并点击“运行一次”。预期正文只包含 `DeepSeek适配验证成功`，提问不会混进回答正文。
