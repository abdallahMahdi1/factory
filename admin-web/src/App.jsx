import React, { useState } from "react";
import { Routes, Route, Navigate, NavLink, useNavigate, useLocation } from "react-router-dom";
import { isLoggedIn, setToken, getUsername } from "./api.js";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Machines from "./pages/Machines.jsx";
import Operators from "./pages/Operators.jsx";
import MasterLists from "./pages/MasterLists.jsx";
import Sessions from "./pages/Sessions.jsx";
import Report from "./pages/Report.jsx";
import Attendance from "./pages/Attendance.jsx";
import ScrapReport from "./pages/ScrapReport.jsx";
import Backup from "./pages/Backup.jsx";
import AdminPassword from "./pages/AdminPassword.jsx";

function RequireAuth({ children }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

// The sidebar is grouped into three areas rather than one flat list of
// nine links: reports a supervisor reads daily, the people side, and the
// setup that's touched rarely. Groups collapse so a long list never pushes
// the footer off a short screen.
const NAV_GROUPS = [
  {
    key: "reports",
    label: "Reports",
    items: [
      { to: "/", end: true, label: "Dashboard" },
      { to: "/sessions", label: "Sessions" },
      { to: "/report", label: "Daily report" },
      { to: "/scrap", label: "Scrap report" },
    ],
  },
  {
    key: "people",
    label: "People",
    items: [
      { to: "/operators", label: "Operators" },
      { to: "/attendance", label: "Attendance" },
    ],
  },
  {
    key: "admin",
    label: "Admin",
    items: [
      { to: "/machines", label: "Machine setup" },
      { to: "/lists", label: "Master lists" },
      { to: "/backup", label: "Backup" },
    ],
  },
];

function Shell({ children }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Remembered per browser so a supervisor's layout survives a refresh.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("ft_nav_collapsed") || "{}");
    } catch {
      return {};
    }
  });
  const [narrow, setNarrow] = useState(() => localStorage.getItem("ft_nav_narrow") === "1");

  function toggleGroup(key) {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("ft_nav_collapsed", JSON.stringify(next));
      return next;
    });
  }
  function toggleNarrow() {
    setNarrow((prev) => {
      localStorage.setItem("ft_nav_narrow", prev ? "0" : "1");
      return !prev;
    });
  }

  return (
    <div className={`app-shell${narrow ? " nav-narrow" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">Factory<span className="dot">•</span>Tracker</div>
          <button className="nav-toggle" onClick={toggleNarrow} title={narrow ? "Expand menu" : "Collapse menu"}>
            {narrow ? "»" : "«"}
          </button>
        </div>

        <nav>
          {NAV_GROUPS.map((group) => {
            // A collapsed group still opens if you're inside it, so the
            // current page is never hidden from you.
            const hasActive = group.items.some((i) =>
              i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)
            );
            const isOpen = !collapsed[group.key] || hasActive;
            return (
              <div className="nav-group" key={group.key}>
                <button className="nav-group-title" onClick={() => toggleGroup(group.key)}>
                  <span className={`nav-caret${isOpen ? " open" : ""}`}>▸</span>
                  <span className="nav-group-label">{group.label}</span>
                </button>
                {isOpen && group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => (isActive ? "active" : "")}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="footer">
          <div style={{ fontSize: 12.5, marginBottom: 8, color: "#889299" }}>{getUsername()}</div>
          <button onClick={() => { setToken(null); navigate("/login"); }}>Log out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Shell><Dashboard /></Shell></RequireAuth>} />
      <Route path="/sessions" element={<RequireAuth><Shell><Sessions /></Shell></RequireAuth>} />
      <Route path="/report" element={<RequireAuth><Shell><Report /></Shell></RequireAuth>} />
      <Route path="/scrap" element={<RequireAuth><Shell><ScrapReport /></Shell></RequireAuth>} />
      <Route path="/attendance" element={<RequireAuth><Shell><Attendance /></Shell></RequireAuth>} />
      <Route path="/machines" element={<RequireAuth><Shell><Machines /></Shell></RequireAuth>} />
      <Route path="/operators" element={<RequireAuth><Shell><Operators /></Shell></RequireAuth>} />
      <Route path="/backup" element={<RequireAuth><Shell><Backup /></Shell></RequireAuth>} />
      {/* Unlisted on purpose — reachable by typing /adminpass, and still
          behind the same auth as everything else. */}
      <Route path="/adminpass" element={<RequireAuth><Shell><AdminPassword /></Shell></RequireAuth>} />
      <Route path="/lists" element={<RequireAuth><Shell><MasterLists /></Shell></RequireAuth>} />
    </Routes>
  );
}
