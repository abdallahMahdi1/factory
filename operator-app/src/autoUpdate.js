const { autoUpdater } = require("electron-updater");
const { app } = require("electron");

// How often to look for a new version once the app is running. Six hours
// is frequent enough that a machine picks up a release the same shift,
// without hammering GitHub from every PC on the floor.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Never interrupt production. The updater downloads in the background and
// stages the install for the next time the app closes — it must never
// restart the app on its own, because on a shop floor that could happen
// mid-job and lose the operator's unsaved rows.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let broadcast = () => {};
let state = { status: "idle", version: null, message: null };

function setState(patch) {
  state = { ...state, ...patch };
  broadcast(state);
}

function getUpdateState() {
  return { ...state, currentVersion: app.getVersion() };
}

function initAutoUpdate(sendToRenderer) {
  broadcast = sendToRenderer || (() => {});

  // In development there's no update feed and no packaged app to replace,
  // so checking would only produce confusing errors in the console.
  if (!app.isPackaged) {
    setState({ status: "disabled", message: "Updates are disabled in development." });
    return;
  }

  autoUpdater.on("checking-for-update", () => setState({ status: "checking", message: null }));
  autoUpdater.on("update-not-available", () => setState({ status: "up-to-date", version: null, message: null }));
  autoUpdater.on("update-available", (info) =>
    setState({ status: "downloading", version: info?.version || null, message: null })
  );
  autoUpdater.on("download-progress", (p) =>
    setState({ status: "downloading", percent: Math.round(p?.percent || 0) })
  );
  autoUpdater.on("update-downloaded", (info) =>
    setState({
      status: "ready",
      version: info?.version || null,
      message: "Update ready — it installs the next time this app is closed.",
    })
  );
  // A failed check is not worth alarming an operator about: the machine
  // keeps working offline by design, and the next check will retry.
  autoUpdater.on("error", (err) => {
    console.warn("Update check failed:", err?.message || err);
    setState({ status: "error", message: null });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("Update check failed:", err?.message || err);
    });
  };

  // Slight delay on launch so the first sync and the operator's login
  // aren't competing with an update download for bandwidth.
  setTimeout(check, 30 * 1000);
  setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdate, getUpdateState };
