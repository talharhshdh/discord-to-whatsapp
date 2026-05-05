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
};
