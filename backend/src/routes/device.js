const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../lib/db");
const { shiftFor, getSettings } = require("../lib/shift");
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

  const pauseReasons = db.prepare("SELECT id, code, label FROM pause_reasons WHERE active = 1 ORDER BY label ASC").all();
  const stopReasons = db.prepare("SELECT id, code, label FROM stop_reasons WHERE active = 1 ORDER BY label ASC").all();

  // The planned job queue for this machine. Pending/in_progress = what the
  // operator picks from to start work; finished = a capped recent history
  // so the app can show a "Finished" list without a second authenticated
  // call (devices only ever authenticate via their machine API key, not an
  // admin JWT, so this piggybacks on the same config fetch the app already
  // polls every 15s).
  const workOrdersPending = db
    .prepare(
      `SELECT * FROM work_orders WHERE machine_id = ? AND status IN ('pending','in_progress')
       ORDER BY sequence ASC, created_at ASC`
    )
    .all(machine.id);
  const workOrdersFinished = db
    .prepare(
      `SELECT * FROM work_orders WHERE machine_id = ? AND status = 'finished'
       ORDER BY finished_at DESC LIMIT 50`
    )
    .all(machine.id);

  const toWorkOrderJson = (w) => ({
    id: w.id,
    sequence: w.sequence,
    jobNo: w.job_no,
    description: w.description,
    process: w.process,
    quantity: w.quantity,
    priority: w.priority,
    dueDate: w.due_date,
    specialInstruction: w.special_instruction,
    remarks: w.remarks,
    inputDiameter: w.input_diameter,
    totalTolerance: w.total_tolerance,
    status: w.status,
    startedAt: w.started_at,
    finishedAt: w.finished_at,
  });

  // Built-ins plus whatever this machine defined, same shape the admin
  // API returns. Any field whose stage doesn't match a known screen would
  // otherwise be invisible, so unknown stages surface as their own screen
  // rather than being silently dropped.
  const customScreens = db
    .prepare("SELECT key, label, sort_order FROM machine_screens WHERE machine_id = ? ORDER BY sort_order ASC")
    .all(machine.id);
  const screenMap = new Map([
    ["start", { key: "start", label: "Input", sort_order: 0 }],
    ["stop", { key: "stop", label: "Output", sort_order: 1 }],
  ]);
  for (const c of customScreens) {
    const ex = screenMap.get(c.key);
    if (ex) { ex.label = c.label; ex.sort_order = c.sort_order; }
    else screenMap.set(c.key, { key: c.key, label: c.label, sort_order: c.sort_order });
  }
  for (const f of rawFields) {
    if (!screenMap.has(f.stage)) screenMap.set(f.stage, { key: f.stage, label: f.stage, sort_order: 99 });
  }
  const screens = [...screenMap.values()].sort((a, b) => a.sort_order - b.sort_order);

  res.json({
    machine: { id: machine.id, name: machine.name, code: machine.code },
    // Every screen this machine shows, in order, each with its own
    // columns — the operator app renders one table per entry.
    screens: screens.map((sc) => ({
      key: sc.key,
      label: sc.label,
      fields: rawFields.filter((f) => f.stage === sc.key),
    })),
    // Kept split by stage here so the operator app doesn't need to filter
    // on every render — "fields" is exactly what belongs on the Start
    // screen, "stopFields" exactly what belongs on the Stop screen.
    fields: rawFields.filter((f) => f.stage === "start"),
    stopFields: rawFields.filter((f) => f.stage === "stop"),
    operators,
    pauseReasons,
    stopReasons,
    workOrders: {
      pending: workOrdersPending.map(toWorkOrderJson),
      finished: workOrdersFinished.map(toWorkOrderJson),
    },
    // The operator may only start one of the first few jobs — the rest of
    // the queue is visible for planning ahead, not for picking from.
    selectableCount: 5,
    // Compared against the version the app last acknowledged, to decide
    // whether to raise the "Please Check - Plan Change" alert.
    // Shift boundaries and timezone, so the app can label the current
    // shift without needing its own clock configuration.
    // Codes the operator picks from on the end-of-shift scrap form.
    scrapCodes: db
      .prepare("SELECT id, code, label FROM scrap_codes WHERE active = 1 ORDER BY code ASC")
      .all(),
    shiftSettings: getSettings(),
    currentShift: shiftFor(new Date()),
    planVersion: machine.plan_version || 0,
    planChangedAt: machine.plan_changed_at || null,
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
          const { sessionId, operatorId, startedAt, workOrderId, runningHourStart, phase } = payload;
          // phase "setup" means the operator is setting the machine up,
          // not producing yet: work_started_at stays NULL until they press
          // "Start work". Starting straight into production sets
          // work_started_at = startedAt, i.e. zero setup time.
          const isSetup = phase === "setup";
          db.prepare(
            `INSERT OR IGNORE INTO sessions
               (id, machine_id, operator_id, work_order_id, field_values, stop_field_values, running_hour_start, started_at, work_started_at, status, created_offline)
             VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)`
          ).run(
            sessionId, req.machine.id, operatorId, workOrderId || null, runningHourStart ?? null,
            startedAt, isSetup ? null : startedAt, isSetup ? "setup" : "running",
            event.createdOffline ? 1 : 0
          );
          // Resolved once, at record time, so historic sessions keep the
          // shift they actually ran in even if the boundaries change later.
          db.prepare("UPDATE sessions SET shift = ? WHERE id = ? AND shift IS NULL")
            .run(shiftFor(startedAt), sessionId);
          if (workOrderId) {
            db.prepare(
              "UPDATE work_orders SET status = 'in_progress', session_id = ?, started_at = ? WHERE id = ? AND machine_id = ?"
            ).run(sessionId, startedAt, workOrderId, req.machine.id);
          }
          break;
        }
        // Setup finished — production starts now. Everything before this
        // point is setup time, everything after is working time.
        case "begin_work": {
          const { sessionId, workStartedAt } = payload;
          db.prepare(
            "UPDATE sessions SET work_started_at = ?, status = 'running' WHERE id = ? AND work_started_at IS NULL"
          ).run(workStartedAt, sessionId);
          break;
        }
        // Operator signed in at this machine's app.
        case "sign_in": {
          const { attendanceId, operatorId, signedInAt } = payload;
          db.prepare(
            `INSERT OR IGNORE INTO operator_attendance
               (id, operator_id, machine_id, signed_in_at, shift)
             VALUES (?, ?, ?, ?, ?)`
          ).run(attendanceId, operatorId, req.machine.id, signedInAt, shiftFor(signedInAt));
          break;
        }
        case "sign_out": {
          const { attendanceId, signedOutAt, scrap } = payload;
          db.prepare(
            "UPDATE operator_attendance SET signed_out_at = ? WHERE id = ? AND signed_out_at IS NULL"
          ).run(signedOutAt, attendanceId);

          // Scrap weighed at end of shift. Replaced rather than appended so
          // a retried sign-out event can't double-count the same scrap.
          if (Array.isArray(scrap)) {
            db.prepare("DELETE FROM shift_scrap WHERE attendance_id = ?").run(attendanceId);
            const insert = db.prepare(
              `INSERT INTO shift_scrap (id, attendance_id, scrap_code_id, scrap_code, scrap_label, description, kg)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            for (const row of scrap) {
              const kg = Number(row?.kg);
              if (!row || !isFinite(kg) || kg <= 0) continue; // skip blank/invalid lines
              // Resolve code and label now: if the admin later renames or
              // removes the code, this record still reads correctly.
              const codeRow = row.scrapCodeId
                ? db.prepare("SELECT code, label FROM scrap_codes WHERE id = ?").get(row.scrapCodeId)
                : null;
              insert.run(
                uuid(), attendanceId, row.scrapCodeId || null,
                codeRow?.code || row.scrapCode || null,
                codeRow?.label || row.scrapLabel || null,
                row.description || null,
                kg
              );
            }
          }
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
        // Rows can be added, edited, or removed at any point while a job
        // is open — before it's finished, while running or paused. Each
        // save sends the FULL current row set for one table (not a diff),
        // which keeps this safe under retry/offline-queueing: the device
        // is the only writer for its own session, so whichever update was
        // generated last simply overwrites, and a duplicate/retried event
        // with the same eventId is caught by the dedup check above like
        // every other event type.
        case "update_rows": {
          const { sessionId, table, rows } = payload;
          if (!table || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(table)) {
            throw new Error(`invalid table key: ${table}`);
          }
          const sess = db.prepare("SELECT table_rows FROM sessions WHERE id = ?").get(sessionId);
          if (!sess) throw new Error(`unknown session: ${sessionId}`);

          let byScreen = {};
          try {
            const parsed = JSON.parse(sess.table_rows || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) byScreen = parsed;
          } catch { /* corrupt or empty — start fresh rather than fail the sync */ }
          byScreen[table] = rows || [];
          db.prepare("UPDATE sessions SET table_rows = ? WHERE id = ?").run(JSON.stringify(byScreen), sessionId);

          // Mirror the two built-in screens into their original columns so
          // anything still reading those keeps seeing correct data.
          if (table === "start" || table === "stop") {
            const column = table === "start" ? "field_values" : "stop_field_values";
            db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(JSON.stringify(rows || []), sessionId);
          }
          break;
        }
        case "stop": {
          const { sessionId, endedAt, status, stopReasonId, completionNote, runningHourEnd } = payload;
          db.prepare(
            "UPDATE sessions SET ended_at = ?, status = ?, stop_reason_id = ?, completion_note = ?, running_hour_end = ? WHERE id = ?"
          ).run(
            endedAt,
            status || "finished",
            stopReasonId || null,
            completionNote || null,
            runningHourEnd ?? null,
            sessionId
          );

          // If this session was tied to a planned work order, move it
          // through the queue: "finished" completes it for good; anything
          // else ("incomplete") releases it back to pending — session_id is
          // cleared so it re-enters the queue and can be picked up again,
          // while the session row itself stays as a permanent record of
          // that attempt.
          const session = db.prepare("SELECT work_order_id FROM sessions WHERE id = ?").get(sessionId);
          if (session && session.work_order_id) {
            if ((status || "finished") === "finished") {
              db.prepare("UPDATE work_orders SET status = 'finished', finished_at = ? WHERE id = ?").run(endedAt, session.work_order_id);
            } else {
              db.prepare("UPDATE work_orders SET status = 'pending', session_id = NULL WHERE id = ?").run(session.work_order_id);
            }
          }
          break;
        }
        // "Delete Job": an operator can remove a job they started by
        // mistake — but only while it's still open. Once a session has
        // been finished (or marked incomplete), it's a permanent record;
        // deletion is refused rather than silently ignored, so a stale
        // offline-queued delete can never destroy real history.
        case "delete_session": {
          const { sessionId } = payload;
          const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
          if (!session) break; // already gone (e.g. a retried delete) — nothing to do
          if (session.status === "finished" || session.status === "incomplete") {
            throw new Error("Cannot delete a session that has already been stopped.");
          }
          if (session.work_order_id) {
            db.prepare("UPDATE work_orders SET status = 'pending', session_id = NULL, started_at = NULL WHERE id = ?").run(
              session.work_order_id
            );
          }
          db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId); // pause_events, session_edits cascade
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
