const jwt = require("jsonwebtoken");
const db = require("../lib/db");

// In production a missing secret must stop the server, not silently fall
// back to a known string — anyone could then forge an admin token.
const IS_PROD = process.env.NODE_ENV === "production";
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error(
    "FATAL: JWT_SECRET is not set. Set it to a long random value before running in production."
  );
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// Protects admin panel routes. Expects: Authorization: Bearer <token>
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing admin token" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Protects device (operator-app) routes. Expects: X-Machine-Api-Key: <key>
// A device only ever authenticates as itself — it can't see other machines' data.
function requireDevice(req, res, next) {
  const apiKey = req.headers["x-machine-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing machine API key" });
  const machine = db.prepare("SELECT * FROM machines WHERE api_key = ?").get(apiKey);
  if (!machine) return res.status(401).json({ error: "Unknown machine API key" });
  req.machine = machine;
  next();
}

module.exports = { requireAdmin, requireDevice, JWT_SECRET };
