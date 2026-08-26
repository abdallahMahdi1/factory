import * as XLSX from "xlsx";

// Turns a production-sheet workbook into the exact CSV text that
// parseSheetCsv.js already understands, rather than duplicating that
// parser's two-tier header logic here. Whatever fixes or tweaks land in
// parseSheetCsv keep applying to Excel uploads for free.
//
// Only the top rows are needed: the group row (Input / Output / Raw
// Materials …), the field-label row under it, and possibly one sub-row.
// The actual data rows below are irrelevant when importing COLUMN
// DEFINITIONS, so this stops well before reading the whole sheet.
const ROWS_TO_READ = 8;

function cellToCsv(v) {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const trimmed = s.trim();
  return /[",\n]/.test(trimmed) ? `"${trimmed.replace(/"/g, '""')}"` : trimmed;
}

export function workbookToSheetCsv(arrayBuffer) {
  let wb;
  try {
    wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  } catch (err) {
    return { csv: "", sheetNames: [], sheetName: null, warning: `Couldn't read that file — is it a valid Excel workbook? (${err.message})` };
  }

  const sheetNames = wb.SheetNames || [];
  if (sheetNames.length === 0) {
    return { csv: "", sheetNames: [], sheetName: null, warning: "That workbook has no sheets." };
  }

  // Pick whichever sheet has the widest top rows — a report sheet's header
  // block is wide (many columns), while a notes/summary tab usually isn't.
  let best = { csv: "", sheetName: sheetNames[0], width: -1 };
  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet["!ref"]) continue;
    // blankrows:true matters here — a blank line between the group row and
    // the label row would change their relative positions if dropped.
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: "", raw: true });
    if (rows.length === 0) continue;

    const top = rows.slice(0, ROWS_TO_READ);
    const width = Math.max(...top.map((r) => (r || []).filter((c) => String(c ?? "").trim()).length));
    if (width > best.width) {
      best = {
        csv: top.map((r) => (r || []).map(cellToCsv).join(",")).join("\n"),
        sheetName: name,
        width,
      };
    }
  }

  if (best.width <= 0) {
    return { csv: "", sheetNames, sheetName: best.sheetName, warning: "Couldn't find any header rows in that workbook." };
  }
  return { csv: best.csv, sheetNames, sheetName: best.sheetName, warning: null };
}
