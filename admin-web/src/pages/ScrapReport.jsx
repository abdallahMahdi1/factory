import React, { useEffect, useState } from "react";
import { api } from "../api.js";

function fmtDate(iso) {
  if (!iso) return "—";
  // "01-Aug-26" style, matching the factory's own scrap sheet
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function ScrapReport() {
  const [operators, setOperators] = useState([]);
  const [machines, setMachines] = useState([]);
  const [data, setData] = useState(null);
  const [operatorId, setOperatorId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [shift, setShift] = useState("");
  const [days, setDays] = useState(30);
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
    api.attendance.scrapReport({ operatorId, machineId, shift, from: daysAgoISO(days) })
      .then(setData)
      .catch((err) => { setError(err.message); setData(null); })
      .finally(() => setLoading(false));
  }, [operatorId, machineId, shift, days]);

  function exportCsv() {
    if (!data) return;
    // Column order mirrors the factory's own scrap sheet so the export can
    // be pasted straight in without rearranging.
    const header = ["Scrap Date", "Shift", "Operator", "Scrap Source", "Scrap code", "Scrap Description", "Scrap Quantity (KG)"];
    const lines = data.rows.map((r) => [
      fmtDate(r.scrapDate),
      r.shift ? r.shift.charAt(0).toUpperCase() : "",
      r.idNumber,
      r.scrapSource,
      r.scrapCode || "",
      r.description || r.scrapLabel || "",
      r.kg,
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
    a.download = `scrap-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-head">
        <h1>Scrap report</h1>
        <div className="hint">
          Every scrap line recorded by operators at the end of their shifts, in the same shape as your scrap sheet.
        </div>
      </div>

      <div className="card">
        <div className="inline-form" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 200 }}>
            <label>Operator</label>
            <select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
              <option value="">All operators</option>
              {operators.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.id_number})</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 190 }}>
            <label>Scrap source</label>
            <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">All machines</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 130 }}>
            <label>Shift</label>
            <select value={shift} onChange={(e) => setShift(e.target.value)}>
              <option value="">Both</option>
              <option value="day">Day</option>
              <option value="night">Night</option>
            </select>
          </div>
          <div className="field" style={{ maxWidth: 150 }}>
            <label>Period</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>Today</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
          </div>
          <button className="btn secondary" onClick={exportCsv} disabled={!data || data.rows.length === 0}>
            Export CSV
          </button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>

      {data && data.byCode.length > 0 && (
        <div className="card">
          <div className="section-title">By scrap code · {data.totalKg} kg total</div>
          <table>
            <thead><tr><th>Code</th><th>Total</th></tr></thead>
            <tbody>
              {data.byCode.map((c) => (
                <tr key={c.code}>
                  <td>{c.code}</td>
                  <td className="mono-data">{c.kg} kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="section-title">
          {data ? `${data.rows.length} scrap line${data.rows.length === 1 ? "" : "s"}` : "Scrap lines"}
        </div>
        {loading ? (
          <div className="hint">Loading…</div>
        ) : !data || data.rows.length === 0 ? (
          <div className="empty">
            No scrap recorded for this selection. Scrap appears here once operators record it on the Shift finish screen.
          </div>
        ) : (
          <div className="wo-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Scrap Date</th><th>Shift</th><th>Operator</th><th>Scrap Source</th>
                  <th>Scrap code</th><th>Scrap Description</th><th>Scrap Quantity (KG)</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono-data">{fmtDate(r.scrapDate)}</td>
                    <td className="mono-data">{r.shift ? r.shift.charAt(0).toUpperCase() : "—"}</td>
                    <td className="mono-data">{r.idNumber}</td>
                    <td>{r.scrapSource}</td>
                    <td className="mono-data">{r.scrapCode || "—"}</td>
                    <td>{r.description || r.scrapLabel || "—"}</td>
                    <td className="mono-data">{r.kg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
