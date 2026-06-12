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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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
import { searchYouTube, getYouTubeInfo, downloadYouTubeVideo } from './youtube-dl';
import { searchMovies } from './movie-search';
import type { YouTubeQualityOption } from './youtube-dl';
import { browserPool, searchViaPool } from './browser-pool';
// import { isConnectionCached } from './page-pool';
import type { WebhookPayload } from './browser-pool';
import { searchPlacesViaPool, searchPlacesStream, searchViaGoogleSearchUrl, searchViaGoogleSearchStream } from './google-places-search';
import { acquirePage, releasePage } from './page-pool';
import { cookieSearchPool } from './cookie-search-pool';
import { saveStateToR2 } from './r2-sync';
import { startCustomContainer, restoreDockerContainers, stopCustomContainer } from './custom-container';

const Corrosion = require('corrosion');
const webProxy = new Corrosion({
  prefix: '/api/web-proxy/',
  codec: 'base64',
});

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

// ── YouTube Download Jobs ───────────────────────────────────────────────────

export interface DownloadJob {
  id: string;
  url: string;
  qualityKey: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  progress: number;
  message: string;
  downloadUrl?: string;
  error?: string;
  title?: string;
  createdAt: number;
}

const downloadJobs: Record<string, DownloadJob> = {};

function cleanupOldJobs(): void {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const downloadsDir = join(__dirname, '..', '..', 'downloads');

  for (const [id, job] of Object.entries(downloadJobs)) {
    if (now - job.createdAt > ONE_HOUR) {
      delete downloadJobs[id];
      if (job.downloadUrl) {
        try {
          const name = new URL(job.downloadUrl, 'http://localhost').searchParams.get('name');
          if (name) {
            const filePath = join(downloadsDir, name);
            if (existsSync(filePath)) {
              const { unlinkSync } = require('fs');
              unlinkSync(filePath);
            }
          }
        } catch (e) {
          console.error('Failed to delete old download file:', e);
        }
      }
    }
  }
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
  throw new Error('Python server (background removal) is disabled.');
  /*
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
  */
}

async function callPythonOcr(imageBuffer: Buffer, filename: string, mimeType: string): Promise<string> {
  throw new Error('Python server (OCR) is disabled.');
  /*
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
  */
}

async function callPythonTranscribe(audioBuffer: Buffer, filename: string, mimeType: string): Promise<string> {
  throw new Error('Python server (transcription) is disabled.');
  /*
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
  */
}

async function callPythonScreenshot(url: string, fullPage = false, format = 'png'): Promise<Buffer> {
  throw new Error('Python server (screenshot) is disabled.');
  /*
  const resp = await fetch(`${PYTHON_API}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, full_page: fullPage, format }),
  });
  if (!resp.ok) throw new Error(`Python API /screenshot → HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
  */
}

// ── Response helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function callPythonExtractHtml(html: string): Promise<string> {
  throw new Error('Python server (HTML extraction) is disabled.');
  /*
  const resp = await fetch(`${PYTHON_API}/extract_html`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  if (!resp.ok) throw new Error(`Python API /extract_html → HTTP ${resp.status}`);
  const data = await resp.json() as { content: string };
  return data.content || '';
  */
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

// ── Authentication Check Helpers ──────────────────────────────────────────────

function safeCompare(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) {
    try {
      require('crypto').timingSafeEqual(aBuf, aBuf);
    } catch {}
    return false;
  }
  return require('crypto').timingSafeEqual(aBuf, bBuf);
}

// ── Environment Variable Helpers ──────────────────────────────────────────────

function readEnvFile(): Record<string, string> {
  const envPath = join(__dirname, '..', '..', '.env');
  const config: Record<string, string> = {};
  if (!existsSync(envPath)) return config;

  const content = readFileSync(envPath, 'utf8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const firstEq = trimmed.indexOf('=');
    if (firstEq === -1) continue;

    const key = trimmed.substring(0, firstEq).trim();
    let val = trimmed.substring(firstEq + 1).trim();

    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }

    config[key] = val;
  }

  return config;
}

function writeEnvFile(newConfig: Record<string, string>): void {
  const envPath = join(__dirname, '..', '..', '.env');
  const existingConfig = readEnvFile();
  const mergedConfig = { ...existingConfig, ...newConfig };

  let currentContent = '';
  if (existsSync(envPath)) {
    currentContent = readFileSync(envPath, 'utf8');
  }

  const lines = currentContent.split('\n');
  const writtenKeys = new Set<string>();
  const outputLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) {
      outputLines.push(line);
      continue;
    }

    const firstEq = trimmed.indexOf('=');
    if (firstEq === -1) {
      outputLines.push(line);
      continue;
    }

    const key = trimmed.substring(0, firstEq).trim();
    if (key in mergedConfig) {
      outputLines.push(`${key}=${mergedConfig[key]}`);
      writtenKeys.add(key);
    } else {
      outputLines.push(line);
    }
  }

  for (const [key, val] of Object.entries(mergedConfig)) {
    if (!writtenKeys.has(key)) {
      outputLines.push(`${key}=${val}`);
    }
  }

  writeFileSync(envPath, outputLines.join('\n'), 'utf8');
}

