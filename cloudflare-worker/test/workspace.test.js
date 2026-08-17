import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarEventTypeLabel,
  dueCalendarEvents,
  dueTasks,
  workspacePayloadIsValid,
} from "../src/workspace.js";

function workspace(overrides = {}) {
  return {
    settings: { monthly_goal: 2 },
    projects: [],
    tasks: [],
    calendar_events: [],
    checklists: [],
    progress_logs: [],
    project_messages: [],
    history: [],
    archives: [],
    deleted_ids: {},
    ...overrides,
  };
}

test("workspace validation preserves the Flask data contract", () => {
  assert.equal(workspacePayloadIsValid(workspace()), true);
  assert.equal(workspacePayloadIsValid({}), false);
  assert.equal(workspacePayloadIsValid(workspace({ projects: [null] })), false);
  assert.equal(workspacePayloadIsValid(workspace({ checklists: [{ items: [[]] }] })), false);
  assert.equal(workspacePayloadIsValid(workspace({ checklist_templates: [{ sections: [{ items: [{}] }] }] })), true);
});

test("task and calendar reminders use Asia/Taipei wall-clock time", () => {
  const data = workspace({
    tasks: [
      { id: "task", date: "2026-08-17", time: "10:00", reminder_minutes: "10", status: "未完成" },
      { id: "done", date: "2026-08-17", time: "10:00", reminder_minutes: "10", status: "已完成" },
    ],
    calendar_events: [
      { id: "timed", date: "2026-08-17", time: "11:00", all_day: false, reminder_minutes: "60" },
      { id: "all-day", date: "2026-08-17", all_day: true, reminder_minutes: "0" },
    ],
  });
  assert.deepEqual(dueTasks(data, new Date("2026-08-17T01:50:00Z")).map((item) => item.id), ["task"]);
  assert.deepEqual(dueCalendarEvents(data, new Date("2026-08-17T02:00:00Z")).map((item) => item.id), ["timed"]);
  assert.deepEqual(dueCalendarEvents(data, new Date("2026-08-17T01:00:00Z")).map((item) => item.id), ["all-day"]);
});

test("legacy important-event labels remain readable", () => {
  assert.equal(calendarEventTypeLabel({ event_type: "要約面試" }), "邀約面試");
  assert.equal(calendarEventTypeLabel({ event_type: "公告" }), "公告活動日");
  assert.equal(calendarEventTypeLabel({ event_type: "unknown" }), "部門會議");
});
