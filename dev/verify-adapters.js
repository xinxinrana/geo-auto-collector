// dev/verify-adapters.js — 通过 CDP 把 adapter 脚本注入到已打开的对话页,验证 collect 入口
// 用法: node dev/verify-adapters.js <platform>
// 前置: 该平台的对话页在调试 Chrome 里有一个已完成的对话

const fs = require('fs');
const path = require('path');
const { findTab, attach } = require('./cdp');

const CONFIG = {
  doubao:      { url: /doubao\.com\/chat/, adapter: 'src/content/adapters/doubao.js', entry: 'collectDoubaoPage' },
  yuanbao:     { url: /yuanbao\.tencent\.com/, adapter: 'src/content/adapters/yuanbao.js', entry: 'collectYuanbaoPage' },
  kimi:        { url: /kimi\.com\/chat/, adapter: 'src/content/adapters/kimi.js', entry: 'collectKimiPage' },
  perplexity:  { url: /perplexity\.ai\/search/, adapter: 'src/content/adapters/perplexity.js', entry: 'collectPerplexityPage' },
  gemini:      { url: /gemini\.google\.com\/app/, adapter: 'src/content/adapters/gemini.js', entry: 'collectGeminiPage' },
  chatgpt:     { url: /chatgpt\.com\/c\//, adapter: 'src/content/adapters/chatgpt.js', entry: 'collectChatgptPage' },
};

async function main() {
  const p = process.argv[2];
  if (!CONFIG[p]) {
    console.error(`Usage: node dev/verify-adapters.js <${Object.keys(CONFIG).join('|')}>`);
    process.exit(1);
  }
  const cfg = CONFIG[p];
  const tab = await findTab((t) => cfg.url.test(t.url));
  if (!tab) { console.error(`No ${p} tab found`); process.exit(1); }
  console.log('tab:', tab.url);
  const cdp = await attach(tab.webSocketDebuggerUrl);

  // 先注入 common + adapter
  const common = fs.readFileSync(path.join(__dirname, '..', 'src/content/common.js'), 'utf8');
  const adapter = fs.readFileSync(path.join(__dirname, '..', cfg.adapter), 'utf8');
  console.log('injecting common.js and adapter…');
  // 清理旧的注入(GEO 保护会跳过重注,所以先删 window.GEO)
  await cdp.evaluate('delete globalThis.GEO;', false);
  await cdp.evaluate(common, false);
  await cdp.evaluate(adapter, false);

  console.log(`calling ${cfg.entry}({})…`);
  const result = await cdp.evaluate(`(async () => { try { return await globalThis['${cfg.entry}']({}); } catch (e) { return { status: 'exception', error: String(e && e.message || e) }; } })()`, true);

  // 只输出摘要,不打印全文
  const summary = {
    status: result && result.status,
    keyword: result && result.keyword,
    answerChars: result && result.answerChars,
    citations_n: result && result.citations ? result.citations.length : null,
    qaSelector: result && result.qaSelector,
    qaHtml_len: result && result.qaHtml ? result.qaHtml.length : null,
    url: result && result.url,
    error: result && result.error,
    timedOut: result && result.timedOut,
    trace: result && result.trace ? result.trace.slice(0, 20) : null,
    textPreview: result && result.text ? result.text.slice(0, 300) : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  cdp.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
