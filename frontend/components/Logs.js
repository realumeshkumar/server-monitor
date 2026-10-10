"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { API, clock } from "../lib/format";
import { useEventSource } from "../lib/useEventSource";
import { Card } from "./Tile";

const MAX_LINES = 500;
const LEVELS = [
  { key: "all", label: "All" },
  { key: "error", label: "Errors" },
  { key: "warn", label: "Warnings" },
];
const LEVEL_STYLE = {
  error: "text-danger",
  warn: "text-warn",
  info: "text-muted",
};
const LEVEL_LABEL = { error: "ERROR", warn: "WARN", info: "INFO" };

export default function Logs() {
  const [lines, setLines] = useState([]);
  const [level, setLevel] = useState("all");
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);

  // Lines can arrive in bursts, so collect them and update the screen
  // a few times a second instead of once per line.
  const incoming = useRef([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const status = useEventSource(`${API}/api/logs/stream`, (entry) => incoming.current.push(entry));

  useEffect(() => {
    const timer = setInterval(() => {
      if (pausedRef.current || !incoming.current.length) return;
      const batch = incoming.current;
      incoming.current = [];
      setLines((prev) => [...prev, ...batch].slice(-MAX_LINES));
    }, 300);
    return () => clearInterval(timer);
  }, []);

  const sources = useMemo(() => [...new Set(lines.map((l) => l.source))].sort(), [lines]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (level === "all" || l.level === level) &&
        (source === "all" || l.source === source) &&
        (!q || l.text.toLowerCase().includes(q)),
    );
  }, [lines, level, source, query]);

  // Stay at the bottom unless the reader has scrolled up to look at something.
  const box = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [visible]);

  const controls = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
        {LEVELS.map((l) => (
          <button
            key={l.key}
            onClick={() => setLevel(l.key)}
            aria-pressed={level === l.key}
            className={`rounded-md px-2.5 py-1 font-medium ${
              level === l.key ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <select
        value={source}
        onChange={(e) => setSource(e.target.value)}
        aria-label="Log source"
        className="rounded-lg border border-border bg-surface px-2 py-1.5"
      >
        <option value="all">All sources</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search logs"
        aria-label="Search logs"
        className="w-36 rounded-lg border border-border bg-surface px-2 py-1.5 placeholder:text-muted"
      />
      <button
        onClick={() => setPaused((p) => !p)}
        aria-pressed={paused}
        className="rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2"
      >
        {paused ? "Resume" : "Pause"}
      </button>
      <button
        onClick={() => setLines([])}
        className="rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2"
      >
        Clear
      </button>
    </div>
  );

  return (
    <Card title="Logs" right={controls}>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-[26rem] overflow-y-auto px-4 py-2 font-mono text-xs leading-5"
        aria-live="off"
      >
        {visible.length === 0 ? (
          <p className="py-8 text-center font-sans text-sm text-muted">
            {lines.length === 0
              ? status === "live"
                ? "No log lines yet. New lines show up here as they are written."
                : "Connecting to the log stream."
              : "No lines match these filters."}
          </p>
        ) : (
          visible.map((l) => (
            <div key={l.id} className="flex gap-3 border-b border-border/50 py-0.5 last:border-0">
              <span className="tabular shrink-0 text-muted">{clock(l.ts)}</span>
              <span className={`w-11 shrink-0 font-semibold ${LEVEL_STYLE[l.level]}`}>{LEVEL_LABEL[l.level]}</span>
              <span className="hidden w-32 shrink-0 truncate text-muted sm:block" title={l.source}>
                {l.source}
              </span>
              <span className={`min-w-0 break-all ${l.level === "info" ? "" : LEVEL_STYLE[l.level]}`}>{l.text}</span>
            </div>
          ))
        )}
      </div>
      <footer className="tabular border-t border-border px-4 py-2 text-xs text-muted">
        Showing {visible.length} of {lines.length} lines
        {paused && " · paused, new lines are waiting"}
      </footer>
    </Card>
  );
}
