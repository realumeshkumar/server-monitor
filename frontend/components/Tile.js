import { severity } from "../lib/format";

const BAR = { normal: "bg-fg/70", warn: "bg-warn", danger: "bg-danger" };
const NOTE = { warn: "High", danger: "Critical" };
const TEXT = { warn: "text-warn", danger: "text-danger" };

export function Card({ title, right, children, className = "" }) {
  return (
    <section className={`rounded-xl border border-border bg-surface ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** One headline number with an optional usage bar. */
export function Tile({ label, value, unit, percent, level: forced, lines = [] }) {
  // `level` lets a tile without a percentage (the error count) set its own colour.
  const level = forced ?? (percent == null ? "normal" : severity(percent));
  return (
    <div className="h-full rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="font-medium uppercase tracking-wide">{label}</span>
        {NOTE[level] && (
          <span className={level === "danger" ? "font-semibold text-danger" : "font-semibold text-warn"}>
            {NOTE[level]}
          </span>
        )}
      </div>
      <div className={`tabular mt-2 text-3xl font-semibold leading-none ${forced && forced !== "normal" ? TEXT[forced] : ""}`}>
        {value}
        {unit && <span className="ml-1 text-base font-normal text-muted">{unit}</span>}
      </div>
      {percent != null && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-label={label}
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${BAR[level]}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      )}
      <div className="tabular mt-3 space-y-0.5 text-xs text-muted">
        {lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    </div>
  );
}
