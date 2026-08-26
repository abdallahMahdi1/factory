// All of this talks to the app only through window.api (see preload.js).
// No network calls and no filesystem access happen here — that separation
// is what keeps "what happens when offline" logic in exactly one place.

let state = { config: null, activeSession: null, status: null, recentLocalSessions: [] };
let currentOperator = null;
let timerHandle = null;
let pendingStop = { status: null, reasonId: null, runningHourEnd: null };
let selectedWorkOrder = null; // the work order picked from the queue, carried through the Start form
let queueTab = "pending"; // "pending" | "finished" — which list the Home screen is showing
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
  "screen-running", "screen-pause-form", "screen-stop-form", "screen-queue-view",
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
function fmtDate(iso) {
  if (!iso) return null;
  // Work order due dates are plain "YYYY-MM-DD" strings (a date, not a
  // timestamp) — parse them as local, not UTC-shifted-then-displayed-wrong.
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderQueueItem(wo, clickable, index, isActive) {
  const item = document.createElement("div");
  item.className = `queue-item${clickable ? "" : " disabled"}${isActive ? " current" : ""}`;
  // Everything the supervisor entered, shown right in the list so the
  // operator can size up a job (and spot the one they want) without
  // having to open it first.
  const metaParts = [];
  if (wo.process) metaParts.push(`<span class="qi-k">Process</span> ${wo.process}`);
  if (wo.quantity != null) metaParts.push(`<span class="qi-k">Qty</span> ${wo.quantity}`);
  if (wo.inputDiameter != null) metaParts.push(`<span class="qi-k">Dia</span> ${wo.inputDiameter}`);
  if (wo.totalTolerance) metaParts.push(`<span class="qi-k">Tol</span> ${wo.totalTolerance}`);
  if (wo.dueDate) metaParts.push(`<span class="qi-k">Due</span> ${fmtDate(wo.dueDate)}`);
  if (!clickable && wo.status === "in_progress" && !isActive) metaParts.push(`<span class="qi-k">Already in progress</span>`);

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
    ${isActive ? `<span class="current-badge">● RUNNING NOW</span>` : `<span class="priority-pill ${wo.priority}">${wo.priority}</span>`}
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
    renderQueue();
  } catch (err) {
    console.error("Refresh failed:", err);
  } finally {
    btn.disabled = false;
    icon.classList.remove("spinning");
  }
}

