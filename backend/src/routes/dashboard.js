const express = require("express");
const db = require("../lib/db");
const { parseRows } = require("../lib/rows");

const router = express.Router();

const OFFLINE_ALERT_MINUTES = Number(process.env.OFFLINE_ALERT_MINUTES || 20);
const LONG_SESSION_ALERT_HOURS = Number(process.env.LONG_SESSION_ALERT_HOURS || 14);

// Builds the "worked from 1:00 to 2:12, then paused, then worked..." segment
// list for one machine's most recent relevant session (today's open session
// if there is one, otherwise the most recently finished one) — this is the
// same shape the Sessions detail view uses, just for whichever job is most
// relevant to show on the live floor status board right now.
function timelineFor(machineId) {
  const session = db
    .prepare(
      `SELECT s.*, o.name as operator_name
       FROM sessions s JOIN operators o ON o.id = s.operator_id
       WHERE s.machine_id = ?
       ORDER BY (s.ended_at IS NULL) DESC, s.started_at DESC
       LIMIT 1`
    )
    .get(machineId);
  if (!session) return null;

  const pauses = db
    .prepare("SELECT * FROM pause_events WHERE session_id = ? ORDER BY started_at ASC")
    .all(session.id);

  // Turn (start, end, [pauses]) into an ordered list of "work" and "pause"
  // segments with real clock times — exactly the "1:00 to 2:12 work, then
  // pause, then work..." shape, computed fresh from the raw timestamps
  // rather than trusting any pre-aggregated duration.
  const segments = [];
  let cursor = session.started_at;
  for (const p of pauses) {
    if (p.started_at > cursor) segments.push({ type: "work", from: cursor, to: p.started_at });
    segments.push({ type: "pause", from: p.started_at, to: p.ended_at, reasonId: p.reason_id });
    if (p.ended_at) cursor = p.ended_at;
  }
  const tail = session.ended_at || null; // null = still running, segment stays open
  if (!tail || tail > cursor) segments.push({ type: "work", from: cursor, to: tail });

  return {
    sessionId: session.id,
    operatorName: session.operator_name,
    status: session.status,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    segments,
  };
}

router.get("/status", (req, res) => {
  const machines = db.prepare("SELECT * FROM machines ORDER BY name ASC").all();
  const now = Date.now();

  const status = machines.map((m) => {
    const openSession = db
      .prepare(
        `SELECT s.*, o.name as operator_name, w.job_no as work_order_job_no
         FROM sessions s
         JOIN operators o ON o.id = s.operator_id
         LEFT JOIN work_orders w ON w.id = s.work_order_id
         WHERE s.machine_id = ? AND s.ended_at IS NULL
         ORDER BY s.started_at DESC LIMIT 1`
      )
      .get(m.id);

    const minutesSinceHeartbeat = m.last_heartbeat_at
      ? Math.round((now - new Date(m.last_heartbeat_at + "Z").getTime()) / 60000)
      : null;
    const offlineAlert = minutesSinceHeartbeat === null || minutesSinceHeartbeat > OFFLINE_ALERT_MINUTES;

    let longRunningAlert = false;
    let runningHours = null;
    if (openSession) {
      runningHours = (now - new Date(openSession.started_at + "Z").getTime()) / 3600000;
      longRunningAlert = runningHours > LONG_SESSION_ALERT_HOURS;
    }

    return {
      machineId: m.id,
      machineName: m.name,
      machineCode: m.code,
      currentSession: openSession
        ? {
            id: openSession.id,
            operatorName: openSession.operator_name,
            status: openSession.status,
            startedAt: openSession.started_at,
            runningHours: runningHours ? Math.round(runningHours * 10) / 10 : null,
            // Rows (not a single flat set of values) since a session's
            // Start table can now have more than one row — the dashboard
            // card shows the FIRST row as a representative preview rather
            // than every row of every machine's card, which would get
            // cluttered fast on a floor with many machines.
            fieldValuesPreview: parseRows(openSession.field_values)[0] || {},
            startRowCount: parseRows(openSession.field_values).length,
            workOrderJobNo: openSession.work_order_job_no || null,
          }
        : null,
      // Sent once per machine so the dashboard can label fieldValues above
      // without a second round-trip per card — small enough (a handful of
      // fields per machine) that including it here is simpler than adding
      // a separate endpoint just for this.
      fields: db
        .prepare(
          `SELECT id, label, type, option_list_id FROM machine_fields WHERE machine_id = ? AND stage = 'start' ORDER BY sort_order ASC`
        )
        .all(m.id),
      timeline: timelineFor(m.id),
      lastHeartbeatAt: m.last_heartbeat_at,
      minutesSinceHeartbeat,
      alerts: {
        offline: offlineAlert,
        longRunningSession: longRunningAlert,
      },
    };
  });

  res.json({
    generatedAt: new Date().toISOString(),
    thresholds: { offlineAlertMinutes: OFFLINE_ALERT_MINUTES, longSessionAlertHours: LONG_SESSION_ALERT_HOURS },
    machines: status,
  });
});

