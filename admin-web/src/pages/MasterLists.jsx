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

function ReasonList({ title, hint, items, onAdd, onRemove }) {
  const [label, setLabel] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!label.trim()) return;
    await onAdd(label.trim());
    setLabel("");
  }
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="hint" style={{ marginBottom: 8 }}>{hint}</div>
      <div className="tag-list">
        {items.map((r) => <span className="tag" key={r.id}>{r.label}<button onClick={() => onRemove(r.id)}>×</button></span>)}
        {items.length === 0 && <span className="hint">None yet</span>}
      </div>
      <form className="inline-form" style={{ marginTop: 10 }} onSubmit={submit}>
        <div className="field"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a reason…" /></div>
        <button className="btn secondary">Add</button>
      </form>
    </div>
  );
}

export default function MasterLists() {
  const [optionLists, setOptionLists] = useState([]);
  const [pauseReasons, setPauseReasons] = useState([]);
  const [stopReasons, setStopReasons] = useState([]);
  const [newListName, setNewListName] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [ol, pr, sr] = await Promise.all([api.optionLists.list(), api.pauseReasons.list(), api.stopReasons.list()]);
      setOptionLists(ol); setPauseReasons(pr); setStopReasons(sr);
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
          onAdd={async (label) => { await api.pauseReasons.create(label); load(); }}
          onRemove={async (id) => { await api.pauseReasons.remove(id); load(); }}
        />
        <ReasonList
          title="Stop reasons"
          hint="Shown when an operator clicks Stop (finished, cancelled, etc.)."
          items={stopReasons}
          onAdd={async (label) => { await api.stopReasons.create(label); load(); }}
          onRemove={async (id) => { await api.stopReasons.remove(id); load(); }}
        />
      </div>
    </div>
  );
}
