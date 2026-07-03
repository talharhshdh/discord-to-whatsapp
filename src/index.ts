import * as dotenv from 'dotenv';
import { startDashboard, registerUrl } from './libs/dashboard-server';
import { browserPool } from './libs/browser-pool';

dotenv.config();

const lol = (...db: any) => { console.log(...db); }

class MainServer {
  private googleSearchKeeperInterval: NodeJS.Timeout | null = null;

  constructor() {
    lol(`🚀 Main Dashboard Server starting...`);
    this.startDashboardAndNotify();
  }

  private async startDashboardAndNotify(): Promise<void> {
    try {
      lol('📊 Starting dashboard server...');

      const { getCloudflareTunnelUrl } = require('./libs/cloudflared');
      const novncUrl: string = await getCloudflareTunnelUrl(6080);
      if (novncUrl) {
        registerUrl('novnc', '🖥️ noVNC Desktop', novncUrl);
      }

      registerUrl('bypasser', '⚡ Python API (local)', 'http://127.0.0.1:8000');

      // Start the dashboard HTTP server on port 4000 + Cloudflare tunnel
      const dashboardPublicUrl = await startDashboard(4000);

      // Start the direct application auto-email service
      try {
        const { startDirectApplyService } = require('./libs/direct-apply-service');
        startDirectApplyService();
      } catch (e) {
        console.warn('⚠️ Failed to start Direct Apply Service:', e);
      }

      if (!dashboardPublicUrl) {
        console.warn('⚠️ Dashboard tunnel failed — skipping URL registration.');
        return;
      }

      try {
        const { saveLiveUrlToR2 } = require('./libs/r2-sync');
        await saveLiveUrlToR2(dashboardPublicUrl);
      } catch (e) {
        console.warn('⚠️ Failed to save live URL to R2:', e);
      }

      this.startGoogleSearchKeeper();
    } catch (e) {
      console.error('❌ Error starting dashboard:', e);
    }
  }

  private startGoogleSearchKeeper(): void {
    const domain = process.env.DASHBOARD_DOMAIN || 'services.ufone-claim.site';
    const intervalMs = 1 * 60 * 1000; // 1 minute

    const performSearch = async () => {
      try {
        const activeCount = Math.max(1, browserPool.getActive().length);
        const totalSearches = activeCount;

        lol(`🔍 Keeper: performing ${totalSearches} keep-alive searches (${activeCount} active browsers)`);

        const promises = [];
        for (let i = 0; i < totalSearches; i++) {
          promises.push((async () => {
            try {
              const response = await fetch(`https://${domain}/api/browser/search`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ query: 'keep alive' })
              });
              await response.text();
            } catch (err) {
              // ignore
            }
          })());
        }
        await Promise.all(promises);
      } catch (err) {
        // ignore
      }
    };

    this.googleSearchKeeperInterval = setInterval(performSearch, intervalMs);
  }

  public async stop(): Promise<void> {
    lol('🛑 Shutting down server...');
    if (this.googleSearchKeeperInterval) {
      clearInterval(this.googleSearchKeeperInterval);
      this.googleSearchKeeperInterval = null;
    }
  }
}

const server = new MainServer();

process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});
