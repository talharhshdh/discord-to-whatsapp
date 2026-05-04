/**
 * dashboard-server.ts
 *
 * Lightweight Express server that:
 *  - Serves the HTML dashboard at GET /
 *  - Exposes live session URLs at GET /api/urls (JSON)
 *  - Lets the app register URLs as they become available (registerUrl)
 *  - Exposes itself on a Cloudflare tunnel so admins can reach it publicly
 *
 * Usage:
 *   import { DashboardServer } from './libs/dashboard-server';
 *   const dashboard = new DashboardServer();
 *   const publicUrl = await dashboard.start();
 *   dashboard.registerUrl('terminal', 'https://xyz.trycloudflare.com', { username: 'dev_abc', password: 'secret' });
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawn, ChildProcess } from 'child_process';

/** A registered tool URL entry. */
export interface ToolUrlEntry {
  /** Human-readable label, e.g. "Terminal", "VSCode" */
  label: string;
  /** Cloudflare public URL */
  url: string;
  /** Optional credentials */
  username?: string;
  password?: string;
  /** ISO timestamp when this entry was registered */
  registeredAt: string;
}

/** Internal registry: toolKey → ToolUrlEntry */
const urlRegistry: Record<string, ToolUrlEntry> = {};

/** When the session started (used for countdown) */
const SESSION_START_MS = Date.now();

/** Maximum session duration in seconds (5 hours, matching the GH Actions timeout) */
const SESSION_DURATION_S = 5 * 60 * 60;

/**
 * Register or update a tool URL in the shared registry.
 *
 * @param key      Short identifier, e.g. "terminal", "vscode", "browser", "novnc"
 * @param label    Human-readable name shown in the dashboard
 * @param url      Cloudflare public URL
 * @param meta     Optional credentials / extra fields
 */
export function registerUrl(
  key: string,
  label: string,
  url: string,
  meta: { username?: string; password?: string } = {}
): void {
  urlRegistry[key] = {
    label,
    url,
    username: meta.username,
    password: meta.password,
    registeredAt: new Date().toISOString(),
  };
  console.log(`📊 Dashboard: registered ${label} → ${url}`);
}

/**
 * Return a snapshot of all registered URLs.
 */
export function getAllUrls(): Record<string, ToolUrlEntry> {
  return { ...urlRegistry };
}

/**
 * Start the local HTTP server that backs the dashboard.
 *
 * @param port  Local port to listen on (default 4000)
 * @returns     The local URL (http://localhost:<port>)
 */
export function startLocalServer(port = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const htmlPath = join(__dirname, 'dashboard.html');

    let htmlTemplate: string;
    try {
      htmlTemplate = readFileSync(htmlPath, 'utf-8');
    } catch {
      // Inline minimal fallback if the HTML file is missing
      htmlTemplate = '<html><body><pre id="data"></pre><script>fetch("/api/urls").then(r=>r.json()).then(d=>document.getElementById("data").textContent=JSON.stringify(d,null,2))</script></body></html>';
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      // ── GET /api/urls ─────────────────────────────────────────────────────
      if (url === '/api/urls' || url.startsWith('/api/urls?')) {
        const elapsedS = Math.floor((Date.now() - SESSION_START_MS) / 1000);
        const remainingS = Math.max(0, SESSION_DURATION_S - elapsedS);

        const payload = {
          sessionStartedAt: new Date(SESSION_START_MS).toISOString(),
          sessionRemainingSeconds: remainingS,
          tools: urlRegistry,
        };

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(payload, null, 2));
        return;
      }

      // ── GET / (dashboard HTML) ────────────────────────────────────────────
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlTemplate);
        return;
      }

      // 404 for anything else
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      const localUrl = `http://localhost:${port}`;
      console.log(`📊 Dashboard server listening at ${localUrl}`);
      resolve(localUrl);
    });
  });
}

/**
 * Expose the local dashboard over a Cloudflare Tunnel.
 *
 * @param localPort  The port the local server is listening on (default 4000)
 * @returns          Public trycloudflare.com URL, or empty string on timeout
 */
export function exposeDashboard(localPort = 4000): Promise<string> {
  return new Promise((resolve) => {
    console.log('🚇 Starting Cloudflare Tunnel for Dashboard...');

    let publicUrl = '';
    const tunnelProcess: ChildProcess = spawn('cloudflared', [
      'tunnel',
      '--url',
      `http://localhost:${localPort}`,
    ]);

    tunnelProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
      if (match && !publicUrl) {
        publicUrl = match[0];
        console.log(`✅ Dashboard public URL: ${publicUrl}`);
        resolve(publicUrl);
      }
    });

    tunnelProcess.on('error', (err: Error) => {
      console.error('❌ Dashboard Cloudflare Tunnel error:', err);
      resolve('');
    });

    tunnelProcess.on('close', (code: number | null) => {
      console.log(`⚠️ Dashboard Cloudflare Tunnel exited with code ${code}`);
    });

    // Safety timeout — if no URL appears in 20 seconds, give up
    setTimeout(() => {
      if (!publicUrl) {
        console.warn('⚠️ Timed out waiting for Dashboard tunnel URL.');
        resolve('');
      }
    }, 20000);
  });
}

/**
 * Convenience helper: start the local server AND expose it via Cloudflare.
 *
 * @param localPort  Port for the local HTTP server (default 4000)
 * @returns          Public Cloudflare URL (empty string if tunnel failed)
 */
export async function startDashboard(localPort = 4000): Promise<string> {
  await startLocalServer(localPort);
  const publicUrl = await exposeDashboard(localPort);

  // Register the dashboard itself in the URL registry so /api/urls includes it
  if (publicUrl) {
    registerUrl('dashboard', '🖥️ Dashboard', publicUrl);
  }

  return publicUrl;
}
