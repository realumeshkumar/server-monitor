"use client";
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { API, clock } from "../lib/format";
import { Card } from "./Tile";

const RANGES = [
  { key: "live", label: "Live", minutes: 5 },
  { key: "1h", label: "1h", minutes: 60 },
  { key: "6h", label: "6h", minutes: 360 },
  { key: "24h", label: "24h", minutes: 1440 },
  { key: "7d", label: "7d", minutes: 10080 },
];

function tick(ts, minutes) {
  if (minutes > 1440) {
    return new Date(ts * 1000).toLocaleDateString([], { day: "numeric", month: "short" });
  }
  return clock(ts, minutes <= 5);
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tabular rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted">{new Date(label * 1000).toLocaleString()}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-4 font-semibold">{p.value}%</span>
        </div>
      ))}
    </div>
  );
}

/**
 * CPU and RAM over time.
 * "Live" draws the points coming from the stream; the other ranges are
 * loaded from the SQLite history and refreshed every 30 seconds.
 */
export default function UsageChart({ live }) {
  const [range, setRange] = useState(RANGES[0]);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (range.key === "live") return;
    let cancelled = false;
    const load = () =>
      fetch(`${API}/api/history?minutes=${range.minutes}`)
        .then((r) => r.json())
        .then((rows) => !cancelled && setHistory(rows))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [range]);

  const data = range.key === "live" ? live : history;

  const tabs = (
    <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5 text-xs" role="tablist" aria-label="Time range">
      {RANGES.map((r) => (
        <button
          key={r.key}
          role="tab"
          aria-selected={r.key === range.key}
          onClick={() => setRange(r)}
          className={`rounded-md px-2.5 py-1 font-medium ${
            r.key === range.key ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  return (
    <Card title="CPU and RAM usage" right={tabs}>
      <div className="flex gap-4 px-4 pt-3 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-cpu" /> CPU
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-mem" /> RAM
        </span>
      </div>
      <div className="h-64 px-2 pb-3 pt-2">
        {data.length < 2 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            Collecting data. The chart fills in as samples arrive.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(ts) => tick(ts, range.minutes)}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                stroke="var(--border)"
                minTickGap={48}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                stroke="var(--border)"
                width={52}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }} />
              <Line name="CPU" dataKey="cpu" stroke="var(--cpu)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line name="RAM" dataKey="mem" stroke="var(--mem)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}
