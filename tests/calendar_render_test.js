ObjC.import("Foundation");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourcePath = $("../app.js").stringByStandardizingPath;
const source = $.NSString.stringWithContentsOfFileEncodingError(sourcePath, $.NSUTF8StringEncoding, null).js;
const testableSource = source.replace(/\ninitializeApp\(\);\s*$/, "");
const storage = { getItem: () => null, setItem: () => null, removeItem: () => null };
const browserWindow = { location: { protocol: "file:" }, INITIAL_WORKSPACE: null };
const harness = new Function("window", "localStorage", `${testableSource}\nreturn { state, todayISO, parseDate, humanDate, renderMonthCalendar, renderWeekCalendar, renderDayCalendar, renderCalendarPanel, renderCalendarPanelTask, renderCalendarPanelEvent, renderMobileCalendarAgenda, calendarEventsOnDate, calendarImportantTimeLabel, calendarImportantType, calendarColor, calendarTaskKind, calendarHours, calendarDoubleActivation, CALENDAR_EVENT_TYPES };`)(browserWindow, storage);

const today = harness.todayISO();
assert(JSON.stringify(harness.CALENDAR_EVENT_TYPES) === JSON.stringify(["要約面試", "線上面試會議", "部門會議"]), "Important events should expose only the three requested categories");
harness.state.workspace = {
  settings: { monthly_goal: 2 },
  projects: [
    { id: "project-alpha", course: "Alpha" },
    { id: "project-bravo", course: "Bravo" },
  ],
  tasks: [
    { id: "task-1", project_id: "", title: "Personal", date: today, time: "08:30", status: "未完成", reminder_minutes: "10" },
    { id: "task-2", project_id: "project-alpha", title: "Course A", date: today, time: "09:00", status: "未完成" },
    { id: "task-3", project_id: "project-bravo", title: "Course B", date: today, time: "10:00", status: "未完成", task_type: "電話聯繫" },
    { id: "task-4", project_id: "project-alpha", title: "Escaped <task>", date: today, time: "", status: "未完成" },
  ],
  calendar_events: [
    { id: "event-1", project_id: "project-alpha", event_type: "線上面試會議", title: "Course meeting", date: today, all_day: false, time: "13:00", end_time: "14:30", location: "Meet", reminder_minutes: "10" },
    { id: "event-2", project_id: "", event_type: "要約面試", title: "Escaped <notice>", date: today, all_day: true, time: "", end_time: "" },
  ],
  checklists: [], progress_logs: [], project_messages: [], history: [], archives: [], deleted_ids: {},
};
harness.state.selectedCalendarDate = today;

const anchor = harness.parseDate(today);
const month = harness.renderMonthCalendar(anchor);
assert(month.includes("另有 3 項"), "Month view should prioritize important events and summarize hidden entries");
assert(month.includes("Escaped &lt;notice&gt;"), "Important event titles must be HTML escaped");
assert(month.includes("calendar-important-event"), "Month view should display important events above work");
assert(month.includes("calendar-event-kind"), "Calendar events should display a compact work-type label");
assert(harness.calendarTaskKind(harness.state.workspace.tasks[0]).label === "個人工作", "Personal work should have a visible calendar type");
assert(harness.calendarTaskKind(harness.state.workspace.tasks[1]).label === "專案工作", "Project work should have a visible calendar type");
assert(harness.calendarTaskKind(harness.state.workspace.tasks[2]).label === "電話聯繫", "Phone work should have a visible calendar type");
assert(harness.humanDate(today).includes("月") && harness.humanDate(today).includes("日"), "Displayed dates should use one readable Chinese format");

const week = harness.renderWeekCalendar(anchor);
assert(week.includes("week-hour-row"), "Week view should render a time grid");
assert(week.includes("data-drop-time"), "Week time cells should accept scheduled tasks");
assert(week.includes('class="week-calendar" data-calendar-scroll'), "Week header and hour rows should share one scroll container");
assert(week.includes("Course meeting") && week.includes("13:00–14:30"), "Week view should display timed important events with an end time");

const day = harness.renderDayCalendar(anchor);
assert(day.includes("time-grid-scroll"), "Day view should render a scrollable time grid");
assert(day.includes("data-drop-all-day"), "Day view should provide an all-day drop target");

const panel = harness.renderCalendarPanel(harness.state.workspace.calendar_events, harness.state.workspace.tasks);
assert(panel.includes("延後一天"), "Selected-date panel should include postpone actions");
assert(panel.includes("data-calendar-delete"), "Selected-date panel should include delete actions");
assert(panel.includes("重要行程") && panel.includes("工作項目"), "Selected-date panel should separate important events from work");
assert(panel.indexOf("Course meeting") < panel.indexOf("Personal"), "Important events should appear before work in the selected-date panel");
const eventPanel = harness.renderCalendarPanelEvent(harness.state.workspace.calendar_events[0]);
assert(eventPanel.includes('data-project-open="project-alpha"') && eventPanel.includes("前往專案"), "Linked important events should open their project");
assert(harness.calendarImportantTimeLabel(harness.state.workspace.calendar_events[0]) === "13:00–14:30", "Important events should display their full time range");
assert(harness.calendarImportantType({ event_type: "unknown" }) === "部門會議", "Unknown imported event types should use a safe visible fallback");
assert(harness.calendarImportantType({ event_type: "會議" }) === "部門會議", "Legacy meeting records should remain visible under the closest current category");
const projectPanelTask = harness.renderCalendarPanelTask(harness.state.workspace.tasks[1]);
const personalPanelTask = harness.renderCalendarPanelTask(harness.state.workspace.tasks[0]);
const completedProjectPanelTask = harness.renderCalendarPanelTask({ ...harness.state.workspace.tasks[1], status: "已完成" });
assert(projectPanelTask.includes('data-project-open="project-alpha"') && projectPanelTask.includes("前往專案"), "Project calendar work should link directly to its project");
assert(!personalPanelTask.includes("前往專案"), "Personal calendar work should not show a project link");
assert(completedProjectPanelTask.includes("前往專案"), "Completed project work should keep its project link");
assert(harness.calendarDoubleActivation(`date:${today}`) === false, "First calendar activation should only select the date");
assert(harness.calendarDoubleActivation(`date:${today}`) === true, "Second calendar activation should create work");
assert(!source.includes("calendarSelectionTimer"), "Calendar selection should not impose a 300 ms single-click delay");
assert(harness.calendarColor(harness.state.workspace.tasks[0]).color === "#5166e6", "Personal tasks should use royal blue");
assert(harness.calendarHours([{ time: "06:30" }, { time: "23:00" }]).join(",") === Array.from({ length: 18 }, (_, index) => index + 6).join(","), "Time grid should include early and late tasks");

const mobileAgenda = harness.renderMobileCalendarAgenda(anchor, harness.state.workspace.calendar_events, harness.state.workspace.tasks, "測試日期");
assert(mobileAgenda.includes("mobile-date-strip"), "Mobile agenda should render a seven-day date strip");
assert(mobileAgenda.includes('data-calendar-inline'), "Mobile date selection should stay in the inline agenda");
assert(mobileAgenda.includes("查看完整月曆"), "Mobile agenda should preserve access to the month calendar");
assert(mobileAgenda.includes("行程＋") && mobileAgenda.includes("Course meeting"), "Mobile agenda should expose important event creation and details");

console.log("calendar render tests: passed");
