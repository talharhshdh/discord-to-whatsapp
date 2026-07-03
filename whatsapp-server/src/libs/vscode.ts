import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

let nextPort = 9080;

interface VSCodeInstance {
  vscodeProcess: any;
  tunnelProcess: any;
  port: number;
}

const vscodeInstances = new Map<string, VSCodeInstance>();

export async function startVSCode(): Promise<{ url?: string; password?: string; error?: string }> {
  try {
    const sessionId = `vscode-${crypto.randomBytes(4).toString('hex')}`;
    const port = nextPort++;
    const password = crypto.randomBytes(6).toString('hex');


    // Install code-server if not present
    try {
      await execAsync('which code-server');
    } catch {
      await execAsync('curl -fsSL https://code-server.dev/install.sh | sh');
    }

    // Run code-server with password
    const vscodeProcess = spawn('code-server', ['--bind-addr', `127.0.0.1:${port}`, '--auth', 'password'], {
      env: { ...process.env, PASSWORD: password }
    });

    vscodeProcess.on('error', (err) => {
      console.error(`❌ code-server spawn error:`, err);
    });

    const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);

    // Track instance processes
    vscodeInstances.set(sessionId, { vscodeProcess, tunnelProcess, port });

    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];

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
        sessionManager.removeSession(sessionId);
        vscodeInstances.delete(sessionId);
        try {
          vscodeProcess.kill('SIGTERM');
        } catch {}
      });

      vscodeProcess.on('close', (code) => {
        sessionManager.removeSession(sessionId);
        vscodeInstances.delete(sessionId);
        try {
          tunnelProcess.kill('SIGTERM');
        } catch {}
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

export async function stopVSCode(sessionId: string): Promise<{ success: boolean; message: string }> {
  try {
    const instance = vscodeInstances.get(sessionId);
    if (!instance) {
      sessionManager.removeSession(sessionId);
      return { success: true, message: 'VSCode session removed from session manager' };
    }

    try {
      instance.vscodeProcess.kill('SIGTERM');
    } catch (e) {
      console.error(`Failed to kill vscodeProcess:`, e);
    }
    try {
      instance.tunnelProcess.kill('SIGTERM');
    } catch (e) {
      console.error(`Failed to kill tunnelProcess:`, e);
    }

    vscodeInstances.delete(sessionId);
    sessionManager.removeSession(sessionId);

    // Unregister URL if registered
    try {
      const { unregisterUrl } = require('./dashboard-server');
      unregisterUrl('vscode');
    } catch (e) {
      console.error('Failed to unregister URL:', e);
    }

    return { success: true, message: 'VSCode session stopped successfully' };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Failed to stop VSCode: ${errMsg}` };
  }
}
