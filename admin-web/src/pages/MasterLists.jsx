import React, { useEffect, useState } from "react";
import { api } from "../api.js";

function OptionListCard({ list, onChanged }) {
  const [newItem, setNewItem] = useState("");

  async function addItem(e) {
    e.preventDefault();
    if (!newItem.trim()) return;
    await api.optionLists.addItem(list.id, newItem.trim());
    setNewItem("");
    onChanged();
  }
  async function removeItem(itemId) {
    await api.optionLists.removeItem(list.id, itemId);
    onChanged();
  }
  async function removeList() {
    if (!window.confirm(`Delete the "${list.name}" list? Any machine field using it will stop working until reassigned.`)) return;
    await api.optionLists.remove(list.id);
    onChanged();
  }

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h3>{list.name}</h3>
        <button className="btn secondary" onClick={removeList}>Delete list</button>
      </div>
      <div className="tag-list">
        {list.items.map((it) => (
          <span className="tag" key={it.id}>{it.value}<button onClick={() => removeItem(it.id)}>×</button></span>
        ))}
        {list.items.length === 0 && <span className="hint">No items yet</span>}
      </div>
      <form className="inline-form" style={{ marginTop: 10 }} onSubmit={addItem}>
        <div className="field">
          <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add an item…" />
        </div>
        <button className="btn secondary">Add</button>
      </form>
    </div>
  );
}

