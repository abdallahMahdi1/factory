import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import Timeline from "../components/Timeline.jsx";

const STATUS_BADGE = { running: "green", paused: "amber", finished: "grey", incomplete: "red" };

function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInputValue(value) {
  return value ? new Date(value).toISOString() : null;
}
function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
function formatMinutes(mins) {
  if (mins == null || Number.isNaN(mins)) return "—";
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h > 0 ? `${h}h ${rem}m` : `${rem}m`;
}
function grossMinutes(session) {
  const start = new Date(session.started_at).getTime();
  const end = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
  return (end - start) / 60000;
}
// Same segment-building logic as the backend's dashboard timeline helper,
// applied here to a single already-fetched session: walk started_at →
// each pause's started_at/ended_at → ended_at, alternating work/pause
// segments with real clock times, never a pre-aggregated duration.
function buildSegments(session) {
  const segments = [];
  let cursor = session.started_at;
  for (const p of session.pauses) {
    if (p.started_at > cursor) segments.push({ type: "work", from: cursor, to: p.started_at });
    segments.push({ type: "pause", from: p.started_at, to: p.ended_at, reasonId: p.reason_id });
    if (p.ended_at) cursor = p.ended_at;
  }
  const tail = session.ended_at || null;
  if (!tail || tail > cursor) segments.push({ type: "work", from: cursor, to: tail });
  return segments;
}
function pauseMinutes(pauses) {
  return pauses.reduce((sum, p) => {
    const start = new Date(p.started_at).getTime();
    const end = p.ended_at ? new Date(p.ended_at).getTime() : Date.now();
    return sum + (end - start) / 60000;
  }, 0);
}

function FilterBar({ machines, operators, filters, setFilters, onApply, onClear, onExport, exporting }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <form
        className="inline-form"
        style={{ flexWrap: "wrap" }}
        onSubmit={(e) => { e.preventDefault(); onApply(); }}
      >
        <div className="field" style={{ minWidth: 160 }}>
          <label>Machine</label>
          <select value={filters.machineId} onChange={(e) => setFilters({ ...filters, machineId: e.target.value })}>
            <option value="">All machines</option>
            {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ minWidth: 160 }}>
          <label>Operator</label>
          <select value={filters.operatorId} onChange={(e) => setFilters({ ...filters, operatorId: e.target.value })}>
            <option value="">All operators</option>
            {operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ minWidth: 140 }}>
          <label>Status</label>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Any status</option>
            <option value="running">Running</option>
            <option value="paused">Paused</option>
            <option value="finished">Finished</option>
            <option value="incomplete">Incomplete</option>
          </select>
        </div>
        <div className="field" style={{ minWidth: 150 }}>
          <label>From</label>
          <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </div>
        <div className="field" style={{ minWidth: 150 }}>
          <label>To</label>
          <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </div>
        <button className="btn secondary">Apply</button>
        <button type="button" className="btn secondary" onClick={onClear}>Clear</button>
        <button
          type="button"
          className="btn"
          onClick={onExport}
          disabled={!filters.machineId || exporting}
          title={filters.machineId ? "Export the filtered sessions as a CSV report" : "Pick a machine first — each machine has its own report columns"}
        >
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </form>
      {!filters.machineId && (
        <div className="hint" style={{ marginTop: 6 }}>Pick a machine above to enable CSV export — each machine has its own set of report columns.</div>
      )}
    </div>
  );
}

