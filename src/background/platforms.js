// platforms.js — 平台注册表。新增平台只需在此加一项 + 对应 adapter 文件。

export const PLATFORMS = {
  perplexity: {
    match: /perplexity\.ai/,
    newConversationUrl: 'https://www.perplexity.ai/',
    files: ['src/content/adapters/perplexity.js'],
    entry: 'runPerplexityTask',
    collectEntry: 'collectPerplexityPage',
    config: { minChars: 1200, maxWait: 180000, stableNeeded: 4 },
  },
  // chatgpt / gemini / claude 在 M4 补充：
  // chatgpt: { match:/chatgpt\.com/, newConversationUrl:'https://chatgpt.com/',
  //   files:['src/content/adapters/chatgpt.js'], entry:'runChatgptTask',
  //   config:{minChars:1500,maxWait:300000,stableNeeded:5} },
};
