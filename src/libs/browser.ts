import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';

const execAsync = util.promisify(exec);

let nextPort = 10080;

export async function startBrowser(): Promise<{ url?: string; username?: string; password?: string; error?: string }> {
  try {
    const port = nextPort++;
    const username = `dev_${crypto.randomBytes(3).toString('hex')}`;
    const password = crypto.randomBytes(6).toString('hex');
    
    console.log(`🚀 Setting up Cloud Browser Server on port ${port}...`);

    // Ensure Docker is available
    try {
      await execAsync('docker --version');
    } catch {
      return { error: 'Docker is not installed or available. Required for virtual browser.' };
    }

    // Run linuxserver/chromium container
    console.log(`🚀 Starting lscr.io/linuxserver/chromium on port ${port}...`);
    
    // We run it detached (-d). Map port 3000 to our local port and mount a host volume.
    const containerName = `cloud-browser-${port}`;
    await execAsync(`docker run -d --rm --name ${containerName} -v /home/runner/chromium_data:/config --shm-size=1gb -p ${port}:3000 -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC -e CUSTOM_USER=${username} -e PASSWORD=${password} lscr.io/linuxserver/chromium:latest`);

    console.log(`🚀 Starting Cloudflare Tunnel for Browser on port ${port}...`);
    // The linuxserver web UI runs on HTTP on port 3000 inside the container.
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
          console.log(`✅ Browser Cloudflare Tunnel URL: ${cloudflareUrl} - Waiting 5 seconds...`);
          setTimeout(() => {
            resolve({ url: cloudflareUrl, username, password });
          }, 5000);
        }
      });

      tunnelProcess.on('close', (code) => {
        console.log(`⚠️ Browser Cloudflare Tunnel exited with code ${code}`);
      });

      setTimeout(() => {
        if (!cloudflareUrl) {
           // Try to stop the container if tunnel fails
           execAsync(`docker stop ${containerName}`).catch(() => {});
           resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 15000);
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to set up virtual browser: ${errMsg}` };
  }
}
