"""Server Monitor backend.

FastAPI + psutil. Pushes live metrics and log lines to the browser over
Server-Sent Events (SSE), keeps a short history in SQLite, and can send
Telegram alerts.

Run:  uvicorn main:app --host 127.0.0.1 --port 8010
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import sqlite3
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import psutil
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

load_dotenv(Path(__file__).with_name(".env"))


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
def env_list(key: str, default: str = "") -> list[str]:
    return [x.strip() for x in os.getenv(key, default).split(",") if x.strip()]


INTERVAL = float(os.getenv("SAMPLE_INTERVAL", "2"))
STORE_EVERY = int(os.getenv("STORE_EVERY", "10"))
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "7"))
DB_PATH = os.getenv("DB_PATH", str(Path(__file__).with_name("monitor.db")))
DISK_MOUNTS = env_list("DISK_MOUNTS", "/")
SERVICES = env_list("SERVICES", "nginx,mariadb,cloudflared")
PM2_ENABLED = os.getenv("PM2", "1") == "1"
JOURNAL = os.getenv("JOURNAL", "0") == "1"
CORS_ORIGINS = env_list("CORS_ORIGINS")
LOG_FILES = dict(
    item.split("=", 1)
    for item in env_list(
        "LOG_FILES",
        "nginx-error=/var/log/nginx/error.log,nginx-access=/var/log/nginx/access.log",
    )
    if "=" in item
)

TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT = os.getenv("TELEGRAM_CHAT_ID", "")
CPU_ALERT = float(os.getenv("CPU_ALERT", "90"))
MEM_ALERT = float(os.getenv("MEM_ALERT", "90"))
DISK_ALERT = float(os.getenv("DISK_ALERT", "90"))
ALERT_COOLDOWN = int(os.getenv("ALERT_COOLDOWN", "900"))

LOG_BUFFER = 300  # lines kept in memory for new viewers
LOG_BACKFILL = 40  # lines read from the end of each file at startup
HOSTNAME = socket.gethostname()


# --------------------------------------------------------------------------
# Shared state (everything runs on one event loop, so no locks needed)
# --------------------------------------------------------------------------
class State:
    latest: dict | None = None
    services: dict = {"systemd": [], "pm2": []}
    logs: deque = deque(maxlen=LOG_BUFFER)
    log_subscribers: set = set()
    # Start ids from the boot time so they stay unique across restarts.
    log_id: int = int(time.time() * 1000)
    error_times: deque = deque(maxlen=5000)
    alerted: dict = {}
    cpu_high_since: float | None = None
    db: sqlite3.Connection | None = None


state = State()


# --------------------------------------------------------------------------
# SQLite history
# --------------------------------------------------------------------------
def db_init() -> None:
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        """CREATE TABLE IF NOT EXISTS samples (
               ts INTEGER PRIMARY KEY,
               cpu REAL, mem REAL, swap REAL, disk REAL,
               load1 REAL, rx REAL, tx REAL, temp REAL
           )"""
    )
    db.commit()
    state.db = db


def db_store(s: dict) -> None:
    disk = s["disks"][0]["percent"] if s["disks"] else None
    state.db.execute(
        "INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?,?)",
        (
            int(s["ts"]),
            s["cpu"]["percent"],
            s["mem"]["percent"],
            s["swap"]["percent"],
            disk,
            s["cpu"]["load"][0],
            s["net"]["rx_rate"],
            s["net"]["tx_rate"],
            s["cpu"]["temp"],
        ),
    )
    state.db.commit()


def db_purge() -> None:
    cutoff = int(time.time()) - RETENTION_DAYS * 86400
    state.db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
    state.db.commit()


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------
_prev_net: tuple[float, int, int] | None = None


def read_temp() -> float | None:
    try:
        temps = psutil.sensors_temperatures()
    except Exception:
        return None
    for key in ("k10temp", "coretemp", "cpu_thermal", "acpitz"):
        if temps.get(key):
            return round(temps[key][0].current, 1)
    for readings in temps.values():
        if readings:
            return round(readings[0].current, 1)
    return None


def collect() -> dict:
    """Read one snapshot of the machine. Blocking, so it runs in a thread."""
    global _prev_net
    now = time.time()

    cores = psutil.cpu_percent(percpu=True)
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()

    net = psutil.net_io_counters()
    rx_rate = tx_rate = 0.0
    if _prev_net:
        dt = max(now - _prev_net[0], 0.001)
        rx_rate = max(net.bytes_recv - _prev_net[1], 0) / dt
        tx_rate = max(net.bytes_sent - _prev_net[2], 0) / dt
    _prev_net = (now, net.bytes_recv, net.bytes_sent)

    disks = []
    for mount in DISK_MOUNTS:
        try:
            u = psutil.disk_usage(mount)
            disks.append(
                {"mount": mount, "total": u.total, "used": u.used, "percent": u.percent}
            )
        except OSError:
            continue

    procs = []
    for p in psutil.process_iter(["pid", "name", "username", "memory_info"]):
        try:
            mem = p.info["memory_info"]
            procs.append(
                {
                    "pid": p.info["pid"],
                    "name": p.info["name"] or "?",
                    "user": p.info["username"] or "?",
                    "cpu": round(p.cpu_percent(None), 1),
                    "mem": mem.rss if mem else 0,
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    top = sorted(procs, key=lambda x: (x["cpu"], x["mem"]), reverse=True)[:8]

    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        load = [0.0, 0.0, 0.0]

    return {
        "ts": round(now, 2),
        "host": HOSTNAME,
        "uptime": int(now - psutil.boot_time()),
        "cpu": {
            "percent": round(sum(cores) / max(len(cores), 1), 1),
            "cores": cores,
            "count": len(cores),
            "load": load,
            "temp": read_temp(),
        },
        "mem": {
            "total": vm.total,
            "used": vm.total - vm.available,
            "available": vm.available,
            "percent": vm.percent,
        },
        "swap": {"total": sw.total, "used": sw.used, "percent": sw.percent},
        "disks": disks,
        "net": {"rx_rate": round(rx_rate), "tx_rate": round(tx_rate)},
        "top": top,
        "process_count": len(procs),
    }


def errors_last_5m() -> int:
    cutoff = time.time() - 300
    while state.error_times and state.error_times[0] < cutoff:
        state.error_times.popleft()
    return len(state.error_times)


async def sampler() -> None:
    psutil.cpu_percent(percpu=True)  # first call only primes the counters
    last_store = last_purge = 0.0
    while True:
        started = time.monotonic()
        try:
            snap = await asyncio.to_thread(collect)
            snap["errors_5m"] = errors_last_5m()
            snap["services"] = state.services
            state.latest = snap
            now = time.time()
            if now - last_store >= STORE_EVERY:
                db_store(snap)
                last_store = now
            if now - last_purge >= 3600:
                db_purge()
                last_purge = now
            await check_alerts(snap)
        except Exception as exc:  # keep the loop alive whatever happens
            print(f"[sampler] {exc!r}")
        await asyncio.sleep(max(0.2, INTERVAL - (time.monotonic() - started)))


# --------------------------------------------------------------------------
# Services: systemd units and PM2 apps
# --------------------------------------------------------------------------
async def run(*cmd: str, timeout: float = 8) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return out.decode(errors="replace")
    except (FileNotFoundError, asyncio.TimeoutError, OSError):
        return ""


async def read_services() -> dict:
    systemd = []
    if SERVICES:
        out = await run("systemctl", "is-active", *SERVICES)
        lines = out.split()
        for i, name in enumerate(SERVICES):
            systemd.append({"name": name, "status": lines[i] if i < len(lines) else "unknown"})

    pm2 = []
    if PM2_ENABLED:
        out = await run("pm2", "jlist")
        start = out.find("[")
        if start != -1:
            try:
                for app_ in json.loads(out[start:]):
                    env = app_.get("pm2_env", {})
                    monit = app_.get("monit", {})
                    pm2.append(
                        {
                            "name": app_.get("name"),
                            "status": env.get("status", "unknown"),
                            "cpu": monit.get("cpu", 0),
                            "mem": monit.get("memory", 0),
                            "restarts": env.get("restart_time", 0),
                            "uptime": int(time.time() - env.get("pm_uptime", 0) / 1000)
                            if env.get("status") == "online"
                            else 0,
                        }
                    )
            except (json.JSONDecodeError, TypeError):
                pass
    return {"systemd": systemd, "pm2": pm2}


async def services_loop() -> None:
    while True:
        try:
            state.services = await read_services()
            for s in state.services["systemd"]:
                if s["status"] not in ("active", "unknown"):
                    await notify(f"svc:{s['name']}", f"Service {s['name']} is {s['status']}")
            for a in state.services["pm2"]:
                if a["status"] != "online":
                    await notify(f"pm2:{a['name']}", f"PM2 app {a['name']} is {a['status']}")
        except Exception as exc:
            print(f"[services] {exc!r}")
        await asyncio.sleep(15)


# --------------------------------------------------------------------------
# Logs
# --------------------------------------------------------------------------
RE_ERROR = re.compile(r"\b(emerg|alert|crit(ical)?|error|fatal|exception|panic|failed)\b", re.I)
RE_WARN = re.compile(r"\b(warn(ing)?|notice|deprecated)\b", re.I)
RE_ACCESS = re.compile(r'" (\d{3}) (\d+|-)')


def classify(text: str) -> str:
    m = RE_ACCESS.search(text)
    if m:  # access-log line: decide from the HTTP status
        code = int(m.group(1))
        return "error" if code >= 500 else "warn" if code >= 400 else "info"
    if RE_ERROR.search(text):
        return "error"
    if RE_WARN.search(text):
        return "warn"
    return "info"


def publish(source: str, text: str, level: str | None = None, backfill: bool = False) -> None:
    text = text.rstrip()
    if not text:
        return
    state.log_id += 1
    entry = {
        "id": state.log_id,
        "ts": time.time(),
        "source": source,
        "level": level or classify(text),
        "text": text[:2000],
    }
    state.logs.append(entry)
    if entry["level"] == "error" and not backfill:
        state.error_times.append(entry["ts"])
    for q in list(state.log_subscribers):
        try:
            q.put_nowait(entry)
        except asyncio.QueueFull:
            pass  # slow viewer: drop the line instead of growing memory


async def tail_file(source: str, path: str) -> None:
    """Follow a log file like `tail -F`, surviving logrotate."""
    handle = None
    inode = None
    buf = ""
    first_open = True
    while True:
        try:
            if handle is None:
                handle = open(path, "r", errors="replace")
                inode = os.fstat(handle.fileno()).st_ino
                buf = ""
                if first_open:
                    size = os.fstat(handle.fileno()).st_size
                    handle.seek(max(0, size - 32_768))
                    tail = handle.read().split("\n")
                    if size > 32_768:
                        tail = tail[1:]  # first piece is a partial line
                    for line in tail[-LOG_BACKFILL:]:
                        publish(source, line, backfill=True)
                    first_open = False

            chunk = handle.read()
            if chunk:
                buf += chunk
                *lines, buf = buf.split("\n")
                for line in lines:
                    publish(source, line)
            else:
                st = os.stat(path)
                if st.st_ino != inode or st.st_size < handle.tell():
                    handle.close()  # rotated or truncated: reopen from the start
                    handle = None
                    continue
        except FileNotFoundError:
            handle = None
        except PermissionError:
            print(f"[logs] no permission to read {path} (add the user to group 'adm')")
            await asyncio.sleep(60)
        except Exception as exc:
            print(f"[logs] {path}: {exc!r}")
            handle = None
        await asyncio.sleep(1)


async def tail_journal() -> None:
    """Stream warnings and errors from every systemd service."""
    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "journalctl", "-f", "-n", "0", "-p", "warning", "-o", "json",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                limit=1024 * 1024,
            )
            async for raw in proc.stdout:
                try:
                    j = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                msg = j.get("MESSAGE")
                if not isinstance(msg, str):
                    continue
                unit = (j.get("_SYSTEMD_UNIT") or j.get("SYSLOG_IDENTIFIER") or "system")
                unit = unit.removesuffix(".service")
                if unit == "server-monitor":
                    continue  # do not echo our own output back
                level = "error" if int(j.get("PRIORITY", 6)) <= 3 else "warn"
                publish(f"journal:{unit}", msg, level)
            await proc.wait()
        except FileNotFoundError:
            return  # no journalctl on this machine
        except Exception as exc:
            print(f"[journal] {exc!r}")
        await asyncio.sleep(5)


# --------------------------------------------------------------------------
# Alerts
# --------------------------------------------------------------------------
async def notify(key: str, text: str) -> None:
    if not (TELEGRAM_TOKEN and TELEGRAM_CHAT):
        return
    now = time.time()
    if now - state.alerted.get(key, 0) < ALERT_COOLDOWN:
        return
    state.alerted[key] = now
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT, "text": f"[{HOSTNAME}] {text}"},
            )
    except httpx.HTTPError as exc:
        print(f"[alert] {exc!r}")


async def check_alerts(s: dict) -> None:
    # CPU must stay high for a full minute, so a short spike is not an alert.
    if s["cpu"]["percent"] >= CPU_ALERT:
        state.cpu_high_since = state.cpu_high_since or s["ts"]
        if s["ts"] - state.cpu_high_since >= 60:
            await notify("cpu", f"CPU at {s['cpu']['percent']}% for over a minute")
    else:
        state.cpu_high_since = None

    if s["mem"]["percent"] >= MEM_ALERT:
        await notify("mem", f"RAM at {s['mem']['percent']}%")
    for d in s["disks"]:
        if d["percent"] >= DISK_ALERT:
            await notify(f"disk:{d['mount']}", f"Disk {d['mount']} at {d['percent']}%")


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastAPI):
    db_init()
    tasks = [asyncio.create_task(sampler()), asyncio.create_task(services_loop())]
    tasks += [asyncio.create_task(tail_file(n, p)) for n, p in LOG_FILES.items()]
    if JOURNAL:
        tasks.append(asyncio.create_task(tail_journal()))
    yield
    for t in tasks:
        t.cancel()
    state.db.close()


app = FastAPI(title="Server Monitor", lifespan=lifespan)

if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET"], allow_headers=["*"]
    )

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",  # tells Nginx not to buffer the stream
}


def sse(data: dict, event_id: int | None = None) -> str:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}data: {json.dumps(data, separators=(',', ':'))}\n\n"


@app.get("/api/health")
async def health():
    return {"ok": True, "host": HOSTNAME}


@app.get("/api/stats")
async def stats():
    return state.latest or {}


@app.get("/api/stream")
async def stream():
    """Live metrics: one event every SAMPLE_INTERVAL seconds."""

    async def gen():
        last = None
        while True:
            snap = state.latest
            if snap and snap["ts"] != last:
                last = snap["ts"]
                yield sse(snap)
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.get("/api/history")
async def history(minutes: int = Query(60, ge=1, le=60 * 24 * 31)):
    """Past samples, averaged into at most ~300 points for the chart."""
    since = int(time.time()) - minutes * 60
    bucket = max(STORE_EVERY, (minutes * 60) // 300)
    rows = state.db.execute(
        """SELECT (ts / ?) * ? AS t, AVG(cpu), AVG(mem), AVG(swap), AVG(disk),
                  AVG(load1), AVG(rx), AVG(tx), AVG(temp)
           FROM samples WHERE ts >= ? GROUP BY t ORDER BY t""",
        (bucket, bucket, since),
    ).fetchall()
    keys = ("ts", "cpu", "mem", "swap", "disk", "load1", "rx", "tx", "temp")
    return [
        {k: (round(v, 1) if isinstance(v, float) else v) for k, v in zip(keys, row)}
        for row in rows
    ]


@app.get("/api/logs")
async def logs(limit: int = Query(200, ge=1, le=LOG_BUFFER)):
    return list(state.logs)[-limit:]


@app.get("/api/logs/sources")
async def log_sources():
    return sorted({e["source"] for e in state.logs} | set(LOG_FILES))


@app.get("/api/logs/stream")
async def logs_stream(request: Request):
    """Live log lines. Sends the recent buffer first, then new lines.

    The browser sends Last-Event-ID when it reconnects, so it only gets
    the lines it missed.
    """
    try:
        last_id = int(request.headers.get("last-event-id", "0"))
    except ValueError:
        last_id = 0

    async def gen():
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        state.log_subscribers.add(queue)
        try:
            for entry in list(state.logs):
                if entry["id"] > last_id:
                    yield sse(entry, entry["id"])
            while True:
                try:
                    entry = await asyncio.wait_for(queue.get(), timeout=15)
                    yield sse(entry, entry["id"])
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # keeps proxies from closing an idle stream
        finally:
            state.log_subscribers.discard(queue)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
