import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_SECONDS,
  clientKey,
  createSession,
  csrfMatches,
  expiredSessionCookie,
  readSession,
  sessionCookie,
  verifyPassword,
} from "./security.js";
import { sendDueNotifications } from "./notifications.js";
import { workspacePayloadIsValid } from "./workspace.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PUBLIC_ASSETS = new Set(["login.css", "login.js", "app-icon.svg", "app-icon-192.png", "app-icon-512.png"]);
const PROTECTED_ASSETS = new Set([
  "styles.css",
  "app.js",
  "manifest.json",
  "service-worker.js",
  "icon-house.svg",
  "icon-folders.svg",
  "icon-calendar-days.svg",
  "icon-settings.svg",
]);

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function responseWithHeaders(response, cacheControl = "no-cache") {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function redirect(location, status = 302, extraHeaders = {}) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", ...extraHeaders });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(null, { status, headers });
}

async function requestJson(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Response(JSON.stringify({ error: "資料超過 8 MB 限制" }), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Response(JSON.stringify({ error: "資料超過 8 MB 限制" }), { status: 413 });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Response(JSON.stringify({ error: "JSON 格式不正確" }), { status: 400 });
  }
}

async function asset(env, request, pathname, cacheControl = "no-cache") {
  const url = new URL(request.url);
  url.pathname = pathname;
  const assetRequest = new Request(url, { method: request.method, headers: request.headers });
  return responseWithHeaders(await env.ASSETS.fetch(assetRequest), cacheControl);
}

async function authenticatedSession(request, env) {
  return readSession(request, env.SESSION_SECRET);
}

async function requireSession(request, env) {
  const session = await authenticatedSession(request, env);
  if (!session) return { error: json({ error: "尚未登入" }, 401) };
  return { session };
}

async function login(request, env) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - LOGIN_WINDOW_SECONDS;
  const key = await clientKey(request, env.SESSION_SECRET);
  await env.DB.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").bind(cutoff).run();
  const attemptRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM login_attempts WHERE client_key = ? AND attempted_at >= ?",
  ).bind(key, cutoff).first();
  if (Number(attemptRow?.count || 0) >= LOGIN_ATTEMPT_LIMIT) {
    return json({ error: "嘗試次數過多，請 15 分鐘後再試。" }, 429, { "Retry-After": String(LOGIN_WINDOW_SECONDS) });
  }
  const body = await requestJson(request);
  if (!await verifyPassword(String(body.password || ""), env.APP_PASSWORD_HASH)) {
    await env.DB.prepare("INSERT INTO login_attempts (client_key, attempted_at) VALUES (?, ?)").bind(key, now).run();
    return json({ error: "密碼不正確" }, 401);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE client_key = ?").bind(key).run();
  const token = await createSession(env.SESSION_SECRET, now);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function getWorkspace(request, env) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  const row = await env.DB.prepare("SELECT revision, payload, updated_at FROM workspace WHERE id = 1").first();
  if (!row) return json({ error: "雲端工作資料尚未初始化" }, 503);
  return json({
    workspace: JSON.parse(row.payload),
    revision: row.revision,
    updated_at: row.updated_at,
    csrf_token: auth.session.csrf,
  });
}

async function putWorkspace(request, env) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  if (!csrfMatches(request, auth.session)) return json({ error: "CSRF 驗證失敗" }, 403);
  const body = await requestJson(request);
  if (!workspacePayloadIsValid(body.workspace) || !Number.isInteger(body.revision)) {
    return json({ error: "workspace 資料格式不正確" }, 400);
  }
  const current = await env.DB.prepare("SELECT revision, payload FROM workspace WHERE id = 1").first();
  if (!current) return json({ error: "雲端工作資料尚未初始化" }, 503);
  if (current.revision !== body.revision) return json({ error: "資料已在其他裝置更新", revision: current.revision }, 409);
  const now = new Date().toISOString().slice(0, 19);
  const payload = JSON.stringify(body.workspace);
  const newRevision = current.revision + 1;
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_backups (revision, payload, created_at) VALUES (?, ?, ?)")
      .bind(current.revision, current.payload, now),
    env.DB.prepare("UPDATE workspace SET revision = ?, payload = ?, updated_at = ? WHERE id = 1 AND revision = ?")
      .bind(newRevision, payload, now, current.revision),
    env.DB.prepare("DELETE FROM workspace_backups WHERE id NOT IN (SELECT id FROM workspace_backups ORDER BY id DESC LIMIT 30)"),
  ]);
  if (Number(results[1]?.meta?.changes || 0) !== 1) {
    const latest = await env.DB.prepare("SELECT revision FROM workspace WHERE id = 1").first();
    return json({ error: "資料已在其他裝置更新", revision: latest?.revision }, 409);
  }
  return json({ ok: true, revision: newRevision, updated_at: now });
}

