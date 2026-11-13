import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './harness.js';

const doubaoPage = `<!doctype html><html><body><main>
<div class="list_items" id="list"></div>
<textarea class="semi-input-textarea"></textarea>
<button id="send"><svg class="text-g-send-msg-btn-text"></svg></button>
</main></body></html>`;

// Mirrors the real page: rows carry no data-observe-row; the user row is marked
// by data-testid="send_message", which is what the live DOM actually exposes.
// 回答结束后豆包会挂出操作栏，这是"已生成完毕"的正面证据。
function doubaoRender(w, keyword) {
  const list = w.document.getElementById('list');
  const user = w.document.createElement('div');
  user.className = 'v_list_row';
  user.innerHTML = '<div data-testid="send_message"><div data-testid="message_content" data-message-id="1"><div class="md-box-root"></div></div></div>';
  user.querySelector('.md-box-root').textContent = keyword;
  const answer = w.document.createElement('div');
  answer.className = 'v_list_row';
  answer.innerHTML = '<div data-testid="receive_message"><div data-testid="message_content" data-message-id="2"><div class="md-box-root">弹性蛋白推荐：品牌 A、品牌 B。这两款都是鲣鱼来源的弹性蛋白肽，每日剂量在 75–100mg 区间，适合长期日常补充。</div><div data-testid="message_action_bar"><button data-testid="message_action_copy"></button><button data-testid="message_action_like"></button></div></div></div>';
  list.append(user, answer);
  const stop = w.document.createElement('div');
  stop.className = 'size-34 rounded-full';
  stop.innerHTML = '<svg><path d="M12 0.5C18.3513 0.5 23.5 5.64873 23.5 12"></path></svg>';
  w.document.body.append(stop);
  w.setTimeout(() => stop.remove(), 80);
}

test('doubao: run submits, waits for completion and collects text', async t => {
  const f = await browserFixture(t);
  f.fixtures.newTab = { url: 'https://www.doubao.com/chat/', content: doubaoPage, inputSelector: 'textarea', sendSelector: '#send', onSend: doubaoRender, title: 'Fixture 豆包' };
  const task = await f.command({ action: 'run', platform: 'doubao', keyword: '弹性蛋白怎么选', timeoutMs: 15000 });
  const done = await f.done(task.id, 20000);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  const result = (await f.request(`/tasks/${task.id}/result?view=full`)).body;
  assert.equal(result.platform, 'doubao');
  assert.equal(result.keyword, '弹性蛋白怎么选');
  assert.match(result.text, /品牌 A/);
  assert.equal(f.submissions, 1);
});

test('doubao: collect reads the existing conversation without submitting', async t => {
  const f = await browserFixture(t);
  const tab = f.makeTab(doubaoPage, { url: 'https://www.doubao.com/chat/123', inputSelector: 'textarea', sendSelector: '#send', onSend: doubaoRender, title: 'Fixture 豆包' });
  doubaoRender(tab.dom.window, '弹性蛋白怎么选');
  const task = await f.command({ action: 'collect', platform: 'doubao', tabId: tab.id, timeoutMs: 15000 });
  const done = await f.done(task.id, 20000);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  const result = (await f.request(`/tasks/${task.id}/result?view=full`)).body;
  assert.equal(result.platform, 'doubao');
  assert.match(result.text, /品牌 B/);
  assert.equal(f.submissions, 0);
});

test('doubao: a tab from another platform is rejected', async t => {
  const f = await browserFixture(t);
  const perplexity = f.makeTab();
  const task = await f.command({ action: 'collect', platform: 'doubao', tabId: perplexity.id, timeoutMs: 10000 });
  const done = await f.done(task.id, 15000);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'wrong_platform');
});

test('doubao: repeated runs keep the tab count at three or fewer and all collect', async t => {
  const f = await browserFixture(t);
  f.fixtures.newTab = { url: 'https://www.doubao.com/chat/', content: doubaoPage, inputSelector: 'textarea', sendSelector: '#send', onSend: doubaoRender, title: 'Fixture 豆包' };
  for (let i = 1; i <= 5; i++) {
    const task = await f.command({ action: 'run', platform: 'doubao', keyword: `弹性蛋白第${i}次`, timeoutMs: 15000 });
    const done = await f.done(task.id, 20000);
    assert.equal(done.status, 'done', JSON.stringify(done.error));
    assert.ok([...f.tabs.keys()].length <= 3, `第 ${i} 次后标签页为 ${[...f.tabs.keys()].join(',')}`);
  }
});
