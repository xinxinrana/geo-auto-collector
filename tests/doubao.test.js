import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Minimal doubao-like page: virtual list rows, React-style textarea, send button
// whose svg class carries send-msg-btn. Verifies selectors against documented anchors.
const page = `<!doctype html><html><body><main>
<div class="list_items">
  <div class="v_list_row"><div data-testid="send_message"><div class="md-box-root">弹性蛋白怎么选</div></div></div>
  <div class="v_list_row"><div data-testid="receive_message"><div class="md-box-root">推荐一：品牌 A。推荐二：品牌 B。</div></div></div>
</div>
<textarea class="semi-input-textarea"></textarea>
<button data-testid="chat_input_send_button"><svg class="text-g-send-msg-btn-text"></svg></button>
</main></body></html>`;

const dom = new JSDOM(page, { url: 'https://www.doubao.com/chat/123', runScripts: 'outside-only', pretendToBeVisual: true });
// jsdom has no layout; every node reports a zero rect and fails visibility checks.
dom.window.Element.prototype.getClientRects = function () { return [{ width: 100, height: 20 }]; };
dom.window.Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; };
dom.window.eval(readFileSync(new URL('../extension/doubao.js', import.meta.url), 'utf8'));
const A = dom.window.GEOAdapter;

test('doubao adapter ids itself as doubao', () => {
  assert.equal(A.platformId, 'doubao');
});

test('doubao adapter locates input, send, question and answer', () => {
  assert.equal(A.inspect('input', {}).tag, 'textarea');
  assert.equal(A.inspect('send', {}).tag, 'button');
  assert.equal(A.inspect('question', {}).textPreview, '弹性蛋白怎么选');
  assert.match(A.inspect('answer', {}).textPreview, /推荐一/);
});

test('doubao adapter extracts the last round with citations scoped to the answer', () => {
  const round = A.current({}, null, []);
  const result = A.extract(round, null);
  assert.equal(result.platform, 'doubao');
  assert.equal(result.keyword, '弹性蛋白怎么选');
  assert.match(result.text, /推荐二/);
  assert.equal(result.citations.length, 0);
});

test('doubao treats from_login query param as logged in', () => {
  assert.equal(A.loginRequired('https://www.doubao.com/chat/?from_login=1&origin_landing=x'), false);
  assert.equal(A.loginRequired('https://www.doubao.com/login'), true);
  assert.equal(A.isPlatformUrl('https://www.doubao.com/chat/1'), true);
  assert.equal(A.isPlatformUrl('https://www.perplexity.ai/'), false);
});

// 真实页面：虚拟列表可能只挂载一轮；问题行夹着时间戳与操作栏；
// 回答区带"共用时"计时器，正式正文是一段独立 md-box-root。
const livePage = `<!doctype html><html><body><main>
<div class="list_items">
  <div class="v_list_row"><div>
    <div class="inner-item" data-testid="union_message"><div data-testid="message-block-container">
      <div data-testid="send_message"><div data-testid="message_content" data-message-id="a">
        <div class="container md-box-root" data-testid="message_text_content">弹性蛋白怎么选</div>
        <div data-testid="message_action_bar"><button data-testid="message_action_copy"></button></div>
      </div><span>今天 18:22</span></div>
    </div></div>
  </div></div>
  <div class="v_list_row"><div>
    <div class="inner-item" data-testid="union_message"><div data-testid="message-block-container">
      <div data-testid="receive_message"><div data-testid="message_content" data-message-id="b">
        <section data-testid="preamble-elapsed"><span>共用时 2 分 19 秒</span></section>
        <div class="container md-box-root" data-testid="message_text_content" data-streaming="false">先说结论：选鲣鱼弹性蛋白肽。</div>
        <div class="container md-box-root" data-testid="message_text_content" data-streaming="false">品牌：DHC、ACTLAND、デマレ。</div>
        <div data-testid="message_action_bar"><button data-testid="message_action_copy"></button></div>
      </div></div>
    </div></div>
  </div></div>
</div>
<textarea class="semi-input-textarea"></textarea>
<button data-testid="chat_input_send_button"></button>
</main></body></html>`;

