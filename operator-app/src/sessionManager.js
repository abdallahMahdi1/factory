// The heart of the operator app. Every operator action writes to the local
// DB FIRST and returns immediately — nothing here ever waits on the network.
// A session's id (and every pause's id) is generated right here on the
// device, which is what makes the sync batch safe to retry: the server
// recognizes the same id twice and just discards the duplicate.
const { randomUUID } = require("crypto");
const { fetchConfig, pushEvents } = require("./sync");

const EMPTY_CONFIG = { machine: null, fields: [], stopFields: [], operators: [], pauseReasons: [], stopReasons: [], workOrders: { pending: [], finished: [] } };

function createSessionManager({ localDb, apiBase, apiKey }) {
  let online = false;
  let lastSyncedAt = null;
  let lastError = null;
  let syncing = false;

  const nowIso = () => new Date().toISOString();

  function getConfig() {
    return localDb.getKV("config", EMPTY_CONFIG);
  }
  function getActiveSession() {
    return localDb.getKV("active_session", null);
  }
  function getStatus() {
    return {
      online,
      lastSyncedAt,
      lastError,
      syncing,
      pendingCount: localDb.countPending(),
      machine: getConfig().machine,
    };
  }

  async function refreshConfig() {
    try {
      const cfg = await fetchConfig({ apiBase, apiKey });
      localDb.setKV("config", cfg);
      online = true;
      lastError = null;
      return cfg;
    } catch (err) {
      online = false;
      lastError = err.message;
      return getConfig(); // fall back to whatever we cached last time we were online
    }
  }

  function findOperatorByIdNumber(idNumber) {
    const cfg = getConfig();
    return cfg.operators.find((o) => String(o.id_number) === String(idNumber)) || null;
  }

  // ---- Attendance: who is signed in at this machine ----
  // Recorded as queued events like everything else, so a shift that starts
  // while the network is down still turns up in the admin panel later.

  function signIn(operator) {
    const attendanceId = randomUUID();
    const signedInAt = nowIso();
    localDb.setKV("attendance", { attendanceId, operatorId: operator.id, operatorName: operator.name, signedInAt });
    localDb.enqueueEvent({
      eventId: `${attendanceId}-in`,
      type: "sign_in",
      payload: { attendanceId, operatorId: operator.id, signedInAt },
    });
    return { attendanceId, signedInAt };
  }

  function signOut({ scrap } = {}) {
    const att = localDb.getKV("attendance", null);
    if (!att) return null;
    const signedOutAt = nowIso();
    localDb.enqueueEvent({
      eventId: `${att.attendanceId}-out`,
      type: "sign_out",
      // Scrap is weighed at end of shift, so it rides along with the
      // sign-out rather than being a separate event that could arrive
      // without its attendance record.
      payload: { attendanceId: att.attendanceId, signedOutAt, scrap: scrap || [] },
    });
    localDb.setKV("attendance", null);
    return { attendanceId: att.attendanceId, signedOutAt };
  }

  function getAttendance() {
    return localDb.getKV("attendance", null);
  }

  function startSession({ operatorId, operatorName, workOrder, runningHourStart, phase }) {
    if (getActiveSession()) throw new Error("A job is already running on this machine.");
    if (!workOrder || !workOrder.id) throw new Error("A work order must be selected to start a job.");
    const sessionId = randomUUID();
    const startedAt = nowIso();
    const session = {
      id: sessionId,
      operatorId,
      operatorName,
      startedAt,
      status: "running",
      pauses: [],
      workOrderId: workOrder.id,
      // A full snapshot of the work order's display info, captured at the
      // moment the job starts. The running screen reads from this rather
      // than re-looking the work order up in the (possibly stale, if
      // offline) cached queue — so what's shown never depends on sync
      // timing once the job is under way.
      workOrderSnapshot: workOrder,
      runningHourStart: runningHourStart ?? null,
      runningHourEnd: null,
      // Each is an array of row objects — the Start table and End table.
      // A session always has at least an empty array here (never
      // undefined), so the UI can render an empty table immediately and
      // the operator adds rows as they go.
      // Rows keyed by screen: { start: [...], stop: [...], scrap: [...] }.
      // A machine defines its own screens, so this can't be two fixed
      // arrays any more.
      screenRows: {},
      // "setup" until the operator presses Start work; everything before
      // that point is counted as setup time rather than production.
      phase: phase === "setup" ? "setup" : "running",
      workStartedAt: phase === "setup" ? null : startedAt,
    };
    localDb.setKV("active_session", session);
    localDb.enqueueEvent({
      eventId: `${sessionId}-start`,
      type: "start",
      createdOffline: !online,
      payload: { sessionId, operatorId, startedAt, workOrderId: workOrder.id, runningHourStart: runningHourStart ?? null, phase: phase === "setup" ? "setup" : "running" },
    });
    return session;
  }

  // Overwrites the FULL row set for one table (Start or End) — not a diff.
  // Safe to call as often as the operator adds/edits/removes a row; each
  // call gets its own fresh eventId so the offline queue treats every save
  // as its own retry-safe event, and the backend just takes whichever one
  // applied most recently as the current truth for that table.
  function updateRows({ table, rows }) {
    const session = getActiveSession();
    if (!session) throw new Error("No active job.");
    if (table !== "start" && table !== "stop") throw new Error(`Invalid table: ${table}`);
    if (!session.screenRows || typeof session.screenRows !== "object") session.screenRows = {};
    session.screenRows[table] = rows;
    localDb.setKV("active_session", session);
    localDb.enqueueEvent({
      eventId: randomUUID(),
      type: "update_rows",
      payload: { sessionId: session.id, table, rows },
    });
    return session;
  }

  // Setup is finished; production starts now. Queued like every other
  // event so it survives being offline.
  function beginWork() {
    const session = getActiveSession();
    if (!session) throw new Error("No active job.");
    if (session.phase !== "setup") return session; // already producing
    const workStartedAt = nowIso();
    session.phase = "running";
    session.workStartedAt = workStartedAt;
    localDb.setKV("active_session", session);
    localDb.enqueueEvent({
      eventId: `${session.id}-begin-work`,
      type: "begin_work",
      payload: { sessionId: session.id, workStartedAt },
    });
    return session;
  }

  function pauseSession({ reasonId }) {
    const session = getActiveSession();
    if (!session) throw new Error("No active job.");
    if (session.status !== "running") throw new Error("Job is not running.");
    const pauseId = randomUUID();
    const startedAt = nowIso();
    session.pauses.push({ id: pauseId, reasonId, startedAt, endedAt: null });
    session.status = "paused";
    localDb.setKV("active_session", session);
    localDb.enqueueEvent({
      eventId: `${pauseId}-pause`,
      type: "pause",
      payload: { sessionId: session.id, pauseId, reasonId, startedAt },
    });
    return session;
  }

  function resumeSession() {
    const session = getActiveSession();
    if (!session) throw new Error("No active job.");
    if (session.status !== "paused") throw new Error("Job is not paused.");
    const openPause = [...session.pauses].reverse().find((p) => !p.endedAt);
    if (!openPause) throw new Error("No open pause found.");
    const endedAt = nowIso();
    openPause.endedAt = endedAt;
    session.status = "running";
    localDb.setKV("active_session", session);
    localDb.enqueueEvent({
      eventId: `${openPause.id}-resume`,
      type: "resume",
      payload: { sessionId: session.id, pauseId: openPause.id, endedAt },
    });
    return session;
  }

  function stopSession({ status, stopReasonId, note, runningHourEnd }) {
    const session = getActiveSession();
    if (!session) throw new Error("No active job.");

    // Stopping mid-pause: close the open pause first so the interval math is
    // always clean, whether anyone ever looks at it in a report or not.
    if (session.status === "paused") {
      const openPause = [...session.pauses].reverse().find((p) => !p.endedAt);
      if (openPause) {
        const endedAt = nowIso();
        openPause.endedAt = endedAt;
        localDb.enqueueEvent({
          eventId: `${openPause.id}-resume`,
          type: "resume",
          payload: { sessionId: session.id, pauseId: openPause.id, endedAt },
        });
      }
    }

    const endedAt = nowIso();
    localDb.enqueueEvent({
      eventId: `${session.id}-stop`,
      type: "stop",
      payload: {
        sessionId: session.id,
        endedAt,
        status,
        stopReasonId: stopReasonId || null,
        completionNote: note || null,
        runningHourEnd: runningHourEnd ?? null,
      },
    });

    localDb.addLocalSessionRecord({
      id: session.id,
      operatorName: session.operatorName,
      startedAt: session.startedAt,
      endedAt,
      status,
      grossMinutes: (new Date(endedAt) - new Date(session.startedAt)) / 60000,
    });

    localDb.setKV("active_session", null);
    return { id: session.id, endedAt, status };
  }

  // "Delete Job": lets an operator remove a job started by mistake — only
  // while it's still open (running/paused). Checked here too, not just on
  // the backend, so the app can give an immediate, clear error instead of
  // queuing an event that's guaranteed to be refused later.
  function deleteSession() {
    const session = getActiveSession();
    if (!session) throw new Error("No active job.");
    localDb.enqueueEvent({
      eventId: randomUUID(),
      type: "delete_session",
      payload: { sessionId: session.id },
    });
    localDb.setKV("active_session", null);
    return { id: session.id };
  }

  // Pulls fresh config (so admin-panel edits eventually reach the shop
  // floor) and drains the local event queue in small batches. Safe to call
  // as often as you like — it's a no-op when there's nothing to do and
  // offline runs cost nothing but one failed request.
  async function runSyncCycle() {
    syncing = true;
    try {
      // Push first, then pull: this way, refreshing config right after
      // pushing an event (e.g. right after an operator stops a job) sees
      // the RESULT of that same push — the just-finished work order
      // correctly shows as finished, not still in_progress from a moment
      // ago. Pulling first (the previous order) meant the freshest local
      // change was always one cycle behind in what the config showed.
      let pushed = 0;
      for (;;) {
        const batch = localDb.getPendingEvents(50);
        if (batch.length === 0) break;
        try {
          const { results } = await pushEvents({ apiBase, apiKey, events: batch });
          const okIds = results.filter((r) => r.ok).map((r) => r.eventId);
          localDb.removeEvents(okIds);
          pushed += okIds.length;
          online = true;
          lastError = null;
          lastSyncedAt = nowIso();
          if (okIds.length < batch.length) break; // a server-side rejection — stop, don't loop forever on a bad event
        } catch (err) {
          online = false;
          lastError = err.message;
          break; // no network — leave the rest queued, try again next cycle
        }
      }

      await refreshConfig();
      return { pushed, pendingCount: localDb.countPending(), online };
    } finally {
      syncing = false;
    }
  }

  return {
    getConfig,
    getStatus,
    getActiveSession,
    refreshConfig,
    findOperatorByIdNumber,
    signIn,
    signOut,
    getAttendance,
    startSession,
    beginWork,
    updateRows,
    pauseSession,
    resumeSession,
    stopSession,
    deleteSession,
    runSyncCycle,
    getRecentLocalSessions: (limit) => localDb.getRecentLocalSessions(limit),
  };
}

module.exports = { createSessionManager };
