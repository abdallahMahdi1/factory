// Parses a pasted CSV that follows the same shape as a real paper/Excel
// production sheet: a "group" header row (Input / Output / Raw Materials /
// ...), a "field label" row directly under it, and optionally one more
// sub-row for columns that need a second-level split (e.g. "Raw Materials"
// having both "Main Material" and "Aux. Material" under one group cell).
//
// This does NOT try to be a general CSV parser — it's built specifically to
// read the two-tier header shape used in these factory report sheets, since
// that's the actual format being imported from.
export function parseSheetCsv(text) {
  const rows = text
    .split(/\r?\n/)
    .filter((r) => r.trim().length > 0)
    .map((r) => splitCsvLine(r));

  if (rows.length === 0) return { fields: [], warning: "The pasted text is empty." };

  // Find the group row: the first row that has at least one non-empty cell
  // AND is immediately followed by a row that looks like field labels
  // (i.e. has more non-empty cells than the group row — group cells span
  // several columns, so the row is sparser).
  let groupRowIdx = -1;
  for (let i = 0; i < rows.length - 1; i++) {
    const nonEmpty = rows[i].filter((c) => c.trim()).length;
    const nextNonEmpty = rows[i + 1].filter((c) => c.trim()).length;
    // A real group row spans several columns (2+ groups like Input/Output).
    // A single-cell row is a TITLE — "Production Department", a date — and
    // treating it as a group label tags every field with it.
    if (nonEmpty >= 2 && nextNonEmpty > nonEmpty) {
      groupRowIdx = i;
      break;
    }
  }

  // Plenty of real sheets have ONE header row, not a group row above a
  // label row — a daily production sheet is usually just
  // "MACHINE | SHIFT | W.O. No. | ...". Requiring two tiers made the
  // importer reject those outright, so fall back to treating the widest
  // row near the top as the labels, with no groups.
  let groupRow, labelRow;
  if (groupRowIdx === -1) {
    let best = { idx: -1, count: 0 };
    const limit = Math.min(rows.length, 20);
    for (let i = 0; i < limit; i++) {
      // A header row is text, not numbers: ignore rows that are mostly
      // numeric, which are data rows that happen to be wide.
      const cells = rows[i].filter((c) => c.trim());
      const texty = cells.filter((c) => !/^-?[\d.,]+$/.test(c.trim())).length;
      if (texty >= 2 && texty > best.count) best = { idx: i, count: texty };
    }
    if (best.idx === -1) {
      return {
        fields: [],
        warning:
          "Couldn't find a header row. Make sure the sheet has a row of column names — " +
          "either a single row, or a group row (Input/Output/...) with the field names right below it.",
      };
    }
    groupRowIdx = best.idx;
    labelRow = rows[groupRowIdx];
    groupRow = new Array(labelRow.length).fill(""); // no groups in a flat sheet
  } else {
    groupRow = rows[groupRowIdx];
    labelRow = rows[groupRowIdx + 1];
  }
  // An optional sub-row: present when it has content but doesn't look like
  // a data row (heuristic: a data row for THIS sheet is expected to be
  // mostly empty right after headers — a real sub-row like "Main Material /
  // Aux. Material" has short, label-like text in a few of the same columns
  // the group row spans).
  const maybeSubRow = groupRow.some((c) => c.trim()) ? rows[groupRowIdx + 2] : null;
  const hasSubRow =
    maybeSubRow &&
    maybeSubRow.some((c, i) => c.trim() && !labelRow[i]?.trim());

  const width = Math.max(groupRow.length, labelRow.length);
  const warnings = [];

  // Group cells are forward-filled: "Input" written once at column 6 means
  // columns 6, 7, 8... all belong to Input, until the next group cell
  // ("Output") appears further right. Columns BEFORE the first group cell
  // (e.g. Size/Process/WO#, which precede "Input" in the source sheet) are
  // ungrouped.
  const groupForCol = new Array(width).fill("");
  let currentGroup = "";
  for (let col = 0; col < width; col++) {
    const cell = (groupRow[col] || "").trim();
    if (cell) currentGroup = cell;
    groupForCol[col] = currentGroup;
  }

  // Field labels, by contrast, only need back-fill for the specific case of
  // a merged label cell followed by blank columns that share it (e.g.
  // "Supplier, Grade, % Catalyst etc." spans two columns, with the second
  // one blank in the label row but filled in by the sub-row instead). We
  // detect that case directly via the sub-row rather than blanket
  // back-filling every label, since most blank label cells are genuinely
  // blank spacer columns, not continuations.
  const labelForCol = labelRow.map((c) => (c || "").trim());
  for (let col = 0; col < width; col++) {
    if (!labelForCol[col] && labelForCol[col - 1] && hasSubRow && (maybeSubRow[col] || "").trim()) {
      labelForCol[col] = labelForCol[col - 1];
    }
  }

  const fields = [];
  const seenLabels = new Map(); // label -> field index, so a repeated column name (e.g. "Drum #" under both Input and Output) merges into ONE shared field per your instruction, instead of creating a duplicate

  for (let col = 0; col < width; col++) {
    const groupCell = groupForCol[col];
    const labelCell = labelForCol[col];
    const subCell = hasSubRow ? (maybeSubRow[col] || "").trim() : "";

    if (!labelCell && !subCell) continue; // blank spacer column
    const label = subCell || labelCell;
    if (!label) continue;

    if (seenLabels.has(label)) continue; // merge repeated column names into one shared field
    seenLabels.set(label, true);

    fields.push({
      label,
      groupLabel: groupCell || null,
      type: guessType(label),
      required: true,
      stage: guessStage(groupCell, label),
      order: fields.length,
    });
  }

  if (fields.length === 0) {
    warnings.push("No columns were recognized — check that the group row and field-label row are both present.");
  }

  return { fields, warning: warnings[0] || null };
}

// Columns whose label implies a measured quantity get type "number";
// everything else defaults to free text. This is a starting point the
// admin can still hand-adjust per field afterward — it doesn't need to be
// perfect, just a reasonable default that saves re-typing 30 rows by hand.
const NUMBER_HINTS = [
  "mm", "kg", "rpm", "mpm", "(m)", "(mtrs)", "count", "length", "dia", "speed",
  "thickness", "min", "max", "avg", "start", "stop", "id ", "id(", "%",
];
// Guesses which screen a column belongs on from its group heading. On these
// sheets, "Input"/"Raw Materials"/"Toolings" columns are filled in as the
// job runs, while "Output"/"Performance"/"Scrap" columns are results known
// at the end — so they default to the Output table. It's only a starting
// point: the import preview lets you change any field's screen before
// anything is saved.
const STOP_GROUP_HINTS = ["output", "performance", "scrap", "result", "reject", "defect", "waste", "yield"];
function guessStage(groupLabel, label) {
  const hay = `${groupLabel || ""} ${label || ""}`.toLowerCase();
  return STOP_GROUP_HINTS.some((h) => hay.includes(h)) ? "stop" : "start";
}

function guessType(label) {
  const lower = label.toLowerCase();
  return NUMBER_HINTS.some((hint) => lower.includes(hint)) ? "number" : "text";
}

// Minimal CSV line splitter: handles quoted fields with embedded commas,
// which is all this importer needs (no multi-line quoted cells).
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
