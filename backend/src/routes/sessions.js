const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../lib/db");
const { parseRows } = require("../lib/rows");

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
      `SELECT s.*, o.name as operator_name
       FROM sessions s JOIN operators o ON o.id = s.operator_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.started_at ASC`
    )
    .all(...params);

  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // Two-row header to mirror the original sheet: a group row (Input /
  // Output / Raw Materials / ...) above the field-label row, matching how
  // the source report was laid out.
  const fixedCols = ["Date", "Shift", "Operator", "Started", "Ended", "Status"];
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
    const startRows = parseRows(s.field_values);
    const stopRows = parseRows(s.stop_field_values);
    const rowCount = Math.max(startRows.length, stopRows.length, 1);

    for (let i = 0; i < rowCount; i++) {
      const merged = { ...(startRows[i] || {}), ...(stopRows[i] || {}) };
      const fieldCells = fields.map((f) => {
        const raw = merged[f.id];
        if (raw === undefined || raw === null || raw === "") return "";
        return f.type === "select" ? (optionValueById[raw] ?? raw) : raw;
      });
      rows.push([
        new Date(s.started_at).toLocaleDateString(),
        s.shift || "",
        s.operator_name,
        new Date(s.started_at).toLocaleTimeString(),
        s.ended_at ? new Date(s.ended_at).toLocaleTimeString() : "",
        s.status,
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
