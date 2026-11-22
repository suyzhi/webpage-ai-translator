/*
 * AI 网页翻译 — 零构建静态类型声明（仅用于 tsc --noEmit 与 IDE 智能提示，不参与运行时加载）。
 */

declare function importScripts(...urls: string[]): void;

declare namespace chrome {
  namespace storage {
    interface StorageChange {
      oldValue?: any;
      newValue?: any;
    }
    interface StorageArea {
      get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const onChanged: {
      addListener(cb: (changes: Record<string, StorageChange>, areaName: string) => void): void;
    };
  }

  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab;
      frameId?: number;
      url?: string;
    }
    interface Port {
      name: string;
      sender?: MessageSender;
      postMessage(message: any): void;
      disconnect(): void;
      onMessage: {
        addListener(cb: (msg: any) => void): void;
        removeListener(cb: (msg: any) => void): void;
      };
      onDisconnect: {
        addListener(cb: () => void): void;
        removeListener(cb: () => void): void;
      };
    }
    const lastError: { message?: string } | undefined;
    function connect(connectInfo?: { name?: string }): Port;
    function sendMessage(message: any): Promise<any>;
    function openOptionsPage(): Promise<void>;
    function getPlatformInfo(cb: (info: any) => void): void;
    const onMessage: {
      addListener(cb: (msg: any, sender: MessageSender, sendResponse: (resp?: any) => void) => boolean | void): void;
    };
    const onConnect: {
      addListener(cb: (port: Port) => void): void;
    };
    const onInstalled: {
      addListener(cb: (details: { reason?: string }) => void): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }
    function get(tabId: number): Promise<Tab>;
    function query(queryInfo: Record<string, any>, cb?: (tabs: Tab[]) => void): Promise<Tab[]>;
    function create(createProperties: { url: string }): Promise<Tab>;
    function sendMessage(tabId: number, message: any, options?: { frameId?: number }, cb?: (resp: any) => void): Promise<any>;
  }

  namespace scripting {
    function executeScript(injection: {
      target: { tabId: number; allFrames?: boolean };
      files?: string[];
      injectImmediately?: boolean;
    }): Promise<any[]>;
    function registerContentScripts(scripts: Array<{
      id: string;
      js: string[];
      matches: string[];
      excludeMatches?: string[];
      runAt?: string;
      allFrames?: boolean;
      persistAcrossSessions?: boolean;
    }>): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  }

  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): void;
    function setBadgeBackgroundColor(details: { tabId?: number; color: string }): void;
  }

  namespace commands {
    interface Command {
      name?: string;
      shortcut?: string;
      description?: string;
    }
    function getAll(cb: (commands: Command[]) => void): void;
    const onCommand: {
      addListener(cb: (command: string) => void): void;
    };
  }

  namespace contextMenus {
    function removeAll(cb?: () => void): void;
    function create(props: { id: string; title: string; contexts: string[] }): void;
    const onClicked: {
      addListener(cb: (info: { menuItemId: string }, tab?: tabs.Tab) => void): void;
    };
  }

  namespace i18n {
    function detectLanguage(
      text: string,
      cb: (result: { isReliable: boolean; languages: Array<{ language: string; percentage: number }> }) => void
    ): void;
  }

  namespace dom {
    function openOrClosedShadowRoot(el: Element): ShadowRoot | null;
  }
}

type WptSiteRule = 'always' | 'never';
type WptSiteRules = Record<string, WptSiteRule>;
type WptStatus = 'idle' | 'scanning' | 'translating' | 'done' | 'error';

interface WptError extends Error {
  status?: number;
  detail?: string;
  badModel?: boolean;
  retryable?: boolean;
  fatal?: boolean;
  split?: boolean;
  retryAfterMs?: number;
  url?: string;
  network?: boolean;
  malformed?: boolean;
  aborted?: boolean;
}

interface WptUsage {
  input: number;
  output: number;
  cached: number;
  requests?: number;
  since?: number;
}

