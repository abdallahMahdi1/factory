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

module.exports = { parseRows };
