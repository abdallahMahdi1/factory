import React from "react";
import { Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { isLoggedIn, setToken, getUsername } from "./api.js";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Machines from "./pages/Machines.jsx";
import Operators from "./pages/Operators.jsx";
import MasterLists from "./pages/MasterLists.jsx";
import Sessions from "./pages/Sessions.jsx";
import Report from "./pages/Report.jsx";

function RequireAuth({ children }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

function Shell({ children }) {
  const navigate = useNavigate();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Factory<span className="dot">•</span>Tracker</div>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>Dashboard</NavLink>
          <NavLink to="/sessions" className={({ isActive }) => (isActive ? "active" : "")}>Sessions</NavLink>
          <NavLink to="/report" className={({ isActive }) => (isActive ? "active" : "")}>Daily report</NavLink>
          <NavLink to="/machines" className={({ isActive }) => (isActive ? "active" : "")}>Machines</NavLink>
          <NavLink to="/operators" className={({ isActive }) => (isActive ? "active" : "")}>Operators</NavLink>
          <NavLink to="/lists" className={({ isActive }) => (isActive ? "active" : "")}>Master lists</NavLink>
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
      <Route path="/machines" element={<RequireAuth><Shell><Machines /></Shell></RequireAuth>} />
      <Route path="/operators" element={<RequireAuth><Shell><Operators /></Shell></RequireAuth>} />
      <Route path="/lists" element={<RequireAuth><Shell><MasterLists /></Shell></RequireAuth>} />
    </Routes>
  );
}
