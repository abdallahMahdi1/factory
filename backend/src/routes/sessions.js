const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../lib/db");
const { parseRows, parseAllScreenRows } = require("../lib/rows");

const router = express.Router();

function pausesFor(sessionId) {
  return db.prepare("SELECT * FROM pause_events WHERE session_id = ? ORDER BY started_at ASC").all(sessionId);
}
function editsFor(sessionId) {
  return db.prepare("SELECT * FROM session_edits WHERE session_id = ? ORDER BY edited_at DESC").all(sessionId);
}

// List sessions, newest first, optionally filtered by machine/operator/date/status
router.get("/", (req, res) => {
  const { machineId, operatorId, status, from, to } = req.query;
  const clauses = [];
  const params = [];
  if (machineId) { clauses.push("s.machine_id = ?"); params.push(machineId); }
  if (operatorId) { clauses.push("s.operator_id = ?"); params.push(operatorId); }
  if (status) { clauses.push("s.status = ?"); params.push(status); }
  if (from) { clauses.push("s.started_at >= ?"); params.push(from); }
  if (to) { clauses.push("s.started_at <= ?"); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT s.*, m.name as machine_name, o.name as operator_name, w.job_no as work_order_job_no
       FROM sessions s
       JOIN machines m ON m.id = s.machine_id
       JOIN operators o ON o.id = s.operator_id
       LEFT JOIN work_orders w ON w.id = s.work_order_id
       ${where}
       ORDER BY s.started_at DESC
       LIMIT 500`
    )
    .all(...params);
  res.json(rows);
});

// CSV export — reconstructs a report row per session, one column per
// machine field (start-stage fields first, then stop-stage fields, each in
// their configured sort order), plus the built-in time/status columns.
// Built specifically so a machine set up from a real paper/Excel sheet
// (e.g. via Machines -> Import from sheet) can be exported back out in a
// shape that matches the original report exactly.
router.get("/export.csv", (req, res) => {
  const { machineId, operatorId, status, from, to } = req.query;
  if (!machineId) return res.status(400).json({ error: "machineId is required for CSV export (each machine can have a different set of columns)" });

  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId);
  if (!machine) return res.status(404).json({ error: "Machine not found" });

  const fields = db
    .prepare("SELECT * FROM machine_fields WHERE machine_id = ? ORDER BY stage ASC, sort_order ASC")
    .all(machineId);

  const optionValueById = {};
  db.prepare(
    `SELECT oi.id, oi.value FROM option_items oi
     JOIN machine_fields mf ON mf.option_list_id = oi.option_list_id
     WHERE mf.machine_id = ?`
  )
    .all(machineId)
    .forEach((row) => (optionValueById[row.id] = row.value));

  const clauses = ["s.machine_id = ?"];
  const params = [machineId];
  if (operatorId) { clauses.push("s.operator_id = ?"); params.push(operatorId); }
  if (status) { clauses.push("s.status = ?"); params.push(status); }
  if (from) { clauses.push("s.started_at >= ?"); params.push(from); }
  if (to) { clauses.push("s.started_at <= ?"); params.push(to); }

  const sessions = db
    .prepare(
      `SELECT s.*, o.name as operator_name, o.id_number as operator_id_number,
              m.name as machine_name,
              w.job_no as work_order_job_no, w.description as work_order_description,
              w.process as work_order_process, w.remarks as work_order_remarks,
              w.quantity as work_order_quantity, w.due_date as work_order_due_date,
              w.input_diameter as work_order_input_diameter,
              w.total_tolerance as work_order_total_tolerance,
              w.special_instruction as work_order_special_instruction,
              sr.code as stop_reason_code, sr.label as stop_reason_label
       FROM sessions s
       JOIN operators o ON o.id = s.operator_id
       JOIN machines m ON m.id = s.machine_id
       LEFT JOIN work_orders w ON w.id = s.work_order_id
       LEFT JOIN stop_reasons sr ON sr.id = s.stop_reason_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.started_at ASC`
    )
    .all(...params);

  // All pauses for the exported sessions, fetched once rather than per row.
  const pausesBySession = {};
  if (sessions.length > 0) {
    const ph = sessions.map(() => "?").join(",");
    for (const p of db
      .prepare(`SELECT session_id, started_at, ended_at FROM pause_events WHERE session_id IN (${ph})`)
      .all(...sessions.map((x) => x.id))) {
      (pausesBySession[p.session_id] ||= []).push(p);
    }
  }

  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // Two-row header to mirror the original sheet: a group row (Input /
  // Output / Raw Materials / ...) above the field-label row, matching how
  // the source report was laid out.
  // Column order mirrors the factory's own Production Department sheet:
  // Machine, Shift, W.O. No., Cable Size/Description, Opr No., Process,
  // Remarks — so an exported file drops straight into their reporting
  // without being re-arranged first.
  const fixedCols = [
    "Date", "Machine", "Shift", "W.O. No.", "Cable Size/Description",
    "Opr No.", "Operator", "Process", "Qty", "Due date",
    "Input dia.", "Tolerance", "Special instruction", "Remarks",
    "Started", "Ended", "Setup (min)", "Worked (min)", "Paused (min)",
    "Status", "Stop reason",
  ];
  const groupHeaderRow = [...fixedCols.map(() => ""), ...fields.map((f) => f.group_label || "")];
  const labelHeaderRow = [...fixedCols, ...fields.map((f) => f.label)];

  // Each session can now have MULTIPLE rows in its Start table and
  // multiple in its End table (e.g. several bobbins in, several drums
  // out) — one CSV row is emitted per physical row, pairing Start-row N
  // with End-row N by position. Sessions with more rows in one table than
  // the other just leave the shorter side blank for the extra rows; this
  // is a reasonable default pairing (matches how the two tables read
  // top-to-bottom in the reference layout) but isn't a guaranteed 1:1
  // correspondence in every real workflow.
  const rows = [];
  for (const s of sessions) {
    // EVERY screen the machine defines, not just the two built-ins. Reading
    // only field_values/stop_field_values meant any custom screen (Scrap,
    // Toolings, a line-speed table...) exported as empty columns, because
    // its rows live in table_rows.
    const byScreen = parseAllScreenRows(s);
    const screenKeys = Object.keys(byScreen);
    const rowCount = Math.max(1, ...screenKeys.map((k) => byScreen[k].length));

    for (let i = 0; i < rowCount; i++) {
      // Row i of each screen, side by side on one CSV line. Screens with
      // fewer rows just leave their columns blank for the extra lines.
      const merged = {};
      for (const key of screenKeys) Object.assign(merged, byScreen[key][i] || {});
      const fieldCells = fields.map((f) => {
        const raw = merged[f.id];
        if (raw === undefined || raw === null || raw === "") return "";
        return f.type === "select" ? (optionValueById[raw] ?? raw) : raw;
      });
      // Timing split out so a supervisor can see setup vs actual production
      // without recomputing it from the raw timestamps.
      const startMs = new Date(s.started_at).getTime();
      const workMs = s.work_started_at ? new Date(s.work_started_at).getTime() : startMs;
      const endMs = s.ended_at ? new Date(s.ended_at).getTime() : Date.now();
      const pausedMs = (pausesBySession[s.id] || []).reduce((sum, p) => {
        const a = new Date(p.started_at).getTime();
        const b = p.ended_at ? new Date(p.ended_at).getTime() : endMs;
        return sum + Math.max(0, b - a);
      }, 0);
      const mins = (ms) => Math.round((ms / 60000) * 10) / 10;

      rows.push([
        new Date(s.started_at).toLocaleDateString(),
        s.machine_name,
        // Single letter, as the sheet uses: D / N
        s.shift ? s.shift.charAt(0).toUpperCase() : "",
        s.work_order_job_no || "",
        s.work_order_description || "",
        s.operator_id_number || "",
        s.operator_name || "",
        s.work_order_process || "",
        s.work_order_quantity ?? "",
        s.work_order_due_date || "",
        s.work_order_input_diameter ?? "",
        s.work_order_total_tolerance || "",
        s.work_order_special_instruction || "",
        s.work_order_remarks || "",
        new Date(s.started_at).toLocaleTimeString(),
        s.ended_at ? new Date(s.ended_at).toLocaleTimeString() : "",
        mins(workMs - startMs),
        mins(Math.max(0, endMs - workMs - pausedMs)),
        mins(pausedMs),
        s.status,
        s.stop_reason_code ? `${s.stop_reason_code} — ${s.stop_reason_label}` : (s.stop_reason_label || ""),
        ...fieldCells,
      ]);
    }
  }

  const csv = [groupHeaderRow, labelHeaderRow, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${machine.code}-production-report.csv"`);
  res.send(csv);
});

