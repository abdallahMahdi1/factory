const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../lib/db");

const router = express.Router();

function itemsFor(listId) {
  return db
    .prepare("SELECT * FROM option_items WHERE option_list_id = ? ORDER BY value ASC")
    .all(listId);
}

router.get("/", (req, res) => {
  const lists = db.prepare("SELECT * FROM option_lists ORDER BY name ASC").all();
  res.json(lists.map((l) => ({ ...l, items: itemsFor(l.id) })));
});

router.post("/", (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = uuid();
  try {
    db.prepare("INSERT INTO option_lists (id, name) VALUES (?, ?)").run(id, name);
  } catch (err) {
    return res.status(400).json({ error: "A list with that name already exists" });
  }
  res.status(201).json({ id, name, items: [] });
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM option_lists WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

router.post("/:id/items", (req, res) => {
  const { value } = req.body || {};
  if (!value) return res.status(400).json({ error: "value is required" });
  const id = uuid();
  db.prepare("INSERT INTO option_items (id, option_list_id, value) VALUES (?, ?, ?)").run(
    id,
    req.params.id,
    value
  );
  res.status(201).json(db.prepare("SELECT * FROM option_items WHERE id = ?").get(id));
});

router.put("/:id/items/:itemId", (req, res) => {
  const { value, active } = req.body || {};
  const item = db.prepare("SELECT * FROM option_items WHERE id = ?").get(req.params.itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });
  db.prepare("UPDATE option_items SET value = ?, active = ? WHERE id = ?").run(
    value ?? item.value,
    active === undefined ? item.active : active ? 1 : 0,
    req.params.itemId
  );
  res.json(db.prepare("SELECT * FROM option_items WHERE id = ?").get(req.params.itemId));
});

router.delete("/:id/items/:itemId", (req, res) => {
  db.prepare("DELETE FROM option_items WHERE id = ?").run(req.params.itemId);
  res.status(204).end();
});

module.exports = router;
