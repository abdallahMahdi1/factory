// Run with: npm run seed
// Creates the first admin login and a couple of example machines so you can
// try the system end-to-end before typing in your real factory data.
require("dotenv").config();
const path = require("path");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const db = require(path.join(__dirname, "..", "src", "lib", "db"));

function upsertOptionList(name, values) {
  let list = db.prepare("SELECT * FROM option_lists WHERE name = ?").get(name);
  if (!list) {
    const id = uuid();
    db.prepare("INSERT INTO option_lists (id, name) VALUES (?, ?)").run(id, name);
    list = { id, name };
  }
  for (const value of values) {
    const exists = db
      .prepare("SELECT 1 FROM option_items WHERE option_list_id = ? AND value = ?")
      .get(list.id, value);
    if (!exists) {
      db.prepare("INSERT INTO option_items (id, option_list_id, value) VALUES (?, ?, ?)").run(
        uuid(),
        list.id,
        value
      );
    }
  }
  return list;
}

function main() {
  // --- Admin login ---
  const adminUsername = process.env.SEED_ADMIN_USERNAME || "admin";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "admin123";
  const existingAdmin = db.prepare("SELECT * FROM admins WHERE username = ?").get(adminUsername);
  if (!existingAdmin) {
    db.prepare("INSERT INTO admins (id, username, password_hash) VALUES (?, ?, ?)").run(
      uuid(),
      adminUsername,
      bcrypt.hashSync(adminPassword, 10)
    );
    console.log(`Created admin login -> username: ${adminUsername}  password: ${adminPassword}`);
  } else {
    console.log(`Admin "${adminUsername}" already exists, skipping.`);
  }

  // --- Master lists ---
  const materials = upsertOptionList("Materials", ["Steel S235", "Aluminum 6061", "Stainless 304", "Brass"]);
  const tools = upsertOptionList("Tools", ["Lathe tool A", "Drill bit 8mm", "Milling cutter 12mm"]);
  const workOrders = upsertOptionList("Work Orders", ["WO-1001", "WO-1002", "WO-1003"]);

  // --- Pause / stop reasons ---
  for (const label of ["Break", "Waiting for material", "Machine breakdown", "Quality check", "Meeting"]) {
    const exists = db.prepare("SELECT 1 FROM pause_reasons WHERE label = ?").get(label);
    if (!exists) db.prepare("INSERT INTO pause_reasons (id, label) VALUES (?, ?)").run(uuid(), label);
  }
  for (const label of ["Job finished", "Cancelled", "Wrong work order", "End of shift"]) {
    const exists = db.prepare("SELECT 1 FROM stop_reasons WHERE label = ?").get(label);
    if (!exists) db.prepare("INSERT INTO stop_reasons (id, label) VALUES (?, ?)").run(uuid(), label);
  }

  // --- One example machine with a start form, so you can see it working ---
  let machine = db.prepare("SELECT * FROM machines WHERE code = ?").get("CNC-01");
  if (!machine) {
    const id = uuid();
    const apiKey = uuid();
    db.prepare("INSERT INTO machines (id, name, code, api_key) VALUES (?, ?, ?, ?)").run(
      id,
      "CNC Machine 1",
      "CNC-01",
      apiKey
    );
    machine = { id, api_key: apiKey };

    const fields = [
      { label: "Work order", type: "select", listId: workOrders.id, order: 0 },
      { label: "Material", type: "select", listId: materials.id, order: 1 },
      { label: "Tool", type: "select", listId: tools.id, order: 2 },
      { label: "Notes", type: "text", listId: null, order: 3, required: false },
    ];
    for (const f of fields) {
      db.prepare(
        `INSERT INTO machine_fields (id, machine_id, label, type, option_list_id, required, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), id, f.label, f.type, f.listId, f.required === false ? 0 : 1, f.order);
    }
    console.log(`Created example machine "CNC Machine 1" (code CNC-01)`);
    console.log(`  Its device API key (put this in the operator app's config.json): ${apiKey}`);
  } else {
    console.log(`Machine CNC-01 already exists -> api key: ${machine.api_key}`);
  }

  // --- One example operator, authorized on that machine ---
  let operator = db.prepare("SELECT * FROM operators WHERE id_number = ?").get("1001");
  if (!operator) {
    const id = uuid();
    db.prepare("INSERT INTO operators (id, name, id_number) VALUES (?, ?, ?)").run(id, "Ahmed Ali", "1001");
    db.prepare("INSERT INTO operator_machines (id, operator_id, machine_id) VALUES (?, ?, ?)").run(
      uuid(),
      id,
      machine.id
    );
    console.log(`Created example operator "Ahmed Ali" (ID number: 1001), authorized on CNC-01`);
  }

  console.log("Seed complete.");
}

main();
