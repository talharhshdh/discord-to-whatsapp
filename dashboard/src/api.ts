/** Typed API client — all API calls use relative URLs ("/api/...").
 *
 * The React build is served statically by the same dashboard-server that
 * handles all /api/* routes. Both are exposed through the same Cloudflare
 * tunnel, so the browser always hits the right origin — no base URL config needed.
 */
const BASE = '';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: form });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function postBinary(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function postFormBinary(path: string, form: FormData): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: form });
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
  organic: { title: string; link: string; snippet: string }[];
  aiResponse: string | null;
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
export interface MovieResult {
  tmdbId: number; title: string; overview: string; posterUrl: string;
  mediaType: string; releaseDate: string; voteAverage: number; watchUrl: string;
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
  getUrls: () => fetch('/api/urls').then(r => r.json()) as Promise<UrlsPayload>,

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

  movieSearch: (query: string) =>
    post<{ results: MovieResult[] }>('/api/movies/search', { query }),

  androidStart: () => post<{ success: boolean; message: string; webUrl?: string; error?: string }>('/api/android/start', {}),
  androidStatus: () => post<{ running: boolean; uptime?: string; deviceInfo?: string; webUrl?: string }>('/api/android/status', {}),
  androidStop: () => post<{ success: boolean; message: string }>('/api/android/stop', {}),

  exportYtCookies: () =>
    post<{ success: boolean; message: string; cookiesPath?: string }>('/api/browser/export-cookies', {}),

  browserSearch: (text: string, pageNumber: number) =>
    post<BrowserSearchResult>('/api/browser/search', { text, pageNumber }),

  // ── LLM ───────────────────────────────────────────────────────────────────
  llmModels: () => fetch('/api/llm/models').then(r => {
    if (!r.ok) return r.json().then((e: { error: string }) => { throw new Error(e.error); });
    return r.json() as Promise<LLMModelsResponse>;
  }),
  llmStatus: () => fetch('/api/llm/status').then(r => r.json()) as Promise<LLMStatus>,
  llmDownload: (model_id: string) =>
    post<{ message: string; status: string }>('/api/llm/download', { model_id }),
  llmDownloadStatus: (model_id: string) =>
    fetch(`/api/llm/download/status/${model_id}`).then(r => r.json()) as Promise<{ status: string; downloaded: boolean; error?: string }>,
  llmLoad: (model_id: string) =>
    post<{ loaded: boolean; model_id: string; label: string }>('/api/llm/load', { model_id }),
  llmUnload: () =>
    post<{ unloaded: boolean; was: string | null }>('/api/llm/unload', {}),
  llmChat: (messages: LLMChatMessage[], max_tokens = 512, temperature = 0.7) =>
    post<LLMChatResponse>('/api/llm/chat', { messages, max_tokens, temperature }),
  llmDelete: (model_id: string) =>
    fetch(`/api/llm/models/${model_id}`, { method: 'DELETE' }).then(r => {
      if (!r.ok) return r.json().then((e: { detail: string }) => { throw new Error(e.detail); });
      return r.json() as Promise<{ deleted: boolean }>;
    }),
};
