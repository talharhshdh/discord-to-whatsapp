import pLimit from "p-limit";

// Initialize p-limit to 5 concurrent executions
const limit = pLimit(5);

let failed = 0;
let success = 0;
let done = 0;
let consecutiveFailures = 0;
let stopFlag = false;
let activeTasks = 0;

console.log(`Starting continuous requests (Max 5 at a time). Stopping after 5 consecutive failures...\n`);

// Wrap the execution in a Promise so we can await the final shutdown
await new Promise((resolve) => {
    const executeTask = async () => {
        // Prevent queuing new tasks if we are stopping
        if (stopFlag) return;

        activeTasks++;
        let isSuccess = false;

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
            // Network or parsing errors count as failures
            isSuccess = false;
        } finally {
            done++;

            // Process outcome and manage the consecutive failure counter
            if (isSuccess) {
                success++;
                consecutiveFailures = 0; // Reset counter on success
            } else {
                failed++;
                consecutiveFailures++;
            }

            console.log(`[Task ${done}] Completed ☑️  | Success: ${success} | Failed: ${failed} | Consecutive Fails: ${consecutiveFailures}`);

            activeTasks--;

            // Check stopping condition
            if (consecutiveFailures >= 5 && !stopFlag) {
                console.log("\n🛑 5 consecutive failures reached! Waiting for in-flight tasks to finish...");
                stopFlag = true;
            }

            // If we aren't stopping, queue the next task immediately
            if (!stopFlag) {
                limit(executeTask);
            }

            // If we are stopping AND this was the last active task, exit the loop
            if (stopFlag && activeTasks === 0) {
                resolve();
            }
        }
    };

    // Kick off the initial batch to saturate the limit
    for (let i = 0; i < 5; i++) {
        limit(executeTask);
    }
});

// Final summary executes only after the resolve() is called above
console.log("\n--- FINAL RESULTS ---");
console.log(`Total Processed: ${done}`);
console.log(`Success: ${success}`);
console.log(`Failed: ${failed}`);