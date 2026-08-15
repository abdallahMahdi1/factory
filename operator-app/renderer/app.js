// All of this talks to the app only through window.api (see preload.js).
// No network calls and no filesystem access happen here — that separation
// is what keeps "what happens when offline" logic in exactly one place.

let state = { config: null, activeSession: null, status: null, recentLocalSessions: [] };
let currentOperator = null;
let timerHandle = null;
let pendingStop = { status: null, reasonId: null };
// When set, render() shows this screen instead of computing one from state —
// used for the Pause and Stop screens, which are reached FROM screen-running
// but aren't a direct function of activeSession/currentOperator the way the
// other screens are.
let screenOverride = null;

const SCREENS = [
  "screen-error", "screen-login", "screen-home", "screen-start-form",
  "screen-running", "screen-pause-form", "screen-stop-form",
];
function showScreen(id) {
  SCREENS.forEach((s) => document.getElementById(s).classList.toggle("hidden", s !== id));
}
function $(id) { return document.getElementById(id); }

// ---------- time helpers ----------
function fmtHMS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function fmtMinutesShort(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
// Elapsed "worked" time = gross time minus every pause interval (using "now"
// for any pause that's still open) — this naturally freezes the number
// while paused and resumes ticking on resume, with no special-casing needed.
function computeWorkedMs(session) {
  const start = new Date(session.startedAt).getTime();
  const now = Date.now();
  let pausedMs = 0;
  for (const p of session.pauses) {
    const pStart = new Date(p.startedAt).getTime();
    const pEnd = p.endedAt ? new Date(p.endedAt).getTime() : now;
    pausedMs += pEnd - pStart;
  }
  return now - start - pausedMs;
}

// ---------- top bar: sync status + window controls ----------
function updateSyncBar(status) {
  if (!status) return;
  const dot = $("sync-dot");
  const text = $("sync-text");
  dot.className = "dot";
  if (!status.online) {
    dot.classList.add("offline");
    text.textContent = status.pendingCount > 0 ? `Offline — ${status.pendingCount} saved locally` : "Offline";
  } else if (status.pendingCount > 0) {
    dot.classList.add("pending");
    text.textContent = `Syncing ${status.pendingCount}…`;
  } else {
    dot.classList.add("online");
    text.textContent = "Synced";
  }
}
function wireWindowControls() {
  $("win-minimize").addEventListener("click", () => window.api.windowMinimize());
  $("win-maximize").addEventListener("click", () => window.api.windowMaximizeToggle());
  $("win-close").addEventListener("click", () => window.api.windowClose());
  window.api.onWindowState(({ maximized }) => {
    $("win-maximize").innerHTML = maximized ? "&#10064;" : "&#9633;";
    $("win-maximize").title = maximized ? "Restore" : "Maximize";
  });
}

// ---------- screen renderers ----------
function renderHome() {
  $("home-machine-name").textContent = state.config?.machine?.name || "—";
  $("home-operator-name").textContent = currentOperator?.name || "—";
  const list = $("recent-list");
  list.innerHTML = "";
  if (state.recentLocalSessions.length === 0) {
    list.innerHTML = `<div class="hint">Nothing recorded on this machine yet today.</div>`;
  } else {
    for (const s of state.recentLocalSessions) {
      const row = document.createElement("div");
      row.className = "recent-item";
      row.innerHTML = `<span>${s.operator_name} · ${fmtMinutesShort(s.gross_minutes)}</span><span class="status">${s.status}</span>`;
      list.appendChild(row);
    }
  }
}

// Renders a set of dynamic fields into `container`, grouped visually by
// each field's groupLabel (e.g. "Input", "Raw Materials") when present —
// this is what makes a 30-field machine (imported from a real production
// sheet) readable instead of one long undifferentiated list. Shared by both
// the Start form and the Stop form; only the field list passed in differs.
function renderDynamicFields(container, fields) {
  container.innerHTML = "";
  let currentGroup = undefined; // undefined = "no group started yet", distinct from null/"" = "ungrouped"
  for (const field of fields) {
    if (field.groupLabel !== currentGroup) {
      currentGroup = field.groupLabel;
      if (currentGroup) {
        const heading = document.createElement("div");
        heading.className = "field-group-heading";
        heading.textContent = currentGroup;
        container.appendChild(heading);
      }
    }

    const group = document.createElement("div");
    group.className = "field-group";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = field.label + (field.required ? " *" : "");
    group.appendChild(label);

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— Select —";
      input.appendChild(placeholder);
      for (const opt of field.options || []) {
        const o = document.createElement("option");
        o.value = opt.id;
        o.textContent = opt.value;
        input.appendChild(o);
      }
    } else if (field.type === "number") {
      input = document.createElement("input");
      input.className = "text-input";
      input.type = "number";
      input.step = "any"; // measurements like 2.35mm need decimals, not just whole numbers
      input.inputMode = "decimal";
    } else {
      input = document.createElement("input");
      input.className = "text-input";
      input.type = "text";
    }
    input.dataset.fieldId = field.id;
    input.dataset.fieldType = field.type;
    input.dataset.required = field.required ? "1" : "0";
    group.appendChild(input);
    container.appendChild(group);
  }
}

