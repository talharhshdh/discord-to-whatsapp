import { exec, spawn, ChildProcess } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

// Custom domain configuration for browser (from environment)
const BROWSER_TUNNEL_TOKEN = process.env.BROWSER_TUNNEL_TOKEN || '';
const BROWSER_DOMAIN = process.env.BROWSER_DOMAIN || '';
const BROWSER_USERNAME = process.env.BROWSER_USERNAME || '';
const BROWSER_PASSWORD = process.env.BROWSER_PASSWORD || '';
const BROWSER_PORT = parseInt(process.env.BROWSER_PORT || '10080', 10);

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
    console.log('♻️ General browser already running, returning existing credentials');
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
    // Use hardcoded credentials if available, otherwise generate random ones
    const port = BROWSER_PORT || (10080 + browserInstances.size);
    const username = BROWSER_USERNAME || `dev_${crypto.randomBytes(3).toString('hex')}`;
    const password = BROWSER_PASSWORD || crypto.randomBytes(6).toString('hex');
    
    console.log(`🚀 Setting up Browser on port ${port}${targetUrl ? ` for ${targetUrl}` : ''}...`);
    if (BROWSER_USERNAME && BROWSER_PASSWORD) {
      console.log(`🔐 Using hardcoded credentials from environment`);
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
        console.log('⚠️ Stopping existing browser container...');
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
      '-e', 'TZ=Etc/UTC',
      '-e', `CUSTOM_USER=${username}`,
      '-e', `PASSWORD=${password}`,
    ];

    // Add custom URL if provided
    if (targetUrl) {
      dockerCmd.push('-e', `CUSTOM_URL=${targetUrl}`);
    }

    dockerCmd.push('lscr.io/linuxserver/chromium:latest');

    console.log(`🚀 Starting browser container...`);
    await execAsync(dockerCmd.join(' '));

    // ── Mode 1: Named tunnel with fixed custom domain ──────────────────────────
    if (BROWSER_TUNNEL_TOKEN && BROWSER_DOMAIN) {
      return new Promise((resolve) => {
        console.log(`🌐 Starting named Cloudflare tunnel for Browser → https://${BROWSER_DOMAIN}`);
        
        const tunnelProcess = spawn('cloudflared', [
          'tunnel', '--no-autoupdate', 'run', '--token', BROWSER_TUNNEL_TOKEN,
        ]);
        
        tunnelProcess.stderr?.on('data', (data: Buffer) => {
          console.log('[cloudflared-browser]', data.toString().trim());
        });
        
        tunnelProcess.on('error', (e) => {
          console.error('❌ Named browser tunnel error:', e);
          execAsync(`docker stop ${containerName}`).catch(() => {});
          resolve({ error: `Named tunnel error: ${e.message}` });
        });
        
        tunnelProcess.on('close', (code) => {
          console.log(`⚠️ Named browser tunnel exited with code ${code}`);
          const instanceId = targetUrl || 'general';
          browserInstances.delete(instanceId);
        });
        
        // With named tunnels the URL is known immediately — no need to parse output.
        // Give cloudflared 5s to initialise before resolving.
        setTimeout(() => {
          const cloudflareUrl = `https://${BROWSER_DOMAIN}`;
          console.log(`✅ Browser at fixed domain: ${cloudflareUrl}`);
          
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
    console.log(`🚀 Starting Cloudflare Tunnel on port ${port}...`);
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
          console.log(`✅ Browser Tunnel URL: ${cloudflareUrl}`);
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
        console.log(`⚠️ Browser Tunnel exited with code ${code}`);
        const instanceId = targetUrl || 'general';
        browserInstances.delete(instanceId);
      });

      setTimeout(() => {
        if (!cloudflareUrl) {
           execAsync(`docker stop ${containerName}`).catch(() => {});
           resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 15000);
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to set up browser: ${errMsg}` };
  }
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
