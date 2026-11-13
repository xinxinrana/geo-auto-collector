import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserFixture, until } from './harness.js';

test('real bridge + background + runner: run, collect, citations, same-page inspection and screenshots', async t => {
  const f = await browserFixture(t);
  const run = await f.command({ action: 'run', platform: 'perplexity', keyword: 'GEO 是什么', timeoutMs: 10000 }, 'one-question');
  const finished = await f.done(run.id);
  assert.equal(finished.status, 'done', JSON.stringify(finished)); assert.equal(f.submissions, 1);
  const result = (await f.request(`/tasks/${run.id}/result?view=full`)).body;
  assert.equal(result.keyword, 'GEO 是什么'); assert.match(result.text, /当前回答/); assert.equal(result.citations[0].url, 'https://example.org/source');
  assert.equal(result.citationStatus.complete, false);
  assert.equal((await f.command({ action: 'run', platform: 'perplexity', keyword: 'GEO 是什么', timeoutMs: 10000 }, 'one-question')).id, run.id);
  const collect = await f.command({ action: 'collect', platform: 'perplexity', tabId: finished.tabId, timeoutMs: 10000 });
  assert.equal((await f.done(collect.id)).status, 'done'); assert.equal(f.submissions, 1);
  const inspect = await f.command({ action: 'inspect', platform: 'perplexity', field: 'answer', tabId: finished.tabId });
  assert.equal((await f.done(inspect.id)).status, 'done');
  const shot = await f.command({ action: 'shot', platform: 'perplexity', tabId: finished.tabId });
  assert.equal((await f.done(shot.id)).status, 'done');
  assert.equal((await f.request(`/tasks/${shot.id}/result`)).body.screenshot.status, 'saved');
});
test('ambiguous answers suspend and persist diagnostics without picking the last node', async t => {
  const f = await browserFixture(t); f.fixtures.ambiguous = true;
  const task = await f.command({ action: 'run', platform: 'perplexity', keyword: 'ambiguous', timeoutMs: 5000 });
  const finished = await f.done(task.id);
  assert.equal(finished.status, 'suspended'); assert.equal(finished.error.code, 'ambiguous');
  const evidence = (await f.request(`/diagnostic/${task.id}?view=full`)).body;
  assert.match(evidence.dom.html, /另一个候选/); assert.equal(f.submissions, 1);
});
test('stable text without a completion signal times out and is explicitly partial', async t => {
  const f = await browserFixture(t); f.fixtures.omitCompletion = true;
  const task = await f.command({ action: 'run', platform: 'perplexity', keyword: 'no completion', timeoutMs: 5000 });
  const finished = await f.done(task.id);
  assert.equal(finished.status, 'failed'); assert.equal(finished.error.code, 'timeout');
  assert.equal((await f.request(`/tasks/${task.id}/result`)).body.complete, false);
});
test('a final answer appearing after twenty seconds is collected within the requested timeout', async t => {
  const f = await browserFixture(t); f.fixtures.delayAnswer = 21000;
  const task = await f.command({ action: 'run', platform: 'perplexity', keyword: '等待较长的真实生成阶段', timeoutMs: 35000 });
  const finished = await f.done(task.id, 32000);
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  assert.equal(f.submissions, 1);
  const result = (await f.request(`/tasks/${task.id}/result?view=full`)).body;
  assert.equal(result.complete, true);
  assert.equal(result.keyword, '等待较长的真实生成阶段');
});
test('stop confirms the original runner ended, and never claims website generation stopped', async t => {
  const f = await browserFixture(t); f.fixtures.omitCompletion = true;
  const run = await f.command({ action: 'run', platform: 'perplexity', keyword: 'stop me', timeoutMs: 20000 });
  await until(() => f.submissions === 1);
  const stop = await f.command({ action: 'stop', taskId: run.id });
  assert.equal((await f.done(run.id)).status, 'interrupted');
  assert.equal((await f.done(stop.id)).status, 'done');
  assert.equal((await f.request(`/tasks/${stop.id}/result?view=data`)).body.data.websiteGenerationStopped, false);
  assert.equal(f.submissions, 1);
});
test('worker restart reconnects to the same page runner without resubmission', async t => {
  const f = await browserFixture(t); f.fixtures.delayCompletion = 1500;
  const task = await f.command({ action: 'run', platform: 'perplexity', keyword: 'recover me', timeoutMs: 10000 });
  await until(async () => (await f.request(`/tasks/${task.id}`)).body.step === 'waiting');
  await f.restartWorker();
  assert.equal((await f.done(task.id)).status, 'done'); assert.equal(f.submissions, 1);
});
test('closing the execution tab interrupts and does not create a replacement', async t => {
  const f = await browserFixture(t); f.fixtures.omitCompletion = true;
  const task = await f.command({ action: 'run', platform: 'perplexity', keyword: 'close me', timeoutMs: 20000 });
  await until(() => f.submissions === 1);
  f.closeTab((await f.request(`/tasks/${task.id}`)).body.tabId);
  assert.equal((await f.done(task.id)).status, 'interrupted'); assert.equal(f.tabs.size, 0); assert.equal(f.submissions, 1);
});
test('SPA loading preserves its runner and an interactive page does not wait for all resources', async t => {
  const f = await browserFixture(t); f.fixtures.delayCompletion = 1000;
  const task = await f.command({ action: 'run', platform: 'perplexity', keyword: 'SPA question', timeoutMs: 10000 });
  await until(() => f.submissions === 1);
  const tab = [...f.tabs.values()][0];
  tab.status = 'loading';
  f.tabUpdated(tab.id, { status: 'loading' });
  assert.equal((await f.done(task.id)).status, 'done');
  const collect = await f.command({ action: 'collect', platform: 'perplexity', tabId: tab.id, timeoutMs: 10000 });
  assert.equal((await f.done(collect.id)).status, 'done');
  assert.equal(f.submissions, 1);
});
test('selector repair validates before saving and rejects stale configuration revisions', async t => {
  const f = await browserFixture(t); const tab = f.makeTab();
  const testOnly = await f.command({ action: 'fix', platform: 'perplexity', tabId: tab.id, field: 'input', selector: 'textarea', testOnly: true });
  assert.equal((await f.done(testOnly.id)).status, 'done');
  const revision = (await f.request(`/tasks/${testOnly.id}/result?view=data`)).body.data.revision;
  const save = await f.command({ action: 'fix', platform: 'perplexity', tabId: tab.id, field: 'input', selector: 'textarea', testOnly: false, expectedRevision: revision });
  assert.equal((await f.done(save.id)).status, 'done');
  const stale = await f.command({ action: 'fix', platform: 'perplexity', tabId: tab.id, field: 'input', selector: 'textarea', testOnly: false, expectedRevision: revision });
  const rejected = await f.done(stale.id); assert.equal(rejected.status, 'failed'); assert.equal(rejected.error.code, 'config_conflict');
});

