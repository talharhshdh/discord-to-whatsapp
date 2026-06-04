import { exec, spawn, ChildProcess } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

let nextPort = 15000;

export async function startCustomContainer(
  image: string,
  containerPort: number,
  env: Record<string, string>,
  name?: string
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
    const cleanName = (name || 'custom-app').replace(/[^a-zA-Z0-9_-]/g, '_');
    const containerName = `docker-custom-${cleanName}-${hash}`;
    const hostPort = nextPort++;

    // Format env parameters
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (k && v) {
        envArgs.push('-e', `${k}=${v}`);
      }
    }

    console.log(`[Docker Deploy] Pulling image ${image}...`);
    // Ensure image is pulled
    await execAsync(`docker pull ${image}`);

    console.log(`[Docker Deploy] Running container ${containerName} on host port ${hostPort}...`);
    // Run container
    const dockerCmd = [
      'docker', 'run', '-d', '--rm',
      '--name', containerName,
      '-p', `${hostPort}:${containerPort}`,
      ...envArgs,
      image
    ];

    const { stdout } = await execAsync(dockerCmd.join(' '));
    console.log(`[Docker Deploy] Container started with ID: ${stdout.trim()}`);

    // Spawn Cloudflare Tunnel
    console.log(`[Docker Deploy] Exposing port ${hostPort} via Cloudflare Tunnel...`);
    const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${hostPort}`]);

    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          console.log(`[Docker Deploy] Live tunnel URL: ${cloudflareUrl}`);

          // Register in Session Manager
          sessionManager.addSession({
            id: sessionId,
            type: 'docker-container', 
            url: cloudflareUrl,
            startedAt: new Date(),
            metadata: {
              port: hostPort,
              containerName,
              targetUrl: image, // Show docker image name in UI
              tunnelProcess,
              tunnelPid: tunnelProcess.pid,
              cloudflaredUrl: cloudflareUrl,
            },
          });

          // Give tunnel a moment to stabilize
          setTimeout(() => {
            resolve({ url: cloudflareUrl, containerName });
          }, 3000);
        }
      });

      tunnelProcess.on('close', (code) => {
        console.log(`[Docker Deploy] Cloudflare tunnel process closed with code ${code}`);
        sessionManager.removeSession(sessionId);
      });

      // Timeout safety
      setTimeout(async () => {
        if (!cloudflareUrl) {
          console.error('[Docker Deploy] Cloudflare tunnel setup timed out.');
          // Stop container to avoid resource leaks
          try {
            await execAsync(`docker stop ${containerName}`);
          } catch {
            // ignore
          }
          try {
            tunnelProcess.kill();
          } catch {
            // ignore
          }
          resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 30000);
    });

  } catch (error: any) {
    console.error('❌ Failed to deploy custom container:', error);
    return { error: error.message || 'Unknown error occurred during container deployment.' };
  }
}
