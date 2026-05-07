import { exec, spawn, ChildProcess } from 'child_process';
import * as util from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

// Environment variables will be read dynamically inside the functions.

// Track all browser instances
const browserInstances = new Map<string, {
  url: string;
  username: string;
  password: string;
  port: number;
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
    const dockerCmd = [
      'docker', 'run', '-d', '--rm',
      '--name', containerName,
      '--shm-size=1gb',
      '-p', `${port}:3000`,
      '-v', `${process.cwd()}/browser_data:/config`,
      '-e', 'TZ=Etc/UTC',
      '-e', `CUSTOM_USER=${username}`,
      '-e', `PASSWORD=${password}`,
      '-e', `PUID=${process.getuid ? process.getuid() : 1000}`,
      '-e', `PGID=${process.getgid ? process.getgid() : 1000}`,
    ];

    // Add custom URL if provided
    if (targetUrl) {
      dockerCmd.push('-e', `CUSTOM_URL=${targetUrl}`);
    }

    dockerCmd.push('lscr.io/linuxserver/chromium:latest');

    await execAsync(dockerCmd.join(' '));

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
// Cookie export
// ---------------------------------------------------------------------------

/**
 * Exports YouTube cookies from the running Chromium container to a
 * Netscape-format cookies.txt file that yt-dlp can consume via --cookies.
 *
 * The Chromium container mounts browser_data → /config.  The cookies SQLite
 * DB lives at /config/chromium/Default/Cookies inside the container.
 *
 * Strategy: run a Python one-liner via `docker exec` to query the DB and
 * write the Netscape file directly into /config (which is bind-mounted to
 * browser_data/ on the host).
 *
 * @param domain  Domain to filter (default: ".youtube.com")
 * @returns  Path to the written cookies file, or null on failure
 */
export async function exportYouTubeCookies(
  domain = '.youtube.com',
): Promise<{ success: boolean; message: string; cookiesPath?: string }> {
  // Find the running browser container
  const instance = Array.from(browserInstances.values()).find(b => !b.targetUrl)
    ?? Array.from(browserInstances.values())[0];

  if (!instance) {
    return { success: false, message: 'No browser container is running. Start the browser first.' };
  }

  const containerName = instance.containerName;
  const cookiesPath = path.join(process.cwd(), 'browser_data', 'youtube-cookies.txt');

  // Write the script to a temp file inside the container, then execute it.
  // Using -c with semicolons breaks Python's indented block syntax (for loops etc.).
  const scriptLines = [
    'import sqlite3, os, sys',
    `domain_filter = "${domain}"`,
    'db = "/config/chromium/Default/Cookies"',
    'out = "/config/youtube-cookies.txt"',
    'if not os.path.exists(db):',
    '    sys.exit("no-db")',
    'con = sqlite3.connect(db)',
    'cur = con.cursor()',
    'cur.execute(',
    '    "SELECT host_key, httponly, path, is_secure, expires_utc, name, value"',
    '    " FROM cookies WHERE host_key LIKE ? OR host_key LIKE ?",',
    '    (domain_filter + "%", domain_filter.lstrip(".") + "%")',
    ')',
    'rows = cur.fetchall()',
    'con.close()',
    'lines = ["# Netscape HTTP Cookie File"]',
    'for r in rows:',
    '    host, httponly, p, secure, exp, name, value = r',
    '    unix_exp = max(0, (exp - 11644473600000000) // 1000000) if exp else 0',
    '    flag_host = "TRUE" if host.startswith(".") else "FALSE"',
    '    flag_secure = "TRUE" if secure else "FALSE"',
    '    lines.append("\\t".join([host, flag_host, p, flag_secure, str(unix_exp), name, value]))',
    'open(out, "w").write("\\n".join(lines))',
    'print(f"exported {len(rows)} cookies")',
  ];

  // Escape single quotes in each line for the bash heredoc, then write + run the file
  const escapedLines = scriptLines.map(l => l.replace(/'/g, "'\\''")).join('\\n');
  const execCmd = `docker exec ${containerName} bash -c $'printf "${escapedLines}\\n" > /tmp/_cookie_export.py && python3 /tmp/_cookie_export.py'`;

  try {
    const { stdout, stderr } = await execAsync(execCmd);

    if (stderr && stderr.includes('no-db')) {
      return {
        success: false,
        message: 'Cookie DB not found. Open YouTube in the browser first, then try again.',
      };
    }

    // Verify file was written to host mount
    if (!fs.existsSync(cookiesPath)) {
      return { success: false, message: 'Cookies file was not created. Check browser_data mount.' };
    }

    const lineCount = fs.readFileSync(cookiesPath, 'utf-8').split('\n').filter(l => !l.startsWith('#') && l.trim()).length;
    const summary = stdout.trim() || `${lineCount} cookies`;

    return { success: true, message: `Exported ${lineCount} YouTube cookies to ${cookiesPath}`, cookiesPath };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // If python3 is not available, try a bash fallback using sqlite3 CLI
    try {
      const bashScript = [
        `DB=/config/chromium/Default/Cookies`,
        `OUT=/config/youtube-cookies.txt`,
        `[ -f "$DB" ] || exit 1`,
        `echo '# Netscape HTTP Cookie File' > "$OUT"`,
        `sqlite3 "$DB" "SELECT host_key||'\t'||(CASE WHEN host_key LIKE '.%' THEN 'TRUE' ELSE 'FALSE' END)||'\t'||path||'\t'||(CASE WHEN is_secure THEN 'TRUE' ELSE 'FALSE' END)||'\t'||MAX(0,(expires_utc-11644473600000000)/1000000)||'\t'||name||'\t'||value FROM cookies WHERE host_key LIKE '%youtube%'" >> "$OUT"`,
        `wc -l "$OUT"`,
      ].join(' && ');

      await execAsync(`docker exec ${containerName} bash -c '${bashScript}'`);

      if (!fs.existsSync(cookiesPath)) {
        return { success: false, message: `Failed to export cookies: ${errMsg}` };
      }

      const lineCount = fs.readFileSync(cookiesPath, 'utf-8').split('\n').filter(l => !l.startsWith('#') && l.trim()).length;
      return { success: true, message: `Exported ${lineCount} YouTube cookies`, cookiesPath };
    } catch (fallbackErr) {
      return { success: false, message: `Cookie export failed: ${errMsg}` };
    }
  }
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
