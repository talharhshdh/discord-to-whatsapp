import { exec, execFile, spawn, ChildProcess } from 'child_process';
import * as util from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer, { type Cookie } from 'puppeteer-core';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// Environment variables will be read dynamically inside the functions.

// CDP debug port allocated per instance (host port → container 9222)
const CDP_BASE_PORT = 19222;

// Track all browser instances
const browserInstances = new Map<string, {
  url: string;
  username: string;
  password: string;
  port: number;
  cdpPort: number;
  containerName: string;
  tunnelProcess: ChildProcess;
  targetUrl?: string;
}>();

/**
 * Start a general-purpose browser (no specific URL)
 */
export async function startBrowser(): Promise<{ url?: string; username?: string; password?: string; error?: string }> {
  // Check if general browser already exists
  const existing = Array.from(browserInstances.values()).find(b => !b.targetUrl);
  if (existing) {
    return {
      url: existing.url,
      username: existing.username,
      password: existing.password,
    };
  }

  return startBrowserInstance();
}

/**
 * Start a browser with a specific URL pre-loaded
 */
export async function startCustomBrowser(targetUrl: string): Promise<{
  sessionId?: string;
  url?: string;
  username?: string;
  password?: string;
  error?: string
}> {
  const sessionId = `browser-${crypto.randomBytes(4).toString('hex')}`;

  const result = await startBrowserInstance(targetUrl);

  if (result.url && !result.error) {
    // Register in session manager
    sessionManager.addSession({
      id: sessionId,
      type: 'custom-browser',
      url: result.url,
      username: result.username,
      password: result.password,
      startedAt: new Date(),
      metadata: {
        targetUrl,
      },
    });

    return { sessionId, ...result };
  }

  return result;
}

/**
 * Internal function to start a browser instance
 */
