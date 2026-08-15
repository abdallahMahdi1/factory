// Not a formal test suite — a scripted run-through of the exact scenario
// the whole system exists for: operator works with no internet, then the
// connection comes back and everything syncs correctly and exactly once.
const path = require("path");
const fs = require("fs");
const { createLocalDb } = require("../src/localDb");
const { createSessionManager } = require("../src/sessionManager");

const DB_PATH = path.join(__dirname, "test-local.db");
for (const ext of ["", "-shm", "-wal"]) {
  if (fs.existsSync(DB_PATH + ext)) fs.unlinkSync(DB_PATH + ext);
}

const API_BASE = process.argv[2]; // e.g. http://localhost:4000/api
const API_KEY = process.argv[3];
if (!API_BASE || !API_KEY) {
  console.error("Usage: node test-offline-flow.js <apiBase> <apiKey>");
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`OK: ${msg}`);
}

async function main() {
  const localDb = createLocalDb(DB_PATH);

  console.log("--- Phase 0: device is online once, caches real config from the server ---");
  const bootstrapManager = createSessionManager({ localDb, apiBase: API_BASE, apiKey: API_KEY });
  const bootstrapCfg = await bootstrapManager.refreshConfig();
  assert(bootstrapCfg.machine !== null, "device successfully cached real config while online");

  // Deliberately wrong port so every sync attempt below fails, exactly like
  // a machine with no internet — this is the "offline" phase. It reuses the
  // SAME local DB, so it still has the config cached from Phase 0.
  const offlineManager = createSessionManager({ localDb, apiBase: "http://localhost:1", apiKey: API_KEY });

  console.log("\n--- Phase 1: fully offline ---");
  const op = offlineManager.findOperatorByIdNumber("1001");
  assert(op && op.name === "Ahmed Ali", "operator lookup works fully offline from cached config");

  const cfg = offlineManager.getConfig();
  const workOrderField = cfg.fields.find((f) => f.label === "Work order");
  const fieldValues = workOrderField ? { [workOrderField.id]: workOrderField.options[0].id } : {};

  const session = offlineManager.startSession({ operatorId: op.id, operatorName: op.name, fieldValues });
  assert(session.status === "running", "session starts locally with no network");
  assert(offlineManager.getStatus().pendingCount === 1, "start event queued locally (1 pending)");

  const pauseReasonId = cfg.pauseReasons[0].id;
  offlineManager.pauseSession({ reasonId: pauseReasonId });
  assert(offlineManager.getActiveSession().status === "paused", "pause applied locally");
  assert(offlineManager.getStatus().pendingCount === 2, "pause event queued (2 pending)");

  offlineManager.resumeSession();
  assert(offlineManager.getActiveSession().status === "running", "resume applied locally");
  assert(offlineManager.getStatus().pendingCount === 3, "resume event queued (3 pending)");

  const stopReasonId = cfg.stopReasons[0].id;
  const stopResult = offlineManager.stopSession({ status: "finished", stopReasonId });
  assert(offlineManager.getActiveSession() === null, "active session cleared locally on stop");
  assert(offlineManager.getStatus().pendingCount === 4, "stop event queued (4 pending)");

  const failedSync = await offlineManager.runSyncCycle();
  assert(failedSync.online === false, "sync cycle correctly fails while offline");
  assert(failedSync.pendingCount === 4, "all 4 events still queued after a failed sync attempt — nothing lost");

  console.log("\n--- Phase 2: connection comes back ---");
  // Same local DB, now pointed at the real running backend — like the PC's
  // network cable being plugged back in.
  const onlineManager = createSessionManager({ localDb, apiBase: API_BASE, apiKey: API_KEY });
  const syncResult = await onlineManager.runSyncCycle();
  assert(syncResult.online === true, "sync cycle detects the backend is now reachable");
  assert(syncResult.pushed === 4, `all 4 queued events were pushed (got ${syncResult.pushed})`);
  assert(syncResult.pendingCount === 0, "queue is empty after a successful sync");

  console.log("\n--- Phase 3: retry safety ---");
  // Simulate the device retrying a sync it thinks might not have landed
  // (e.g. it got a network error right as the response was on its way back).
  localDb.enqueueEvent({ eventId: `${session.id}-stop`, type: "stop", payload: { sessionId: session.id, endedAt: stopResult.endedAt, status: "finished" } });
  const retrySync = await onlineManager.runSyncCycle();
  assert(retrySync.pushed === 1, "retried stop event is accepted (server dedupes, doesn't error)");

  console.log("\nAll checks passed.");
  localDb.close();
  fs.unlinkSync(DB_PATH);
  fs.existsSync(DB_PATH + "-shm") && fs.unlinkSync(DB_PATH + "-shm");
  fs.existsSync(DB_PATH + "-wal") && fs.unlinkSync(DB_PATH + "-wal");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
