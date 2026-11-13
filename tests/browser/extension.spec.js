import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createBridge } from '../../bridge/server.js';

async function environment() {
  const home = mkdtempSync(join(tmpdir(), 'geo-real-browser-'));
  const bridge = createBridge({ home: join(home, 'data'), port: 0 });
  let context, fixtureServer;
  try {
    await bridge.listen();
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(home, 'key.pem'), '-out', join(home, 'cert.pem'), '-days', '1', '-subj', '/CN=www.perplexity.ai'], { stdio: 'ignore' });
    let fixtureRequests = 0;
    fixtureServer = https.createServer({ key: readFileSync(join(home, 'key.pem')), cert: readFileSync(join(home, 'cert.pem')) }, (_req, res) => {
      fixtureRequests++; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync('tests/browser/fixture.html'));
    });
    await new Promise(r => fixtureServer.listen(0, '127.0.0.1', r));
    const port = bridge.server.address().port;
    context = await chromium.launchPersistentContext(join(home, 'profile'), {
      channel: 'chromium', headless: true, viewport: { width: 420, height: 1000 },
      args: [`--disable-extensions-except=${resolve('.')}`, `--load-extension=${resolve('.')}`, '--no-proxy-server', '--ignore-certificate-errors', `--host-resolver-rules=MAP www.perplexity.ai 127.0.0.1:${fixtureServer.address().port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`]
    });
    // Browser-level routing also covers the first navigation of chrome.tabs.create,
    // which can occur before Playwright attaches. Other DNS destinations are blocked.
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    const errors = []; panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/extension/panel.html`);
    await panel.locator('#setup').evaluate(node => { node.open = true; });
    await panel.locator('#port').fill(String(port));
    await expect(panel.locator('input[type=password]')).toHaveCount(0);
    await panel.locator('#connect-form button[type=submit]').click();
    const request = async (path, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      if (response.headers.get('content-type')?.includes('image/png')) return Buffer.from(await response.arrayBuffer());
      const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data;
    };
    await expect.poll(async () => (await request('/status')).extension.ready).toBe(true).catch(async error => {
      const uiStatus = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'ui-status' }));
      throw new Error(`${error.message}\nExtension status: ${JSON.stringify(uiStatus)}\nPage errors: ${JSON.stringify(errors)}`);
    });
    const command = value => request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(value) });
    const done = async id => { await expect.poll(async () => (await request(`/tasks/${id}`)).status, { timeout: 25000 }).not.toMatch(/^(queued|running)$/); return request(`/tasks/${id}`); };
    return { context, worker, extensionId, panel, errors, request, command, done, get fixtureRequests() { return fixtureRequests; }, close: async () => { await context.close(); await bridge.close(); await new Promise(r => { fixtureServer.close(r); fixtureServer.closeAllConnections(); }); rmSync(home, { recursive: true, force: true }); } };
  } catch (e) { await context?.close(); await bridge.close(); if (fixtureServer) await new Promise(r => { fixtureServer.close(r); fixtureServer.closeAllConnections(); }); rmSync(home, { recursive: true, force: true }); throw e; }
}

test('Chromium loads the extension and executes the side panel → runner → persisted result flow', async ({}, testInfo) => {
  const env = await environment();
  try {
    const { panel, request, done, command, context } = env;
    await expect(panel.locator('#version')).toHaveText(`v${JSON.parse(readFileSync('manifest.json')).version}`);
    await panel.locator('#keyword').fill('GEO 是什么？');
    await panel.locator('#run').click();
    let task;
    await expect.poll(async () => { task = (await request('/tasks')).tasks[0]; return task?.id; }).toBeTruthy();
    const completed = await done(task.id);
    expect(env.fixtureRequests).toBeGreaterThan(0);
    expect(completed.status, JSON.stringify({ task: completed, ...(completed.links.diagnostic ? { diagnostic: await request(`${completed.links.diagnostic}?view=full`) } : {}) })).toBe('done');
    const result = await request(`/tasks/${task.id}/result?view=full`);
    expect(result.keyword).toBe('GEO 是什么？');
    expect(result.text).toContain('生成式搜索');
    expect(result.citations[0].url).toBe('https://example.org/reference');
    await expect(panel.locator('#result-text')).toContainText('生成式搜索');
    const target = context.pages().find(page => page.url().startsWith('https://www.perplexity.ai/'));
    expect(await target.evaluate(() => globalThis.submissions)).toBe(1);
    const collect = await command({ action: 'collect', platform: 'perplexity', tabId: completed.tabId, focus: false });
    expect((await done(collect.id)).status).toBe('done');
    expect(await target.evaluate(() => globalThis.submissions)).toBe(1);
    const screenshot = await command({ action: 'shot', platform: 'perplexity', tabId: completed.tabId });
    const shotTask = await done(screenshot.id);
    expect(shotTask.status, JSON.stringify(shotTask)).toBe('done');
    const png = await request(`/tasks/${screenshot.id}/artifacts/screenshot`);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    writeFileSync(testInfo.outputPath('answer.png'), png);
    await testInfo.attach('answer.png', { body: png, contentType: 'image/png' });
    await expect(panel.locator('#task-count')).toHaveText('3');
    await expect(panel.locator('.task-state')).toHaveText(['已完成', '已完成', '已完成']);
    await panel.locator('#setup').evaluate(node => { node.open = false; });
    const image = await panel.screenshot({ fullPage: true, path: testInfo.outputPath('side-panel.png') });
    await testInfo.attach('side-panel.png', { body: image, contentType: 'image/png' });
    const download = panel.waitForEvent('download'); await panel.locator('#export-html').click();
    expect((await download).suggestedFilename()).toMatch(/\.html$/);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
});

test('Chromium worker termination resumes the existing runner and page reload interrupts it', async () => {
  const env = await environment();
  try {
    const run = await env.command({ action: 'run', platform: 'perplexity', keyword: '慢速回答用于恢复验证', timeoutMs: 30000 });
    await expect.poll(async () => (await env.request(`/tasks/${run.id}`)).step).toBe('waiting');
    const cdp = await env.context.newCDPSession(env.panel);
    await cdp.send('ServiceWorker.enable');
    let versions = [];
    cdp.on('ServiceWorker.workerVersionUpdated', event => { versions = event.versions; });
    await cdp.send('ServiceWorker.disable'); await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versions.find(v => v.scriptURL.includes(env.extensionId))?.versionId).toBeTruthy();
    const versionId = versions.find(v => v.scriptURL.includes(env.extensionId)).versionId;
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    // Requesting status from the extension page wakes the service worker again.
    await env.panel.evaluate(() => chrome.runtime.sendMessage({ type: 'ui-status' }));
    expect((await env.done(run.id)).status).toBe('done');
    const target = env.context.pages().find(page => page.url().startsWith('https://www.perplexity.ai/'));
    expect(await target.evaluate(() => globalThis.submissions)).toBe(1);
    const second = await env.command({ action: 'run', platform: 'perplexity', keyword: '慢速回答用于刷新验证', timeoutMs: 30000 });
    await expect.poll(async () => (await env.request(`/tasks/${second.id}`)).step).toBe('waiting');
    const secondPage = env.context.pages().filter(page => page.url().startsWith('https://www.perplexity.ai/')).at(-1);
    await secondPage.reload();
    expect((await env.done(second.id)).status).toBe('interrupted');
    expect(await secondPage.evaluate(() => globalThis.submissions)).toBe(0);
    await cdp.detach();
  } finally { await env.close(); }
});