async function startBrowserInstance(targetUrl?: string): Promise<{
  url?: string;
  username?: string;
  password?: string;
  error?: string
}> {
  try {
    // Read environment variables dynamically
    const BROWSER_PORT = parseInt(process.env.BROWSER_PORT || '10080', 10);
    const BROWSER_USERNAME = process.env.BROWSER_USERNAME || '';
    const BROWSER_PASSWORD = process.env.BROWSER_PASSWORD || '';
    const BROWSER_TUNNEL_TOKEN = process.env.BROWSER_TUNNEL_TOKEN || '';
    const BROWSER_DOMAIN = process.env.BROWSER_DOMAIN || '';

    // Use hardcoded credentials if available, otherwise generate random ones
    const port = BROWSER_PORT || (10080 + browserInstances.size);
    const username = BROWSER_USERNAME || `dev_${crypto.randomBytes(3).toString('hex')}`;
    const password = BROWSER_PASSWORD || crypto.randomBytes(6).toString('hex');

    if (BROWSER_USERNAME && BROWSER_PASSWORD) {
    }

    // Ensure Docker is available
    try {
      await execAsync('docker --version');
    } catch {
      return { error: 'Docker is not installed or available.' };
    }

    const containerName = `cloud-browser-${port}`;
    // Allocate a unique host-side CDP port per instance
    const cdpPort = CDP_BASE_PORT + browserInstances.size;

    // Check if container already exists
    try {
      const { stdout } = await execAsync(`docker ps -a --filter name=${containerName} --format "{{.Names}}"`);
      if (stdout.includes(containerName)) {
        await execAsync(`docker stop ${containerName}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch {
      // No existing container
    }

    // Build docker command
    // Port 9222 (CDP) is exposed so puppeteer-core can connect directly — no Python/SQLite needed.
    const dockerCmd = [
      'docker', 'run', '-d', '--rm',
      '--name', containerName,
      '--shm-size=1gb',
      '-p', `${port}:3000`,
      '-p', `${cdpPort}:9222`,
      '-v', `${process.cwd()}/browser_data:/config`,
      '-e', 'TZ=Etc/UTC',
      '-e', `CUSTOM_USER=${username}`,
      '-e', `PASSWORD=${password}`,
      '-e', `PUID=${process.getuid ? process.getuid() : 1000}`,
      '-e', `PGID=${process.getgid ? process.getgid() : 1000}`,
      // Enable CDP remote debugging inside the container
      '-e', 'CHROMIUM_FLAGS=--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --no-sandbox --disable-dev-shm-usage',
    ];

    // Add custom URL if provided
    if (targetUrl) {
      dockerCmd.push('-e', `CUSTOM_URL=${targetUrl}`);
    }

    dockerCmd.push('lscr.io/linuxserver/chromium:latest');

    // Use execFile so args are passed directly to the OS — no shell splitting
    // on spaces inside env values like CHROMIUM_FLAGS.
    await execFileAsync(dockerCmd[0], dockerCmd.slice(1));

    // ── Mode 1: Named tunnel with fixed custom domain ──────────────────────────
    if (BROWSER_TUNNEL_TOKEN && BROWSER_DOMAIN) {
      return new Promise((resolve) => {

        const tunnelProcess = spawn('cloudflared', [
          'tunnel', '--no-autoupdate', 'run', '--token', BROWSER_TUNNEL_TOKEN,
        ]);

        tunnelProcess.stderr?.on('data', (data: Buffer) => {
        });

        tunnelProcess.on('error', (e) => {
          console.error('❌ Named browser tunnel error:', e);
          execAsync(`docker stop ${containerName}`).catch(() => { });
          resolve({ error: `Named tunnel error: ${e.message}` });
        });

        tunnelProcess.on('close', (code) => {
          const instanceId = targetUrl || 'general';
          browserInstances.delete(instanceId);
        });

        // With named tunnels the URL is known immediately — no need to parse output.
        // Give cloudflared 5s to initialise before resolving.
        setTimeout(() => {
          const cloudflareUrl = `https://${BROWSER_DOMAIN}`;

          // Store instance
          const instanceId = targetUrl || 'general';
          browserInstances.set(instanceId, {
            url: cloudflareUrl,
            username,
            password,
            port,
            cdpPort,
            containerName,
            tunnelProcess,
            targetUrl,
          });

          // Update session with cloudflared URL if this is a custom browser
          if (targetUrl) {
            const sessions = sessionManager.getSessionsByType('custom-browser');
            const session = sessions.find(s => s.metadata?.targetUrl === targetUrl);
            if (session) {
              sessionManager.updateSessionMetadata(session.id, { cloudflaredUrl: cloudflareUrl });
            }
          }

          resolve({ url: cloudflareUrl, username, password });
        }, 5000);
      });
    }

    // ── Mode 2: Quick tunnel (trycloudflare.com) ───────────────────────────────
    const tunnelProcess = spawn('cloudflared', [
      'tunnel',
      '--url', `http://localhost:${port}`
    ]);

    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          setTimeout(() => {
            // Store instance
            const instanceId = targetUrl || 'general';
            browserInstances.set(instanceId, {
              url: cloudflareUrl,
              username,
              password,
              port,
              cdpPort,
              containerName,
              tunnelProcess,
              targetUrl,
            });

            // Update session with cloudflared URL if this is a custom browser
            if (targetUrl) {
              const sessions = sessionManager.getSessionsByType('custom-browser');
              const session = sessions.find(s => s.metadata?.targetUrl === targetUrl);
              if (session) {
                sessionManager.updateSessionMetadata(session.id, { cloudflaredUrl: cloudflareUrl });
              }
            }

            resolve({ url: cloudflareUrl, username, password });
          }, 5000);
        }
      });

      tunnelProcess.on('close', (code) => {
        const instanceId = targetUrl || 'general';
        browserInstances.delete(instanceId);
      });

      setTimeout(() => {
        if (!cloudflareUrl) {
          execAsync(`docker stop ${containerName}`).catch(() => { });
          resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 15000);
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to set up browser: ${errMsg}` };
  }
}

// ---------------------------------------------------------------------------
// Cookie export — puppeteer-core via CDP
// ---------------------------------------------------------------------------

/**
 * Exports YouTube cookies from the running Chromium container using puppeteer-core.
 *
 * The container is started with --remote-debugging-port=9222 and that port is
 * mapped to a host-side port (cdpPort).  puppeteer.connect() talks to that
 * endpoint, fetches all cookies for the target domains, and writes a
 * Netscape-format cookies.txt that yt-dlp can consume via --cookies.
 *
 * This works identically on a local machine and on GitHub Actions because
 * both the Node process and the Docker container share the same host network.
 *
 * @param domain  Domain filter prefix (default: ".youtube.com")
 */
export async function exportYouTubeCookies(
  domain = '.youtube.com',
): Promise<{ success: boolean; message: string; cookiesPath?: string }> {
  const instance =
    Array.from(browserInstances.values()).find(b => !b.targetUrl) ??
    Array.from(browserInstances.values())[0];

  if (!instance) {
    return { success: false, message: 'No browser container is running. Start the browser first.' };
  }

  const { cdpPort } = instance;
  const cookiesPath = path.join(process.cwd(), 'browser_data', 'youtube-cookies.txt');

  // Wait up to 15 s for the CDP endpoint to become reachable (Chromium takes a
  // few seconds after container start before --remote-debugging-port is ready).
  const cdpUrl = `http://localhost:${cdpPort}`;
  await waitForCdp(cdpUrl, 15_000);

  let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;
  try {
    browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });

    // Collect cookies for YouTube + Google account domains
    const targetDomains = [domain, domain.replace(/^\./, ''), '.google.com', 'accounts.google.com'];
    const allCookies: Cookie[] = [];

    for (const page of await browser.pages()) {
      const cookies = await page.cookies(...targetDomains);
      for (const c of cookies) {
        if (!allCookies.some(existing => existing.name === c.name && existing.domain === c.domain)) {
          allCookies.push(c);
        }
      }
    }

    if (allCookies.length === 0) {
      return {
        success: false,
        message: 'No cookies found. Open YouTube in the browser and log in first, then try again.',
      };
    }

    // Convert to Netscape cookies.txt format
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of allCookies) {
      const hostFlag = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const secureFlag = c.secure ? 'TRUE' : 'FALSE';
      const expires = c.expires > 0 ? Math.floor(c.expires) : 0;
      // Skip cookies with control characters in value
      const value = c.value.replace(/[\t\n\r]/g, '');
      if (!value) continue;
      lines.push([c.domain, hostFlag, c.path, secureFlag, expires, c.name, value].join('\t'));
    }

    fs.writeFileSync(cookiesPath, lines.join('\n'), 'utf-8');

    const cookieCount = lines.length - 1; // subtract header
    return {
      success: true,
      message: `Exported ${cookieCount} YouTube cookies to ${cookiesPath}`,
      cookiesPath,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Cookie export failed: ${errMsg}` };
  } finally {
    // Disconnect without closing the browser (user may still be browsing)
    browser?.disconnect();
  }
}

/**
 * Polls the CDP /json/version endpoint until it responds or the timeout elapses.
 */
async function waitForCdp(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/json/version`);
      if (res.ok) return;
    } catch {
      // not yet ready
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`CDP endpoint at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

/**
 * Returns the path to the YouTube cookies file if it exists, otherwise undefined.
 */
export function getYouTubeCookiesPath(): string | undefined {
  const p = path.join(process.cwd(), 'browser_data', 'youtube-cookies.txt');
  return fs.existsSync(p) ? p : undefined;
}

/**
 * Stop a browser instance
 */
export async function stopBrowser(sessionId?: string): Promise<{ success: boolean; message: string }> {
  try {
    if (sessionId) {
      // Stop specific session
      const session = sessionManager.getSession(sessionId);
      if (!session || session.type !== 'custom-browser') {
        return { success: false, message: 'Session not found' };
      }

      const instance = browserInstances.get(session.metadata?.targetUrl || '');
      if (instance) {
        instance.tunnelProcess.kill();
        await execAsync(`docker stop ${instance.containerName}`);
        browserInstances.delete(session.metadata?.targetUrl || '');
      }

      sessionManager.removeSession(sessionId);
      return { success: true, message: 'Browser session stopped' };
    } else {
      // Stop general browser
      const general = Array.from(browserInstances.values()).find(b => !b.targetUrl);
      if (!general) {
        return { success: false, message: 'No general browser running' };
      }

      general.tunnelProcess.kill();
      await execAsync(`docker stop ${general.containerName}`);
      browserInstances.delete('general');
      return { success: true, message: 'General browser stopped' };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: errMsg };
  }
}

/**
 * Get all browser instances
 */
export function getAllBrowsers() {
  return Array.from(browserInstances.entries()).map(([key, instance]) => ({
    id: key,
    url: instance.url,
    username: instance.username,
    password: instance.password,
    targetUrl: instance.targetUrl,
    port: instance.port,
  }));
}