interface WptSettings {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  targetLang: string;
  sourceLang: string;
  displayMode: 'bilingual' | 'translation';
  markStyle: 'none' | 'underline' | 'border' | 'background' | 'dim';
  skipTargetLang: boolean;
  translateTitle: boolean;
  minTextLength: number;
  customPrompt: string;
  lazyTranslate: boolean;
  pageGlossary: boolean;
  concurrency: number;
  batchChars: number;
  batchItems: number;
  firstBatchChars: number;
  maxRetries: number;
  timeoutMs: number;
  useCache: boolean;
  cacheMaxEntries: number;
  autoTranslate: boolean;
  siteRules: WptSiteRules;
  animations: boolean;
  settingsRev?: number;
}

interface WptContentConfig {
  targetLang: string;
  sourceLang: string;
  minTextLength: number;
  displayMode: 'bilingual' | 'translation';
  markStyle: 'none' | 'underline' | 'border' | 'background' | 'dim';
  skipTargetLang: boolean;
  translateTitle: boolean;
  pageGlossary: boolean;
  animations: boolean;
}

interface WptPreset {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  keyUrl: string;
}

interface WptLanguage {
  code: string;
  name: string;
  native: string;
  script: string;
  prompt: string;
  rtl?: boolean;
}

interface WptPlan {
  mode: 'end' | 'sibling' | 'anchor' | 'inline' | 'after';
  target: Element;
  typo?: Element | null;
  only?: boolean;
  nav?: boolean;
  [k: string]: any;
}

interface WptUnit {
  id: number;
  el: Element | null;
  text: string;
  kind: 'full' | 'partial';
  anchorNode: Node | null;
  nodes?: Node[];
  isTitle?: boolean;
  dead?: boolean;
  same?: boolean;
  visible?: boolean;
  plan?: WptPlan | null;
  clipFallback?: boolean;
  hidden?: any;
  loader?: HTMLElement | null;
  reinserts?: number;
}

interface WptUnitList extends Array<WptUnit> {
  shadowRoots?: ShadowRoot[];
  hiddenEls?: Element[];
}

interface WptToastAction {
  label: string;
  run: () => void;
}

interface WptToastOptions {
  kind?: 'busy' | 'ok' | 'err';
  duration?: number;
  sub?: string;
  progress?: number;
  actions?: WptToastAction[];
}

interface WptToastApi {
  show(msg: string, opts?: WptToastOptions): void;
  hide(): void;
}

interface WptPlainTextApi {
  prepare(): HTMLElement | null;
  teardown(): boolean;
  root(): HTMLElement | null;
}

interface WptFramesDeps {
  isChild: boolean;
  getStatus(): WptStatus;
  getOverrides(): Partial<WptSettings> | null;
  getTranslatedCount(): number;
  getShadowRoots(): Set<ShadowRoot>;
  waitBodyReady(): Promise<void>;
  onStart(overrides: Partial<WptSettings> | null): void;
  onRestore(): void;
  onStop(): void;
}

interface WptFramesApi {
  notify(action: 'start' | 'restore' | 'stop'): Promise<any>;
  reportStatus(isActive: boolean): void;
  hasCandidates(): boolean;
  waitForActive(frameTask: Promise<any>): Promise<void>;
  watch(root: Document | Element | ShadowRoot | null | undefined): void;
  handleMessage(msg: any): boolean;
  isActive(): boolean;
  translatedCount(): number;
  hasAny(): boolean;
  reset(): boolean;
}

interface WptObserverDeps {
  getStatus(): WptStatus;
  getSettings(): WptSettings | null;
  hasUnitElement(el: Element): boolean;
  getUnitByElement(el: Element): WptUnit | null;
  isKnownElement(el: Element): boolean;
  markKnownElement(el: Element): void;
  removeUnit(u: WptUnit): void;
  onNodeRemoved(node: HTMLElement): void;
  onNewFrameRoot(root: Element | ShadowRoot): void;
  onLazyScroll(): void;
  collect(root: Element, cfg: WptContentConfig): WptUnitList;
  filterLanguage(units: WptUnit[], settings: WptSettings): Promise<WptUnit[]>;
  onDeltaUnits(units: WptUnit[]): void;
}

