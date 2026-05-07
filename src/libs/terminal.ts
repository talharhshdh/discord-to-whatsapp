import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

let nextPort = 8080;

export async function startTerminal(): Promise<{ url?: string; username?: string; password?: string; error?: string }> {
  try {
    const sessionId = `terminal-${crypto.randomBytes(4).toString('hex')}`;
    const port = nextPort++;
    const username = `dev_${crypto.randomBytes(3).toString('hex')}`;
    const password = crypto.randomBytes(6).toString('hex');

    console.log(`🚀 Setting up Terminal User ${username} on port ${port}...`);

    // Create the random user
    await execAsync(`sudo useradd -m -s /bin/bash ${username}`);
    await execAsync(`echo "${username}:${password}" | sudo chpasswd`);
    await execAsync(`sudo usermod -aG sudo ${username}`);

    // Install ttyd if not present
    try {
      await execAsync('which ttyd');
    } catch {
      await execAsync('sudo apt-get update && sudo apt-get install -y ttyd');
    }

    console.log(`🚀 Starting ttyd for ${username} on port ${port}...`);
    const terminalProcess = spawn('sudo', ['ttyd', '-W', '-p', port.toString(), 'login']);

    terminalProcess.on('error', (err) => {
      console.error(`❌ ttyd spawn error for ${username}:`, err);
    });

    console.log(`🚀 Starting Cloudflare Tunnel for port ${port}...`);
    const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);

    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          console.log(`✅ Terminal Cloudflare Tunnel URL for ${username}: ${cloudflareUrl} - Waiting 5 seconds...`);

          // Register session with cloudflared URL
          sessionManager.addSession({
            id: sessionId,
            type: 'terminal',
            url: cloudflareUrl,
            username,
            password,
            startedAt: new Date(),
            metadata: {
              port,
              cloudflaredUrl: cloudflareUrl,
            },
          });

          setTimeout(() => {
            resolve({ url: cloudflareUrl, username, password });
          }, 5000);
        }
      });

      tunnelProcess.on('close', (code) => {
        console.log(`⚠️ Terminal Cloudflare Tunnel for ${username} exited with code ${code}`);
        sessionManager.removeSession(sessionId);
      });

      setTimeout(() => {
        if (!cloudflareUrl) {
          resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 15000);
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to set up terminal: ${errMsg}` };
  }
}