// Reads back whatever renderDynamicFields put into `container`, validating
// required fields. Returns null (and sets the error text) if something
// required is missing.
function collectDynamicFields(container, errorEl) {
  const inputs = container.querySelectorAll("[data-field-id]");
  const values = {};
  for (const input of inputs) {
    const value = input.value;
    if (input.dataset.required === "1" && !value) {
      if (errorEl) errorEl.textContent = "Please fill in every required field.";
      return null;
    }
    if (value !== "") values[input.dataset.fieldId] = value;
  }
  return values;
}

function renderStartForm() {
  $("form-machine-name").textContent = state.config?.machine?.name || "—";
  $("form-error").textContent = "";
  renderDynamicFields($("dynamic-fields"), state.config?.fields || []);
}

function renderRunning() {
  const session = state.activeSession;
  if (!session) return;
  $("run-machine-name").textContent = state.config?.machine?.name || "—";
  $("run-operator-name").textContent = session.operatorName;

  const pill = $("run-status-pill");
  const paused = session.status === "paused";
  pill.textContent = paused ? "PAUSED" : "RUNNING";
  pill.classList.toggle("paused", paused);
  $("pause-btn").classList.toggle("hidden", paused);
  $("resume-btn").classList.toggle("hidden", !paused);

  const tagList = $("run-fields");
  tagList.innerHTML = "";
  for (const [fieldId, value] of Object.entries(session.fieldValues || {})) {
    const field = fieldLookup(fieldId);
    if (!field || !value) continue;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.innerHTML = `${field.label}: <strong>${optionText(field, value)}</strong>`;
    tagList.appendChild(tag);
  }
}

function fieldLookup(fieldId) {
  return (state.config?.fields || []).find((f) => f.id === fieldId)
    || (state.config?.stopFields || []).find((f) => f.id === fieldId);
}
function optionText(field, value) {
  if (field?.type === "select") {
    const opt = (field.options || []).find((o) => o.id === value);
    return opt ? opt.value : value;
  }
  return value;
}

function tickTimer() {
  const session = state.activeSession;
  if (!session) return;
  $("run-timer").textContent = fmtHMS(computeWorkedMs(session));
}

// ---------- master render ----------
function render() {
  if (state.fatalError) {
    $("error-message").textContent = state.fatalError;
    showScreen("screen-error");
    return;
  }
  if (screenOverride) {
    showScreen(screenOverride);
    return;
  }
  if (state.activeSession) {
    if (!currentOperator) currentOperator = { id: state.activeSession.operatorId, name: state.activeSession.operatorName };
    renderRunning();
    showScreen("screen-running");
  } else if (!currentOperator) {
    showScreen("screen-login");
    setTimeout(() => $("login-input").focus(), 50);
  } else {
    renderHome();
    showScreen("screen-home");
  }
}

// ---------- login screen ----------
function buildKeypad() {
  const layout = ["1","2","3","4","5","6","7","8","9","clear","0","back"];
  const pad = $("keypad");
  pad.innerHTML = "";
  for (const key of layout) {
    const btn = document.createElement("button");
    btn.textContent = key === "back" ? "⌫" : key === "clear" ? "C" : key;
    btn.addEventListener("click", () => {
      const input = $("login-input");
      if (key === "clear") input.value = "";
      else if (key === "back") input.value = input.value.slice(0, -1);
      else input.value += key;
      input.focus();
    });
    pad.appendChild(btn);
  }
}

