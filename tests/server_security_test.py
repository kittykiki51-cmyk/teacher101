import os
import sys
import tempfile
from datetime import datetime


os.environ["APP_PASSWORD"] = "audit-password"
os.environ["SECRET_KEY"] = "12345678901234567890123456789012"
os.environ["COOKIE_SECURE"] = "0"
os.environ["ENABLE_NOTIFICATION_WORKER"] = "0"
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="teacher101-security-")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import server  # noqa: E402


def workspace_payload() -> dict:
    return {
        "version": "test",
        "settings": {"monthly_goal": 2},
        "projects": [],
        "tasks": [],
        "calendar_events": [],
        "checklists": [],
        "progress_logs": [],
        "project_messages": [],
        "history": [],
        "archives": [],
        "deleted_ids": {},
    }


client = server.app.test_client()
for login_path in ("/login", "/login.css?v=29", "/login.js?v=29"):
    login_response = client.get(login_path)
    assert login_response.status_code == 200
    assert login_response.headers["Cache-Control"] == "no-store"
assert client.get("/api/workspace").status_code == 401
assert client.post("/api/login", json={"password": "audit-password"}).status_code == 200

loaded = client.get("/api/workspace").get_json()
revision = loaded["revision"]
csrf = loaded["csrf_token"]
headers = {"X-CSRF-Token": csrf}

assert client.put("/api/workspace", json={"workspace": {}, "revision": revision}, headers=headers).status_code == 400
assert client.put("/api/workspace", json={"workspace": workspace_payload(), "revision": "1"}, headers=headers).status_code == 400

broken = workspace_payload()
broken["projects"] = [None]
assert client.put("/api/workspace", json={"workspace": broken, "revision": revision}, headers=headers).status_code == 400

broken_nested = workspace_payload()
broken_nested["projects"] = [{"id": "project", "stages": [[]]}]
assert client.put("/api/workspace", json={"workspace": broken_nested, "revision": revision}, headers=headers).status_code == 400

assert client.put("/api/workspace", json={"workspace": workspace_payload(), "revision": revision}).status_code == 403
assert client.put("/api/workspace", json={"workspace": workspace_payload(), "revision": revision}, headers=headers).status_code == 200
assert client.put("/api/workspace", json={"workspace": workspace_payload(), "revision": revision}, headers=headers).status_code == 409

reminder_workspace = workspace_payload()
reminder_workspace["calendar_events"] = [
    {"id": "timed", "date": "2026-08-11", "time": "10:00", "all_day": False, "reminder_minutes": "10"},
    {"id": "all-day", "date": "2026-08-11", "all_day": True, "reminder_minutes": "0"},
]
timed_due = server.due_calendar_events(reminder_workspace, datetime(2026, 8, 11, 9, 50, tzinfo=server.APP_TIMEZONE))
all_day_due = server.due_calendar_events(reminder_workspace, datetime(2026, 8, 11, 9, 0, tzinfo=server.APP_TIMEZONE))
assert [item["id"] for item in timed_due] == ["timed"]
assert [item["id"] for item in all_day_due] == ["all-day"]
assert server.calendar_event_type_label({"event_type": "線上面試會議"}) == "線上面試會議"
assert server.calendar_event_type_label({"event_type": "會議"}) == "部門會議"

server.login_attempts.clear()
limited_client = server.app.test_client()
for _ in range(server.LOGIN_ATTEMPT_LIMIT):
    assert limited_client.post("/api/login", json={"password": "wrong"}).status_code == 401
assert limited_client.post("/api/login", json={"password": "wrong"}).status_code == 429

print("server security tests: passed")
