from __future__ import annotations

import hmac
import base64
import ipaddress
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from flask import Flask, abort, jsonify, redirect, request, send_from_directory, session, url_for


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(
    os.environ.get("DATA_DIR")
    or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
    or BASE_DIR / "cloud-data"
).expanduser()
DATABASE_PATH = DATA_DIR / "teacher_operations.sqlite3"
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") != "0"
APP_TIMEZONE = ZoneInfo(os.environ.get("APP_TIMEZONE", "Asia/Taipei"))

if not APP_PASSWORD:
    raise RuntimeError("APP_PASSWORD 環境變數尚未設定。")
if len(SECRET_KEY) < 32:
    raise RuntimeError("SECRET_KEY 必須是至少 32 字元的隨機字串。")

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=None)
app.secret_key = SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    SESSION_COOKIE_SECURE=COOKIE_SECURE,
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
)

LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_ATTEMPT_LIMIT = 8
MAX_TRACKED_LOGIN_CLIENTS = 2048
WORKSPACE_LIST_FIELDS = (
    "projects", "tasks", "checklists", "progress_logs",
    "project_messages", "history", "archives",
)

login_attempts: dict[str, list[float]] = {}
login_attempts_lock = threading.Lock()
save_lock = threading.Lock()
_vapid_cache: tuple[str, str] | None = None


def database() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    return connection


def initial_workspace() -> dict[str, Any]:
    initial_file = BASE_DIR / "initial-data.js"
    if not initial_file.exists():
        return {
            "version": "cloud-1",
            "settings": {"monthly_goal": 2},
            "projects": [],
            "tasks": [],
            "checklists": [],
            "progress_logs": [],
            "project_messages": [],
            "history": [],
            "archives": [],
            "deleted_ids": {},
        }
    source = initial_file.read_text(encoding="utf-8").strip()
    prefix = "window.INITIAL_WORKSPACE ="
    if not source.startswith(prefix):
        raise RuntimeError("initial-data.js 格式不正確。")
    payload = source[len(prefix):].strip()
    if payload.endswith(";"):
        payload = payload[:-1]
    return json.loads(payload)


