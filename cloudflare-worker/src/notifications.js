import webpush from "web-push";

import { calendarEventTypeLabel, dueCalendarEvents, dueTasks } from "./workspace.js";

function notificationKey(itemType, item) {
  return `${itemType}:${item.id || ""}:${item.snooze_until || item.date || ""}:${String(item.time || "").slice(0, 5)}:${item.reminder_minutes ?? ""}`;
}

function notificationPayload(itemType, item, projects) {
  const isCalendarEvent = itemType === "calendar_event";
  const project = projects.get(item.project_id) || {};
  return JSON.stringify({
    title: isCalendarEvent ? "重要行程提醒" : "老師專案管理提醒",
    body: isCalendarEvent
      ? `${calendarEventTypeLabel(item)}｜${item.title || "行程時間到了"}`
      : `${project.course || "我的工作"}｜${item.title || "工作時間到了"}`,
    url: isCalendarEvent ? `/?calendar_date=${String(item.date || "").slice(0, 10)}` : "/",
    tag: notificationKey(itemType, item),
    task_id: isCalendarEvent ? "" : item.id || "",
  });
}

export async function sendDueNotifications(env, now = new Date()) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return { due: 0, delivered: 0 };
  const row = await env.DB.prepare("SELECT payload FROM workspace WHERE id = 1").first();
  if (!row) return { due: 0, delivered: 0 };
  const workspace = JSON.parse(row.payload);
  const subscriptions = await env.DB.prepare(
    "SELECT endpoint, subscription FROM push_subscriptions WHERE disabled_at = ''",
  ).all();
  const projects = new Map((workspace.projects || []).map((project) => [project.id, project]));
  const dueItems = dueTasks(workspace, now).map((item) => ["task", item]);
  dueItems.push(...dueCalendarEvents(workspace, now).map((item) => ["calendar_event", item]));
  if (!dueItems.length || !subscriptions.results.length) return { due: dueItems.length, delivered: 0 };

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  let deliveredCount = 0;
  for (const [itemType, item] of dueItems) {
    const key = notificationKey(itemType, item);
    const sent = await env.DB.prepare("SELECT 1 AS present FROM sent_notifications WHERE notification_key = ?").bind(key).first();
    if (sent) continue;
    let delivered = false;
    for (const subscriptionRow of subscriptions.results) {
      try {
        await webpush.sendNotification(JSON.parse(subscriptionRow.subscription), notificationPayload(itemType, item, projects), {
          TTL: 60 * 60,
          urgency: "high",
        });
        delivered = true;
      } catch (error) {
        if ([404, 410].includes(Number(error?.statusCode))) {
          await env.DB.prepare("UPDATE push_subscriptions SET disabled_at = ? WHERE endpoint = ?")
            .bind(new Date().toISOString(), subscriptionRow.endpoint)
            .run();
        } else {
          console.error("Web Push delivery failed", error?.message || error);
        }
      }
    }
    if (delivered) {
      await env.DB.prepare("INSERT OR IGNORE INTO sent_notifications (notification_key, sent_at) VALUES (?, ?)")
        .bind(key, now.toISOString())
        .run();
      deliveredCount += 1;
    }
  }
  return { due: dueItems.length, delivered: deliveredCount };
}
