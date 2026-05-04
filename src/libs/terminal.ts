import { exec, spawn, ChildProcess } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

let terminalProcess: ChildProcess | null = null;
let cloudflareUrl = '';
let tunnelProcess: ChildProcess | null = null;
let isTerminalRunning = false;

export async function startTerminal(): Promise<{ url?: string; error?: string }> {
  if (isTerminalRunning && cloudflareUrl) {
    return { url: cloudflareUrl };
  }

  isTerminalRunning = true;

  try {
    console.log('🚀 Setting up Terminal User and dependencies...');
    // Create devuser if it doesn't exist
    try {
      await execAsync('id -u devuser');
    } catch {
      await execAsync('sudo useradd -m -s /bin/bash devuser');
      await execAsync('echo "devuser:devpassword" | sudo chpasswd');
      await execAsync('sudo usermod -aG sudo devuser');
    }

    // Install ttyd if not present
    try {
      await execAsync('which ttyd');
    } catch {
      await execAsync('sudo apt-get update && sudo apt-get install -y ttyd');
    }

    // Start ttyd
    if (terminalProcess) {
      terminalProcess.kill();
    }
    
    console.log('🚀 Starting ttyd...');
    terminalProcess = spawn('sudo', ['ttyd', '-W', '-p', '8080', 'login']);
    
    terminalProcess.on('error', (err) => {
      console.error('❌ ttyd spawn error:', err);
    });

    // Start Cloudflare tunnel for port 8080
    if (tunnelProcess) {
      tunnelProcess.kill();
    }
    
    console.log('🚀 Starting Cloudflare Tunnel for Terminal...');
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:8080']);
    
    return new Promise((resolve) => {
      tunnelProcess!.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          console.log(`✅ Terminal Cloudflare Tunnel URL: ${cloudflareUrl} - Waiting 5 seconds for DNS propagation...`);
          setTimeout(() => {
            resolve({ url: cloudflareUrl });
          }, 5000);
        }
      });

      tunnelProcess!.on('close', (code) => {
        console.log(`⚠️ Terminal Cloudflare Tunnel exited with code ${code}`);
        cloudflareUrl = '';
        isTerminalRunning = false;
      });

      setTimeout(() => {
        if (!cloudflareUrl) {
          isTerminalRunning = false;
          resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 15000);
    });

  } catch (error) {
    isTerminalRunning = false;
    const errMsg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to set up terminal: ${errMsg}` };
  }
}
