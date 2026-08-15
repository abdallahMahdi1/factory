const express = require("express");
const db = require("../lib/db");

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
        `SELECT s.*, o.name as operator_name
         FROM sessions s JOIN operators o ON o.id = s.operator_id
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
            fieldValues: JSON.parse(openSession.field_values || "{}"),
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

module.exports = router;
