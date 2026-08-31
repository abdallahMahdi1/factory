import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

export default function Backup() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const fileInput = useRef(null);

  function load() {
    api.backup.status().then(setStatus).catch((err) => setMessage({ error: true, text: err.message }));
  }
  useEffect(load, []);

  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const text = await api.backup.download();
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `factory-tracker-backup-${new Date().toISOString().slice(0, 19).replace(/[:]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({ text: "Backup downloaded. Keep it somewhere off the server." });
    } catch (err) {
      setMessage({ error: true, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function restore(file) {
    if (!file) return;
    // Restoring throws away whatever is currently in the database, so it
    // asks twice: once here, and again via the confirm flag the API needs.
    const ok = window.confirm(
      `Restore from "${file.name}"?\n\nThis REPLACES everything currently in the database — all machines, ` +
        `work orders, sessions, attendance and scrap. It can't be undone.`
    );
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      const result = await api.backup.restore(backup);
      const total = Object.values(result.restored || {}).reduce((a, b) => a + b, 0);
      setMessage({ text: `Restore complete — ${total} rows restored.` });
      load();
    } catch (err) {
      setMessage({ error: true, text: err.message });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const rows = status?.counts ? Object.entries(status.counts).filter(([, n]) => n > 0) : [];

  return (
    <div>
      <div className="page-head">
        <h1>Backup &amp; restore</h1>
        <div className="hint">
          Download a complete copy of the database, and restore it if the data is ever lost. On free hosting the
          server's disk is wiped whenever it restarts, so keep a recent backup somewhere else.
        </div>
      </div>

      <div className="card">
        <div className="section-title">Download a backup</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          One JSON file with everything: machines, operators, work orders, sessions, attendance and scrap.
          {status?.latestSessionAt && (
            <> Most recent session: <strong>{new Date(status.latestSessionAt).toLocaleString()}</strong>.</>
          )}
        </div>
        <button className="btn" onClick={download} disabled={busy}>
          {busy ? "Working…" : "Download backup"}
        </button>
      </div>

      <div className="card">
        <div className="section-title">Restore from a backup</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          Replaces everything currently in the database with the contents of the file. Use this after the server has
          been wiped, or to move to a new server.
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => restore(e.target.files?.[0])}
        />
      </div>

      {message && (
        <div className="card">
          <div className={message.error ? "error-text" : "hint"}>{message.text}</div>
        </div>
      )}

      <div className="card">
        <div className="section-title">
          What's in the database now{status ? ` · ${status.totalRows} rows` : ""}
        </div>
        {rows.length === 0 ? (
          <div className="empty">Nothing recorded yet.</div>
        ) : (
          <table>
            <thead><tr><th>Table</th><th>Rows</th></tr></thead>
            <tbody>
              {rows.map(([table, n]) => (
                <tr key={table}>
                  <td>{table.replace(/_/g, " ")}</td>
                  <td className="mono-data">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
