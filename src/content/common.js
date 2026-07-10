// common.js — 平台无关的采集原语，注入到目标页的隔离世界。
// 迁移自 CDP 方案的 wait_generation / is_generating / 拟人输入 / 引用抓取。
// 挂到 globalThis.GEO 供各平台 adapter 复用。

(function () {
  if (globalThis.GEO) return; // 避免重复注入

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

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

  // 迁移 wait_generation：停止按钮消失 + 文本长度连续稳定 + 最小字符 + 超时兜底
  async function waitAnswerComplete(opts = {}) {
    const {
      root = document.body,
      minChars = 1200,
      maxWait = 180000,
      stableNeeded = 4,
      poll = 3000,
    } = opts;
    let prevLen = 0;
    let stable = 0;
    let waited = 0;
    let sawGenerating = false;

    while (waited < maxWait) {
      await sleep(poll);
      waited += poll;
      const txt = (root.innerText || '').trim();
      const len = txt.length;
      const gen = isGenerating();
      if (gen) sawGenerating = true;
      if (len === prevLen) stable++;
      else stable = 0;
      prevLen = len;

      if (!gen && stable >= stableNeeded && len > minChars) {
        // 若全程没检测到停止按钮，要求更长稳定窗口兜底
        if (sawGenerating || stable >= stableNeeded + 2) {
          return { text: txt, timedOut: false };
        }
      }
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
    document.querySelectorAll('a[href^="http"]').forEach((a) => add(a.getAttribute('href')));
    // 通用来源容器（Gemini chip 等）
    const selectors = ['[class*=citation] a', '[class*=source] a', 'sources-list a', '[data-url]', '[data-href]'];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        ['href', 'data-url', 'data-href'].forEach((attr) => add(el.getAttribute(attr)));
      });
    });
    return [...map.values()];
  }

  globalThis.GEO = { sleep, rand, isGenerating, waitAnswerComplete, humanType, extractCitations };
})();
