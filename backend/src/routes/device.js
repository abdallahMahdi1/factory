const express = require("express");
const db = require("../lib/db");
const { requireDevice } = require("../middleware/auth");

const router = express.Router();
router.use(requireDevice);

// Everything the operator app needs to work fully offline: this machine's
// start-form fields (with resolved dropdown options), who's allowed to log
// in on this machine, and the pause/stop reason lists. The app re-fetches
// this whenever it's online so changes made in the admin panel eventually
// reach the shop floor, but it always has a cached copy to run on.
router.get("/config", (req, res) => {
  const machine = req.machine;

  const rawFields = db
    .prepare(
      `SELECT id, label, type, option_list_id, required, sort_order, stage, group_label
       FROM machine_fields WHERE machine_id = ? ORDER BY stage ASC, sort_order ASC`
    )
    .all(machine.id)
    .map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: !!f.required,
      stage: f.stage,
      groupLabel: f.group_label,
      options:
        f.type === "select"
          ? db
              .prepare("SELECT id, value FROM option_items WHERE option_list_id = ? AND active = 1 ORDER BY value ASC")
              .all(f.option_list_id)
          : undefined,
    }));

  const operators = db
    .prepare(
      `SELECT o.id, o.name, o.id_number
       FROM operators o
       JOIN operator_machines om ON om.operator_id = o.id
       WHERE om.machine_id = ? AND o.active = 1`
    )
    .all(machine.id);

  const pauseReasons = db.prepare("SELECT id, label FROM pause_reasons WHERE active = 1 ORDER BY label ASC").all();
  const stopReasons = db.prepare("SELECT id, label FROM stop_reasons WHERE active = 1 ORDER BY label ASC").all();

  res.json({
    machine: { id: machine.id, name: machine.name, code: machine.code },
    // Kept split by stage here so the operator app doesn't need to filter
    // on every render — "fields" is exactly what belongs on the Start
    // screen, "stopFields" exactly what belongs on the Stop screen.
    fields: rawFields.filter((f) => f.stage === "start"),
    stopFields: rawFields.filter((f) => f.stage === "stop"),
    operators,
    pauseReasons,
    stopReasons,
  });
});

// Batch event sync. Body: { events: [ { eventId, type, ...payload }, ... ] }
// Every event is de-duplicated by eventId (see synced_events) so retrying a
// batch after a dropped connection never double-applies anything. Events
// are applied in the order sent, inside one transaction per batch.
router.post("/sync", (req, res) => {
  const { events } = req.body || {};
  if (!Array.isArray(events)) return res.status(400).json({ error: "events must be an array" });

  const results = [];
  const alreadyProcessed = db.prepare("SELECT 1 FROM synced_events WHERE id = ?");
  const markProcessed = db.prepare("INSERT INTO synced_events (id) VALUES (?)");

  const applyEvent = (event) => {
    const { eventId, type, payload } = event;
    if (!eventId || !type) return { eventId, ok: false, error: "eventId and type are required" };
    if (alreadyProcessed.get(eventId)) return { eventId, ok: true, deduped: true };

    // Each event is applied in its own SAVEPOINT: if one event is bad (e.g.
    // it references an operator/session that doesn't exist in this
    // database — which can happen if a device queued events against an
    // older or different backend before its config.json was corrected), we
    // roll back just that one insert and report it as failed, rather than
    // throwing and aborting every other event in the batch. A device that
    // gets a per-event failure back simply drops that one event from its
    // local queue instead of retrying it forever — see the "ok: false"
    // handling below.
    db.exec("SAVEPOINT event_sp");
    try {
      switch (type) {
        case "start": {
          const { sessionId, operatorId, fieldValues, startedAt } = payload;
          db.prepare(
            `INSERT OR IGNORE INTO sessions
               (id, machine_id, operator_id, field_values, started_at, status, created_offline)
             VALUES (?, ?, ?, ?, ?, 'running', ?)`
          ).run(sessionId, req.machine.id, operatorId, JSON.stringify(fieldValues || {}), startedAt, event.createdOffline ? 1 : 0);
          break;
        }
        case "pause": {
          const { sessionId, pauseId, reasonId, startedAt } = payload;
          db.prepare(
            "INSERT OR IGNORE INTO pause_events (id, session_id, reason_id, started_at) VALUES (?, ?, ?, ?)"
          ).run(pauseId, sessionId, reasonId || null, startedAt);
          db.prepare("UPDATE sessions SET status = 'paused' WHERE id = ?").run(sessionId);
          break;
        }
        case "resume": {
          const { pauseId, sessionId, endedAt } = payload;
          db.prepare("UPDATE pause_events SET ended_at = ? WHERE id = ?").run(endedAt, pauseId);
          db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(sessionId);
          break;
        }
        case "stop": {
          const { sessionId, endedAt, status, stopReasonId, completionNote, stopFieldValues } = payload;
          db.prepare(
            "UPDATE sessions SET ended_at = ?, status = ?, stop_reason_id = ?, completion_note = ?, stop_field_values = ? WHERE id = ?"
          ).run(
            endedAt,
            status || "finished",
            stopReasonId || null,
            completionNote || null,
            JSON.stringify(stopFieldValues || {}),
            sessionId
          );
          break;
        }
        default:
          db.exec("ROLLBACK TO event_sp");
          db.exec("RELEASE event_sp");
          return { eventId, ok: false, error: `Unknown event type: ${type}` };
      }
    } catch (err) {
      db.exec("ROLLBACK TO event_sp");
      db.exec("RELEASE event_sp");
      console.error(`Sync event ${eventId} (${type}) rejected:`, err.message);
      // Still mark it processed: this event can never succeed (its
      // referenced session/operator doesn't exist), so accepting the
      // failure permanently is correct — otherwise a genuinely bad event
      // would sit in every device's local queue forever, retried every
      // 15 seconds indefinitely.
      markProcessed.run(eventId);
      return { eventId, ok: false, error: err.message };
    }
    db.exec("RELEASE event_sp");
    markProcessed.run(eventId);
    return { eventId, ok: true };
  };

  const tx = db.transaction(() => {
    for (const event of events) {
      results.push(applyEvent(event));
    }
  });
  tx();

  db.prepare("UPDATE machines SET last_synced_at = datetime('now'), last_heartbeat_at = datetime('now') WHERE id = ?").run(
    req.machine.id
  );

  res.json({ results });
});

// Lightweight liveness ping — the operator app calls this even when there's
// nothing to sync, so the admin dashboard can tell "online, nothing to say"
// apart from "actually offline".
router.post("/heartbeat", (req, res) => {
  db.prepare("UPDATE machines SET last_heartbeat_at = datetime('now') WHERE id = ?").run(req.machine.id);
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

module.exports = router;