test('question role cannot be repaired to an answer node', async t => {
  const f = await browserFixture(t);
  const tab = f.makeTab('<main><div class="focus:outline-none"><div class="flex flex-col gap-y-md"><h2>问题</h2><section><div class="prose">回答</div></section></div></div></main>');
  const fix = await f.command({ action: 'fix', platform: 'perplexity', tabId: tab.id, field: 'question', selector: '.prose', testOnly: true });
  const finished = await f.done(fix.id);
  assert.equal(finished.status, 'suspended'); assert.equal(finished.error.code, 'wrong_role');
});

test('side panel routes a real command and renders collected HTML as text, not markup', async t => {
  const f = await browserFixture(t), panel = await f.openPanel();
  const w = panel.window, doc = w.document;
  assert.equal(doc.getElementById('version').textContent, `v${JSON.parse(readFileSync('manifest.json')).version}`);
  assert.equal(doc.getElementById('run').disabled, false);
  doc.getElementById('keyword').value = '<img src=x onerror=alert(1)> 这个问题';
  doc.getElementById('run-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => f.submissions === 1);
  await until(() => doc.getElementById('result-text').textContent.includes('当前回答'));
  assert.equal(doc.querySelectorAll('#result-section img, #tasks img').length, 0);
  assert.equal(doc.querySelector('#citations a')?.href, 'https://example.org/source');
  assert(!doc.getElementById('handoff').textContent.includes('Bearer'));
  assert(doc.getElementById('handoff').textContent.includes('/help'));
});

test('website content scripts cannot call the trusted extension UI API', async t => {
  const f = await browserFixture(t), tab = f.makeTab();
  const response = await tab.dom.window.chrome.runtime.sendMessage({ type: 'ui-command', command: { action: 'run', platform: 'perplexity', keyword: 'unauthorized' } });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'forbidden');
  assert.equal((await f.request('/tasks')).body.tasks.length, 0);
});
