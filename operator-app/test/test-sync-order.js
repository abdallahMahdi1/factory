// Verifies the exact bug fixed by ordering runSyncCycle() to push local
// events BEFORE refreshing config: after stopping a job, a single sync
// cycle should immediately show that work order as finished in the
// LOCAL CACHED config — not require a second cycle to catch up. This is
// what makes the operator's Queue screen update immediately after they
// finish a job, instead of briefly showing stale data.
const path = require("path");
const fs = require("fs");
const { createLocalDb } = require("../src/localDb");
const { createSessionManager } = require("../src/sessionManager");

const DB_PATH = path.join(__dirname, "test-sync-order.db");
for (const ext of ["", "-shm", "-wal"]) {
  if (fs.existsSync(DB_PATH + ext)) fs.unlinkSync(DB_PATH + ext);
}

const API_BASE = process.argv[2];
const API_KEY = process.argv[3];
if (!API_BASE || !API_KEY) {
  console.error("Usage: node test-sync-order.js <apiBase> <apiKey>");
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
  const manager = createSessionManager({ localDb, apiBase: API_BASE, apiKey: API_KEY });

  const cfg = await manager.refreshConfig();
  assert(cfg.machine !== null, "initial config fetch succeeds");

  const adminLogin = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  }).then((r) => r.json());
  const wo = await fetch(`${API_BASE}/machines/${cfg.machine.id}/work-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminLogin.token}` },
    body: JSON.stringify({ jobNo: `SYNC-ORDER-TEST-${Date.now()}` }),
  }).then((r) => r.json());

  const op = manager.findOperatorByIdNumber("1001");
  manager.startSession({
    operatorId: op.id, operatorName: op.name, fieldValues: {},
    workOrder: { id: wo.id, jobNo: wo.job_no, priority: wo.priority },
  });
  await manager.runSyncCycle(); // push the start event

  manager.stopSession({ status: "finished" });

  // The critical check: exactly ONE sync cycle after stopping.
  const result = await manager.runSyncCycle();
  assert(result.pushed === 1, `the stop event was pushed in this single cycle (pushed=${result.pushed})`);

  const cachedConfig = manager.getConfig();
  const inFinished = (cachedConfig.workOrders.finished || []).some((w) => w.id === wo.id);
  const stillInPending = (cachedConfig.workOrders.pending || []).some((w) => w.id === wo.id);
  assert(inFinished, "work order appears in the LOCALLY CACHED finished list after just ONE sync cycle");
  assert(!stillInPending, "work order no longer appears in the locally cached pending list");

  console.log("\nAll sync-order checks passed.");
  localDb.close();
  fs.unlinkSync(DB_PATH);
  fs.existsSync(DB_PATH + "-shm") && fs.unlinkSync(DB_PATH + "-shm");
  fs.existsSync(DB_PATH + "-wal") && fs.unlinkSync(DB_PATH + "-wal");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
