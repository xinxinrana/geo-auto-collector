# yuanbao DOM 侦查报告(collect 模式)

- 时间: 2026-07-21T03:03:03.034Z
- URL: https://yuanbao.tencent.com/chat/naQivTmsDa/0Ox3T8VPpQ0
- 问题: "CDP 无法获取用户基础信息"
- 快照: yuanbao_collect_2026-07-21T03-03-03.html



## 用户气泡
```json
{
  "tag": "div",
  "id": null,
  "className": "yb-recent-conv-list__item active",
  "dataAttrs": [],
  "textLen": 20,
  "innerTextPreview": "CDP 无法获取用户基础信息的原因及解决"
}
```
## 回答节点
```json
{
  "tag": "div",
  "id": null,
  "className": "yb-recent-conv-list__item",
  "dataAttrs": [],
  "textLen": 23,
  "innerTextPreview": "Codex与ChatGPT桌面端新对话卡顿分析"
}
```
## QA 最小公共祖先
```json
{
  "tag": "div",
  "id": null,
  "className": "yb-recent-conv-list",
  "dataAttrs": [],
  "textLen": 576,
  "innerTextPreview": "Chat 本周阅读与自我复盘 ASO简历工具项目阶段规划 CDP 无法获取用户基础信息的原因及解决 编程中Pipeline的概念解析 Shopify Forms 数据导出方法 AKK菌介绍与功效解析 千川能否直接投放豆包商品 豆包商品GEO"
}
```
## 从用户气泡到 QA 祖先的链（含 textLen 跳跃）
```json
[
  {
    "tag": "DIV",
    "cls": "yb-recent-conv-list__item active",
    "dataAttrs": [],
    "textLen": 20
  },
  {
    "tag": "DIV",
    "cls": "yb-recent-conv-list",
    "dataAttrs": [],
    "textLen": 576
  }
]
```
## 引用链接(QA 内 0 个 / 全页 0 个)
```json
[]
```
## 停止按钮候选(用于 isGenerating)
```json
[]
```
## trace
1. start {"url":"https://yuanbao.tencent.com/chat/naQivTmsDa/0Ox3T8VPpQ0","q":"CDP 无法获取用户基础信息"}
2. user_anchored {"tag":"DIV","cls":"yb-recent-conv-list__item active","textLen":20}
3. assistant_by_sib {"hop":0,"tag":"DIV","cls":"yb-recent-conv-list__item","textLen":23}
4. qa_ancestor {"tag":"DIV","cls":"yb-recent-conv-list"}

## QA 祖先 HTML 片段(截取)
```html
<div class="yb-recent-conv-list"><div class="yb-recent-conv-list__split">Chat</div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="5f7b38ef-bc37-4df1-9354-6562966fac27" dt-ext1="1" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="5f7b38ef-bc37-4df1-9354-6562966fac27" data-item-name="本周阅读与自我复盘" class="yb-recent-conv-list__item-name isTop" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">本周阅读与自我复盘</div><div class="yb-recent-conv-list__chat-top"><span class="yb-icon iconfont-yb icon-yb-ic_pin_16"></span></div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="cc5aa8fe-95fd-4c66-899a-9299cf0cb257" dt-ext1="2" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="cc5aa8fe-95fd-4c66-899a-9299cf0cb257" data-item-name="ASO简历工具项目阶段规划" class="yb-recent-conv-list__item-name isTop" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">ASO简历工具项目阶段规划</div><div class="yb-recent-conv-list__chat-top"><span class="yb-icon iconfont-yb icon-yb-ic_pin_16"></span></div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0Ox3T8VPpQ0" dt-ext1="3" dt-ext5="0" class="yb-recent-conv-list__item active"><div data-item-id="0Ox3T8VPpQ0" data-item-name="CDP 无法获取用户基础信息的原因及解决" class="yb-recent-conv-list__item-name" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">CDP 无法获取用户基础信息的原因及解决</div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0Or2nprXQA4" dt-ext1="4" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="0Or2nprXQA4" data-item-name="编程中Pipeline的概念解析" class="yb-recent-conv-list__item-name" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">编程中Pipeline的概念解析</div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0OvNQFVknlw" dt-ext1="5" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="0OvNQFVknlw" data-item-name="Shopify Forms 数据导出方法" class="yb-recent-conv-list__item-name" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">Shopify Forms 数据导出方法</div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0Op9FL2KAyn" dt-ext1="6" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="0Op9FL2KAyn" data-item-name="AKK菌介绍与功效解析" class="yb-recent-conv-list__item-name" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">AKK菌介绍与功效解析</div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0Oqx5XS9E6y" dt-ext1="7" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="0Oqx5XS9E6y" data-item-name="千川能否直接投放豆包商品" class="yb-recent-conv-list__item-name" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">千川能否直接投放豆包商品</div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0Oqwmpn5iJk" dt-ext1="8" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="0Oqwmpn5iJk" data-item-name="豆包商品GEO投放渠道说明" class="yb-recent-conv-list__item-name" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">豆包商品GEO投放渠道说明</div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0OqU5JbFyoz" dt-ext1="9" dt-ext5="0" class="yb-recent-conv-list__item"><div data-item-id="0OqU5JbFyoz" data-item-name="千川投流一站式管理工具解析" class="yb-recent-conv-list__item-name" draggable="true" style="cursor: pointer; transition: opacity 0.2s;">千川投流一站式管理工具解析</div><div class="yb-recent-conv-list__dropdown-trigger"><span class="yb-icon iconfont-yb icon-yb-ic_ellipsis"></span></div></div><div dt-exposure="OnView" dt-page-id="SlidePage" dt-mod-id="list_mod" dt-agent-id="naQivTmsDa" dt-cid="0OqMFfG1GXg" dt-ext1="10" dt-ext5="0" class="yb-recent-conv-list__item"><div
```