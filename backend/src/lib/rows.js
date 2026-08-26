// field_values / stop_field_values are stored as a JSON array of row
// objects: [{ [machineFieldId]: value }, ...] — one entry per row the
// operator added to that table (Start table or End table).
//
// Sessions created BEFORE the multi-row redesign stored a single flat
// object instead ({ [machineFieldId]: value }, no array). This normalizes
// either shape into an array, so every place that reads this column
// (admin display, CSV export, the operator app) can treat it uniformly
// without crashing on old data or needing a data migration.
function parseRows(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) return [parsed];
  return [];
}

// A session's rows for EVERY screen, as { screenKey: [rowObject, ...] }.
//
// Reads the newer table_rows column, then folds in the two original
// columns for the built-in screens when table_rows doesn't already carry
// them — so sessions recorded before custom screens existed still show
// their Input/Output data with no migration step.
function parseAllScreenRows(session) {
  let byScreen = {};
  if (session.table_rows) {
    try {
      const parsed = JSON.parse(session.table_rows);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) byScreen = parsed;
    } catch { /* fall through to the legacy columns */ }
  }
  for (const [key, column] of [["start", "field_values"], ["stop", "stop_field_values"]]) {
    if (!Array.isArray(byScreen[key]) || byScreen[key].length === 0) {
      const legacy = parseRows(session[column]);
      if (legacy.length > 0) byScreen[key] = legacy;
    }
  }
  for (const key of Object.keys(byScreen)) {
    if (!Array.isArray(byScreen[key])) byScreen[key] = [];
  }
  return byScreen;
}

module.exports = { parseRows, parseAllScreenRows };
