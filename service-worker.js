const CACHE_NAME = "teacher-operations-v17";
const APP_SHELL = [
  "/", "/styles.css", "/app.js", "/manifest.json", "/app-icon.svg",
  "/app-icon-192.png", "/app-icon-512.png", "/icon-house.svg", "/icon-folders.svg",
  "/icon-calendar-days.svg", "/icon-settings.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/api/")) return;
  const updateCache = fetch(event.request).then((response) => {
    if (response.ok && !response.url.endsWith("/login") && new URL(event.request.url).origin === self.location.origin) {
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    }
    return response;
  });
  if (event.request.mode === "navigate") {
    event.respondWith(updateCache.catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || updateCache));
  event.waitUntil(updateCache.then(() => undefined).catch(() => undefined));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "工作時間到了" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "老師專案管理提醒", {
    body: data.body || "工作時間到了",
    tag: data.tag || "teacher-operations-reminder",
    actions: data.task_id ? [{ action: "snooze", title: "延後 10 分鐘" }] : [],
    data: { url: data.url || "/", task_id: data.task_id || "" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.action === "snooze" && event.notification.data?.task_id
    ? `/?snooze=${encodeURIComponent(event.notification.data.task_id)}`
    : event.notification.data?.url || "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) return existing.focus().then(() => existing.navigate(target));
    return clients.openWindow(target);
  }));
});