async function submitLogin() {
  const idNumber = $("login-input").value.trim();
  $("login-error").textContent = "";
  if (!idNumber) return;
  try {
    const operator = await window.api.loginOperator(idNumber);
    currentOperator = operator;
    $("login-input").value = "";
    render();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
}

// ---------- start form ----------
function openStartForm() {
  renderStartForm();
  showScreen("screen-start-form");
}

async function submitStartForm() {
  const fieldValues = collectDynamicFields($("dynamic-fields"), $("form-error"));
  if (fieldValues === null) return;
  try {
    const session = await window.api.startSession({
      operatorId: currentOperator.id,
      operatorName: currentOperator.name,
      fieldValues,
    });
    state.activeSession = session;
    render();
  } catch (err) {
    $("form-error").textContent = err.message;
  }
}

// ---------- pause screen ----------
function openPauseScreen() {
  $("pause-form-machine-name").textContent = state.config?.machine?.name || "—";
  $("pause-form-error").textContent = "";
  const list = $("pause-reason-list");
  list.innerHTML = "";
  for (const reason of state.config?.pauseReasons || []) {
    const btn = document.createElement("button");
    btn.textContent = reason.label;
    btn.addEventListener("click", async () => {
      try {
        const session = await window.api.pauseSession({ reasonId: reason.id });
        state.activeSession = session;
        screenOverride = null;
        render();
      } catch (err) {
        $("pause-form-error").textContent = err.message;
      }
    });
    list.appendChild(btn);
  }
  screenOverride = "screen-pause-form";
  render();
}

// ---------- stop screen ----------
function resetStopForm() {
  pendingStop = { status: null, reasonId: null, stopFieldValues: {} };
  $("stop-reason-section").classList.add("hidden");
  $("stop-fields-section").classList.add("hidden");
  $("stop-note-section").classList.add("hidden");
  $("stop-choice-row").classList.remove("hidden");
  $("stop-note-input").value = "";
  $("stop-form-error").textContent = "";
  $("stop-fields-error").textContent = "";
  $("stop-form-title").textContent = "Job finished?";
}
function openStopScreen() {
  $("stop-form-machine-name").textContent = state.config?.machine?.name || "—";
  resetStopForm();
  screenOverride = "screen-stop-form";
  render();
}
// After Finished/Incomplete (and, for Incomplete, after picking a reason),
// the flow lands here: show this machine's stop-stage fields (Output,
// Performance, Scrap, etc. — whatever the admin configured) if it has any,
// otherwise skip straight to the note/confirm step.
function goToStopFieldsOrNote() {
  const stopFields = state.config?.stopFields || [];
  if (stopFields.length > 0) {
    $("stop-fields-error").textContent = "";
    renderDynamicFields($("stop-dynamic-fields"), stopFields);
    $("stop-fields-section").classList.remove("hidden");
  } else {
    $("stop-note-section").classList.remove("hidden");
  }
}
function chooseStopStatus(status) {
  pendingStop.status = status;
  $("stop-choice-row").classList.add("hidden");
  if (status === "incomplete") {
    $("stop-form-title").textContent = "What happened?";
    const list = $("stop-reason-list");
    list.innerHTML = "";
    for (const reason of state.config?.stopReasons || []) {
      const btn = document.createElement("button");
      btn.textContent = reason.label;
      btn.addEventListener("click", () => {
        pendingStop.reasonId = reason.id;
        $("stop-reason-section").classList.add("hidden");
        $("stop-form-title").textContent = "Job details";
        goToStopFieldsOrNote();
      });
      list.appendChild(btn);
    }
    $("stop-reason-section").classList.remove("hidden");
  } else {
    $("stop-form-title").textContent = "Job details";
    goToStopFieldsOrNote();
  }
}
function submitStopFields() {
  const values = collectDynamicFields($("stop-dynamic-fields"), $("stop-fields-error"));
  if (values === null) return;
  pendingStop.stopFieldValues = values;
  $("stop-fields-section").classList.add("hidden");
  $("stop-form-title").textContent = "Confirm";
  $("stop-note-section").classList.remove("hidden");
}
async function confirmStop() {
  try {
    await window.api.stopSession({
      status: pendingStop.status,
      stopReasonId: pendingStop.reasonId,
      stopFieldValues: pendingStop.stopFieldValues,
      note: $("stop-note-input").value.trim() || null,
    });
    state.activeSession = null;
    screenOverride = null;
    const fresh = await window.api.getState();
    state = { ...state, ...fresh };
    render();
  } catch (err) {
    $("stop-form-error").textContent = err.message;
  }
}

// ---------- wiring ----------
function wireEvents() {
  wireWindowControls();
  buildKeypad();
  $("login-submit").addEventListener("click", submitLogin);
  $("login-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitLogin(); });

  $("logout-btn").addEventListener("click", () => { currentOperator = null; render(); });
  $("start-job-btn").addEventListener("click", openStartForm);
  $("form-cancel-btn").addEventListener("click", () => { showScreen("screen-home"); });
  $("form-submit-btn").addEventListener("click", submitStartForm);

  $("pause-btn").addEventListener("click", openPauseScreen);
  $("pause-form-cancel-btn").addEventListener("click", () => { screenOverride = null; render(); });
  $("resume-btn").addEventListener("click", async () => {
    state.activeSession = await window.api.resumeSession();
    render();
  });

  $("stop-btn").addEventListener("click", openStopScreen);
  $("stop-form-cancel-btn").addEventListener("click", () => { screenOverride = null; render(); });
  $("stop-finished-btn").addEventListener("click", () => chooseStopStatus("finished"));
  $("stop-incomplete-btn").addEventListener("click", () => chooseStopStatus("incomplete"));
  $("stop-fields-continue-btn").addEventListener("click", submitStopFields);
  $("stop-confirm-btn").addEventListener("click", confirmStop);

  window.api.onStatusUpdate((status) => {
    state.status = status;
    updateSyncBar(status);
  });
  window.api.onFatalError((message) => {
    state.fatalError = message;
    render();
  });
}

async function init() {
  wireEvents();
  const fresh = await window.api.getState();
  state = { ...state, ...fresh };
  updateSyncBar(state.status);
  render();
  timerHandle = setInterval(tickTimer, 1000);
}

init();
