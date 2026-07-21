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
const harness = new Function("window", "localStorage", "confirm", "crypto", `${testableSource}
function runProjectActionForTest(action, id) {
  const originalToast = showToast;
  const originalRender = render;
  const originalSave = saveWorkspace;
  showToast = () => {};
  render = () => {};
  saveWorkspace = () => {};
  try { action(id); } finally { showToast = originalToast; render = originalRender; saveWorkspace = originalSave; }
}
return {
  state, todayISO, monthKey, renderDashboard, renderProjects, renderProjectDetail, renderSettings, renderCalendar,
  projectMilestone, projectFinished, taskList,
  completeProjectForTest: (id) => runProjectActionForTest(completeProject, id),
  reopenProjectForTest: (id) => runProjectActionForTest(reopenProject, id),
};`)(browserWindow, storage, () => true, { randomUUID: () => "12345678-1234-1234-1234-123456789abc" });

const today = harness.todayISO();
const currentMonth = harness.monthKey(new Date());
const project = {
  id: "project-mobile",
  teacher: "Mobile Teacher",
  course: "Mobile Course",
  role: "正式",
  mode: "recorded",
  target_month: currentMonth,
  start_date: today,
  target_date: today,
  current_stage: "課程錄製",
  status: "進行中",
  cooperation_status: "順利",
  links: {},
};
const completedProject = {
  ...project,
  id: "project-completed",
  teacher: "Completed Teacher",
  course: "Completed Course",
  current_stage: "課程上架",
  status: "已完成",
  completed_date: today,
};
const generalTask = { id: "task-mobile", project_id: project.id, title: "Today task", date: today, time: "10:00", status: "未完成", task_type: "一般工作" };
const phoneTask = { id: "phone-mobile", project_id: project.id, title: "Phone task", date: today, time: "11:00", status: "未完成", task_type: "電話聯繫", phone_status: "待聯繫" };

