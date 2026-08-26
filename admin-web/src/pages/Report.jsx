import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtDuration(minutes) {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}
function todayLocalISO() {
  // Local YYYY-MM-DD, not UTC — "today" has to mean the operator's day,
  // otherwise anyone west of UTC gets yesterday's report after 5pm.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const KIND_LABEL = { work: "Running", pause: "Paused", idle: "Not running" };

export default function Report() {
  const [machines, setMachines] = useState([]);
  const [machineId, setMachineId] = useState("");
  const [date, setDate] = useState(todayLocalISO());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.machines.list()
      .then((list) => {
        setMachines(list);
        if (list.length > 0) setMachineId((cur) => cur || list[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!machineId || !date) return;
    setLoading(true);
    setError("");
    api.dashboard.dailyReport(machineId, date)
      .then(setReport)
      .catch((err) => { setError(err.message); setReport(null); })
      .finally(() => setLoading(false));
  }, [machineId, date]);

  function shiftDay(deltaDays) {
    const d = new Date(`${date}T12:00:00`); // midday avoids any DST edge
    d.setDate(d.getDate() + deltaDays);
    const pad = (n) => String(n).padStart(2, "0");
    setDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }

  // The proportional bar across the top — one continuous strip showing the
  // whole day at a glance before reading any of the rows.
  const barSegments = useMemo(() => {
    if (!report || report.totals.totalMinutes === 0) return [];
    return report.rows.map((r, i) => ({
      key: i,
      kind: r.kind,
      pct: (r.minutes / report.totals.totalMinutes) * 100,
      title: `${fmtClock(r.startedAt)}–${fmtClock(r.endedAt)} · ${KIND_LABEL[r.kind]} · ${fmtDuration(r.minutes)}${r.reasonLabel ? ` · ${r.reasonLabel}` : ""}`,
    }));
  }, [report]);

  function downloadCsv() {
    if (!report) return;
    const header = ["From", "To", "Duration (min)", "State", "Work order", "Operator", "Reason code", "Reason"];
    const lines = report.rows.map((r) => [
      fmtClock(r.startedAt),
      fmtClock(r.endedAt),
      r.minutes,
      KIND_LABEL[r.kind],
      r.jobNo || "",
      r.operatorName || "",
      r.reasonCode || "",
      r.reasonLabel || "",
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
    a.download = `daily-report-${report.machine.code}-${report.date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-head">
        <h1>Daily report</h1>
        <div className="hint">Everything that happened on one machine over a full 24 hours — running, paused, and idle time, all accounted for.</div>
      </div>

      <div className="card">
        <div className="inline-form" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>Machine</label>
            <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn secondary" onClick={() => shiftDay(-1)}>‹ Prev day</button>
          <button className="btn secondary" onClick={() => shiftDay(1)}>Next day ›</button>
          <button className="btn secondary" onClick={() => setDate(todayLocalISO())}>Today</button>
          <button className="btn secondary" onClick={downloadCsv} disabled={!report}>Export CSV</button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>

      {loading && <div className="card"><div className="hint">Loading…</div></div>}

      {report && !loading && (
        <>
          <div className="card">
            <div className="report-totals">
              <div className="report-total">
                <div className="rt-value" style={{ color: "var(--green)" }}>{fmtDuration(report.totals.workMinutes)}</div>
                <div className="rt-label">Running</div>
              </div>
              <div className="report-total">
                <div className="rt-value" style={{ color: "var(--amber)" }}>{fmtDuration(report.totals.pauseMinutes)}</div>
                <div className="rt-label">Paused</div>
              </div>
              <div className="report-total">
                <div className="rt-value" style={{ color: "var(--muted)" }}>{fmtDuration(report.totals.idleMinutes)}</div>
                <div className="rt-label">Not running</div>
              </div>
              <div className="report-total">
                <div className="rt-value">{report.totals.utilizationPercent}%</div>
                <div className="rt-label">Utilization</div>
              </div>
            </div>

            <div className="day-bar">
              {barSegments.map((s) => (
                <div key={s.key} className={`day-bar-seg ${s.kind}`} style={{ width: `${s.pct}%` }} title={s.title} />
              ))}
            </div>
            <div className="day-bar-scale">
              <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
            </div>
          </div>

          {report.downtimeByReason.length > 0 && (
            <div className="card">
              <div className="section-title">Downtime by reason</div>
              <table>
                <thead><tr><th>Reason</th><th>Total</th></tr></thead>
                <tbody>
                  {report.downtimeByReason.map((d) => (
                    <tr key={d.reason}>
                      <td>{d.reason}</td>
                      <td className="mono-data">{fmtDuration(d.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <div className="section-title">Timeline</div>
            {report.rows.length === 0 ? (
              <div className="empty">Nothing recorded for this day.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>From</th><th>To</th><th>Duration</th><th>State</th><th>Work order</th><th>Operator</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {report.rows.map((r, i) => (
                    <tr key={i} className={`report-row ${r.kind}`}>
                      <td className="mono-data">{fmtClock(r.startedAt)}</td>
                      <td className="mono-data">{fmtClock(r.endedAt)}</td>
                      <td className="mono-data">{fmtDuration(r.minutes)}</td>
                      <td><span className={`state-pill ${r.kind}`}>{KIND_LABEL[r.kind]}</span></td>
                      <td>{r.jobNo || "—"}</td>
                      <td>{r.operatorName || "—"}</td>
                      <td>
                        {r.reasonCode && <span className="reason-code-tag">{r.reasonCode}</span>}
                        {r.reasonLabel || (r.kind === "idle" ? "No job running" : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
