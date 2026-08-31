const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const { createLocalDb } = require("./localDb");
const { createSessionManager } = require("./sessionManager");
const { initAutoUpdate, getUpdateState } = require("./autoUpdate");

// ---- Load this machine's config ----
// Each shop-floor PC gets its own config.json pointing at its own machine,
// so one build serves every machine. See config.example.json for the format.
//
// The authoritative location is the USER-DATA folder, deliberately not the
// install folder: an auto-update replaces everything in the install
// directory, and a machine losing its API key on every update would mean
// someone walking the floor to re-enter them. User-data survives updates
// and uninstall/reinstall.
//
// Two legacy locations are still read, in order, so existing installs keep
// working and get migrated automatically on first launch:
//   1. next to a portable .exe (PORTABLE_EXECUTABLE_DIR) — the old format
//   2. next to the executable / project root — dev and older builds
const USER_CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
const LEGACY_PATHS = [
  path.join(exeDir, "config.json"),
  path.join(__dirname, "..", "config.json"), // `npm start` in dev
];

function loadDeviceConfig() {
  const explicit = process.env.FT_CONFIG_PATH;
  const candidates = explicit ? [explicit] : [USER_CONFIG_PATH, ...LEGACY_PATHS];
  const configPath = candidates.find((p) => p && fs.existsSync(p));

  if (!configPath) {
    // Name the exact path rather than "next to the app": with an installer
    // build there's no obvious folder to point at, and someone setting up a
    // PC shouldn't have to guess.
    throw new Error(
      `No config.json found. Create it at:\n${USER_CONFIG_PATH}\n\n` +
        `It needs apiBase and machineApiKey for this machine — get the key from ` +
        `the admin panel's Machines page. See config.example.json for the format.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!raw.apiBase || !raw.machineApiKey) {
    throw new Error("config.json must include both apiBase and machineApiKey.");
  }

  // Migrate a legacy config into user-data once, so the next update can't
  // take it away. Best-effort: a read-only folder shouldn't stop the app.
  if (configPath !== USER_CONFIG_PATH && !explicit) {
    try {
      fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
      fs.copyFileSync(configPath, USER_CONFIG_PATH);
      console.log(`Copied config.json to ${USER_CONFIG_PATH} so updates can't overwrite it.`);
    } catch (err) {
      console.warn("Could not copy config.json into user-data:", err.message);
    }
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

  // Background updates: downloads silently, installs when the app next
  // closes. Never interrupts a running job.
  initAutoUpdate((updateState) => {
    if (win && !win.isDestroyed()) win.webContents.send("update-state", updateState);
  });

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

ipcMain.handle("get-update-state", () => getUpdateState());

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
