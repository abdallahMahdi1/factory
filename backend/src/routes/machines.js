const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../lib/db");

const router = express.Router();

// The screens a machine shows, always including the two built-ins so a
// machine that has never customised anything still works unchanged.
const BUILTIN_SCREENS = [
  { key: "start", label: "Input", sort_order: 0, builtin: true },
  { key: "stop", label: "Output", sort_order: 1, builtin: true },
];

function screensForMachine(machineId) {
  const custom = db
    .prepare("SELECT key, label, sort_order FROM machine_screens WHERE machine_id = ? ORDER BY sort_order ASC")
    .all(machineId);
  const byKey = new Map(BUILTIN_SCREENS.map((s) => [s.key, { ...s }]));
  for (const c of custom) {
    // A row for "start"/"stop" renames the built-in rather than adding a
    // duplicate — that's how a machine calls its Input table something else.
    const existing = byKey.get(c.key);
    if (existing) {
      existing.label = c.label;
      existing.sort_order = c.sort_order;
    } else {
      byKey.set(c.key, { key: c.key, label: c.label, sort_order: c.sort_order, builtin: false });
    }
  }
  return [...byKey.values()].sort((a, b) => a.sort_order - b.sort_order);
}

function fieldsForMachine(machineId) {
  return db
    .prepare(
      `SELECT mf.*, ol.name as option_list_name
       FROM machine_fields mf
       LEFT JOIN option_lists ol ON ol.id = mf.option_list_id
       WHERE mf.machine_id = ?
       ORDER BY mf.stage ASC, mf.sort_order ASC`
    )
    .all(machineId);
}

// List all machines with their field config
router.get("/", (req, res) => {
  const machines = db.prepare("SELECT * FROM machines ORDER BY name ASC").all();
  const withFields = machines.map((m) => ({ ...m, fields: fieldsForMachine(m.id), screens: screensForMachine(m.id) }));
  res.json(withFields);
});

router.get("/:id", (req, res) => {
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });
  res.json({ ...machine, fields: fieldsForMachine(machine.id), screens: screensForMachine(machine.id) });
});

// Create a machine. Returns the generated api_key — this is what gets typed
// into that machine's operator-app config.json once, during setup.
router.post("/", (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: "name and code are required" });
  const id = uuid();
  const apiKey = uuid();
  try {
    db.prepare("INSERT INTO machines (id, name, code, api_key) VALUES (?, ?, ?, ?)").run(
      id,
      name,
      code,
      apiKey
    );
  } catch (err) {
    return res.status(400).json({ error: "A machine with that name or code already exists" });
  }
  res.status(201).json(db.prepare("SELECT * FROM machines WHERE id = ?").get(id));
});

router.put("/:id", (req, res) => {
  const { name, code } = req.body || {};
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });
  db.prepare("UPDATE machines SET name = ?, code = ? WHERE id = ?").run(
    name || machine.name,
    code || machine.code,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id));
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM machines WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Regenerate a machine's API key (e.g. device was replaced/compromised)
router.post("/:id/regenerate-key", (req, res) => {
  const newKey = uuid();
  const result = db.prepare("UPDATE machines SET api_key = ? WHERE id = ?").run(
    newKey,
    req.params.id
  );
  if (result.changes === 0) return res.status(404).json({ error: "Machine not found" });
  res.json({ apiKey: newKey });
});

// ---- Start/Stop form fields for a machine ----

const FIELD_TYPES = ["text", "number", "select"];
// Screens are defined per machine now, so there's no fixed whitelist to
// check against. What still matters is that a key is a safe, stable
// identifier — it's used as a JSON object key in sessions.table_rows.
const SCREEN_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
function invalidStage(stage) {
  if (stage == null || stage === "") return null;
  return SCREEN_KEY_RE.test(stage)
    ? null
    : "screen must be lowercase letters, numbers, dashes or underscores (max 40 chars)";
}

