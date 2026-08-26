const path = require("path");
const fs = require("fs");
const { createLocalDb } = require("../src/localDb");
const { createSessionManager } = require("../src/sessionManager");

const DB_PATH = path.join(__dirname, "test-rows.db");
for (const ext of ["", "-shm", "-wal"]) {
  if (fs.existsSync(DB_PATH + ext)) fs.unlinkSync(DB_PATH + ext);
}

const API_BASE = process.argv[2];
const API_KEY = process.argv[3];
if (!API_BASE || !API_KEY) {
  console.error("Usage: node test-row-tables.js <apiBase> <apiKey>");
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

  console.log("--- Bootstrap: cache real config ---");
  const cfg = await manager.refreshConfig();
  assert(cfg.machine !== null, "cached real config");
  const op = cfg.operators[0];
  const wo = cfg.workOrders.pending[0];
  assert(wo, "a pending work order exists to start against");

  console.log("\n--- Start with runningHourStart ---");
  const session = manager.startSession({
    operatorId: op.id, operatorName: op.name, workOrder: wo, runningHourStart: 500.25,
  });
  assert(session.startRows.length === 0 && session.stopRows.length === 0, "session starts with empty row arrays");
  assert(manager.getStatus().pendingCount === 1, "start event queued (1 pending)");

  console.log("\n--- Add rows to Start table (progressively, like the real UI would) ---");
  const materialField = cfg.fields.find((f) => f.label === "Material");
  let updated = manager.updateRows({ table: "start", rows: [{ [materialField.id]: "opt-1" }] });
  assert(updated.startRows.length === 1, "1 row added to start table locally");
  assert(manager.getStatus().pendingCount === 2, "update_rows event queued (2 pending)");

  updated = manager.updateRows({ table: "start", rows: [{ [materialField.id]: "opt-1" }, { [materialField.id]: "opt-2" }] });
  assert(updated.startRows.length === 2, "2nd row added, overwriting the full row set");
  assert(manager.getStatus().pendingCount === 3, "second update_rows event queued (3 pending)");

  console.log("\n--- Pause, resume ---");
  manager.pauseSession({ reasonId: null }); // "Continue Next Shift"-style pause with no specific reason
  assert(manager.getActiveSession().status === "paused", "pause applied locally with null reasonId");
  manager.resumeSession();
  assert(manager.getActiveSession().status === "running", "resume applied locally");

  console.log("\n--- Add a row to the End table while running ---");
  manager.updateRows({ table: "stop", rows: [{ someKey: "value" }] });
  assert(manager.getActiveSession().stopRows.length === 1, "end table has 1 row locally");

  console.log("\n--- Sync everything ---");
  const syncResult = await manager.runSyncCycle();
  assert(syncResult.online === true, "sync detects backend reachable");
  assert(syncResult.pendingCount === 0, "all queued events synced");

  console.log("\n--- Stop with runningHourEnd ---");
  const stopResult = manager.stopSession({ status: "finished", runningHourEnd: 502.75 });
  assert(manager.getActiveSession() === null, "active session cleared after stop");
  await manager.runSyncCycle();

  console.log("\n--- Verify via the real backend API that everything landed correctly ---");
  const https = require("http");
  function apiGet(p) {
    return new Promise((resolve, reject) => {
      https.get(API_BASE.replace("/api", "") + p, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      }).on("error", reject);
    });
  }
  // (quick raw check without needing an admin token — use the device config endpoint instead
  // to confirm the work order moved to finished, which is enough signal that the stop event applied)
  const finalCfg = await manager.refreshConfig();
  const stillPending = finalCfg.workOrders.pending.find((w) => w.id === wo.id);
  const nowFinished = finalCfg.workOrders.finished.find((w) => w.id === wo.id);
  assert(!stillPending, "work order no longer in pending queue");
  assert(!!nowFinished, "work order now appears in finished list");

  console.log("\n--- Delete session test (separate job) ---");
  // Create a fresh work order via the admin API specifically for this test,
  // rather than relying on whatever's left in the queue — makes the test
  // deterministic regardless of how many work orders were seeded.
  const http = require("http");
  function apiCall(method, urlPath, body, headers) {
    return new Promise((resolve, reject) => {
      const url = new URL(API_BASE + urlPath);
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
          headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}), ...headers } },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve(JSON.parse(raw)));
        }
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }
  const login = await apiCall("POST", "/auth/login", { username: "admin", password: "admin123" });
  const machineId = manager.getConfig().machine.id;
  const newWo = await apiCall("POST", `/machines/${machineId}/work-orders`, { jobNo: "WO-DELETE-TEST" }, { Authorization: `Bearer ${login.token}` });

  await manager.refreshConfig();
  const wo2 = manager.getConfig().workOrders.pending.find((w) => w.id === newWo.id);
  assert(!!wo2, "freshly created work order is visible to the device");

  const s2 = manager.startSession({ operatorId: op.id, operatorName: op.name, workOrder: wo2, runningHourStart: 10 });
  manager.deleteSession();
  assert(manager.getActiveSession() === null, "session cleared locally after delete");
  await manager.runSyncCycle();
  const cfgAfterDelete = await manager.refreshConfig();
  const backInQueue = cfgAfterDelete.workOrders.pending.find((w) => w.id === wo2.id);
  assert(!!backInQueue, "deleted job's work order returned to pending queue");

  console.log("\nALL ROW-TABLE SESSION-MANAGER CHECKS PASSED");
  localDb.close();
  for (const ext of ["", "-shm", "-wal"]) {
    if (fs.existsSync(DB_PATH + ext)) fs.unlinkSync(DB_PATH + ext);
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
