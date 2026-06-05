import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

function getSanitizedEnv(key: string): string {
  const raw = process.env[key];
  if (!raw) return '';
  return raw.trim().replace(/^['"]|['"]$/g, '').replace(/;$/, '').trim();
}

let nextPort = 15000;

export async function startCustomContainer(
  image: string,
  containerPort: number,
  env: Record<string, string>,
  name?: string,
  domainMode: 'quick' | 'custom' = 'quick',
  customDomain?: string,
  requestedHostPort?: number,
  tunnelToken?: string,
  existingSessionId?: string
): Promise<{ url?: string; containerName?: string; error?: string }> {
  try {
    // Check docker version first to verify docker is installed
    try {
      await execAsync('docker --version');
    } catch {
      return { error: 'Docker is not installed or not running on the host system.' };
    }

    const hash = existingSessionId ? existingSessionId.replace(/^docker-/, '') : crypto.randomBytes(4).toString('hex');
    const sessionId = existingSessionId || `docker-${hash}`;
    const webhookSecret = existingSessionId 
      ? (sessionManager.getSession(existingSessionId)?.metadata?.webhookSecret || crypto.randomBytes(16).toString('hex'))
      : crypto.randomBytes(16).toString('hex');
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
      const hostname = targetUrl.replace(/^https?:\/\//, '');
      console.log(`[Docker Deploy] Custom domain configured: ${targetUrl} (hostname: ${hostname})`);

      const ACCOUNT_ID = getSanitizedEnv('CLOUDFLARE_ACCOUNT_ID');
      const ZONE_ID = getSanitizedEnv('CLOUDFLARE_ZONE_ID');
      const API_TOKEN = getSanitizedEnv('CLOUDFLARE_API_TOKEN');

      let activeTunnelToken = tunnelToken;
      let activeTunnelId = '';

      // Check if domain has changed for an existing session with a tunnel
      const existingSession = existingSessionId ? sessionManager.getSession(existingSessionId) : null;
      const oldDomain = existingSession?.metadata?.customDomain;
      const oldTunnelId = existingSession?.metadata?.tunnelId;

      if (activeTunnelToken && oldTunnelId && oldDomain && oldDomain !== targetUrl) {
        if (!ACCOUNT_ID || !ZONE_ID || !API_TOKEN) {
          console.warn('[Docker Deploy] Domain changed but missing Cloudflare API credentials to update routing.');
        } else {
          try {
            console.log(`[Docker Deploy] Domain changed from ${oldDomain} to ${targetUrl}. Updating Cloudflare...`);
            
            // 1. Delete old DNS CNAME
            const oldHostname = oldDomain.replace(/^https?:\/\//, '');
            const oldDnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${oldHostname}&type=CNAME`, {
              headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
            });
            const oldDnsData = await oldDnsRes.json() as any;
            if (oldDnsData.success && oldDnsData.result && oldDnsData.result.length > 0) {
              const oldDnsRecordId = oldDnsData.result[0].id;
              await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${oldDnsRecordId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
              });
              console.log(`[Docker Deploy] Deleted old CNAME record for ${oldHostname}`);
            }

            // 2. Update Ingress configuration on existing tunnel
            const configRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${oldTunnelId}/configurations`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                config: {
                  ingress: [
                    { hostname: hostname, service: `http://localhost:${hostPort}` },
                    { service: 'http_status:404' }
                  ]
                }
              })
            });
            const configData = await configRes.json() as any;
            if (!configData.success) throw new Error(`Routing update failed: ${JSON.stringify(configData.errors)}`);
            console.log('[Docker Deploy] Updated ingress routing on Cloudflare tunnel.');

            // 3. Upsert CNAME record for new domain
            const dnsListRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${hostname}&type=CNAME`, {
              headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
            });
            const dnsListData = await dnsListRes.json() as any;
            let dnsRecordId = '';
            if (dnsListData.success && dnsListData.result && dnsListData.result.length > 0) {
              dnsRecordId = dnsListData.result[0].id;
            }

            const dnsUrl = dnsRecordId 
              ? `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${dnsRecordId}`
              : `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`;
            const dnsMethod = dnsRecordId ? 'PUT' : 'POST';

            const dnsRes = await fetch(dnsUrl, {
              method: dnsMethod,
              headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                type: 'CNAME',
                name: hostname,
                content: `${oldTunnelId}.cfargotunnel.com`,
                proxied: true
              })
            });
            const dnsData = await dnsRes.json() as any;
            if (!dnsData.success) {
              console.warn('⚠️ DNS record creation/update failed:', dnsData.errors);
            } else {
              console.log(`[Docker Deploy] DNS Record mapped ${hostname} to tunnel ${oldTunnelId}`);
            }

            activeTunnelId = oldTunnelId;
          } catch (err: any) {
            console.error('[Docker Deploy] Error updating domain routing:', err);
          }
        }
      }

      // If no tunnel token is provided, and we have Cloudflare credentials, auto-generate the tunnel
      if (!activeTunnelToken) {
        if (!ACCOUNT_ID || !ZONE_ID || !API_TOKEN) {
          return { error: 'Missing Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN) in environment to auto-configure custom domain.' };
        }

        try {
          console.log('[Docker Deploy] Auto-configuring Cloudflare Tunnel...');
          const tunnelSecret = crypto.randomBytes(32).toString('base64');
          const tunnelName = `tunnel-${cleanName}-${hash}`.substring(0, 120);

          // 1. Create Tunnel
          const tunnelRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: tunnelName,
              tunnel_secret: tunnelSecret
            })
          });
          const tunnelData = await tunnelRes.json() as any;
          if (!tunnelData.success) {
            return { error: `Cloudflare tunnel creation failed: ${JSON.stringify(tunnelData.errors)}` };
          }
          activeTunnelId = tunnelData.result.id;
          console.log(`[Docker Deploy] Cloudflare Tunnel Created: ${activeTunnelId}`);

          // 2. Configure Ingress Rules
          const configRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${activeTunnelId}/configurations`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              config: {
                ingress: [
                  { hostname: hostname, service: `http://localhost:${hostPort}` },
                  { service: 'http_status:404' }
                ]
              }
            })
          });
          const configData = await configRes.json() as any;
          if (!configData.success) {
            return { error: `Cloudflare tunnel configuration failed: ${JSON.stringify(configData.errors)}` };
          }
          console.log('[Docker Deploy] Cloudflare Ingress Rules configured.');

          // 3. Create or Update DNS CNAME record
          const dnsListRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${hostname}&type=CNAME`, {
            headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
          });
          const dnsListData = await dnsListRes.json() as any;
          let dnsRecordId = '';
          if (dnsListData.success && dnsListData.result && dnsListData.result.length > 0) {
            dnsRecordId = dnsListData.result[0].id;
          }

          const dnsUrl = dnsRecordId 
            ? `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${dnsRecordId}`
            : `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`;
          const dnsMethod = dnsRecordId ? 'PUT' : 'POST';

          const dnsRes = await fetch(dnsUrl, {
            method: dnsMethod,
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              type: 'CNAME',
              name: hostname,
              content: `${activeTunnelId}.cfargotunnel.com`,
              proxied: true
            })
          });
          const dnsData = await dnsRes.json() as any;
          if (!dnsData.success) {
            console.warn('⚠️ DNS record creation/update failed:', dnsData.errors);
          } else {
            console.log(`[Docker Deploy] DNS Record mapped ${hostname} to ${activeTunnelId}.cfargotunnel.com`);
          }

          // 4. Construct Tunnel Token
          const tokenPayload = { a: ACCOUNT_ID, t: activeTunnelId, s: tunnelSecret };
          activeTunnelToken = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');
        } catch (err: any) {
          return { error: `Failed during Cloudflare API calls: ${err.message}` };
        }
      } else {
        if (!activeTunnelId && activeTunnelToken) {
          try {
            const decoded = JSON.parse(Buffer.from(activeTunnelToken, 'base64').toString('utf8'));
            activeTunnelId = decoded.t;
          } catch {
            // ignore
          }
        }
      }

      let tunnelProcess: any = null;
      if (activeTunnelToken) {
        console.log(`[Docker Deploy] Starting Cloudflare Named Tunnel for ${targetUrl}...`);
        tunnelProcess = spawn('cloudflared', [
          'tunnel', '--no-autoupdate', 'run', '--token', activeTunnelToken
        ]);

        tunnelProcess.on('close', (code: any) => {
          console.log(`[Docker Deploy] Named tunnel closed with code ${code}`);
          const currentSession = sessionManager.getSession(sessionId);
          if (currentSession?.metadata?.tunnelPid === tunnelProcess.pid) {
            sessionManager.removeSession(sessionId);
          } else {
            console.log(`[Docker Deploy] Old tunnel closed for session ${sessionId}, ignoring removal.`);
          }
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
          tunnelToken: activeTunnelToken,
          tunnelId: activeTunnelId,
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
        const currentSession = sessionManager.getSession(sessionId);
        if (currentSession?.metadata?.tunnelPid === tunnelProcess.pid) {
          sessionManager.removeSession(sessionId);
        } else {
          console.log(`[Docker Deploy] Old quick tunnel closed for session ${sessionId}, ignoring removal.`);
        }
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
      }

      if (domainMode === 'custom') {
        if (tunnelToken) {
         const tunnelProcess = spawn('cloudflared', [
            'tunnel', '--no-autoupdate', 'run', '--token', tunnelToken
          ]);

          tunnelProcess.on('close', () => {
            const currentSession = sessionManager.getSession(session.id);
            if (currentSession?.metadata?.tunnelPid === tunnelProcess.pid) {
              sessionManager.removeSession(session.id);
            } else {
              console.log(`[Docker Restore] Old tunnel closed for session ${session.id}, ignoring removal.`);
            }
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
        const currentSession = sessionManager.getSession(session.id);
        if (currentSession?.metadata?.tunnelPid === tunnelProcess.pid) {
          sessionManager.removeSession(session.id);
        } else {
          console.log(`[Docker Restore] Old quick tunnel closed for session ${session.id}, ignoring removal.`);
        }
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

export async function stopCustomContainer(sessionId: string): Promise<{ success: boolean; message: string }> {
  const session = sessionManager.getSession(sessionId);
  if (!session || session.type !== 'docker-container') {
    return { success: false, message: 'Docker session not found' };
  }

  const meta = session.metadata as any;
  if (meta) {
    const { containerName, tunnelPid, tunnelId, customDomain } = meta;

    // 1. Stop container
    if (containerName) {
      try {
        await execAsync(`docker stop ${containerName}`);
        console.log(`[Docker Stop] Stopped container ${containerName}`);
      } catch (e: any) {
        console.error(`[Docker Stop] Failed to stop container ${containerName}:`, e);
      }
    }

    // 2. Kill tunnel process
    if (tunnelPid) {
      try {
        process.kill(tunnelPid);
        console.log(`[Docker Stop] Killed tunnel process PID ${tunnelPid}`);
      } catch (e) {
        // ignore
      }
    }

    // 3. Delete Cloudflare Tunnel & DNS CNAME if created programmatically
    const ACCOUNT_ID = getSanitizedEnv('CLOUDFLARE_ACCOUNT_ID');
    const ZONE_ID = getSanitizedEnv('CLOUDFLARE_ZONE_ID');
    const API_TOKEN = getSanitizedEnv('CLOUDFLARE_API_TOKEN');

    if (tunnelId && ACCOUNT_ID && API_TOKEN) {
      try {
        console.log(`[Docker Stop] Deleting Cloudflare tunnel ${tunnelId}...`);
        
        // Wait a brief moment to ensure the tunnel process is fully terminated and disconnected
        await new Promise(resolve => setTimeout(resolve, 2000));

        const delRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        const delData = await delRes.json() as any;
        if (delData.success) {
          console.log(`[Docker Stop] Successfully deleted Cloudflare tunnel ${tunnelId}`);
        } else {
          console.warn(`[Docker Stop] Failed to delete Cloudflare tunnel:`, delData.errors);
        }
      } catch (err) {
        console.error(`[Docker Stop] Error deleting Cloudflare tunnel:`, err);
      }
    }

    if (customDomain && ZONE_ID && API_TOKEN) {
      try {
        const hostname = customDomain.replace(/^https?:\/\//, '');
        console.log(`[Docker Stop] Cleaning up DNS CNAME record for ${hostname}...`);

        // Find DNS record ID
        const dnsListRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${hostname}&type=CNAME`, {
          headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        const dnsListData = await dnsListRes.json() as any;
        if (dnsListData.success && dnsListData.result && dnsListData.result.length > 0) {
          const dnsRecordId = dnsListData.result[0].id;
          const delDnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${dnsRecordId}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
          const delDnsData = await delDnsRes.json() as any;
          if (delDnsData.success) {
            console.log(`[Docker Stop] Successfully deleted CNAME record for ${hostname}`);
          } else {
            console.warn(`[Docker Stop] Failed to delete CNAME record:`, delDnsData.errors);
          }
        }
      } catch (err) {
        console.error(`[Docker Stop] Error cleaning up CNAME record:`, err);
      }
    }
  }

  sessionManager.removeSession(sessionId);
  return { success: true, message: 'Docker container stopped and resources cleaned up.' };
}
