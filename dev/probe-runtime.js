// dev/probe-runtime.js — 页面内跑的侦查器（CDP.evaluate 注入）
// 采集完整交互链路上的 7 个锚点：
//   1) 输入框  2) 发送按钮(输入前后对比)  3) 停止按钮(生成中轮询)
//   4) 用户气泡  5) 回答节点  6) QA 最小公共祖先  7) 登录墙特征
//
// 参数: (question: string, platform: string)

async function probeRuntime(question, platform) {
  const trace = [];
  const t = (msg, extra) => {
    trace.push(extra !== undefined ? `${msg} ${typeof extra === 'object' ? JSON.stringify(extra) : extra}` : msg);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 通用工具 ----
  const describe = (el) => el ? {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    dataAttrs: [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => ({ name: a.name, value: (a.value || '').slice(0, 60) })),
    ariaLabel: el.getAttribute('aria-label') || null,
    role: el.getAttribute('role') || null,
    testid: el.getAttribute('data-testid') || null,
    title: el.getAttribute('title') || null,
    editable: !!el.isContentEditable,
    disabled: !!el.disabled,
    visible: el.offsetParent !== null,
    textLen: (el.innerText || '').length,
    innerTextPreview: (el.innerText || '').slice(0, 100).replace(/\n+/g, ' '),
  } : null;

  const snapshotButtons = (root = document) => {
    return [...root.querySelectorAll('button, [role=button]')].filter(b => b.offsetParent !== null).map(b => ({
      aria: b.getAttribute('aria-label'),
      testid: b.getAttribute('data-testid'),
      title: b.getAttribute('title'),
      role: b.getAttribute('role'),
      cls: String(b.className || '').slice(0, 80),
      text: (b.innerText || '').trim().slice(0, 30),
      icon: b.querySelector('svg use')?.getAttribute('href') || b.querySelector('svg')?.getAttribute('class')?.slice(0, 40) || null,
      matIcon: b.querySelector('mat-icon')?.getAttribute('data-mat-icon-name') || null,
      disabled: b.disabled,
      inMain: !!b.closest('main'),
      inNav: !!b.closest('nav, aside, [role=navigation]'),
    }));
  };

  const buttonKey = (b) => `${b.aria || ''}|${b.testid || ''}|${b.icon || b.matIcon || ''}|${b.text || ''}`;

  try {
    t('start', { url: location.href, platform });

    // ---- 7) 先检测登录墙 ----
    const loginFeatures = (() => {
      const patterns = [/log ?in/i, /sign ?in/i, /sign ?up/i, /登录/, /登入/, /注册/, /微信登录/, /手机登录/];
      const found = [];
      for (const p of patterns) {
        const btn = [...document.querySelectorAll('button, a, [role=button]')].find(el => {
          const s = (el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '');
          return p.test(s) && el.offsetParent !== null;
        });
        if (btn) found.push({ pattern: String(p), tag: btn.tagName.toLowerCase(), text: (btn.innerText || '').slice(0, 40), href: btn.getAttribute('href') || null, cls: String(btn.className || '').slice(0, 60) });
      }
      const urlIsLogin = /\/login|\/signin|\/sign-in|\/auth\/|accounts\.google|passport/i.test(location.href);
      return { urlIsLogin, buttons: found.slice(0, 6) };
    })();
    t('login_check', { urlIsLogin: loginFeatures.urlIsLogin, matchedButtons: loginFeatures.buttons.length });

    // ---- 1) 找输入框 ----
    const inputSelectors = {
      gemini: ['div.ql-editor[contenteditable=true]', 'rich-textarea div[contenteditable=true]', 'div[contenteditable=true]'],
      chatgpt: ['#prompt-textarea', 'div[contenteditable=true]', 'textarea'],
      claude: ['div[contenteditable=true].ProseMirror', 'div[contenteditable=true]', 'textarea'],
      perplexity: ['div[role=textbox]', 'textarea', '[contenteditable=true]'],
      doubao: ['textarea[data-testid*=input]', 'textarea', 'div[contenteditable=true]'],
      kimi: ['div[contenteditable=true][data-lexical-editor=true]', 'div[contenteditable=true]', 'div[role=textbox]', 'textarea'],
      yuanbao: ['div[contenteditable=true]', 'textarea', 'div[role=textbox]'],
    };

    // 记录所有可能的输入候选（不管是否命中，都存下来供文档参考）
    const inputCandidatesAll = [];
    for (const sel of ['textarea', 'div[contenteditable=true]', 'div[role=textbox]', '.ProseMirror', '[data-lexical-editor=true]']) {
      for (const el of document.querySelectorAll(sel)) {
        inputCandidatesAll.push({ sel, ...describe(el) });
      }
    }
    t('input_candidates_all', { count: inputCandidatesAll.length });

    const sels = inputSelectors[platform] || inputSelectors.gemini;
    let input = null;
    for (let attempt = 0; attempt < 20 && !input; attempt++) {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { input = el; break; }
      }
      if (!input) await sleep(500);
    }
    if (!input) return { ok: false, error: 'input_not_found', trace, inputCandidatesAll, loginFeatures };
    t('input_found', { tag: input.tagName, cls: String(input.className).slice(0, 60) });

    const inputInfo = describe(input);
    // 记录 input 的祖先链（可看到 form/container 结构）
    const inputAncestors = [];
    let n = input;
    for (let i = 0; i < 6 && n; i++) {
      inputAncestors.push({ tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 70), dataAttrs: [...n.attributes].filter(a => a.name.startsWith('data-')).map(a => a.name).slice(0, 4) });
      n = n.parentElement;
    }

    // ---- 2) 输入前的按钮快照 ----
    const buttonsBeforeType = snapshotButtons();

    // ---- 输入问题 ----
    input.focus();
    if (input.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(input);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.execCommand('delete', false);
      for (const ch of question) document.execCommand('insertText', false, ch);
    } else {
      input.value = '';
      for (const ch of question) {
        input.value += ch;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      }
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(1000);
    t('typed');

    // ---- 2) 输入后的按钮快照 → 找出新出现的按钮（大概率是发送按钮） ----
    const buttonsAfterType = snapshotButtons();
    const beforeKeys = new Set(buttonsBeforeType.map(buttonKey));
    const newAfterType = buttonsAfterType.filter(b => !beforeKeys.has(buttonKey(b)));
    t('buttons_diff', { before: buttonsBeforeType.length, after: buttonsAfterType.length, newlyAppeared: newAfterType.length });

    // 尝试点发送按钮（多种候选）
    const sendSelectors = [
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button[data-testid=send-button]',
      'button[data-testid*=send i]',
      'button[type=submit]',
    ];
    let sendBtn = null;
    for (const sel of sendSelectors) {
      const b = document.querySelector(sel);
      if (b && !b.disabled && b.offsetParent !== null) { sendBtn = b; break; }
    }
    // 若 selector 未命中，用 newAfterType 里的第一个非菜单类按钮兜底（但侦查只报告，不点）
    const sendCandidates = newAfterType.filter(b => !/menu|option|模式|模型|工具|设置|attach|upload/i.test((b.aria || '') + (b.text || ''))).slice(0, 5);
    if (sendBtn) {
      sendBtn.click();
      t('sent_via_selector', { sel: sendBtn.getAttribute('aria-label') || sendBtn.getAttribute('data-testid') });
    } else {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      t('sent_via_enter');
    }

    // ---- 3) 生成中：轮询捕获停止按钮 ----
    const stopSnapshots = [];
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止"]',
      'button[aria-label*="中止"]',
      'button[data-testid=stop-button]',
      'button[data-testid*=stop i]',
      '[data-testid=stop-generating]',
    ];
    const isGenerating = () => stopSelectors.some((sel) => {
      const el = document.querySelector(sel);
      return el && el.offsetParent !== null;
    });

    // 前 12 秒每 1 秒抓一次「输入后新出现的按钮」
    const gencapDurations = [1000, 1500, 2000, 2500, 3500, 5000, 7000, 10000, 14000, 20000];
    let elapsed = 0;
    const seenStopButtons = new Map();
    for (const step of gencapDurations) {
      await sleep(step - elapsed);
      elapsed = step;
      const cur = snapshotButtons();
      const newHere = cur.filter(b => !beforeKeys.has(buttonKey(b)));
      const stops = newHere.filter(b => /stop|停止|中止|pause/i.test((b.aria || '') + (b.testid || '') + (b.title || '') + (b.text || '')));
      for (const s of stops) {
        const k = buttonKey(s);
        if (!seenStopButtons.has(k)) seenStopButtons.set(k, s);
      }
      stopSnapshots.push({ atMs: elapsed, generating: isGenerating(), stopCount: stops.length });
      if (elapsed > 20000) break;
    }
    t('stop_button_probe', { snapshots: stopSnapshots.length, uniqueStopButtons: seenStopButtons.size });

    // ---- 等生成完成 ----
    let prevLen = 0, stable = 0, waited = 20000, sawGenerating = seenStopButtons.size > 0;
    const POLL = 2500, MAX_WAIT = 120000, STABLE_NEED = 4;
    while (waited < MAX_WAIT) {
      await sleep(POLL);
      waited += POLL;
      const len = (document.body.innerText || '').length;
      const gen = isGenerating();
      if (gen) sawGenerating = true;
      stable = (len === prevLen) ? stable + 1 : 0;
      prevLen = len;
      if (!gen && stable >= STABLE_NEED && len > 300) {
        if (sawGenerating || stable >= STABLE_NEED + 2) break;
      }
    }
    t('wait_done', { waited, prevLen, sawGenerating });

    // ---- 4~6) 用问题文本反查用户气泡 → 找回答 → 计算 QA 祖先 ----
    // 必须限定在 <main> 内（若无 main 则排除 sidebar/nav）
    const searchRoot = document.querySelector('main') || document.body;
    const inSidebar = (el) => el.closest('nav, aside, [role=navigation], [role=complementary], [data-history-container], [class*=sidebar], [class*=history-]');

    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const qNorm = norm(question);
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_ELEMENT);
    const matches = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (inSidebar(el)) continue;
      const text = norm(el.innerText || '');
      if (text.includes(qNorm) && text.length < qNorm.length * 8) matches.push(el);
    }
    matches.sort((a, b) => a.innerText.length - b.innerText.length);
    const userNode = matches[0] || null;
    if (!userNode) {
      return {
        ok: false, error: 'user_bubble_not_found_by_text_anchor', trace,
        inputCandidatesAll, inputInfo, inputAncestors,
        buttonsBeforeType, buttonsAfterType, newAfterType, sendCandidates,
        stopSnapshots, seenStopButtons: [...seenStopButtons.values()],
        loginFeatures,
        pageStats: { bodyLen: (document.body.innerText || '').length, mainLen: searchRoot ? (searchRoot.innerText || '').length : 0, matchesFound: matches.length },
      };
    }
    t('user_anchored', { tag: userNode.tagName, cls: String(userNode.className).slice(0, 80), textLen: userNode.innerText.length });

    let assistantNode = null;
    let hopNode = userNode;
    for (let hop = 0; hop < 12 && !assistantNode; hop++) {
      let sib = hopNode.nextElementSibling;
      while (sib) {
        const sibText = norm(sib.innerText || '');
        if (sibText.length > qNorm.length * 1.5 && !sibText.includes(qNorm)) {
          assistantNode = sib;
          t('assistant_by_sib', { hop, tag: sib.tagName, cls: String(sib.className).slice(0, 80), textLen: sib.innerText.length });
          break;
        }
        sib = sib.nextElementSibling;
      }
      if (!assistantNode) hopNode = hopNode.parentElement;
      if (!hopNode) break;
    }

    const ancestors = (n) => { const arr = []; while (n) { arr.push(n); n = n.parentElement; } return arr; };
    const aChain = ancestors(userNode);
    const bChain = new Set(assistantNode ? ancestors(assistantNode) : []);
    const qaAncestor = assistantNode ? (aChain.find((n) => bChain.has(n)) || document.body) : (userNode.closest('main') || document.body);
    t('qa_ancestor', { tag: qaAncestor.tagName, cls: String(qaAncestor.className).slice(0, 80) });

    // ancestor 链（含 textLen 跳跃）
    const chainInfo = [];
    let cn = userNode;
    while (cn && cn !== qaAncestor.parentElement) {
      chainInfo.push({
        tag: cn.tagName, cls: String(cn.className || '').slice(0, 80),
        dataAttrs: [...cn.attributes].filter(a => a.name.startsWith('data-')).map(a => a.name).slice(0, 6),
        textLen: (cn.innerText || '').length,
      });
      cn = cn.parentElement;
    }

    // QA 内的链接
    const linksInQA = [...qaAncestor.querySelectorAll('a[href^="http"]')].map(a => a.getAttribute('href'));
    const linksInPage = [...document.querySelectorAll('a[href^="http"]')].length;

    return {
      ok: true,
      trace,
      // 1. 输入框
      inputCandidatesAll,
      inputInfo,
      inputAncestors,
      // 2. 发送按钮
      buttonsBeforeType,
      buttonsAfterType,
      newAfterType,
      sendCandidates,
      // 3. 停止按钮
      stopSnapshots,
      seenStopButtons: [...seenStopButtons.values()],
      // 4~6. QA
      userNode: describe(userNode),
      assistantNode: describe(assistantNode),
      qaAncestor: describe(qaAncestor),
      ancestorChain: chainInfo,
      linksInQA: linksInQA.slice(0, 30),
      linksInPageCount: linksInPage,
      qaAncestorHtmlPreview: qaAncestor.outerHTML.slice(0, 5000),
      // 7. 登录墙
      loginFeatures,
      // 答案文本（用于人肉阅读）
      answerText: (qaAncestor.innerText || '').slice(0, 2000),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), trace };
  }
}
