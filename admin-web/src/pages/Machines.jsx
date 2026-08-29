import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { parseSheetCsv } from "../lib/parseSheetCsv.js";
import { parseWorkOrdersCsv } from "../lib/parseWorkOrdersCsv.js";

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

  async function handleFile(file) {
    if (!file) return;
    setError("");
    setWarning("");
    try {
      const buf = await file.arrayBuffer();
      // Lazy-loaded: the Excel library is large and only needed here.
      const { workbookToSheetCsv } = await import("../lib/workbookToSheetCsv.js");
      const { csv, sheetName, warning: readWarning } = workbookToSheetCsv(buf);
      if (!csv) {
        setError(readWarning || "Couldn't read any header rows from that file.");
        return;
      }
      // Route the Excel content through the SAME parser the paste box uses,
      // so both paths behave identically and only need fixing in one place.
      const { fields, warning } = parseSheetCsv(csv);
      if (fields.length === 0) {
        setText(csv); // show what was read, so the mismatch is visible
        setError(warning || "Couldn't find a group row and a field-label row in that sheet.");
        return;
      }
      setPreview(fields);
      setWarning([sheetName ? `Read sheet "${sheetName}".` : "", warning || ""].filter(Boolean).join(" "));
    } catch (err) {
      setError(`Couldn't read that file: ${err.message}`);
    }
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
            <div className="section-title">Upload the Excel sheet</div>
            <div className="hint" style={{ marginBottom: 8 }}>
              Pick your production report (.xlsx or .xls). It reads the group header row (e.g. "Input", "Output",
              "Raw Materials") and the field-label row underneath it, then guesses each column's type and which
              screen it belongs on. You review and adjust everything before anything is saved.
            </div>
            <input
              type="file"
              accept=".xlsx,.xls,.xlsm"
              onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }}
              style={{ marginBottom: 18 }}
            />

            <div className="section-title">Or paste CSV</div>
            <div className="hint" style={{ marginBottom: 8 }}>
              Same two-row header shape: the group row, then the field-label row directly underneath.
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
                        {screensOf(machine).map((sc) => <option key={sc.key} value={sc.key}>{sc.label}</option>)}
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

// A machine's screens always include the two built-ins, so a dropdown
// still works for machines that have never customised anything.
function screensOf(machine) {
  const list = machine?.screens;
  if (Array.isArray(list) && list.length > 0) return list;
  return [{ key: "start", label: "Input" }, { key: "stop", label: "Output" }];
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
          {screensOf(machine).map((sc) => <option key={sc.key} value={sc.key}>{sc.label}</option>)}
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

  const screens = screensOf(machine);
  return (
    <div>
      <ScreenManager machine={machine} onChanged={onChanged} />
      {screens.map((sc) => (
        <div key={sc.key}>
          {renderTable(
            machine.fields.filter((f) => f.stage === sc.key),
            `${sc.label} fields`,
            `Columns of the operator's "${sc.label}" table — filled in as rows are added throughout the job.`
          )}
        </div>
      ))}
      {/* Any field whose screen no longer exists would otherwise vanish
          from this page while still being sent to the operator app. */}
      {(() => {
        const known = new Set(screens.map((sc) => sc.key));
        const orphans = machine.fields.filter((f) => !known.has(f.stage));
        return orphans.length === 0 ? null : renderTable(
          orphans,
          "Fields on removed screens",
          "These fields point at a screen that no longer exists. Move them to a current screen, or delete them."
        );
      })()}
      <div className="section-title">Add a field</div>
      <AddFieldForm machine={machine} optionLists={optionLists} onChanged={onChanged} />
    </div>
  );
}

