export const WORKSPACE_LIST_FIELDS = [
  "projects",
  "tasks",
  "calendar_events",
  "checklists",
  "progress_logs",
  "project_messages",
  "history",
  "archives",
];

const CALENDAR_EVENT_TYPES = new Set(["休假", "邀約面試", "線上面試會議", "部門會議", "公告活動日"]);
const LEGACY_CALENDAR_EVENT_TYPE_MAP = {
  "要約面試": "邀約面試",
  "公告": "公告活動日",
  "會議": "部門會議",
  "重要事項": "部門會議",
  "錄製／上課": "部門會議",
};

function recordList(value) {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item));
}

export function workspacePayloadIsValid(workspace) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return false;
  if (!workspace.settings || typeof workspace.settings !== "object" || Array.isArray(workspace.settings)) return false;
  if (!workspace.deleted_ids || typeof workspace.deleted_ids !== "object" || Array.isArray(workspace.deleted_ids)) return false;
  if (WORKSPACE_LIST_FIELDS.some((field) => !recordList(workspace[field]))) return false;
  if (workspace.projects.some((project) => "stages" in project && !recordList(project.stages))) return false;
  if (workspace.checklists.some((group) => "items" in group && !recordList(group.items))) return false;
  if (workspace.checklist_templates !== undefined) {
    if (!recordList(workspace.checklist_templates)) return false;
    for (const template of workspace.checklist_templates) {
      if (!recordList(template.sections)) return false;
      if (template.sections.some((section) => !recordList(section.items))) return false;
    }
  }
  const archiveFields = WORKSPACE_LIST_FIELDS.slice(0, -1);
  for (const archive of workspace.archives) {
    if (archiveFields.some((field) => field in archive && !recordList(archive[field]))) return false;
  }
  return true;
}

function localTimestamp(date, time) {
  const timestamp = Date.parse(`${String(date).slice(0, 10)}T${String(time).slice(0, 5)}:00+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function dueTasks(workspace, now) {
  const due = [];
  const currentMinute = Math.floor(now.getTime() / 60000) * 60000;
  for (const task of workspace.tasks || []) {
    if (task.status === "已完成") continue;
    const snoozeUntil = String(task.snooze_until || "").slice(0, 16);
    if (snoozeUntil) {
      const snoozeAt = localTimestamp(snoozeUntil.slice(0, 10), snoozeUntil.slice(11, 16));
      if (snoozeAt === currentMinute) due.push(task);
      continue;
    }
    if (!task.date || !task.time || task.reminder_minutes === "" || task.reminder_minutes === null || task.reminder_minutes === undefined) continue;
    const scheduled = localTimestamp(task.date, task.time);
    const reminder = Number(task.reminder_minutes);
    if (scheduled !== null && Number.isFinite(reminder) && scheduled - Math.max(0, reminder) * 60000 === currentMinute) due.push(task);
  }
  return due;
}

export function dueCalendarEvents(workspace, now) {
  const due = [];
  const currentMinute = Math.floor(now.getTime() / 60000) * 60000;
  for (const event of workspace.calendar_events || []) {
    if (event.status === "已完成") continue;
    if (!event.date || event.reminder_minutes === "" || event.reminder_minutes === null || event.reminder_minutes === undefined) continue;
    const time = event.all_day || !event.time ? "09:00" : event.time;
    const scheduled = localTimestamp(event.date, time);
    const reminder = Number(event.reminder_minutes);
    if (scheduled !== null && Number.isFinite(reminder) && scheduled - Math.max(0, reminder) * 60000 === currentMinute) due.push(event);
  }
  return due;
}

export function calendarEventTypeLabel(event) {
  const rawType = String(event.event_type || "");
  const eventType = LEGACY_CALENDAR_EVENT_TYPE_MAP[rawType] || rawType;
  return CALENDAR_EVENT_TYPES.has(eventType) ? eventType : "部門會議";
}
