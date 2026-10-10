# Server Monitor

Live dashboard for a single Linux server: CPU, RAM, disk, network, systemd
services, PM2 apps, top processes and a live log viewer with error counts.

- `backend/`  FastAPI + psutil, live data over Server-Sent Events, 7 days of history in SQLite, optional Telegram alerts (port 8010)
- `frontend/` Next.js + Tailwind + Recharts (port 3006)
- `deploy/`   systemd unit and Nginx server block

## 1. Copy to the server

    /var/www/html/server-monitor/

## 2. Backend

    sudo apt install -y python3-venv
    cd /var/www/html/server-monitor/backend
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    cp .env.example .env
    nano .env          # set SERVICES, LOG_FILES, Telegram keys

Quick test:

    .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8010
    curl localhost:8010/api/stats

Run it as a service (edit the username inside the file first):

    sudo cp ../deploy/server-monitor.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now server-monitor
    journalctl -u server-monitor -f

## 3. Frontend

    cd /var/www/html/server-monitor/frontend
    npm install
    npm run build
    pm2 start npm --name server-monitor-web -- start
    pm2 save

In production leave `NEXT_PUBLIC_API_BASE` empty: Nginx serves `/api/` on the
same domain. For local development create `.env.local` with
`NEXT_PUBLIC_API_BASE=http://<server-ip>:8010`, add your dev origin to
`CORS_ORIGINS` in the backend `.env`, and run `npm run dev`.

## 4. Nginx and Cloudflare

    sudo cp deploy/nginx-monitor.conf /etc/nginx/sites-available/monitor.realumeshkumar.in
    sudo ln -s /etc/nginx/sites-available/monitor.realumeshkumar.in /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx

In Cloudflare Zero Trust:

1. Tunnels > your tunnel > Public hostname: add `monitor.realumeshkumar.in`
   pointing to the same Nginx address your main site uses.
2. Access > Applications > Add (self-hosted) for `monitor.realumeshkumar.in`
   with a policy that allows only your email.

**Do step 2 before sharing the URL.** The dashboard has no login of its own,
and it shows logs and process names. The backend only listens on 127.0.0.1,
so Cloudflare Access is the lock on the door.

## Telegram alerts

1. Message @BotFather, send `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`
   into `TELEGRAM_CHAT_ID`.
3. `sudo systemctl restart server-monitor`

Alerts fire when CPU stays above the limit for a minute, when RAM or disk
cross their limit, and when a watched service or PM2 app goes down. Each alert
repeats at most once per `ALERT_COOLDOWN` seconds.

## API

| Endpoint | What it returns |
|---|---|
| `GET /api/stats` | Latest snapshot (JSON) |
| `GET /api/stream` | Live snapshots (SSE) |
| `GET /api/history?minutes=60` | Averaged history for charts |
| `GET /api/logs?limit=200` | Recent log lines |
| `GET /api/logs/stream` | Live log lines (SSE, resumes with Last-Event-ID) |
| `GET /api/health` | Health check |

## Troubleshooting

- **Log panel empty for Nginx:** the service user needs group `adm` (already set in the unit file).
- **Magento logs not showing:** the service user must be able to read `var/log/*.log`.
- **PM2 apps missing:** the service must run as the user that owns PM2, and `PATH` in the unit file must include the folder from `which pm2`.
- **A service shows "unknown":** the unit name is wrong; check `systemctl list-units --type=service`.
- **Temp not available:** install `lm-sensors` and run `sudo sensors-detect`.