def initialize_database() -> None:
    with database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS workspace (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                revision INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workspace_backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                revision INTEGER NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                endpoint TEXT PRIMARY KEY,
                subscription TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sent_notifications (
                notification_key TEXT PRIMARY KEY,
                sent_at TEXT NOT NULL
            );
            """
        )
        existing = connection.execute("SELECT id FROM workspace WHERE id = 1").fetchone()
        if not existing:
            now = datetime.now().isoformat(timespec="seconds")
            connection.execute(
                "INSERT INTO workspace (id, revision, payload, updated_at) VALUES (1, 1, ?, ?)",
                (json.dumps(initial_workspace(), ensure_ascii=False), now),
            )


def vapid_keys() -> tuple[str, str]:
    global _vapid_cache
    if _vapid_cache:
        return _vapid_cache
    public_key = os.environ.get("VAPID_PUBLIC_KEY", "")
    private_key = os.environ.get("VAPID_PRIVATE_KEY", "")
    if public_key and private_key:
        _vapid_cache = public_key, private_key
        return _vapid_cache

    key_file = DATA_DIR / "vapid-keys.json"
    if key_file.exists():
        saved = json.loads(key_file.read_text(encoding="utf-8"))
        _vapid_cache = saved["public_key"], saved["private_key"]
        return _vapid_cache

    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid

    def base64url(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")

    vapid = Vapid()
    vapid.generate_keys()
    private_der = vapid.private_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_raw = vapid.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    _vapid_cache = base64url(public_raw), base64url(private_der)
    key_file.write_text(json.dumps({"public_key": _vapid_cache[0], "private_key": _vapid_cache[1]}), encoding="utf-8")
    key_file.chmod(0o600)
    return _vapid_cache


def authenticated() -> bool:
    return bool(session.get("authenticated"))


def require_auth(view: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(view)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        if not authenticated():
            if request.path.startswith("/api/"):
                return jsonify({"error": "尚未登入"}), 401
            return redirect(url_for("login_page"))
        return view(*args, **kwargs)

    return wrapped


def csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def require_csrf() -> None:
    supplied = request.headers.get("X-CSRF-Token", "")
    if not supplied or not hmac.compare_digest(supplied, str(session.get("csrf_token", ""))):
        abort(403, description="CSRF 驗證失敗")


def login_client_key() -> str:
    # Railway sets X-Real-IP at its trusted edge. Do not trust client-supplied
    # X-Forwarded-For for authentication rate limits.
    for raw in (request.headers.get("X-Real-IP", ""), request.remote_addr or ""):
        candidate = raw.split(",", 1)[0].strip()
        try:
            return ipaddress.ip_address(candidate).compressed
        except ValueError:
            continue
    return "unknown"


def prune_login_attempts(now: float) -> None:
    for client, stamps in list(login_attempts.items()):
        recent = [stamp for stamp in stamps if now - stamp < LOGIN_WINDOW_SECONDS]
        if recent:
            login_attempts[client] = recent
        else:
            login_attempts.pop(client, None)

    overflow = len(login_attempts) - MAX_TRACKED_LOGIN_CLIENTS
    if overflow > 0:
        oldest = sorted(login_attempts, key=lambda client: login_attempts[client][-1])[:overflow]
        for client in oldest:
            login_attempts.pop(client, None)


def login_is_rate_limited(client: str) -> bool:
    now = time.time()
    with login_attempts_lock:
        prune_login_attempts(now)
        return len(login_attempts.get(client, [])) >= LOGIN_ATTEMPT_LIMIT


def record_failed_login(client: str) -> None:
    now = time.time()
    with login_attempts_lock:
        prune_login_attempts(now)
        if client not in login_attempts and len(login_attempts) >= MAX_TRACKED_LOGIN_CLIENTS:
            oldest = min(login_attempts, key=lambda key: login_attempts[key][-1])
            login_attempts.pop(oldest, None)
        login_attempts.setdefault(client, []).append(now)


def clear_failed_logins(client: str) -> None:
    with login_attempts_lock:
        login_attempts.pop(client, None)


def workspace_payload_is_valid(workspace: Any) -> bool:
    def record_list(value: Any) -> bool:
        return isinstance(value, list) and all(isinstance(item, dict) for item in value)

    if not isinstance(workspace, dict):
        return False
    if not isinstance(workspace.get("settings"), dict) or not isinstance(workspace.get("deleted_ids"), dict):
        return False
    for field in WORKSPACE_LIST_FIELDS:
        items = workspace.get(field)
        if not record_list(items):
            return False
    if any("stages" in project and not record_list(project["stages"]) for project in workspace["projects"]):
        return False
    if any("items" in group and not record_list(group["items"]) for group in workspace["checklists"]):
        return False
    templates = workspace.get("checklist_templates")
    if templates is not None:
        if not record_list(templates):
            return False
        for template in templates:
            sections = template.get("sections")
            if not record_list(sections) or any(not record_list(section.get("items")) for section in sections):
                return False
    archive_fields = WORKSPACE_LIST_FIELDS[:-1]
    if any(
        field in archive and not record_list(archive[field])
        for archive in workspace["archives"]
        for field in archive_fields
    ):
        return False
    return True


@app.after_request
def security_headers(response: Any) -> Any:
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
        "form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
        "worker-src 'self'; manifest-src 'self'"
    )
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cache-Control"] = "no-store" if request.path.startswith("/api/") or request.path == "/login" else "no-cache"
    return response


@app.get("/login")
def login_page() -> Any:
    if authenticated():
        return redirect(url_for("home"))
    return send_from_directory(BASE_DIR, "login.html")


@app.get("/health")
def health() -> Any:
    return jsonify({"status": "ok"})


@app.get("/ready")
def ready() -> Any:
    try:
        with database() as connection:
            connection.execute("SELECT 1").fetchone()
        return jsonify({"status": "ok"})
    except sqlite3.Error:
        return jsonify({"status": "error"}), 503


@app.post("/api/login")
def login() -> Any:
    client = login_client_key()
    if login_is_rate_limited(client):
        return jsonify({"error": "嘗試次數過多，請 15 分鐘後再試。"}), 429, {"Retry-After": str(LOGIN_WINDOW_SECONDS)}
    supplied = str((request.get_json(silent=True) or {}).get("password", ""))
    if not hmac.compare_digest(supplied, APP_PASSWORD):
        record_failed_login(client)
        return jsonify({"error": "密碼不正確"}), 401
    clear_failed_logins(client)
    session.clear()
    session.permanent = True
    session["authenticated"] = True
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"ok": True})


@app.post("/api/logout")
@require_auth
def logout() -> Any:
    require_csrf()
    session.clear()
    return jsonify({"ok": True})


@app.get("/")
@require_auth
def home() -> Any:
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:filename>")
def public_asset(filename: str) -> Any:
    allowed = {
        "styles.css", "app.js", "manifest.json", "service-worker.js", "login.css", "login.js",
        "app-icon.svg", "app-icon-192.png", "app-icon-512.png",
        "icon-house.svg", "icon-folders.svg", "icon-calendar-days.svg", "icon-settings.svg",
    }
    if filename not in allowed:
        abort(404)
    public_without_auth = {
        "login.css", "login.js", "app-icon.svg", "app-icon-192.png", "app-icon-512.png",
    }
    if filename not in public_without_auth and not authenticated():
        return redirect(url_for("login_page"))
    return send_from_directory(BASE_DIR, filename)


@app.get("/api/workspace")
@require_auth
def get_workspace() -> Any:
    with database() as connection:
        row = connection.execute("SELECT revision, payload, updated_at FROM workspace WHERE id = 1").fetchone()
    return jsonify({"workspace": json.loads(row["payload"]), "revision": row["revision"], "updated_at": row["updated_at"], "csrf_token": csrf_token()})


@app.put("/api/workspace")
@require_auth
def put_workspace() -> Any:
    require_csrf()
    body = request.get_json(silent=True) or {}
    workspace = body.get("workspace")
    expected_revision = body.get("revision")
    if not workspace_payload_is_valid(workspace) or not isinstance(expected_revision, int) or isinstance(expected_revision, bool):
        return jsonify({"error": "workspace 資料格式不正確"}), 400
    payload = json.dumps(workspace, ensure_ascii=False, separators=(",", ":"))
    now = datetime.now().isoformat(timespec="seconds")
    with save_lock, database() as connection:
        row = connection.execute("SELECT revision, payload FROM workspace WHERE id = 1").fetchone()
        if expected_revision != row["revision"]:
            return jsonify({"error": "資料已在其他裝置更新", "revision": row["revision"]}), 409
        new_revision = row["revision"] + 1
        connection.execute(
            "INSERT INTO workspace_backups (revision, payload, created_at) VALUES (?, ?, ?)",
            (row["revision"], row["payload"], now),
        )
        connection.execute(
            "DELETE FROM workspace_backups WHERE id NOT IN (SELECT id FROM workspace_backups ORDER BY id DESC LIMIT 30)"
        )
        connection.execute(
            "UPDATE workspace SET revision = ?, payload = ?, updated_at = ? WHERE id = 1",
            (new_revision, payload, now),
        )
    return jsonify({"ok": True, "revision": new_revision, "updated_at": now})


@app.get("/api/push/config")
@require_auth
def push_config() -> Any:
    public_key, private_key = vapid_keys()
    return jsonify({"enabled": bool(public_key and private_key), "public_key": public_key, "csrf_token": csrf_token()})


@app.post("/api/push/subscribe")
@require_auth
def push_subscribe() -> Any:
    require_csrf()
    subscription = request.get_json(silent=True) or {}
    endpoint = str(subscription.get("endpoint", ""))
    if not endpoint.startswith("https://"):
        return jsonify({"error": "推播訂閱格式不正確"}), 400
    now = datetime.now().isoformat(timespec="seconds")
    with database() as connection:
        connection.execute(
            "INSERT INTO push_subscriptions (endpoint, subscription, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription, user_agent=excluded.user_agent, updated_at=excluded.updated_at",
            (endpoint, json.dumps(subscription), request.user_agent.string[:500], now, now),
        )
    return jsonify({"ok": True})


@app.delete("/api/push/subscribe")
@require_auth
def push_unsubscribe() -> Any:
    require_csrf()
    body = request.get_json(silent=True) or {}
    endpoint = str(body.get("endpoint", ""))
    if not endpoint.startswith("https://") or len(endpoint) > 4096:
        return jsonify({"error": "推播訂閱格式不正確"}), 400
    with database() as connection:
        connection.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    return jsonify({"ok": True})


def due_tasks(workspace: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    due: list[dict[str, Any]] = []
    current_minute = now.replace(second=0, microsecond=0)
    for task in workspace.get("tasks", []):
        if task.get("status") == "已完成":
            continue
        snooze_until = str(task.get("snooze_until", ""))[:16]
        if snooze_until:
            try:
                if datetime.fromisoformat(snooze_until).replace(tzinfo=APP_TIMEZONE) == current_minute:
                    due.append(task)
                continue
            except ValueError:
                pass
        if not task.get("date") or not task.get("time"):
            continue
        reminder = task.get("reminder_minutes")
        if reminder in {None, ""}:
            continue
        try:
            scheduled = datetime.strptime(
                f"{str(task['date'])[:10]} {str(task['time'])[:5]}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=APP_TIMEZONE)
            reminder_at = scheduled - timedelta(minutes=max(0, int(reminder)))
        except (TypeError, ValueError):
            continue
        if reminder_at == current_minute:
            due.append(task)
    return due


def send_push_notifications() -> None:
    public_key, private_key = vapid_keys()
    contact = os.environ.get("VAPID_CONTACT", "mailto:admin@example.com")
    if not public_key or not private_key:
        return
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        return

    now = datetime.now(APP_TIMEZONE)
    with database() as connection:
        row = connection.execute("SELECT payload FROM workspace WHERE id = 1").fetchone()
        workspace = json.loads(row["payload"])
        subscriptions = connection.execute("SELECT endpoint, subscription FROM push_subscriptions").fetchall()
        projects = {project.get("id"): project for project in workspace.get("projects", [])}
        for task in due_tasks(workspace, now):
            key = f"{task.get('id')}:{task.get('snooze_until') or task.get('date')}:{str(task.get('time', ''))[:5]}:{task.get('reminder_minutes', '')}"
            if connection.execute("SELECT 1 FROM sent_notifications WHERE notification_key = ?", (key,)).fetchone():
                continue
            project = projects.get(task.get("project_id"), {})
            message = json.dumps({
                "title": "老師專案管理提醒",
                "body": f"{project.get('course', '我的工作')}｜{task.get('title', '工作時間到了')}",
                "url": "/",
                "tag": key,
                "task_id": task.get("id", ""),
            }, ensure_ascii=False)
            delivered = False
            for subscription in subscriptions:
                try:
                    webpush(
                        subscription_info=json.loads(subscription["subscription"]),
                        data=message,
                        vapid_private_key=private_key,
                        vapid_claims={"sub": contact},
                    )
                    delivered = True
                except WebPushException as error:
                    status = getattr(getattr(error, "response", None), "status_code", None)
                    if status in {404, 410}:
                        connection.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (subscription["endpoint"],))
            if delivered:
                connection.execute(
                    "INSERT OR IGNORE INTO sent_notifications (notification_key, sent_at) VALUES (?, ?)",
                    (key, now.isoformat(timespec="seconds")),
                )


def notification_loop() -> None:
    while True:
        try:
            send_push_notifications()
        except Exception:
            app.logger.exception("定時推播檢查失敗")
        time.sleep(20)


initialize_database()

if os.environ.get("ENABLE_NOTIFICATION_WORKER", "1") == "1":
    threading.Thread(target=notification_loop, daemon=True, name="notification-worker").start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)
