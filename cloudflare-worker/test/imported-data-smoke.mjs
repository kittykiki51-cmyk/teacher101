import assert from "node:assert/strict";

const base = process.argv[2] || "http://127.0.0.1:8787";
const password = process.argv[3] || "local-test-only";
const login = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";", 1)[0];
const workspaceResponse = await fetch(`${base}/api/workspace`, { headers: { Cookie: cookie } });
assert.equal(workspaceResponse.status, 200);
const loaded = await workspaceResponse.json();
assert.equal(loaded.revision, 530);
assert.ok(loaded.workspace.projects.length > 0);
assert.ok(loaded.workspace.tasks.length > 0);
const statusResponse = await fetch(`${base}/api/migration/status`, { headers: { Cookie: cookie } });
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.backups, 30);
assert.equal(status.sent_notifications, 50);
assert.equal(status.subscriptions, 0);
console.log(JSON.stringify({
  revision: loaded.revision,
  projects: loaded.workspace.projects.length,
  tasks: loaded.workspace.tasks.length,
  calendar_events: loaded.workspace.calendar_events.length,
  backups: status.backups,
  sent_notifications: status.sent_notifications,
}));
