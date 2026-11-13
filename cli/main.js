import { readFile, writeFile } from 'node:fs/promises';
import { ACTIONS, GeoError, TERMINAL, documentation, help, validateCommand, errorBody } from '../shared/protocol.js';

const version = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8')).version;
const args = process.argv.slice(2);
let action = args.shift() || 'help';
if (action === '--help') action = 'help';
const options = {}, positional = [];
const print = data => console.log(JSON.stringify(data, null, 2));
function exitFor(task) { return task.status === 'suspended' ? 2 : ['failed', 'interrupted'].includes(task.status) ? 1 : 0; }
function integer(value, name, max = 3600000) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new GeoError('invalid_argument', `${name} 必须为 0–${max} 的整数`); return n; }
try {
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (key === 'no-focus') options.focus = false;
    else if (key === 'test-only') options.testOnly = true;
    else if (key === 'save') options.testOnly = false;
    else { if (!args.length || args[0].startsWith('--')) throw new GeoError('invalid_argument', `${arg} 缺少值`); options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args.shift(); }
  }
  if (action === 'help') { print({ ...help(version), cli: ['up', 'status', 'platforms', 'tasks', 'task <id>', 'result <id>', 'events <id>', 'diagnostic <id>'] }); }
  else if (action === 'docs') print(documentation(positional[0]));
  else if (action === 'up') {
    if (options.port) process.env.GEO_BRIDGE_PORT = String(integer(options.port, 'port', 65535));
    await import('../bridge/main.js');
  } else {
    const port = integer(process.env.GEO_BRIDGE_PORT || 8787, 'GEO_BRIDGE_PORT', 65535);
    const request = async (path, init = {}, binary = false) => {
      let response;
      try { response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(30000) }); }
      catch { throw new GeoError('service_offline', '无法连接 bridge，请检查 ./geo up 和端口', 503); }
      if (binary && response.ok) return new Uint8Array(await response.arrayBuffer());
      const data = await response.json();
      if (!response.ok) throw new GeoError(data.error?.code || 'http_error', data.error?.message || '请求失败', response.status, data.error || {});
      return data;
    };
    const id = () => { if (!/^task_[a-f0-9-]+$/.test(positional[0] || '')) throw new GeoError('invalid_argument', '需要有效的 taskId'); return positional[0]; };
    if (Object.hasOwn(ACTIONS, action)) {
      const wait = integer(options.wait ?? 0, 'wait');
      const idem = options.idempotencyKey || crypto.randomUUID();
      delete options.wait; delete options.idempotencyKey;
      // 位置参数就是第一个必填字段（文档与帮助里一直是 `./geo inspect input` 这种写法）。
      // 之前这里把位置参数直接丢弃，导致 field 永远回落到默认值，测的根本不是指定角色。
      if (positional.length) {
        const first = positional[0];
        const slot = ['inspect', 'dom', 'fix'].includes(action) ? 'field' : ['task', 'stop'].includes(action) ? 'taskId' : null;
        if (slot && !(slot in options)) options[slot] = first;
        else if (positional.length) throw new GeoError('invalid_argument', `多余的位置参数 ${first}`);
      }
      for (const k of ['tabId', 'timeoutMs', 'maxChars', 'expectedRevision']) if (k in options) options[k] = integer(options[k], k, 2147483647);
      const command = validateCommand({ action, ...options });
      let task = await request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idem }, body: JSON.stringify(command) });
      if (wait) {
        const deadline = Date.now() + wait;
        console.error(`任务 ${task.id}；幂等键 ${idem}`);
        while (!TERMINAL.includes(task.status) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, Math.min(task.pollAfterMs || 1000, Math.max(0, deadline - Date.now()))));
          task = await request(`/tasks/${task.id}`);
        }
        if (!TERMINAL.includes(task.status)) { print({ ...task, waitTimedOut: true }); process.exitCode = 4; }
        else { print({ task, ...(task.resultAvailable ? { result: await request(`/tasks/${task.id}/result`) } : {}) }); process.exitCode = exitFor(task); }
      } else { print(task); process.exitCode = exitFor(task); }
    } else if (['status', 'platforms', 'tasks'].includes(action)) {
      print(await request(`/${action}${action === 'tasks' && options.limit ? `?limit=${integer(options.limit, 'limit', 100)}` : ''}`));
    } else if (action === 'task') { const task = await request(`/tasks/${id()}`); print(task); process.exitCode = exitFor(task); }
    else if (action === 'result') {
      if (options.view === 'screenshot') {
        if (!options.out) throw new GeoError('invalid_argument', '截图需要 --out <文件路径>');
        const bytes = await request(`/tasks/${id()}/artifacts/screenshot`, {}, true);
        await writeFile(options.out, bytes); print({ path: options.out, bytes: bytes.length });
      } else {
        const query = new URLSearchParams();
        for (const key of Object.keys(options)) { if (!['view', 'offset', 'maxChars', 'limit'].includes(key)) throw new GeoError('invalid_argument', `未知参数 ${key}`); query.set(key, options[key]); }
        print(await request(`/tasks/${id()}/result?${query}`));
      }
    } else if (action === 'events') print(await request(`/events?taskId=${id()}&since=${integer(options.since ?? 0, 'since', Number.MAX_SAFE_INTEGER)}&wait=${integer(options.wait ?? 0, 'wait', 25000)}`));
    else if (action === 'diagnostic') print(await request(`/diagnostic/${id()}?view=${encodeURIComponent(options.view || 'summary')}`));
    else throw new GeoError('invalid_action', '未知命令，运行 ./geo help');
  }
} catch (error) {
  if (error.code === 'ENOENT') error = new GeoError('service_offline', '请先运行 ./geo up', 503);
  print(errorBody(error)); process.exitCode = error.status === 503 ? 5 : error.status === 409 ? 3 : 1;
}
