# Claude DOM 结构侦查（未验证-不可信）

## 状态:**待侦查**

- **原因**:本轮侦查用的调试 Chrome profile 未登录 claude.ai。
- v0.2 阶段用户也**未曾真机验证过** Claude(见 [CHANGELOG.md](../CHANGELOG.md))—— 当前 [claude.js](../../src/content/adapters/claude.js) 选择器完全是基于常规约定推测,风险较高。

## 侦查计划(下次执行)

1. 登录 claude.ai。
2. 跑 `node dev/probe-dom.js claude --question "..."`。
3. 整理报告到本文件。

## 已知选择器(来自 v0.2 claude.js,**均未精验**)

| 目标 | 现有选择器 | 备注 |
|---|---|---|
| 输入框 | `div[contenteditable=true].ProseMirror` | ProseMirror 编辑器,大概率有效 |
| 回答容器 | `[data-testid=assistant-message]` `div[class*="font-claude"]` `.prose` | 未验证 |
| 用户消息 | `[data-testid=user-message]` | 未验证 |
| 发送按钮 | `button[aria-label*="Send" i]` | 未验证 |
| 停止按钮 | `button[aria-label*="Stop" i]` | 未验证 |

## 预期 QA 结构(猜测)

Claude UI 有多次改版,当前可能:
- 用 `data-testid` 属性标注消息节点(如果 `assistant-message` / `user-message` 是有效属性)
- 或用自定义组件名
- 或纯 Tailwind + `.prose`

**必须真机侦查后才能给出可靠结论。**

## 待验证

- Claude 的 QA 边界(用户消息 + 助手消息的最小公共祖先)
- Claude 引用/工具调用(如果有 web search / artifacts)的 DOM 形态
- Claude 是否支持逐字流式和停止按钮