router.get("/:id", (req, res) => {
  const session = db
    .prepare(
      `SELECT s.*, m.name as machine_name, o.name as operator_name, w.job_no as work_order_job_no, w.description as work_order_description
       FROM sessions s
       JOIN machines m ON m.id = s.machine_id
       JOIN operators o ON o.id = s.operator_id
       LEFT JOIN work_orders w ON w.id = s.work_order_id
       WHERE s.id = ?`
    )
    .get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ ...session, pauses: pausesFor(session.id), edits: editsFor(session.id) });
});

// Manually correct a session. Every changed field is written to session_edits
// so nothing is ever silently overwritten — old and new value both kept.
router.put("/:id", (req, res) => {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const editedBy = (req.admin && req.admin.username) || "unknown-admin";
  const editable = ["started_at", "ended_at", "status", "completion_note"];
  const updates = {};
  const tx = db.transaction(() => {
    for (const field of editable) {
      const incomingKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); // startedAt etc
      if (req.body && req.body[incomingKey] !== undefined && req.body[incomingKey] !== session[field]) {
        db.prepare(
          "INSERT INTO session_edits (id, session_id, edited_by, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(uuid(), session.id, editedBy, field, session[field], String(req.body[incomingKey]));
        updates[field] = req.body[incomingKey];
      }
    }
    if (Object.keys(updates).length) {
      const setClause = Object.keys(updates).map((f) => `${f} = ?`).join(", ");
      db.prepare(`UPDATE sessions SET ${setClause} WHERE id = ?`).run(
        ...Object.values(updates),
        session.id
      );
    }
  });
  tx();

  const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id);
  res.json({ ...updated, pauses: pausesFor(session.id), edits: editsFor(session.id) });
});


module.exports = router;