interface WptObserverApi {
  start(): void;
  stop(): void;
  reset(): void;
  observeShadows(roots: ShadowRoot[] | null | undefined): void;
  trackHidden(list: Element[] | null | undefined): void;
  discardOwn(): void;
  getShadowRoots(): Set<ShadowRoot>;
}

interface WptRenderQueueDeps {
  isChild: boolean;
  getSettings(): WptSettings | null;
  getStatus(): WptStatus;
  onlyTranslation(): boolean;
  getUnit(id: number): WptUnit | undefined;
  getNode(id: number): HTMLElement | undefined;
  setNode(id: number, node: HTMLElement, u: WptUnit): void;
  deleteNode(id: number): void;
  getUnitByNode(node: HTMLElement): WptUnit | null;
  nodeCount(): number;
  removeLoader(u: WptUnit): void;
  unobserveIO(el: Element): void;
  discardOwnMutations(): void;
  onChildRendered(): void;
  onProgress(): void;
  timed<F extends (...args: any[]) => any>(key: 'renderMax' | 'clipMax' | 'collectMax', fn: F): F;
}

interface WptRenderQueueApi {
  push(entry: [number, string, HTMLElement?]): void;
  schedule(): void;
  captureHScroll(): void;
  scheduleRelayout(): void;
  reset(): void;
  dropped(): number;
  dropLog(): string[];
}

interface WptContentState {
  status: WptStatus;
  settings: WptSettings | null;
  overrides: Partial<WptSettings> | null;
  byId: Map<number, WptUnit>;
  elUnit: WeakMap<Element, WptUnit>;
  nodeUnit: WeakMap<HTMLElement, WptUnit>;
  nodes: Map<number, HTMLElement>;
  pending: Set<number>;
  lazy: Set<number>;
  sent: Set<number>;
  failedIds: Set<number>;
  knownEls: WeakSet<Element>;
  total: number;
  cached: number;
  error: string | null;
  seq: number;
  port: chrome.runtime.Port | null;
  heartbeat: any;
  reconnectTries: number;
  io: IntersectionObserver | null;
  nearIO: IntersectionObserver | null;
  armTimer: any;
  starting: boolean;
  autoRun: boolean;
  announce: boolean;
  memo: Map<string, string | null>;
  memoSig: string;
  usage: WptUsage;
  originalTitle: string | null;
  lastStats: any;
}

interface WptSiteRulesApi {
  normalizeHost(input: string | null | undefined): string;
  normalizeSiteRules(raw: unknown): WptSiteRules;
  matchSiteRule(host: string | null | undefined, rules: WptSiteRules | null | undefined): { host: string; rule: WptSiteRule } | null;
  siteRuleFor(host: string | null | undefined, rules: WptSiteRules | null | undefined): WptSiteRule | null;
  autoStartFor(settings: Partial<WptSettings> | null | undefined, host: string | null | undefined): boolean;
  autoRegistrationFor(settings: Partial<WptSettings> | null | undefined): { matches: string[]; excludeMatches?: string[] } | null;
}

interface WptConcurrencyApi {
  runPool<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>,
    opts?: { signal?: AbortSignal; onError?: (err: any, item: T, index: number) => void }
  ): Promise<void>;
  Limiter: new (max: number) => any;
  LRUCache: new <K = any, V = any>(max?: number) => any;
}

