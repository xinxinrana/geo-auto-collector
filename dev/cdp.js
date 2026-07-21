// dev/cdp.js — 轻量 CDP 客户端封装（Node 18+，内置 WebSocket）
// 提供：list()、attach(wsUrl)、evaluate(expr, awaitPromise)

async function list(host = '127.0.0.1', port = 9222) {
  const res = await fetch(`http://${host}:${port}/json`);
  return res.json();
}

async function findTab(matcher, host, port) {
  const tabs = await list(host, port);
  return tabs.find((t) => t.type === 'page' && matcher(t));
}

// 打开一个新 tab(用 /json/new?url=...),返回 tab 对象
async function openTab(url, host = '127.0.0.1', port = 9222) {
  const res = await fetch(`http://${host}:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) {
    // 有些 Chrome 版本 /json/new 需要 GET
    const res2 = await fetch(`http://${host}:${port}/json/new?${encodeURIComponent(url)}`);
    return res2.json();
  }
  return res.json();
}

function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = async () => {
      const send = (method, params = {}) => {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((r) => pending.set(i, r));
      };
      await send('Runtime.enable');
      const evaluate = async (expression, awaitPromise = false) => {
        const r = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise,
        });
        if (r.result && r.result.exceptionDetails) {
          const ex = r.result.exceptionDetails;
          throw new Error(`Runtime exception: ${ex.exception ? ex.exception.description : JSON.stringify(ex)}`);
        }
        return r.result && r.result.result && r.result.result.value;
      };
      resolve({ ws, send, evaluate, close: () => ws.close() });
    };
  });
}

module.exports = { list, findTab, openTab, attach };
