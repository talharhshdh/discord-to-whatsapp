/**
 * @file dashboard-server.ts
 * @description Full-featured HTTP control-panel server.
 *
 * Exposes REST API endpoints for every bot capability and serves a
 * Tailwind-based SPA at GET /.  Also manages a shared URL registry so
 * callers can register/query live Cloudflare tunnel URLs.
 *
 * API surface:
 *  GET  /api/urls                          → registered tunnel URL registry
 *  POST /api/sessions/terminal             → start a new ttyd terminal session
 *  POST /api/sessions/vscode               → start a new code-server session
 *  POST /api/sessions/browser              → start a new cloud browser session
 *  POST /api/ai/remove-bg (multipart)      → remove background from image
 *  POST /api/ai/ocr       (multipart)      → OCR text from image
 *  POST /api/ai/screenshot                 → screenshot a URL
 *  POST /api/ai/transcribe (multipart)     → transcribe audio with Whisper
 *  POST /api/media/download                → download media from any supported URL
 *  POST /api/youtube/search                → search YouTube
 *  POST /api/youtube/info                  → get video info + quality options
 *  POST /api/youtube/download              → download YouTube video
 *  POST /api/movies/search                 → search movies (TMDB)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { startTerminal } from './terminal';
import {
  llmListModels, llmDownloadModel, llmDownloadStatus,
  llmLoadModel, llmUnloadModel, llmStatus, llmChat, llmDeleteModel,
  isLLMServerRunning,
} from './llm-manager';
import { startVSCode } from './vscode';
import { startBrowser } from './browser';
import { exportYouTubeCookies } from './browser';
import { detectAndDownload } from './downloader';
import { searchYouTube, getYouTubeInfo, downloadYouTubeVideo, downloadYouTubeVideoFallback } from './youtube-dl';
import { searchMovies } from './movie-search';
import type { YouTubeQualityOption } from './youtube-dl';

// ── URL Registry ─────────────────────────────────────────────────────────────

export interface ToolUrlEntry {
  label: string;
  url: string;
  username?: string;
  password?: string;
  registeredAt: string;
}

const urlRegistry: Record<string, ToolUrlEntry> = {};
const SESSION_START_MS = Date.now();
const SESSION_DURATION_S = 5 * 60 * 60;

export function registerUrl(
  key: string,
  label: string,
  url: string,
  meta: { username?: string; password?: string } = {}
): void {
  urlRegistry[key] = { label, url, username: meta.username, password: meta.password, registeredAt: new Date().toISOString() };
}

export function getAllUrls(): Record<string, ToolUrlEntry> {
  return { ...urlRegistry };
}

// ── Multipart body parser (no external deps) ──────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf-8')) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Minimal multipart/form-data parser.
 * Returns { fields: Record<string,string>, files: Record<string,{buffer,filename,mimeType}> }
 */
function parseMultipart(body: Buffer, contentType: string): {
  fields: Record<string, string>;
  files: Record<string, { buffer: Buffer; filename: string; mimeType: string }>;
} {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return { fields: {}, files: {} };
  const boundary = '--' + boundaryMatch[1];
  const fields: Record<string, string> = {};
  const files: Record<string, { buffer: Buffer; filename: string; mimeType: string }> = {};

  const boundaryBuf = Buffer.from('\r\n' + boundary);
  const parts: Buffer[] = [];
  let start = body.indexOf(Buffer.from(boundary + '\r\n'));
  if (start < 0) return { fields, files };
  start += boundary.length + 2;

  while (start < body.length) {
    const end = body.indexOf(boundaryBuf, start);
    if (end < 0) break;
    parts.push(body.slice(start, end));
    start = end + boundaryBuf.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    start += 2; // skip \r\n
  }

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const partBody = part.slice(headerEnd + 4);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]*)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    if (!nameMatch) continue;
    const name = nameMatch[1];

    if (filenameMatch) {
      files[name] = {
        buffer: partBody,
        filename: filenameMatch[1],
        mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
      };
    } else {
      fields[name] = partBody.toString('utf-8');
    }
  }

  return { fields, files };
}

// ── Python API proxy helpers ──────────────────────────────────────────────────

const PYTHON_API = 'http://127.0.0.1:8000';

