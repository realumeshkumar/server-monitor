import { bytes, duration } from "../lib/format";
import { Card } from "./Tile";

const GOOD = new Set(["active", "online"]);

function Status({ value }) {
  const good = GOOD.has(value);
  const unknown = value === "unknown";
  const tone = good ? "text-ok" : unknown ? "text-muted" : "text-danger";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone}`}>
      <span className="h-2 w-2 rounded-full bg-current" aria-hidden />
      {value}
    </span>
  );
}

export function Services({ services }) {
  const systemd = services?.systemd ?? [];
  const pm2 = services?.pm2 ?? [];
  const empty = !systemd.length && !pm2.length;
  return (
    <Card title="Services">
      {empty && <p className="px-4 py-6 text-sm text-muted">No services configured yet.</p>}
      <ul className="divide-y divide-border text-sm">
        {systemd.map((s) => (
          <li key={`s-${s.name}`} className="flex items-center justify-between px-4 py-2.5">
            <span>
              {s.name} <span className="text-xs text-muted">systemd</span>
            </span>
            <Status value={s.status} />
          </li>
        ))}
        {pm2.map((a) => (
          <li key={`p-${a.name}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="min-w-0">
              <span className="block truncate">
                {a.name} <span className="text-xs text-muted">PM2</span>
              </span>
              <span className="tabular block text-xs text-muted">
                {bytes(a.mem)} · up {duration(a.uptime)} · {a.restarts} restarts
              </span>
            </span>
            <Status value={a.status} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Processes({ top = [], total }) {
  return (
    <Card title="Top processes" right={<span className="text-xs text-muted">{total ?? 0} running</span>}>
      <div className="overflow-x-auto">
        <table className="tabular w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Process</th>
              <th className="px-2 py-2 font-medium">User</th>
              <th className="px-2 py-2 text-right font-medium">CPU</th>
              <th className="px-4 py-2 text-right font-medium">RAM</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {top.map((p) => (
              <tr key={p.pid}>
                <td className="max-w-40 truncate px-4 py-2">
                  {p.name} <span className="text-xs text-muted">{p.pid}</span>
                </td>
                <td className="px-2 py-2 text-muted">{p.user}</td>
                <td className="px-2 py-2 text-right">{p.cpu.toFixed(1)}%</td>
                <td className="px-4 py-2 text-right">{bytes(p.mem)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