function renderQueue() {
  $("home-machine-name").textContent = state.config?.machine?.name || "—";
  $("home-operator-name").textContent = currentOperator?.name || "—";

  $("queue-tab-pending").classList.toggle("active", queueTab === "pending");
  $("queue-tab-finished").classList.toggle("active", queueTab === "finished");
  $("queue-list-pending").classList.toggle("hidden", queueTab !== "pending");
  $("queue-list-finished").classList.toggle("hidden", queueTab !== "finished");

  const pending = $("queue-list-pending");
  pending.innerHTML = "";
  const pendingItems = state.config?.workOrders?.pending || [];
  if (pendingItems.length === 0) {
    pending.innerHTML = `<div class="queue-empty">No work orders planned for this machine yet.<br>Ask your supervisor to add one.</div>`;
  } else {
    pendingItems.forEach((wo, i) => {
      pending.appendChild(renderQueueItem(wo, wo.status === "pending", i + 1));
    });
  }

  const finished = $("queue-list-finished");
  finished.innerHTML = "";
  const finishedItems = state.config?.workOrders?.finished || [];
  if (finishedItems.length === 0) {
    finished.innerHTML = `<div class="queue-empty">Nothing finished yet.</div>`;
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
function renderRowTable(tableEl, fields, rows, tableName) {
  tableEl.innerHTML = "";
  const addBtn = $(tableName === "start" ? "start-table-add-row-btn" : "stop-table-add-row-btn");
  if (fields.length === 0) {
    addBtn.disabled = true;
    const tbody = document.createElement("tbody");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "table-empty";
    td.colSpan = 3;
    td.textContent = "No columns configured here yet — ask your supervisor to add some in the admin panel.";
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
      input.addEventListener("input", () => {
        row[field.id] = input.value;
        scheduleRowSave(tableName);
      });
      input.addEventListener("change", () => {
        row[field.id] = input.value;
        scheduleRowSave(tableName);
      });
      cell.appendChild(input);
      tr.appendChild(cell);
    }

    const actionCell = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "row-delete-btn";
    delBtn.textContent = "✕";
    delBtn.title = "Remove row";
    delBtn.disabled = rows.length <= 1; // minimum 1 row always required
    delBtn.addEventListener("click", () => removeRow(tableName, rowIndex));
    actionCell.appendChild(delBtn);
    tr.appendChild(actionCell);

    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);
}

function currentRows(tableName) {
  const session = state.activeSession;
  if (!session) return [];
  return tableName === "start" ? session.startRows : session.stopRows;
}
function currentFields(tableName) {
  return tableName === "start" ? (state.config?.fields || []) : (state.config?.stopFields || []);
}

function scheduleRowSave(tableName) {
  clearTimeout(rowSaveTimers[tableName]);
  rowSaveTimers[tableName] = setTimeout(() => saveRows(tableName), 900);
}
function flushPendingRowSaves() {
  for (const table of Object.keys(rowSaveTimers)) {
    if (rowSaveTimers[table]) {
      clearTimeout(rowSaveTimers[table]);
      saveRows(table);
    }
  }
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
function renderRunningTables() {
  renderRowTable($("start-table"), currentFields("start"), currentRows("start"), "start");
  renderRowTable($("stop-table"), currentFields("stop"), currentRows("stop"), "stop");
}

function renderStartForm() {
  $("form-machine-name").textContent = state.config?.machine?.name || "—";
  $("form-error").textContent = "";
  renderWorkOrderContext($("form-wo-context"), selectedWorkOrder);
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
  pill.textContent = paused ? "PAUSED" : "RUNNING";
  pill.classList.toggle("paused", paused);
  $("pause-btn").classList.toggle("hidden", paused);
  $("resume-btn").classList.toggle("hidden", !paused);

  renderWorkOrderContext($("run-wo-context"), session.workOrderSnapshot);

  // No manual counter entry — the start time is the real clock timestamp
  // recorded the moment Start was tapped, and the worked-time duration
  // above is computed automatically (start subtracted from now, minus any
  // pauses). Nothing for the operator to read off a machine and type in.
  $("run-hour-summary").textContent = `Started at ${fmtClock(session.startedAt)}`;

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

async function submitStartForm() {
  if (!selectedWorkOrder) {
    $("form-error").textContent = "No work order selected — go back and pick one from the queue.";
    return;
  }
  try {
    const session = await window.api.startSession({
      operatorId: currentOperator.id,
      operatorName: currentOperator.name,
      workOrder: selectedWorkOrder,
    });
    state.activeSession = session;
    selectedWorkOrder = null;
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
    <input class="text-input reason-filter" type="text" placeholder="${placeholder || "Search code or reason…"}" />
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
      optionsEl.innerHTML = `<div class="reason-empty">No reasons are set up for this machine yet — ask your supervisor.</div>`;
      return;
    }
    if (matches.length === 0) {
      optionsEl.innerHTML = `<div class="reason-empty">Nothing matches "${filterInput.value.trim()}".</div>`;
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
function openPauseScreen() {
  flushPendingRowSaves();
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

// ---------- stop screen ----------
function resetStopForm() {
  pendingStop = { status: null, reasonId: null };
  $("stop-reason-section").classList.add("hidden");
  $("stop-choice-row").classList.remove("hidden");
  $("stop-form-error").textContent = "";
  $("stop-choice-error").textContent = "";
  $("stop-form-title").textContent = "Job finished?";
}
function openStopScreen() {
  flushPendingRowSaves();
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
    const startCount = (session?.startRows || []).length;
    const stopCount = (session?.stopRows || []).length;
    if (startCount < 1 || stopCount < 1) {
      $("stop-choice-error").textContent =
        "Add at least one row to both the Input table and the Output table before finishing.";
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

  $("logout-btn").addEventListener("click", () => { currentOperator = null; render(); });
  $("queue-tab-pending").addEventListener("click", () => { queueTab = "pending"; renderQueue(); });
  $("queue-tab-finished").addEventListener("click", () => { queueTab = "finished"; renderQueue(); });
  $("queue-refresh-btn").addEventListener("click", refreshQueue);
  $("form-cancel-btn").addEventListener("click", () => { selectedWorkOrder = null; showScreen("screen-home"); });
  $("form-submit-btn").addEventListener("click", submitStartForm);

  $("start-table-add-row-btn").addEventListener("click", () => addRow("start"));
  $("stop-table-add-row-btn").addEventListener("click", () => addRow("stop"));

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