async function callPythonRemoveBg(imageBuffer: Buffer, filename: string, mimeType: string): Promise<Buffer> {
  const boundary = 'dashboundary' + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageBuffer, footer]);

  const resp = await fetch(`${PYTHON_API}/remove_bg`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body as unknown as BodyInit,
  });
  if (!resp.ok) throw new Error(`Python API /remove_bg → HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function callPythonOcr(imageBuffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const boundary = 'dashboundary' + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageBuffer, footer]);

  const resp = await fetch(`${PYTHON_API}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body as unknown as BodyInit,
  });
  if (!resp.ok) throw new Error(`Python API /ocr → HTTP ${resp.status}`);
  const data = await resp.json() as { text: string };
  return data.text || 'No text found.';
}

async function callPythonTranscribe(audioBuffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const boundary = 'dashboundary' + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, audioBuffer, footer]);

  const resp = await fetch(`${PYTHON_API}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body as unknown as BodyInit,
  });
  if (!resp.ok) throw new Error(`Python API /transcribe → HTTP ${resp.status}`);
  const data = await resp.json() as { text: string };
  return data.text || 'No transcription available.';
}

async function callPythonScreenshot(url: string, fullPage = false, format = 'png'): Promise<Buffer> {
  const resp = await fetch(`${PYTHON_API}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, full_page: fullPage, format }),
  });
  if (!resp.ok) throw new Error(`Python API /screenshot → HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── Response helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function callPythonExtractHtml(html: string): Promise<string> {
  const resp = await fetch(`${PYTHON_API}/extract_html`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  if (!resp.ok) throw new Error(`Python API /extract_html → HTTP ${resp.status}`);
  const data = await resp.json() as { content: string };
  return data.content || '';
}

function err(res: ServerResponse, message: string, status = 500): void {
  json(res, { error: message }, status);
}

function binary(res: ServerResponse, buffer: Buffer, mimeType: string, filename: string): void {
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buffer);
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method?.toUpperCase() ?? 'GET';
  const ct = req.headers['content-type'] ?? '';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // ── Static React build (dashboard/dist/) ──────────────────────────────────
  if (method === 'GET' && !url.startsWith('/api/')) {
    // Resolve path: strip query string
    const cleanPath = url.split('?')[0];
    // Try exact file first, fall back to SPA index.html
    const distDir = join(__dirname, '..', '..', 'dashboard', 'dist');
    const tryPaths = [
      join(distDir, cleanPath === '/' ? 'index.html' : cleanPath),
      join(distDir, 'index.html'), // SPA fallback
    ];
    const MIME: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
    };
    for (const filePath of tryPaths) {
      if (existsSync(filePath)) {
        const ext = filePath.substring(filePath.lastIndexOf('.'));
        const ct = MIME[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
        res.end(readFileSync(filePath));
        return;
      }
    }
    res.writeHead(404); res.end('Not found');
    return;
  }

  // ── GET /api/urls ─────────────────────────────────────────────────────────
  if (method === 'GET' && url.startsWith('/api/urls')) {
    const elapsed = Math.floor((Date.now() - SESSION_START_MS) / 1000);
    json(res, {
      sessionStartedAt: new Date(SESSION_START_MS).toISOString(),
      sessionRemainingSeconds: Math.max(0, SESSION_DURATION_S - elapsed),
      tools: urlRegistry,
    });
    return;
  }

  // ── POST /api/sessions/terminal ────────────────────────────────────────────
  if (method === 'POST' && url === '/api/sessions/terminal') {
    try {
      const result = await startTerminal();
      if (result.error) return err(res, result.error);
      if (result.url) registerUrl('terminal', '💻 Terminal', result.url, { username: result.username, password: result.password });
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/sessions/ssh ─────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/sessions/ssh') {
    try {
      const { startSSHTerminal } = require('./ssh-terminal');
      const result = await startSSHTerminal();
      if (result.error) return err(res, result.error);
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/sessions/vscode ──────────────────────────────────────────────
  if (method === 'POST' && url === '/api/sessions/vscode') {
    try {
      const result = await startVSCode();
      if (result.error) return err(res, result.error);
      if (result.url) registerUrl('vscode', '🔵 VSCode Server', result.url, { password: result.password });
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/sessions/browser ─────────────────────────────────────────────
  if (method === 'POST' && url === '/api/sessions/browser') {
    try {
      const result = await startBrowser();
      if (result.error) return err(res, result.error);
      if (result.url) registerUrl('browser', '🌐 Cloud Browser', result.url, { username: result.username, password: result.password });
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/ai/remove-bg ─────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/ai/remove-bg') {
    try {
      const body = await readBody(req);
      const { files } = parseMultipart(body, ct);
      const file = files['file'];
      if (!file) return err(res, 'No file uploaded', 400);
      const result = await callPythonRemoveBg(file.buffer, file.filename || 'image.png', file.mimeType);
      binary(res, result, 'image/png', `rembg_${Date.now()}.png`);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/ai/ocr ───────────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/ai/ocr') {
    try {
      const body = await readBody(req);
      const { files } = parseMultipart(body, ct);
      const file = files['file'];
      if (!file) return err(res, 'No file uploaded', 400);
      const text = await callPythonOcr(file.buffer, file.filename || 'image.png', file.mimeType);
      json(res, { text });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/ai/transcribe ────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/ai/transcribe') {
    try {
      const body = await readBody(req);
      const { files } = parseMultipart(body, ct);
      const file = files['file'];
      if (!file) return err(res, 'No file uploaded', 400);
      const text = await callPythonTranscribe(file.buffer, file.filename || 'audio.ogg', file.mimeType);
      json(res, { text });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/ai/screenshot ────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/ai/screenshot') {
    try {
      const body = await parseJsonBody(req);
      const targetUrl = body['url'] as string;
      if (!targetUrl) return err(res, 'url is required', 400);
      const fullPage = Boolean(body['fullPage']);
      const fmt = (body['format'] as string) || 'png';
      const buf = await callPythonScreenshot(targetUrl, fullPage, fmt);
      binary(res, buf, `image/${fmt}`, `screenshot_${Date.now()}.${fmt}`);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/ai/extract-html ──────────────────────────────────────────────
  if (method === 'POST' && url === '/api/ai/extract-html') {
    try {
      const body = await parseJsonBody(req);
      const html = body['html'] as string;
      if (!html) return err(res, 'html is required', 400);
      const content = await callPythonExtractHtml(html);
      json(res, { content });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/media/download ───────────────────────────────────────────────
  if (method === 'POST' && url === '/api/media/download') {
    try {
      const body = await parseJsonBody(req);
      const mediaUrl = body['url'] as string;
      if (!mediaUrl) return err(res, 'url is required', 400);
      const result = await detectAndDownload(mediaUrl);
      if (!result) return err(res, 'URL not supported or no media found', 400);
      binary(res, result.buffer, result.mimetype, result.filename);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/youtube/search ───────────────────────────────────────────────
  if (method === 'POST' && url === '/api/youtube/search') {
    try {
      const body = await parseJsonBody(req);
      const query = body['query'] as string;
      if (!query) return err(res, 'query is required', 400);
      const limit = Number(body['limit']) || 5;
      const results = await searchYouTube(query, limit);
      json(res, { results });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/youtube/info ─────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/youtube/info') {
    try {
      const body = await parseJsonBody(req);
      const videoUrl = body['url'] as string;
      if (!videoUrl) return err(res, 'url is required', 400);
      const info = await getYouTubeInfo(videoUrl);
      json(res, info);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/youtube/download ─────────────────────────────────────────────
  if (method === 'POST' && url === '/api/youtube/download') {
    try {
      const body = await parseJsonBody(req);
      const videoUrl = body['url'] as string;
      if (!videoUrl) return err(res, 'url is required', 400);
      const quality = body['quality'] as YouTubeQualityOption | undefined;
      let result;
      if (quality) {
        result = await downloadYouTubeVideo(videoUrl, quality);
      } else {
        result = await downloadYouTubeVideoFallback(videoUrl);
      }
      binary(res, result.buffer, result.mimetype, result.filename);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/android/start ────────────────────────────────────────────
  if (method === 'POST' && url === '/api/android/start') {
    try {
      const { startAndroidEmulator } = require('./android-emulator');
      const result = await startAndroidEmulator();
      if (!result.success) return err(res, result.error || result.message);
      if (result.webUrl) registerUrl('android', '📱 Android Emulator', result.webUrl);
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/android/status ───────────────────────────────────────────
  if (method === 'POST' && url === '/api/android/status') {
    try {
      const { getAndroidEmulatorStatus } = require('./android-emulator');
      const result = await getAndroidEmulatorStatus();
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/android/stop ─────────────────────────────────────────────
  if (method === 'POST' && url === '/api/android/stop') {
    try {
      const { stopAndroidEmulator } = require('./android-emulator');
      const result = await stopAndroidEmulator();
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── GET /api/sessions/all ──────────────────────────────────────────────
  if (method === 'GET' && url === '/api/sessions/all') {
    try {
      const { sessionManager } = require('./session-manager');
      const { getAllBrowsers } = require('./browser');
      const { getAndroidEmulatorStatus } = require('./android-emulator');
      
      const sessions = sessionManager.getAllSessions();
      const browsers = getAllBrowsers();
      const androidStatus = await getAndroidEmulatorStatus();
      
      json(res, {
        sessions,
        browsers,
        android: androidStatus.running ? androidStatus : null,
      });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/sessions/stop ────────────────────────────────────────────
  if (method === 'POST' && url === '/api/sessions/stop') {
    try {
      const body = await parseJsonBody(req);
      const sessionId = body['sessionId'] as string;
      const sessionType = body['type'] as string;
      
      if (!sessionId) return err(res, 'sessionId is required', 400);
      
      const { sessionManager } = require('./session-manager');
      const session = sessionManager.getSession(sessionId);
      
      if (!session) return err(res, 'Session not found', 404);
      
      // Stop based on type
      if (session.type === 'custom-browser') {
        const { stopBrowser } = require('./browser');
        const result = await stopBrowser(sessionId);
        json(res, result);
      } else if (session.type === 'android') {
        const { stopAndroidEmulator } = require('./android-emulator');
        const result = await stopAndroidEmulator();
        json(res, result);
      } else {
        json(res, { success: false, message: 'Cannot stop this session type yet' });
      }
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/browser/custom ───────────────────────────────────────────
  if (method === 'POST' && url === '/api/browser/custom') {
    try {
      const body = await parseJsonBody(req);
      const targetUrl = body['url'] as string;
      if (!targetUrl) return err(res, 'url is required', 400);
      
      const { startCustomBrowser } = require('./browser');
      const result = await startCustomBrowser(targetUrl);
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/browser/export-cookies ──────────────────────────────────
  if (method === 'POST' && url === '/api/browser/export-cookies') {
    try {
      const result = await exportYouTubeCookies();
      json(res, result, result.success ? 200 : 500);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/movies/search ────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/movies/search') {
    try {
      const body = await parseJsonBody(req);
      const query = body['query'] as string;
      if (!query) return err(res, 'query is required', 400);
      const limit = Number(body['limit']) || 6;
      const results = await searchMovies(query, limit);
      json(res, { results });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── GET /api/llm/models ────────────────────────────────────────────────────
  if (method === 'GET' && url === '/api/llm/models') {
    try {
      const running = await isLLMServerRunning();
      if (!running) return err(res, 'LLM server is not running. Check GitHub Actions logs.', 503);
      json(res, await llmListModels());
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── GET /api/llm/status ─────────────────────────────────────────────────────
  if (method === 'GET' && url === '/api/llm/status') {
    try {
      const running = await isLLMServerRunning();
      if (!running) return json(res, { loaded: false, model_id: null, label: null, ctx: null, server_running: false });
      const status = await llmStatus();
      json(res, { ...status, server_running: true });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── GET /api/llm/download/status/:id ───────────────────────────────────────
  if (method === 'GET' && url.startsWith('/api/llm/download/status/')) {
    try {
      const model_id = url.replace('/api/llm/download/status/', '');
      json(res, await llmDownloadStatus(model_id));
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/llm/download ─────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/llm/download') {
    try {
      const body = await parseJsonBody(req);
      const model_id = body['model_id'] as string;
      if (!model_id) return err(res, 'model_id is required', 400);
      json(res, await llmDownloadModel(model_id));
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/llm/load ─────────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/llm/load') {
    try {
      const body = await parseJsonBody(req);
      const model_id = body['model_id'] as string;
      const n_ctx = body['n_ctx'] as number | undefined;
      if (!model_id) return err(res, 'model_id is required', 400);
      json(res, await llmLoadModel(model_id, n_ctx));
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/llm/unload ───────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/llm/unload') {
    try { json(res, await llmUnloadModel()); }
    catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/llm/chat ─────────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/llm/chat') {
    try {
      const body = await parseJsonBody(req);
      const messages = body['messages'] as Array<{ role: string; content: string }>;
      if (!messages?.length) return err(res, 'messages is required', 400);
      const max_tokens = (body['max_tokens'] as number) || 512;
      const temperature = (body['temperature'] as number) ?? 0.7;
      json(res, await llmChat({ messages: messages as any, max_tokens, temperature }));
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/llm/chat/stream ──────────────────────────────────────────────
  if (method === 'POST' && url === '/api/llm/chat/stream') {
    try {
      const body = await parseJsonBody(req);
      const messages = body['messages'] as Array<{ role: string; content: string }>;
      if (!messages?.length) return err(res, 'messages is required', 400);
      const max_tokens = (body['max_tokens'] as number) || 512;
      const temperature = (body['temperature'] as number) ?? 0.7;

      const pythonResp = await fetch(`http://127.0.0.1:8001/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, max_tokens, temperature, stream: true }),
      });

      if (!pythonResp.ok) {
        let msg = `LLM server HTTP ${pythonResp.status}`;
        try { const j = await pythonResp.json() as { detail?: string }; msg = j.detail ?? msg; } catch { /* ignore */ }
        return err(res, msg);
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      if (!pythonResp.body) { res.end('data: [DONE]\n\n'); return; }

      // Node 18+ fetch body is a Web ReadableStream — get a reader and pipe it
      type StreamReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): void };
      const body_ = pythonResp.body as unknown as { getReader(): StreamReader };
      const r = body_.getReader();
      const dec = new TextDecoder();

      req.on('close', () => { try { r.cancel(); } catch { /* ignore */ } });

      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        if (!res.writableEnded) res.write(dec.decode(value, { stream: true }));
      }
      if (!res.writableEnded) res.end();
    } catch (e) {
      if (!res.headersSent) err(res, (e as Error).message);
      else if (!res.writableEnded) res.end();
    }
    return;
  }




  // ── POST /api/browser/search ───────────────────────────────────────────
  // Supports ?engine=cdp|selenium. Default: tries CDP first, falls back to selenium.
  if (method === 'POST' && url === '/api/browser/search') {
    try {
      const body = await parseJsonBody(req);
      const text = body['text'] as string;
      if (!text) return err(res, 'text is required', 400);
      const pageNumber = Number(body['pageNumber']) || 1;
      const engine = (body['engine'] as string) || 'auto';

      // ── CDP / Puppeteer search ──────────────────────────────────────────
      const tryCdpSearch = async (): Promise<any | null> => {
        const { getGeneralBrowserCdpPort } = require('./browser');
        const cdpPort = getGeneralBrowserCdpPort() || 9222;

        // Pre-flight check
        const cdpResp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (!cdpResp.ok) return null;
        const info = await cdpResp.json() as { webSocketDebuggerUrl?: string };
        const wsUrl = info.webSocketDebuggerUrl;
        if (!wsUrl) return null;

        const puppeteer = require('puppeteer-core');
        const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
        const page = await browser.newPage();
        const startParam = (pageNumber - 1) * 10;
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));

        // Click all "Show more" buttons to expand AI overview
        try {
          await page.evaluate(() => {
            const btns = document.querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe');
            btns.forEach(b => (b as HTMLElement).click());
          });
          await new Promise(r => setTimeout(r, 1500));
        } catch {}

        const results = await page.evaluate(() => {
          const organic: any[] = [];
          let aiResponse: string | null = null;
          const seen = new Set<string>();

          // AI overview — grab the entire container's HTML for rich rendering
          const aiSelectors = ['.M8OgIe', '.LLtROe', '.IZ6rdc', '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk'];
          for (const sel of aiSelectors) {
            const el = document.querySelector(sel);
            if (el && (el as HTMLElement).innerText?.trim().length > 20) {
              // Get innerHTML for rich formatting, fall back to innerText
              aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
              break;
            }
          }

          // Organic results
          document.querySelectorAll('#search .g, #rso .g, .MjjYud .g').forEach(el => {
            const h3 = el.querySelector('h3');
            const a = el.querySelector('a[href^="http"]');
            if (!h3 || !a) return;
            const link = a.getAttribute('href') || '';
            if (seen.has(link)) return;
            seen.add(link);
            let snippet = '';
            for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec']) {
              const sn = el.querySelector(s);
              if (sn && (sn as HTMLElement).innerText) { snippet = (sn as HTMLElement).innerText.trim(); break; }
            }
            organic.push({ title: (h3 as HTMLElement).innerText.trim(), link, snippet });
          });

          // Fallback
          if (organic.length === 0) {
            document.querySelectorAll('a[href^="http"]').forEach(a => {
              const h3 = a.querySelector('h3');
              if (!h3) return;
              const link = a.getAttribute('href') || '';
              if (link.includes('google.com') || seen.has(link)) return;
              seen.add(link);
              organic.push({ title: (h3 as HTMLElement).innerText.trim(), link, snippet: '' });
            });
          }

          return { organic, aiResponse };
        });

        await page.close();
        browser.disconnect();
        return results;
      };

      // ── Python / SeleniumBase search ─────────────────────────────────────
      const trySeleniumSearch = async (): Promise<any> => {
        const resp = await fetch(`${PYTHON_API}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, pageNumber }),
        });
        if (!resp.ok) throw new Error(`Python API /search → HTTP ${resp.status}`);
        return resp.json();
      };

      let results: any;

      if (engine === 'cdp') {
        results = await tryCdpSearch();
        if (!results) return err(res, 'CDP not reachable. Is the browser container + socat sidecar running?', 400);
      } else if (engine === 'selenium') {
        results = await trySeleniumSearch();
      } else {
        // auto: try CDP first, fallback to selenium
        try {
          results = await tryCdpSearch();
        } catch { results = null; }
        if (!results) {
          results = await trySeleniumSearch();
        }
      }

      json(res, results);
    } catch (e) {
      err(res, (e as Error).message);
    }
    return;
  }

  // ── DELETE /api/llm/models/:id ─────────────────────────────────────────────
  if (method === 'DELETE' && url.startsWith('/api/llm/models/')) {
    try {
      const model_id = url.replace('/api/llm/models/', '');
      json(res, await llmDeleteModel(model_id));
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

export function startLocalServer(port = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const distDir = join(__dirname, '..', '..', 'dashboard', 'dist');
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((e) => {
        console.error('Dashboard handler error:', e);
        try { res.writeHead(500); res.end('Internal error'); } catch { /* already sent */ }
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(`http://localhost:${port}`);
    });
  });
}

