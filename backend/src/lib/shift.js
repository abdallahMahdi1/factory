const db = require("./db");

// Reads the single settings row. Falls back to sane defaults rather than
// throwing, so a database that somehow lost the row still serves requests.
function getSettings() {
  const row = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  return {
    timezone: row?.timezone || "Asia/Riyadh",
    dayShiftStart: row?.day_shift_start || "06:00",
    nightShiftStart: row?.night_shift_start || "18:00",
  };
}

// The local wall-clock time in a given IANA zone, as { hour, minute, dateKey }.
//
// Uses Intl rather than manual offset arithmetic because that's the only
// approach that gets daylight saving right — the offset for a zone isn't a
// constant, it depends on the date. An invalid zone falls back to UTC so a
// typo in settings degrades gracefully instead of crashing every request.
function localParts(isoOrDate, timezone) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  // Intl reports midnight as "24" in some environments; normalise it.
  const hour = Number(get("hour")) % 24;
  return {
    hour,
    minute: Number(get("minute")),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Which shift a moment belongs to.
//
// Day runs from day_shift_start up to (not including) night_shift_start;
// everything else is night. Written as "is it inside the day window?"
// rather than comparing against both boundaries separately, because the
// night shift wraps past midnight (18:00 -> 06:00) and the naive version
// of that comparison gets the small hours wrong.
function shiftFor(isoOrDate, settings = getSettings()) {
  const local = localParts(isoOrDate, settings.timezone);
  if (!local) return null;
  const nowMin = local.hour * 60 + local.minute;
  const dayStart = toMinutes(settings.dayShiftStart);
  const nightStart = toMinutes(settings.nightShiftStart);

  if (dayStart === nightStart) return "day"; // degenerate config: one shift
  if (dayStart < nightStart) {
    return nowMin >= dayStart && nowMin < nightStart ? "day" : "night";
  }
  // Day shift itself wraps midnight (unusual, but configurable, so handle it)
  return nowMin >= dayStart || nowMin < nightStart ? "day" : "night";
}

// Local calendar day (YYYY-MM-DD) in the configured zone. Used so "today's
// report" means the operator's today, not the server's.
function localDateKey(isoOrDate, settings = getSettings()) {
  const local = localParts(isoOrDate, settings.timezone);
  return local ? local.dateKey : null;
}

module.exports = { getSettings, shiftFor, localDateKey, localParts };
