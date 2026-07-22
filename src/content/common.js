// common.js — 平台无关的采集原语，注入到目标页的隔离世界。
// 迁移自 CDP 方案的 wait_generation / is_generating / 拟人输入 / 引用抓取。
// 挂到 globalThis.GEO 供各平台 adapter 复用。

(function () {
  if (globalThis.GEO) return; // 避免重复注入

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  // 日志：打印到目标页控制台，统一前缀便于过滤
  function log(...args) {
    try { console.log('[GEO]', ...args); } catch {}
  }

  // 追踪器：收集分步日志，随结果返回，便于在 SW/popup 排查失败点
  function makeTrace() {
    const steps = [];
    return {
      push(msg, extra) {
        const line = extra !== undefined ? `${msg} ${typeof extra === 'object' ? JSON.stringify(extra) : extra}` : msg;
        steps.push(line);
        log(line);
      },
      steps,
    };
  }

  // 停止/生成中按钮检测（多平台通用选择器，命中即认为仍在生成）
  const STOP_SELECTORS = [
    'button[data-testid=stop-button]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
    'button[aria-label="Stop streaming"]',
    '[data-testid=stop-generating]',
  ];

  function isGenerating() {
    for (const sel of STOP_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return true;
    }
    return false;
  }

  // 等生成结束。三条独立的完成信号,任一命中立即返回,不做叠加等待:
  //   A) 曾经看到过 stop 按钮,现在消失了 → 强信号,立即采集
  //   B) 正文长度连续两次 poll(默认 3s)未变 → 视为写完
  //      - GPT(requireMinCharsForStable=true): 还需满足 minChars,防止过短提前采集
  //      - 其他平台(requireMinCharsForStable=false): 只要长度稳定即可,避免等超时
  //   C) 达到 maxWait → 兜底返回
  // 首次 poll 前 sleep(poll):给页面时间开始生成、以及给 stop 按钮时间挂上 DOM。
  async function waitAnswerComplete(opts = {}) {
    const {
      root = document.body,
      minChars = 300,
      maxWait = 180000,
      poll = 3000,
      // GPT 默认保持原行为,其他平台传 false 以启用"3s 稳定即采集"
      requireMinCharsForStable = true,
      // 平台自定义生成判断,未提供则用通用 isGenerating()
      isGeneratingFn,
    } = opts;

    let prevLen = -1;
    let waited = 0;
    let sawGenerating = false;

    while (waited < maxWait) {
      await sleep(poll);
      waited += poll;
      const txt = (root.innerText || '').trim();
      const len = txt.length;
      const gen = typeof isGeneratingFn === 'function' ? isGeneratingFn() : isGenerating();
      if (gen) { sawGenerating = true; prevLen = len; continue; }

      // 信号 A:曾经在生成,现在 stop 按钮消失 —— 立即返回
      if (sawGenerating) return { text: txt, timedOut: false };

      // 信号 B:长度稳定(连续两次 poll 相同)
      if (len > 0 && len === prevLen) {
        if (!requireMinCharsForStable || len >= minChars) {
          return { text: txt, timedOut: false };
        }
      }

      prevLen = len;
    }
    return { text: (root.innerText || '').trim(), timedOut: true };
  }

  // 拟人输入到 contenteditable / textarea（React 受控：用 execCommand insertText + 派发事件）
  async function humanType(el, text, delayMin = 50, delayMax = 150) {
    el.focus();
    // 清空已有内容
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
    } else {
      el.value = '';
    }
    for (const ch of text) {
      if (el.isContentEditable) {
        // execCommand 能触发 React 受控组件识别
        document.execCommand('insertText', false, ch);
      } else {
        el.value += ch;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      }
      await sleep(rand(delayMin, delayMax));
    }
    // 兜底再派发一次 input，确保状态同步
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  // 引用域名抓取，迁移 domains_from_page
  function extractCitations(opts = {}) {
    const exclude = opts.exclude || [
      'perplexity', 'google.com', 'gstatic', 'openai', 'chatgpt',
      'gemini', 'googleusercontent', 'googletagmanager',
    ];
    const root = opts.root || document.body;
    const map = new Map();
    const add = (href) => {
      if (!href || !href.startsWith('http')) return;
      if (exclude.some((x) => href.includes(x))) return;
      let host;
      try { host = new URL(href).hostname.replace('www.', ''); } catch { return; }
      if (!host) return;
      if (!map.has(host)) map.set(host, { domain: host, count: 0, sampleUrl: href });
      map.get(host).count++;
    };
    root.querySelectorAll('a[href^="http"]').forEach((a) => add(a.getAttribute('href')));
    // 通用来源容器（Gemini chip 等）
    const selectors = ['[class*=citation] a', '[class*=source] a', 'sources-list a', '[data-url]', '[data-href]'];
    selectors.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el) => {
        ['href', 'data-url', 'data-href'].forEach((attr) => add(el.getAttribute(attr)));
      });
    });
    return [...map.values()];
  }

  // ---- QA 节点通用工具:限定 root 内做问题文本反查 → 找回答 → 计算最小公共祖先 ----
  // 适用于 adapter 里 "结构选择器失效时的 fallback",或作为 collect 模式的锚点。
  // opts:
  //   root        —— 搜索根(默认 <main> || document.body)
  //   excludeSel  —— 排除的祖先选择器(默认 sidebar/nav/history)
  //   maxRatio    —— 匹配节点 innerText 长度不超过 query.length * maxRatio (默认 8)
  //   answerRatio —— 助手节点 innerText 长度阈值:>= query.length * answerRatio (默认 1.5)
  // 返回: { userNode, assistantNode, qaAncestor } 或 null
  function findQANodeByAnchor(query, opts = {}) {
    const {
      root = document.querySelector('main') || document.body,
      excludeSel = 'nav, aside, [role=navigation], [role=complementary], [class*=sidebar], [class*=history], [data-history-container]',
      maxRatio = 8,
      answerRatio = 1.5,
    } = opts;
    if (!query || query.length < 2) return null;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const qNorm = norm(query).toLowerCase();
    const inSidebar = (el) => el.closest && el.closest(excludeSel);

    // 遍历所有 element,收集 innerText 含 qNorm 且长度不超过阈值的节点
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const matches = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (inSidebar(el)) continue;
      const text = norm(el.innerText || '').toLowerCase();
      if (text.includes(qNorm) && text.length < qNorm.length * maxRatio) matches.push(el);
    }
    // 取最短(最贴近气泡本体)的
    matches.sort((a, b) => a.innerText.length - b.innerText.length);
    const userNode = matches[0] || null;
    if (!userNode) return null;

    // 向后/向上找回答:兄弟层扫,找不到跳父层
    let assistantNode = null;
    let hopNode = userNode;
    for (let hop = 0; hop < 12 && !assistantNode; hop++) {
      let sib = hopNode.nextElementSibling;
      while (sib) {
        const sibText = norm(sib.innerText || '');
        if (sibText.length > qNorm.length * answerRatio && !sibText.toLowerCase().includes(qNorm)) {
          assistantNode = sib;
          break;
        }
        sib = sib.nextElementSibling;
      }
      if (!assistantNode) hopNode = hopNode.parentElement;
      if (!hopNode) break;
    }

    // 计算最小公共祖先
    const ancestors = (n) => { const a = []; while (n) { a.push(n); n = n.parentElement; } return a; };
    const aChain = ancestors(userNode);
    const bChain = new Set(assistantNode ? ancestors(assistantNode) : []);
    const qaAncestor = assistantNode
      ? aChain.find((n) => bChain.has(n)) || root
      : userNode.closest('main') || root;

    return { userNode, assistantNode, qaAncestor };
  }

  // ---- DOM 节点截图 ----
  // 依赖 html-to-image(在 SW 里通过 chrome.scripting.executeScript files 注入 src/lib/html-to-image.min.js)
  // 优势:节点独立渲染,不受父容器 overflow / fixed / sticky 影响,一次出图不用分段
  // 参数: selector 或 node,可选 opts 传给 html-to-image
  // 返回: { dataUrl, width, height } 或 { error }
  async function captureNode(target, opts = {}) {
    let node;
    let isTempShot = false;
    if (typeof target === 'string') {
      const list = [...document.querySelectorAll(target)].filter((e) => e.offsetParent !== null);
      node = list[list.length - 1];
      isTempShot = target.startsWith('#geo-shot-');
    } else {
      node = target;
      isTempShot = !!(node && node.id && String(node.id).startsWith('geo-shot-'));
    }
    if (!node) return { error: 'node_not_found' };
    if (!globalThis.htmlToImage) return { error: 'html_to_image_not_loaded' };

    // 让节点在视口内以避免 lazy image 尚未加载
    try { node.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
    // 等图片、字体加载完成
    await sleep(300);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch {}

    const rect = node.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // 限制 dpr 避免超大文件
    try {
      const dataUrl = await globalThis.htmlToImage.toPng(node, {
        pixelRatio: dpr,
        cacheBust: true,
        // 白底(避免透明背景在 dark 模式下看不清)
        backgroundColor: opts.backgroundColor || '#ffffff',
        // 跳过失败的资源,不整张丢
        skipFonts: false,
        // 缓解某些平台 <img> 跨域的 tainted
        imagePlaceholder:
          'data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        ...opts,
      });
      if (isTempShot) { try { node.remove(); } catch {} }
      return {
        dataUrl,
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
      };
    } catch (e) {
      // 失败时保留临时 wrapper,让 CDP / captureVisibleTab fallback 还能命中
      return { error: String(e && e.message || e) };
    }
  }

  globalThis.GEO = { sleep, rand, isGenerating, waitAnswerComplete, humanType, extractCitations, findQANodeByAnchor, captureNode, log, makeTrace };
})();
