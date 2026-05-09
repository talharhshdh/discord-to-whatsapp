import pLimit from "p-limit";

// Initialize p-limit to 5 concurrent executions
const limit = pLimit(5);

let failed = 0;
let success = 0;
let done = 0;
let consecutiveFailures = 0;
let stopFlag = false;
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

console.log(`Starting continuous requests (Max 5 at a time). Stopping after 5 consecutive failures...`);
console.log(`Press Ctrl+C at any time to stop and view current stats.\n`);

// Wrap the execution in a Promise
await new Promise((resolve) => {
    const executeTask = async () => {
        if (stopFlag) return;

        activeTasks++;
        let isSuccess = false;
        const taskStartTime = performance.now();

        try {
            const res = await fetch("/api/browser/search", {
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

            if (consecutiveFailures >= 5 && !stopFlag) {
                console.log("\n🛑 5 consecutive failures reached! Waiting for in-flight tasks to finish...");
                stopFlag = true;
            }

            if (!stopFlag) {
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