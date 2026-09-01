// All of this talks to the app only through window.api (see preload.js).
// No network calls and no filesystem access happen here — that separation
// is what keeps "what happens when offline" logic in exactly one place.

let state = { config: null, activeSession: null, status: null, recentLocalSessions: [] };
let currentOperator = null;
let timerHandle = null;
let pendingStop = { status: null, reasonId: null, runningHourEnd: null };
let selectedWorkOrder = null; // the work order picked from the queue, carried through the Start form
let queueTab = "pending"; // "pending" | "finished" — which list the Home screen is showing
// The plan version this operator has already seen. When the backend
// reports a newer one, the "Please Check - Plan Change" alert appears and
// starting is blocked until the queue is refreshed.
let acknowledgedPlanVersion = null;
let planAlertDismissed = false;
// Scrap rows being entered on the end-of-shift form.
let scrapRows = [];
// Set when a finish attempt failed validation, so empty required cells get
// outlined until the operator fills them.
let showInvalidCells = false;
// When set, render() shows this screen instead of computing one from state —
// used for the Pause and Stop screens, which are reached FROM screen-running
// but aren't a direct function of activeSession/currentOperator the way the
// other screens are.
let screenOverride = null;
// Debounce timers for row-table cell edits, keyed by table name ("start"/
// "stop") — typing in a cell doesn't sync on every keystroke, it waits
// briefly after the operator stops typing, same idea as autosave anywhere.
const rowSaveTimers = {};

