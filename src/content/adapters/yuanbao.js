// yuanbao.js — 元宝 (yuanbao.tencent.com) 平台 adapter
// 入口:
//   runYuanbaoTask(query, config)      —— 全流程
//   collectYuanbaoPage(config)         —— 仅采集
//
// DOM 参考: docs/adapters/yuanbao.md
// 关键锚:
//   输入框: .ql-editor (Quill)
//   发送/停止: a[class*="send-btn"] (发送/停止图标切换 + --disabled 后缀类)
//   消息容器: .agent-chat__list__item__content
//   用户气泡: .agent-chat__bubble--human
//   助手气泡: .agent-chat__bubble--ai
//   答案文本: .hyc-common-markdown (在助手气泡内)

(function () {
  const G = globalThis.GEO;

  async function findInput() {
    const selectors = ['.ql-editor', 'div[contenteditable=true][data-prevent-quill-blur]', 'div[contenteditable=true]'];
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      }
      await G.sleep(500);
    }
    return null;
  }

  function findSendButton() {
    // 发送态: a[class*=send-btn] 里含 .icon-send
    const btns = [...document.querySelectorAll('a[class*="send-btn"]')].filter((b) => b.offsetParent !== null);
    for (const b of btns) {
      const cls = b.className || '';
      if (/send-btn--disabled/.test(cls)) continue;
      if (b.querySelector('.icon-send')) return b;
    }
    return null;
  }

  function isYuanbaoGenerating() {
    const btn = document.querySelector('a[class*="send-btn"]');
    if (!btn) return false;
    // 生成中:内部为 svg > rect (方块图标),而非 .icon-send
    return !btn.querySelector('.icon-send') && !!btn.querySelector('svg rect');
  }

  // 元宝有多个 .agent-chat__list__item__content,取最后一个非用户的作 assistant,
  // 前面最近一个含 --human 的作 user
  function findLastQA() {
    const items = [...document.querySelectorAll('.agent-chat__list__item__content')].filter((e) => e.offsetParent !== null);
    if (!items.length) return null;
    let assistantItem = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.querySelector('.agent-chat__bubble--ai') || it.querySelector('.agent-chat__conv--ai')) {
        assistantItem = it; break;
      }
    }
    if (!assistantItem) return null;
    let userItem = null;
    const idx = items.indexOf(assistantItem);
    for (let i = idx - 1; i >= 0; i--) {
      const it = items[i];
      if (it.querySelector('.agent-chat__bubble--human') || it.querySelector('.agent-chat__conv--human')) {
        userItem = it; break;
      }
    }
    // 计算最小公共祖先:两者共同的父
    const ancestors = (n) => { const a = []; while (n) { a.push(n); n = n.parentElement; } return a; };
    const bChain = new Set(ancestors(assistantItem));
    let qaAncestor = assistantItem;
    if (userItem) {
      const chain = ancestors(userItem);
      qaAncestor = chain.find((n) => bChain.has(n)) || assistantItem.parentElement || assistantItem;
    }
    return { userItem, assistantItem, qaAncestor };
  }

  function answerRoot(qa) {
    const q = qa || findLastQA();
    if (!q || !q.assistantItem) return document.body;
    // 元宝可能同时存在 CoT (deepsearch-cot) + 最终答案(hyc-common-markdown)
    // 最终答案总是最后一个 .hyc-common-markdown(不在 CoT 容器内的)
    const allMd = [...q.assistantItem.querySelectorAll('.hyc-common-markdown')];
    // 排除 CoT 内的
    const finalMd = allMd.filter((m) => !m.closest('.hyc-component-deepsearch-cot'));
    if (finalMd.length) return finalMd[finalMd.length - 1];
    if (allMd.length) return allMd[allMd.length - 1];
    const md =
      q.assistantItem.querySelector('.agent-chat__conv--ai__speech_show') ||
      q.assistantItem.querySelector('[class*=markdown]');
    return md || q.assistantItem;
  }

  function loginRequired() {
    return /\/login|\/signin|passport\./i.test(location.href);
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 400, maxWait: 240000, ...config };
    const qa = findLastQA();
    if (tr) tr.push('findLastQA', qa ? { user: !!qa.userItem, assistant: !!qa.assistantItem } : null);
    const root = answerRoot(qa);
    if (tr) tr.push('answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: (root.innerText || '').length });

    let text, timedOut = false;
    if (ensureComplete || isYuanbaoGenerating()) {
      const r = await G.waitAnswerComplete({ root, minChars: cfg.minChars, maxWait: cfg.maxWait });
      text = r.text; timedOut = r.timedOut;
    } else {
      text = (root.innerText || '').trim();
    }
    if (tr) tr.push('collected', { chars: text.length, timedOut });

    const citations = G.extractCitations({ root: qa ? qa.assistantItem : document.body });
    if (tr) tr.push('citations', { n: citations.length });

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      qaHtml: qa ? qa.qaAncestor.outerHTML.slice(0, 200000) : null,
      qaSelector: '.agent-chat__list__item__content',
      url: location.href,
      timedOut,
    };
  }

  globalThis.runYuanbaoTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runYuanbaoTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput();
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { cls: String(box.className).slice(0, 60) });

      // Quill 编辑器:humanType 里 execCommand 有效
      await G.humanType(box, query);
      tr.push('typed');
      await G.sleep(G.rand(600, 1000));

      const sendBtn = findSendButton();
      if (sendBtn) {
        sendBtn.click();
        tr.push('sent via a.send-btn');
      } else {
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        tr.push('sent via Enter (send btn not found)');
      }

      await G.sleep(3500);
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }

      const out = await collect(config, true, tr);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  globalThis.collectYuanbaoPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectYuanbaoPage start', { url: location.href });
    try {
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }
      const qa = findLastQA();
      if (!qa || !qa.assistantItem) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      const len = (qa.assistantItem.innerText || '').trim().length;
      if (len < 20) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      const out = await collect(config, false, tr);
      out.keyword = inferKeyword(qa);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  function inferKeyword(qa) {
    const q = qa || findLastQA();
    if (q && q.userItem) {
      const bubble = q.userItem.querySelector('.agent-chat__bubble--human') || q.userItem;
      const t = (bubble.innerText || '').trim();
      if (t.length > 1) return t.slice(0, 200);
    }
    const title = (document.title || '').replace(/\s*[|\-–]\s*.*$/i, '').trim();
    return title || '当前页面';
  }
})();