router.post("/:id/fields", (req, res) => {
  const { label, type, optionListId, required, order, stage, groupLabel } = req.body || {};
  if (!label || !type) return res.status(400).json({ error: "label and type are required" });
  if (!FIELD_TYPES.includes(type)) {
    return res.status(400).json({ error: "type must be 'text', 'number', or 'select'" });
  }
  if (type === "select" && !optionListId) {
    return res.status(400).json({ error: "optionListId is required for select fields" });
  }
  const stageErr = invalidStage(stage);
  if (stageErr) return res.status(400).json({ error: stageErr });
  const id = uuid();
  db.prepare(
    `INSERT INTO machine_fields (id, machine_id, label, type, option_list_id, required, sort_order, stage, group_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.params.id,
    label,
    type,
    type === "select" ? optionListId : null,
    required ? 1 : 0,
    order || 0,
    stage || "start",
    groupLabel || null
  );
  res.status(201).json(db.prepare("SELECT * FROM machine_fields WHERE id = ?").get(id));
});

router.put("/:id/fields/:fieldId", (req, res) => {
  const { label, type, optionListId, required, order, stage, groupLabel } = req.body || {};
  const field = db.prepare("SELECT * FROM machine_fields WHERE id = ?").get(req.params.fieldId);
  if (!field) return res.status(404).json({ error: "Field not found" });
  const nextType = type ?? field.type;
  if (type && !FIELD_TYPES.includes(type)) {
    return res.status(400).json({ error: "type must be 'text', 'number', or 'select'" });
  }
  const stageErr = invalidStage(stage);
  if (stageErr) return res.status(400).json({ error: stageErr });
  db.prepare(
    `UPDATE machine_fields SET label = ?, type = ?, option_list_id = ?, required = ?, sort_order = ?, stage = ?, group_label = ?
     WHERE id = ?`
  ).run(
    label ?? field.label,
    nextType,
    nextType === "select" ? optionListId ?? field.option_list_id : null,
    required === undefined ? field.required : required ? 1 : 0,
    order === undefined ? field.sort_order : order,
    stage ?? field.stage,
    groupLabel === undefined ? field.group_label : groupLabel,
    req.params.fieldId
  );
  res.json(db.prepare("SELECT * FROM machine_fields WHERE id = ?").get(req.params.fieldId));
});

router.delete("/:id/fields/:fieldId", (req, res) => {
  db.prepare("DELETE FROM machine_fields WHERE id = ?").run(req.params.fieldId);
  res.status(204).end();
});

// Bulk replace: swaps out this machine's ENTIRE field set in one transaction.
// Built for the "add/edit a machine's whole form at once" admin UI — much
// friendlier than one field-at-a-time calls when a machine has 20-30 fields,
// and it's how the CSV-import flow (Machines page -> "Import from sheet")
// creates a new machine's fields in a single request.
router.put("/:id/fields", (req, res) => {
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });
  const { fields } = req.body || {};
  if (!Array.isArray(fields)) return res.status(400).json({ error: "fields must be an array" });

  for (const f of fields) {
    if (!f.label || !f.type) return res.status(400).json({ error: "Every field needs a label and type" });
    if (!FIELD_TYPES.includes(f.type)) return res.status(400).json({ error: `Invalid type: ${f.type}` });
    if (f.type === "select" && !f.optionListId) {
      return res.status(400).json({ error: `Field "${f.label}" is type select but has no optionListId` });
    }
    const fStageErr = invalidStage(f.stage);
    if (fStageErr) return res.status(400).json({ error: `${fStageErr} (got "${f.stage}")` });
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM machine_fields WHERE machine_id = ?").run(req.params.id);
    const insert = db.prepare(
      `INSERT INTO machine_fields (id, machine_id, label, type, option_list_id, required, sort_order, stage, group_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    fields.forEach((f, i) => {
      insert.run(
        uuid(),
        req.params.id,
        f.label,
        f.type,
        f.type === "select" ? f.optionListId : null,
        f.required === false ? 0 : 1,
        f.order ?? i,
        f.stage || "start",
        f.groupLabel || null
      );
    });
  });
  tx();

  res.json(fieldsForMachine(req.params.id));
});

// ---- Screens (the tables a machine shows in the operator app) ----

router.get("/:id/screens", (req, res) => {
  res.json(screensForMachine(req.params.id));
});

