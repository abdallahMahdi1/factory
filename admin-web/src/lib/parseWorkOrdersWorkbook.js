import * as XLSX from "xlsx";

// Reads a real production-planning workbook (.xlsx/.xls) into work-order
// objects. Deliberately tolerant of how these sheets actually look in a
// factory rather than assuming a clean export:
//   - the header row is often NOT row 1 (title rows, logos, blank rows above)
//   - column names vary between sheets ("Job No." / "JOB NO." / "Work Order")
//   - merged cells leave blanks that should inherit from the row above
//   - cancelled lines are struck through rather than deleted
//   - dates arrive as Excel serial numbers, not strings

const HEADER_ALIASES = {
  jobNo: ["job no", "job no.", "job number", "jobno", "wo", "wo no", "work order", "work order no", "job#", "sl no", "job"],
  description: ["size type", "size & type", "size and type", "description", "item", "job description", "cable description", "size"],
  process: ["process"],
  quantity: ["qty", "quantity", "total qty", "total quantity", "qty km", "total qty km"],
  priority: ["priority"],
  dueDate: ["delivery date", "due date", "delivery", "del date"],
  specialInstruction: ["special instruction", "special instructions", "instruction", "instructions"],
  remarks: ["remarks", "remark", "notes", "note"],
  inputDiameter: ["diameter", "diamete", "input diameter", "input dia", "dia", "diameter mm"],
  totalTolerance: ["tolerance", "toleran", "total tolerance", "tol"],
};

// "SL.NO." is a row counter in these sheets, never the actual job number —
// listed in jobNo aliases above only as a last resort, so make sure a real
// job-number column wins when both are present.
const JOB_NO_PREFERRED = ["job no", "job no.", "job number", "jobno", "work order", "work order no", "wo no"];

function normalize(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Excel stores dates as days since 1900 (with a legacy leap-year quirk that
// SheetJS's own date parser handles). We ask SheetJS for real Date objects
// where it can, and fall back to passing strings through untouched.
function toDateString(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  // A bare number here is an Excel date serial (days since 1899-12-30 in
  // Excel's epoch) that cellDates didn't convert — usually because the cell
  // was never formatted as a date. Convert it rather than storing "45838".
  if (typeof v === "number" && isFinite(v) && v > 20000 && v < 80000) {
    const ms = Math.round((v - 25569) * 86400 * 1000); // 25569 = days from 1970 epoch
    const d = new Date(ms);
    if (!isNaN(d)) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
  }
  const s = String(v).trim();
  return s || null;
}

function toNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

const PRIORITY_WORDS = {
  normal: "normal", high: "high", urgent: "urgent",
  "high priority": "high", "very urgent": "urgent", rush: "urgent",
};

// Finds the row that looks most like a header: the one matching the most
// known column names. Scans the first 20 rows so title/logo rows above the
// real header don't break the import.
function findHeaderRow(rows) {
  const allAliases = new Set(Object.values(HEADER_ALIASES).flat());
  let best = { index: -1, score: 0 };
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    const score = (rows[i] || []).reduce((acc, cell) => {
      const n = normalize(cell);
      return acc + (n && allAliases.has(n) ? 1 : 0);
    }, 0);
    if (score > best.score) best = { index: i, score };
  }
  return best.score >= 2 ? best.index : -1;
}

function mapColumns(headerRow) {
  const normalized = headerRow.map(normalize);
  const colIndex = {};

  // Job number first, preferring a real job-number column over "SL.NO."
  for (const alias of JOB_NO_PREFERRED) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) { colIndex.jobNo = idx; break; }
  }

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (colIndex[field] !== undefined) continue;
    // Exact match first, then a prefix match so truncated headers like
    // "Diamete" or "Toleran" (cut off by column width) still resolve.
    let idx = normalized.findIndex((h) => h && aliases.includes(h));
    if (idx === -1) {
      idx = normalized.findIndex((h) => h && aliases.some((a) => h.startsWith(a) || a.startsWith(h)));
    }
    if (idx !== -1) colIndex[field] = idx;
  }
  return colIndex;
}

