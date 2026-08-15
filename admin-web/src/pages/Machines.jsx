import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { parseSheetCsv } from "../lib/parseSheetCsv.js";

function NewMachineForm({ onCreated }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const machine = await api.machines.create({ name, code });
      setName(""); setCode("");
      onCreated(machine.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <div className="field">
        <label>Machine name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sheathing Line 33U" required />
      </div>
      <div className="field">
        <label>Short code</label>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="SHTH-33U" required />
      </div>
      <button className="btn" disabled={saving}>{saving ? "Adding…" : "Add machine"}</button>
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}

// Paste a two-row-header production sheet (group row + field-label row,
// like "Input | Output | Raw Materials..." over "Size | Process | ...") and
// get back a ready-to-review field list — built specifically so a machine
// like a real paper/Excel report can be set up in one paste instead of
// typing 20-30 fields by hand, one at a time.
function ImportFromSheet({ onImported }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function runParse() {
    setError("");
    const { fields, warning } = parseSheetCsv(text);
    setPreview(fields);
    setWarning(warning || "");
  }

  function updatePreviewField(i, patch) {
    setPreview((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function removePreviewField(i) {
    setPreview((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function confirmImport() {
    setSaving(true);
    setError("");
    try {
      await onImported(preview);
      setOpen(false);
      setText("");
      setPreview(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button className="btn secondary" onClick={() => setOpen(true)}>Import from sheet…</button>
    );
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" style={{ width: 720, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h2>Import fields from a production sheet</h2>
        {!preview ? (
          <>
            <div className="hint" style={{ marginBottom: 10 }}>
              Paste the CSV of your sheet below (export it from Excel as CSV first). This reads a group header row
              (e.g. "Input", "Output", "Raw Materials") and the field-label row underneath it — the same shape as a
              typical daily production report.
            </div>
            <textarea
              className="mono-data"
              style={{ width: "100%", minHeight: 220, fontSize: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste CSV content here…"
            />
            <div className="actions">
              <button className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn" onClick={runParse} disabled={!text.trim()}>Parse</button>
            </div>
          </>
        ) : (
          <>
            {warning && <div className="error-text" style={{ marginBottom: 8 }}>{warning}</div>}
            <div className="hint" style={{ marginBottom: 10 }}>
              Found {preview.length} fields. Review the type, group, and which screen (Start or Stop) each one
              belongs on, then confirm. Everything landed on "Start" by default — move Output/Performance/Scrap-style
              fields to "Stop" below.
            </div>
            <table style={{ marginBottom: 4 }}>
              <thead>
                <tr><th>Label</th><th>Group</th><th>Type</th><th>Screen</th><th></th></tr>
              </thead>
              <tbody>
                {preview.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <input style={{ width: 160 }} value={f.label} onChange={(e) => updatePreviewField(i, { label: e.target.value })} />
                    </td>
                    <td>
                      <input style={{ width: 110 }} value={f.groupLabel || ""} onChange={(e) => updatePreviewField(i, { groupLabel: e.target.value || null })} />
                    </td>
                    <td>
                      <select value={f.type} onChange={(e) => updatePreviewField(i, { type: e.target.value })}>
                        <option value="text">Text</option>
                        <option value="number">Number</option>
                      </select>
                    </td>
                    <td>
                      <select value={f.stage} onChange={(e) => updatePreviewField(i, { stage: e.target.value })}>
                        <option value="start">Start</option>
                        <option value="stop">Stop</option>
                      </select>
                    </td>
                    <td><button className="btn secondary" onClick={() => removePreviewField(i)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {error && <div className="error-text">{error}</div>}
            <div className="actions">
              <button className="btn secondary" onClick={() => setPreview(null)}>Back</button>
              <button className="btn" onClick={confirmImport} disabled={saving || preview.length === 0}>
                {saving ? "Creating fields…" : `Create ${preview.length} fields`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AddFieldForm({ machine, optionLists, onChanged }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState("text");
  const [stage, setStage] = useState("start");
  const [groupLabel, setGroupLabel] = useState("");
  const [optionListId, setOptionListId] = useState(optionLists[0]?.id || "");
  const [required, setRequired] = useState(true);
  const [error, setError] = useState("");

  async function addField(e) {
    e.preventDefault();
    setError("");
    try {
      const sameStage = machine.fields.filter((f) => f.stage === stage);
      await api.machines.addField(machine.id, {
        label,
        type,
        optionListId: type === "select" ? optionListId : null,
        required,
        stage,
        groupLabel: groupLabel || null,
        order: sameStage.length,
      });
      setLabel("");
      setGroupLabel("");
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <form className="inline-form" onSubmit={addField} style={{ flexWrap: "wrap" }}>
      <div className="field" style={{ minWidth: 140 }}>
        <label>Field label</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Line Speed (MPM)" required />
      </div>
      <div className="field" style={{ minWidth: 110 }}>
        <label>Group (optional)</label>
        <input value={groupLabel} onChange={(e) => setGroupLabel(e.target.value)} placeholder="Output" />
      </div>
      <div className="field" style={{ minWidth: 110 }}>
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="text">Free text</option>
          <option value="number">Number</option>
          <option value="select">Select from list</option>
        </select>
      </div>
      {type === "select" && (
        <div className="field" style={{ minWidth: 150 }}>
          <label>List</label>
          <select value={optionListId} onChange={(e) => setOptionListId(e.target.value)}>
            {optionLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}
      <div className="field" style={{ minWidth: 100 }}>
        <label>Screen</label>
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="start">Start</option>
          <option value="stop">Stop</option>
        </select>
      </div>
      <div className="field" style={{ minWidth: 90 }}>
        <label>Required</label>
        <select value={required ? "yes" : "no"} onChange={(e) => setRequired(e.target.value === "yes")}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
      <button className="btn secondary">Add field</button>
      {error && <div className="error-text">{error}</div>}
      {type === "select" && optionLists.length === 0 && (
        <div className="hint">You don't have any master lists yet — create one under "Master lists" first.</div>
      )}
    </form>
  );
}

// One field's row: label/group/required are editable inline; type and
// screen changes go through the same PUT so nothing is ever silently lost.
function FieldRow({ machine, field, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [groupLabel, setGroupLabel] = useState(field.group_label || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.machines.updateField(machine.id, field.id, { label, groupLabel: groupLabel || null });
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }
  async function toggleStage() {
    await api.machines.updateField(machine.id, field.id, { stage: field.stage === "start" ? "stop" : "start" });
    onChanged();
  }
  async function toggleRequired() {
    await api.machines.updateField(machine.id, field.id, { required: !field.required });
    onChanged();
  }
  async function remove() {
    await api.machines.removeField(machine.id, field.id);
    onChanged();
  }

  return (
    <tr>
      <td>
        {editing ? (
          <input style={{ width: 150 }} value={label} onChange={(e) => setLabel(e.target.value)} />
        ) : field.label}
      </td>
      <td>
        {editing ? (
          <input style={{ width: 100 }} value={groupLabel} onChange={(e) => setGroupLabel(e.target.value)} placeholder="—" />
        ) : (field.group_label || "—")}
      </td>
      <td className="mono-data">{field.type}</td>
      <td>{field.option_list_name || "—"}</td>
      <td>
        <button className="btn secondary" onClick={toggleStage} title="Click to move to the other screen">
          {field.stage === "start" ? "Start" : "Stop"}
        </button>
      </td>
      <td>
        <button className="btn secondary" onClick={toggleRequired}>{field.required ? "Yes" : "No"}</button>
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        {editing ? (
          <>
            <button className="btn secondary" onClick={save} disabled={saving}>Save</button>{" "}
            <button className="btn secondary" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn secondary" onClick={() => setEditing(true)}>Edit</button>{" "}
            <button className="btn secondary" onClick={remove}>Remove</button>
          </>
        )}
      </td>
    </tr>
  );
}

function FieldEditor({ machine, optionLists, onChanged }) {
  const startFields = machine.fields.filter((f) => f.stage === "start");
  const stopFields = machine.fields.filter((f) => f.stage === "stop");

  function renderTable(fields, title, hint) {
    return (
      <div style={{ marginBottom: 20 }}>
        <div className="section-title">{title}</div>
        <div className="hint" style={{ marginBottom: 10 }}>{hint}</div>
        {fields.length === 0 ? (
          <div className="empty">No fields yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Label</th><th>Group</th><th>Type</th><th>Options from</th><th>Screen</th><th>Required</th><th></th></tr>
            </thead>
            <tbody>
              {fields.map((f) => <FieldRow key={f.id} machine={machine} field={f} onChanged={onChanged} />)}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  return (
    <div>
      {renderTable(startFields, "Start-form fields", "Answered when the operator clicks Start — typically the Input side of a job (work order, material, size, etc).")}
      {renderTable(stopFields, "Stop-form fields", "Answered when the operator finishes or cancels the job — typically the Output side (results, measurements, scrap).")}
      <div className="section-title">Add a field</div>
      <AddFieldForm machine={machine} optionLists={optionLists} onChanged={onChanged} />
    </div>
  );
}

export default function Machines() {
  const [machines, setMachines] = useState([]);
  const [optionLists, setOptionLists] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [m, l] = await Promise.all([api.machines.list(), api.optionLists.list()]);
      setMachines(m);
      setOptionLists(l);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  const selected = machines.find((m) => m.id === selectedId);

  async function regenerateKey() {
    if (!window.confirm("Regenerate this machine's API key? The operator app on that PC will need the new key.")) return;
    await api.machines.regenerateKey(selected.id);
    load();
  }

  async function removeMachine(id) {
    if (!window.confirm("Delete this machine? This does not delete its past session history.")) return;
    await api.machines.remove(id);
    setSelectedId(null);
    load();
  }

  async function handleImport(fields) {
    if (!selected) throw new Error("Select or create a machine first.");
    const existing = selected.fields || [];
    await api.machines.setFields(selected.id, [
      ...existing.map((f) => ({
        label: f.label, type: f.type, optionListId: f.option_list_id,
        required: !!f.required, stage: f.stage, groupLabel: f.group_label, order: f.sort_order,
      })),
      ...fields,
    ]);
    await load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Machines</h1>
          <div className="sub">{machines.length} machines configured</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <NewMachineForm onCreated={(id) => { load(); setSelectedId(id); }} />
      </div>
      {error && <div className="error-text">{error}</div>}

      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ flex: "0 0 280px" }}>
          {machines.map((m) => (
            <div
              key={m.id}
              className="card"
              style={{ marginBottom: 8, cursor: "pointer", borderColor: m.id === selectedId ? "var(--accent)" : "var(--border)" }}
              onClick={() => { setSelectedId(m.id); setShowKey(false); }}
            >
              <strong>{m.name}</strong>
              <div className="code mono-data">{m.code}</div>
              <div className="row" style={{ marginTop: 2 }}>{m.fields.length} fields</div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }}>
          {!selected ? (
            <div className="empty">Select a machine to configure its Start/Stop fields and device API key.</div>
          ) : (
            <div className="card">
              <div className="page-header" style={{ marginBottom: 6 }}>
                <h2>{selected.name}</h2>
                <div>
                  <ImportFromSheet onImported={handleImport} />{" "}
                  <button className="btn danger" onClick={() => removeMachine(selected.id)}>Delete machine</button>
                </div>
              </div>

              <div className="section-title">Device setup</div>
              <div className="hint">
                Put this machine's API key into the operator app's <code className="mono-data">config.json</code> on
                the PC next to this machine, so the app knows which machine it is.
              </div>
              <div style={{ marginTop: 8, marginBottom: 20 }}>
                {showKey ? (
                  <code className="mono-data" style={{ background: "#f5f6f5", padding: "6px 10px", borderRadius: 6, display: "inline-block" }}>
                    {selected.api_key}
                  </code>
                ) : (
                  <button className="btn secondary" onClick={() => setShowKey(true)}>Show API key</button>
                )}
                {" "}
                <button className="btn secondary" onClick={regenerateKey}>Regenerate key</button>
              </div>

              <FieldEditor machine={selected} optionLists={optionLists} onChanged={load} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