const SCREENS = [
  "screen-error", "screen-login", "screen-home", "screen-start-form",
  "screen-running", "screen-pause-form", "screen-stop-form", "screen-queue-view", "screen-shift-finish",
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
// Elapsed "worked" time = gross time minus every pause interval (using "now"
// for any pause that's still open) — this naturally freezes the number
// while paused and resumes ticking on resume, with no special-casing needed.
function computeWorkedMs(session) {
  // Two separate clocks, each starting from zero:
  //   - during setup, count from when setup began
  //   - once producing, count from when WORK began, not from setup
  // Counting from startedAt in both phases would make the work timer jump
  // straight to the setup duration the moment production starts.
  const inSetup = session.phase === "setup";
  const anchor = inSetup
    ? session.startedAt
    : (session.workStartedAt || session.startedAt);
  const start = new Date(anchor).getTime();
  const now = Date.now();

  let pausedMs = 0;
  for (const p of session.pauses) {
    const pStart = new Date(p.startedAt).getTime();
    const pEnd = p.endedAt ? new Date(p.endedAt).getTime() : now;
    // Pauses before the anchor (i.e. during setup) don't reduce work time.
    const overlapStart = Math.max(pStart, start);
    const overlapEnd = Math.max(pEnd, start);
    pausedMs += Math.max(0, overlapEnd - overlapStart);
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
    text.textContent = status.pendingCount > 0 ? t("offlineSaved", { n: status.pendingCount }) : t("offline");
  } else if (status.pendingCount > 0) {
    dot.classList.add("pending");
    text.textContent = t("syncing", { n: status.pendingCount });
  } else {
    dot.classList.add("online");
    text.textContent = t("synced");
  }
}
// Shows the running version, plus a quiet note when an update is waiting.
// Deliberately low-key: an operator can't act on it, and the install
// happens by itself when the app is next closed.
function renderUpdateState(u) {
  const el = $("app-version");
  if (!el || !u) return;
  const v = u.currentVersion ? `v${u.currentVersion}` : "";
  if (u.status === "ready") {
    el.textContent = `${v} · ${t("updateReady")}`;
    el.classList.add("update-ready");
  } else if (u.status === "downloading") {
    el.textContent = `${v} · ${t("updateDownloading")}${u.percent ? ` ${u.percent}%` : ""}`;
    el.classList.remove("update-ready");
  } else {
    el.textContent = v;
    el.classList.remove("update-ready");
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
function fmtDate(iso) {
  if (!iso) return null;
  // Work order due dates are plain "YYYY-MM-DD" strings (a date, not a
  // timestamp) — parse them as local, not UTC-shifted-then-displayed-wrong.
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderQueueItem(wo, clickable, index, isActive, opts = {}) {
  const item = document.createElement("div");
  const locked = !!opts.lockedNote;
  item.className = `queue-item${clickable ? "" : " disabled"}${isActive ? " current" : ""}${locked ? " locked" : ""}`;
  // Everything the supervisor entered, shown right in the list so the
  // operator can size up a job (and spot the one they want) without
  // having to open it first.
  const metaParts = [];
  if (wo.process) metaParts.push(`<span class="qi-k">${t("fieldProcess")}</span> ${wo.process}`);
  if (wo.quantity != null) metaParts.push(`<span class="qi-k">${t("fieldQty")}</span> ${wo.quantity}`);
  if (wo.inputDiameter != null) metaParts.push(`<span class="qi-k">${t("fieldDia")}</span> ${wo.inputDiameter}`);
  if (wo.totalTolerance) metaParts.push(`<span class="qi-k">${t("fieldTol")}</span> ${wo.totalTolerance}`);
  if (wo.dueDate) metaParts.push(`<span class="qi-k">${t("fieldDue")}</span> ${fmtDate(wo.dueDate)}`);
  if (!clickable && wo.status === "in_progress" && !isActive) metaParts.push(`<span class="qi-k">${t("alreadyInProgress")}</span>`);

  // Instructions and remarks get their own line — they're the things worth
  // reading before starting, so they shouldn't be buried among the numbers.
  const notes = [wo.specialInstruction, wo.remarks].filter(Boolean);

  item.innerHTML = `
    <span class="qi-index">${index}</span>
    <div class="qi-main">
      <div class="qi-job">${wo.jobNo}</div>
      ${wo.description ? `<div class="qi-desc">${wo.description}</div>` : ""}
      ${metaParts.length ? `<div class="qi-meta">${metaParts.join(`<span class="qi-sep">·</span>`)}</div>` : ""}
      ${notes.length ? `<div class="qi-notes">⚠ ${notes.join(" · ")}</div>` : ""}
    </div>
    ${isActive
      ? `<span class="current-badge">● ${t("runningNow")}</span>`
      : locked
        ? `<span class="qi-locked-note">${opts.lockedNote}</span>`
        : `<span class="priority-pill ${wo.priority}">${t("priority" + wo.priority.charAt(0).toUpperCase() + wo.priority.slice(1))}</span>`}
    ${clickable ? `<span class="qi-arrow">›</span>` : ""}
  `;
  if (clickable) item.addEventListener("click", () => openStartFormForWorkOrder(wo));
  return item;
}

// Read-only queue view, reachable from the Running screen — the operator
// can see what's next in line while a job is active, but can't tap into
// starting anything from here (only one job runs at a time on this
// machine). The currently active work order is highlighted wherever it
// falls in the list, not necessarily first.
function renderQueueView() {
  $("queue-view-machine-name").textContent = state.config?.machine?.name || "—";
  const list = $("queue-view-list");
  list.innerHTML = "";
  const pendingItems = state.config?.workOrders?.pending || [];
  const activeWoId = state.activeSession?.workOrderId;
  if (pendingItems.length === 0) {
    list.innerHTML = `<div class="queue-empty">No other work orders planned yet.</div>`;
  } else {
    pendingItems.forEach((wo, i) => {
      list.appendChild(renderQueueItem(wo, false, i + 1, wo.id === activeWoId));
    });
  }
}
function openQueueView() {
  renderQueueView();
  screenOverride = "screen-queue-view";
  render();
}
function closeQueueView() {
  screenOverride = null;
  render();
}

// Manually forces a sync right now (rather than waiting for the ~15s
// background cycle) and re-renders the queue with whatever comes back —
// mainly for "a supervisor just added/reordered a job, show it now."
async function refreshQueue() {
  const btn = $("queue-refresh-btn");
  const icon = btn.querySelector(".refresh-icon");
  btn.disabled = true;
  icon.classList.add("spinning");
  try {
    await window.api.forceSync();
    const fresh = await window.api.getState();
    state = { ...state, ...fresh };
    // Refreshing IS the acknowledgement — the operator has now seen
    // whatever the supervisor published.
    acknowledgedPlanVersion = state.config?.planVersion ?? 0;
    planAlertDismissed = false;
    renderQueue();
  } catch (err) {
    console.error("Refresh failed:", err);
  } finally {
    btn.disabled = false;
    icon.classList.remove("spinning");
  }
}

// True when the supervisor has published a newer plan than this operator
// has seen. Starting is blocked until they refresh — a stale queue is
// exactly how someone ends up running a job that was just cancelled.
function planRefreshRequired() {
  const current = state.config?.planVersion ?? 0;
  return acknowledgedPlanVersion !== null && current > acknowledgedPlanVersion;
}

function renderPlanAlert() {
  const el = $("plan-alert");
  if (!el) return;
  el.classList.toggle("hidden", !(planRefreshRequired() && !planAlertDismissed));
}

function renderQueue() {
  $("home-machine-name").textContent = state.config?.machine?.name || "—";
  $("home-operator-name").textContent = currentOperator?.name || "—";

  $("queue-tab-pending").classList.toggle("active", queueTab === "pending");
  $("queue-tab-finished").classList.toggle("active", queueTab === "finished");
  $("queue-list-pending").classList.toggle("hidden", queueTab !== "pending");
  $("queue-finished-wrap").classList.toggle("hidden", queueTab !== "finished");

  renderPlanAlert();

  const pending = $("queue-list-pending");
  pending.innerHTML = "";
  const pendingItems = state.config?.workOrders?.pending || [];
  // Only the first few jobs can actually be started — the rest are shown
  // so the operator can see what's coming, not to pick from.
  const selectableCount = state.config?.selectableCount ?? 5;
  if (pendingItems.length === 0) {
    pending.innerHTML = `<div class="queue-empty">${t("noWorkOrders")}<br>${t("askSupervisor")}</div>`;
  } else {
    pendingItems.forEach((wo, i) => {
      const withinLimit = i < selectableCount;
      const startable = wo.status === "pending" && withinLimit && !planRefreshRequired();
      pending.appendChild(renderQueueItem(wo, startable, i + 1, false, {
        lockedNote: !withinLimit ? t("notYetTopOnly", { n: selectableCount }) : null,
      }));
    });
  }

  const finished = $("queue-list-finished");
  finished.innerHTML = "";
  const allFinished = state.config?.workOrders?.finished || [];
  // Search across job number AND description — an operator may remember
  // either "4900002080" or "5CX6.0MM2", rarely both.
  const q = ($("finished-search")?.value || "").trim().toLowerCase();
  const finishedItems = q
    ? allFinished.filter((wo) =>
        `${wo.jobNo || ""} ${wo.description || ""} ${wo.process || ""}`.toLowerCase().includes(q))
    : allFinished;
  if (finishedItems.length === 0) {
    finished.innerHTML = `<div class="queue-empty">${q ? t("nothingMatches", { q: $("finished-search").value.trim() }) : t("nothingFinished")}</div>`;
  } else {
    finishedItems.forEach((wo, i) => {
      finished.appendChild(renderQueueItem(wo, false, i + 1));
    });
  }
}

// Shared read-only summary card for a work order — used at the top of the
// Start form (before the job begins) and on the Running screen (once it
// has), so the operator always sees which job they're looking at.
function renderWorkOrderContext(container, wo) {
  if (!wo) { container.innerHTML = ""; return; }
  const metaParts = [];
  if (wo.quantity != null) metaParts.push(`Qty: <strong>${wo.quantity}</strong>`);
  if (wo.dueDate) metaParts.push(`Due: <strong>${fmtDate(wo.dueDate)}</strong>`);
  if (wo.process) metaParts.push(`Process: <strong>${wo.process}</strong>`);
  if (wo.inputDiameter != null) metaParts.push(`Input dia: <strong>${wo.inputDiameter}</strong>`);
  if (wo.totalTolerance) metaParts.push(`Tolerance: <strong>${wo.totalTolerance}</strong>`);
  const notes = [wo.specialInstruction, wo.remarks].filter(Boolean);
  container.innerHTML = `
    <div class="wo-job">${wo.jobNo} <span class="priority-pill ${wo.priority}">${wo.priority}</span></div>
    ${wo.description ? `<div class="wo-desc">${wo.description}</div>` : ""}
    ${metaParts.length ? `<div class="wo-meta">${metaParts.map((p) => `<span>${p}</span>`).join("")}</div>` : ""}
    ${notes.map((n) => `<div class="wo-note">⚠ ${n}</div>`).join("")}
  `;
}

function fieldLookup(fieldId) {
  return (state.config?.fields || []).find((f) => f.id === fieldId)
    || (state.config?.stopFields || []).find((f) => f.id === fieldId);
}

// Builds one editable form control (text/number/select) for a single field,
// pre-filled with `value` — used for each cell in a row table. Kept as its
// own function since both the Start table and End table need identically-
// behaving cells, just with a different field list and row array.
function buildFieldInput(field, value) {
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
      if (opt.id === value) o.selected = true;
      input.appendChild(o);
    }
  } else if (field.type === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.inputMode = "decimal";
    if (value != null) input.value = value;
  } else {
    input = document.createElement("input");
    input.type = "text";
    if (value != null) input.value = value;
  }
  return input;
}

// Renders one full row-table (Start table or End table) into `tableEl`,
// with one column per field this machine has configured for that stage,
// and one row per entry in `rows`. Every cell edit and every add/remove
// row immediately updates the in-memory session (so validation, e.g. "at
// least 1 row", always sees the latest state) and schedules/perform a save.
function renderRowTable(tableEl, fields, rows, tableName, addBtn) {
  tableEl.innerHTML = "";
  if (fields.length === 0) {
    addBtn.disabled = true;
    const tbody = document.createElement("tbody");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "table-empty";
    td.colSpan = 3;
    td.textContent = t("noColumns");
    tr.appendChild(td);
    tbody.appendChild(tr);
    tableEl.appendChild(tbody);
    return;
  }
  addBtn.disabled = false;

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.innerHTML = `<th></th>${fields.map((f) => `<th>${f.label}${f.required ? " *" : ""}</th>`).join("")}<th></th>`;
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    const indexCell = document.createElement("td");
    indexCell.className = "row-index";
    indexCell.textContent = rowIndex + 1;
    tr.appendChild(indexCell);

    for (const field of fields) {
      const cell = document.createElement("td");
      const input = buildFieldInput(field, row[field.id]);

      // After a failed finish attempt, outline the specific cells that are
      // required and still blank, so the operator can see exactly what to
      // fill rather than hunting through every table.
      const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";
      const markValidity = () => {
        const bad = showInvalidCells && field.required && isBlank(row[field.id]);
        input.classList.toggle("invalid", bad);
      };
      markValidity();

      const onEdit = () => {
        row[field.id] = input.value;
        markValidity();
        scheduleRowSave(tableName);
      };
      input.addEventListener("input", onEdit);
      input.addEventListener("change", onEdit);
      cell.appendChild(input);
      tr.appendChild(cell);
    }

    const actionCell = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "row-delete-btn";
    delBtn.textContent = "✕";
    delBtn.title = t("removeRow");
    delBtn.disabled = rows.length <= 1; // minimum 1 row always required
    delBtn.addEventListener("click", () => removeRow(tableName, rowIndex));
    actionCell.appendChild(delBtn);
    tr.appendChild(actionCell);

    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);
}

// The machine's screens, each becoming its own table. Falls back to the
// original two-screen shape when talking to an older backend that doesn't
// send a screens list yet.
function currentScreens() {
  const screens = state.config?.screens;
  if (Array.isArray(screens) && screens.length > 0) return screens;
  return [
    { key: "start", label: "Input", fields: state.config?.fields || [] },
    { key: "stop", label: "Output", fields: state.config?.stopFields || [] },
  ];
}
function currentRows(tableName) {
  const session = state.activeSession;
  if (!session) return [];
  if (!session.screenRows || typeof session.screenRows !== "object") session.screenRows = {};
  if (!Array.isArray(session.screenRows[tableName])) session.screenRows[tableName] = [];
  return session.screenRows[tableName];
}
function currentFields(tableName) {
  const screen = currentScreens().find((sc) => sc.key === tableName);
  return screen ? (screen.fields || []) : [];
}

function scheduleRowSave(tableName) {
  clearTimeout(rowSaveTimers[tableName]);
  rowSaveTimers[tableName] = setTimeout(() => saveRows(tableName), 900);
}
// Writes any debounced row edits immediately and RESOLVES ONLY WHEN THEY
// ARE SAVED. Callers must await this before anything that replaces
// state.activeSession (pause, stop, shift finish) — otherwise the
// replacement can land before the save completes and the operator's most
// recent typing is lost.
async function flushPendingRowSaves() {
  const pending = [];
  for (const table of Object.keys(rowSaveTimers)) {
    if (rowSaveTimers[table]) {
      clearTimeout(rowSaveTimers[table]);
      rowSaveTimers[table] = null;
      pending.push(saveRows(table));
    }
  }
  await Promise.all(pending);
}
async function saveRows(tableName) {
  const rows = currentRows(tableName);
  try {
    await window.api.updateRows({ table: tableName, rows });
    // Deliberately NOT reassigning state.activeSession from the response
    // here. The renderer's local rows array is already the source of
    // truth — the <input> elements' event listeners are closed over THESE
    // exact row objects. Swapping in the IPC round-trip's freshly
    // deserialized copy would silently orphan those closures: any typing
    // that happens after the swap would mutate objects no longer
    // referenced by state.activeSession, and the next save would send
    // stale data without any error ever appearing.
  } catch (err) {
    console.error(`Failed to save ${tableName} table rows:`, err);
  }
}
function addRow(tableName) {
  const rows = currentRows(tableName);
  rows.push({});
  renderRunningTables(); // re-render immediately so the new row appears
  saveRows(tableName); // no debounce — an add should feel instant, not laggy
}
function removeRow(tableName, index) {
  const rows = currentRows(tableName);
  if (rows.length <= 1) return; // minimum 1 row enforced
  rows.splice(index, 1);
  renderRunningTables();
  saveRows(tableName);
}
// Builds one titled section (heading + Add row button + table) per screen
// the machine defines. Rebuilt on every render rather than diffed — the
// list is short, and rebuilding keeps the row-object closures and the DOM
// guaranteed in sync, which is exactly what went wrong when they drifted
// apart before.
function renderRunningTables() {
  const host = $("screen-tables");
  if (!host) return;
  host.innerHTML = "";

  // During setup there's nothing to record yet — the operator is at the
  // machine setting it up, not producing. Showing empty data tables would
  // just invite them to fill in numbers that don't exist yet, so the
  // tables only appear once "Start work" is pressed.
  if (state.activeSession?.phase === "setup") {
    const note = document.createElement("div");
    note.className = "setup-note";
    note.textContent = t("setupInProgress");
    host.appendChild(note);
    return;
  }

  for (const screen of currentScreens()) {
    const section = document.createElement("div");
    section.className = "table-section";

    const header = document.createElement("div");
    header.className = "table-section-header";
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = screen.label || screen.key;
    const addBtn = document.createElement("button");
    addBtn.className = "btn secondary";
    addBtn.textContent = t("addRow");
    addBtn.addEventListener("click", () => addRow(screen.key));
    header.appendChild(title);
    header.appendChild(addBtn);

    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "row-table";
    scroll.appendChild(table);

    section.appendChild(header);
    section.appendChild(scroll);
    host.appendChild(section);

    renderRowTable(table, screen.fields || [], currentRows(screen.key), screen.key, addBtn);
  }
}

function renderStartForm() {
  $("form-machine-name").textContent = state.config?.machine?.name || "—";
  $("form-error").textContent = "";
  renderWorkOrderContext($("form-wo-context"), selectedWorkOrder);
}

function fmtDuration(fromIso, toIso) {
  const mins = Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}
function fmtClock(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderRunning() {
  const session = state.activeSession;
  if (!session) return;
  $("run-machine-name").textContent = state.config?.machine?.name || "—";
  $("run-operator-name").textContent = session.operatorName;

  const pill = $("run-status-pill");
  const paused = session.status === "paused";
  const inSetup = session.phase === "setup";
  pill.textContent = inSetup ? t("underSetup") : paused ? t("paused") : t("running");
  pill.classList.toggle("paused", paused || inSetup);
  // During setup the only forward action is "Start work" — pausing or
  // stopping a job that hasn't started producing yet isn't meaningful.
  $("begin-work-btn").classList.toggle("hidden", !inSetup);
  $("pause-btn").classList.toggle("hidden", paused || inSetup);
  $("resume-btn").classList.toggle("hidden", !paused);

  renderWorkOrderContext($("run-wo-context"), session.workOrderSnapshot);

  // No manual counter entry — the start time is the real clock timestamp
  // recorded the moment Start was tapped, and the worked-time duration
  // above is computed automatically (start subtracted from now, minus any
  // pauses). Nothing for the operator to read off a machine and type in.
  $("run-hour-summary").textContent = session.phase === "setup"
    ? t("setupStartedAt", { time: fmtClock(session.startedAt) })
    : session.workStartedAt && session.workStartedAt !== session.startedAt
      ? t("setupThenWorking", { duration: fmtDuration(session.startedAt, session.workStartedAt), time: fmtClock(session.workStartedAt) })
      : t("startedAt", { time: fmtClock(session.startedAt) });

  renderRunningTables();
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
    $("login-machine-name").textContent = state.config?.machine?.name || "—";
    showScreen("screen-login");
    setTimeout(() => $("login-input").focus(), 50);
  } else {
    renderQueue();
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
    // Pull the latest queue as the shift starts, so the operator never sees
    // a plan the supervisor changed while the machine sat at the login
    // screen. Fire-and-forget: if the network is down this just no-ops and
    // the cached queue is shown, which is the offline behaviour anyway.
    refreshQueue().catch(() => {});
  } catch (err) {
    $("login-error").textContent = err.message;
  }
}

// ---------- start form ----------
function openStartFormForWorkOrder(wo) {
  selectedWorkOrder = wo;
  renderStartForm();
  showScreen("screen-start-form");
}

async function submitStartForm(phase) {
  if (!selectedWorkOrder) {
    $("form-error").textContent = t("noWorkOrderSelected");
    return;
  }
  if (planRefreshRequired()) {
    $("form-error").textContent = t("planChangedBlocked");
    return;
  }
  try {
    const session = await window.api.startSession({
      operatorId: currentOperator.id,
      operatorName: currentOperator.name,
      workOrder: selectedWorkOrder,
      phase,
    });
    state.activeSession = session;
    selectedWorkOrder = null;
    showInvalidCells = false;
    render();
  } catch (err) {
    $("form-error").textContent = err.message;
  }
}

// ---------- shared reason picker (Pause, and Stop/Incomplete) ----------
// A filterable list rather than a plain <select>: with a real factory's
// reason list running to 50+ codes (RS01…RS47, RM01…), a native dropdown
// means a long scroll on a shop-floor screen. Typing in the filter box
// narrows by BOTH code and label ("RS13", "x-head", "die"), so the
// operator can find a reason whether they remember the code or only the
// wording. Everything stays tappable — no keyboard required.
// Returns { setError } so the caller can surface an async failure (e.g.
// the pause API call itself failing) into the same UI.
function buildCodeEntryUI(containerEl, { reasons, onMatch, placeholder }) {
  containerEl.innerHTML = `
    <input class="text-input reason-filter" type="text" placeholder="${placeholder || t("searchReason")}" />
    <div class="error-text code-error"></div>
    <div class="reason-options"></div>
  `;
  const filterInput = containerEl.querySelector(".reason-filter");
  const errorEl = containerEl.querySelector(".code-error");
  const optionsEl = containerEl.querySelector(".reason-options");
  const list = reasons || [];

  function renderOptions() {
    const q = filterInput.value.trim().toLowerCase();
    const matches = q
      ? list.filter((r) => `${r.code || ""} ${r.label}`.toLowerCase().includes(q))
      : list;

    optionsEl.innerHTML = "";
    if (list.length === 0) {
      optionsEl.innerHTML = `<div class="reason-empty">${t("noReasons")}</div>`;
      return;
    }
    if (matches.length === 0) {
      optionsEl.innerHTML = `<div class="reason-empty">${t("nothingMatches", { q: filterInput.value.trim() })}</div>`;
      return;
    }
    for (const r of matches) {
      const btn = document.createElement("button");
      btn.className = "reason-option";
      btn.innerHTML = `
        ${r.code ? `<span class="reason-option-code">${r.code}</span>` : ""}
        <span class="reason-option-label">${r.label}</span>
      `;
      btn.addEventListener("click", () => onMatch(r));
      optionsEl.appendChild(btn);
    }
  }

  filterInput.addEventListener("input", () => { errorEl.textContent = ""; renderOptions(); });
  renderOptions();
  setTimeout(() => filterInput.focus(), 50);

  return { setError: (msg) => { errorEl.textContent = msg; } };
}

// ---------- pause screen ----------
async function openPauseScreen() {
  await flushPendingRowSaves();
  $("pause-form-machine-name").textContent = state.config?.machine?.name || "—";
  const widget = buildCodeEntryUI($("pause-reason-list"), {
    reasons: state.config?.pauseReasons || [],
    onMatch: async (reason) => {
      try {
        const session = await window.api.pauseSession({ reasonId: reason.id });
        state.activeSession = session;
        screenOverride = null;
        render();
      } catch (err) {
        widget.setError(err.message);
      }
    },
  });
  screenOverride = "screen-pause-form";
  render();
}

// Finds every row with a required cell left blank, across all screens.
// Returns [{ screenKey, screenLabel, rowNumber, missing: [labels] }].
function findIncompleteRows() {
  const problems = [];
  for (const screen of currentScreens()) {
    const required = (screen.fields || []).filter((f) => f.required);
    if (required.length === 0) continue;
    currentRows(screen.key).forEach((row, i) => {
      const missing = required
        .filter((f) => {
          const v = row[f.id];
          return v === undefined || v === null || String(v).trim() === "";
        })
        .map((f) => f.label);
      if (missing.length > 0) {
        problems.push({
          screenKey: screen.key,
          screenLabel: screen.label || screen.key,
          rowNumber: i + 1,
          missing,
        });
      }
    });
  }
  return problems;
}

// ---------- shift finish ----------
// Pressing "Shift finish" opens a scrap form; signing out only happens
// once that's submitted, so scrap and the attendance record always arrive
// together.
function openShiftFinish() {
  // A job left running would keep counting against an operator who has
  // gone home, so it has to be stopped first.
  if (state.activeSession) {
    window.alert(t("stopJobFirst"));
    return;
  }
  scrapRows = [];
  $("shift-finish-error").textContent = "";
  $("shift-machine-name").textContent = state.config?.machine?.name || "—";
  renderScrapTable();
  screenOverride = "screen-shift-finish";
  render();
}

function renderScrapTable() {
  const tableEl = $("scrap-table");
  if (!tableEl) return;
  tableEl.innerHTML = "";
  const codes = state.config?.scrapCodes || [];

  if (scrapRows.length === 0) {
    const tbody = document.createElement("tbody");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "table-empty";
    td.colSpan = 5;
    td.textContent = t("noScrapYet");
    tr.appendChild(td);
    tbody.appendChild(tr);
    tableEl.appendChild(tbody);
    return;
  }

  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th></th><th>${t("scrapCode")}</th><th>${t("scrapDescription")}</th><th>${t("scrapKg")}</th><th></th></tr>`;
  tableEl.appendChild(thead);

  const tbody = document.createElement("tbody");
  scrapRows.forEach((row, i) => {
    const tr = document.createElement("tr");

    const idx = document.createElement("td");
    idx.className = "row-index";
    idx.textContent = i + 1;
    tr.appendChild(idx);

    // Code picked from the admin-managed list
    const codeCell = document.createElement("td");
    const select = document.createElement("select");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— " + t("scrapCode") + " —";
    select.appendChild(placeholder);
    for (const c of codes) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.code} — ${c.label}`;
      if (c.id === row.scrapCodeId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      row.scrapCodeId = select.value;
      const picked = codes.find((c) => c.id === select.value);
      row.scrapCode = picked?.code || "";
      row.scrapLabel = picked?.label || "";
      // Prefill the description with the code's own wording — that's what
      // it usually is, and the operator can still edit it for detail.
      if (!row.description && picked) {
        row.description = picked.label;
        renderScrapTable();
      }
    });
    codeCell.appendChild(select);
    tr.appendChild(codeCell);

    // Free-text description the operator types
    const descCell = document.createElement("td");
    const descInput = document.createElement("input");
    descInput.type = "text";
    descInput.value = row.description || "";
    descInput.placeholder = t("scrapDescription");
    descInput.addEventListener("input", () => { row.description = descInput.value; });
    descCell.appendChild(descInput);
    tr.appendChild(descCell);

    const kgCell = document.createElement("td");
    const kgInput = document.createElement("input");
    kgInput.type = "number";
    kgInput.step = "any";
    kgInput.min = "0";
    kgInput.inputMode = "decimal";
    if (row.kg != null) kgInput.value = row.kg;
    kgInput.addEventListener("input", () => { row.kg = kgInput.value; });
    kgCell.appendChild(kgInput);
    tr.appendChild(kgCell);

    const actions = document.createElement("td");
    const del = document.createElement("button");
    del.className = "row-delete-btn";
    del.textContent = "✕";
    del.title = t("removeRow");
    del.addEventListener("click", () => { scrapRows.splice(i, 1); renderScrapTable(); });
    actions.appendChild(del);
    tr.appendChild(actions);

    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);
}

