const express = require("express");
const db = require("../lib/db");
const { getSettings } = require("../lib/shift");

const router = express.Router();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

router.get("/", (req, res) => {
  const s = getSettings();
  res.json({
    timezone: s.timezone,
    dayShiftStart: s.dayShiftStart,
    nightShiftStart: s.nightShiftStart,
    // Offered to the admin UI so the timezone field can be a dropdown of
    // real zones rather than a free-text box people typo into.
    availableTimezones: typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC", "Asia/Riyadh", "Asia/Dubai", "Asia/Kolkata", "Europe/London"],
  });
});

router.put("/", (req, res) => {
  const { timezone, dayShiftStart, nightShiftStart } = req.body || {};
  const current = getSettings();

  const tz = timezone ?? current.timezone;
  // Validate by asking Intl to use it — the only reliable check, since the
  // list of valid zones depends on the runtime's ICU data.
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return res.status(400).json({ error: `Unknown time zone: ${tz}` });
  }

  const day = dayShiftStart ?? current.dayShiftStart;
  const night = nightShiftStart ?? current.nightShiftStart;
  if (!HHMM.test(day)) return res.status(400).json({ error: "dayShiftStart must be HH:MM (24-hour)" });
  if (!HHMM.test(night)) return res.status(400).json({ error: "nightShiftStart must be HH:MM (24-hour)" });
  if (day === night) return res.status(400).json({ error: "Day and night shifts can't start at the same time" });

  db.prepare(
    "UPDATE settings SET timezone = ?, day_shift_start = ?, night_shift_start = ?, updated_at = datetime('now') WHERE id = 1"
  ).run(tz, day, night);

  res.json({ timezone: tz, dayShiftStart: day, nightShiftStart: night });
});

module.exports = router;