// ---- Daily timeline report: the full 24 hours for one machine ----
// Answers "what happened on this machine today?" as one continuous,
// gap-free list of rows: worked 1h on WO-123, paused 30m for RS03, idle
// 20m, worked 2h... covering the whole day with nothing unaccounted for.
//
// Every row is derived, not stored: work segments come from sessions
// minus their pauses, pause rows come from pause_events, and idle rows
// are whatever time is left over between them. That means the report
// stays correct even for sessions edited after the fact, and there's no
// separate report table that could drift out of sync with reality.
router.get("/daily-report", (req, res) => {
  const { machineId, date } = req.query;
  if (!machineId) return res.status(400).json({ error: "machineId is required" });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date is required, formatted YYYY-MM-DD" });
  }

  const machine = db.prepare("SELECT id, name, code FROM machines WHERE id = ?").get(machineId);
  if (!machine) return res.status(404).json({ error: "Machine not found" });

  // The report day runs local-midnight to local-midnight. Constructing the
  // bounds from the plain date string this way (rather than in UTC) is what
  // makes "today" mean the operator's actual shift day.
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const now = new Date();
  // Never report past "now" for today — an in-progress day shouldn't show
  // hours of phantom idle time stretching to midnight.
  const reportEnd = dayEnd > now ? now : dayEnd;
  if (reportEnd <= dayStart) {
    return res.json({ machine, date, rows: [], totals: emptyTotals(), generatedAt: now.toISOString() });
  }

  // Any session that OVERLAPS the day, not just ones that started in it —
  // a night-shift job running 22:00→06:00 belongs in both days' reports,
  // clipped to each day's bounds.
  const sessions = db
    .prepare(
      `SELECT s.*, o.name as operator_name, w.job_no as work_order_job_no, w.description as work_order_description
       FROM sessions s
       JOIN operators o ON o.id = s.operator_id
       LEFT JOIN work_orders w ON w.id = s.work_order_id
       WHERE s.machine_id = ?
         AND s.started_at < ?
         AND (s.ended_at IS NULL OR s.ended_at > ?)
       ORDER BY s.started_at ASC`
    )
    .all(machineId, reportEnd.toISOString(), dayStart.toISOString());

  const pauseReasonById = {};
  for (const r of db.prepare("SELECT id, code, label FROM pause_reasons").all()) pauseReasonById[r.id] = r;
  const stopReasonById = {};
  for (const r of db.prepare("SELECT id, code, label FROM stop_reasons").all()) stopReasonById[r.id] = r;

  const clamp = (d) => new Date(Math.min(Math.max(d.getTime(), dayStart.getTime()), reportEnd.getTime()));
  const segments = [];

  for (const s of sessions) {
    const sStart = new Date(s.started_at);
    const sEnd = s.ended_at ? new Date(s.ended_at) : reportEnd;
    const pauses = db
      .prepare("SELECT * FROM pause_events WHERE session_id = ? ORDER BY started_at ASC")
      .all(s.id);

    const jobLabel = s.work_order_job_no || "(no work order)";
    const stopReason = s.stop_reason_id ? stopReasonById[s.stop_reason_id] : null;

    // Walk the session start→end, emitting a "work" segment for each
    // stretch between pauses, and a "pause" segment for each pause.
    let cursor = sStart;
    for (const p of pauses) {
      const pStart = new Date(p.started_at);
      const pEnd = p.ended_at ? new Date(p.ended_at) : sEnd;
      if (pStart > cursor) {
        segments.push({ kind: "work", from: cursor, to: pStart, session: s, jobLabel, stopReason });
      }
      const reason = p.reason_id ? pauseReasonById[p.reason_id] : null;
      segments.push({ kind: "pause", from: pStart, to: pEnd, session: s, jobLabel, reason });
      if (pEnd > cursor) cursor = pEnd;
    }
    if (sEnd > cursor) {
      segments.push({ kind: "work", from: cursor, to: sEnd, session: s, jobLabel, stopReason });
    }
  }

  // Clip everything to the day, drop anything that falls entirely outside
  // it or collapses to zero length once clipped.
  const clipped = segments
    .map((seg) => ({ ...seg, from: clamp(seg.from), to: clamp(seg.to) }))
    .filter((seg) => seg.to > seg.from)
    .sort((a, b) => a.from - b.from);

  // Fill every remaining gap (including before the first segment and after
  // the last) with explicit idle rows, so the rows always add up to the
  // full elapsed day with nothing unaccounted for.
  const rows = [];
  let cursor = dayStart;
  const pushIdle = (from, to) => {
    if (to > from) rows.push({ kind: "idle", startedAt: from.toISOString(), endedAt: to.toISOString(), minutes: minutesBetween(from, to) });
  };

  for (const seg of clipped) {
    if (seg.from > cursor) pushIdle(cursor, seg.from);
    if (seg.from < cursor) {
      // Overlapping segments shouldn't happen (one machine runs one job at
      // a time), but if data is ever inconsistent, skip rather than emit a
      // negative-duration row.
      if (seg.to <= cursor) continue;
      seg.from = cursor;
    }
    rows.push({
      kind: seg.kind,
      startedAt: seg.from.toISOString(),
      endedAt: seg.to.toISOString(),
      minutes: minutesBetween(seg.from, seg.to),
      sessionId: seg.session.id,
      operatorName: seg.session.operator_name,
      jobNo: seg.jobLabel,
      jobDescription: seg.session.work_order_description || null,
      sessionStatus: seg.session.status,
      reasonCode: seg.kind === "pause" ? (seg.reason?.code || null) : (seg.stopReason?.code || null),
      reasonLabel: seg.kind === "pause"
        ? (seg.reason?.label || "No reason given")
        : (seg.stopReason?.label || null),
    });
    cursor = seg.to;
  }
  pushIdle(cursor, reportEnd);

  const totals = emptyTotals();
  for (const r of rows) {
    if (r.kind === "work") totals.workMinutes += r.minutes;
    else if (r.kind === "pause") totals.pauseMinutes += r.minutes;
    else totals.idleMinutes += r.minutes;
  }
  totals.totalMinutes = totals.workMinutes + totals.pauseMinutes + totals.idleMinutes;
  totals.utilizationPercent = totals.totalMinutes > 0
    ? Math.round((totals.workMinutes / totals.totalMinutes) * 1000) / 10
    : 0;

  // Downtime grouped by reason — the "why did we lose time today" summary.
  const byReason = {};
  for (const r of rows) {
    if (r.kind !== "pause") continue;
    const key = r.reasonCode ? `${r.reasonCode} — ${r.reasonLabel}` : r.reasonLabel;
    byReason[key] = (byReason[key] || 0) + r.minutes;
  }
  const downtimeByReason = Object.entries(byReason)
    .map(([reason, minutes]) => ({ reason, minutes }))
    .sort((a, b) => b.minutes - a.minutes);

  res.json({ machine, date, rows, totals, downtimeByReason, generatedAt: now.toISOString() });
});

function emptyTotals() {
  return { workMinutes: 0, pauseMinutes: 0, idleMinutes: 0, totalMinutes: 0, utilizationPercent: 0 };
}
function minutesBetween(a, b) {
  return Math.round(((b - a) / 60000) * 10) / 10;
}

module.exports = router;
