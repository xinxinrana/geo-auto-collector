// 通用 collect 模式侦查：不做输入/发送，直接在当前已加载好的对话页做 DOM 分析
// 用法: node dev/probe-collect.js <platform> [--question "..."]
//   若不给 question，尝试从 document.title 或页面上首个用户消息推断
const fs = require('fs');
const path = require('path');
const { findTab, attach } = require('./cdp');

const URL_MATCH = {
  doubao: /doubao\.com/,
  kimi: /kimi\.com/,
  yuanbao: /yuanbao\.tencent\.com/,
  gemini: /gemini\.google\.com/,
  chatgpt: /chatgpt\.com|chat\.openai\.com/,
  claude: /claude\.ai/,
  perplexity: /perplexity\.ai/,
};

async function main() {
  const args = process.argv.slice(2);
  const platform = args[0];
  const qIdx = args.indexOf('--question');
  let question = qIdx >= 0 ? args[qIdx + 1] : null;
  if (!URL_MATCH[platform]) { console.error(`用法: node dev/probe-collect.js <${Object.keys(URL_MATCH).join('|')}> [--question "..."]`); process.exit(1); }

  const tab = await findTab((t) => URL_MATCH[platform].test(t.url));
  if (!tab) { console.error(`no ${platform} tab`); process.exit(1); }
  console.log('tab:', tab.url);
  const cdp = await attach(tab.webSocketDebuggerUrl);

  // 若无 question，从 title 猜
  if (!question) {
    const title = await cdp.evaluate('document.title');
    question = String(title).replace(/^\s*|\s*[|\-–]\s*.*$/g, '').trim();
    console.log('inferred question from title:', JSON.stringify(question));
  }

  const code = `
(async (question) => {
  const trace = [];
  const t = (m, e) => trace.push(m + (e !== undefined ? ' ' + (typeof e === 'object' ? JSON.stringify(e) : e) : ''));
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const qNorm = norm(question).toLowerCase();
  t('start', { url: location.href, q: question });

  // 优先在 <main> 内反查；没 main 则在整个 body 但排除 nav/aside/sidebar
  const searchRoot = document.querySelector('main') || document.body;
  const inSidebar = (el) => el.closest('nav, aside, [role=navigation], [role=complementary], [class*=sidebar], [class*=history]');

  const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_ELEMENT);
  const matches = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (inSidebar(el)) continue;
    const text = norm(el.innerText || '').toLowerCase();
    if (text.includes(qNorm) && text.length < qNorm.length * 8) matches.push(el);
  }
  matches.sort((a, b) => a.innerText.length - b.innerText.length);
  const userNode = matches[0] || null;
  if (!userNode) return { ok: false, error: 'user_bubble_not_found', trace, matchCount: matches.length, searchRoot: searchRoot.tagName };
  t('user_anchored', { tag: userNode.tagName, cls: String(userNode.className||'').slice(0,80), textLen: userNode.innerText.length });

  // 向后/向上找回答
  let assistantNode = null;
  let hopNode = userNode;
  for (let hop = 0; hop < 12 && !assistantNode; hop++) {
    let sib = hopNode.nextElementSibling;
    while (sib) {
      const sibText = norm(sib.innerText || '');
      if (sibText.length > qNorm.length * 1.5 && !sibText.toLowerCase().includes(qNorm)) {
        assistantNode = sib;
        t('assistant_by_sib', { hop, tag: sib.tagName, cls: String(sib.className||'').slice(0,80), textLen: sib.innerText.length });
        break;
      }
      sib = sib.nextElementSibling;
    }
    if (!assistantNode) hopNode = hopNode.parentElement;
    if (!hopNode) break;
  }

  const ancestors = (n) => { const a = []; while (n) { a.push(n); n = n.parentElement; } return a; };
  const aChain = ancestors(userNode);
  const bChain = new Set(assistantNode ? ancestors(assistantNode) : []);
  const qaAncestor = assistantNode ? aChain.find(n => bChain.has(n)) : userNode.closest('main') || document.body;
  t('qa_ancestor', { tag: qaAncestor.tagName, cls: String(qaAncestor.className||'').slice(0,80) });

  // 用户气泡到 qaAncestor 的祖先链（含 textLen 跳跃点）
  const chainInfo = [];
  let n = userNode;
  while (n && n !== qaAncestor.parentElement) {
    chainInfo.push({
      tag: n.tagName, cls: String(n.className||'').slice(0, 80),
      dataAttrs: [...n.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name).slice(0,6),
      textLen: (n.innerText||'').length,
    });
    n = n.parentElement;
  }

  const describe = (el) => el ? {
    tag: el.tagName.toLowerCase(), id: el.id || null,
    className: String(el.className||'').slice(0,200),
    dataAttrs: [...el.attributes].filter(a=>a.name.startsWith('data-')).map(a=>({name:a.name,value:(a.value||'').slice(0,60)})),
    textLen: (el.innerText||'').length,
    innerTextPreview: (el.innerText||'').slice(0,120).replace(/\\n+/g,' '),
  } : null;

  const links = qaAncestor ? [...qaAncestor.querySelectorAll('a[href^="http"]')].map(a=>a.href) : [];
  const stopBtns = [...document.querySelectorAll('button')].filter(b => {
    const s = ((b.getAttribute('aria-label')||'') + (b.getAttribute('data-testid')||'') + (b.getAttribute('title')||'') + (b.innerText||'')).toLowerCase();
    return /stop|停止|中止/.test(s);
  }).map(b => ({ aria: b.getAttribute('aria-label'), testid: b.getAttribute('data-testid'), title: b.getAttribute('title'), text: (b.innerText||'').slice(0,20), visible: b.offsetParent !== null }));

  return {
    ok: true, trace,
    userNode: describe(userNode),
    assistantNode: describe(assistantNode),
    qaAncestor: describe(qaAncestor),
    ancestorChain: chainInfo,
    linksInQA: links.slice(0, 20),
    linksInPage: [...document.querySelectorAll('a[href^="http"]')].length,
    stopButtons: stopBtns,
    qaAncestorHtmlPreview: qaAncestor ? qaAncestor.outerHTML.slice(0, 5000) : null,
  };
})(${JSON.stringify(question)})
`;
  const result = await cdp.evaluate(code, true);
  const html = await cdp.evaluate('document.documentElement.outerHTML');
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const snapPath = path.join(__dirname, 'snapshots', `${platform}_collect_${ts}.html`);
  const reportPath = path.join(__dirname, 'snapshots', `${platform}_collect_${ts}.report.md`);
  fs.writeFileSync(snapPath, html);
  const lines = [
    `# ${platform} DOM 侦查报告(collect 模式)`, '',
    `- 时间: ${new Date().toISOString()}`,
    `- URL: ${tab.url}`,
    `- 问题: ${JSON.stringify(question)}`,
    `- 快照: ${path.basename(snapPath)}`,
    '',
    result.ok ? '' : `❌ ok=false: ${result.error} (matchCount=${result.matchCount}, searchRoot=${result.searchRoot})`,
    '',
    '## 用户气泡', '```json', JSON.stringify(result.userNode, null, 2), '```',
    '## 回答节点', '```json', JSON.stringify(result.assistantNode, null, 2), '```',
    '## QA 最小公共祖先', '```json', JSON.stringify(result.qaAncestor, null, 2), '```',
    '## 从用户气泡到 QA 祖先的链（含 textLen 跳跃）',
    '```json', JSON.stringify(result.ancestorChain, null, 2), '```',
    `## 引用链接(QA 内 ${result.linksInQA?.length || 0} 个 / 全页 ${result.linksInPage} 个)`,
    '```json', JSON.stringify(result.linksInQA, null, 2), '```',
    '## 停止按钮候选(用于 isGenerating)',
    '```json', JSON.stringify(result.stopButtons, null, 2), '```',
    '## trace', (result.trace||[]).map((s,i)=>`${i+1}. ${s}`).join('\n'),
    '', '## QA 祖先 HTML 片段(截取)', '```html', result.qaAncestorHtmlPreview || '(空)', '```',
  ].join('\n');
  fs.writeFileSync(reportPath, lines);
  console.log('report:', reportPath);
  cdp.close();
}
main().catch(e => { console.error(e); process.exit(1); });
