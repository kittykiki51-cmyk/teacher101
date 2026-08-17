import assert from "node:assert/strict";

const base = process.argv[2] || "http://127.0.0.1:8787";
const password = process.argv[3] || "local-test-only";

async function request(path, options = {}) {
  return fetch(`${base}${path}`, { redirect: "manual", ...options });
}

const health = await request("/health");
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: "ok" });
assert.equal(health.headers.get("x-frame-options"), "DENY");

const rootBeforeLogin = await request("/");
assert.equal(rootBeforeLogin.status, 302);
assert.equal(rootBeforeLogin.headers.get("location"), "/login");

const wrongLogin = await request("/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: "wrong" }),
});
assert.equal(wrongLogin.status, 401);

const login = await request("/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";", 1)[0];
assert.ok(cookie.startsWith("__Host-teacher_session="));

const app = await request("/", { headers: { Cookie: cookie } });
assert.equal(app.status, 200);
assert.ok((await app.text()).includes("老師專案管理"));

const workspaceResponse = await request("/api/workspace", { headers: { Cookie: cookie } });
assert.equal(workspaceResponse.status, 200);
const loaded = await workspaceResponse.json();
assert.equal(typeof loaded.revision, "number");
assert.equal(typeof loaded.csrf_token, "string");

const rejectedWithoutCsrf = await request("/api/workspace", {
  method: "PUT",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ workspace: loaded.workspace, revision: loaded.revision }),
});
assert.equal(rejectedWithoutCsrf.status, 403);

const invalidWorkspace = await request("/api/workspace", {
  method: "PUT",
  headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loaded.csrf_token },
  body: JSON.stringify({ workspace: {}, revision: loaded.revision }),
});
assert.equal(invalidWorkspace.status, 400);

const saved = await request("/api/workspace", {
  method: "PUT",
  headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loaded.csrf_token },
  body: JSON.stringify({ workspace: loaded.workspace, revision: loaded.revision }),
});
assert.equal(saved.status, 200);
const savedBody = await saved.json();
assert.equal(savedBody.revision, loaded.revision + 1);

const conflict = await request("/api/workspace", {
  method: "PUT",
  headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": loaded.csrf_token },
  body: JSON.stringify({ workspace: loaded.workspace, revision: loaded.revision }),
});
assert.equal(conflict.status, 409);

const pushConfig = await request("/api/push/config", { headers: { Cookie: cookie } });
assert.equal(pushConfig.status, 200);
assert.equal((await pushConfig.json()).enabled, false);

const logout = await request("/api/logout", {
  method: "POST",
  headers: { Cookie: cookie, "X-CSRF-Token": loaded.csrf_token },
});
assert.equal(logout.status, 200);
assert.ok(logout.headers.get("set-cookie").includes("Max-Age=0"));

console.log("local Worker integration: passed");