function SessionDetail({ sessionId, fieldLookup, pauseReasonLookup, onClose, onSaved }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);

  async function load() {
    try {
      const s = await api.sessions.get(sessionId);
      setSession(s);
      setForm({
        startedAt: toLocalInputValue(s.started_at),
        endedAt: toLocalInputValue(s.ended_at),
        status: s.status,
        completionNote: s.completion_note || "",
      });
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [sessionId]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.sessions.update(sessionId, {
        startedAt: fromLocalInputValue(form.startedAt),
        endedAt: fromLocalInputValue(form.endedAt),
        status: form.status,
        completionNote: form.completionNote,
      });
      await load();
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!session || !form) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {error ? <div className="error-text">{error}</div> : <div className="empty">Loading…</div>}
        </div>
      </div>
    );
  }

  // Historical sessions (created before the multi-row redesign) stored a
  // single flat object instead of an array of rows — normalize either
  // shape so this view never crashes on old data.
  function parseRows(raw) {
    if (!raw) return [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) return [parsed];
    return [];
  }
  const startRows = parseRows(session.field_values);
  const stopRows = parseRows(session.stop_field_values);

  const gross = grossMinutes(session);
  const pauseTotal = pauseMinutes(session.pauses);
  const segments = buildSegments(session);

  function displayValue(fieldId, value) {
    const f = fieldLookup.fieldsById[fieldId];
    return f && f.type === "select" ? (fieldLookup.optionItemsById[value] || value) : value;
  }

  // Renders one table: a column per field this machine has configured for
  // that stage, a row per entry the operator added (minimum 1 once the job
  // has started). Columns are pulled from fieldLookup so even a value from
  // a since-removed field still shows under a generic header rather than
  // silently vanishing.
  function renderRowsTable(rows, stageFields) {
    if (rows.length === 0) return <div className="hint">No rows yet.</div>;
    const columnIds = stageFields.length > 0 ? stageFields.map((f) => f.id) : Object.keys(rows[0] || {});
    return (
      <table style={{ marginBottom: 4 }}>
        <thead>
          <tr>
            <th>#</th>
            {columnIds.map((fid) => <th key={fid}>{fieldLookup.fieldsById[fid]?.label || "Field"}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="mono-data">{i + 1}</td>
              {columnIds.map((fid) => <td key={fid}>{row[fid] != null && row[fid] !== "" ? String(displayValue(fid, row[fid])) : "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const startFields = Object.values(fieldLookup.fieldsById)
    .filter((f) => f.machine_id === session.machine_id && f.stage === "start")
    .sort((a, b) => a.sort_order - b.sort_order);
  const stopFields = Object.values(fieldLookup.fieldsById)
    .filter((f) => f.machine_id === session.machine_id && f.stage === "stop")
    .sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <h2>{session.machine_name} · {session.operator_name}</h2>

        <div className="section-title">Timeline</div>
        <div className="row" style={{ fontSize: 13.5, color: "var(--muted)", marginBottom: 2 }}>
          {session.created_offline ? "Started while offline, synced automatically. " : ""}
          <strong style={{ color: "var(--ink)" }}>{formatMinutes(gross - pauseTotal)} worked</strong>
          {" "}of {formatMinutes(gross)} total ({formatMinutes(pauseTotal)} paused)
        </div>
        <Timeline segments={segments} pauseReasonLookup={pauseReasonLookup} />

        <div className="section-title">Input ({startRows.length} row{startRows.length === 1 ? "" : "s"})</div>
        {renderRowsTable(startRows, startFields)}

        <div className="section-title">Output ({stopRows.length} row{stopRows.length === 1 ? "" : "s"})</div>
        {renderRowsTable(stopRows, stopFields)}

        <div className="section-title">Correct this record</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          Every change here is kept in the audit trail below — nothing is overwritten silently.
        </div>
        <form onSubmit={save}>
          <div style={{ display: "flex", gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Started at</label>
              <input type="datetime-local" value={form.startedAt}
                onChange={(e) => setForm({ ...form, startedAt: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Ended at</label>
              <input type="datetime-local" value={form.endedAt}
                onChange={(e) => setForm({ ...form, endedAt: e.target.value })} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="running">Running</option>
                <option value="paused">Paused</option>
                <option value="finished">Finished</option>
                <option value="incomplete">Incomplete</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Note</label>
              <input value={form.completionNote}
                onChange={(e) => setForm({ ...form, completionNote: e.target.value })} placeholder="Optional" />
            </div>
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="actions">
            <button type="button" className="btn secondary" onClick={onClose}>Close</button>
            <button className="btn" disabled={saving}>{saving ? "Saving…" : "Save correction"}</button>
          </div>
        </form>

        {session.edits.length > 0 && (
          <>
            <div className="section-title">Audit trail</div>
            <table>
              <thead><tr><th>When</th><th>By</th><th>Field</th><th>Old</th><th>New</th></tr></thead>
              <tbody>
                {session.edits.map((e) => (
                  <tr key={e.id}>
                    <td className="mono-data">{formatDateTime(e.edited_at)}</td>
                    <td>{e.edited_by}</td>
                    <td className="mono-data">{e.field}</td>
                    <td className="mono-data">{e.old_value ?? "—"}</td>
                    <td className="mono-data">{e.new_value ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [machines, setMachines] = useState([]);
  const [operators, setOperators] = useState([]);
  const [optionLists, setOptionLists] = useState([]);
  const [filters, setFilters] = useState({ machineId: "", operatorId: "", status: "", from: "", to: "" });
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState("");
  const [pauseReasons, setPauseReasons] = useState([]);
  const [exporting, setExporting] = useState(false);

  async function loadMeta() {
    const [m, o, l, pr] = await Promise.all([
      api.machines.list(), api.operators.list(), api.optionLists.list(), api.pauseReasons.list(),
    ]);
    setMachines(m);
    setOperators(o);
    setOptionLists(l);
    setPauseReasons(pr);
  }

  async function loadSessions(f = filters) {
    try {
      const params = {};
      if (f.machineId) params.machineId = f.machineId;
      if (f.operatorId) params.operatorId = f.operatorId;
      if (f.status) params.status = f.status;
      if (f.from) params.from = new Date(f.from).toISOString();
      if (f.to) params.to = new Date(f.to + "T23:59:59").toISOString();
      setSessions(await api.sessions.list(params));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { loadMeta(); loadSessions(); }, []);

  const fieldLookup = useMemo(() => {
    const fieldsById = {};
    machines.forEach((m) => (m.fields || []).forEach((f) => { fieldsById[f.id] = f; }));
    const optionItemsById = {};
    optionLists.forEach((l) => (l.items || []).forEach((i) => { optionItemsById[i.id] = i.value; }));
    return { fieldsById, optionItemsById };
  }, [machines, optionLists]);

  const pauseReasonLookup = useMemo(() => {
    const lookup = {};
    pauseReasons.forEach((r) => (lookup[r.id] = r.label));
    return lookup;
  }, [pauseReasons]);

  function clearFilters() {
    const cleared = { machineId: "", operatorId: "", status: "", from: "", to: "" };
    setFilters(cleared);
    loadSessions(cleared);
  }

  async function handleExport() {
    if (!filters.machineId) return;
    setExporting(true);
    setError("");
    try {
      const params = {};
      if (filters.operatorId) params.operatorId = filters.operatorId;
      if (filters.status) params.status = filters.status;
      if (filters.from) params.from = new Date(filters.from).toISOString();
      if (filters.to) params.to = new Date(filters.to + "T23:59:59").toISOString();
      await api.sessions.exportCsv(filters.machineId, params);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Sessions</h1>
          <div className="sub">{sessions.length} recorded (most recent 500)</div>
        </div>
      </div>

      <FilterBar
        machines={machines}
        operators={operators}
        filters={filters}
        setFilters={setFilters}
        onApply={() => loadSessions()}
        onClear={clearFilters}
        onExport={handleExport}
        exporting={exporting}
      />
      {error && <div className="error-text">{error}</div>}

      <div className="card">
        {sessions.length === 0 ? (
          <div className="empty">No sessions match these filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th><th>Machine</th><th>Operator</th><th>Duration</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(s.id)}>
                  <td className="mono-data">{formatDateTime(s.started_at)}</td>
                  <td>{s.machine_name}</td>
                  <td>{s.operator_name}</td>
                  <td className="mono-data">{formatMinutes(grossMinutes(s))}</td>
                  <td><span className={`badge ${STATUS_BADGE[s.status] || "grey"}`}>{s.status}</span></td>
                  <td><button className="btn secondary" onClick={(e) => { e.stopPropagation(); setOpenId(s.id); }}>View / Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openId && (
        <SessionDetail
          sessionId={openId}
          fieldLookup={fieldLookup}
          pauseReasonLookup={pauseReasonLookup}
          onClose={() => setOpenId(null)}
          onSaved={() => loadSessions()}
        />
      )}
    </div>
  );
}