function liveDom() {
  const d = new JSDOM(livePage, { url: 'https://www.doubao.com/chat/38453309448875522', runScripts: 'outside-only', pretendToBeVisual: true });
  d.window.Element.prototype.getClientRects = function () { return [{ width: 100, height: 20 }]; };
  d.window.Element.prototype.getBoundingClientRect = function () {
    const all = [...d.window.document.querySelectorAll('*')];
    const i = all.indexOf(this);
    return { x: 0, y: i * 30, top: i * 30, left: 0, right: 100, bottom: i * 30 + 20, width: 100, height: 20 };
  };
  d.window.eval(readFileSync(new URL('../extension/doubao.js', import.meta.url), 'utf8'));
  return d;
}

test('doubao parses the live page shape where only one round is mounted', () => {
  const d = liveDom();
  const A2 = d.window.GEOAdapter;
  const round = A2.current({}, null, []);
  // 问题文本不含时间戳；正文拼接全部段落，不含"共用时"计时器。
  assert.equal(A2.questionText(round.question), '弹性蛋白怎么选');
  assert.match(A2.bodyText(round), /鲣鱼弹性蛋白肽/);
  assert.doesNotMatch(A2.bodyText(round), /共用时/);
  assert.equal(A2.generating(), false);
  const result = A2.extract(round, null);
  assert.match(result.text, /DHC/);
  assert.match(result.text, /鲣鱼弹性蛋白肽/);
  assert.doesNotMatch(result.text, /共用时/);
});

test('doubao generating() is false on a settled page with no stop control', () => {
  const d = liveDom();
  assert.equal(d.window.GEOAdapter.generating(), false);
});

// 长回答会把问题行顶出视口，虚拟列表随即卸载它。采集必须仍然成立。
test('doubao collects the answer even after the question row is unmounted', () => {
  const d = liveDom();
  const A2 = d.window.GEOAdapter;
  d.window.document.querySelector('[data-testid="send_message"]').closest('.v_list_row').remove();
  assert.equal(d.window.document.querySelectorAll('[data-testid="send_message"]').length, 0);
  const round = A2.current({}, null, []);
  assert.match(A2.bodyText(round), /鲣鱼弹性蛋白肽/);
  const result = A2.extract(round, '弹性蛋白怎么选');
  assert.equal(result.keyword, '弹性蛋白怎么选');
  assert.match(result.text, /DHC/);
});

// run 模式下用提交的关键词匹配轮次；问题行已卸载时应退回到唯一挂载的那一轮。
test('doubao matches a run to the only mounted round when the question row is gone', () => {
  const d = liveDom();
  const A2 = d.window.GEOAdapter;
  d.window.document.querySelector('[data-testid="send_message"]').closest('.v_list_row').remove();
  const round = A2.current({}, '弹性蛋白怎么选', []);
  assert.match(A2.bodyText(round), /鲣鱼弹性蛋白肽/);
});

// 开场白陷阱：豆包先输出"我先查一下…"，此时没有操作栏，不能算完成。
test('doubao does not treat the search preamble as completion', () => {
  const d = liveDom();
  const A2 = d.window.GEOAdapter;
  // 去掉回答侧的操作栏（用户消息那一侧的仍保留），模拟检索进行中的状态。
  const bars = [...d.window.document.querySelectorAll('[data-testid="receive_message"] [data-testid="message_action_bar"]')];
  assert.equal(bars.length, 1);
  bars[0].remove();
  const round = A2.current({}, null, []);
  assert.equal(A2.hasActionBar(round), false);
  assert.equal(A2.completed(round), false);
});

test('doubao treats an answer with the action bar as complete', () => {
  const d = liveDom();
  const A2 = d.window.GEOAdapter;
  const round = A2.current({}, null, []);
  assert.equal(A2.hasActionBar(round), true);
  assert.equal(A2.completed(round), true);
});