async function pushConfig(request, env) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  return json({ enabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), public_key: env.VAPID_PUBLIC_KEY || "", csrf_token: auth.session.csrf });
}

async function subscribePush(request, env) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  if (!csrfMatches(request, auth.session)) return json({ error: "CSRF 驗證失敗" }, 403);
  const subscription = await requestJson(request);
  const endpoint = String(subscription.endpoint || "");
  if (!endpoint.startsWith("https://") || endpoint.length > 4096 || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return json({ error: "推播訂閱格式不正確" }, 400);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, subscription, user_agent, created_at, updated_at, disabled_at) VALUES (?, ?, ?, ?, ?, '') "
      + "ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription, user_agent=excluded.user_agent, updated_at=excluded.updated_at, disabled_at=''",
  ).bind(endpoint, JSON.stringify(subscription), String(request.headers.get("User-Agent") || "").slice(0, 500), now, now).run();
  return json({ ok: true });
}

async function unsubscribePush(request, env) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  if (!csrfMatches(request, auth.session)) return json({ error: "CSRF 驗證失敗" }, 403);
  const body = await requestJson(request);
  const endpoint = String(body.endpoint || "");
  if (!endpoint.startsWith("https://") || endpoint.length > 4096) return json({ error: "推播訂閱格式不正確" }, 400);
  await env.DB.prepare("UPDATE push_subscriptions SET disabled_at = ?, updated_at = ? WHERE endpoint = ?")
    .bind(new Date().toISOString(), new Date().toISOString(), endpoint)
    .run();
  return json({ ok: true });
}

function migrationEnabled(env) {
  return env.MIGRATION_MODE === "1";
}

function migrationTokenMatches(request, env) {
  const supplied = request.headers.get("X-Migration-Token") || "";
  const expected = String(env.MIGRATION_TOKEN || "");
  if (expected.length < 48 || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function requireMigrationSession(request, env) {
  if (!migrationEnabled(env)) return { error: json({ error: "資料遷移功能未開啟" }, 404) };
  if (migrationTokenMatches(request, env)) return { migration_token: true };
  const auth = await requireSession(request, env);
  if (auth.error) return auth;
  if (!csrfMatches(request, auth.session)) return { error: json({ error: "CSRF 驗證失敗" }, 403) };
  return auth;
}

function workspaceIsEmpty(workspace) {
  if (!workspace || typeof workspace !== "object") return false;
  return ["projects", "tasks", "calendar_events", "checklists", "progress_logs", "project_messages", "history", "archives"]
    .every((field) => Array.isArray(workspace[field]) && workspace[field].length === 0);
}

async function migrateWorkspace(request, env) {
  const auth = await requireMigrationSession(request, env);
  if (auth.error) return auth.error;
  const body = await requestJson(request);
  if (!workspacePayloadIsValid(body.workspace) || !Number.isInteger(body.revision) || body.revision < 1 || typeof body.updated_at !== "string") {
    return json({ error: "遷移工作資料格式不正確" }, 400);
  }
  const current = await env.DB.prepare("SELECT revision, payload FROM workspace WHERE id = 1").first();
  if (!current || !workspaceIsEmpty(JSON.parse(current.payload))) {
    return json({ error: "目標 D1 已有正式資料，為避免覆寫已停止遷移" }, 409);
  }
  await env.DB.prepare("UPDATE workspace SET revision = ?, payload = ?, updated_at = ? WHERE id = 1")
    .bind(body.revision, JSON.stringify(body.workspace), body.updated_at.slice(0, 32))
    .run();
  return json({ ok: true, revision: body.revision });
}

async function migrateBackup(request, env) {
  const auth = await requireMigrationSession(request, env);
  if (auth.error) return auth.error;
  const body = await requestJson(request);
  if (!Number.isInteger(body.id) || body.id < 1 || !Number.isInteger(body.revision) || body.revision < 1
      || !workspacePayloadIsValid(body.workspace) || typeof body.created_at !== "string") {
    return json({ error: "遷移備份格式不正確" }, 400);
  }
  const current = await env.DB.prepare("SELECT revision FROM workspace WHERE id = 1").first();
  if (!current || body.revision >= current.revision) return json({ error: "備份版本不可高於目前工作資料" }, 400);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO workspace_backups (id, revision, payload, created_at) VALUES (?, ?, ?, ?)")
      .bind(body.id, body.revision, JSON.stringify(body.workspace), body.created_at.slice(0, 32)),
    env.DB.prepare("DELETE FROM workspace_backups WHERE id NOT IN (SELECT id FROM workspace_backups ORDER BY id DESC LIMIT 30)"),
  ]);
  return json({ ok: true });
}

