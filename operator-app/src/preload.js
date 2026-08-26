const { contextBridge, ipcRenderer } = require("electron");

// The renderer is plain HTML/JS with no Node access (contextIsolation is on,
// nodeIntegration is off) — this is the only surface it can touch. Every
// operator action goes through here, into main.js, into sessionManager.
contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("get-state"),
  loginOperator: (idNumber) => ipcRenderer.invoke("login-operator", idNumber),
  startSession: (payload) => ipcRenderer.invoke("start-session", payload),
  updateRows: (payload) => ipcRenderer.invoke("update-rows", payload),
  pauseSession: (payload) => ipcRenderer.invoke("pause-session", payload),
  resumeSession: () => ipcRenderer.invoke("resume-session"),
  stopSession: (payload) => ipcRenderer.invoke("stop-session", payload),
  deleteSession: () => ipcRenderer.invoke("delete-session"),
  forceSync: () => ipcRenderer.invoke("force-sync"),
  onStatusUpdate: (callback) => ipcRenderer.on("status-update", (event, status) => callback(status)),
  onFatalError: (callback) => ipcRenderer.on("fatal-error", (event, message) => callback(message)),

  // Top bar window controls
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onWindowState: (callback) => ipcRenderer.on("window-state", (event, state) => callback(state)),
});
