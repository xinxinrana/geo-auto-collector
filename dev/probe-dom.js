// dev/probe-dom.js — 通用侦查脚本
// 用法: node dev/probe-dom.js <platform> [--question "..."]
//   platform: gemini | chatgpt | claude | perplexity
// 前置: Chrome 已带 --remote-debugging-port=9222 启动，且已登录目标平台
//
// 流程：
//   1. 打开对应平台首页（若非首页则导航过去）
//   2. 输入问题、点发送、等回答生成完成
//   3. 保存整页 HTML 快照到 dev/snapshots/{platform}_{ts}.html
//   4. 分析 DOM：
//      a) 通过问题文本反查用户气泡节点
//      b) 从用户气泡向后/向上寻找回答节点
//      c) 计算 QA 最小公共祖先
//      d) 输出「候选选择器 + DOM 树片段 + 结论」到 dev/snapshots/{platform}_{ts}.report.md

const fs = require('fs');
const path = require('path');
const { findTab, attach } = require('./cdp');

const PLATFORMS = {
  gemini: {
    urlMatch: /gemini\.google\.com/,
    homeUrl: 'https://gemini.google.com/app',
  },
  chatgpt: {
    urlMatch: /chatgpt\.com|chat\.openai\.com/,
    homeUrl: 'https://chatgpt.com/',
  },
  claude: {
    urlMatch: /claude\.ai/,
    homeUrl: 'https://claude.ai/new',
  },
  perplexity: {
    urlMatch: /perplexity\.ai/,
    homeUrl: 'https://www.perplexity.ai/',
  },
  doubao: {
    urlMatch: /doubao\.com/,
    homeUrl: 'https://www.doubao.com/chat/',
  },
  kimi: {
    urlMatch: /kimi\.com/,
    homeUrl: 'https://www.kimi.com/',
  },
  yuanbao: {
    urlMatch: /yuanbao\.tencent\.com/,
    homeUrl: 'https://yuanbao.tencent.com/chat/',
  },
};

const DEFAULT_QUESTION = 'GEO内容优化最重要的三个技巧是什么？';

async function main() {
  const args = process.argv.slice(2);
  const platform = args[0];
  const qIdx = args.indexOf('--question');
  const question = qIdx >= 0 ? args[qIdx + 1] : DEFAULT_QUESTION;

  if (!PLATFORMS[platform]) {
    console.error(`用法: node dev/probe-dom.js <${Object.keys(PLATFORMS).join('|')}> [--question "..."]`);
    process.exit(1);
  }
  const cfg = PLATFORMS[platform];

  console.log(`[侦查] 平台=${platform} 问题="${question}"`);
  const tab = await findTab((t) => cfg.urlMatch.test(t.url));
  if (!tab) {
    console.error(`未找到 ${platform} 的 Tab。请先在调试 Chrome 里打开 ${cfg.homeUrl} 并登录。`);
    process.exit(1);
  }
  console.log(`[侦查] 命中 Tab: ${tab.url}`);

  const cdp = await attach(tab.webSocketDebuggerUrl);

  // 侦查阶段的运行时脚本：输入 + 发送 + 等答案 + 抓分析
  const probeCode = fs.readFileSync(path.join(__dirname, 'probe-runtime.js'), 'utf8');
  const probeCall = `(${probeCode})(${JSON.stringify(question)}, ${JSON.stringify(platform)})`;

  console.log(`[侦查] 注入分析器，开始输入 & 采集…`);
  let result;
  try {
    result = await cdp.evaluate(probeCall, true);
  } catch (e) {
    console.error(`[侦查] 页面内脚本抛异常: ${e.message}`);
    process.exit(2);
  }

  // 无论成功失败都拉快照 + 生成报告(失败时也能查看采到的输入框/登录墙等)
  const html = await cdp.evaluate('document.documentElement.outerHTML');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapPath = path.join(__dirname, 'snapshots', `${platform}_${ts}.html`);
  const reportPath = path.join(__dirname, 'snapshots', `${platform}_${ts}.report.md`);
  fs.writeFileSync(snapPath, html, 'utf8');
  console.log(`[侦查] 快照已存: ${snapPath} (${(html.length / 1024).toFixed(1)} KB)`);
  fs.writeFileSync(reportPath, buildReport(platform, question, result || { ok: false, error: 'no_result', trace: [] }, tab.url, snapPath), 'utf8');
  console.log(`[侦查] 报告已存: ${reportPath}`);

  if (!result || !result.ok) {
    console.error(`[侦查] ❌ 失败: ${result && result.error}`);
    if (result && result.trace) console.error('trace:\n' + result.trace.map((s, i) => `  ${i + 1}. ${s}`).join('\n'));
    // 不 exit 2 —— 报告已生成，可查看
  }

  cdp.close();
}

function fence(lang, s) { return '```' + lang + '\n' + s + '\n```'; }

