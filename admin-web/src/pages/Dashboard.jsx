import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import Timeline from "../components/Timeline.jsx";

function statusOf(m) {
  if (m.alerts.offline) return { color: "grey", label: "Offline" };
  if (m.alerts.longRunningSession) return { color: "red", label: "Running too long" };
  if (m.currentSession) {
    // Setup is its own state — a machine being set up is neither producing
    // nor idle, and showing it as "Running" hides the very number the
    // setup timer exists to capture.
    if (m.currentSession.inSetup) return { color: "blue", label: "Under setup" };
    if (m.currentSession.status === "paused") return { color: "amber", label: "Paused" };
    return { color: "green", label: "Running" };
  }
  return { color: "grey", label: "Idle" };
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [pauseReasons, setPauseReasons] = useState([]);
  const [optionLists, setOptionLists] = useState([]);

  async function load() {
    try {
      const [status, reasons, lists] = await Promise.all([
        api.dashboard.status(), api.pauseReasons.list(), api.optionLists.list(),
      ]);
      setData(status);
      setPauseReasons(reasons);
      setOptionLists(lists);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15000); // refresh every 15s, this is a status board
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const pauseReasonLookup = {};
  pauseReasons.forEach((r) => (pauseReasonLookup[r.id] = r.label));

  const optionItemsById = {};
  optionLists.forEach((l) => (l.items || []).forEach((i) => { optionItemsById[i.id] = i.value; }));

  const alertCount = data.machines.filter((m) => m.alerts.offline || m.alerts.longRunningSession).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Floor status</h1>
          <div className="sub">{data.machines.length} machines · updated every 15s</div>
        </div>
      </div>

      {alertCount > 0 && (
        <div className="alert-banner">
          ⚠ {alertCount} machine{alertCount > 1 ? "s" : ""} need attention — offline or running unusually long.
        </div>
      )}

      {data.machines.length === 0 ? (
        <div className="empty">No machines set up yet. Add one from the Machines page.</div>
      ) : (
        <div className="grid">
          {data.machines.map((m) => {
            const s = statusOf(m);
            const fieldsById = {};
            (m.fields || []).forEach((f) => { fieldsById[f.id] = f; });
            const inputEntries = m.currentSession ? Object.entries(m.currentSession.fieldValuesPreview || {}) : [];
            const extraRows = m.currentSession && m.currentSession.startRowCount > 1 ? m.currentSession.startRowCount - 1 : 0;
            return (
              <div className="card machine-card" key={m.machineId}>
                <div className="head">
                  <strong>{m.machineName}</strong>
                  <span className={`badge ${s.color}`}><span className={`status-dot ${s.color}`} />{s.label}</span>
                </div>
                <div className="code mono-data">{m.machineCode}</div>
                {m.currentSession ? (
                  <div className="row">
                    Operator: <strong>{m.currentSession.operatorName}</strong>
                  </div>
                ) : (
                  <div className="row">No active session</div>
                )}

                {inputEntries.length > 0 && (
                  <>
                    <div className="mini-section-title">Input {extraRows > 0 ? `(row 1 of ${extraRows + 1})` : ""}</div>
                    <div className="tag-list">
                      {inputEntries.map(([fieldId, value]) => {
                        const f = fieldsById[fieldId];
                        if (!f) return null;
                        const display = f.type === "select" ? (optionItemsById[value] || value) : value;
                        return <span className="tag" key={fieldId}>{f.label}: {String(display)}</span>;
                      })}
                    </div>
                  </>
                )}

                {m.timeline && m.timeline.segments.length > 0 && (
                  <>
                    <div className="mini-section-title">Timeline</div>
                    <Timeline segments={m.timeline.segments} pauseReasonLookup={pauseReasonLookup} compact />
                  </>
                )}

                <div className="row" style={{ marginTop: 6 }}>
                  {m.minutesSinceHeartbeat === null
                    ? "Never connected"
                    : `Last synced ${m.minutesSinceHeartbeat}m ago`}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
