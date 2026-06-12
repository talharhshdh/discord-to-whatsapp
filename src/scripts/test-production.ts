import { writeFileSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';

// Load local .env variables
dotenv.config();

// Retrieve configuration strictly from command line arguments or environment
const PROD_DOMAIN = process.argv[2] || process.env.DASHBOARD_DOMAIN;
const USERNAME = process.argv[3] || process.env.DASHBOARD_USERNAME;
const PASSWORD = process.argv[4] || process.env.DASHBOARD_PASSWORD;

if (!PROD_DOMAIN || !USERNAME || !PASSWORD) {
  console.error("\n❌ Error: Missing configuration.");
  console.error("Please set DASHBOARD_DOMAIN, DASHBOARD_USERNAME, and DASHBOARD_PASSWORD in your .env file,");
  console.error("or pass them directly as command-line arguments:");
  console.error("  npx ts-node src/scripts/test-production.ts <domain> <username> <password>\n");
  process.exit(1);
}

const PROD_URL = PROD_DOMAIN.startsWith('http') ? PROD_DOMAIN : `https://${PROD_DOMAIN}`;
const AUTH_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

interface Worker {
  workerId: string;
  cdpUrl: string;
  apiUrl?: string;
  status: string;
  secondsSinceHeartbeat: number;
}

async function runDiagnostics() {
  console.log(`\n======================================================`);
  console.log(`🔍 Scraper Production Testing Kit - Diagnostic Run`);
  console.log(`======================================================\n`);

  try {
    // 1. Fetch worker pool from production server
    console.log(`📡 Fetching worker pool from production server: ${PROD_URL}...`);
    const poolResp = await fetch(`${PROD_URL}/api/browsers/pool`, {
      headers: { 'Authorization': AUTH_HEADER }
    });

    if (!poolResp.ok) {
      throw new Error(`Failed to fetch browser pool. HTTP status ${poolResp.status}`);
    }

    const poolData = await poolResp.json() as { total: number; active: number; browsers: Worker[] };
    console.log(`📊 Production Status:`);
    console.log(`   - Total workers in registry: ${poolData.total}`);
    console.log(`   - Active workers online: ${poolData.active}`);
    console.log(`   - Connected workers details:\n`);

    if (poolData.browsers.length === 0) {
      console.log(`❌ No remote workers are registered. Run the browser worker fleet to continue.`);
      return;
    }

    for (const worker of poolData.browsers) {
      console.log(`------------------------------------------------------`);
      console.log(`Worker ID: ${worker.workerId}`);
      console.log(`Status:    ${worker.status} (${worker.secondsSinceHeartbeat}s since heartbeat)`);
      console.log(`CDP URL:   ${worker.cdpUrl}`);
      console.log(`API URL:   ${worker.apiUrl || 'N/A'}`);
      console.log(`------------------------------------------------------`);

      if (!worker.apiUrl) {
        console.log(`⚠️ Worker lacks an API URL. It might be running an outdated script.`);
        continue;
      }

      // 2. Test worker health
      console.log(`⏳ Testing worker health endpoint...`);
      try {
        const healthResp = await fetch(`${worker.apiUrl}/health`, { signal: AbortSignal.timeout(10000) });
        if (healthResp.ok) {
          const health = await healthResp.json() as { status: string };
          console.log(`✅ Worker health: OK (Response status: ${health.status})`);
        } else {
          console.log(`❌ Worker health returned HTTP ${healthResp.status}`);
        }
      } catch (e) {
        console.log(`❌ Failed to contact worker API: ${(e as Error).message}`);
        continue;
      }

      // 3. Test scraper endpoint directly
      console.log(`🔎 Triggering Indeed scrape test on worker...`);
      const scrapePayload = {
        query: 'software engineer',
        location: 'Rawalpindi',
        page: 1
      };

      try {
        const scrapeResp = await fetch(`${worker.apiUrl}/scrape/indeed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scrapePayload),
          signal: AbortSignal.timeout(60000) // 60s timeout
        });

        if (!scrapeResp.ok) {
          console.log(`❌ Worker scrape endpoint returned HTTP ${scrapeResp.status}`);
          if (scrapeResp.status === 403) {
            console.log(`⚠️ Worker returned 403: Captcha blocked detected!`);
          }
        } else {
          const jobs = await scrapeResp.json() as any[];
          console.log(`✅ Scraper execution finished. Jobs found: ${jobs.length}`);
          if (jobs.length > 0) {
            console.log(`💼 Sample job parsed: "${jobs[0].title}" at ${jobs[0].company}`);
          } else {
            console.log(`⚠️ Indeed returned 0 jobs. Pulling diagnostic assets...`);
            await pullDiagnostics(worker, 'https://pk.indeed.com/jobs?q=software+engineer&l=Rawalpindi');
          }
        }
      } catch (e) {
        console.log(`❌ Scraper execution failed: ${(e as Error).message}`);
        console.log(`⏳ Pulling diagnostic assets...`);
        await pullDiagnostics(worker, 'https://pk.indeed.com/jobs?q=software+engineer&l=Rawalpindi');
      }
    }

  } catch (err) {
    console.error(`❌ Diagnostic script error:`, err);
  }
}

async function pullDiagnostics(worker: Worker, targetUrl: string) {
  if (!worker.apiUrl) return;

  const outDir = join(__dirname, '..', '..');

  // 1. Pull Screenshot
  console.log(`📸 Requesting diagnostic screenshot from worker...`);
  try {
    const shotResp = await fetch(`${worker.apiUrl}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
      signal: AbortSignal.timeout(20000)
    });

    if (shotResp.ok) {
      const buffer = Buffer.from(await shotResp.arrayBuffer());
      const shotPath = join(outDir, `prod_debug_${worker.workerId}.png`);
      writeFileSync(shotPath, buffer);
      console.log(`✅ Diagnostic screenshot saved to: ${shotPath}`);
    } else {
      console.log(`❌ Worker screenshot API returned HTTP ${shotResp.status}`);
    }
  } catch (e) {
    console.log(`❌ Failed to pull screenshot: ${(e as Error).message}`);
  }

  // 2. Pull HTML
  console.log(`📄 Requesting page HTML source from worker...`);
  try {
    const htmlResp = await fetch(`${worker.apiUrl}/get_html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
      signal: AbortSignal.timeout(20000)
    });

    if (htmlResp.ok) {
      const data = await htmlResp.json() as { html: string };
      const htmlPath = join(outDir, `prod_debug_${worker.workerId}.html`);
      writeFileSync(htmlPath, data.html, 'utf-8');
      console.log(`✅ Diagnostic HTML saved to: ${htmlPath}`);
    } else {
      console.log(`❌ Worker get_html API returned HTTP ${htmlResp.status}`);
    }
  } catch (e) {
    console.log(`❌ Failed to pull HTML source: ${(e as Error).message}`);
  }
}

runDiagnostics();
