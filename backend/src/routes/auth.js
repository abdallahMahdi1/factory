const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../lib/db");
const { JWT_SECRET, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Simple in-memory throttle: a shop-floor admin panel doesn't need a
// full rate-limiter dependency, but leaving login completely unthrottled
// invites password guessing. Per-username, resets on success.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

function tooManyAttempts(username) {
  const rec = attempts.get(username);
  if (!rec) return false;
  if (Date.now() - rec.first > LOCKOUT_MS) {
    attempts.delete(username);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}
function noteFailure(username) {
  const rec = attempts.get(username);
  if (!rec || Date.now() - rec.first > LOCKOUT_MS) {
    attempts.set(username, { count: 1, first: Date.now() });
  } else {
    rec.count++;
  }
}

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
  if (tooManyAttempts(username)) {
    return res.status(429).json({ error: "Too many failed attempts. Wait five minutes and try again." });
  }
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    noteFailure(username);
    return res.status(401).json({ error: "Incorrect username or password" });
  }
  attempts.delete(username);
  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, {
    expiresIn: "12h",
  });
  res.json({ token, username: admin.username });
});

// Change the signed-in admin's password. Requires the current one, so a
// left-open browser can't be used to lock the real admin out.
router.post("/change-password", requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Both the current and new password are required." });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: "Use at least 8 characters." });
  }
  const admin = db.prepare("SELECT * FROM admins WHERE id = ?").get(req.admin.id);
  if (!admin || !bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?")
    .run(bcrypt.hashSync(String(newPassword), 10), admin.id);
  res.json({ ok: true, message: "Password changed. Existing sessions stay signed in." });
});

module.exports = router;
