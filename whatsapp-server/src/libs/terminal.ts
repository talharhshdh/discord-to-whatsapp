import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

let nextPort = 8080;

interface TerminalInstance {
  terminalProcess: any;
  tunnelProcess: any;
  port: number;
  username: string;
}

const terminalInstances = new Map<string, TerminalInstance>();

export async function startTerminal(): Promise<{ url?: string; username?: string; password?: string; error?: string }> {
  try {
    const sessionId = `terminal-${crypto.randomBytes(4).toString('hex')}`;
    const port = nextPort++;
    const username = `dev_${crypto.randomBytes(3).toString('hex')}`;
    const password = crypto.randomBytes(6).toString('hex');


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

    const terminalProcess = spawn('sudo', ['ttyd', '-W', '-p', port.toString(), 'login']);

    terminalProcess.on('error', (err) => {
      console.error(`❌ ttyd spawn error for ${username}:`, err);
    });

    const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);

    // Track the instance processes
    terminalInstances.set(sessionId, { terminalProcess, tunnelProcess, port, username });

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
        sessionManager.removeSession(sessionId);
        terminalInstances.delete(sessionId);
        try {
          terminalProcess.kill('SIGTERM');
        } catch {}
      });

      terminalProcess.on('close', (code) => {
        sessionManager.removeSession(sessionId);
        terminalInstances.delete(sessionId);
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
    return { error: `Failed to set up terminal: ${errMsg}` };
  }
}

export async function stopTerminal(sessionId: string): Promise<{ success: boolean; message: string }> {
  try {
    const instance = terminalInstances.get(sessionId);
    if (!instance) {
      sessionManager.removeSession(sessionId);
      return { success: true, message: 'Terminal session removed from session manager' };
    }

    try {
      instance.terminalProcess.kill('SIGTERM');
    } catch (e) {
      console.error(`Failed to kill terminalProcess:`, e);
    }
    try {
      instance.tunnelProcess.kill('SIGTERM');
    } catch (e) {
      console.error(`Failed to kill tunnelProcess:`, e);
    }

    // Clean up created user in background
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      await execAsync(`sudo pkill -u ${instance.username}`);
      await execAsync(`sudo userdel -r ${instance.username}`);
    } catch (e) {
      console.error(`Failed to delete user ${instance.username}:`, e);
    }

    terminalInstances.delete(sessionId);
    sessionManager.removeSession(sessionId);

    // Unregister URL if registered
    try {
      const { unregisterUrl } = require('./dashboard-server');
      unregisterUrl('terminal');
    } catch (e) {
      console.error('Failed to unregister URL:', e);
    }

    return { success: true, message: 'Terminal session stopped successfully' };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Failed to stop terminal: ${errMsg}` };
  }
}
