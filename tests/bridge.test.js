import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createBridge } from '../bridge/server.js';
import { PROTOCOL } from '../shared/protocol.js';
const version = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url))).version;
export async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'geo-test-'));
  let bridge = createBridge({ home, port: 0 }); await bridge.listen();
  const request = async (path, options = {}) => {
    const res = await fetch(`http://127.0.0.1:${bridge.server.address().port}${path}`, options);
    return { status: res.status, body: res.headers.get('content-type')?.includes('image/png') ? new Uint8Array(await res.arrayBuffer()) : await res.json() };
  };
  const command = (body, key = crypto.randomUUID()) => request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const connect = async (knownTasks = [], origin) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.server.address().port}/extension`, { origin });
    const messages = [];
    ws.on('message', raw => { const m = JSON.parse(raw); messages.push(m); if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'sync', knownTasks })); });
    await new Promise((r, reject) => { ws.on('open', r); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, version }));
    await until(() => messages.some(m => m.type === 'ready'));
    return { ws, messages, event: async event => { ws.send(JSON.stringify({ type: 'event', event })); await until(() => messages.some(m => m.type === 'ack' && m.taskId === event.taskId && m.seq === event.seq)); } };
  };
  t.after(async () => { await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, request, command, connect, get bridge() { return bridge; }, restart: async () => { await bridge.close(); bridge = createBridge({ home, port: 0 }); await bridge.listen(); } };
}
export async function until(fn, ms = 5000) { const deadline = Date.now() + ms; while (!await fn()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise(r => setTimeout(r, 20)); } }

test('HTTP and WebSocket connect directly without credentials or origin binding', async t => {
  const f = await fixture(t);
  for (const path of ['/help', '/status', '/platforms', '/tasks']) assert.equal((await f.request(path)).status, 200);
  assert.equal((await f.request('/status', { headers: { Origin: 'http://localhost:3000' } })).status, 200);
  assert.equal((await f.command({ action: 'anchors' })).status, 503);
  assert.equal(existsSync(join(f.home, 'token')), false);
  const ext = await f.connect();
  const accepted = await f.command({ action: 'anchors' });
  assert.equal(accepted.status, 202);
  await ext.event({ taskId: accepted.body.id, runnerId: 'r1', seq: 1, status: 'done', step: 'completed', result: { data: { revision: 0 } } });
  assert.equal((await f.request(`/tasks/${accepted.body.id}/result?view=data`)).body.data.revision, 0);
});
test('CLI queries the running service without a credential file or local data directory', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['geo', 'status'], { env: { ...process.env, GEO_BRIDGE_PORT: String(f.bridge.server.address().port), GEO_BRIDGE_HOME: join(f.home, 'absent') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, version);
  assert.equal(existsSync(join(f.home, 'absent')), false);
});
test('a different extension instance connects after bridge restart without pairing', async t => {
  const f = await fixture(t);
  await f.connect([], `chrome-extension://${'a'.repeat(32)}`);
  assert.equal((await f.request('/status')).body.extension.ready, true);
  await f.restart();
  await f.connect([], `chrome-extension://${'b'.repeat(32)}`);
  assert.equal((await f.request('/status')).body.extension.ready, true);
  assert.equal(existsSync(join(f.home, 'token')), false);
});
test('persistent idempotency, busy behavior, result paging and lean status/events', async t => {
  const f = await fixture(t), ext = await f.connect();
  const cmd = { action: 'run', platform: 'perplexity', keyword: 'hello' };
  const accepted = await f.command(cmd, 'research-1'), id = accepted.body.id;
  assert.equal(accepted.status, 202);
  assert.equal((await f.command(cmd, 'research-1')).body.id, id);
  assert.equal((await f.command({ ...cmd, keyword: 'different' }, 'research-1')).status, 409);
  assert.equal((await f.command(cmd, 'research-2')).status, 409);
  const text = '正文🙂'.repeat(2000);
  await ext.event({ taskId: id, runnerId: 'r1', seq: 1, status: 'running', step: 'waiting' });
  await ext.event({ taskId: id, runnerId: 'r1', seq: 2, status: 'done', step: 'completed', result: { text, citations: [{ url: 'https://example.org', title: 'Example' }], html: '<p>hello</p>' } });
  const summary = await f.request(`/tasks/${id}/result`);
  assert.equal(summary.body.answerChars, Array.from(text).length); assert(!JSON.stringify(summary.body).includes('正文'));
  assert(Buffer.byteLength(JSON.stringify((await f.request(`/tasks/${id}`)).body)) < 2048);
  let complete = '', offset = 0;
  do { const page = (await f.request(`/tasks/${id}/result?view=text&offset=${offset}&maxChars=997`)).body; complete += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.equal(complete, text);
  assert.equal((await f.request(`/tasks/${id}/result?view=text&maxChars=20001`)).status, 400);
  const events = (await f.request(`/events?taskId=${id}`)).body;
  assert.equal(events.events.length, 2); assert(!JSON.stringify(events).includes('正文'));
  assert.equal((await f.request(`/events?taskId=${id}&since=${events.cursor}`)).body.events.length, 0);
  await f.restart();
  assert.equal((await f.command(cmd, 'research-1')).body.id, id);
  assert.equal((await f.request(`/tasks/${id}/result?view=text`)).body.total, Array.from(text).length);
});
test('event replay is deduplicated and diagnostics preserve the failure snapshot', async t => {
  const f = await fixture(t), ext = await f.connect();
  const id = (await f.command({ action: 'inspect', platform: 'perplexity' })).body.id;
  const event = { taskId: id, runnerId: 'r1', seq: 1, status: 'suspended', step: 'ended', error: { code: 'ambiguous', message: 'two answers' }, diagnostic: { error: 'ambiguous', dom: '<div>failure-time snapshot</div>' } };
  await ext.event(event); await ext.event(event);
  assert.equal((await f.request(`/events?taskId=${id}`)).body.events.length, 1);
  assert(!JSON.stringify((await f.request(`/diagnostic/${id}`)).body).includes('failure-time'));
  assert.match((await f.request(`/diagnostic/${id}?view=full`)).body.dom, /failure-time/);
  assert.equal((await f.request(`/tasks/${id}/result`)).status, 404);
});
test('PNG is a binary artifact and unavailable files return 404', async t => {
  const f = await fixture(t), ext = await f.connect();
  const id = (await f.command({ action: 'shot', platform: 'perplexity' })).body.id;
  assert.equal((await f.request(`/tasks/${id}/artifacts/screenshot`)).status, 404);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZJAAAAAASUVORK5CYII=';
  await ext.event({ taskId: id, runnerId: 'r1', seq: 1, status: 'done', step: 'completed', result: { screenshotBase64: png } });
  assert.deepEqual(Buffer.from((await f.request(`/tasks/${id}/artifacts/screenshot`)).body), Buffer.from(png, 'base64'));
  assert(!JSON.stringify((await f.request(`/tasks/${id}/result?view=full`)).body).includes(png));
});
test('reconnect cannot silently restart a running task without its execution record', async t => {
  const f = await fixture(t), ext = await f.connect();
  const id = (await f.command({ action: 'run', platform: 'perplexity', keyword: 'hello' })).body.id;
  await ext.event({ taskId: id, runnerId: 'r1', seq: 1, status: 'running', step: 'submission_intent', submissionState: 'intent' });
  await f.restart(); const next = await f.connect([]);
  const task = (await f.request(`/tasks/${id}`)).body;
  assert.equal(task.status, 'interrupted'); assert.equal(task.error.code, 'submission_unknown');
  assert(!next.messages.some(m => m.type === 'command' && m.task.id === id));
});
