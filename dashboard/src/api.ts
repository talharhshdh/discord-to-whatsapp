/** Typed API client — all API calls use relative URLs ("/api/...").
 *
 * The React build is served statically by the same dashboard-server that
 * handles all /api/* routes. Both are exposed through the same Cloudflare
 * tunnel, so the browser always hits the right origin — no base URL config needed.
 */
export const BASE = '';
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('dashboard_token');
  return token ? { 'Authorization': `Basic ${token}` } : {};
}

function authFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      ...getAuthHeaders()
    }
  });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      ...getAuthHeaders()
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { 
    method: 'POST', 
    headers: getAuthHeaders(),
    body: form 
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function postBinary(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      ...getAuthHeaders()
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function postFormBinary(path: string, form: FormData): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, { 
    method: 'POST', 
    headers: getAuthHeaders(),
    body: form 
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}


// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolUrl {
  label: string; url: string; username?: string; password?: string; registeredAt: string;
}
export interface UrlsPayload {
  sessionStartedAt: string;
  sessionRemainingSeconds: number;
  tools: Record<string, ToolUrl>;
}
export interface SessionResult {
  url?: string; username?: string; password?: string; error?: string;
}
export interface BrowserSearchResult {
  organic: { title: string; link: string; snippet: string; displayedLink?: string; favicon?: string }[];
  aiResponse: string | null;
  featuredSnippet?: { title: string; link: string; snippet: string } | null;
  knowledgePanel?: {
    title: string;
    subtitle?: string;
    description?: string;
    sourceUrl?: string;
    attributes?: { label: string; value: string }[];
  } | null;
  peopleAlsoAsk?: { question: string; answer?: string; sourceTitle?: string; sourceUrl?: string }[];
  directAnswer?: { type: string; answer: string; details?: string } | null;
  news?: { title: string; source: string; time: string; link: string }[];
  videos?: { title: string; source: string; duration?: string; uploadedAt?: string; link: string }[];
  images?: { alt: string; sourceUrl: string; imageUrl?: string }[];
  shopping?: { title: string; price: string; merchant: string; rating?: string; link: string }[];
  relatedSearches?: string[];
  localResults?: { title: string; rating?: string; reviewsCount?: string; address?: string; phone?: string; link?: string }[];
}

export interface YtSearchResult {
  videoId: string; url: string; title: string; thumbnail: string;
  duration: string; views: number; ago: string; author: string;
}
export interface YtQuality {
  key: string; label: string; sizeBytes: number | null;
  audioOnly: boolean; formatId: string; audioFormatId?: string;
}
export interface YtVideoInfo {
  videoId: string; url: string; title: string; thumbnail: string;
  durationSeconds: number; uploader: string; viewCount: number; qualities: YtQuality[];
}
export interface YtDownloadJob {
  id: string;
  url: string;
  qualityKey: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  progress: number;
  message: string;
  downloadUrl?: string;
  error?: string;
  title?: string;
}
// ── TTS Types ───────────────────────────────────────────────────────────────

export interface TTSVoice {
  id: string;
  label: string;
  engine: string;
  gender: string;
  tone: string;
}

export interface TTSStatus {
  running: boolean;
  model_loaded: boolean;
  loading: boolean;
  error?: string;
}

export interface MovieResult {
  tmdbId: number; title: string; overview: string; posterUrl: string;
  mediaType: string; releaseDate: string; voteAverage: number; watchUrl: string;
}

// ── Places Types ─────────────────────────────────────────────────────────────

export interface PlaceResult {
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  category: string | null;
  openNow: boolean | null;
  todaysHours: string | null;
  openStatus: string | null;
  weeklyHours: Record<string, string> | null;
  description: string | null;
  photosCount: number | null;
  mapsUrl: string | null;
  placeId: string | null;
  lat: number | null;
  lng: number | null;
  hasPopularTimes: boolean;
  isClaimed: boolean | null;
  amenities: string[];
  relatedPlaces: string[];
}

export interface PlacesBatchEvent {
  type: 'batch' | 'progress' | 'done' | 'error';
  cards?: PlaceResult[];
  total?: number;
  round?: number;
  reachedEnd?: boolean;
  message?: string;
}

export interface PlacesSearchResult {
  query: string;
  page: number;
  results: PlaceResult[];
  hasNextPage: boolean;
  totalResultsText: string | null;
}

// ── LLM Types ───────────────────────────────────────────────────────────────

export interface LLMModelInfo {
  id: string;
  label: string;
  description: string;
  size_gb: number;
  tags: string[];
  ctx: number;
  downloaded: boolean;
  loaded: boolean;
  download_status: 'not_downloaded' | 'downloading' | 'ready' | 'error';
  download_error?: string;
}

export interface LLMModelsResponse {
  models: LLMModelInfo[];
  current_model: string | null;
  models_dir: string;
}

export interface LLMStatus {
  loaded: boolean;
  model_id: string | null;
  label: string | null;
  ctx: number | null;
  server_running: boolean;
}

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatResponse {
  content: string;
  model_id: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── API ─────────────────────────────────────────────────────────────────────

export const api = {
  login: (username: string, password: string) =>
    post<{ success: boolean; token: string }>('/api/auth/login', { username, password }),

  getUrls: () => authFetch(`${BASE}/api/urls`).then(r => r.json()) as Promise<UrlsPayload>,

  startTerminal: () => post<SessionResult>('/api/sessions/terminal', {}),
  startVSCode: () => post<SessionResult>('/api/sessions/vscode', {}),
  startBrowser: () => post<SessionResult>('/api/sessions/browser', {}),

  removeBg: (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    return postFormBinary('/api/ai/remove-bg', fd);
  },
  ocr: (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    return postForm<{ text: string }>('/api/ai/ocr', fd);
  },
  transcribe: (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    return postForm<{ text: string }>('/api/ai/transcribe', fd);
  },
  screenshot: (url: string, fullPage: boolean) =>
    postBinary('/api/ai/screenshot', { url, fullPage, format: 'png' }),
  extractHtml: (html: string) =>
    post<{ content: string }>('/api/ai/extract-html', { html }),

  downloadMedia: (url: string) =>
    postBinary('/api/media/download', { url }),

  ytSearch: (query: string) =>
    post<{ results: YtSearchResult[] }>('/api/youtube/search', { query }),
  ytInfo: (url: string) =>
    post<YtVideoInfo>('/api/youtube/info', { url }),
  ytDownload: (url: string, quality?: YtQuality) =>
    postBinary('/api/youtube/download', { url, quality }),
  ytDownloadJob: (url: string, quality?: YtQuality) =>
    post<{ jobId: string }>('/api/youtube/download-job', { url, quality }),
  ytJobStatus: (jobId: string) =>
    authFetch(`${BASE}/api/youtube/job-status?id=${encodeURIComponent(jobId)}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<YtDownloadJob>;
    }),

  movieSearch: (query: string) =>
    post<{ results: MovieResult[] }>('/api/movies/search', { query }),

  androidStart: () => post<{ success: boolean; message: string; webUrl?: string; error?: string }>('/api/android/start', {}),
  androidStatus: () => post<{ running: boolean; uptime?: string; deviceInfo?: string; webUrl?: string }>('/api/android/status', {}),
  androidStop: () => post<{ success: boolean; message: string }>('/api/android/stop', {}),

  exportYtCookies: () =>
    post<{ success: boolean; message: string; cookiesPath?: string }>('/api/browser/export-cookies', {}),

  browserSearch: (text: string, pageNumber: number, engine: 'auto' | 'cdp' | 'selenium' = 'auto', includeAI = false) =>
    post<BrowserSearchResult>('/api/browser/search', { text, pageNumber, engine, includeAI }),
  restartBrowsers: () =>
    post<{ ok: boolean; message: string }>('/api/browsers/restart', {}),
  placesSearch: (query: string, pageNumber = 1, deepScrape = false) =>
    post<PlacesSearchResult>('/api/browser/places', { query, pageNumber, deepScrape }),

  /**
   * Opens an SSE connection to /api/browser/places/stream.
   * Calls `onBatch` each time a new scroll round reveals more cards.
   * Calls `onDone` when all cards are loaded.
   * Calls `onError` on failure.
   * Returns the EventSource so the caller can close it.
   */
  placesStream: (
    query: string,
    onBatch: (cards: PlaceResult[], total: number, round: number) => void,
    onDone: (total: number, reachedEnd: boolean) => void,
    onError: (message: string) => void,
  ): EventSource => {
    const token = localStorage.getItem('dashboard_token') || '';
    const es = new EventSource(`${BASE}/api/browser/places/stream?query=${encodeURIComponent(query)}&token=${encodeURIComponent(token)}`);
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as PlacesBatchEvent;
        if (event.type === 'batch' && event.cards) {
          onBatch(event.cards, event.total ?? 0, event.round ?? 0);
        } else if (event.type === 'done') {
          onDone(event.total ?? 0, event.reachedEnd ?? false);
          es.close();
        } else if (event.type === 'error') {
          onError(event.message ?? 'Unknown error');
          es.close();
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => { onError('Stream connection lost'); es.close(); };
    return es;
  },

  /** Single page via Google Search (udm=1) URL pattern. */
  googleSearchPlaces: (query: string, pageNumber = 1) =>
    post<PlacesSearchResult>('/api/browser/places/google-search', { query, pageNumber }),

  /**
   * SSE stream via Google Search (udm=1) — iterates pages automatically.
   * Calls onBatch per page, onDone when all maxPages are done or last page reached.
   */
  googleSearchPlacesStream: (
    query: string,
    onBatch: (cards: PlaceResult[], total: number, page: number) => void,
    onDone: (total: number, reachedEnd: boolean) => void,
    onError: (message: string) => void,
    maxPages = 10,
  ): EventSource => {
    const token = localStorage.getItem('dashboard_token') || '';
    const es = new EventSource(
      `${BASE}/api/browser/places/google-search/stream?query=${encodeURIComponent(query)}&maxPages=${maxPages}&token=${encodeURIComponent(token)}`,
    );
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as PlacesBatchEvent;
        if (event.type === 'batch' && event.cards) {
          onBatch(event.cards, event.total ?? 0, event.round ?? 0);
        } else if (event.type === 'done') {
          onDone(event.total ?? 0, event.reachedEnd ?? false);
          es.close();
        } else if (event.type === 'error') {
          onError(event.message ?? 'Unknown error');
          es.close();
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => { onError('Stream connection lost'); es.close(); };
    return es;
  },


  // ── LLM ───────────────────────────────────────────────────────────────────
  llmModels: () => authFetch(`${BASE}/api/llm/models`).then(r => {
    if (!r.ok) return r.json().then((e: { error: string }) => { throw new Error(e.error); });
    return r.json() as Promise<LLMModelsResponse>;
  }),
  llmStatus: () => authFetch(`${BASE}/api/llm/status`).then(r => r.json()) as Promise<LLMStatus>,
  llmDownload: (model_id: string) =>
    post<{ message: string; status: string }>('/api/llm/download', { model_id }),
  llmDownloadStatus: (model_id: string) =>
    authFetch(`${BASE}/api/llm/download/status/${model_id}`).then(r => r.json()) as Promise<{ status: string; downloaded: boolean; error?: string }>,
  llmLoad: (model_id: string) =>
    post<{ loaded: boolean; model_id: string; label: string }>('/api/llm/load', { model_id }),
  llmUnload: () =>
    post<{ unloaded: boolean; was: string | null }>('/api/llm/unload', {}),
  llmChat: (messages: LLMChatMessage[], max_tokens = 512, temperature = 0.7) =>
    post<LLMChatResponse>('/api/llm/chat', { messages, max_tokens, temperature }),
  llmDelete: (model_id: string) =>
    authFetch(`${BASE}/api/llm/models/${model_id}`, { method: 'DELETE' }).then(r => {
      if (!r.ok) return r.json().then((e: { detail: string }) => { throw new Error(e.detail); });
      return r.json() as Promise<{ deleted: boolean }>;
    }),

  // ── TTS ───────────────────────────────────────────────────────────────────
  ttsStatus: () => authFetch(`${BASE}/api/tts/status`).then(r => r.json()) as Promise<TTSStatus>,
  ttsVoices: () => authFetch(`${BASE}/api/tts/voices`).then(r => r.json()) as Promise<{ voices: TTSVoice[] }>,

  ttsGenerate: (text: string, voice: string, language: string = 'Auto', instruct: string = '', engine: string = 'qwen') =>
    postBinary('/api/tts/generate', { text, speaker: voice, language, instruct, engine }),

  ttsClone: (text: string, referenceAudio: File, refText: string, language: string = 'Auto') => {
    const fd = new FormData();
    fd.append('text', text);
    fd.append('reference_audio', referenceAudio);
    fd.append('ref_text', refText);
    fd.append('language', language);
    return postFormBinary('/api/tts/clone', fd);
  },

  ttsDesign: (text: string, style: string, language: string = 'Auto') =>
    postBinary('/api/tts/design', { text, style, language }),
};
