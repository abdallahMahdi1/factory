// Parses a plain, single-header-row CSV into work-order objects — much
// simpler than parseSheetCsv.js's two-tier group/field parser, since a
// supervisor's work-order list is just a flat table (one row per job), not
// a form layout. Header matching is fuzzy (case/spacing/punctuation
// insensitive) so pasting from a real planning sheet with slightly
// different column names still works without the admin needing to rename
// anything first.
const HEADER_ALIASES = {
  jobNo: ["job no", "job number", "jobno", "wo", "wo no", "work order", "work order no", "job#"],
  description: ["description", "size type", "size and type", "item", "job description", "size & type"],
  process: ["process"],
  quantity: ["quantity", "qty", "total qty", "total qty km", "total quantity"],
  priority: ["priority"],
  dueDate: ["due date", "delivery date", "delivery"],
  specialInstruction: ["special instruction", "special instructions", "instruction", "instructions"],
  remarks: ["remarks", "notes", "note", "remark"],
  inputDiameter: ["input diameter", "input dia", "input diameter mm"],
  totalTolerance: ["total tolerance", "tolerance"],
};

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cells.push(current); current = ""; }
      else current += ch;
    }
  }
  cells.push(current);
  return cells;
}

const PRIORITY_WORDS = { normal: "normal", high: "high", urgent: "urgent", "high priority": "high" };

export function parseWorkOrdersCsv(text) {
  const rows = text
    .split(/\r?\n/)
    .filter((r) => r.trim().length > 0)
    .map((r) => splitCsvLine(r));

  if (rows.length < 2) {
    return { workOrders: [], warning: "Paste a header row plus at least one data row." };
  }

  const headerRow = rows[0].map(normalize);
  const colIndex = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = headerRow.findIndex((h) => aliases.includes(h));
    if (idx !== -1) colIndex[field] = idx;
  }

  if (colIndex.jobNo === undefined) {
    return {
      workOrders: [],
      warning: `Couldn't find a "Job No" column in the header row. First row was: ${rows[0].join(", ")}`,
    };
  }

  const workOrders = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const jobNo = (row[colIndex.jobNo] || "").trim();
    if (!jobNo) continue; // skip blank rows
    const get = (field) => (colIndex[field] !== undefined ? (row[colIndex[field]] || "").trim() : "");
    const rawPriority = normalize(get("priority"));
    const quantityRaw = get("quantity");
    const inputDiameterRaw = get("inputDiameter");
    workOrders.push({
      jobNo,
      description: get("description") || null,
      process: get("process") || null,
      quantity: quantityRaw ? Number(quantityRaw.replace(/[^0-9.]/g, "")) || null : null,
      priority: PRIORITY_WORDS[rawPriority] || "normal",
      dueDate: get("dueDate") || null,
      specialInstruction: get("specialInstruction") || null,
      remarks: get("remarks") || null,
      inputDiameter: inputDiameterRaw ? Number(inputDiameterRaw.replace(/[^0-9.]/g, "")) || null : null,
      totalTolerance: get("totalTolerance") || null,
    });
  }

  return { workOrders, warning: workOrders.length === 0 ? "No rows with a Job No were found." : null };
}
