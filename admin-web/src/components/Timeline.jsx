import React from "react";

function formatClock(iso) {
  if (!iso) return "now";
  // 24-hour: "07:28" instead of "07:28 AM". Half the width, no ambiguity on
  // a night shift, and it matches the rest of the reports.
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function formatDuration(fromIso, toIso) {
  const start = new Date(fromIso).getTime();
  const end = toIso ? new Date(toIso).getTime() : Date.now();
  const mins = Math.max(0, Math.round((end - start) / 60000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// Renders exactly the "worked 1:00–2:12, paused 2:12–2:30, worked 2:30–3:05…"
// shape — real clock times read straight off started_at/ended_at, not a
// pre-computed duration number. `segments` is the array the backend already
// builds in routes/dashboard.js and routes/sessions.js's timeline helper:
// [{ type: "work" | "pause", from, to, reasonId? }, ...] in chronological order.
export default function Timeline({ segments, pauseReasonLookup = {}, compact = false }) {
  if (!segments || segments.length === 0) {
    return <div className="hint">No activity recorded yet.</div>;
  }

  // Drop segments shorter than a minute. A quick pause-and-resume produces
  // several "0m" rows that say nothing but crowd out the ones that matter —
  // except the last, which is the live one and must always show.
  const meaningful = segments.filter((seg, i) => {
    if (i === segments.length - 1 || !seg.to) return true;
    return new Date(seg.to).getTime() - new Date(seg.from).getTime() >= 60000;
  });

  // On the dashboard card, show only the tail: the last few states are what
  // "what's happening now" means. The full history is on the session page.
  const MAX_COMPACT_ROWS = 4;
  const hidden = compact ? Math.max(0, meaningful.length - MAX_COMPACT_ROWS) : 0;
  const shown = hidden > 0 ? meaningful.slice(-MAX_COMPACT_ROWS) : meaningful;

  return (
    <div className={`timeline ${compact ? "compact" : ""}`}>
      {hidden > 0 && (
        <div className="timeline-more">+{hidden} earlier {hidden === 1 ? "step" : "steps"}</div>
      )}
      {shown.map((seg, i) => {
        const isOpen = !seg.to;
        const label =
          seg.type === "work"
            ? "Working"
            : seg.type === "setup"
              ? "Under setup"
              : `Paused${seg.reasonId && pauseReasonLookup[seg.reasonId] ? ` — ${pauseReasonLookup[seg.reasonId]}` : ""}`;
        return (
          <div className={`timeline-row ${seg.type} ${isOpen ? "open" : ""}`} key={i}>
            <span className={`timeline-dot ${seg.type}`} />
            <span className="timeline-range mono-data">
              {formatClock(seg.from)} – {isOpen ? "now" : formatClock(seg.to)}
            </span>
            <span className="timeline-label">{label}</span>
            <span className="timeline-duration mono-data">{formatDuration(seg.from, seg.to)}</span>
          </div>
        );
      })}
    </div>
  );
}
