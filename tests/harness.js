import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto, randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { WebSocket } from 'ws';
import { createBridge } from '../bridge/server.js';

export async function until(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture state'); await new Promise(r => setTimeout(r, 20)); }
}
const extensionId = 'b'.repeat(32);
const manifest = JSON.parse(readFileSync('manifest.json'));
const listeners = () => { const fns = []; return { addListener: fn => fns.push(fn), fire: (...args) => fns.forEach(fn => fn(...args)), fns }; };
const clone = data => JSON.parse(JSON.stringify(data));
export async function browserFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'geo-browser-fixture-'));
  let bridge = createBridge({ home, port: 0 }); await bridge.listen();
  const port = bridge.server.address().port;
  const db = new IDBFactory(), tabs = new Map(); let nextTab = 1, worker, submissions = 0;
  const onRemoved = listeners(), onUpdated = listeners();
  const timers = new Set(), sockets = new Set(), panels = [];
  const fixtures = { omitCompletion: false, ambiguous: false, delayCompletion: 80 };
  function makeTab(content, options = {}) {
    const id = nextTab++, documentId = randomUUID();
    const url = options.url || 'https://www.perplexity.ai/';
    const dom = new JSDOM(content || '<main><form><textarea></textarea><button type="button" aria-label="Submit">Send</button></form><div class="focus:outline-none" id="rounds"></div></main>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, onMessage = listeners();
    w.HTMLElement.prototype.getClientRects = function() { return this.isConnected && !this.hidden && this.style.display !== 'none' ? [{ width: 600, height: 100 }] : []; };
    w.HTMLElement.prototype.getBoundingClientRect = function() { return { x: 0, y: 0, top: 0, left: 0, width: 600, height: 100, right: 600, bottom: 100 }; };
    w.chrome = { runtime: { onMessage, sendMessage: message => dispatch(message, { id: extensionId, tab: { id }, documentId, frameId: 0, url: w.location.href }) } };
    // 真实站点提交后输入框会清空；豆包适配器以此为提交成立的硬证据。
    if (options.onSend) w.document.querySelector(options.sendSelector)?.addEventListener('click', () => {
      submissions++;
      const box = w.document.querySelector(options.inputSelector);
      const value = box?.value ?? box?.textContent ?? '';
      if (box) { if ('value' in box) box.value = ''; box.textContent = ''; }
      options.onSend(w, value);
    });
    else w.document.querySelector('[aria-label=Submit]')?.addEventListener('click', () => {
      submissions++;
      const keyword = w.document.querySelector('textarea').value;
      const render = () => {
      const round = w.document.createElement('div'); round.className = 'flex flex-col gap-y-md';
      const q = w.document.createElement('h2'); q.textContent = keyword;
      const a = w.document.createElement('section'); a.innerHTML = '<div class="prose">当前回答 <a href="https://example.org/source">来源</a></div>';
      if (fixtures.ambiguous) a.innerHTML += '<div class="prose">另一个候选</div>';
      round.append(q, a); w.document.getElementById('rounds').append(round);
      if (!fixtures.omitCompletion) {
        const stop = w.document.createElement('button'); stop.setAttribute('aria-label', 'Stop response'); w.document.body.append(stop);
        w.setTimeout(() => { stop.remove(); const copy = w.document.createElement('button'); copy.setAttribute('aria-label', 'Copy'); a.append(copy); }, fixtures.delayCompletion);
      }
      };
      if (fixtures.delayAnswer) w.setTimeout(render, fixtures.delayAnswer);
      else render();
    });
    const tab = { id, documentId, dom, onMessage, url: w.location.href, status: 'complete', windowId: 1, title: options.title || 'Fixture Perplexity', discarded: false };
    tabs.set(id, tab); return tab;
  }
  async function dispatch(message, sender) {
    return new Promise((resolve, reject) => {
      if (!worker?.runtime.onMessage.fns.length) return reject(new Error('worker unavailable'));
      let responded = false;
      for (const fn of worker.runtime.onMessage.fns) fn(clone(message), sender, response => { if (!responded) { responded = true; resolve(clone(response)); } });
    });
  }
  async function startWorker() {
    const runtime = { id: extensionId, getManifest: () => manifest, getURL: path => `chrome-extension://${extensionId}/${path}`, sendMessage: async () => {}, onMessage: listeners(), onStartup: listeners(), onInstalled: listeners() };
    const chrome = {
      runtime,
      tabs: {
        onRemoved, onUpdated,
        create: async ({ url: target } = {}) => { const cfg = fixtures.newTab || {}; const tab = makeTab(cfg.content, { ...cfg, url: target || cfg.url }); return { id: tab.id, url: tab.url, status: tab.status, windowId: 1 }; },
        get: async id => { const tab = tabs.get(id); if (!tab) throw new Error('No tab'); return { id, url: tab.url, status: tab.status, discarded: tab.discarded, windowId: 1 }; },
        query: async queryInfo => {
          const patterns = queryInfo?.url || [];
          return [...tabs.values()].filter(tab => !patterns.length || patterns.some(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(tab.url))).map(tab => ({ id: tab.id, url: tab.url, title: tab.title }));
        },
        update: async () => {},
        sendMessage: async (id, message, options) => {
          const tab = tabs.get(id); if (!tab || options?.documentId && options.documentId !== tab.documentId || !tab.onMessage.fns.length) throw new Error('Receiving end does not exist');
          return new Promise((resolve, reject) => { let response; tab.onMessage.fire(clone(message), { id: extensionId }, r => { response = r; }); if (response === undefined) reject(new Error('No response')); else resolve(clone(response)); });
        }
      },
      windows: { update: async () => {} },
      scripting: { executeScript: async ({ target, files, func }) => {
        const tab = tabs.get(target.tabId); if (!tab) throw new Error('No tab');
        for (const file of files || []) tab.dom.window.eval(readFileSync(file, 'utf8'));
        return [{ documentId: tab.documentId, result: func ? tab.dom.window.eval(`(${func.toString()})()`) : null }];
      } },
      sidePanel: { setPanelBehavior: async () => {} },
      alarms: { create: async () => {}, onAlarm: listeners() },
      debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async (target, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          const tab = tabs.get(target.tabId);
          if (tab) { const el = tab.dom.window.document.elementFromPoint?.(params.x, params.y); (el || tab.dom.window.document.querySelector('[aria-label=Submit]'))?.click(); }
          return {};
        }
        if (method === 'Input.insertText') {
          const tab = tabs.get(target.tabId), box = tab?.dom.window.document.querySelector('textarea,[contenteditable="true"]');
          if (box) { box.textContent = params.text; box.dispatchEvent(new tab.dom.window.InputEvent('input', { bubbles: true })); }
          return {};
        }
        if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && params.key === 'Enter') {
          const tab = tabs.get(target.tabId), box = tab?.dom.window.document.querySelector('textarea,[contenteditable="true"]');
          box?.dispatchEvent(new tab.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          tab?.dom.window.document.querySelector('[aria-label=Submit]')?.click();
          return {};
        }
        return { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZJAAAAAASUVORK5CYII=' };
      } }
    };
    class Socket extends WebSocket { constructor(url) { super(url, { origin: `chrome-extension://${extensionId}` }); sockets.add(this); } }
    const context = vm.createContext({ chrome, indexedDB: db, crypto: webcrypto, console, URL, fetch, AbortSignal, WebSocket: Socket,
      setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; }, clearTimeout,
      setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; }, clearInterval });
    const modules = new Map();
    async function load(file) {
      const path = resolve(file);
      if (modules.has(path)) return modules.get(path);
      const module = new vm.SourceTextModule(readFileSync(path, 'utf8'), { context, identifier: path }); modules.set(path, module);
      await module.link((specifier, referring) => load(resolve(dirname(referring.identifier), specifier))); return module;
    }
    worker = { runtime, chrome, context, modules };
    await (await load('extension/background.js')).evaluate();
    return worker;
  }
  function stopWorker() { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } timers.clear(); for (const socket of sockets) { socket.onclose = null; socket.terminate(); } sockets.clear(); onRemoved.fns.length = 0; onUpdated.fns.length = 0; worker = null; }
  t.after(async () => { stopWorker(); for (const tab of tabs.values()) tab.dom.window.close(); for (const panel of panels) panel.window.close(); await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  await startWorker();
  const ui = (type, values = {}) => dispatch({ type, ...values }, { id: extensionId, url: `chrome-extension://${extensionId}/extension/panel.html` });
  await ui('ui-connect', { port });
  const request = async (path, init = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: r.status, body: await r.json() };
  };
  await until(async () => (await request('/status')).body.extension.ready);
  const command = async (command, key = randomUUID()) => {
    const r = await request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(command) });
    if (r.status !== 202) throw new Error(JSON.stringify(r.body)); return r.body;
  };
  const done = async (id, ms = 8000) => { let t; await until(async () => { t = (await request(`/tasks/${id}`)).body; return ['done', 'failed', 'suspended', 'interrupted'].includes(t.status); }, ms); return t; };
  async function openPanel() {
    const panel = new JSDOM(readFileSync('extension/panel.html', 'utf8'), { url: `chrome-extension://${extensionId}/extension/panel.html`, runScripts: 'outside-only' }); panels.push(panel);
    panel.window.chrome = { runtime: { sendMessage: message => dispatch(message, { id: extensionId, url: `chrome-extension://${extensionId}/extension/panel.html` }) } };
    const code = new vm.SourceTextModule(readFileSync('extension/panel.js', 'utf8'), { context: panel.getInternalVMContext() }); await code.link(() => {}); await code.evaluate();
    return panel;
  }
  return { request, command, done, ui, tabs, fixtures, makeTab, openPanel, tabUpdated: (id, info) => onUpdated.fire(id, info), get submissions() { return submissions; }, restartWorker: async () => { stopWorker(); await startWorker(); await until(async () => (await request('/status')).body.extension.ready); }, closeTab: id => { tabs.get(id)?.dom.window.close(); tabs.delete(id); onRemoved.fire(id); } };
}
