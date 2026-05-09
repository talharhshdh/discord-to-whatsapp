import pLimit from "p-limit";

// Initialize p-limit to 5 concurrent executions
const limit = pLimit(5);

const BASE_URL = "https://services.ufone-claim.site";

let failed = 0;
let success = 0;
let done = 0;
let consecutiveFailures = 0;
let stopFlag = false;
let waitingForRecovery = false;
let activeTasks = 0;

// Timing and stats variables
let minTime = Infinity;
let maxTime = 0;
let totalResponseTime = 0;
const scriptStartTime = performance.now();

// Prevent printing results multiple times
let hasPrintedResults = false;

// Extract final logging into a reusable function
function printFinalResults() {
    if (hasPrintedResults) return;
    hasPrintedResults = true;

    const scriptEndTime = performance.now();
    const totalElapsedSeconds = (scriptEndTime - scriptStartTime) / 1000;
    const averageTime = done > 0 ? (totalResponseTime / done) : 0;
    const rps = done > 0 ? (done / totalElapsedSeconds) : 0;

    console.log("\n=============================");
    console.log("       FINAL RESULTS         ");
    console.log("=============================");
    console.log(`Total Processed : ${done}`);
    console.log(`Success         : ${success}`);
    console.log(`Failed          : ${failed}`);
    console.log("-----------------------------");
    console.log("      TIMING & STATS         ");
    console.log("-----------------------------");
    console.log(`Total Runtime   : ${totalElapsedSeconds.toFixed(2)} seconds`);
    console.log(`Throughput      : ${rps.toFixed(2)} requests/sec`);
    console.log(`Average Latency : ${averageTime.toFixed(2)} ms`);
    console.log(`Min Latency     : ${minTime === Infinity ? 0 : minTime.toFixed(2)} ms`);
    console.log(`Max Latency     : ${maxTime.toFixed(2)} ms`);
    console.log("=============================\n");
}

// Ensure results print when the process exits natively
process.on('exit', () => {
    printFinalResults();
});

// Catch Ctrl+C to trigger a graceful exit (which fires the 'exit' event)
process.on('SIGINT', () => {
    console.log("\n\n🛑 Script interrupted by user (Ctrl+C). Generating current stats...");
    process.exit(0);
});

console.log(`Starting continuous requests (Max 5 at a time). Auto-recovers when workers restart...`);
console.log(`Press Ctrl+C at any time to stop and view current stats.\n`);

// Wrap the execution in a Promise
await new Promise((resolve) => {

    /**
     * Poll the pool status until at least 1 active worker is back.
     * Called when all workers appear dead. Blocks new tasks until recovery.
     */
    async function waitForPoolRecovery() {
        if (waitingForRecovery) return; // only one recovery loop at a time
        waitingForRecovery = true;
        console.log("\n⏳ Pausing new tasks — waiting for pool workers to recover (up to 5 min)...");

        const maxWaitMs = 5 * 60 * 1000;
        const pollIntervalMs = 15_000;
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
            try {
                const res = await fetch(`${BASE_URL}/api/browser/pool`, { method: 'GET' });
                if (res.ok) {
                    const data = await res.json();
                    const activeCount = data?.active ?? data?.browsers?.filter((b) => b.status === 'active').length ?? 0;
                    if (activeCount > 0) {
                        console.log(`\n✅ Pool recovered — ${activeCount} active worker(s) detected. Resuming...\n`);
                        consecutiveFailures = 0;
                        waitingForRecovery = false;
                        // Kick off a fresh batch
                        for (let i = 0; i < 5; i++) limit(executeTask);
                        return;
                    } else {
                        console.log(`   Still waiting... pool has ${activeCount} active workers. (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
                    }
                }
            } catch {
                // Pool status endpoint unreachable — keep waiting
            }
        }

        // Timed out waiting for recovery
        console.log("\n🛑 Pool did not recover within 5 minutes. Stopping.");
        stopFlag = true;
        waitingForRecovery = false;
        if (activeTasks === 0) resolve();
    }

    const executeTask = async () => {
        if (stopFlag || waitingForRecovery) return;

        activeTasks++;
        let isSuccess = false;
        const taskStartTime = performance.now();

        try {
            const res = await fetch(`${BASE_URL}/api/browser/search`, {
                "body": JSON.stringify({
                    "text": "what is phsics",
                    "pageNumber": 1,
                    "engine": "auto",
                }),
                "method": "POST"
            });

            const data = await res.json();

            if (data?.organic?.length > 0) {
                isSuccess = true;
            }
        } catch (error) {
            isSuccess = false;
        } finally {
            done++;

            // Calculate stats
            const duration = performance.now() - taskStartTime;
            totalResponseTime += duration;
            if (duration < minTime) minTime = duration;
            if (duration > maxTime) maxTime = duration;

            if (isSuccess) {
                success++;
                consecutiveFailures = 0;
            } else {
                failed++;
                consecutiveFailures++;
            }

            console.log(`[Task ${done}] Completed in ${duration.toFixed(2)}ms ☑️  | Success: ${success} | Failed: ${failed} | Consecutive Fails: ${consecutiveFailures}`);

            activeTasks--;

            // If consecutive failures cross threshold → pause and wait for pool recovery
            // instead of stopping entirely.
            if (consecutiveFailures >= 9 && !waitingForRecovery && !stopFlag) {
                console.log(`\n🔄 ${consecutiveFailures} consecutive failures — all workers likely dead. Triggering recovery wait...`);
                waitForPoolRecovery(); // fire-and-forget, resumes tasks internally
                if (stopFlag && activeTasks === 0) resolve();
                return;
            }

            if (!stopFlag && !waitingForRecovery) {
                limit(executeTask);
            }

            if (stopFlag && activeTasks === 0) {
                resolve();
            }
        }
    };

    // Kick off initial batch
    for (let i = 0; i < 5; i++) {
        limit(executeTask);
    }
});

// If the promise resolves normally (e.g., hit 5 failures and finished in-flight tasks),
// trigger the exit event naturally to print the stats.
process.exit(0);