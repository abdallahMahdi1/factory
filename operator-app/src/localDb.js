// Everything the operator app needs to keep on disk so it can run with zero
// internet: the last-known machine config, the current in-progress session,
// a queue of not-yet-synced events, and a small local log of today's finished
// jobs (so the operator gets confirmation even before anything reaches the server).
//
// This is a plain JSON file, not a real database — deliberately. The data
// here is tiny (a handful of queued events, one active session, a short list
// of recent jobs), so a database engine buys nothing. It also means this
// module has ZERO native dependencies: nothing to compile, nothing that can
// go out of sync with whatever Node version Electron happens to bundle. On a
// shop-floor PC that a technician sets up once and never touches again,
// "never needs a compiler" is worth more than a real SQL engine would add.
const fs = require("fs");
const path = require("path");

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { kv: {}, eventQueue: [], localSessions: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      kv: parsed.kv || {},
      eventQueue: parsed.eventQueue || [],
      localSessions: parsed.localSessions || [],
    };
  } catch {
    // A corrupted file (e.g. power loss mid-write, extremely unlikely given
    // the atomic write below, but not impossible) should never crash the
    // app on a factory floor — start clean rather than refuse to open.
    return { kv: {}, eventQueue: [], localSessions: [] };
  }
}

// Write-to-temp-then-rename is atomic on both Windows and POSIX filesystems,
// so a mid-write power loss leaves either the old file or the new one intact
// — never a half-written, corrupt one.
function writeFileAtomic(filePath, data) {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function createLocalDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let data = readFile(dbPath);
  const save = () => writeFileAtomic(dbPath, data);

  return {
    getKV(key, fallback = null) {
      return key in data.kv ? data.kv[key] : fallback;
    },
    setKV(key, value) {
      data.kv[key] = value;
      save();
    },

    // Idempotent by design: same eventId (e.g. a UI double-click) is a no-op.
    enqueueEvent(event) {
      if (data.eventQueue.some((e) => e.id === event.eventId)) return;
      data.eventQueue.push({ id: event.eventId, payload: event, createdAt: new Date().toISOString() });
      save();
    },
    getPendingEvents(limit = 50) {
      return data.eventQueue
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map((e) => e.payload);
    },
    removeEvents(ids) {
      const idSet = new Set(ids);
      data.eventQueue = data.eventQueue.filter((e) => !idSet.has(e.id));
      save();
    },
    countPending() {
      return data.eventQueue.length;
    },

    addLocalSessionRecord(rec) {
      data.localSessions.push({
        id: rec.id,
        operator_name: rec.operatorName,
        started_at: rec.startedAt,
        ended_at: rec.endedAt,
        status: rec.status,
        gross_minutes: rec.grossMinutes,
      });
      // Keep this list small on disk — only the operator app's own "recent
      // on this machine" panel reads it, so history beyond that has no use.
      if (data.localSessions.length > 200) {
        data.localSessions = data.localSessions
          .slice()
          .sort((a, b) => b.started_at.localeCompare(a.started_at))
          .slice(0, 200);
      }
      save();
    },
    getRecentLocalSessions(limit = 10) {
      return data.localSessions
        .slice()
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, limit);
    },

    close() {
      // Every mutation above already saves synchronously — nothing pending to flush.
    },
  };
}

module.exports = { createLocalDb };