harness.state.workspace = {
  settings: { monthly_goal: 2 },
  projects: [project, completedProject],
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
assert(dashboard.includes("empty-state") || dashboard.includes("home-task-row"), "Dashboard sections should provide content or a guided empty state");

const phoneList = harness.taskList([phoneTask], "", true);
assert(phoneList.includes(`data-task-edit=\"${phoneTask.id}\"`), "Phone tasks should remain editable");

const cardProjects = harness.renderProjects();
assert(cardProjects.includes('data-project-view="cards"') && cardProjects.includes('data-project-view="table"'), "Project page should switch between card and summary views");
assert(cardProjects.includes('data-project-status="active"') && cardProjects.includes('data-project-status="completed"'), "Project page should separate active and completed projects");
assert(cardProjects.includes("Mobile Course") && !cardProjects.includes("Completed Course"), "Completed projects should stay hidden from the default active view");
assert(harness.projectFinished(project) === false && harness.projectFinished(completedProject) === true, "Project visibility should depend on project status instead of task completion");
harness.completeProjectForTest(project.id);
assert(project.status === "已完成" && project.completed_date === today, "Complete project should set project-level status and completion date");
assert(generalTask.status === "未完成", "Completing a project should not rewrite its individual work records");
harness.reopenProjectForTest(project.id);
assert(project.status === "進行中" && project.completed_date === "", "Reopening should return a project to the active view");
assert(harness.projectMilestone(project).progress === 80, "Course recording should map to the 80 percent milestone");
assert(harness.projectMilestone({ current_stage: "講師資料", status: "進行中" }).progress === 50, "Teacher preparation should map to the 50 percent milestone");
assert(harness.projectMilestone({ current_stage: "課綱與合約", status: "進行中" }).progress === 60, "Syllabus discussion should map to the 60 percent milestone");
assert(harness.projectMilestone({ current_stage: "影片後製", status: "進行中" }).progress === 90, "Completed recording or post-production should map to the 90 percent milestone");
assert(harness.projectMilestone({ current_stage: "已上架", status: "已上架" }).progress === 100, "Published projects should map to the 100 percent milestone");
harness.state.projectView = "table";
const summaryProjects = harness.renderProjects();
assert(summaryProjects.includes("project-summary-table"), "Desktop summary view should render a project table");
assert(summaryProjects.includes("project-mobile-summary-list"), "Mobile summary view should render a compact project list");
assert(summaryProjects.includes("80%") && summaryProjects.includes("課綱完成・錄製課程"), "Summary view should pair milestone percentage with its label");
harness.state.projectStatusFilter = "completed";
const completedSummary = harness.renderProjects();
assert(completedSummary.includes("Completed Course") && !completedSummary.includes("Mobile Course"), "Completed view should only display completed projects");
assert(completedSummary.includes("100%"), "Completed projects should report 100 percent progress");
harness.state.projectStatusFilter = "active";

harness.state.projectMobileTab = "work";
const workDetail = harness.renderProjectDetail();
assert(workDetail.includes("project-mobile-tabs"), "Project details should provide mobile tabs");
assert(workDetail.includes('data-project-complete="project-mobile"'), "Active project details should provide a complete-project action");
assert(workDetail.includes('data-project-mobile-panel="work"'), "Project work panel should be available");
assert(workDetail.includes('data-project-mobile-panel="checklist"'), "Project checklist panel should be available");
assert(workDetail.includes('data-project-mobile-panel="message"'), "Project message panel should be available");
assert(workDetail.includes('data-project-mobile-panel="history"'), "Project history panel should be available");

harness.state.projectMobileTab = "message";
const messageDetail = harness.renderProjectDetail();
assert(messageDetail.includes('project-board-card project-mobile-panel active'), "Selected mobile project tab should activate its panel");
harness.state.selectedProjectId = completedProject.id;
const completedDetail = harness.renderProjectDetail();
assert(completedDetail.includes('data-project-reopen="project-completed"'), "Completed project details should provide a reopen action");
harness.state.selectedProjectId = project.id;

const settings = harness.renderSettings();
assert(settings.includes("mobile-account-panel"), "Mobile settings should expose sync and account actions");
assert(source.includes('name="task_type"'), "Task forms should preserve phone task type");
assert(source.includes("window.visualViewport"), "Mobile dialogs should follow the visible viewport when the keyboard opens");
assert(source.includes('type="month" name="target_month"'), "Project month should use the device month picker");
assert(source.includes('type="date" name="target_date"'), "Project date should use the device date picker");
assert(source.includes('type="date" name="start_date"'), "Project forms should capture the project start date for summary reporting");
assert(source.includes('name="teacher" required') && source.includes('autocomplete="off"'), "Teacher name should not request contact autofill");
assert(source.includes("project-form-tabs"), "Project forms should provide mobile sections");
assert(source.includes('data-project-form-section="basic"') && source.includes('data-project-form-section="schedule"') && source.includes('data-project-form-section="links"'), "All project form sections should be available");
assert(source.includes("nav-icon-${item.icon}"), "Desktop and mobile navigation should render consistent line icons");

const calendar = harness.renderCalendar();
assert(calendar.includes("mobile-calendar-agenda"), "Calendar should provide an agenda-first mobile view");
assert(calendar.includes("mobile-date-strip"), "Mobile calendar should provide a seven-day date strip");
assert(calendar.includes("data-mobile-month-toggle"), "Full month view should remain available on mobile");

const styles = read("../styles.css");
assert((styles.match(/\{/g) || []).length === (styles.match(/\}/g) || []).length, "CSS braces should remain balanced");
const dashboardPanelStart = styles.indexOf("\n.home-panel {", styles.indexOf(".home-body"));
const dashboardPanelStyles = styles.slice(dashboardPanelStart, styles.indexOf("\n.today-work-panel {", dashboardPanelStart));
assert(dashboardPanelStyles.includes("background: var(--surface)") && dashboardPanelStyles.includes("border: 1px solid var(--border)"), "Dashboard panels should retain their white framed surfaces");
assert(styles.includes(".project-mobile-tabs"), "Mobile project tab styles should exist");
assert(styles.includes("place-items: end stretch"), "Mobile dialogs should open as bottom sheets");
assert(styles.includes("env(safe-area-inset-bottom)"), "Mobile controls should account for device safe areas");
assert(styles.includes("position: sticky") && styles.includes("top: 84px"), "Mobile project tabs should remain visible while scrolling");
assert(styles.includes(".formal-panel .list") && styles.includes("grid-template-columns: repeat(2"), "Desktop dashboard should scan formal projects in two columns");
assert(styles.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"), "Today's work and phone panels should use equal desktop columns");
assert(styles.includes("margin-right: -10px") && styles.includes("border-radius: 0"), "Mobile dashboard sections should use a compact native-style layout");
assert(!styles.includes("font-size: 9px"), "Mobile supporting text should remain readable at 10px or larger");
assert(styles.includes('.modal-card .search-input') && styles.includes("font-size: 16px"), "Modal inputs should remain 16px to avoid iOS focus zoom");
assert(styles.includes(".nav-icon-house") && styles.includes(".nav-icon-calendar-days"), "Navigation icon masks should be available");
assert(styles.includes(".pill.gray") && styles.includes("border-radius: 5px"), "Status badges should use the standardized compact treatment");
assert(styles.includes("button:active:not(:disabled)"), "Buttons should provide restrained press feedback");
assert(styles.includes("--content-width: 1280px") && styles.includes('body[data-page="calendar"] .content'), "Standard pages should use a focused width while calendars remain wide");
assert(styles.includes(".item-card.completed") && styles.includes("opacity: 0.78"), "Completed work should use reduced visual weight");
assert(styles.includes(".project-summary-table") && styles.includes(".project-mobile-summary-list"), "Project summary should provide dedicated desktop and mobile layouts");
assert(styles.includes(".bottom-nav .active") && styles.includes("background: transparent"), "Mobile navigation should use a single active-state signal");
assert(source.includes("updateSyncIndicator") && source.includes("indicator.dataset.syncTone = tone"), "Sync feedback should use stable visual states");
assert(source.includes('showToast("已標記完成", () =>'), "Completing work should provide a short undo opportunity");

const index = read("../index.html");
assert(index.includes("mobile-button-label"), "Mobile top bar should use a compact add label");
assert(index.includes('href="app-icon.svg"') && index.includes('href="app-icon-192.png"'), "The app should publish browser and home-screen icons");

const manifest = read("../manifest.json");
assert(manifest.includes("app-icon-192.png") && manifest.includes("app-icon-512.png") && manifest.includes("maskable"), "The PWA manifest should publish installable app icons");

const worker = read("../service-worker.js");
new Function(worker);
assert(worker.includes('teacher-operations-v16'), "PWA cache should be refreshed for the final data-integrity fixes");
assert(worker.includes("icon-house.svg") && worker.includes("app-icon-512.png"), "The PWA shell should cache identity and navigation assets");
assert(source.includes("cloudSavePending"), "Cloud saves made during an active request should remain queued");
assert(source.includes("scheduleSearchRender"), "Search input should debounce full-page rendering");
assert(!styles.includes("backdrop-filter: blur(12px)"), "Mobile navigation should avoid expensive live backdrop blur");
assert(styles.includes(".segmented-control.project-status-switch") && styles.includes("white-space: nowrap"), "Project status tabs should retain readable two-column labels");

console.log("mobile UX render tests: passed");