const gzipCache = new Map<string, { mtime: number; content: Buffer }>();

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

        try {
          const stat = require('fs').statSync(filePath);
          const mtime = stat.mtimeMs;
          const fileContent = readFileSync(filePath);

          const acceptEncoding = req.headers['accept-encoding'] || '';
          if (acceptEncoding.includes('gzip') && ['.html', '.js', '.css', '.json', '.svg'].includes(ext)) {
            let cached = gzipCache.get(filePath);
            if (!cached || cached.mtime !== mtime) {
              const { gzipSync } = require('zlib');
              const compressed = gzipSync(fileContent);
              cached = { mtime, content: compressed };
              gzipCache.set(filePath, cached);
            }
            res.writeHead(200, {
              'Content-Type': ct,
              'Content-Encoding': 'gzip',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=31536000',
            });
            res.end(cached.content);
          } else {
            res.writeHead(200, {
              'Content-Type': ct,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=31536000',
            });
            res.end(fileContent);
          }
        } catch (e) {
          res.writeHead(500);
          res.end('Server error');
        }
        return;
      }
    }
    res.writeHead(404); res.end('Not found');
    return;
  }

  // ── Authentication Check ──────────────────────────────────────────────────
  const usernameEnv = process.env.DASHBOARD_USERNAME;
  const passwordEnv = process.env.DASHBOARD_PASSWORD;

  if (url.startsWith('/api/') && 
      url !== '/api/auth/login' && 
      url !== '/api/browser/search' && 
      url !== '/api/browser/cookie-search' && 
      url !== '/api/browsers/webhook' &&
      !url.startsWith('/api/webhook/docker/')) {
    if (usernameEnv && passwordEnv) {
      const expectedToken = Buffer.from(`${usernameEnv}:${passwordEnv}`).toString('base64');
      let providedToken: string | null = null;

      // 1. Check Authorization or x-dashboard-token header
      const authHeader = req.headers['authorization'] || req.headers['x-dashboard-token'];
      if (authHeader && typeof authHeader === 'string') {
        providedToken = authHeader.startsWith('Basic ') ? authHeader.substring(6) : authHeader;
      }

      // 2. Check token query parameter in the URL
      if (!providedToken && req.url) {
        try {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const tokenParam = parsedUrl.searchParams.get('token');
          if (tokenParam) providedToken = tokenParam;
        } catch {
          const match = req.url.match(/[?&]token=([^&]+)/);
          if (match) providedToken = decodeURIComponent(match[1]);
        }
      }

      // 3. Check dashboard_token cookie
      if (!providedToken) {
        const cookieHeader = req.headers['cookie'] || req.headers['Cookie'];
        if (cookieHeader && typeof cookieHeader === 'string') {
          const match = cookieHeader.match(/(?:^|;\s*)dashboard_token=([^;]+)/);
          if (match) providedToken = match[1];
        }
      }

      if (safeCompare(providedToken, expectedToken)) {
        // Correctly authorized!
        // Ensure the client has the dashboard_token cookie so subresources load successfully
        const cookieHeader = req.headers['cookie'] || req.headers['Cookie'];
        const hasMatchingCookie = cookieHeader && typeof cookieHeader === 'string' &&
          cookieHeader.includes(`dashboard_token=${expectedToken}`);
        if (!hasMatchingCookie) {
          res.setHeader('Set-Cookie', `dashboard_token=${expectedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
        }
      } else {
        err(res, 'Unauthorized', 401);
        return;
      }
    }
  }

  // ── Proxy Go Container Manager ──────────────────────────────────────────────
  if (url.startsWith('/api/go/')) {
    const targetUrl = `http://127.0.0.1:18080${url}`;
    const parsedTarget = new URL(targetUrl);
    
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) {
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
    }
    headers['host'] = parsedTarget.host;

    const proxyReq = require('http').request({
      method: req.method,
      hostname: parsedTarget.hostname,
      port: parsedTarget.port,
      path: parsedTarget.pathname + parsedTarget.search,
      headers: headers
    }, (proxyRes: any) => {
      if (url.includes('/containers/logs') || proxyRes.headers['content-type'] === 'text/event-stream') {
        proxyRes.headers['x-accel-buffering'] = 'no';
      }
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (proxyErr: Error) => {
      console.error('[Go Proxy Error]:', proxyErr.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Go container manager is offline: ${proxyErr.message}` }));
      }
    });

    req.pipe(proxyReq);
    return;
  }

  // ── POST /api/auth/login ───────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/auth/login') {
    try {
      const body = await parseJsonBody(req);
      const username = body['username'] as string;
      const password = body['password'] as string;

      if (!usernameEnv || !passwordEnv) {
        json(res, { success: true, token: '' });
        return;
      }

      if (safeCompare(username, usernameEnv) && safeCompare(password, passwordEnv)) {
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        res.setHeader('Set-Cookie', `dashboard_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
        json(res, { success: true, token });
      } else {
        err(res, 'Invalid credentials', 400);
      }
    } catch (e) {
      err(res, (e as Error).message);
    }
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

  // ── POST /api/sessions/docker ─────────────────────────────────────────────
  if (method === 'POST' && url === '/api/sessions/docker') {
    try {
      const body = await parseJsonBody(req);
      const image = body['image'] as string;
      const port = Number(body['port']);
      const env = (body['env'] || {}) as Record<string, string>;
      const name = body['name'] as string | undefined;
      const domainMode = (body['domainMode'] || 'quick') as 'quick' | 'custom';
      const customDomain = body['customDomain'] as string | undefined;
      const hostPort = body['hostPort'] ? Number(body['hostPort']) : undefined;
      const tunnelToken = body['tunnelToken'] as string | undefined;

      if (!image) return err(res, 'image is required', 400);
      if (!port || isNaN(port)) return err(res, 'port is required and must be a number', 400);

      const result = await startCustomContainer(image, port, env, name, domainMode, customDomain, hostPort, tunnelToken);
      if (result.error) return err(res, result.error);
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/sessions/docker/update ──────────────────────────────────────
  if (method === 'POST' && url === '/api/sessions/docker/update') {
    try {
      const body = await parseJsonBody(req);
      const sessionId = body['sessionId'] as string;
      const image = body['image'] as string;
      const port = Number(body['port']);
      const env = (body['env'] || {}) as Record<string, string>;
      const name = body['name'] as string | undefined;
      const domainMode = (body['domainMode'] || 'quick') as 'quick' | 'custom';
      const customDomain = body['customDomain'] as string | undefined;
      const hostPort = body['hostPort'] ? Number(body['hostPort']) : undefined;
      const tunnelToken = body['tunnelToken'] as string | undefined;

      if (!sessionId) return err(res, 'sessionId is required', 400);
      if (!image) return err(res, 'image is required', 400);
      if (!port || isNaN(port)) return err(res, 'port is required and must be a number', 400);

      const { sessionManager } = require('./session-manager');
      const session = sessionManager.getSession(sessionId);
      if (!session || session.type !== 'docker-container') {
        return err(res, 'Docker session not found', 404);
      }

      // Start new container with same sessionId (which will automatically stop the old one and clean up its Cloudflare resources first)
      const result = await startCustomContainer(
        image,
        port,
        env,
        name,
        domainMode,
        customDomain,
        hostPort,
        undefined,
        sessionId
      );

      if (result.error) return err(res, result.error);
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── GET/POST /api/webhook/docker/<sessionId> ───────────────────────────────
  if ((method === 'GET' || method === 'POST') && url.startsWith('/api/webhook/docker/')) {
    try {
      const urlObj = new URL(url, 'http://localhost');
      const pathParts = urlObj.pathname.split('/');
      const sessionId = pathParts[pathParts.length - 1];
      const secret = urlObj.searchParams.get('secret');

      const { sessionManager } = require('./session-manager');
      const session = sessionManager.getSession(sessionId);

      if (!session || session.type !== 'docker-container') {
        return err(res, 'Session not found or invalid type', 404);
      }

      const meta = session.metadata as any;
      if (!meta || !safeCompare(meta.webhookSecret, secret)) {
        return err(res, 'Invalid or missing webhook secret', 401);
      }

      // Respond immediately to avoid timing out the caller
      json(res, { success: true, message: 'Redeploy task scheduled successfully' });

      // Run redeploy asynchronously in the background
      (async () => {
        try {
          console.log(`[Webhook Deploy] Starting redeploy for session ${sessionId} (${meta.image})...`);
          
          const containerPort = meta.port;
          const hostPort = meta.hostPort;
          const env = meta.env || {};
          const name = meta.containerName ? meta.containerName.replace(/^docker-custom-/, '').split('-')[0] : undefined;
          const domainMode = meta.domainMode || 'quick';
          const customDomain = meta.customDomain;

          console.log(`[Webhook Deploy] Launching new instance for ${meta.image}...`);

          const result = await startCustomContainer(
            meta.image,
            containerPort,
            env,
            name,
            domainMode,
            customDomain,
            hostPort,
            undefined,
            sessionId
          );

          if (result.error) {
            console.error(`[Webhook Deploy] Failed to start container:`, result.error);
          } else {
            console.log(`[Webhook Deploy] Successfully redeployed ${meta.image}. New name: ${result.containerName}`);
          }
        } catch (redeployErr) {
          console.error(`[Webhook Deploy] Error during redeploy:`, redeployErr);
        }
      })();

    } catch (e) {
      err(res, (e as Error).message);
    }
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

      // More universal fallback: try pre-merged mp4, then best available
      const formatStr = quality?.formatId || 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best';
      const isAudioOnly = quality?.audioOnly || false;
      const ext = isAudioOnly ? 'm4a' : 'mp4';
      const mimeType = isAudioOnly ? 'audio/mp4' : 'video/mp4';

      const { getYouTubeCookiesPath } = require('./browser');
      const cookiesPath = getYouTubeCookiesPath();

      const youtubedl = require('youtube-dl-exec');
      const yt = youtubedl.exec(videoUrl, {
        f: formatStr,
        noWarnings: true,
        noCheckCertificates: true,
        o: '-',
        ...(cookiesPath ? { cookies: cookiesPath } : {}),
      });

      // Collect stderr for error reporting before headers are sent
      const stderrChunks: Buffer[] = [];
      yt.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data);
        console.log('[yt-dlp]', data.toString().trim());
      });

      // Process-level spawn errors (e.g. binary missing)
      yt.on('error', (spawnErr: Error) => {
        console.error('[yt-dlp] spawn error:', spawnErr);
        if (!res.headersSent) err(res, `yt-dlp spawn error: ${spawnErr.message}`);
        else if (!res.writableEnded) res.end();
      });

      // Non-zero exit: yt-dlp failed (format unavailable, bot-check, etc.)
      yt.on('close', (code: number | null) => {
        if (code && code !== 0) {
          const stderrMsg = Buffer.concat(stderrChunks).toString().trim();
          console.error(`[yt-dlp] exited with code ${code}: ${stderrMsg}`);
          if (!res.headersSent) {
            err(res, `yt-dlp failed (exit ${code}): ${stderrMsg.split('\n').pop() ?? 'unknown error'}`);
          } else if (!res.writableEnded) {
            res.end();
          }
        }
      });

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="youtube_download.${ext}"`,
        'Access-Control-Allow-Origin': '*',
      });

      yt.stdout?.pipe(res);

      req.on('close', () => { try { yt.kill(); } catch { /* ignore */ } });

    } catch (e) {
      if (!res.headersSent) err(res, (e as Error).message);
      else if (!res.writableEnded) res.end();
    }
    return;
  }

  // ── POST /api/youtube/download-job ─────────────────────────────────────────
  if (method === 'POST' && url === '/api/youtube/download-job') {
    try {
      const body = await parseJsonBody(req);
      const videoUrl = body['url'] as string;
      if (!videoUrl) return err(res, 'url is required', 400);
      const quality = body['quality'] as YouTubeQualityOption | undefined;

      cleanupOldJobs();

      const jobId = Math.random().toString(36).substring(2, 15);
      const job: DownloadJob = {
        id: jobId,
        url: videoUrl,
        qualityKey: quality?.key || 'default',
        status: 'pending',
        progress: 0,
        message: 'Job initialized',
        createdAt: Date.now(),
      };
      downloadJobs[jobId] = job;

      // Start download in background
      (async () => {
        try {
          job.status = 'downloading';
          job.message = 'Starting download...';

          const qOption = quality || {
            key: 'audio-video',
            label: '🎬 Audio + Video (Best Pre-merged)',
            sizeBytes: null,
            audioOnly: false,
            formatId: 'best[ext=mp4]/best'
          };

          const result = await downloadYouTubeVideo(videoUrl, qOption, async (statusStr) => {
            job.message = statusStr;
            const pctMatch = statusStr.match(/(\d+)%/);
            if (pctMatch) {
              job.progress = parseInt(pctMatch[1], 10);
            }
          });

          const downloadsDir = join(__dirname, '..', '..', 'downloads');
          if (!existsSync(downloadsDir)) {
            mkdirSync(downloadsDir, { recursive: true });
          }

          const safeFilename = `${jobId}_${result.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
          const filePath = join(downloadsDir, safeFilename);
          writeFileSync(filePath, result.buffer);

          job.status = 'completed';
          job.progress = 100;
          job.message = 'Download complete!';
          job.title = result.filename;
          job.downloadUrl = `/api/youtube/files?name=${encodeURIComponent(safeFilename)}`;
        } catch (jobErr) {
          console.error(`[Download Job ${jobId}] error:`, jobErr);
          job.status = 'failed';
          job.message = `Failed: ${(jobErr as Error).message}`;
          job.error = (jobErr as Error).message;
        }
      })();

      json(res, { jobId });
    } catch (e) {
      err(res, (e as Error).message);
    }
    return;
  }

  // ── GET /api/youtube/job-status ────────────────────────────────────────────
  if (method === 'GET' && url.startsWith('/api/youtube/job-status')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const jobId = params.get('id');
    if (!jobId) return err(res, 'id is required', 400);

    const job = downloadJobs[jobId];
    if (!job) return err(res, 'Job not found', 404);

    json(res, job);
    return;
  }

  // ── GET /api/youtube/files ─────────────────────────────────────────────────
  if (method === 'GET' && url.startsWith('/api/youtube/files')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const name = params.get('name');
    if (!name) return err(res, 'name is required', 400);

    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      return err(res, 'Invalid file name', 400);
    }

    const downloadsDir = join(__dirname, '..', '..', 'downloads');
    const filePath = join(downloadsDir, name);
    if (!existsSync(filePath)) {
      return err(res, 'File not found', 404);
    }

    const ext = name.split('.').pop() || '';
    const mimeType = ext === 'm4a' ? 'audio/mp4' : 'video/mp4';

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name.replace(/^\w+_/, ''))}"`,
      'Access-Control-Allow-Origin': '*',
    });

    const { createReadStream } = require('fs');
    createReadStream(filePath).pipe(res);
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
      } else if (session.type === 'docker-container') {
        const result = await stopCustomContainer(sessionId);
        json(res, result);
      } else {
        json(res, { success: false, message: 'Cannot stop this session type yet' });
      }
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── Web Proxy (Corrosion) ──────────────────────────────────────────────────
  if (url.startsWith('/api/web-proxy')) {
    try {
      if (url.includes('?url=')) {
        try {
          const params = new URL(url, 'http://localhost').searchParams;
          let targetUrl = params.get('url');
          if (targetUrl) {
            if (!/^https?:\/\//i.test(targetUrl)) {
              targetUrl = 'https://' + targetUrl;
            }
            let encoded = '';
            if (webProxy.codec && typeof webProxy.codec.encode === 'function') {
              encoded = webProxy.codec.encode(targetUrl);
            } else {
              encoded = Buffer.from(targetUrl).toString('base64');
            }
            const token = params.get('token');
            res.writeHead(302, {
              'Location': `/api/web-proxy/${encoded}/${token ? `?token=${encodeURIComponent(token)}` : ''}`
            });
            res.end();
            return;
          }
        } catch (urlParamsErr) {
          console.error('Failed to parse proxy URL params:', urlParamsErr);
        }
      }

      // Strip only the 'token' parameter from the query string of the proxy path
      // to avoid corrupting the base64 URL decoding while preserving other query params.
      if (req.url) {
        const [path, search] = req.url.split('?');
        if (search) {
          const params = new URLSearchParams(search);
          params.delete('token');
          const newSearch = params.toString();
          req.url = path + (newSearch ? '?' + newSearch : '');
        }
      }

      // Detect and directly stream video/audio or range requests to bypass Corrosion's in-memory buffering
      let targetUrlStr = '';
      try {
        const urlData = webProxy.url.unwrap(req.url || '', { flags: true, leftovers: true });
        targetUrlStr = typeof urlData === 'string' ? urlData : urlData?.value || '';
      } catch (e) {
        // ignore
      }

      if (!targetUrlStr || !/^https?:\/\//i.test(targetUrlStr)) {
        const isCorrosionInternal = req.url && (
          req.url.startsWith('/api/web-proxy/index.js') ||
          req.url.startsWith('/api/web-proxy/gateway')
        );
        if (!isCorrosionInternal) {
          err(res, 'Invalid or missing target URL for proxy', 400);
          return;
        }
      }

      if (targetUrlStr) {
        const isRange = !!req.headers['range'];
        const acceptHeader = req.headers['accept'] || '';
        const isAcceptMedia = typeof acceptHeader === 'string' && (acceptHeader.includes('video/') || acceptHeader.includes('audio/'));
        const isMediaExtension = /\.(mp4|webm|mp3|wav|ogg|m4a|mov|flac|aac|ts|m3u8|mpd)(?:\?|$)/i.test(targetUrlStr);
        const isMediaKeyword = /videoplayback|googlevideo\.com|\/video\/|\/audio\/|\/stream/i.test(targetUrlStr);

        if (isRange || isAcceptMedia || isMediaExtension || isMediaKeyword) {
          try {
            const targetUrl = new URL(targetUrlStr);
            const isHttps = targetUrl.protocol === 'https:';
            const requester = isHttps ? require('https').request : require('http').request;

            const headers = { ...req.headers };
            headers['host'] = targetUrl.host;
            delete headers['origin'];
            delete headers['referer'];

            const proxyReq = requester(
              {
                method: req.method || 'GET',
                hostname: targetUrl.hostname,
                port: targetUrl.port || undefined,
                path: targetUrl.pathname + targetUrl.search,
                headers: headers,
                rejectUnauthorized: false,
              },
              (proxyRes: any) => {
                const resHeaders = { ...proxyRes.headers };
                if (resHeaders.location) {
                  try {
                    resHeaders.location = webProxy.url.wrap(resHeaders.location, { base: targetUrlStr });
                  } catch (wrapErr) {
                    console.error('Failed to wrap media redirect location:', wrapErr);
                  }
                }
                res.writeHead(proxyRes.statusCode || 200, resHeaders);
                proxyRes.pipe(res);
              }
            );

            proxyReq.on('error', (err: Error) => {
              console.error('Direct media proxy stream error:', err);
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(err.message);
              }
            });

            req.pipe(proxyReq);
            return;
          } catch (streamErr) {
            console.error('Direct media stream request failed:', streamErr);
          }
        }
      }

      webProxy.request(req, res);
    } catch (e) {
      err(res, (e as Error).message);
    }
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

  // ── GET /api/config ────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/api/config') {
    try {
      const config = readEnvFile();
      const responseConfig: Record<string, string> = {};
      for (const [k, v] of Object.entries(config)) {
        if (['R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID'].includes(k)) {
          responseConfig[k] = '••••••••••••••••';
        } else {
          responseConfig[k] = v;
        }
      }
      json(res, responseConfig);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/config ───────────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/config') {
    try {
      const body = await parseJsonBody(req) as Record<string, string>;
      const cleanedConfig: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === '••••••••••••••••') {
          continue;
        }
        cleanedConfig[k] = v;
      }

      writeEnvFile(cleanedConfig);

      // Update in-memory process.env
      for (const [k, v] of Object.entries(cleanedConfig)) {
        process.env[k] = v;
      }

      console.log('[Dashboard Config] Environment variables saved. Syncing to R2...');
      saveStateToR2().catch(e => {
        console.error('❌ Background R2 sync failed:', e);
      });

      json(res, { success: true, message: 'Configuration saved and R2 sync triggered.' });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/config/sync ──────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/config/sync') {
    try {
      console.log('[Dashboard Config] Manual R2 sync triggered...');
      const result = await saveStateToR2();
      json(res, result);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/browsers/webhook ─────────────────────────────────────────
  // Remote browser workers register, heartbeat, and deregister via this endpoint.
  if (method === 'POST' && url.startsWith('/api/browsers/webhook')) {
    try {
      const urlObj = new URL(url, 'http://localhost');
      const secretParam = urlObj.searchParams.get('secret');
      const expectedSecret = process.env.WEBHOOK_SECRET || process.env.DASHBOARD_PASSWORD;

      if (expectedSecret && !safeCompare(secretParam, expectedSecret)) {
        return err(res, 'Invalid or missing webhook secret', 401);
      }

      const body = await parseJsonBody(req) as unknown as WebhookPayload;
      const { event, workerId, cdpUrl, apiUrl, runId } = body;

      if (!event || !workerId) {
        return err(res, 'event and workerId are required', 400);
      }

      switch (event) {
        case 'register':
          if (!cdpUrl) return err(res, 'cdpUrl is required for register', 400);
          browserPool.register(workerId, cdpUrl, runId, false, apiUrl);
          json(res, { ok: true, message: 'Registered', poolSize: browserPool.size });
          break;

        case 'heartbeat': {
          const known = browserPool.heartbeat(workerId, runId);
          if (!known) {
            // Worker not in pool — tell it to re-register
            return json(res, { ok: false, message: 'Unknown worker — please re-register' }, 404);
          }
          json(res, { ok: true });
          break;
        }

        case 'deregister':
          browserPool.deregister(workerId);
          json(res, { ok: true, message: 'Removed', poolSize: browserPool.size });
          break;

        default:
          return err(res, `Unknown event: ${event}`, 400);
      }
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/browsers/stop-worker ───────────────────────────────────────
  if (method === 'POST' && url === '/api/browsers/stop-worker') {
    try {
      const body = await parseJsonBody(req);
      const runId = body['runId'] as string;
      if (!runId) return err(res, 'runId is required', 400);
      const success = await browserPool.stopWorker(runId);
      json(res, { success, message: `Stop signal sent for worker run ${runId}` });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── GET /api/browsers/pool ──────────────────────────────────────────────
  if (method === 'GET' && url === '/api/browsers/pool') {
    const all = browserPool.getAll();
    const active = browserPool.getActive();
    json(res, {
      total: all.length,
      active: active.length,
      browsers: all.map(b => ({
        workerId: b.workerId,
        cdpUrl: b.cdpUrl,
        apiUrl: b.apiUrl,
        status: b.status,
        registeredAt: new Date(b.registeredAt).toISOString(),
        lastHeartbeat: new Date(b.lastHeartbeat).toISOString(),
        secondsSinceHeartbeat: Math.round((Date.now() - b.lastHeartbeat) / 1000),
        // isCached: isConnectionCached(b.workerId),
      })),
    });
    return;
  }

  // ── POST /api/browsers/restart ─────────────────────────────────────────
  if (method === 'POST' && url === '/api/browsers/restart') {
    try {
      await browserPool.restartWorkers(true);
      json(res, { ok: true, message: 'Restart command sent to GitHub Actions' });
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/scrape/indeed ──────────────────────────────────────────────
  if (method === 'POST' && url === '/api/scrape/indeed') {
    try {
      const body = await parseJsonBody(req);
      const query = (body['query'] as string) || 'software engineer';
      const location = (body['location'] as string) || '';
      const pagesCount = (body['pages'] as number) || 3;

      const activeWorkers = browserPool.getActive().filter(b => b.apiUrl);
      if (activeWorkers.length === 0) {
        return err(res, 'No active browser workers with API support available', 503);
      }

      console.log(`[Indeed Scrape] Query: "${query}", Location: "${location}", Pages: ${pagesCount}. Active workers: ${activeWorkers.length}`);

      // Distribute pages to workers in parallel
      const promises = [];
      for (let i = 0; i < pagesCount; i++) {
        const worker = activeWorkers[i % activeWorkers.length];
        const pageIdx = i; // 0-based
        promises.push((async () => {
          try {
            console.log(`[Indeed Scrape] Dispatching Page ${pageIdx + 1} to worker ${worker.workerId} at ${worker.apiUrl}`);
            const response = await fetch(`${worker.apiUrl}/scrape/indeed`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query, location, page: pageIdx + 1 }),
            });
            if (!response.ok) {
              const text = await response.text();
              throw new Error(`Worker returned HTTP ${response.status}: ${text}`);
            }
            const data = await response.json() as any[];
            console.log(`[Indeed Scrape] Worker ${worker.workerId} returned ${data.length} jobs for Page ${pageIdx + 1}`);
            return data;
          } catch (e) {
            console.error(`[Indeed Scrape] Error on Page ${pageIdx + 1} using worker ${worker.workerId}:`, e);
            return [];
          }
        })());
      }

      const results = await Promise.all(promises);
      const allJobs: any[] = [];
      const seen = new Set<string>();
      for (const list of results) {
        if (!Array.isArray(list)) continue;
        for (const job of list) {
          if (job && job.jk && !seen.has(job.jk)) {
            seen.add(job.jk);
            allJobs.push(job);
          }
        }
      }

      console.log(`[Indeed Scrape] Finished. Scraped ${allJobs.length} jobs in total.`);
      json(res, { success: true, jobsCount: allJobs.length, jobs: allJobs });
    } catch (e) {
      err(res, (e as Error).message);
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
      const includeAI = Boolean(body['includeAI']);
      const category = (body['category'] as string) || 'all';

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
        let googleUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}`;
        if (category === 'images') {
          googleUrl += '&udm=2';
        } else if (category === 'videos') {
          googleUrl += '&udm=7';
        } else if (category === 'news') {
          googleUrl += '&udm=14';
        } else if (category === 'shopping') {
          googleUrl += '&udm=3';
        }
        await page.goto(googleUrl, { waitUntil: 'domcontentloaded' });
        // Wait dynamically for elements to load
        await page.waitForSelector('#search, .g, h3, form[action*="/sorry/"], #captcha, .g-recaptcha', { timeout: 100 }).catch(() => { });

        // Click "Show more" buttons only when AI response is requested
        if (includeAI) {
          try {
            const hasButtons = await page.evaluate(() => {
              const btns = document.querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe');
              if (btns.length > 0) {
                btns.forEach(b => (b as HTMLElement).click());
                return true;
              }
              return false;
            });
            if (hasButtons) {
              await new Promise(r => setTimeout(r, 1000));
            }
          } catch { }
        }

        const results = await page.evaluate((fetchAI: boolean) => {
          const organic: any[] = [];
          let aiResponse: string | null = null;
          const seen = new Set<string>();

          if (fetchAI) {
            // AI overview — grab the entire container's HTML for rich rendering
            const aiSelectors = ['.M8OgIe', '.LLtROe', '.IZ6rdc', '[data-attrid="wa:/description"]'];
            for (const sel of aiSelectors) {
              const el = document.querySelector(sel);
              if (el && (el as HTMLElement).innerText?.trim().length > 20) {
                const txt = (el as HTMLElement).innerText;
                if (txt.includes('AI Overview is not available') || txt.includes("Can't generate an AI overview")) {
                  continue;
                }
                aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
                break;
              }
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
            for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec', '.s3v9rd', '.AP7Wnd', '.BNeawe']) {
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
        }, includeAI);

        await page.close();
        browser.disconnect();
        return results;
      };

      // ── Python / SeleniumBase search ─────────────────────────────────────
      const trySeleniumSearch = async (): Promise<any> => {
        throw new Error('Selenium search is disabled (Python server offline).');
        /*
        const resp = await fetch(`${PYTHON_API}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, pageNumber, includeAI, category }),
        });
        if (!resp.ok) throw new Error(`Python API /search → HTTP ${resp.status}`);
        return resp.json();
        */
      };

      let results: any;

      if (engine === 'cdp') {
        results = await tryCdpSearch();
        if (!results) return err(res, 'CDP not reachable. Is the browser container + socat sidecar running?', 400);
      } else if (engine === 'selenium') {
        results = await trySeleniumSearch();
      } else if (engine === 'pool') {
        results = await searchViaPool(text, pageNumber, includeAI, category);
        if (!results) return err(res, 'No browsers available in pool', 503);
      } else {
        // auto: try pool first → local CDP → selenium fallback
        try {
          results = await searchViaPool(text, pageNumber, includeAI, category);
        } catch { results = null; }
        if (!results) {
          try {
            results = await tryCdpSearch();
          } catch { results = null; }
        }
        if (!results) {
          results = await trySeleniumSearch();
        }
      }

      if (results && results.aiResponse) {
        const cheerio = require('cheerio');
        const $ = cheerio.load(results.aiResponse);
        $('script, style').remove();
        results.aiResponse = $.text()
          .split('\n')
          .map((line: string) => line.trim())
          .filter((line: string) => line.length > 0)
          .join('\n');
      }

      json(res, results);
    } catch (e) {
      err(res, (e as Error).message);
    }
    return;
  }

  // ── POST /api/browser/cookie-search ───────────────────────────────────────
  if (method === 'POST' && url === '/api/browser/cookie-search') {
    try {
      const body = await parseJsonBody(req);
      const text = body['text'] as string;
      if (!text) return err(res, 'text is required', 400);
      const pageNumber = Number(body['pageNumber']) || 1;
      const category = (body['category'] as string) || 'all';
      const results = await cookieSearchPool.search(text, pageNumber, category);
      json(res, results);
    } catch (e) {
      err(res, (e as Error).message);
    }
    return;
  }

  // ── GET /api/browser/places/stream ────────────────────────────────────────
  // SSE endpoint: streams PlaceResult batches as the browser scrolls the feed.
  // Query params: query (required)
  // Events:
  //   data: {type:"batch", cards:[...], total:N, round:N}
  //   data: {type:"done",  total:N, reachedEnd:bool}
  //   data: {type:"error", message:string}
  if (method === 'GET' && url.startsWith('/api/browser/places/stream')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const query = params.get('query')?.trim() ?? '';
    if (!query) { err(res, 'query param is required', 400); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Keep-alive comment every 15s so the connection doesn't time out
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    const send = (event: object) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    req.on('close', () => clearInterval(keepAlive));

    try {
      await searchPlacesStream(query, send);
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // ── POST /api/browser/places ───────────────────────────────────────────
  // Google Maps Places search with pagination and optional deep-scrape.
  // Body: { query: string, pageNumber?: number, deepScrape?: boolean }
  if (method === 'POST' && url === '/api/browser/places') {
    try {
      const body = await parseJsonBody(req);
      const query = body['query'] as string;
      if (!query) return err(res, 'query is required', 400);
      const pageNumber = Number(body['pageNumber']) || 1;
      const deepScrape = Boolean(body['deepScrape']);

      const result = await searchPlacesViaPool(query, pageNumber, deepScrape);
      if (!result) return err(res, 'No browsers available in pool or all attempts failed', 503);
      json(res, result);
    } catch (e) {
      err(res, (e as Error).message);
    }
    return;
  }

  // ── POST /api/browser/places/google-search ────────────────────────────────
  // Single-page scrape via Google Search (udm=1) URL pattern.
  // Body: { query: string, pageNumber?: number }
  if (method === 'POST' && url === '/api/browser/places/google-search') {
    try {
      const body = await parseJsonBody(req);
      const query = body['query'] as string;
      if (!query) return err(res, 'query is required', 400);
      const pageNumber = Number(body['pageNumber']) || 1;

      const result = await searchViaGoogleSearchUrl(query, pageNumber);
      if (!result) return err(res, 'No browsers available in pool or all attempts failed', 503);
      json(res, result);
    } catch (e) {
      err(res, (e as Error).message);
    }
    return;
  }

  // ── GET /api/browser/places/google-search/stream ──────────────────────────
  // SSE endpoint: streams PlaceResult batches page-by-page via Google Search
  // (udm=1) URL pattern.
  // Query params: query (required), maxPages (optional, default 10)
  if (method === 'GET' && url.startsWith('/api/browser/places/google-search/stream')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const query = params.get('query')?.trim() ?? '';
    const maxPages = Number(params.get('maxPages')) || 10;
    if (!query) { err(res, 'query param is required', 400); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    const send = (event: object) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    req.on('close', () => clearInterval(keepAlive));

    try {
      await searchViaGoogleSearchStream(query, send, maxPages);
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
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

  // ── GET /api/tts/status ──────────────────────────────────────────────────────
  if (method === 'GET' && url === '/api/tts/status') {
    try {
      const r = await fetch('http://127.0.0.1:8002/health');
      if (!r.ok) return json(res, { running: false, model_loaded: false, loading: false, error: `HTTP ${r.status}` });
      const d = await r.json() as { status: string; model_loaded: boolean; loading: boolean; error?: string };
      json(res, { running: true, ...d });
    } catch {
      json(res, { running: false, model_loaded: false, loading: false, error: 'TTS server not reachable' });
    }
    return;
  }

  // ── GET /api/tts/voices ───────────────────────────────────────────────────────
  if (method === 'GET' && url === '/api/tts/voices') {
    try {
      const r = await fetch('http://127.0.0.1:8002/tts/voices');
      if (!r.ok) return err(res, `TTS server HTTP ${r.status}`);
      json(res, await r.json());
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/tts/generate ───────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/tts/generate') {
    try {
      const body = await parseJsonBody(req);
      const r = await fetch('http://127.0.0.1:8002/tts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ detail: `HTTP ${r.status}` })) as { detail?: string };
        return err(res, e.detail ?? `TTS server HTTP ${r.status}`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const fmt = (body['format'] as string) || 'wav';
      binary(res, buf, fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav', `tts_${Date.now()}.${fmt}`);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/tts/clone ──────────────────────────────────────────────────────
  // Forwards the raw multipart body directly to the Python TTS server.
  if (method === 'POST' && url === '/api/tts/clone') {
    try {
      const rawBody = await readBody(req);
      const r = await fetch('http://127.0.0.1:8002/tts/clone', {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: rawBody as unknown as BodyInit,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ detail: `HTTP ${r.status}` })) as { detail?: string };
        return err(res, e.detail ?? `TTS server HTTP ${r.status}`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const { fields } = parseMultipart(rawBody, ct);
      const fmt = fields['format'] || 'wav';
      binary(res, buf, fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav', `clone_${Date.now()}.${fmt}`);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // ── POST /api/tts/design ──────────────────────────────────────────────────────
  if (method === 'POST' && url === '/api/tts/design') {
    try {
      const body = await parseJsonBody(req);
      const r = await fetch('http://127.0.0.1:8002/tts/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ detail: `HTTP ${r.status}` })) as { detail?: string };
        return err(res, e.detail ?? `TTS server HTTP ${r.status}`);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const fmt = (body['format'] as string) || 'wav';
      binary(res, buf, fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav', `design_${Date.now()}.${fmt}`);
    } catch (e) { err(res, (e as Error).message); }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

export function startLocalServer(port = 4000): Promise<string> {
  // Start the browser pool cleanup loop so stale/dead workers are pruned
  browserPool.startCleanupLoop();

  return new Promise((resolve, reject) => {
    const distDir = join(__dirname, '..', '..', 'dashboard', 'dist');
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((e) => {
        console.error('Dashboard handler error:', e);
        try { res.writeHead(500); res.end('Internal error'); } catch { /* already sent */ }
      });
    });
    server.on('upgrade', (req: any, socket: any, head: any) => {
      if (req.url.startsWith('/api/web-proxy/')) {
        webProxy.upgrade(req, socket, head);
      }
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
  const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
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
  
  restoreDockerContainers().catch(err => {
    console.error('❌ Failed to restore docker containers:', err);
  });

  return publicUrl;
}
