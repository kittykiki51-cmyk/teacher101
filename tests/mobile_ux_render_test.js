ObjC.import("Foundation");

function read(path) {
  return $.NSString.stringWithContentsOfFileEncodingError($(path).stringByStandardizingPath, $.NSUTF8StringEncoding, null).js;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = read("../app.js");
const testableSource = source.replace(/\ninitializeApp\(\);\s*$/, "");
const storage = { getItem: () => null, setItem: () => null, removeItem: () => null };
const browserWindow = { location: { protocol: "file:" }, INITIAL_WORKSPACE: null };
const harness = new Function("window", "localStorage", `${testableSource}\nreturn { state, todayISO, monthKey, renderDashboard, renderProjectDetail, renderSettings, renderCalendar, taskList };`)(browserWindow, storage);

const today = harness.todayISO();
const currentMonth = harness.monthKey(new Date());
const project = {
  id: "project-mobile",
  teacher: "Mobile Teacher",
  course: "Mobile Course",
  role: "正式",
  mode: "recorded",
  target_month: currentMonth,
  target_date: today,
  current_stage: "課程錄製",
  status: "進行中",
  cooperation_status: "順利",
  links: {},
};
const generalTask = { id: "task-mobile", project_id: project.id, title: "Today task", date: today, time: "10:00", status: "未完成", task_type: "一般工作" };
const phoneTask = { id: "phone-mobile", project_id: project.id, title: "Phone task", date: today, time: "11:00", status: "未完成", task_type: "電話聯繫", phone_status: "待聯繫" };

harness.state.workspace = {
  settings: { monthly_goal: 2 },
  projects: [project],
  tasks: [generalTask, phoneTask],
  checklists: [], progress_logs: [], project_messages: [], history: [], archives: [], deleted_ids: {},
};
harness.state.selectedProjectId = project.id;

const dashboard = harness.renderDashboard();
assert(dashboard.includes("today-work-panel"), "Dashboard should identify today's work for mobile ordering");
assert(dashboard.includes("data-phone-add"), "Dashboard should provide a working phone-add action");
assert(dashboard.includes(`data-complete=\"${generalTask.id}\"`), "Today's work should provide a direct complete action");
assert(dashboard.includes(`data-task-edit=\"${generalTask.id}\"`), "Today's work should provide a direct edit action");
assert(dashboard.includes("mobile-task-complete"), "Mobile tasks should provide a one-tap completion control");
assert(dashboard.includes("task-overflow"), "Secondary mobile task actions should use an overflow menu");

const phoneList = harness.taskList([phoneTask], "", true);
assert(phoneList.includes(`data-task-edit=\"${phoneTask.id}\"`), "Phone tasks should remain editable");

harness.state.projectMobileTab = "work";
const workDetail = harness.renderProjectDetail();
assert(workDetail.includes("project-mobile-tabs"), "Project details should provide mobile tabs");
assert(workDetail.includes('data-project-mobile-panel="work"'), "Project work panel should be available");
assert(workDetail.includes('data-project-mobile-panel="checklist"'), "Project checklist panel should be available");
assert(workDetail.includes('data-project-mobile-panel="message"'), "Project message panel should be available");
assert(workDetail.includes('data-project-mobile-panel="history"'), "Project history panel should be available");

harness.state.projectMobileTab = "message";
const messageDetail = harness.renderProjectDetail();
assert(messageDetail.includes('project-board-card project-mobile-panel active'), "Selected mobile project tab should activate its panel");

const settings = harness.renderSettings();
assert(settings.includes("mobile-account-panel"), "Mobile settings should expose sync and account actions");
assert(source.includes('name="task_type"'), "Task forms should preserve phone task type");
assert(source.includes("window.visualViewport"), "Mobile dialogs should follow the visible viewport when the keyboard opens");
assert(source.includes('type="month" name="target_month"'), "Project month should use the device month picker");
assert(source.includes('type="date" name="target_date"'), "Project date should use the device date picker");
assert(source.includes('name="teacher" required') && source.includes('autocomplete="off"'), "Teacher name should not request contact autofill");
assert(source.includes("project-form-tabs"), "Project forms should provide mobile sections");
assert(source.includes('data-project-form-section="basic"') && source.includes('data-project-form-section="schedule"') && source.includes('data-project-form-section="links"'), "All project form sections should be available");

const calendar = harness.renderCalendar();
assert(calendar.includes("mobile-calendar-agenda"), "Calendar should provide an agenda-first mobile view");
assert(calendar.includes("mobile-date-strip"), "Mobile calendar should provide a seven-day date strip");
assert(calendar.includes("data-mobile-month-toggle"), "Full month view should remain available on mobile");

const styles = read("../styles.css");
assert(styles.includes(".project-mobile-tabs"), "Mobile project tab styles should exist");
assert(styles.includes("place-items: end stretch"), "Mobile dialogs should open as bottom sheets");
assert(styles.includes("env(safe-area-inset-bottom)"), "Mobile controls should account for device safe areas");
assert(styles.includes("position: sticky") && styles.includes("top: 84px"), "Mobile project tabs should remain visible while scrolling");
assert(styles.includes(".formal-panel .list") && styles.includes("grid-template-columns: repeat(2"), "Desktop dashboard should scan formal projects in two columns");
assert(styles.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"), "Today's work and phone panels should use equal desktop columns");
assert(styles.includes("margin-right: -10px") && styles.includes("border-radius: 0"), "Mobile dashboard sections should use a compact native-style layout");
assert(!styles.includes("font-size: 9px"), "Mobile supporting text should remain readable at 10px or larger");
assert(styles.includes('.modal-card .search-input') && styles.includes("font-size: 16px"), "Modal inputs should remain 16px to avoid iOS focus zoom");

const index = read("../index.html");
assert(index.includes("mobile-button-label"), "Mobile top bar should use a compact add label");

const worker = read("../service-worker.js");
assert(worker.includes('teacher-operations-v8'), "PWA cache should be refreshed for the typography update");

console.log("mobile UX render tests: passed");
