// The heart of the operator app. Every operator action writes to the local
// DB FIRST and returns immediately — nothing here ever waits on the network.
// A session's id (and every pause's id) is generated right here on the
// device, which is what makes the sync batch safe to retry: the server
// recognizes the same id twice and just discards the duplicate.
const { randomUUID } = require("crypto");
const { fetchConfig, pushEvents } = require("./sync");

const EMPTY_CONFIG = { machine: null, fields: [], operators: [], pauseReasons: [], stopReasons: [] };

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

  function startSession({ operatorId, operatorName, fieldValues }) {
    if (getActiveSession()) throw new Error("A job is already running on this machine.");
    const sessionId = randomUUID();
    const startedAt = nowIso();
    const session = {
      id: sessionId,
      operatorId,
      operatorName,
      fieldValues: fieldValues || {},
      startedAt,
      status: "running",
      pauses: [],
    };
    localDb.setKV("active_session", session);
    localDb.enqueueEvent({
      eventId: `${sessionId}-start`,
      type: "start",
      createdOffline: !online,
      payload: { sessionId, operatorId, fieldValues: session.fieldValues, startedAt },
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

  function stopSession({ status, stopReasonId, note, stopFieldValues }) {
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
        stopFieldValues: stopFieldValues || {},
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

  // Pulls fresh config (so admin-panel edits eventually reach the shop
  // floor) and drains the local event queue in small batches. Safe to call
  // as often as you like — it's a no-op when there's nothing to do and
  // offline runs cost nothing but one failed request.
  async function runSyncCycle() {
    syncing = true;
    try {
      await refreshConfig();

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
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    runSyncCycle,
    getRecentLocalSessions: (limit) => localDb.getRecentLocalSessions(limit),
  };
}

module.exports = { createSessionManager };
