// 千问网页版：输入、发送及回答区域已在 chat.qwen.ai 的访客会话验证。
(function () {
  const G = globalThis.GEO;
  const INPUT = 'textarea.message-input-textarea';
  const ANSWER = '.response-message-content.phase-answer';
  const QUESTION = '.chat-user-message';
  const SEND = 'button.send-button';

  const last = (selector) => {
    const list = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
    return list[list.length - 1] || null;
  };
  const configured = (config, field, useLast = false) => G.getConfiguredElement(config[`${field}Selector`], {
    last: useLast, matcher: config[`${field}Matcher`],
  });
  const answerRoot = (config) => configured(config, 'answer', true) || last(ANSWER);
  const questionRoot = (config) => configured(config, 'question', true) || last(QUESTION);
  const generating = () => !!document.querySelector('button.stop-button:not(.disabled):not([disabled])');
  const loginRequired = () => /\/auth(?:\/|\?|$)/.test(location.href);

  async function findInput(config) {
    for (let i = 0; i < 30; i++) {
      if (loginRequired()) return null;
      const input = configured(config, 'input') || last(INPUT);
      if (input) return input;
      await G.sleep(500);
    }
    return null;
  }

  function typeQuery(input, query) {
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
    if (ensureComplete || generating()) {
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
        if (text && !generating() && text === previous) stable++;
        else stable = 0;
        if (stable >= 2) break;
        previous = text;
      }
      timedOut = Date.now() - started >= maxWait;
    }
    tr.push('answer check', {
      configured: !!config.answerSelector, selector: config.answerSelector || ANSWER,
      matches: document.querySelectorAll(config.answerSelector || ANSWER).length,
      chars: text.length, timedOut,
    });
    if (!root || !text) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };

    const question = questionRoot(config);
    const qa = root.closest('.chat-container') || root.parentElement || root;
    const captureId = `geo-qwen-qa-${Date.now()}`;
    qa.id = captureId;
    return {
      status: 'ok', text, answerChars: text.length, answerHtml: root.innerHTML,
      domHtml: root.outerHTML, qaHtml: qa.outerHTML.slice(0, 200000), qaSelector: `#${captureId}`,
      citations: G.extractCitations({ root: qa }),
      keyword: (question?.innerText || '').trim().slice(0, 200) || document.title || '当前页面',
      url: location.href, timedOut, trace: tr.steps,
    };
  }

  globalThis.runQwenTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runQwenTask start', { url: location.href });
    try {
      if (loginRequired()) return { status: 'login_required', trace: tr.steps };
      const input = await findInput(config);
      if (loginRequired()) return { status: 'login_required', trace: tr.steps };
      if (!input || !typeQuery(input, query)) {
        tr.push('input not editable', G.inspectConfiguredElement(config.inputSelector || INPUT, config.inputMatcher));
        return { status: 'failed', error: 'input_not_editable', trace: tr.steps };
      }
      tr.push('typed', { selector: config.inputSelector || INPUT, chars: query.length });
      let button = null;
      for (let i = 0; i < 10; i++) {
        button = configured(config, 'send') || last(SEND);
        if (button && !button.disabled) break;
        await G.sleep(200);
      }
      if (!button || button.disabled) {
        tr.push('send button not found', G.inspectConfiguredElement(config.sendSelector || SEND, config.sendMatcher));
        return { status: 'failed', error: 'send_button_not_found', trace: tr.steps };
      }
      const sent = await chrome.runtime.sendMessage({ type: 'TRUSTED_CLICK', selector: config.sendSelector || SEND });
      if (!sent?.ok) {
        tr.push('trusted click failed', sent?.error || 'unknown');
        return { status: 'failed', error: 'send_click_failed', trace: tr.steps };
      }
      tr.push('sent via CDP', { selector: config.sendSelector || SEND });
      if (loginRequired()) return { status: 'login_required', trace: tr.steps };
      const out = await collect(config, tr, true);
      out.keyword = query;
      return out;
    } catch (error) {
      tr.push('exception', String(error?.message || error));
      return { status: 'failed', error: String(error?.message || error), trace: tr.steps };
    }
  };

  globalThis.collectQwenPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectQwenPage start', { url: location.href });
    try {
      if (loginRequired()) return { status: 'login_required', trace: tr.steps };
      return await collect(config, tr);
    } catch (error) {
      tr.push('exception', String(error?.message || error));
      return { status: 'failed', error: String(error?.message || error), trace: tr.steps };
    }
  };
})();
