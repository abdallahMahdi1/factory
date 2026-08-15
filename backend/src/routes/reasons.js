const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../lib/db");

const router = express.Router();

function buildReasonRouter(table) {
  const r = express.Router();

  r.get("/", (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${table} ORDER BY label ASC`).all());
  });

  r.post("/", (req, res) => {
    const { label } = req.body || {};
    if (!label) return res.status(400).json({ error: "label is required" });
    const id = uuid();
    try {
      db.prepare(`INSERT INTO ${table} (id, label) VALUES (?, ?)`).run(id, label);
    } catch (err) {
      return res.status(400).json({ error: "That reason already exists" });
    }
    res.status(201).json({ id, label, active: 1 });
  });

  r.put("/:id", (req, res) => {
    const { label, active } = req.body || {};
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare(`UPDATE ${table} SET label = ?, active = ? WHERE id = ?`).run(
      label ?? row.label,
      active === undefined ? row.active : active ? 1 : 0,
      req.params.id
    );
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
  });

  r.delete("/:id", (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.status(204).end();
  });

  return r;
}

router.use("/pause-reasons", buildReasonRouter("pause_reasons"));
router.use("/stop-reasons", buildReasonRouter("stop_reasons"));

module.exports = router;
