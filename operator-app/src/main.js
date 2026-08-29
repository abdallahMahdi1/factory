const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const { createLocalDb } = require("./localDb");
const { createSessionManager } = require("./sessionManager");

// ---- Load this machine's config ----
// config.json lives NEXT TO the installed app (not bundled inside it), so
// each shop-floor PC gets its own copy pointing at its own machine, without
// rebuilding the app per machine. See config.example.json for the format.
//
// IMPORTANT (portable .exe builds): electron-builder's "portable" target
// self-extracts into a temp folder at launch and runs from there, so
// app.getPath("exe") resolves to that TEMP location — NOT the folder the
// person actually double-clicked in. electron-builder sets
// PORTABLE_EXECUTABLE_DIR specifically to solve this: it's the real,
// visible folder the portable .exe was launched from, which is where
// config.json actually lives. Fall back to app.getPath("exe") for
// non-portable builds (installer-based, or running the unpacked app
// directly) where PORTABLE_EXECUTABLE_DIR isn't set.
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
const CONFIG_PATH = process.env.FT_CONFIG_PATH || path.join(exeDir, "config.json");
const FALLBACK_CONFIG_PATH = path.join(__dirname, "..", "config.json"); // for `npm start` in dev

function loadDeviceConfig() {
  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : FALLBACK_CONFIG_PATH;
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No config.json found. Copy config.example.json to config.json next to the app and fill in ` +
        `apiBase and machineApiKey for this machine (get the key from the admin panel's Machines page).`
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!raw.apiBase || !raw.machineApiKey) {
    throw new Error("config.json must include both apiBase and machineApiKey.");
  }
  return raw;
}

let sessionManager;
let win;
let syncTimer;
// Module-scoped so IPC handlers can read it too (the language setting is
// needed by get-state, which runs long after startup).
let deviceConfig;

const SYNC_INTERVAL_MS = 15000; // matches the 20-minute offline-alert threshold with plenty of margin

function broadcastStatus() {
  if (win && sessionManager) {
    win.webContents.send("status-update", sessionManager.getStatus());
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 820,
    minHeight: 600,
    fullscreen: false,
    frame: false, // no native OS title bar — the in-app top bar (drag region + minimize/maximize/close) is the only one now, instead of stacking on top of a second native one
    title: "Factory Tracker",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.on("maximize", () => win.webContents.send("window-state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("window-state", { maximized: false }));
}

app.whenReady().then(async () => {
  try {
    deviceConfig = loadDeviceConfig();
  } catch (err) {
    // Still show a window so the person setting up the PC sees a real error
    // instead of the app silently vanishing.
    createWindow();
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("fatal-error", err.message);
    });
    return;
  }

  const userDataDir = app.getPath("userData");
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const localDb = createLocalDb(path.join(userDataDir, "operator-app.db"));

  sessionManager = createSessionManager({
    localDb,
    apiBase: deviceConfig.apiBase,
    apiKey: deviceConfig.machineApiKey,
  });

  createWindow();

  // Kick off an immediate sync (in case the app was just restarted with a
  // queue left over from before), then keep syncing on an interval forever.
  const cycle = async () => {
    try {
      await sessionManager.runSyncCycle();
    } catch (err) {
      // runSyncCycle already captures errors into status; this catch is
      // just a last-resort guard so the timer itself never dies.
      console.error("Unexpected sync error:", err);
    }
    broadcastStatus();
  };
  cycle();
  syncTimer = setInterval(cycle, SYNC_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (syncTimer) clearInterval(syncTimer);
  if (process.platform !== "darwin") app.quit();
});

// ---- IPC handlers: the only way the renderer touches app logic ----
// The renderer never talks to the network or the database directly (see
// preload.js) — everything goes through sessionManager so there's exactly
// one place the offline/sync rules live.

ipcMain.handle("get-state", () => ({
  // Which language this machine's screen is in. Set once per PC in
  // config.json when the machine is installed, so operators never have to
  // pick it and it can't get changed by accident mid-shift.
  language: deviceConfig?.language || "en",
  config: sessionManager.getConfig(),
  activeSession: sessionManager.getActiveSession(),
  status: sessionManager.getStatus(),
  recentLocalSessions: sessionManager.getRecentLocalSessions(5),
}));

ipcMain.handle("login-operator", (event, idNumber) => {
  const operator = sessionManager.findOperatorByIdNumber(idNumber);
  if (!operator) throw new Error("That ID isn't authorized on this machine.");
  // Signing in on the machine IS the attendance record — the supervisor
  // sees when someone actually arrived at their machine, not when a
  // separate clock-in terminal was touched.
  sessionManager.signIn(operator);
  sessionManager.runSyncCycle().then(broadcastStatus);
  return operator;
});

ipcMain.handle("logout-operator", (event, payload) => {
  const result = sessionManager.signOut(payload || {});
  sessionManager.runSyncCycle().then(broadcastStatus);
  return result;
});

ipcMain.handle("start-session", (event, { operatorId, operatorName, workOrder, runningHourStart, phase }) => {
  const session = sessionManager.startSession({ operatorId, operatorName, workOrder, runningHourStart, phase });
  sessionManager.runSyncCycle().then(broadcastStatus);
  return session;
});

ipcMain.handle("begin-work", () => {
  const session = sessionManager.beginWork();
  sessionManager.runSyncCycle().then(broadcastStatus);
  return session;
});

ipcMain.handle("update-rows", (event, { table, rows }) => {
  const session = sessionManager.updateRows({ table, rows });
  sessionManager.runSyncCycle().then(broadcastStatus);
  return session;
});

ipcMain.handle("pause-session", (event, { reasonId }) => {
  const session = sessionManager.pauseSession({ reasonId });
  sessionManager.runSyncCycle().then(broadcastStatus);
  return session;
});

ipcMain.handle("resume-session", () => {
  const session = sessionManager.resumeSession();
  sessionManager.runSyncCycle().then(broadcastStatus);
  return session;
});

ipcMain.handle("stop-session", (event, { status, stopReasonId, note, runningHourEnd }) => {
  const result = sessionManager.stopSession({ status, stopReasonId, note, runningHourEnd });
  sessionManager.runSyncCycle().then(broadcastStatus);
  return result;
});

ipcMain.handle("delete-session", () => {
  const result = sessionManager.deleteSession();
  sessionManager.runSyncCycle().then(broadcastStatus);
  return result;
});

ipcMain.handle("force-sync", async () => {
  const result = await sessionManager.runSyncCycle();
  broadcastStatus();
  return result;
});

// ---- Window controls for the in-app top bar ----
// With frame: false, there is no native OS title bar at all — these IPC
// handlers are the ONLY way to minimize/maximize/close the window, wired
// to the buttons in the custom top bar.
ipcMain.handle("window-minimize", () => win?.minimize());
ipcMain.handle("window-maximize-toggle", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window-close", () => win?.close());
ipcMain.handle("window-is-maximized", () => win?.isMaximized() || false);