// Add a screen, or rename a built-in one. The key is derived from the
// label so the admin never has to think about identifiers — but once
// created it never changes, because sessions.table_rows and
// machine_fields.stage both reference it.
router.post("/:id/screens", (req, res) => {
  const machine = db.prepare("SELECT id FROM machines WHERE id = ?").get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });

  const { label, key: providedKey } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: "label is required" });

  const key = String(providedKey || label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const keyErr = invalidStage(key);
  if (keyErr) return res.status(400).json({ error: keyErr });

  const existing = db.prepare("SELECT id FROM machine_screens WHERE machine_id = ? AND key = ?").get(req.params.id, key);
  if (existing) {
    db.prepare("UPDATE machine_screens SET label = ? WHERE id = ?").run(String(label).trim(), existing.id);
    return res.json(screensForMachine(req.params.id));
  }

  const maxSort = db
    .prepare("SELECT COALESCE(MAX(sort_order), 1) as m FROM machine_screens WHERE machine_id = ?")
    .get(req.params.id).m;
  db.prepare("INSERT INTO machine_screens (id, machine_id, key, label, sort_order) VALUES (?, ?, ?, ?, ?)")
    .run(uuid(), req.params.id, key, String(label).trim(), Math.max(maxSort + 1, 2));
  res.status(201).json(screensForMachine(req.params.id));
});

router.put("/:id/screens/:key", (req, res) => {
  const { label, sortOrder } = req.body || {};
  const key = req.params.key;
  const row = db.prepare("SELECT * FROM machine_screens WHERE machine_id = ? AND key = ?").get(req.params.id, key);

  if (row) {
    db.prepare("UPDATE machine_screens SET label = ?, sort_order = ? WHERE id = ?")
      .run(label ?? row.label, sortOrder ?? row.sort_order, row.id);
  } else {
    // Renaming a built-in for the first time creates its override row.
    const builtin = BUILTIN_SCREENS.find((b) => b.key === key);
    if (!builtin) return res.status(404).json({ error: "Screen not found" });
    db.prepare("INSERT INTO machine_screens (id, machine_id, key, label, sort_order) VALUES (?, ?, ?, ?, ?)")
      .run(uuid(), req.params.id, key, label ?? builtin.label, sortOrder ?? builtin.sort_order);
  }
  res.json(screensForMachine(req.params.id));
});

// Removing a screen is refused while any field still lives on it, rather
// than silently orphaning those fields into a table nobody renders.
router.delete("/:id/screens/:key", (req, res) => {
  const key = req.params.key;
  if (BUILTIN_SCREENS.some((b) => b.key === key)) {
    return res.status(400).json({ error: "The Input and Output screens can't be removed — rename them instead." });
  }
  const inUse = db
    .prepare("SELECT COUNT(*) as c FROM machine_fields WHERE machine_id = ? AND stage = ?")
    .get(req.params.id, key).c;
  if (inUse > 0) {
    return res.status(400).json({ error: `That screen still has ${inUse} field(s). Move or delete them first.` });
  }
  db.prepare("DELETE FROM machine_screens WHERE machine_id = ? AND key = ?").run(req.params.id, key);
  res.json(screensForMachine(req.params.id));
});

// ---- Work order queue for a machine (planned by a supervisor) ----

const PRIORITIES = ["normal", "high", "urgent"];

function workOrdersForMachine(machineId, status) {
  const clauses = ["machine_id = ?"];
  const params = [machineId];
  if (status) { clauses.push("status = ?"); params.push(status); }
  return db
    .prepare(`SELECT * FROM work_orders WHERE ${clauses.join(" AND ")} ORDER BY sequence ASC, created_at ASC`)
    .all(...params);
}

router.get("/:id/work-orders", (req, res) => {
  res.json(workOrdersForMachine(req.params.id, req.query.status));
});

