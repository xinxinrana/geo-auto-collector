// DeepSeek 网页版：稳定语义类优先，避开每次构建变化的哈希类名。
(function () {
  const G = globalThis.GEO;
  const INPUT = 'textarea[name="search"]';
  const QUESTION = '.ds-collapsible-text';
  const ANSWER = '.ds-assistant-message-main-content';
  const SEND = '.ds-button--primary.ds-button--circle:not(.ds-button--disabled)';

  const last = (selector) => {
    const items = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
    return items[items.length - 1] || null;
  };
  const configured = (config, field, useLast = false) => G.getConfiguredElement(config[`${field}Selector`], {
    last: useLast, matcher: config[`${field}Matcher`],
  });
  const answerRoot = (config) => configured(config, 'answer', true) || last(ANSWER);
  const questionRoot = (config) => configured(config, 'question', true) || last(QUESTION);
  const loginRequired = () => /\/sign_in(?:\/|\?|$)/.test(location.href);

  async function findInput(config) {
    for (let i = 0; i < 30; i++) {
      if (loginRequired()) return null;
      const input = configured(config, 'input') || last(INPUT);
      if (input) return input;
      await G.sleep(500);
    }
    return null;
  }

  async function typeQuery(input, query) {
    input.focus();
    if (input.isContentEditable) { await G.humanType(input, query); return true; }
    if (!/^(INPUT|TEXTAREA)$/.test(input.tagName)) return false;
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, query);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: query, inputType: 'insertText' }));
    return true;
  }

  async function collect(config, tr, ensureComplete = false) {
    let root = answerRoot(config);
    let text = (root?.innerText || '').trim();
    let timedOut = false;
    if (ensureComplete) {
      const started = Date.now();
      const maxWait = config.maxWait || 180000;
      let previous = '';
      let stable = 0;
      while (Date.now() - started < maxWait) {
        await G.sleep(1500);
        if (loginRequired()) {
          tr.push('login_required', { url: location.href });
          return { status: 'login_required', trace: tr.steps };
        }
        root = answerRoot(config);
        text = (root?.innerText || '').trim();
        if (text && text === previous) stable++;
        else stable = 0;
        if (stable >= 2) break;
        previous = text;
      }
      timedOut = Date.now() - started >= maxWait;
    }
    tr.push('answer check', {
      selector: config.answerSelector || ANSWER,
      found: !!root, chars: text.length, timedOut,
    });
    if (!root || !text) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };

    const question = questionRoot(config);
    const answerItem = root.closest('[data-virtual-list-item-key]') || root;
    const captureId = `geo-deepseek-answer-${Date.now()}`;
    answerItem.id = captureId;
    return {
      status: 'ok', text, answerChars: text.length, answerHtml: root.innerHTML,
      domHtml: root.outerHTML,
      qaHtml: `<div>${question?.outerHTML || ''}${answerItem.outerHTML}</div>`.slice(0, 200000),
      qaSelector: `#${captureId}`, citations: G.extractCitations({ root: answerItem }),
      keyword: (question?.innerText || '').trim().slice(0, 200) || document.title || '当前页面',
      url: location.href, timedOut, trace: tr.steps,
    };
  }

  globalThis.runDeepSeekTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runDeepSeekTask start', { url: location.href });
    try {
      if (loginRequired()) return { status: 'login_required', trace: tr.steps };
      const input = await findInput(config);
      if (loginRequired()) return { status: 'login_required', trace: tr.steps };
      if (!input || !await typeQuery(input, query)) {
        tr.push('input not editable', G.inspectConfiguredElement(config.inputSelector || INPUT, config.inputMatcher));
        return { status: 'failed', error: 'input_not_editable', trace: tr.steps };
      }
      tr.push('typed', { selector: config.inputSelector || INPUT, chars: query.length });
      let button = null;
      for (let i = 0; i < 10; i++) {
        button = configured(config, 'send') || last(SEND);
        if (button) break;
        await G.sleep(200);
      }
      if (!button) {
        tr.push('send button not found', G.inspectConfiguredElement(config.sendSelector || SEND, config.sendMatcher));
        return { status: 'failed', error: 'send_button_not_found', trace: tr.steps };
      }
      button.click();
      tr.push('sent', { selector: config.sendSelector || SEND });
      const out = await collect(config, tr, true);
      out.keyword = query;
      return out;
    } catch (error) {
      tr.push('exception', String(error?.message || error));
      return { status: 'failed', error: String(error?.message || error), trace: tr.steps };
    }
  };

  globalThis.collectDeepSeekPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectDeepSeekPage start', { url: location.href });
    try {
      if (loginRequired()) return { status: 'login_required', trace: tr.steps };
      return await collect(config, tr);
    } catch (error) {
      tr.push('exception', String(error?.message || error));
      return { status: 'failed', error: String(error?.message || error), trace: tr.steps };
    }
  };
})();