// Create, rename, reorder and remove the tables a machine shows in the
// operator app. The two built-ins can be renamed but not removed, since
// every machine needs somewhere to put its fields.
function ScreenManager({ machine, onChanged }) {
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const screens = screensOf(machine);

  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function add(e) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    await run(async () => {
      await api.machines.screens.create(machine.id, newLabel.trim());
      setNewLabel("");
    });
  }
  async function rename(sc) {
    const label = window.prompt(`Rename "${sc.label}" to:`, sc.label);
    if (!label || label.trim() === sc.label) return;
    await run(() => api.machines.screens.update(machine.id, sc.key, { label: label.trim() }));
  }
  async function move(sc, delta) {
    const ordered = [...screens];
    const i = ordered.findIndex((x) => x.key === sc.key);
    const j = i + delta;
    if (j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    await run(async () => {
      for (let idx = 0; idx < ordered.length; idx++) {
        await api.machines.screens.update(machine.id, ordered[idx].key, { sortOrder: idx });
      }
    });
  }
  async function remove(sc) {
    if (!window.confirm(`Remove the "${sc.label}" screen?`)) return;
    await run(() => api.machines.screens.remove(machine.id, sc.key));
  }

  return (
    <div style={{ marginBottom: 22 }}>
      <div className="section-title">Screens (tables in the operator app)</div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Each screen becomes its own table on the operator's job page, in this order. Every table stays open and
        editable for the whole job. Input and Output can be renamed but not removed.
      </div>
      <div className="screen-chips">
        {screens.map((sc, i) => (
          <div className="screen-chip" key={sc.key}>
            <span className="screen-chip-label">{sc.label}</span>
            <span className="screen-chip-count">
              {machine.fields.filter((f) => f.stage === sc.key).length} fields
            </span>
            <button className="btn secondary" disabled={busy || i === 0} onClick={() => move(sc, -1)} title="Move up">↑</button>
            <button className="btn secondary" disabled={busy || i === screens.length - 1} onClick={() => move(sc, 1)} title="Move down">↓</button>
            <button className="btn secondary" disabled={busy} onClick={() => rename(sc)}>Rename</button>
            {!sc.builtin && <button className="btn secondary" disabled={busy} onClick={() => remove(sc)}>Remove</button>}
          </div>
        ))}
      </div>
      <form className="inline-form" style={{ marginTop: 10 }} onSubmit={add}>
        <div className="field" style={{ minWidth: 200 }}>
          <label>New screen name</label>
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Scrap" />
        </div>
        <button className="btn secondary" disabled={busy || !newLabel.trim()}>Add screen</button>
      </form>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

const PRIORITY_BADGE = { normal: "grey", high: "amber", urgent: "red" };
const STATUS_BADGE = { pending: "grey", in_progress: "green", finished: "grey", cancelled: "red" };

function AddWorkOrderForm({ machine, onAdded }) {
  const [jobNo, setJobNo] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [priority, setPriority] = useState("normal");
  const [dueDate, setDueDate] = useState("");
  const [inputDiameter, setInputDiameter] = useState("");
  const [totalTolerance, setTotalTolerance] = useState("");
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.machines.workOrders.create(machine.id, {
        jobNo, description: description || null,
        quantity: quantity ? Number(quantity) : null,
        priority, dueDate: dueDate || null,
        inputDiameter: inputDiameter ? Number(inputDiameter) : null,
        totalTolerance: totalTolerance || null,
        remarks: remarks || null,
      });
      setJobNo(""); setDescription(""); setQuantity(""); setDueDate(""); setPriority("normal");
      setInputDiameter(""); setTotalTolerance(""); setRemarks("");
      onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} style={{ flexWrap: "wrap" }}>
      <div className="field" style={{ minWidth: 140 }}>
        <label>Job No *</label>
        <input value={jobNo} onChange={(e) => setJobNo(e.target.value)} placeholder="WO-1001" required />
      </div>
      <div className="field" style={{ minWidth: 180 }}>
        <label>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="3CX120MM2 cable" />
      </div>
      <div className="field" style={{ minWidth: 100 }}>
        <label>Quantity</label>
        <input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>
      <div className="field" style={{ minWidth: 110 }}>
        <label>Priority</label>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
      <div className="field" style={{ minWidth: 150 }}>
        <label>Due date</label>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <div className="field" style={{ minWidth: 120 }}>
        <label>Input diameter</label>
        <input type="number" step="any" value={inputDiameter} onChange={(e) => setInputDiameter(e.target.value)} placeholder="e.g. 25.4" />
      </div>
      <div className="field" style={{ minWidth: 130 }}>
        <label>Total tolerance</label>
        <input value={totalTolerance} onChange={(e) => setTotalTolerance(e.target.value)} placeholder="e.g. ±0.1mm" />
      </div>
      <div className="field" style={{ minWidth: 180 }}>
        <label>Remarks</label>
        <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" />
      </div>
      <button className="btn secondary" disabled={saving}>{saving ? "Adding…" : "Add to queue"}</button>
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}

// Paste a flat CSV (Job No, Description, Process, Quantity, Priority, Due
// Date, Special Instruction, Remarks — header names are matched loosely)
// and get back an editable preview before actually creating anything. This
// is what makes bringing in a supervisor's existing planning sheet (many
// rows at once) practical instead of retyping every job by hand.
function BulkImportWorkOrders({ machine, onImported }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function runParse() {
    setError("");
    const { workOrders, warning } = parseWorkOrdersCsv(text);
    // Paste-parsed rows have no cancelled/include flags of their own, so
    // default them to included — the preview's tick column works the same
    // way for both input paths.
    setPreview(workOrders.map((w) => ({ ...w, _include: true, _cancelled: false })));
    setWarning(warning || "");
  }

  async function handleFile(file) {
    if (!file) return;
    setError("");
    setWarning("");
    try {
      const buf = await file.arrayBuffer();
      // Loaded on demand: the Excel library is ~340KB, and importing it at
      // the top of the file would make every admin page load carry that
      // weight for a feature used occasionally. This keeps the everyday
      // dashboard/sessions pages light.
      const { parseWorkOrdersWorkbook } = await import("../lib/parseWorkOrdersWorkbook.js");
      const { workOrders, warning, sheetName } = parseWorkOrdersWorkbook(buf);
      if (workOrders.length === 0) {
        setError(warning || "Couldn't find any work orders in that file.");
        return;
      }
      setPreview(workOrders);
      setWarning([sheetName ? `Read sheet "${sheetName}".` : "", warning || ""].filter(Boolean).join(" "));
    } catch (err) {
      setError(`Couldn't read that file: ${err.message}`);
    }
  }
  function updateRow(i, patch) {
    setPreview((prev) => prev.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  }
  function removeRow(i) {
    setPreview((prev) => prev.filter((_, idx) => idx !== i));
  }
  async function confirmImport() {
    setSaving(true);
    setError("");
    try {
      const toSend = preview
        .filter((w) => w._include !== false)
        .map(({ _include, _cancelled, ...rest }) => rest);
      if (toSend.length === 0) {
        setError("Nothing ticked to import.");
        setSaving(false);
        return;
      }
      await api.machines.workOrders.bulkCreate(machine.id, toSend);
      setOpen(false);
      setText("");
      setPreview(null);
      onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return <button className="btn secondary" onClick={() => setOpen(true)}>Bulk import…</button>;
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" style={{ width: 760, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h2>Bulk import work orders</h2>
        {!preview ? (
          <>
            <div className="section-title">Upload an Excel file</div>
            <div className="hint" style={{ marginBottom: 8 }}>
              Pick your planning sheet (.xlsx or .xls) and it's read automatically — the header row is found even if
              it isn't the first row, merged cells carry down, totals rows are skipped, and struck-through
              (cancelled) rows come in unticked. You review everything before anything is saved.
            </div>
            <input
              type="file"
              accept=".xlsx,.xls,.xlsm"
              onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }}
              style={{ marginBottom: 18 }}
            />

            <div className="section-title">Or paste rows</div>
            <div className="hint" style={{ marginBottom: 8 }}>
              A header row followed by one row per job. Recognized columns: Job No (required), Description, Process,
              Quantity, Priority, Due Date, Special Instruction, Remarks, Input Diameter, Total Tolerance — names are
              matched loosely, so "Size & Type" or "Delivery Date" work fine too.
            </div>
            <textarea
              className="mono-data"
              style={{ width: "100%", minHeight: 200, fontSize: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Job No,Description,Process,Quantity,Priority,Due Date,Special Instruction,Remarks&#10;WO-1001,3CX120MM2 cable,SHEATHING,1.1,High,2026-06-30,LSHF ORANGE,"
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
              Found {preview.length} rows ({preview.filter((w) => w._include !== false).length} ticked). These will be added to the END of the existing queue (nothing
              already planned gets removed). Review and adjust before confirming.
            </div>
            <table style={{ marginBottom: 4 }}>
              <thead><tr><th></th><th>Job No</th><th>Description</th><th>Qty</th><th>Priority</th><th>Due</th><th></th></tr></thead>
              <tbody>
                {preview.map((w, i) => (
                  <tr key={i} style={w._include === false ? { opacity: 0.45 } : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={w._include !== false}
                        onChange={(e) => updateRow(i, { _include: e.target.checked })}
                        title={w._cancelled ? "Looks struck through (cancelled) in the sheet" : "Include this row"}
                      />
                    </td>
                    <td><input style={{ width: 120 }} value={w.jobNo} onChange={(e) => updateRow(i, { jobNo: e.target.value })} /></td>
                    <td><input style={{ width: 160 }} value={w.description || ""} onChange={(e) => updateRow(i, { description: e.target.value })} /></td>
                    <td><input style={{ width: 70 }} type="number" step="any" value={w.quantity ?? ""} onChange={(e) => updateRow(i, { quantity: e.target.value ? Number(e.target.value) : null })} /></td>
                    <td>
                      <select value={w.priority} onChange={(e) => updateRow(i, { priority: e.target.value })}>
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </td>
                    <td><input style={{ width: 110 }} type="date" value={w.dueDate || ""} onChange={(e) => updateRow(i, { dueDate: e.target.value })} /></td>
                    <td><button className="btn secondary" onClick={() => removeRow(i)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {error && <div className="error-text">{error}</div>}
            <div className="actions">
              <button className="btn secondary" onClick={() => setPreview(null)}>Back</button>
              <button className="btn" onClick={confirmImport} disabled={saving || preview.filter((w) => w._include !== false).length === 0}>
                {saving ? "Adding…" : `Add ${preview.filter((w) => w._include !== false).length} work orders`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WorkOrderRow({ machine, wo, isFirst, isLast, onChanged, onMoveUp, onMoveDown }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Every field is editable, not just job number and description — a
  // supervisor correcting a diameter or tolerance shouldn't have to delete
  // and re-add the whole work order.
  function beginEdit() {
    setDraft({
      jobNo: wo.job_no || "",
      description: wo.description || "",
      process: wo.process || "",
      quantity: wo.quantity ?? "",
      priority: wo.priority || "normal",
      dueDate: wo.due_date || "",
      inputDiameter: wo.input_diameter ?? "",
      totalTolerance: wo.total_tolerance || "",
      specialInstruction: wo.special_instruction || "",
      remarks: wo.remarks || "",
    });
    setError("");
    setEditing(true);
  }
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    setSaving(true);
    setError("");
    try {
      await api.machines.workOrders.update(machine.id, wo.id, {
        jobNo: draft.jobNo,
        description: draft.description || null,
        process: draft.process || null,
        quantity: draft.quantity === "" ? null : Number(draft.quantity),
        priority: draft.priority,
        dueDate: draft.dueDate || null,
        inputDiameter: draft.inputDiameter === "" ? null : Number(draft.inputDiameter),
        totalTolerance: draft.totalTolerance || null,
        specialInstruction: draft.specialInstruction || null,
        remarks: draft.remarks || null,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!window.confirm(`Remove work order "${wo.job_no}" from the queue?`)) return;
    await api.machines.workOrders.remove(machine.id, wo.id);
    onChanged();
  }

  // While editing, the row expands into a full-width form — trying to fit
  // ten editable inputs into ten table cells makes every one unusably
  // narrow.
  if (editing) {
    return (
      <tr>
        <td colSpan={11}>
          <div className="wo-edit-form">
            <div className="field" style={{ minWidth: 150 }}>
              <label>Job No *</label>
              <input value={draft.jobNo} onChange={(e) => set({ jobNo: e.target.value })} />
            </div>
            <div className="field" style={{ minWidth: 260, flex: 1 }}>
              <label>Description</label>
              <input value={draft.description} onChange={(e) => set({ description: e.target.value })} />
            </div>
            <div className="field" style={{ minWidth: 130 }}>
              <label>Process</label>
              <input value={draft.process} onChange={(e) => set({ process: e.target.value })} />
            </div>
            <div className="field" style={{ maxWidth: 90 }}>
              <label>Qty</label>
              <input type="number" step="any" value={draft.quantity} onChange={(e) => set({ quantity: e.target.value })} />
            </div>
            <div className="field" style={{ maxWidth: 110 }}>
              <label>Priority</label>
              <select value={draft.priority} onChange={(e) => set({ priority: e.target.value })}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="field" style={{ maxWidth: 150 }}>
              <label>Due date</label>
              <input type="date" value={draft.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
            </div>
            <div className="field" style={{ maxWidth: 110 }}>
              <label>Input dia.</label>
              <input type="number" step="any" value={draft.inputDiameter} onChange={(e) => set({ inputDiameter: e.target.value })} />
            </div>
            <div className="field" style={{ maxWidth: 120 }}>
              <label>Tolerance</label>
              <input value={draft.totalTolerance} onChange={(e) => set({ totalTolerance: e.target.value })} />
            </div>
            <div className="field" style={{ minWidth: 200, flex: 1 }}>
              <label>Special instruction</label>
              <input value={draft.specialInstruction} onChange={(e) => set({ specialInstruction: e.target.value })} />
            </div>
            <div className="field" style={{ minWidth: 180, flex: 1 }}>
              <label>Remarks</label>
              <input value={draft.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </div>
            <div className="wo-edit-actions">
              <button className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>{" "}
              <button className="btn secondary" onClick={() => setEditing(false)}>Cancel</button>
            </div>
            {error && <div className="error-text" style={{ width: "100%" }}>{error}</div>}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td style={{ whiteSpace: "nowrap" }}>
        <button className="btn secondary" onClick={onMoveUp} disabled={isFirst} style={{ padding: "2px 8px" }}>↑</button>{" "}
        <button className="btn secondary" onClick={onMoveDown} disabled={isLast} style={{ padding: "2px 8px" }}>↓</button>
      </td>
      <td><strong>{wo.job_no}</strong></td>
      <td className="wo-desc-cell">{wo.description || "—"}</td>
      <td>{wo.process || "—"}</td>
      <td className="mono-data">{wo.quantity ?? "—"}</td>
      <td className="mono-data">{wo.input_diameter ?? "—"}</td>
      <td className="mono-data">{wo.total_tolerance || "—"}</td>
      <td><span className={`badge ${PRIORITY_BADGE[wo.priority]}`}>{wo.priority}</span></td>
      <td>{wo.due_date || "—"}</td>
      <td className="wo-notes-cell">
        {wo.special_instruction && <div>{wo.special_instruction}</div>}
        {wo.remarks && <div className="wo-remark">{wo.remarks}</div>}
        {!wo.special_instruction && !wo.remarks && "—"}
      </td>
      <td><span className={`badge ${STATUS_BADGE[wo.status]}`}>{wo.status.replace("_", " ")}</span></td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button className="btn secondary" onClick={beginEdit}>Edit</button>{" "}
        <button className="btn secondary" onClick={remove}>Remove</button>
      </td>
    </tr>
  );
}

// "Update queue" — tells the operators on the floor that the plan changed.
// Deliberately a manual button rather than firing on every edit: a
// supervisor reshuffling the list makes many small changes, and each one
// interrupting the floor would train operators to ignore the alert.
function PublishPlan({ machine, queue }) {
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  // The queue prop is passed in purely so this re-checks whenever the
  // supervisor edits something, keeping the "unpublished changes" hint live.
  useEffect(() => {
    let cancelled = false;
    api.machines.plan.get(machine.id)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [machine.id, queue]);

  async function publish() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.machines.plan.publish(machine.id);
      setResult(r);
      setStatus(await api.machines.plan.get(machine.id));
    } catch (err) {
      setResult({ message: err.message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const pending = status?.hasUnpublishedChanges;
  return (
    <div className="publish-plan">
      <button className={`btn ${pending ? "" : "secondary"}`} onClick={publish} disabled={busy}>
        {busy ? "Updating…" : "Update queue"}
      </button>
      <div className="publish-plan-note">
        {pending
          ? <span className="publish-pending">Changes to the top {10} jobs haven't been sent to the operators yet.</span>
          : <span className="hint">Operators are seeing the current plan.</span>}
        {result && (
          <div className={result.error ? "error-text" : "hint"} style={{ marginTop: 2 }}>{result.message}</div>
        )}
      </div>
    </div>
  );
}

function WorkOrderQueue({ machine }) {
  const [workOrders, setWorkOrders] = useState([]);
  const [error, setError] = useState("");
  const [showFinished, setShowFinished] = useState(false);

  async function load() {
    try {
      setWorkOrders(await api.machines.workOrders.list(machine.id));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [machine.id]);

  const queue = workOrders
    .filter((w) => w.status === "pending" || w.status === "in_progress")
    .sort((a, b) => a.sequence - b.sequence);
  const finished = workOrders
    .filter((w) => w.status === "finished")
    .sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || ""));

  async function move(index, direction) {
    const newQueue = [...queue];
    const target = index + direction;
    if (target < 0 || target >= newQueue.length) return;
    [newQueue[index], newQueue[target]] = [newQueue[target], newQueue[index]];
    await api.machines.workOrders.reorder(machine.id, newQueue.map((w) => w.id));
    load();
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div className="section-title">Work order queue</div>
      <PublishPlan machine={machine} queue={queue} />
      <div className="hint" style={{ marginBottom: 10 }}>
        Planned by a supervisor, in priority order. The operator app shows this exact list — they pick a job from
        here to start it; it can't be started any other way.
      </div>
      {error && <div className="error-text">{error}</div>}
      {queue.length === 0 ? (
        <div className="empty">No work orders queued. Add one below, or bulk import a planning sheet.</div>
      ) : (
        <div className="wo-table-scroll">
        <table style={{ marginBottom: 10 }}>
          <thead>
            <tr><th></th><th>Job No</th><th>Description</th><th>Process</th><th>Qty</th><th>Input dia.</th><th>Tolerance</th><th>Priority</th><th>Due</th><th>Instruction / Remarks</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {queue.map((wo, i) => (
              <WorkOrderRow
                key={wo.id}
                machine={machine}
                wo={wo}
                isFirst={i === 0}
                isLast={i === queue.length - 1}
                onMoveUp={() => move(i, -1)}
                onMoveDown={() => move(i, 1)}
                onChanged={load}
              />
            ))}
          </tbody>
        </table>
        </div>
      )}

      <div className="inline-form" style={{ marginBottom: 14 }}>
        <AddWorkOrderForm machine={machine} onAdded={load} />
        <BulkImportWorkOrders machine={machine} onImported={load} />
      </div>

      <button className="btn secondary" onClick={() => setShowFinished((s) => !s)}>
        {showFinished ? "Hide" : "Show"} finished ({finished.length})
      </button>
      {showFinished && (
        finished.length === 0 ? (
          <div className="empty" style={{ marginTop: 8 }}>Nothing finished yet.</div>
        ) : (
          <div className="wo-table-scroll">
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Job No</th><th>Description</th><th>Process</th><th>Qty</th><th>Input dia.</th><th>Tolerance</th><th>Finished</th></tr></thead>
            <tbody>
              {finished.map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.job_no}</strong></td>
                  <td className="wo-desc-cell">{w.description || "—"}</td>
                  <td>{w.process || "—"}</td>
                  <td className="mono-data">{w.quantity ?? "—"}</td>
                  <td className="mono-data">{w.input_diameter ?? "—"}</td>
                  <td className="mono-data">{w.total_tolerance || "—"}</td>
                  <td className="mono-data">{w.finished_at ? new Date(w.finished_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )
      )}
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

              <WorkOrderQueue machine={selected} />

              <FieldEditor machine={selected} optionLists={optionLists} onChanged={load} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
