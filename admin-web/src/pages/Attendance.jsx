import React, { useEffect, useState } from "react";
import { api } from "../api.js";

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtDuration(minutes) {
  if (minutes == null) return "—";
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Shift and time zone configuration. Kept on this page because it's what
// gives the sign-in times below their meaning — "late" only means anything
// once the shift start is known.
function ShiftSettings() {
  const [settings, setSettings] = useState(null);
  const [zones, setZones] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    api.settings.get()
      .then((s) => { setSettings(s); setZones(s.availableTimezones || []); })
      .catch((err) => setMessage({ error: true, text: err.message }));
  }, []);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api.settings.update({
        timezone: settings.timezone,
        dayShiftStart: settings.dayShiftStart,
        nightShiftStart: settings.nightShiftStart,
      });
      setSettings((s) => ({ ...s, ...saved }));
      setMessage({ text: "Saved." });
    } catch (err) {
      setMessage({ error: true, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <div className="card"><div className="hint">Loading settings…</div></div>;

  return (
    <div className="card">
      <div className="section-title">Shifts and time zone</div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Applies to the whole system. A job starting between the day and night start times counts as the day shift;
        everything else is the night shift. Changing these affects new records only — jobs already recorded keep the
        shift they actually ran in.
      </div>
      <div className="inline-form" style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ minWidth: 240 }}>
          <label>Time zone</label>
          <select
            value={settings.timezone}
            onChange={(e) => setSettings((s) => ({ ...s, timezone: e.target.value }))}
          >
            {zones.length === 0 && <option value={settings.timezone}>{settings.timezone}</option>}
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 150 }}>
          <label>Day shift starts</label>
          <input
            type="time"
            value={settings.dayShiftStart}
            onChange={(e) => setSettings((s) => ({ ...s, dayShiftStart: e.target.value }))}
          />
        </div>
        <div className="field" style={{ maxWidth: 150 }}>
          <label>Night shift starts</label>
          <input
            type="time"
            value={settings.nightShiftStart}
            onChange={(e) => setSettings((s) => ({ ...s, nightShiftStart: e.target.value }))}
          />
        </div>
        <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </div>
      {message && <div className={message.error ? "error-text" : "hint"}>{message.text}</div>}
    </div>
  );
}

export default function Attendance() {
  const [operators, setOperators] = useState([]);
  const [machines, setMachines] = useState([]);
  const [rows, setRows] = useState([]);
  const [operatorId, setOperatorId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.operators.list(), api.machines.list()])
      .then(([ops, ms]) => { setOperators(ops); setMachines(ms); })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError("");
    api.attendance.list({ operatorId, machineId, from: daysAgoISO(days) })
      .then(setRows)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [operatorId, machineId, days]);

  function exportCsv() {
    const header = ["Date", "Operator", "ID number", "Machine", "Shift", "Signed in", "Signed out", "Minutes", "Scrap (kg)", "Scrap detail"];
    const lines = rows.map((r) => [
      new Date(r.signedInAt).toLocaleDateString(),
      r.operatorName, r.idNumber, r.machineCode, r.shift || "",
      fmtTime(r.signedInAt), r.signedOutAt ? fmtTime(r.signedOutAt) : "",
      r.minutes ?? "",
      r.scrapTotalKg || 0,
      (r.scrap || []).map((sc) => `${sc.materialLabel}: ${sc.kg}kg`).join("; "),
    ]);
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...lines].map((row) => row.map(esc).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalMinutes = rows.reduce((sum, r) => sum + (r.minutes || 0), 0);
  const totalScrapKg = rows.reduce((sum, r) => sum + (r.scrapTotalKg || 0), 0);

  // Scrap totalled by material across the whole selection — answers "how
  // much did we scrap this week, and of what?" without exporting first.
  const scrapByMaterial = (() => {
    const totals = {};
    for (const r of rows) {
      for (const sc of r.scrap || []) {
        totals[sc.materialLabel] = (totals[sc.materialLabel] || 0) + sc.kg;
      }
    }
    return Object.entries(totals)
      .map(([material, kg]) => ({ material, kg: Math.round(kg * 100) / 100 }))
      .sort((a, b) => b.kg - a.kg);
  })();

  return (
    <div>
      <div className="page-head">
        <h1>Operator attendance</h1>
        <div className="hint">
          When each operator signed in and out at a machine, and the scrap they recorded on the way out. Signing in
          is entering an ID number on the operator app; signing out is pressing "Shift finish" and completing the
          scrap form.
        </div>
      </div>

      <ShiftSettings />

      <div className="card">
        <div className="inline-form" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>Operator</label>
            <select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
              <option value="">All operators</option>
              {operators.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.id_number})</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label>Machine</label>
            <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">All machines</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>Period</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>Today</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
          <button className="btn secondary" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>

      {scrapByMaterial.length > 0 && (
        <div className="card">
          <div className="section-title">Scrap by material · {Math.round(totalScrapKg * 100) / 100} kg total</div>
          <table>
            <thead><tr><th>Material</th><th>Total</th></tr></thead>
            <tbody>
              {scrapByMaterial.map((m) => (
                <tr key={m.material}>
                  <td>{m.material}</td>
                  <td className="mono-data">{m.kg} kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="section-title">
          {rows.length} sign-in{rows.length === 1 ? "" : "s"}
          {rows.length > 0 && <span className="hint" style={{ marginLeft: 10 }}>· {fmtDuration(totalMinutes)} total on machines</span>}
        </div>
        {loading ? (
          <div className="hint">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            No sign-ins recorded for this selection. Operators appear here once they enter their ID on a machine's app.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Operator</th><th>ID</th><th>Machine</th>
                <th>Shift</th><th>Signed in</th><th>Signed out</th><th>Time on machine</th><th>Scrap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono-data">{new Date(r.signedInAt).toLocaleDateString()}</td>
                  <td><strong>{r.operatorName}</strong></td>
                  <td className="mono-data">{r.idNumber}</td>
                  <td>{r.machineCode}</td>
                  <td>
                    {r.shift
                      ? <span className={`badge ${r.shift === "night" ? "grey" : "amber"}`}>{r.shift}</span>
                      : "—"}
                  </td>
                  <td className="mono-data">{fmtTime(r.signedInAt)}</td>
                  <td className="mono-data">
                    {r.signedOutAt
                      ? fmtTime(r.signedOutAt)
                      : <span className="badge green">still on shift</span>}
                  </td>
                  <td className="mono-data">{fmtDuration(r.minutes)}</td>
                  <td className="scrap-cell">
                    {r.scrap && r.scrap.length > 0
                      ? <>
                          <strong className="mono-data">{r.scrapTotalKg} kg</strong>
                          {r.scrap.map((sc, i) => (
                            <div key={i} className="hint">{sc.materialLabel} — {sc.kg} kg</div>
                          ))}
                        </>
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
