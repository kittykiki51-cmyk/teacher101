ObjC.import("Foundation");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourcePath = $("../app.js").stringByStandardizingPath;
const source = $.NSString.stringWithContentsOfFileEncodingError(sourcePath, $.NSUTF8StringEncoding, null).js;
const testableSource = source.replace(/\ninitializeApp\(\);\s*$/, "");
const storage = { getItem: () => null, setItem: () => null, removeItem: () => null };
const browserWindow = { location: { protocol: "file:" }, INITIAL_WORKSPACE: null };
const harness = new Function("window", "localStorage", `${testableSource}\nreturn { state, todayISO, parseDate, renderMonthCalendar, renderWeekCalendar, renderDayCalendar, renderCalendarPanel, renderMobileCalendarAgenda, calendarColor, calendarHours };`)(browserWindow, storage);

const today = harness.todayISO();
harness.state.workspace = {
  settings: { monthly_goal: 2 },
  projects: [
    { id: "project-alpha", course: "Alpha" },
    { id: "project-bravo", course: "Bravo" },
  ],
  tasks: [
    { id: "task-1", project_id: "", title: "Personal", date: today, time: "08:30", status: "未完成", reminder_minutes: "10" },
    { id: "task-2", project_id: "project-alpha", title: "Course A", date: today, time: "09:00", status: "未完成" },
    { id: "task-3", project_id: "project-bravo", title: "Course B", date: today, time: "10:00", status: "未完成" },
    { id: "task-4", project_id: "project-alpha", title: "Escaped <task>", date: today, time: "", status: "未完成" },
  ],
  checklists: [], progress_logs: [], project_messages: [], history: [], archives: [], deleted_ids: {},
};
harness.state.selectedCalendarDate = today;

const anchor = harness.parseDate(today);
const month = harness.renderMonthCalendar(anchor);
assert(month.includes("另有 1 件"), "Month view should limit a date to three visible tasks");
assert(month.includes("Escaped &lt;task&gt;"), "Calendar task titles must be HTML escaped");

const week = harness.renderWeekCalendar(anchor);
assert(week.includes("week-hour-row"), "Week view should render a time grid");
assert(week.includes("data-drop-time"), "Week time cells should accept scheduled tasks");
assert(week.includes('class="week-calendar" data-calendar-scroll'), "Week header and hour rows should share one scroll container");

const day = harness.renderDayCalendar(anchor);
assert(day.includes("time-grid-scroll"), "Day view should render a scrollable time grid");
assert(day.includes("data-drop-all-day"), "Day view should provide an all-day drop target");

const panel = harness.renderCalendarPanel(harness.state.workspace.tasks);
assert(panel.includes("延後一天"), "Selected-date panel should include postpone actions");
assert(panel.includes("data-calendar-delete"), "Selected-date panel should include delete actions");
assert(harness.calendarColor(harness.state.workspace.tasks[0]).color === "#5166e6", "Personal tasks should use royal blue");
assert(harness.calendarHours([{ time: "06:30" }, { time: "23:00" }]).join(",") === Array.from({ length: 18 }, (_, index) => index + 6).join(","), "Time grid should include early and late tasks");

const mobileAgenda = harness.renderMobileCalendarAgenda(anchor, harness.state.workspace.tasks, "測試日期");
assert(mobileAgenda.includes("mobile-date-strip"), "Mobile agenda should render a seven-day date strip");
assert(mobileAgenda.includes('data-calendar-inline'), "Mobile date selection should stay in the inline agenda");
assert(mobileAgenda.includes("查看完整月曆"), "Mobile agenda should preserve access to the month calendar");

console.log("calendar render tests: passed");
