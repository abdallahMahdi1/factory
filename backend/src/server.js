require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { requireAdmin } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const machineRoutes = require("./routes/machines");
const optionListRoutes = require("./routes/optionLists");
const operatorRoutes = require("./routes/operators");
const reasonRoutes = require("./routes/reasons");
const sessionRoutes = require("./routes/sessions");
const dashboardRoutes = require("./routes/dashboard");
const deviceRoutes = require("./routes/device");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Public
app.use("/api/auth", authRoutes);

// Operator devices authenticate with their own machine API key, not a JWT
app.use("/api/device", deviceRoutes);

// Everything else is the admin panel, protected by admin login
app.use("/api/machines", requireAdmin, machineRoutes);
app.use("/api/option-lists", requireAdmin, optionListRoutes);
app.use("/api/operators", requireAdmin, operatorRoutes);
app.use("/api", requireAdmin, reasonRoutes); // /api/pause-reasons, /api/stop-reasons
app.use("/api/sessions", requireAdmin, sessionRoutes);
app.use("/api/dashboard", requireAdmin, dashboardRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Factory Tracker API listening on http://localhost:${PORT}`);
});