function ReasonRow({ reason, onSave, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(reason.code || "");
  const [label, setLabel] = useState(reason.label);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSave(reason.id, { code: code.trim() || null, label });
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="reason-row">
      {editing ? (
        <>
          <input className="mono-data" style={{ width: 60 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="code" />
          <input style={{ flex: 1 }} value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn secondary" onClick={save} disabled={saving}>Save</button>
          <button className="btn secondary" onClick={() => setEditing(false)}>Cancel</button>
        </>
      ) : (
        <>
          <span className="reason-code">{reason.code || "—"}</span>
          <span className="reason-label">{reason.label}</span>
          <button className="btn secondary" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn secondary" onClick={() => onRemove(reason.id)}>Remove</button>
        </>
      )}
      {error && <div className="error-text" style={{ width: "100%" }}>{error}</div>}
    </div>
  );
}

function ReasonList({ title, hint, items, onAdd, onBulkAdd, onBulkDone, onSave, onRemove }) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!label.trim() || !code.trim()) { setError("Both a code and a label are required."); return; }
    try {
      await onAdd(label.trim(), code.trim());
      setLabel(""); setCode("");
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="hint" style={{ marginBottom: 8 }}>
        {hint} The operator picks this from a searchable list in the app — they can search by either the <strong>code</strong> or the label, so codes like "RS01" or "RM02" work fine alongside plain numbers.
      </div>
      {items.length === 0 ? (
        <div className="hint">None yet</div>
      ) : (
        <div className="reason-list-admin">
          {items.map((r) => <ReasonRow key={r.id} reason={r} onSave={onSave} onRemove={onRemove} />)}
        </div>
      )}
      <form className="inline-form" style={{ marginTop: 10 }} onSubmit={submit}>
        <div className="field" style={{ maxWidth: 110 }}>
          <label>Code</label>
          <input className="mono-data" value={code} onChange={(e) => setCode(e.target.value)} placeholder="RS01" />
        </div>
        <div className="field">
          <label>Label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Payoff drum / bobbin change" />
        </div>
        <button className="btn secondary">Add</button>
        <BulkAddReasons onAdd={onBulkAdd} onDone={onBulkDone} />
      </form>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

// Paste a whole reason list at once (e.g. the factory's standard RS/RM
// stoppage codes) instead of adding 50+ rows by hand. Accepts one reason
// per line as "CODE<tab or spaces>Label" — which is exactly what you get
// pasting two columns straight out of Excel.
function BulkAddReasons({ onAdd, onDone }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  function parseLines(raw) {
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Split on the first tab, or on 2+ spaces — so "RS01<tab>Payoff drum"
      // and "RS01   Payoff drum" both work, while single spaces inside the
      // label itself ("Payoff drum change") are preserved.
      const m = trimmed.match(/^(\S+)(?:\t+|\s{2,})(.+)$/) || trimmed.match(/^(\S+)\s+(.+)$/);
      if (!m) continue;
      out.push({ code: m[1].trim(), label: m[2].trim() });
    }
    return out;
  }

  async function runImport() {
    const parsed = parseLines(text);
    if (parsed.length === 0) {
      setResult({ added: 0, failed: [], warning: "Couldn't read any lines. Use one reason per line: a code, then the label." });
      return;
    }
    setSaving(true);
    let added = 0;
    const failed = [];
    // Sequential rather than parallel: each insert can fail independently
    // (duplicate code or duplicate label), and we want to report exactly
    // which ones were skipped rather than aborting the whole batch.
    for (const r of parsed) {
      try {
        await onAdd(r.label, r.code);
        added++;
      } catch (err) {
        failed.push(`${r.code} — ${err.message}`);
      }
    }
    setSaving(false);
    setResult({ added, failed, warning: null });
    setText("");
    onDone();
  }

  if (!open) {
    return <button type="button" className="btn secondary" onClick={() => setOpen(true)}>Bulk add…</button>;
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <h2>Bulk add reasons</h2>
        <div className="hint" style={{ marginBottom: 10 }}>
          One reason per line — the code first, then the label. Pasting two columns straight from Excel works.
          Anything whose code or label already exists is skipped, so it's safe to re-paste a list you've partly added.
        </div>
        <textarea
          className="mono-data"
          style={{ width: "100%", minHeight: 220, fontSize: 12.5, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"RS01\tPayoff drum / bobbin change / Basket change\nRS02\tTakeup drum / Bobbin change / Pallet Change\nRS03\tTip, Die, Rollers, Guides"}
        />
        {result && (
          <div style={{ marginTop: 10 }}>
            {result.warning
              ? <div className="error-text">{result.warning}</div>
              : <div className="hint">Added {result.added}. {result.failed.length > 0 ? `Skipped ${result.failed.length}:` : ""}</div>}
            {result.failed.length > 0 && (
              <div className="hint" style={{ maxHeight: 120, overflowY: "auto", marginTop: 4 }}>
                {result.failed.map((f, i) => <div key={i}>{f}</div>)}
              </div>
            )}
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn secondary" onClick={() => { setOpen(false); setResult(null); }}>Close</button>
          <button type="button" className="btn" onClick={runImport} disabled={saving || !text.trim()}>
            {saving ? "Adding…" : "Add all"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MasterLists() {
  const [optionLists, setOptionLists] = useState([]);
  const [pauseReasons, setPauseReasons] = useState([]);
  const [stopReasons, setStopReasons] = useState([]);
  const [scrapCodes, setScrapCodes] = useState([]);
  const [newListName, setNewListName] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [ol, pr, sr, sc] = await Promise.all([api.optionLists.list(), api.pauseReasons.list(), api.stopReasons.list(), api.scrapCodes.list()]);
      setOptionLists(ol); setPauseReasons(pr); setStopReasons(sr); setScrapCodes(sc);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function createList(e) {
    e.preventDefault();
    if (!newListName.trim()) return;
    await api.optionLists.create(newListName.trim());
    setNewListName("");
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Master lists</h1>
          <div className="sub">Shared dropdown values used across machine Start-forms, and pause/stop reasons</div>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="section-title">Option lists (Materials, Tools, Work orders, …)</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <form className="inline-form" onSubmit={createList}>
          <div className="field">
            <label>New list name</label>
            <input value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="Work Orders" />
          </div>
          <button className="btn">Create list</button>
        </form>
      </div>
      {optionLists.map((list) => <OptionListCard key={list.id} list={list} onChanged={load} />)}

      <div className="section-title">Pause &amp; stop reasons</div>
      <div className="grid">
        <ReasonList
          title="Pause reasons"
          hint="Shown when an operator clicks Pause."
          items={pauseReasons}
          onAdd={async (label, code) => { await api.pauseReasons.create(label, code); load(); }}
          onBulkAdd={(label, code) => api.pauseReasons.create(label, code)}
          onBulkDone={load}
          onSave={async (id, data) => { await api.pauseReasons.update(id, data); load(); }}
          onRemove={async (id) => { await api.pauseReasons.remove(id); load(); }}
        />
        <ReasonList
          title="Scrap codes"
          hint="Shown when an operator records scrap at the end of their shift."
          items={scrapCodes}
          onAdd={async (label, code) => { await api.scrapCodes.create(label, code); load(); }}
          onBulkAdd={(label, code) => api.scrapCodes.create(label, code)}
          onBulkDone={load}
          onSave={async (id, data) => { await api.scrapCodes.update(id, data); load(); }}
          onRemove={async (id) => { await api.scrapCodes.remove(id); load(); }}
        />
        <ReasonList
          title="Stop reasons"
          hint="Shown when an operator marks a job Incomplete/Cancelled."
          items={stopReasons}
          onAdd={async (label, code) => { await api.stopReasons.create(label, code); load(); }}
          onBulkAdd={(label, code) => api.stopReasons.create(label, code)}
          onBulkDone={load}
          onSave={async (id, data) => { await api.stopReasons.update(id, data); load(); }}
          onRemove={async (id) => { await api.stopReasons.remove(id); load(); }}
        />
      </div>
    </div>
  );
}
