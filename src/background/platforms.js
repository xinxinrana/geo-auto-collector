// platforms.js — 平台注册表。新增平台只需在此加一项 + 对应 adapter 文件。

export const PLATFORMS = {
  perplexity: {
    match: /perplexity\.ai/,
    newConversationUrl: 'https://www.perplexity.ai/',
    files: ['src/content/adapters/perplexity.js'],
    entry: 'runPerplexityTask',
    collectEntry: 'collectPerplexityPage',
    // Perplexity 答案常常只有 400-700 字,minChars 只作为 fallback 门槛,主判据是 stop 按钮消失
    config: { minChars: 300, maxWait: 180000 },
  },
  chatgpt: {
    match: /chatgpt\.com|chat\.openai\.com/,
    newConversationUrl: 'https://chatgpt.com/',
    files: ['src/content/adapters/chatgpt.js'],
    entry: 'runChatgptTask',
    collectEntry: 'collectChatgptPage',
    config: { minChars: 1500, maxWait: 300000 },
  },
  gemini: {
    match: /gemini\.google\.com/,
    newConversationUrl: 'https://gemini.google.com/app',
    files: ['src/content/adapters/gemini.js'],
    entry: 'runGeminiTask',
    collectEntry: 'collectGeminiPage',
    config: { minChars: 1000, maxWait: 240000 },
  },
  claude: {
    match: /claude\.ai/,
    newConversationUrl: 'https://claude.ai/new',
    files: ['src/content/adapters/claude.js'],
    entry: 'runClaudeTask',
    collectEntry: 'collectClaudePage',
    config: { minChars: 1200, maxWait: 240000 },
  },
  doubao: {
    match: /doubao\.com/,
    newConversationUrl: 'https://www.doubao.com/chat/',
    files: ['src/content/adapters/doubao.js'],
    entry: 'runDoubaoTask',
    collectEntry: 'collectDoubaoPage',
    config: { minChars: 400, maxWait: 240000 },
  },
  yuanbao: {
    match: /yuanbao\.tencent\.com/,
    newConversationUrl: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    files: ['src/content/adapters/yuanbao.js'],
    entry: 'runYuanbaoTask',
    collectEntry: 'collectYuanbaoPage',
    config: { minChars: 400, maxWait: 240000 },
  },
  kimi: {
    match: /kimi\.com/,
    newConversationUrl: 'https://www.kimi.com/',
    files: ['src/content/adapters/kimi.js'],
    entry: 'runKimiTask',
    collectEntry: 'collectKimiPage',
    config: { minChars: 400, maxWait: 240000 },
  },
};