async function confirmShiftFinish() {
  // Every row must be complete — a half-filled row means someone was
  // interrupted mid-entry, and silently dropping it would lose real scrap.
  const incomplete = scrapRows.some((r) => !r.scrapCodeId || !(Number(r.kg) > 0));
  if (incomplete) {
    $("shift-finish-error").textContent = t("scrapNeedsCode");
    return;
  }
  try {
    await window.api.logoutOperator({
      scrap: scrapRows.map((r) => ({
        scrapCodeId: r.scrapCodeId,
        scrapCode: r.scrapCode,
        scrapLabel: r.scrapLabel,
        description: r.description,
        kg: Number(r.kg),
      })),
    });
  } catch (err) {
    console.error("Sign-out failed:", err);
  }
  scrapRows = [];
  currentOperator = null;
  screenOverride = null;
  render();
}

// ---------- stop screen ----------
function resetStopForm() {
  pendingStop = { status: null, reasonId: null };
  $("stop-reason-section").classList.add("hidden");
  $("stop-choice-row").classList.remove("hidden");
  $("stop-form-error").textContent = "";
  $("stop-choice-error").textContent = "";
  $("stop-form-title").textContent = "Job finished?";
}
async function openStopScreen() {
  await flushPendingRowSaves();
  $("stop-form-machine-name").textContent = state.config?.machine?.name || "—";
  resetStopForm();
  screenOverride = "screen-stop-form";
  render();
}
// Tapping Finished (once the row check passes) or entering a valid
// Incomplete reason code both stop the job immediately — there's no
// separate note/confirm step in between anymore, just one deliberate tap.
function chooseStopStatus(status) {
  if (status === "finished") {
    const session = state.activeSession;
    // A job still in setup never produced anything, so "Finished" doesn't
    // apply — it can only be abandoned. Saying so plainly beats listing
    // every empty table the operator was never shown.
    if (session?.phase === "setup") {
      $("stop-choice-error").textContent =
        t("stillInSetup");
      return;
    }
    // Every screen that actually has columns configured needs at least one
    // row before the job can be called finished — a machine with a Scrap
    // table shouldn't be finishable with Scrap left blank.
    const screensWithFields = currentScreens().filter((sc) => (sc.fields || []).length > 0);
    const emptyScreens = screensWithFields.filter((sc) => currentRows(sc.key).length === 0);
    if (emptyScreens.length > 0) {
      const names = emptyScreens.map((sc) => sc.label || sc.key).join(", ");
      $("stop-choice-error").textContent = t("addRowsBefore", { names });
      return;
    }

    // Having a row isn't enough — every REQUIRED cell in every row must
    // actually be filled. Without this an operator can add a blank row and
    // finish the job, which is how empty records reach the reports.
    const problems = findIncompleteRows();
    if (problems.length > 0) {
      showInvalidCells = true;
      const first = problems[0];
      $("stop-choice-error").textContent = t("fillRequiredCells", {
        screen: first.screenLabel,
        row: first.rowNumber,
        fields: first.missing.join(", "),
      });
      // Send them back to the tables with the offending cells outlined,
      // rather than leaving them on a dead-end error screen.
      setTimeout(() => { screenOverride = null; render(); }, 1600);
      return;
    }
  }
  $("stop-choice-error").textContent = "";
  pendingStop.status = status;
  $("stop-choice-row").classList.add("hidden");
  if (status === "incomplete") {
    $("stop-form-title").textContent = "What happened?";
    buildCodeEntryUI($("stop-reason-list"), {
      reasons: state.config?.stopReasons || [],
      onMatch: (reason) => {
        pendingStop.reasonId = reason.id;
        confirmStop();
      },
    });
    $("stop-reason-section").classList.remove("hidden");
  } else {
    confirmStop();
  }
}
async function confirmStop() {
  try {
    await window.api.stopSession({
      status: pendingStop.status,
      stopReasonId: pendingStop.reasonId,
      note: null,
    });
    state.activeSession = null;
    screenOverride = null;
    showInvalidCells = false;
    // Explicitly wait for a real push+pull before re-rendering, rather than
    // relying on the next background sync cycle (which runs fire-and-forget
    // and could leave the queue showing this job as still in_progress for
    // a few seconds). If offline, this just times out quickly and the
    // queue still refreshes from whatever's cached — no worse than before.
    await window.api.forceSync();
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

  $("logout-btn").addEventListener("click", openShiftFinish);
  $("scrap-add-row-btn").addEventListener("click", () => { scrapRows.push({ scrapCodeId: "", scrapCode: "", scrapLabel: "", description: "", kg: "" }); renderScrapTable(); });
  $("shift-cancel-btn").addEventListener("click", () => { screenOverride = null; render(); });
  $("shift-confirm-btn").addEventListener("click", confirmShiftFinish);
  $("queue-tab-pending").addEventListener("click", () => { queueTab = "pending"; renderQueue(); });
  $("queue-tab-finished").addEventListener("click", () => { queueTab = "finished"; renderQueue(); setTimeout(() => $("finished-search")?.focus(), 50); });
  $("finished-search").addEventListener("input", renderQueue);
  $("queue-refresh-btn").addEventListener("click", refreshQueue);
  $("form-cancel-btn").addEventListener("click", () => { selectedWorkOrder = null; showScreen("screen-home"); });
  $("form-submit-btn").addEventListener("click", () => submitStartForm("running"));
  $("form-setup-btn").addEventListener("click", () => submitStartForm("setup"));
  $("begin-work-btn").addEventListener("click", async () => {
    state.activeSession = await window.api.beginWork();
    render();
  });
  $("plan-alert-refresh").addEventListener("click", refreshQueue);
  $("plan-alert-dismiss").addEventListener("click", () => { planAlertDismissed = true; renderPlanAlert(); });


  $("pause-btn").addEventListener("click", openPauseScreen);
  $("pause-form-cancel-btn").addEventListener("click", () => { screenOverride = null; render(); });
  $("resume-btn").addEventListener("click", async () => {
    state.activeSession = await window.api.resumeSession();
    render();
  });

  $("view-queue-btn").addEventListener("click", openQueueView);
  $("queue-view-back-btn").addEventListener("click", closeQueueView);

  $("stop-btn").addEventListener("click", openStopScreen);
  $("stop-form-cancel-btn").addEventListener("click", () => { screenOverride = null; render(); });
  $("stop-finished-btn").addEventListener("click", () => chooseStopStatus("finished"));
  $("stop-incomplete-btn").addEventListener("click", () => chooseStopStatus("incomplete"));

  // The main process blocks a close while a job is open and tells us why;
  // the operator gets a plain explanation and an explicit way through.
  window.api.onCloseBlocked(() => {
    const ok = window.confirm(t("closeBlocked"));
    if (ok) window.api.forceClose();
  });

  window.api.onUpdateState(renderUpdateState);
  window.api.getUpdateState().then(renderUpdateState).catch(() => {});

  window.api.onStatusUpdate((status) => {
    state.status = status;
    updateSyncBar(status);
  });
  window.api.onFatalError((message) => {
    state.fatalError = message;
    render();
  });
}

// Re-renders every piece of fixed text on the page. Called on startup and
// whenever the language changes — cheaper and less error-prone than
// translating at each individual render site.
function applyTranslations() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  }
  // Screens built in JS (queue items, tables, reason lists) aren't tagged,
  // so re-render whatever is currently showing.
  render();
}

async function init() {
  wireEvents();
  const fresh = await window.api.getState();
  state = { ...state, ...fresh };
  // Language comes from this machine's config.json — one setting per PC,
  // nothing for the operator to choose or accidentally change.
  setLanguage(fresh.language || "en");
  // Whatever the plan is at launch is the baseline — the operator hasn't
  // missed anything yet, so no alert on startup.
  acknowledgedPlanVersion = state.config?.planVersion ?? 0;
  updateSyncBar(state.status);
  applyTranslations();
  timerHandle = setInterval(tickTimer, 1000);
}

init();
