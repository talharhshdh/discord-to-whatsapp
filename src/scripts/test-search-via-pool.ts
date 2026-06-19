import { searchViaPool, browserPool } from '../libs/browser-pool';
import * as dotenv from 'dotenv';

dotenv.config();

const PROD_DOMAIN = process.env.DASHBOARD_DOMAIN || 'services.ufone-claim.site';
const USERNAME = process.env.DASHBOARD_USERNAME;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!PROD_DOMAIN || !USERNAME || !PASSWORD) {
  console.error("❌ Error: Missing DASHBOARD_DOMAIN, DASHBOARD_USERNAME, or DASHBOARD_PASSWORD in .env.");
  process.exit(1);
}

const PROD_URL = PROD_DOMAIN.startsWith('http') ? PROD_DOMAIN : `https://${PROD_DOMAIN}`;
const AUTH_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

async function run() {
  console.log("🚀 Starting searchViaPool test for talhatech...");
  try {
    // Fetch active workers from production
    console.log(`📡 Fetching browser pool from: ${PROD_URL}...`);
    const poolResp = await fetch(`${PROD_URL}/api/browsers/pool`, {
      headers: { 'Authorization': AUTH_HEADER }
    });

    if (!poolResp.ok) {
      throw new Error(`Failed to fetch pool: ${poolResp.status}`);
    }

    const poolData = await poolResp.json() as any;
    console.log(`📊 Total workers in prod: ${poolData.total}, Active: ${poolData.active}`);

    const activeWorkers = poolData.browsers.filter((b: any) => b.status === 'active');
    if (activeWorkers.length === 0) {
      console.error("❌ No active workers found.");
      process.exit(1);
    }

    // Register the active workers into the local browserPool instance
    for (const w of activeWorkers) {
      console.log(`Registering worker locally: ${w.workerId} -> ${w.cdpUrl}`);
      browserPool.register(w.workerId, w.cdpUrl, w.runId, true, w.apiUrl);
    }

    const res = await searchViaPool('site:talhatech.vercel.app', 1, false, 'all');
    console.log("🎯 searchViaPool Result:", JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("❌ Test failed:", err);
  }
  process.exit(0);
}

run();
