import React, { useState } from "react";
import { api } from "../api.js";

// Reached only by typing /adminpass — deliberately not in the sidebar, so
// it isn't something a supervisor stumbles into.
//
// The real protection is still the login: this route sits behind the same
// auth as every other page, and the endpoint requires the CURRENT password
// on top of that. An unlisted URL alone wouldn't protect anything.
export default function AdminPassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setMessage(null);
    if (next !== confirm) {
      setMessage({ error: true, text: "The two new passwords don't match." });
      return;
    }
    setBusy(true);
    try {
      const r = await api.auth.changePassword(current, next);
      setMessage({ text: r.message || "Password changed." });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setMessage({ error: true, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Admin password</h1>
        <div className="hint">
          Change the password used to sign in to this panel. If you're still using the one this system was installed
          with, change it before real production data goes in.
        </div>
      </div>

      <div className="card" style={{ maxWidth: 460 }}>
        <form onSubmit={submit}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Current password</label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>New password</label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
            <div className="hint" style={{ marginTop: 4 }}>At least 8 characters.</div>
          </div>
          <div className="field" style={{ marginBottom: 16 }}>
            <label>Repeat new password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button className="btn" disabled={busy || !current || !next}>
            {busy ? "Saving…" : "Change password"}
          </button>
        </form>
        {message && (
          <div className={message.error ? "error-text" : "hint"} style={{ marginTop: 12 }}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}