function buildReport(platform, question, r, tabUrl, snapPath) {
  const now = new Date().toISOString();
  const L = [];
  L.push(`# ${platform} DOM 侦查报告(7 锚点)`);
  L.push('');
  L.push(`- 侦查时间: ${now}`);
  L.push(`- 页面 URL: ${tabUrl}`);
  L.push(`- 使用问题: ${JSON.stringify(question)}`);
  L.push(`- 快照文件: ${path.basename(snapPath)}`);
  L.push(`- 侦查结果: ${r.ok ? '✅ 成功' : `❌ ${r.error}`}`);
  L.push('');

  // ---- 7. 登录墙 ----
  L.push('## 锚点 7 · 登录墙特征');
  L.push('```json'); L.push(JSON.stringify(r.loginFeatures || null, null, 2)); L.push('```');
  L.push('');

  // ---- 1. 输入框 ----
  L.push('## 锚点 1 · 输入框');
  L.push('### 命中的输入');
  L.push('```json'); L.push(JSON.stringify(r.inputInfo || null, null, 2)); L.push('```');
  L.push('### 输入框祖先链(找 form / container)');
  L.push('```json'); L.push(JSON.stringify(r.inputAncestors || [], null, 2)); L.push('```');
  L.push('### 页面上所有输入候选(全部枚举,供决策)');
  L.push('```json'); L.push(JSON.stringify(r.inputCandidatesAll || [], null, 2)); L.push('```');
  L.push('');

  // ---- 2. 发送按钮 ----
  L.push('## 锚点 2 · 发送按钮');
  L.push('**方法**: 记录输入前 vs 输入后的可见按钮,取「输入后新出现」的按钮列表(大概率含发送键)。');
  L.push('');
  L.push('### 输入前的可见按钮数');
  L.push('```');
  L.push(String((r.buttonsBeforeType || []).length));
  L.push('```');
  L.push('### 输入后新出现的按钮(推荐做发送键候选)');
  L.push('```json'); L.push(JSON.stringify(r.newAfterType || [], null, 2)); L.push('```');
  L.push('### 过滤后的发送键候选(排除菜单/模型选择/上传等)');
  L.push('```json'); L.push(JSON.stringify(r.sendCandidates || [], null, 2)); L.push('```');
  L.push('');

  // ---- 3. 停止按钮 ----
  L.push('## 锚点 3 · 停止/生成中按钮');
  L.push('**方法**: 发送后前 20 秒轮询 10 次,采集「输入前不存在但在生成期间出现」且 aria/testid/title/text 含 stop/停止/中止/pause 的按钮。');
  L.push('');
  L.push('### 采集到的停止按钮(去重)');
  L.push('```json'); L.push(JSON.stringify(r.seenStopButtons || [], null, 2)); L.push('```');
  L.push('### 轮询快照(用于诊断按钮出现的时机)');
  L.push('```json'); L.push(JSON.stringify(r.stopSnapshots || [], null, 2)); L.push('```');
  L.push('');

  // ---- 4. 用户气泡 ----
  L.push('## 锚点 4 · 用户气泡(问题所在节点)');
  L.push('```json'); L.push(JSON.stringify(r.userNode || null, null, 2)); L.push('```');
  L.push('');

  // ---- 5. 回答节点 ----
  L.push('## 锚点 5 · 回答节点');
  L.push('```json'); L.push(JSON.stringify(r.assistantNode || null, null, 2)); L.push('```');
  L.push('');

  // ---- 6. QA 最小公共祖先 ----
  L.push('## 锚点 6 · QA 最小公共祖先(截图/答案/引用扫描的边界)');
  L.push('```json'); L.push(JSON.stringify(r.qaAncestor || null, null, 2)); L.push('```');
  L.push('### 从用户气泡到 QA 祖先的链(观察 textLen 跳跃点)');
  L.push('```json'); L.push(JSON.stringify(r.ancestorChain || [], null, 2)); L.push('```');
  L.push(`### 引用链接: QA 内 ${(r.linksInQA || []).length} 个 / 全页 ${r.linksInPageCount || 0} 个`);
  L.push('```json'); L.push(JSON.stringify(r.linksInQA || [], null, 2)); L.push('```');
  L.push('### QA 祖先 outerHTML 前 5000 字');
  L.push('```html'); L.push(r.qaAncestorHtmlPreview || '(空)'); L.push('```');
  L.push('');

  // ---- trace ----
  L.push('## 侦查过程 trace');
  L.push((r.trace || []).map((s, i) => `${i + 1}. ${s}`).join('\n'));
  L.push('');

  // ---- 答案预览 ----
  L.push('## 采集到的答案文本预览(前 800 字)');
  L.push('```text'); L.push((r.answerText || '').slice(0, 800)); L.push('```');
  L.push('');
  L.push('---');
  L.push('本报告由 `dev/probe-dom.js` 自动生成,不进插件打包。');
  return L.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