async function migrateSentNotification(request, env) {
  const auth = await requireMigrationSession(request, env);
  if (auth.error) return auth.error;
  const body = await requestJson(request);
  if (typeof body.notification_key !== "string" || !body.notification_key || body.notification_key.length > 2048
      || typeof body.sent_at !== "string") {
    return json({ error: "遷移通知紀錄格式不正確" }, 400);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO sent_notifications (notification_key, sent_at) VALUES (?, ?)")
    .bind(body.notification_key, body.sent_at.slice(0, 40))
    .run();
  return json({ ok: true });
}

async function migrationStatus(request, env) {
  const auth = await requireMigrationSession(request, env);
  if (auth.error) return auth.error;
  const workspaceRow = await env.DB.prepare("SELECT revision, updated_at, payload FROM workspace WHERE id = 1").first();
  const backups = await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_backups").first();
  const subscriptions = await env.DB.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").first();
  const sent = await env.DB.prepare("SELECT COUNT(*) AS count FROM sent_notifications").first();
  const payloadBytes = new TextEncoder().encode(workspaceRow?.payload || "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payloadBytes));
  const payloadSha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return json({
    migration_enabled: migrationEnabled(env),
    workspace: {
      revision: workspaceRow?.revision,
      updated_at: workspaceRow?.updated_at,
      payload_bytes: payloadBytes.length,
      payload_sha256: payloadSha256,
    },
    backups: Number(backups?.count || 0),
    subscriptions: Number(subscriptions?.count || 0),
    sent_notifications: Number(sent?.count || 0),
  });
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/health") return json({ status: "ok" });
  if (path === "/ready") {
    try {
      await env.DB.prepare("SELECT 1 AS ready").first();
      return json({ status: "ok" });
    } catch {
      return json({ status: "error" }, 503);
    }
  }
  if (path === "/api/login" && request.method === "POST") return login(request, env);
  if (path === "/api/workspace" && request.method === "GET") return getWorkspace(request, env);
  if (path === "/api/workspace" && request.method === "PUT") return putWorkspace(request, env);
  if (path === "/api/push/config" && request.method === "GET") return pushConfig(request, env);
  if (path === "/api/push/subscribe" && request.method === "POST") return subscribePush(request, env);
  if (path === "/api/push/subscribe" && request.method === "DELETE") return unsubscribePush(request, env);
  if (path === "/api/migration/workspace" && request.method === "POST") return migrateWorkspace(request, env);
  if (path === "/api/migration/backup" && request.method === "POST") return migrateBackup(request, env);
  if (path === "/api/migration/sent-notification" && request.method === "POST") return migrateSentNotification(request, env);
  if (path === "/api/migration/status" && request.method === "GET") return migrationStatus(request, env);
  if (path === "/api/logout" && request.method === "POST") {
    const auth = await requireSession(request, env);
    if (auth.error) return auth.error;
    if (!csrfMatches(request, auth.session)) return json({ error: "CSRF 驗證失敗" }, 403);
    return json({ ok: true }, 200, { "Set-Cookie": expiredSessionCookie() });
  }
  if (path.startsWith("/api/")) return json({ error: "找不到此 API" }, 404);

  if (path === "/login") {
    if (await authenticatedSession(request, env)) return redirect("/");
    return asset(env, request, "/login.html", "no-store");
  }
  if (path === "/") {
    if (!await authenticatedSession(request, env)) return redirect("/login");
    return asset(env, request, "/index.html");
  }
  const filename = path.slice(1);
  if (PUBLIC_ASSETS.has(filename)) return asset(env, request, path, filename.startsWith("login.") ? "no-store" : "public, max-age=86400");
  if (PROTECTED_ASSETS.has(filename)) {
    if (!await authenticatedSession(request, env)) return redirect("/login");
    return asset(env, request, path);
  }
  return json({ error: "Not Found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      if (error instanceof Response) return responseWithHeaders(error, "no-store");
      console.error("Unhandled request error", error);
      return json({ error: "伺服器暫時無法處理此要求" }, 500);
    }
  },
  async scheduled(controller, env, context) {
    context.waitUntil(sendDueNotifications(env, new Date(controller.scheduledTime)));
  },
};

export { handleFetch };
