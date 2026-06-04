import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

let nextPort = 15000;

export async function startCustomContainer(
  image: string,
  containerPort: number,
  env: Record<string, string>,
  name?: string,
  domainMode: 'quick' | 'custom' = 'quick',
  customDomain?: string,
  requestedHostPort?: number,
  tunnelToken?: string
): Promise<{ url?: string; containerName?: string; error?: string }> {
  try {
    // Check docker version first to verify docker is installed
    try {
      await execAsync('docker --version');
    } catch {
      return { error: 'Docker is not installed or not running on the host system.' };
    }

    const hash = crypto.randomBytes(4).toString('hex');
    const sessionId = `docker-${hash}`;
    const webhookSecret = crypto.randomBytes(16).toString('hex');
    const cleanName = (name || 'custom-app').replace(/[^a-zA-Z0-9_-]/g, '_');
    const containerName = `docker-custom-${cleanName}-${hash}`;
    const hostPort = requestedHostPort && requestedHostPort > 0 ? requestedHostPort : nextPort++;

    // Format env parameters
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (k && v) {
        envArgs.push('-e', `${k}=${v}`);
      }
    }

    console.log(`[Docker Deploy] Pulling image ${image}...`);
    await execAsync(`docker pull ${image}`);

    console.log(`[Docker Deploy] Running container ${containerName} on host port ${hostPort}...`);
    const dockerCmd = [
      'docker', 'run', '-d', '--rm',
      '--name', containerName,
      '-p', `${hostPort}:${containerPort}`,
      ...envArgs,
      image
    ];

    await execAsync(dockerCmd.join(' '));

    if (domainMode === 'custom') {
      if (!customDomain) {
        return { error: 'Custom domain is required when domain mode is custom.' };
      }
      const targetUrl = customDomain.startsWith('http') ? customDomain : `https://${customDomain}`;
      console.log(`[Docker Deploy] Custom domain configured: ${targetUrl}`);

      let tunnelProcess: any = null;
      if (tunnelToken) {
        console.log(`[Docker Deploy] Starting Cloudflare Named Tunnel for ${targetUrl}...`);
        tunnelProcess = spawn('cloudflared', [
          'tunnel', '--no-autoupdate', 'run', '--token', tunnelToken
        ]);

        tunnelProcess.on('close', (code: any) => {
          console.log(`[Docker Deploy] Named tunnel closed with code ${code}`);
          sessionManager.removeSession(sessionId);
        });
      }

      sessionManager.addSession({
        id: sessionId,
        type: 'docker-container',
        url: targetUrl,
        startedAt: new Date(),
        metadata: {
          port: containerPort,
          hostPort,
          containerName,
          image,
          env,
          domainMode,
          customDomain: targetUrl,
          cloudflaredUrl: targetUrl,
          tunnelPid: tunnelProcess ? tunnelProcess.pid : undefined,
          tunnelToken,
          webhookSecret,
        },
      });

      return { url: targetUrl, containerName };
    }

    // Spawn Cloudflare Tunnel (Quick Tunnel)
    console.log(`[Docker Deploy] Exposing port ${hostPort} via Cloudflare Quick Tunnel...`);
    const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${hostPort}`]);

    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          console.log(`[Docker Deploy] Live tunnel URL: ${cloudflareUrl}`);

          sessionManager.addSession({
            id: sessionId,
            type: 'docker-container',
            url: cloudflareUrl,
            startedAt: new Date(),
            metadata: {
              port: containerPort,
              hostPort,
              containerName,
              image,
              env,
              domainMode,
              webhookSecret,
              cloudflaredUrl: cloudflareUrl,
              tunnelPid: tunnelProcess.pid,
            },
          });

          setTimeout(() => {
            resolve({ url: cloudflareUrl, containerName });
          }, 3000);
        }
      });

      tunnelProcess.on('close', (code) => {
        console.log(`[Docker Deploy] Cloudflare tunnel process closed with code ${code}`);
        sessionManager.removeSession(sessionId);
      });

      setTimeout(async () => {
        if (!cloudflareUrl) {
          console.error('[Docker Deploy] Cloudflare tunnel setup timed out.');
          try { await execAsync(`docker stop ${containerName}`); } catch {}
          try { tunnelProcess.kill(); } catch {}
          resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 30000);
    });

  } catch (error: any) {
    console.error('❌ Failed to deploy custom container:', error);
    return { error: error.message || 'Unknown error occurred during container deployment.' };
  }
}

export async function restoreDockerContainers(): Promise<void> {
  console.log('[Docker Restore] Checking for container sessions to restore...');
  const sessions = sessionManager.getAllSessions().filter(s => s.type === 'docker-container');
  if (sessions.length === 0) {
    console.log('[Docker Restore] No container sessions found to restore.');
    return;
  }

  for (const session of sessions) {
    try {
      const meta = session.metadata as any;
      if (!meta) continue;

      const { containerName, image, port, hostPort, env, domainMode, customDomain, tunnelToken } = meta;
      if (!containerName || !image) continue;

      // Check if container is running
      let isRunning = false;
      try {
        const { stdout } = await execAsync(`docker ps --filter name=${containerName} --format "{{.Names}}"`);
        if (stdout.trim() === containerName) {
          isRunning = true;
        }
      } catch (err) {
        // ignore
      }

      if (isRunning) {
        console.log(`[Docker Restore] Container ${containerName} is already running.`);
      } else {
        console.log(`[Docker Restore] Restoring container ${containerName} (${image})...`);
        
        // Pull image just in case
        try { await execAsync(`docker pull ${image}`); } catch {}

        const envArgs: string[] = [];
        if (env) {
          for (const [k, v] of Object.entries(env)) {
            if (k && v) {
              envArgs.push('-e', `${k}=${v}`);
            }
          }
        }

        const dockerCmd = [
          'docker', 'run', '-d', '--rm',
          '--name', containerName,
          '-p', `${hostPort}:${port}`,
          ...envArgs,
          image
        ];

        await execAsync(dockerCmd.join(' '));
        console.log(`[Docker Restore] Container ${containerName} started on port ${hostPort}.`);
      }

      if (domainMode === 'custom') {
        if (tunnelToken) {
          console.log(`[Docker Restore] Restarting Cloudflare Named Tunnel for custom domain ${customDomain}...`);
          const tunnelProcess = spawn('cloudflared', [
            'tunnel', '--no-autoupdate', 'run', '--token', tunnelToken
          ]);

          tunnelProcess.on('close', () => {
            sessionManager.removeSession(session.id);
          });

          session.metadata = {
            ...session.metadata,
            tunnelProcess,
            tunnelPid: tunnelProcess.pid
          };
          sessionManager.updateSessionMetadata(session.id, {
            tunnelPid: tunnelProcess.pid
          });
        } else {
          console.log(`[Docker Restore] Custom domain preserved without named tunnel: ${customDomain}`);
        }
        continue;
      }

      // If quick tunnel, we need to spawn a new quick tunnel process
      console.log(`[Docker Restore] Restarting Cloudflare Quick Tunnel for port ${hostPort}...`);
      const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${hostPort}`]);

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match) {
          const newUrl = match[0];
          console.log(`[Docker Restore] New quick tunnel URL: ${newUrl}`);
          sessionManager.updateSessionUrl(session.id, newUrl);
          sessionManager.updateSessionMetadata(session.id, {
            cloudflaredUrl: newUrl,
            tunnelPid: tunnelProcess.pid
          });
        }
      });

      tunnelProcess.on('close', () => {
        sessionManager.removeSession(session.id);
      });

      // Bind dynamic tunnel process object to in-memory session (if desired)
      session.metadata = {
        ...session.metadata,
        tunnelProcess,
        tunnelPid: tunnelProcess.pid
      };

    } catch (restoreErr) {
      console.error(`[Docker Restore] Failed to restore session ${session.id}:`, restoreErr);
    }
  }
}
