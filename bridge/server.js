import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Store, publicTask } from './store.js';
import { GeoError, errorBody, validateCommand, help, documentation, PLATFORMS, PROTOCOL, TERMINAL } from '../shared/protocol.js';

const version = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url))).version;
const MAX_BODY = 1024 * 1024;
function number(params, name, fallback, max) { const raw = params.get(name); const n = raw === null ? fallback : Number(raw); if (!Number.isSafeInteger(n) || n < 0 || n > max || raw === '') throw new GeoError('invalid_argument', `${name} 超出范围`, 400, { field: name }); return n; }
function send(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }
async function body(req) { let size = 0; const chunks = []; for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new GeoError('body_too_large', '请求体过大', 413); chunks.push(c); } try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new GeoError('invalid_json', 'JSON 格式错误'); } }

export function createBridge({ home, port = 8787, projectDir = resolve('.') }) {
  const store = new Store(home);
  let peer = null;
  const connected = () => Boolean(peer && peer.ws.readyState === WebSocket.OPEN && Date.now() - peer.lastSeen < 60000);
  const deliver = task => { if (connected() && peer.ready) peer.ws.send(JSON.stringify({ type: 'command', task })); };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && u.pathname === '/help') return send(res, 200, help(version));
      if (req.method === 'GET' && (u.pathname === '/docs' || u.pathname.startsWith('/docs/'))) return send(res, 200, documentation(u.pathname.split('/')[2]));
      if (req.method === 'GET' && u.pathname === '/status') return send(res, 200, { version, protocol: PROTOCOL, projectDir, extension: { connected: connected(), ready: connected() && peer.ready, lastSeen: peer?.lastSeen || null }, tasks: store.active().map(publicTask) });
      if (req.method === 'GET' && u.pathname === '/platforms') return send(res, 200, { platforms: Object.values(PLATFORMS).map(p => ({ ...p, online: connected() && peer.ready })) });
      if (req.method === 'POST' && u.pathname === '/command') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new GeoError('content_type', '需要 application/json', 415);
        const command = validateCommand(await body(req));
        const idem = req.headers['idempotency-key'] || randomUUID();
        if (typeof idem !== 'string' || idem.length > 200 || !idem.trim()) throw new GeoError('invalid_argument', '幂等键无效');
        const created = store.create(command, idem, () => { if (!connected() || !peer.ready) throw new GeoError('extension_offline', '扩展未连接或尚未完成恢复', 503, { docs: '/docs/connection' }); });
        if (!created.replay) deliver(created.task);
        return send(res, 202, { ...publicTask(created.task), idempotencyKey: idem, replay: created.replay });
      }
      if (req.method === 'GET' && u.pathname === '/tasks') return send(res, 200, { tasks: store.all().slice(0, number(u.searchParams, 'limit', 20, 100)).map(publicTask) });
      if (req.method === 'GET' && u.pathname === '/events') {
        const id = u.searchParams.get('taskId'), since = number(u.searchParams, 'since', 0, Number.MAX_SAFE_INTEGER), wait = number(u.searchParams, 'wait', 0, 25000);
        const deadline = Date.now() + wait;
        let result;
        do { result = store.events(id, since); if (result.events.length || Date.now() >= deadline || TERMINAL.includes(store.task(id).status) || res.destroyed) break; await new Promise(r => setTimeout(r, 150)); } while (true);
        return send(res, 200, result);
      }
      const match = u.pathname.match(/^\/tasks\/(task_[a-f0-9-]+)(?:\/(result|artifacts\/screenshot))?$/);
      if (req.method === 'GET' && match) {
        const [, id, kind] = match, t = store.task(id);
        if (!kind) return send(res, 200, publicTask(t));
        const data = store.result(id);
        if (kind === 'artifacts/screenshot') {
          if (!data?.screenshot || !existsSync(store.artifactPath(id, 'screenshot'))) throw new GeoError('not_found', '截图不存在', 404);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(readFileSync(store.artifactPath(id, 'screenshot')));
        }
        if (!t.resultAvailable) { if (!TERMINAL.includes(t.status)) return send(res, 202, publicTask(t)); throw new GeoError('not_found', '任务没有采集产物', 404, { links: publicTask(t).links }); }
        return send(res, 200, resultView(t, data, u.searchParams));
      }
      const diagnostic = u.pathname.match(/^\/diagnostic\/(task_[a-f0-9-]+)$/);
      if (req.method === 'GET' && diagnostic) {
        const d = store.result(diagnostic[1])?.diagnostic;
        if (!d) throw new GeoError('not_found', '诊断不存在', 404);
        const view = u.searchParams.get('view') || 'summary';
        if (!['summary', 'full'].includes(view)) throw new GeoError('invalid_argument', '诊断 view 必须是 summary 或 full');
        const { dom, ...summary } = d;
        return send(res, 200, view === 'full' ? d : { ...summary, links: { full: `/diagnostic/${diagnostic[1]}?view=full` } });
      }
      throw new GeoError('not_found', '接口不存在', 404);
    } catch (e) { if (!e.code) console.error(e); if (!res.headersSent) send(res, e.status || 500, errorBody(e)); else res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/extension') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    let initialized = false, chain = Promise.resolve();
    const timeout = setTimeout(() => ws.close(1008, 'hello timeout'), 5000);
    ws.on('message', raw => {
      chain = chain.then(() => {
        const m = JSON.parse(raw);
        if (!initialized) {
          // 只校验协议号：小版本漂移不应把扩展挡在门外（本地开发时服务与扩展常常不同步）。
          if (m.type !== 'hello' || m.protocol !== PROTOCOL) throw new GeoError('version_mismatch', '扩展与服务协议不匹配，请刷新扩展');
          if (peer && peer.ws !== ws) peer.ws.close(1000, 'reconnected');
          initialized = true; clearTimeout(timeout);
          peer = { ws, ready: false, lastSeen: Date.now() };
          ws.send(JSON.stringify({ type: 'welcome', projectDir, tasks: store.active().map(t => t.id) })); return;
        }
        if (peer?.ws !== ws) return ws.close(1008, 'superseded');
        peer.lastSeen = Date.now();
        if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
        if (m.type === 'event') {
          store.event(m.event);
          ws.send(JSON.stringify({ type: 'ack', taskId: m.event.taskId, seq: m.event.seq })); return;
        }
        if (m.type === 'sync') {
          if (!Array.isArray(m.knownTasks) || m.knownTasks.length > 10000) throw new GeoError('invalid_sync', '同步记录错误');
          for (const t of store.active()) if (!m.knownTasks.includes(t.id)) store.lose(t.id);
          peer.ready = true;
          ws.send(JSON.stringify({ type: 'ready' }));
          for (const t of store.active()) if (t.status === 'queued' && !m.knownTasks.includes(t.id)) deliver(t);
          return;
        }
        throw new GeoError('invalid_message', '未知连接消息');
      }).catch(e => { console.error(`extension: ${e.code || 'invalid_message'}`); ws.close(1008, e.code || 'invalid_message'); });
    });
    ws.on('close', () => { clearTimeout(timeout); if (peer?.ws === ws) peer = null; });
    ws.on('error', () => {});
  });
  const heartbeat = setInterval(() => { if (peer && !connected()) peer.ws.terminate(); }, 20000);
  heartbeat.unref();
  return {
    server, store,
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return server.address(); },
    async close() { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); store.close(); }
  };
}
function resultView(task, data, params) {
  const view = params.get('view') || 'summary';
  const available = ['summary', ...['text', 'citations', 'html', 'qa', 'data'].filter(k => data[k] !== undefined)];
  if (view === 'summary') return { id: task.id, status: task.status === 'done' ? 'ok' : 'partial', complete: data.complete ?? true, answerChars: Array.from(data.text || '').length, citationCount: data.citations?.length || 0, citationStatus: data.citationStatus, screenshot: data.screenshot || { status: 'not_requested' }, availableViews: available, links: { ...Object.fromEntries(available.filter(v => v !== 'summary').map(v => [v, `/tasks/${task.id}/result?view=${v}`])), ...(data.screenshot?.status === 'saved' ? { screenshot: `/tasks/${task.id}/artifacts/screenshot` } : {}) } };
  if (view === 'full') return data;
  if (!available.includes(view)) throw new GeoError('not_found', '该结果视图不存在', 404);
  if (view === 'data') return { id: task.id, data: data.data };
  const offset = number(params, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const items = view === 'citations' ? data.citations : Array.from(data[view]);
  const limit = view === 'citations' ? number(params, 'limit', 50, 200) : number(params, 'maxChars', 4000, 20000);
  if (!limit) throw new GeoError('invalid_argument', '分页长度必须大于 0');
  const selected = items.slice(offset, offset + limit);
  return { id: task.id, view, total: items.length, offset, nextOffset: offset + selected.length < items.length ? offset + selected.length : null, [view]: view === 'citations' ? selected : selected.join('') };
}
