import os
import sys
import tempfile


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
        "checklists": [],
        "progress_logs": [],
        "project_messages": [],
        "history": [],
        "archives": [],
        "deleted_ids": {},
    }


client = server.app.test_client()
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

assert client.put("/api/workspace", json={"workspace": workspace_payload(), "revision": revision}).status_code == 403
assert client.put("/api/workspace", json={"workspace": workspace_payload(), "revision": revision}, headers=headers).status_code == 200
assert client.put("/api/workspace", json={"workspace": workspace_payload(), "revision": revision}, headers=headers).status_code == 409

server.login_attempts.clear()
limited_client = server.app.test_client()
for _ in range(server.LOGIN_ATTEMPT_LIMIT):
    assert limited_client.post("/api/login", json={"password": "wrong"}).status_code == 401
assert limited_client.post("/api/login", json={"password": "wrong"}).status_code == 429

print("server security tests: passed")