/**
 * Expose the dashboard via Cloudflare.
 *
 * Two modes:
 *  1. Named tunnel (recommended, fixed domain):
 *     Set CLOUDFLARE_TUNNEL_TOKEN  → token from `cloudflared tunnel create` / Cloudflare Zero Trust
 *     Set DASHBOARD_DOMAIN         → e.g. "dashboard.yourdomain.com"
 *     The tunnel must already be configured in Cloudflare to route to localhost:4000.
 *
 *  2. Quick tunnel (fallback, random trycloudflare.com URL):
 *     Neither env var is set. A random URL is generated each session.
 */
export function exposeDashboard(localPort = 4000): Promise<string> {
  const tunnelToken  = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  const customDomain = process.env.DASHBOARD_DOMAIN;

  // ── Mode 1: Named tunnel with fixed custom domain ──────────────────────────
  if (tunnelToken && customDomain) {
    return new Promise((resolve) => {
      const proc: ChildProcess = spawn('cloudflared', [
        'tunnel', '--no-autoupdate', 'run', '--token', tunnelToken,
      ]);
      proc.stderr?.on('data', (_d: Buffer) => { /* suppress tunnel output */ });
      proc.on('error', (e) => {
        console.error('❌ Named tunnel error:', e);
        resolve('');
      });
      proc.on('close', () => { /* named tunnel closed */ });
      // With named tunnels the URL is known immediately — no need to parse output.
      // Give cloudflared 5 s to initialise before resolving.
      setTimeout(() => {
        const url = `https://${customDomain}`;
        resolve(url);
      }, 5000);
    });
  }

  // ── Mode 2: Quick tunnel (trycloudflare.com) ───────────────────────────────
  return new Promise((resolve) => {
    let publicUrl = '';
    const proc: ChildProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${localPort}`]);
    proc.stderr?.on('data', (d: Buffer) => {
      const m = d.toString().match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
      if (m && !publicUrl) { publicUrl = m[0]; resolve(publicUrl); }
    });
    proc.on('error', (e) => { console.error('Dashboard tunnel error:', e); resolve(''); });
    proc.on('close', () => { /* quick tunnel closed */ });
    setTimeout(() => { if (!publicUrl) { console.warn('⚠️ Dashboard tunnel timed out.'); resolve(''); } }, 20000);
  });
}

export async function startDashboard(localPort = 4000): Promise<string> {
  await startLocalServer(localPort);
  const publicUrl = await exposeDashboard(localPort);
  if (publicUrl) registerUrl('dashboard', '🖥️ Dashboard', publicUrl);
  return publicUrl;
}