// Cells struck through in Excel mean "cancelled" in these sheets. SheetJS
// only exposes that styling with cellStyles enabled, and even then not for
// every file, so this is treated as a best-effort hint: flagged rows are
// pre-unchecked in the preview, never silently dropped.
function struckThroughRows(sheet, headerRowIndex, dataRowCount) {
  const flagged = new Set();
  try {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let r = headerRowIndex + 1; r <= Math.min(range.e.r, headerRowIndex + dataRowCount); r++) {
      let struck = 0;
      let seen = 0;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (!cell || cell.v == null || cell.v === "") continue;
        seen++;
        if (cell.s && cell.s.font && cell.s.font.strike) struck++;
      }
      // Only treat the row as cancelled if most of its filled cells are
      // struck — a single struck cell is likelier an edit than a deletion.
      if (seen > 0 && struck / seen > 0.5) flagged.add(r - headerRowIndex - 1);
    }
  } catch {
    // Styling unavailable — every row simply stays included.
  }
  return flagged;
}

export function parseWorkOrdersWorkbook(arrayBuffer) {
  let wb;
  try {
    wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true, cellStyles: true });
  } catch (err) {
    return { workOrders: [], warning: `Couldn't read that file — is it a valid Excel workbook? (${err.message})`, sheetNames: [] };
  }

  const sheetNames = wb.SheetNames || [];
  if (sheetNames.length === 0) return { workOrders: [], warning: "That workbook has no sheets.", sheetNames: [] };

  // Try every sheet, keep whichever yields the most work orders — saves the
  // admin from having to know which tab the data lives on.
  let best = { workOrders: [], warning: "No rows with a job number were found.", sheetName: sheetNames[0] };

  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet["!ref"]) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "", raw: true });
    if (rows.length < 2) continue;

    const headerRowIndex = findHeaderRow(rows);
    if (headerRowIndex === -1) continue;

    const colIndex = mapColumns(rows[headerRowIndex]);
    if (colIndex.jobNo === undefined) continue;

    const dataRows = rows.slice(headerRowIndex + 1);
    const flagged = struckThroughRows(sheet, headerRowIndex, dataRows.length);

    const workOrders = [];
    // Merged cells in Excel report as blank for every cell after the first,
    // so carry the previous row's value forward for the columns where that
    // genuinely means "same as above".
    const carry = {};
    dataRows.forEach((row, i) => {
      // Raw accessor — keeps Date objects and numbers intact so they can be
      // converted properly, rather than stringifying everything up front.
      const raw = (field) => (colIndex[field] === undefined ? "" : (row[colIndex[field]] ?? ""));
      const get = (field) => {
        const v = raw(field);
        return v == null ? "" : String(v).trim();
      };

      const rawJob = get("jobNo");
      // Reject summary/total lines BEFORE carry-forward, otherwise a "TOTAL"
      // row with a blank job cell inherits the previous row's job number and
      // sneaks in as a real work order. Scan the whole row rather than one
      // column, since which column holds the word "TOTAL" varies between
      // sheets (sometimes the serial-number column, sometimes the job column).
      const looksLikeTotal = row.some((cell) => /^\s*(total|grand total|sub ?total|sum)\b/i.test(String(cell ?? "")));
      if (looksLikeTotal) return;

      const jobNo = rawJob || carry.jobNo || "";
      if (!jobNo) return;                       // nothing identifies this row
      if (rawJob) carry.jobNo = rawJob;

      const forProcess = get("process") || carry.process || "";
      if (get("process")) carry.process = get("process");
      const rawDue = raw("dueDate");
      const forDue = (rawDue !== "" && rawDue != null) ? rawDue : (carry.dueDate ?? "");
      if (rawDue !== "" && rawDue != null) carry.dueDate = rawDue;

      workOrders.push({
        jobNo,
        description: get("description") || null,
        process: forProcess || null,
        quantity: toNumber(raw("quantity")),
        priority: PRIORITY_WORDS[normalize(get("priority"))] || "normal",
        dueDate: toDateString(forDue),
        specialInstruction: get("specialInstruction") || null,
        remarks: get("remarks") || null,
        inputDiameter: toNumber(raw("inputDiameter")),
        totalTolerance: get("totalTolerance") || null,
        // Preview-only flags, stripped before sending to the API
        _cancelled: flagged.has(i),
        _include: !flagged.has(i),
      });
    });

    if (workOrders.length > best.workOrders.length) {
      const cancelledCount = workOrders.filter((w) => w._cancelled).length;
      best = {
        workOrders,
        sheetName: name,
        warning: cancelledCount > 0
          ? `${cancelledCount} row(s) look struck through (cancelled) and are unticked below — tick them if you do want them.`
          : null,
      };
    }
  }

  return { ...best, sheetNames };
}
