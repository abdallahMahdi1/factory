import React, { useEffect, useState } from "react";
import { api } from "../api.js";

function NewOperatorForm({ onCreated }) {
  const [name, setName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.operators.create({ name, idNumber });
      setName(""); setIdNumber("");
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ahmed Ali" required />
      </div>
      <div className="field">
        <label>ID number</label>
        <input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder="1001" required />
      </div>
      <button className="btn" disabled={saving}>{saving ? "Adding…" : "Add operator"}</button>
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}

function AssignMachines({ operator, machines, onChanged }) {
  const [open, setOpen] = useState(false);
  const assignedIds = new Set(operator.machines.map((m) => m.id));

  async function toggle(machineId) {
    const next = assignedIds.has(machineId)
      ? operator.machines.filter((m) => m.id !== machineId).map((m) => m.id)
      : [...operator.machines.map((m) => m.id), machineId];
    await api.operators.setMachines(operator.id, next);
    onChanged();
  }

  return (
    <div>
      <div className="tag-list">
        {operator.machines.length === 0 && <span className="hint">Not assigned to any machine</span>}
        {operator.machines.map((m) => (
          <span className="tag" key={m.id}>
            {m.name}
            <button title="Remove" onClick={() => toggle(m.id)}>×</button>
          </span>
        ))}
      </div>
      <button className="btn secondary" style={{ marginTop: 6 }} onClick={() => setOpen(!open)}>
        {open ? "Done" : "+ Assign to machine"}
      </button>
      {open && (
        <div className="tag-list" style={{ marginTop: 8 }}>
          {machines.filter((m) => !assignedIds.has(m.id)).map((m) => (
            <span className="tag" key={m.id} style={{ cursor: "pointer" }} onClick={() => toggle(m.id)}>
              + {m.name}
            </span>
          ))}
          {machines.every((m) => assignedIds.has(m.id)) && <span className="hint">Already on every machine</span>}
        </div>
      )}
    </div>
  );
}

export default function Operators() {
  const [operators, setOperators] = useState([]);
  const [machines, setMachines] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [ops, ms] = await Promise.all([api.operators.list(), api.machines.list()]);
      setOperators(ops);
      setMachines(ms);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function toggleActive(op) {
    await api.operators.update(op.id, { active: op.active ? 0 : 1 });
    load();
  }
  async function remove(op) {
    if (!window.confirm(`Remove ${op.name}? Past sessions stay recorded.`)) return;
    await api.operators.remove(op.id);
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Operators</h1>
          <div className="sub">{operators.length} operators · who's allowed on which machine</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <NewOperatorForm onCreated={load} />
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>ID number</th><th>Assigned machines</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {operators.map((op) => (
              <tr key={op.id}>
                <td>{op.name}</td>
                <td className="mono-data">{op.id_number}</td>
                <td style={{ minWidth: 260 }}><AssignMachines operator={op} machines={machines} onChanged={load} /></td>
                <td>
                  <span className={`badge ${op.active ? "green" : "grey"}`}>{op.active ? "Active" : "Disabled"}</span>
                </td>
                <td>
                  <button className="btn secondary" onClick={() => toggleActive(op)}>{op.active ? "Disable" : "Enable"}</button>{" "}
                  <button className="btn danger" onClick={() => remove(op)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {operators.length === 0 && <div className="empty">No operators yet.</div>}
      </div>
    </div>
  );
}
