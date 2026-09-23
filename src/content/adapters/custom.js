// 用户添加平台的通用页面交互；行为由平台控制台保存的元素配置决定。
(function () {
  const G = globalThis.GEO;

  function element(config, field, last = false) {
    return G.getConfiguredElement(config[`${field}Selector`], { last, matcher: config[`${field}Matcher`] });
  }

  async function waitFor(field, config, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = element(config, field, field !== 'input' && field !== 'send');
      if (found) return found;
      await G.sleep(500);
    }
    return null;
  }

  async function collect(config, tr, ensureComplete = false) {
    const answer = await waitFor('answer', config, ensureComplete ? 60000 : 2000);
    if (!answer) {
      tr.push('answer_not_found', G.inspectConfiguredElement(config.answerSelector, config.answerMatcher));
      return { status: 'failed', error: 'answer_not_found', trace: tr.steps };
    }
    let text = (answer.innerText || '').trim();
    let timedOut = false;
    if (ensureComplete || G.isGenerating()) {
      const settled = await G.waitAnswerComplete({ root: answer, minChars: 1, maxWait: config.maxWait || 180000, requireMinCharsForStable: false });
      text = settled.text;
      timedOut = settled.timedOut;
    }
    if (!text) {
      tr.push('answer_empty', G.inspectConfiguredElement(config.answerSelector, config.answerMatcher));
      return { status: 'failed', error: 'answer_empty', trace: tr.steps };
    }
    const question = element(config, 'question', true);
    tr.push('collected', { chars: text.length, timedOut });
    return {
      status: 'ok', text, answerHtml: answer.innerHTML, answerChars: text.length,
      citations: G.extractCitations({ root: answer.parentElement || answer }),
      qaHtml: (answer.parentElement || answer).outerHTML.slice(0, 200000),
      qaSelector: config.answerSelector, domHtml: answer.outerHTML,
      keyword: (question?.innerText || '').trim().slice(0, 200) || document.title || '当前页面',
      url: location.href, timedOut, trace: tr.steps,
    };
  }

  globalThis.runCustomTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('custom task start', { url: location.href });
    try {
      if (!config.inputSelector || !config.answerSelector) return { status: 'failed', error: 'input_or_answer_not_configured', trace: tr.steps };
      const input = await waitFor('input', config);
      if (!input || !(input.isContentEditable || /^(INPUT|TEXTAREA)$/.test(input.tagName))) {
        tr.push('input_not_editable', G.inspectConfiguredElement(config.inputSelector, config.inputMatcher));
        return { status: 'failed', error: 'input_not_editable', trace: tr.steps };
      }
      const previousAnswer = (element(config, 'answer', true)?.innerText || '').trim();
      await G.humanType(input, query);
      tr.push('typed');
      const send = element(config, 'send');
      if (config.sendSelector && !send) return { status: 'failed', error: 'send_button_not_found', trace: tr.steps };
      if (send) { send.click(); tr.push('sent via button'); }
      else if (input.closest('form')?.requestSubmit) { input.closest('form').requestSubmit(); tr.push('sent via form'); }
      else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        tr.push('sent via Enter');
      }
      const start = Date.now();
      while (Date.now() - start < 60000) {
        await G.sleep(1000);
        const current = (element(config, 'answer', true)?.innerText || '').trim();
        if (current && current !== previousAnswer) break;
      }
      if (Date.now() - start >= 60000) return { status: 'failed', error: 'answer_did_not_change', trace: tr.steps };
      const result = await collect(config, tr, true);
      if (result.status === 'ok') result.keyword = query;
      return result;
    } catch (error) {
      tr.push('exception', String(error?.message || error));
      return { status: 'failed', error: String(error?.message || error), trace: tr.steps };
    }
  };

  globalThis.collectCustomPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('custom page collect', { url: location.href });
    try {
      if (!config.answerSelector) return { status: 'failed', error: 'answer_not_configured', trace: tr.steps };
      return await collect(config, tr);
    } catch (error) {
      tr.push('exception', String(error?.message || error));
      return { status: 'failed', error: String(error?.message || error), trace: tr.steps };
    }
  };
})();
