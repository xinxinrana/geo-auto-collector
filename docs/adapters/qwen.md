# 千问（Qwen Studio）

验证日期：2026-09-23。访问 `https://chat.qwen.ai/`，访客会话可直接提问；回答后地址为 `/c/guest`。连续测试后网站曾跳转 `/auth`，因此批量采集需要准备可用登录会话，适配器会将登录跳转报告为 `login_required`。

| 用途 | 已验证选择器 |
|---|---|
| 输入框 | `textarea.message-input-textarea` |
| 发送按钮 | `button.send-button` |
| 用户提问 | `.chat-user-message` |
| 最终回答 | `.response-message-content.phase-answer` |
| 生成中 | `button.stop-button:not(.disabled)` |

输入必须使用 `HTMLTextAreaElement.prototype.value` 的原生 setter 并触发 `input` 事件。直接逐字改写 `textarea.value` 会让 React 状态与 DOM 脱节，发送按钮不出现。发送按钮的普通 `element.click()` 不能完成提交；适配器通过扩展后台的 CDP 鼠标事件点击。

已通过的验证：真实网页提问返回“千问适配验证成功”；适配器提问与当前页采集均提取到该回答；加载插件后，平台控制台单条试运行返回 `status=ok`、`text=插件千问全链路通过`、`answerChars=9`。

复现：先确保千问页面可直接聊天；如跳转登录页，先完成登录。刷新插件，在千问页面打开平台控制台，选择“千问”，输入 `请只回答：插件千问全链路通过` 并点击“运行一次”。预期试运行成功，正文只包含 `插件千问全链路通过`，不会混入思考过程或页面导航。
