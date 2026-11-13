import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('contenteditable fill waits for the editor commit and rejects an uncommitted value', async t => {
  const dom = new JSDOM('<div contenteditable="true"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, node = w.document.querySelector('div');
  w.eval(readFileSync(new URL('../extension/perplexity.js', import.meta.url), 'utf8'));
  let inserts = 0;
  w.document.execCommand = (_command, _ui, value) => {
    inserts++;
    setTimeout(() => { node.textContent = value; }, 150);
    return true;
  };
  await w.GEOAdapter.fill(node, '适合中国用户的 AI Agent');
  assert.equal(node.textContent, '适合中国用户的 AI Agent');
  assert.equal(inserts, 1);
  w.document.execCommand = () => true;
  await assert.rejects(w.GEOAdapter.fill(node, '另一条问题'), error => error.code === 'input_mismatch');
});

test('session partitions match each question to its final answer and ignore Copy query as completion', t => {
  const round = (question, answer) => `<section><div class="group/partition"><div class="group/user-bubble"><div><button aria-label="Copy query"></button></div><div class="whitespace-pre-wrap"><p>${question}</p></div></div></div><div class="group/partition"><div class="prose">思考过程</div></div><div class="group/partition group/final-text"><div class="prose">${answer}<a href="https://example.org/source">来源</a></div></div></section>`;
  const dom = new JSDOM(`<main>${round('第一问', '第一答')}${round('第二问', '第二答')}</main>`, { runScripts: 'outside-only', url: 'https://www.perplexity.ai/session/example' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{}] : []; };
  w.eval(readFileSync(new URL('../extension/perplexity.js', import.meta.url), 'utf8'));
  const a = w.GEOAdapter, current = a.current({});
  assert.equal(a.text(current.question), '第二问');
  assert.equal(a.text(current.answer), '第二答来源');
  assert.equal(a.text(a.current({}, '第一问').answer), '第一答来源');
  assert.equal(a.completed(current), false);
  const copy = w.document.createElement('button'); copy.setAttribute('aria-label', 'Copy'); current.container.append(copy);
  assert.equal(a.completed(current), true);
  const result = a.extract(current);
  assert.equal(result.keyword, '第二问');
  assert.equal(result.citations[0].url, 'https://example.org/source');
  assert.equal(result.text.includes('思考过程'), false);
});
