/*
 * AI 网页翻译 — 共享常量
 * 经典脚本（非 ES Module），挂载到 globalThis.WPT，可被 content script / service worker / 页面复用。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.CONST_READY) return;
  NS.CONST_READY = true;

  NS.VERSION = '1.0.0';
  NS.PORT_NAME = 'wpt-stream';
  NS.SETTINGS_KEY = 'wpt.settings.v1';
  NS.CACHE_PREFIX = 'wpt.c.';
  NS.CACHE_META_KEY = 'wpt.cache.meta.v1';

  NS.MSG = {
    PING: 'wpt:ping',
    START: 'wpt:start',
    RESTORE: 'wpt:restore',
    STOP: 'wpt:stop',
    READY: 'wpt:ready',
    RESULTS: 'wpt:results',
    PROGRESS: 'wpt:progress',
    DONE: 'wpt:done',
    ERROR: 'wpt:error',
    CACHE_CLEAR: 'wpt:cache-clear',
    CACHE_STATS: 'wpt:cache-stats',
    TEST_CONNECTION: 'wpt:test-connection',
    INJECT: 'wpt:inject',
    TOGGLE: 'wpt:toggle',
    NOTIFY: 'wpt:notify'
  };

  NS.STATUS = {
    IDLE: 'idle',
    SCANNING: 'scanning',
    TRANSLATING: 'translating',
    DONE: 'done',
    ERROR: 'error'
  };

  NS.DEFAULT_SETTINGS = {
    // ---- AI 服务 ----
    provider: 'openai',            // openai | anthropic
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    // ---- 翻译 ----
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    displayMode: 'bilingual',      // bilingual | translation
    markStyle: 'none',             // none | underline | border | background
    skipTargetLang: true,
    translateTitle: true,
    minTextLength: 2,
    customPrompt: '',
    // ---- 性能 ----
    concurrency: 4,                // 1 - 16
    batchChars: 1200,
    batchItems: 16,
    firstBatchChars: 400,          // 首批更小 => 首屏更快
    maxRetries: 2,
    timeoutMs: 60000,
    useCache: true,
    cacheMaxEntries: 4000,
    // ---- 其他 ----
    autoTranslate: false,
    animations: true
  };

  NS.LIMITS = {
    concurrency: [1, 16],
    batchChars: [200, 8000],
    batchItems: [1, 60],
    firstBatchChars: [100, 4000],
    maxRetries: [0, 5],
    timeoutMs: [5000, 300000],
    minTextLength: [0, 40],
    cacheMaxEntries: [100, 20000],
    temperature: [0, 1.5]
  };

  /* 供应商预设：baseUrl 只需写到 /v1，适配器会自动补 /chat/completions */
  NS.PRESETS = [
    { id: 'openai',     label: 'OpenAI',            provider: 'openai',    baseUrl: 'https://api.openai.com/v1',                        model: 'gpt-4o-mini',                  keyUrl: 'https://platform.openai.com/api-keys' },
    { id: 'deepseek',   label: 'DeepSeek 深度求索',  provider: 'openai',    baseUrl: 'https://api.deepseek.com/v1',                      model: 'deepseek-chat',                keyUrl: 'https://platform.deepseek.com/api_keys' },
    { id: 'qwen',       label: '阿里通义千问',        provider: 'openai',    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',                   keyUrl: 'https://bailian.console.aliyun.com/' },
    { id: 'moonshot',   label: '月之暗面 Kimi',       provider: 'openai',    baseUrl: 'https://api.moonshot.cn/v1',                       model: 'moonshot-v1-8k',               keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
    { id: 'zhipu',      label: '智谱 GLM',            provider: 'openai',    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',             model: 'glm-4-flash',                  keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
    { id: 'siliconflow',label: '硅基流动',            provider: 'openai',    baseUrl: 'https://api.siliconflow.cn/v1',                    model: 'Qwen/Qwen2.5-7B-Instruct',     keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
    { id: 'openrouter', label: 'OpenRouter',        provider: 'openai',    baseUrl: 'https://openrouter.ai/api/v1',                     model: 'openai/gpt-4o-mini',           keyUrl: 'https://openrouter.ai/keys' },
    { id: 'groq',       label: 'Groq',              provider: 'openai',    baseUrl: 'https://api.groq.com/openai/v1',                   model: 'llama-3.3-70b-versatile',      keyUrl: 'https://console.groq.com/keys' },
    { id: 'ollama',     label: 'Ollama 本地',         provider: 'openai',    baseUrl: 'http://localhost:11434/v1',                        model: 'qwen2.5:7b',                   keyUrl: '' },
    { id: 'lmstudio',   label: 'LM Studio 本地',      provider: 'openai',    baseUrl: 'http://localhost:1234/v1',                         model: 'local-model',                  keyUrl: '' },
    { id: 'anthropic',  label: 'Anthropic Claude',   provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',                     model: 'claude-3-5-haiku-latest',      keyUrl: 'https://console.anthropic.com/settings/keys' },
    { id: 'custom',     label: '自定义 (OpenAI 兼容)', provider: 'openai',    baseUrl: '',                                                 model: '',                             keyUrl: '' }
  ];

  /*
   * script: 用于「已是目标语言则跳过」的脚本判定；
   * rtl: 从右向左书写。
   */
  NS.LANGUAGES = [
    { code: 'zh-CN', name: 'Chinese (Simplified)',  native: '简体中文',       script: 'han',      prompt: 'Simplified Chinese (简体中文)' },
    { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文',       script: 'han',      prompt: 'Traditional Chinese (繁體中文)' },
    { code: 'en',    name: 'English',               native: 'English',        script: 'latin',    prompt: 'English' },
    { code: 'ja',    name: 'Japanese',              native: '日本語',         script: 'kana',     prompt: 'Japanese (日本語)' },
    { code: 'ko',    name: 'Korean',                native: '한국어',         script: 'hangul',   prompt: 'Korean (한국어)' },
    { code: 'fr',    name: 'French',                native: 'Français',       script: 'latin',    prompt: 'French (Français)' },
    { code: 'de',    name: 'German',                native: 'Deutsch',        script: 'latin',    prompt: 'German (Deutsch)' },
    { code: 'es',    name: 'Spanish',               native: 'Español',        script: 'latin',    prompt: 'Spanish (Español)' },
    { code: 'pt',    name: 'Portuguese',            native: 'Português',      script: 'latin',    prompt: 'Portuguese (Português)' },
    { code: 'pt-BR', name: 'Portuguese (Brazil)',   native: 'Português (BR)', script: 'latin',    prompt: 'Brazilian Portuguese (Português do Brasil)' },
    { code: 'ru',    name: 'Russian',               native: 'Русский',        script: 'cyrillic', prompt: 'Russian (Русский)' },
    { code: 'it',    name: 'Italian',               native: 'Italiano',       script: 'latin',    prompt: 'Italian (Italiano)' },
    { code: 'ar',    name: 'Arabic',                native: 'العربية',        script: 'arabic',   prompt: 'Arabic (العربية)', rtl: true },
    { code: 'hi',    name: 'Hindi',                 native: 'हिन्दी',          script: 'devanagari', prompt: 'Hindi (हिन्दी)' },
    { code: 'th',    name: 'Thai',                  native: 'ไทย',            script: 'thai',     prompt: 'Thai (ไทย)' },
    { code: 'vi',    name: 'Vietnamese',            native: 'Tiếng Việt',     script: 'latin',    prompt: 'Vietnamese (Tiếng Việt)' },
    { code: 'id',    name: 'Indonesian',            native: 'Bahasa Indonesia', script: 'latin',  prompt: 'Indonesian (Bahasa Indonesia)' },
    { code: 'ms',    name: 'Malay',                 native: 'Bahasa Melayu',  script: 'latin',    prompt: 'Malay (Bahasa Melayu)' },
    { code: 'tr',    name: 'Turkish',               native: 'Türkçe',         script: 'latin',    prompt: 'Turkish (Türkçe)' },
    { code: 'nl',    name: 'Dutch',                 native: 'Nederlands',     script: 'latin',    prompt: 'Dutch (Nederlands)' },
    { code: 'pl',    name: 'Polish',                native: 'Polski',         script: 'latin',    prompt: 'Polish (Polski)' },
    { code: 'sv',    name: 'Swedish',               native: 'Svenska',        script: 'latin',    prompt: 'Swedish (Svenska)' },
    { code: 'da',    name: 'Danish',                native: 'Dansk',          script: 'latin',    prompt: 'Danish (Dansk)' },
    { code: 'no',    name: 'Norwegian',             native: 'Norsk',          script: 'latin',    prompt: 'Norwegian (Norsk)' },
    { code: 'fi',    name: 'Finnish',               native: 'Suomi',          script: 'latin',    prompt: 'Finnish (Suomi)' },
    { code: 'cs',    name: 'Czech',                 native: 'Čeština',        script: 'latin',    prompt: 'Czech (Čeština)' },
    { code: 'sk',    name: 'Slovak',                native: 'Slovenčina',     script: 'latin',    prompt: 'Slovak (Slovenčina)' },
    { code: 'hu',    name: 'Hungarian',             native: 'Magyar',         script: 'latin',    prompt: 'Hungarian (Magyar)' },
    { code: 'ro',    name: 'Romanian',              native: 'Română',         script: 'latin',    prompt: 'Romanian (Română)' },
    { code: 'bg',    name: 'Bulgarian',             native: 'Български',      script: 'cyrillic', prompt: 'Bulgarian (Български)' },
    { code: 'uk',    name: 'Ukrainian',             native: 'Українська',     script: 'cyrillic', prompt: 'Ukrainian (Українська)' },
    { code: 'el',    name: 'Greek',                 native: 'Ελληνικά',       script: 'greek',    prompt: 'Greek (Ελληνικά)' },
    { code: 'he',    name: 'Hebrew',                native: 'עברית',          script: 'hebrew',   prompt: 'Hebrew (עברית)', rtl: true },
    { code: 'fa',    name: 'Persian',               native: 'فارسی',          script: 'arabic',   prompt: 'Persian (فارسی)', rtl: true },
    { code: 'ur',    name: 'Urdu',                  native: 'اردو',           script: 'arabic',   prompt: 'Urdu (اردو)', rtl: true },
    { code: 'bn',    name: 'Bengali',               native: 'বাংলা',          script: 'bengali',  prompt: 'Bengali (বাংলা)' },
    { code: 'ta',    name: 'Tamil',                 native: 'தமிழ்',          script: 'tamil',    prompt: 'Tamil (தமிழ்)' },
    { code: 'te',    name: 'Telugu',                native: 'తెలుగు',         script: 'telugu',   prompt: 'Telugu (తెలుగు)' },
    { code: 'mr',    name: 'Marathi',               native: 'मराठी',          script: 'devanagari', prompt: 'Marathi (मराठी)' },
    { code: 'gu',    name: 'Gujarati',              native: 'ગુજરાતી',        script: 'gujarati', prompt: 'Gujarati (ગુજરાતી)' },
    { code: 'kn',    name: 'Kannada',               native: 'ಕನ್ನಡ',          script: 'kannada',  prompt: 'Kannada (ಕನ್ನಡ)' },
    { code: 'ml',    name: 'Malayalam',             native: 'മലയാളം',        script: 'malayalam', prompt: 'Malayalam (മലയാളം)' },
    { code: 'pa',    name: 'Punjabi',               native: 'ਪੰਜਾਬੀ',         script: 'gurmukhi', prompt: 'Punjabi (ਪੰਜਾਬੀ)' },
    { code: 'ne',    name: 'Nepali',                native: 'नेपाली',         script: 'devanagari', prompt: 'Nepali (नेपाली)' },
    { code: 'si',    name: 'Sinhala',               native: 'සිංහල',          script: 'sinhala',  prompt: 'Sinhala (සිංහල)' },
    { code: 'my',    name: 'Burmese',               native: 'ဗမာ',            script: 'myanmar',  prompt: 'Burmese (ဗမာ)' },
    { code: 'km',    name: 'Khmer',                 native: 'ខ្មែរ',           script: 'khmer',    prompt: 'Khmer (ខ្មែរ)' },
    { code: 'lo',    name: 'Lao',                   native: 'ລາວ',            script: 'lao',      prompt: 'Lao (ລາວ)' },
    { code: 'ka',    name: 'Georgian',              native: 'ქართული',        script: 'georgian', prompt: 'Georgian (ქართული)' },
    { code: 'hy',    name: 'Armenian',              native: 'Հայերեն',        script: 'armenian', prompt: 'Armenian (Հայերեն)' },
    { code: 'az',    name: 'Azerbaijani',           native: 'Azərbaycan',     script: 'latin',    prompt: 'Azerbaijani (Azərbaycan)' },
    { code: 'kk',    name: 'Kazakh',                native: 'Қазақша',        script: 'cyrillic', prompt: 'Kazakh (Қазақша)' },
    { code: 'uz',    name: 'Uzbek',                 native: "O'zbekcha",      script: 'latin',    prompt: 'Uzbek (O\'zbekcha)' },
    { code: 'mn',    name: 'Mongolian',             native: 'Монгол',         script: 'cyrillic', prompt: 'Mongolian (Монгол)' },
    { code: 'sr',    name: 'Serbian',               native: 'Српски',         script: 'cyrillic', prompt: 'Serbian (Српски)' },
    { code: 'hr',    name: 'Croatian',              native: 'Hrvatski',       script: 'latin',    prompt: 'Croatian (Hrvatski)' },
    { code: 'sl',    name: 'Slovenian',             native: 'Slovenščina',    script: 'latin',    prompt: 'Slovenian (Slovenščina)' },
    { code: 'lt',    name: 'Lithuanian',            native: 'Lietuvių',       script: 'latin',    prompt: 'Lithuanian (Lietuvių)' },
    { code: 'lv',    name: 'Latvian',               native: 'Latviešu',       script: 'latin',    prompt: 'Latvian (Latviešu)' },
    { code: 'et',    name: 'Estonian',              native: 'Eesti',          script: 'latin',    prompt: 'Estonian (Eesti)' },
    { code: 'is',    name: 'Icelandic',             native: 'Íslenska',       script: 'latin',    prompt: 'Icelandic (Íslenska)' },
    { code: 'ca',    name: 'Catalan',               native: 'Català',         script: 'latin',    prompt: 'Catalan (Català)' },
    { code: 'gl',    name: 'Galician',              native: 'Galego',         script: 'latin',    prompt: 'Galician (Galego)' },
    { code: 'eu',    name: 'Basque',                native: 'Euskara',        script: 'latin',    prompt: 'Basque (Euskara)' },
    { code: 'af',    name: 'Afrikaans',             native: 'Afrikaans',      script: 'latin',    prompt: 'Afrikaans' },
    { code: 'sw',    name: 'Swahili',               native: 'Kiswahili',      script: 'latin',    prompt: 'Swahili (Kiswahili)' },
    { code: 'am',    name: 'Amharic',               native: 'አማርኛ',          script: 'ethiopic', prompt: 'Amharic (አማርኛ)' },
    { code: 'yo',    name: 'Yoruba',                native: 'Yorùbá',         script: 'latin',    prompt: 'Yoruba (Yorùbá)' },
    { code: 'zu',    name: 'Zulu',                  native: 'isiZulu',        script: 'latin',    prompt: 'Zulu (isiZulu)' },
    { code: 'fil',   name: 'Filipino',              native: 'Filipino',       script: 'latin',    prompt: 'Filipino' },
    { code: 'la',    name: 'Latin',                 native: 'Latina',         script: 'latin',    prompt: 'Latin (Latina)' },
    { code: 'eo',    name: 'Esperanto',             native: 'Esperanto',      script: 'latin',    prompt: 'Esperanto' }
  ];

  NS.LANG_MAP = Object.create(null);
  for (const l of NS.LANGUAGES) NS.LANG_MAP[l.code] = l;

  NS.langName = function (code, forPrompt) {
    const l = NS.LANG_MAP[code];
    if (!l) return code;
    return forPrompt ? (l.prompt || l.name) : l.name;
  };

  /* 自动翻译模式下动态注册内容脚本时使用的文件顺序 */
  NS.CONTENT_FILES = [
    'src/shared/constants.js',
    'src/shared/util.js',
    'src/shared/settings.js',
    'src/content/extract.js',
    'src/content/render.js',
    'src/content/content.js'
  ];
})();
