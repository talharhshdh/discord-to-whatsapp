import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

let nextPort = 9080;

export async function startVSCode(): Promise<{ url?: string; password?: string; error?: string }> {
  try {
    const sessionId = `vscode-${crypto.randomBytes(4).toString('hex')}`;
    const port = nextPort++;
    const password = crypto.randomBytes(6).toString('hex');

    console.log(`🚀 Setting up VSCode Server on port ${port}...`);

    // Install code-server if not present
    try {
      await execAsync('which code-server');
    } catch {
      console.log('🚀 Installing code-server...');
      await execAsync('curl -fsSL https://code-server.dev/install.sh | sh');
    }

    console.log(`🚀 Starting code-server on port ${port}...`);
    // Run code-server with password
    const vscodeProcess = spawn('code-server', ['--bind-addr', `127.0.0.1:${port}`, '--auth', 'password'], {
      env: { ...process.env, PASSWORD: password }
    });
    
    vscodeProcess.on('error', (err) => {
      console.error(`❌ code-server spawn error:`, err);
    });

    console.log(`🚀 Starting Cloudflare Tunnel for VSCode on port ${port}...`);
    const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);
    
    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          console.log(`✅ VSCode Cloudflare Tunnel URL: ${cloudflareUrl} - Waiting 5 seconds...`);
          
          // Register session with cloudflared URL
          sessionManager.addSession({
            id: sessionId,
            type: 'vscode',
            url: cloudflareUrl,
            password,
            startedAt: new Date(),
            metadata: {
              port,
              cloudflaredUrl: cloudflareUrl,
            },
          });
          
          setTimeout(() => {
            resolve({ url: cloudflareUrl, password });
          }, 5000);
        }
      });

      tunnelProcess.on('close', (code) => {
        console.log(`⚠️ VSCode Cloudflare Tunnel exited with code ${code}`);
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
    return { error: `Failed to set up VSCode: ${errMsg}` };
  }
}