router.post("/:id/work-orders", (req, res) => {
  const { jobNo, description, process, quantity, priority, dueDate, specialInstruction, remarks, inputDiameter, totalTolerance, sequence } = req.body || {};
  if (!jobNo) return res.status(400).json({ error: "jobNo is required" });
  if (priority && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: "priority must be 'normal', 'high', or 'urgent'" });
  }
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });

  const maxSeq = db.prepare("SELECT COALESCE(MAX(sequence), -1) as m FROM work_orders WHERE machine_id = ?").get(req.params.id).m;
  const id = uuid();
  db.prepare(
    `INSERT INTO work_orders
       (id, machine_id, sequence, job_no, description, process, quantity, priority, due_date, special_instruction, remarks, input_diameter, total_tolerance, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.params.id, sequence ?? maxSeq + 1, jobNo, description || null, process || null,
    quantity ?? null, priority || "normal", dueDate || null, specialInstruction || null, remarks || null,
    inputDiameter ?? null, totalTolerance || null,
    req.admin?.username || null
  );
  res.status(201).json(db.prepare("SELECT * FROM work_orders WHERE id = ?").get(id));
});

// Explicit reorder: body is an array of work order ids in the new desired
// order. Simpler and less error-prone from the admin UI than asking the
// client to compute individual sequence numbers itself.
router.put("/:id/work-orders/reorder", (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: "orderedIds must be an array" });
  const tx = db.transaction(() => {
    const stmt = db.prepare("UPDATE work_orders SET sequence = ? WHERE id = ? AND machine_id = ?");
    orderedIds.forEach((id, i) => stmt.run(i, id, req.params.id));
  });
  tx();
  res.json(workOrdersForMachine(req.params.id));
});

// Bulk create: one row per work order, e.g. pasted from a supervisor's
// planning sheet. Appends after whatever's already queued rather than
// replacing it (unlike the machine-fields bulk endpoint) — importing a new
// batch of jobs shouldn't wipe out jobs already in progress.
router.post("/:id/work-orders/bulk", (req, res) => {
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });
  const { workOrders } = req.body || {};
  if (!Array.isArray(workOrders) || workOrders.length === 0) {
    return res.status(400).json({ error: "workOrders must be a non-empty array" });
  }
  for (const w of workOrders) {
    if (!w.jobNo) return res.status(400).json({ error: "Every work order needs a jobNo" });
  }

  const maxSeq = db.prepare("SELECT COALESCE(MAX(sequence), -1) as m FROM work_orders WHERE machine_id = ?").get(req.params.id).m;
  const tx = db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO work_orders
         (id, machine_id, sequence, job_no, description, process, quantity, priority, due_date, special_instruction, remarks, input_diameter, total_tolerance, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    workOrders.forEach((w, i) => {
      insert.run(
        uuid(), req.params.id, maxSeq + 1 + i, w.jobNo, w.description || null, w.process || null,
        w.quantity ?? null, PRIORITIES.includes(w.priority) ? w.priority : "normal",
        w.dueDate || null, w.specialInstruction || null, w.remarks || null,
        w.inputDiameter ?? null, w.totalTolerance || null, req.admin?.username || null
      );
    });
  });
  tx();

  res.status(201).json(workOrdersForMachine(req.params.id));
});


router.put("/:id/work-orders/:workOrderId", (req, res) => {
  const wo = db.prepare("SELECT * FROM work_orders WHERE id = ? AND machine_id = ?").get(req.params.workOrderId, req.params.id);
  if (!wo) return res.status(404).json({ error: "Work order not found" });
  const { jobNo, description, process, quantity, priority, dueDate, specialInstruction, remarks, inputDiameter, totalTolerance, sequence, status } = req.body || {};
  if (priority && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: "priority must be 'normal', 'high', or 'urgent'" });
  }
  db.prepare(
    `UPDATE work_orders SET
       job_no = ?, description = ?, process = ?, quantity = ?, priority = ?, due_date = ?,
       special_instruction = ?, remarks = ?, input_diameter = ?, total_tolerance = ?, sequence = ?, status = ?
     WHERE id = ?`
  ).run(
    jobNo ?? wo.job_no,
    description === undefined ? wo.description : description,
    process === undefined ? wo.process : process,
    quantity === undefined ? wo.quantity : quantity,
    priority || wo.priority,
    dueDate === undefined ? wo.due_date : dueDate,
    specialInstruction === undefined ? wo.special_instruction : specialInstruction,
    remarks === undefined ? wo.remarks : remarks,
    inputDiameter === undefined ? wo.input_diameter : inputDiameter,
    totalTolerance === undefined ? wo.total_tolerance : totalTolerance,
    sequence === undefined ? wo.sequence : sequence,
    status || wo.status,
    req.params.workOrderId
  );
  res.json(db.prepare("SELECT * FROM work_orders WHERE id = ?").get(req.params.workOrderId));
});

router.delete("/:id/work-orders/:workOrderId", (req, res) => {
  db.prepare("DELETE FROM work_orders WHERE id = ? AND machine_id = ?").run(req.params.workOrderId, req.params.id);
  res.status(204).end();
});

module.exports = router;
