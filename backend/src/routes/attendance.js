const express = require("express");
const db = require("../lib/db");

const router = express.Router();

// Sign-in/out history, newest first. Filterable by operator and by date
// range so a supervisor can answer "did Ahmed arrive on time this week?"
router.get("/", (req, res) => {
  const { operatorId, machineId, from, to, limit } = req.query;
  const clauses = [];
  const params = [];
  if (operatorId) { clauses.push("a.operator_id = ?"); params.push(operatorId); }
  if (machineId) { clauses.push("a.machine_id = ?"); params.push(machineId); }
  if (from) { clauses.push("a.signed_in_at >= ?"); params.push(from); }
  if (to) { clauses.push("a.signed_in_at <= ?"); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT a.*, o.name as operator_name, o.id_number, m.name as machine_name, m.code as machine_code
       FROM operator_attendance a
       JOIN operators o ON o.id = a.operator_id
       JOIN machines m ON m.id = a.machine_id
       ${where}
       ORDER BY a.signed_in_at DESC
       LIMIT ?`
    )
    .all(...params, Number(limit) || 500);

  // Scrap per attendance record, fetched in one query rather than per row.
  const scrapByAttendance = {};
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const scrapRows = db
      .prepare(`SELECT * FROM shift_scrap WHERE attendance_id IN (${placeholders}) ORDER BY recorded_at ASC`)
      .all(...rows.map((r) => r.id));
    for (const sc of scrapRows) {
      (scrapByAttendance[sc.attendance_id] ||= []).push({
        scrapCode: sc.scrap_code,
        scrapLabel: sc.scrap_label,
        description: sc.description,
        kg: sc.kg,
      });
    }
  }

  res.json(rows.map((r) => ({
    id: r.id,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    idNumber: r.id_number,
    machineId: r.machine_id,
    machineName: r.machine_name,
    machineCode: r.machine_code,
    signedInAt: r.signed_in_at,
    signedOutAt: r.signed_out_at,
    shift: r.shift,
    // null while still signed in — the UI shows "still on shift"
    scrap: scrapByAttendance[r.id] || [],
    scrapTotalKg: (scrapByAttendance[r.id] || []).reduce((sum, x) => sum + x.kg, 0),
    minutes: r.signed_out_at
      ? Math.round(((new Date(r.signed_out_at) - new Date(r.signed_in_at)) / 60000) * 10) / 10
      : null,
  })));
});

// ---- Scrap report ----
// One row per scrap line, shaped like the factory's own scrap sheet:
// date, shift, operator, source machine, code, description, quantity.
router.get("/scrap", (req, res) => {
  const { from, to, operatorId, machineId, shift, limit } = req.query;
  const clauses = [];
  const params = [];
  if (operatorId) { clauses.push("a.operator_id = ?"); params.push(operatorId); }
  if (machineId) { clauses.push("a.machine_id = ?"); params.push(machineId); }
  if (shift) { clauses.push("a.shift = ?"); params.push(shift); }
  if (from) { clauses.push("a.signed_in_at >= ?"); params.push(from); }
  if (to) { clauses.push("a.signed_in_at <= ?"); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT s.*, a.signed_in_at, a.shift, a.operator_id,
              o.name as operator_name, o.id_number,
              m.name as machine_name, m.code as machine_code
       FROM shift_scrap s
       JOIN operator_attendance a ON a.id = s.attendance_id
       JOIN operators o ON o.id = a.operator_id
       JOIN machines m ON m.id = a.machine_id
       ${where}
       ORDER BY a.signed_in_at DESC, s.recorded_at ASC
       LIMIT ?`
    )
    .all(...params, Number(limit) || 2000);

  const byCode = {};
  for (const r of rows) {
    const key = r.scrap_code ? `${r.scrap_code} — ${r.scrap_label || ""}`.trim() : (r.scrap_label || "(no code)");
    byCode[key] = (byCode[key] || 0) + r.kg;
  }

  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      scrapDate: r.signed_in_at,
      shift: r.shift,
      operatorName: r.operator_name,
      idNumber: r.id_number,
      scrapSource: r.machine_name,
      machineCode: r.machine_code,
      scrapCode: r.scrap_code,
      scrapLabel: r.scrap_label,
      description: r.description,
      kg: r.kg,
    })),
    totalKg: Math.round(rows.reduce((sum, r) => sum + r.kg, 0) * 100) / 100,
    byCode: Object.entries(byCode)
      .map(([code, kg]) => ({ code, kg: Math.round(kg * 100) / 100 }))
      .sort((a, b) => b.kg - a.kg),
  });
});

module.exports = router;
