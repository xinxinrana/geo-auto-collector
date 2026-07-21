// dev/probe-buttons.js — 专门补齐「发送按钮 + 停止按钮」的侦查
// 针对各平台特化输入方式：React textarea 用 native setter，
// contenteditable/Lexical/Quill 用 execCommand('insertText')。
//
// 用法: node dev/probe-buttons.js <platform> [--question "..."]
// 前置: 该平台的对话页(空输入或已打开)在调试 Chrome 里可见

const fs = require('fs');
const path = require('path');
const { findTab, attach } = require('./cdp');

const URL_MATCH = {
  doubao: /doubao\.com\/(chat|)/,
  kimi: /kimi\.com/,
  yuanbao: /yuanbao\.tencent\.com/,
  perplexity: /perplexity\.ai\/(search|)/,
};

const HOME_URL = {
  doubao: 'https://www.doubao.com/chat/',
  kimi: 'https://www.kimi.com/',
  yuanbao: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
  perplexity: 'https://www.perplexity.ai/',
};

const DEFAULT_QUESTION = 'GEO内容优化最重要的三个技巧是什么？';

async function main() {
  const args = process.argv.slice(2);
  const platform = args[0];
  const qIdx = args.indexOf('--question');
  const question = qIdx >= 0 ? args[qIdx + 1] : DEFAULT_QUESTION;

  if (!URL_MATCH[platform]) {
    console.error(`用法: node dev/probe-buttons.js <${Object.keys(URL_MATCH).join('|')}> [--question "..."]`);
    process.exit(1);
  }

  const tab = await findTab((t) => URL_MATCH[platform].test(t.url));
  if (!tab) {
    console.error(`未找到 ${platform} tab，请先在调试 Chrome 打开 ${HOME_URL[platform]}`);
    process.exit(1);
  }
  console.log('tab:', tab.url);
  const cdp = await attach(tab.webSocketDebuggerUrl);

  const runtimeCode = fs.readFileSync(path.join(__dirname, 'probe-buttons-runtime.js'), 'utf8');
  const call = `(${runtimeCode})(${JSON.stringify(question)}, ${JSON.stringify(platform)})`;

  console.log('注入按钮侦查脚本…');
  const result = await cdp.evaluate(call, true);

  const html = await cdp.evaluate('document.documentElement.outerHTML');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapPath = path.join(__dirname, 'snapshots', `${platform}_btns_${ts}.html`);
  const reportPath = path.join(__dirname, 'snapshots', `${platform}_btns_${ts}.report.md`);
  fs.writeFileSync(snapPath, html);

  const md = buildReport(platform, question, tab.url, result || { ok: false, error: 'no_result' });
  fs.writeFileSync(reportPath, md);
  console.log('report:', reportPath);

  if (!result || !result.ok) console.error(`❌ ${result && result.error}`);
  cdp.close();
}

function buildReport(platform, question, url, r) {
  const L = [];
  L.push(`# ${platform} 发送/停止按钮侦查报告`);
  L.push('');
  L.push(`- 时间: ${new Date().toISOString()}`);
  L.push(`- URL: ${url}`);
  L.push(`- 问题: ${JSON.stringify(question)}`);
  L.push(`- 结果: ${r.ok ? '✅ 成功' : `❌ ${r.error}`}`);
  L.push('');

  L.push('## 输入框命中');
  L.push('```json'); L.push(JSON.stringify(r.inputInfo || null, null, 2)); L.push('```');

  L.push('## 输入前的按钮总数');
  L.push('```'); L.push(String((r.buttonsBefore || []).length)); L.push('```');

  L.push('## 输入后 新出现 的按钮(去掉输入前已有的)');
  L.push('```json'); L.push(JSON.stringify(r.newAfterType || [], null, 2)); L.push('```');

  L.push('## 输入后 消失 的按钮(比较少见,若发送键是"占位切换"式会出现)');
  L.push('```json'); L.push(JSON.stringify(r.disappearedAfterType || [], null, 2)); L.push('```');

  L.push('## 发送后 消失(输入后有,发送后没有 → 大概率就是发送按钮本尊)');
  L.push('```json'); L.push(JSON.stringify(r.disappearedAfterSend || [], null, 2)); L.push('```');

  L.push('## 发送后 新增(生成期间才出现的按钮,大概率含停止按钮)');
  L.push('```json'); L.push(JSON.stringify(r.newAfterSend || [], null, 2)); L.push('```');

  L.push('## 停止按钮轮询快照(前 20 秒)');
  L.push('```json'); L.push(JSON.stringify(r.stopSnapshots || [], null, 2)); L.push('```');

  L.push('## 采集到的候选停止按钮(去重)');
  L.push('```json'); L.push(JSON.stringify(r.stopCandidates || [], null, 2)); L.push('```');

  L.push('## trace');
  L.push((r.trace || []).map((s, i) => `${i + 1}. ${s}`).join('\n'));

  return L.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
