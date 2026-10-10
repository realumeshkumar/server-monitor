"use client";
import { useEffect, useState } from "react";
import Logs from "../components/Logs";
import { Processes, Services } from "../components/Panels";
import { Tile } from "../components/Tile";
import UsageChart from "../components/UsageChart";
import { API, bytes, duration } from "../lib/format";
import { useEventSource } from "../lib/useEventSource";

const LIVE_POINTS = 150; // about 5 minutes at one sample every 2 seconds

const CONNECTION = {
  live: { text: "Live", tone: "text-ok" },
  connecting: { text: "Connecting", tone: "text-muted" },
  reconnecting: { text: "Reconnecting", tone: "text-warn" },
};

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [live, setLive] = useState([]);

  // Fill the live chart with the last few minutes so it is not empty on load.
  useEffect(() => {
    fetch(`${API}/api/history?minutes=5`)
      .then((r) => r.json())
      .then((rows) => setLive((cur) => [...rows.filter((r) => !cur.length || r.ts < cur[0].ts), ...cur]))
      .catch(() => {});
  }, []);

  const status = useEventSource(`${API}/api/stream`, (snap) => {
    setStats(snap);
    setLive((cur) =>
      [...cur, { ts: snap.ts, cpu: snap.cpu.percent, mem: snap.mem.percent }].slice(-LIVE_POINTS),
    );
  });

  const conn = CONNECTION[status];
  const disk = stats?.disks?.[0];

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{stats?.host ?? "Server"} monitor</h1>
          <p className="tabular text-sm text-muted">
            {stats ? `Up ${duration(stats.uptime)} · ${stats.cpu.count} cores · ${bytes(stats.mem.total)} RAM` : "Waiting for the first reading"}
          </p>
        </div>
        <span className={`inline-flex items-center gap-2 text-sm font-medium ${conn.tone}`} role="status">
          <span className={`h-2 w-2 rounded-full bg-current ${status === "live" ? "animate-pulse" : ""}`} aria-hidden />
          {conn.text}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Tile
          label="CPU"
          value={stats ? stats.cpu.percent.toFixed(1) : "-"}
          unit="%"
          percent={stats?.cpu.percent}
          lines={
            stats
              ? [
                  `Load ${stats.cpu.load.join(" / ")}`,
                  stats.cpu.temp != null ? `Temp ${stats.cpu.temp}°C` : "Temp not available",
                ]
              : []
          }
        />
        <Tile
          label="RAM"
          value={stats ? stats.mem.percent.toFixed(1) : "-"}
          unit="%"
          percent={stats?.mem.percent}
          lines={
            stats
              ? [
                  `${bytes(stats.mem.used)} of ${bytes(stats.mem.total)}`,
                  stats.swap.total ? `Swap ${bytes(stats.swap.used)} of ${bytes(stats.swap.total)}` : "No swap",
                ]
              : []
          }
        />
        <Tile
          label={disk ? `Disk ${disk.mount}` : "Disk"}
          value={disk ? disk.percent.toFixed(1) : "-"}
          unit="%"
          percent={disk?.percent}
          lines={[
            ...(disk ? [`${bytes(disk.used)} of ${bytes(disk.total)}`] : []),
            ...(stats?.disks ?? []).slice(1).map((d) => `${d.mount} ${d.percent}% of ${bytes(d.total)}`),
          ]}
        />
        <Tile
          label="Network"
          value={stats ? bytes(stats.net.rx_rate).split(" ")[0] : "-"}
          unit={stats ? `${bytes(stats.net.rx_rate).split(" ")[1]}/s down` : ""}
          lines={stats ? [`Upload ${bytes(stats.net.tx_rate)}/s`] : []}
        />
        <div className="col-span-2 lg:col-span-1">
          <Tile
            label="Errors, last 5 min"
            value={stats ? stats.errors_5m : "-"}
            level={!stats || stats.errors_5m === 0 ? "normal" : stats.errors_5m >= 20 ? "danger" : "warn"}
            lines={["Counted from the logs below"]}
          />
        </div>
      </div>

      <UsageChart live={live} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Services services={stats?.services} />
        <Processes top={stats?.top} total={stats?.process_count} />
      </div>

      <Logs />
    </main>
  );
}