interface WptUtilApi extends WptSiteRulesApi, WptConcurrencyApi {
  clamp(n: number, lo: number, hi: number): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  abortError(msg?: string): Error & { aborted: boolean };
  isAbort(e: any): boolean;
  backoff(attempt: number, base?: number, cap?: number): number;
  normalizeText(text: any): string;
  visualLength(text: any): number;
  hashText(text: any): string;
  escapeXml(s: any): string;
  unescapeXml(s: any): string;
  protectTokens(text: any): { text: string; tokens: string[] };
  restoreTokens(text: any, tokens: string[]): string;
  ensureTokensPreserved(sourceProtected: string, translated: string, tokens: string[]): string;
  scriptCounts(text: any): Record<string, number>;
  isProbablyTargetLang(text: any, langCode: string): boolean;
  hasTargetScript(text: any, langCode: string): boolean;
  isTrivialLabel(s: string): boolean;
  pickTerms(texts: string[], n: number, minUnits?: number): Array<{ term: string; sample: string; units: number }>;
  isTranslatable(text: any, settings?: Partial<WptContentConfig> | null, preNormalized?: boolean): boolean;
  sameText(a: any, b: any): boolean;
  baseLang(code: any): string;
  planBatches<T extends { text?: string; cost?: number }>(
    items: T[],
    opts?: { maxChars?: number; maxItems?: number; firstBatchChars?: number }
  ): T[][];
  joinUrl(base: any, suffix: string): string;
  isLocalUrl(url: any): boolean;
  fmtTokens(n: number | null | undefined): string;
  truncate(s: any, n: number): string;
  describeError(err: any): string;
}

interface WptNamespace {
  CONST_READY?: boolean;
  VERSION: string;
  PORT_NAME: string;
  SETTINGS_KEY: string;
  CACHE_PREFIX: string;
  CACHE_META_KEY: string;
  USAGE_KEY: string;
  SETTINGS_REV: number;
  SITE_RULES_MAX: number;
  MSG: {
    PING: string;
    START: string;
    RESTORE: string;
    STOP: string;
    READY: string;
    RESULTS: string;
    PROGRESS: string;
    DONE: string;
    ERROR: string;
    CACHE_CLEAR: string;
    CACHE_STATS: string;
    TEST_CONNECTION: string;
    INJECT: string;
    TOGGLE: string;
    NOTIFY: string;
    USAGE: string;
    USAGE_RESET: string;
    STATE: string;
    STATE_CHANGED: string;
    FRAMES: string;
    FRAME_CMD: string;
    FRAME_STATUS: string;
    OPEN_OPTIONS: string;
  };
  STATUS: {
    IDLE: 'idle';
    SCANNING: 'scanning';
    TRANSLATING: 'translating';
    DONE: 'done';
    ERROR: 'error';
  };
  DEFAULT_SETTINGS: WptSettings;
  LIMITS: Record<string, [number, number]>;
  PRESETS: WptPreset[];
  LANGUAGES: WptLanguage[];
  LANG_MAP: Record<string, WptLanguage>;
  CONTENT_FILES: string[];
  isReasoningModel(model: any): boolean;
  langName(code: string, forPrompt?: boolean): string;
  util: WptUtilApi;
  siteRules: WptSiteRulesApi;
  concurrency: WptConcurrencyApi;
  settings: {
    get(): Promise<WptSettings>;
    set(patch: Partial<WptSettings>): Promise<WptSettings>;
    setSiteRule(host: string, rule: string): Promise<WptSettings>;
    reset(): Promise<WptSettings>;
    normalize(raw: any): WptSettings;
    onChange(cb: (s: WptSettings) => void): void;
    forContent(s: WptSettings): WptContentConfig;
  };
  prompt: any;
  providers: any;
  TranslationCache: any;
  Engine: any;
  Extractor: any;
  Renderer: any;
  Toast: { create(disabled?: boolean): WptToastApi };
  PlainText: { create(isChild: boolean): WptPlainTextApi };
  Frames: { create(deps: WptFramesDeps): WptFramesApi };
  Observer: { create(deps: WptObserverDeps): WptObserverApi };
  RenderQueue: { create(deps: WptRenderQueueDeps): WptRenderQueueApi; nextFrame(fn: () => void, hiddenDelay?: number): () => void };
  Content: any;
}

declare var WPT: WptNamespace;
