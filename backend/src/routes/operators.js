const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../lib/db");

const router = express.Router();

function machinesFor(operatorId) {
  return db
    .prepare(
      `SELECT m.id, m.name, m.code
       FROM operator_machines om
       JOIN machines m ON m.id = om.machine_id
       WHERE om.operator_id = ?
       ORDER BY m.name ASC`
    )
    .all(operatorId);
}

router.get("/", (req, res) => {
  const operators = db.prepare("SELECT * FROM operators ORDER BY name ASC").all();
  res.json(operators.map((o) => ({ ...o, machines: machinesFor(o.id) })));
});

router.post("/", (req, res) => {
  const { name, idNumber } = req.body || {};
  if (!name || !idNumber) return res.status(400).json({ error: "name and idNumber are required" });
  const id = uuid();
  try {
    db.prepare("INSERT INTO operators (id, name, id_number) VALUES (?, ?, ?)").run(
      id,
      name,
      idNumber
    );
  } catch (err) {
    return res.status(400).json({ error: "That ID number is already in use" });
  }
  res.status(201).json({ id, name, id_number: idNumber, active: 1, machines: [] });
});

router.put("/:id", (req, res) => {
  const { name, idNumber, active } = req.body || {};
  const operator = db.prepare("SELECT * FROM operators WHERE id = ?").get(req.params.id);
  if (!operator) return res.status(404).json({ error: "Operator not found" });
  db.prepare("UPDATE operators SET name = ?, id_number = ?, active = ? WHERE id = ?").run(
    name ?? operator.name,
    idNumber ?? operator.id_number,
    active === undefined ? operator.active : active ? 1 : 0,
    req.params.id
  );
  res.json({ ...db.prepare("SELECT * FROM operators WHERE id = ?").get(req.params.id), machines: machinesFor(req.params.id) });
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM operators WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Replace the full set of machines this operator is authorized on
router.put("/:id/machines", (req, res) => {
  const { machineIds } = req.body || {};
  if (!Array.isArray(machineIds)) return res.status(400).json({ error: "machineIds must be an array" });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM operator_machines WHERE operator_id = ?").run(req.params.id);
    const insert = db.prepare(
      "INSERT INTO operator_machines (id, operator_id, machine_id) VALUES (?, ?, ?)"
    );
    for (const machineId of machineIds) {
      insert.run(uuid(), req.params.id, machineId);
    }
  });
  tx();
  res.json({ operatorId: req.params.id, machines: machinesFor(req.params.id) });
});

module.exports = router;
