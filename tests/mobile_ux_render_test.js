ObjC.import("Foundation");

function read(path) {
  return $.NSString.stringWithContentsOfFileEncodingError($(path).stringByStandardizingPath, $.NSUTF8StringEncoding, null).js;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = read("../app.js");
assert(source.includes('label: "10% 招募老師"') && source.includes('label: "100% 已上架"'), "The project form should publish the requested first and final stage labels");
assert(!source.includes('[...STAGE_NAMES, "已上架", "已完成", "已放棄"]'), "The project-stage selector should contain only the seven requested progress categories");
const testableSource = source.replace(/\ninitializeApp\(\);\s*$/, "");
const storage = { getItem: () => null, setItem: () => null, removeItem: () => null };
const browserWindow = { location: { protocol: "file:" }, INITIAL_WORKSPACE: null };
function MockFormData(target) { this.get = (name) => target.values?.[name] ?? ""; }
const harness = new Function("window", "localStorage", "confirm", "crypto", "FormData", "requestAnimationFrame", `${testableSource}
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
  state, todayISO, monthKey, offsetMonthKey, renderDashboard, renderProjects, renderProjectDetail, renderSettings, renderCalendar,
  normalizeWorkspace,
  projectMilestone, projectFinished, projectGanttSchedule, projectGanttPriority, projectGanttTooltip, taskList,
  normalizedStageValue, projectStageDisplay, STAGE_DEFINITIONS, PROJECT_MESSAGE_TYPES, projectMessageType,
  BILLING_METHODS, lessonDurationSeconds, formatLongDuration, billableHours, projectBillingSummary,
  LESSON_DELIVERY_STEPS, lessonDeliveryState, lessonDeliverySummary, projectOperationalChecklistGroups,
  projectCompletionSummary, archiveYearSelection, notificationSettingsState, validEmailAddress,
  monthlyGoalProjects, taskDurationMinutes, taskTimeLabel, taskInterval, taskTimeConflicts,
  completeProjectForTest: (id) => runProjectActionForTest(completeProject, id),
  reopenProjectForTest: (id) => runProjectActionForTest(reopenProject, id),
  updateProjectMessageTypeForTest: (id, type) => runProjectActionForTest(() => updateProjectMessageType(id, type), id),
  startProjectMessageReplyForTest: (id) => runProjectActionForTest(startProjectMessageReply, id),
  addProjectMessageForTest: (values) => runProjectActionForTest(() => addProjectMessage({ preventDefault() {}, currentTarget: { values } })),
  saveProjectBillingSettingsForTest: (values) => runProjectActionForTest(() => saveProjectBillingSettings({ preventDefault() {}, currentTarget: { values } })),
  addLessonDurationRecordForTest: (id) => runProjectActionForTest(addLessonDurationRecord, id),
  saveLessonDurationRecordForTest: (id, values) => runProjectActionForTest(() => saveLessonDurationRecord({ preventDefault() {}, currentTarget: { dataset: { durationRecord: id }, values } })),
  toggleLessonDeliveryForTest: (id, field, done) => runProjectActionForTest(() => toggleLessonDelivery(id, field, done), id),
  deleteLessonDurationRecordForTest: (id) => runProjectActionForTest(deleteLessonDurationRecord, id),
};`)(browserWindow, storage, () => true, { randomUUID: () => "12345678-1234-1234-1234-123456789abc" }, MockFormData, () => {});

const today = harness.todayISO();
const currentMonth = harness.monthKey(new Date());
const nextMonth = harness.offsetMonthKey(1);
const project = {
  id: "project-mobile",
  teacher: "Mobile Teacher",
  course: "Mobile Course",
  role: "正式",
  mode: "recorded",
  target_month: currentMonth,
  start_date: today,
  target_date: today,
  current_stage: "完成規格書／規格書撰寫／影音錄製中",
  status: "進行中",
  cooperation_status: "順利",
  hourly_rate: 1500,
  billing_method: "exact",
  lesson_durations: [
    { id: "duration-1", lesson_number: 1, hours: 0, minutes: 57, seconds: 30, note: "Lesson one", syllabus_ready: true, video_uploaded: true, subtitles_uploaded: false, handout_uploaded: false },
    { id: "duration-2", lesson_number: 2, hours: 1, minutes: 2, seconds: 30, note: "Lesson two", syllabus_ready: true, video_uploaded: true, subtitles_uploaded: true, handout_uploaded: true },
  ],
  links: { "講師 Gmail": "teacher@gmail.com" },
};
const completedProject = {
  ...project,
  id: "project-completed",
  teacher: "Completed Teacher",
  course: "Completed Course",
  current_stage: "已上架",
  status: "已完成",
  completed_date: today,
};
const nextProject = {
  ...project,
  id: "project-next",
  teacher: "Next Teacher",
  course: "Next Course",
  target_month: nextMonth,
};
const deferredNextProject = {
  ...nextProject,
  id: "project-next-deferred",
  course: "Deferred Next Course",
  cooperation_status: "暫緩",
};
const generalTask = { id: "task-mobile", project_id: project.id, title: "Today task", date: today, time: "10:00", end_time: "11:00", status: "未完成", task_type: "一般工作" };
const phoneTask = { id: "phone-mobile", project_id: project.id, title: "Phone task", date: today, time: "11:00", status: "未完成", task_type: "電話聯繫", phone_status: "待聯繫" };
const importantEvent = { id: "event-mobile", project_id: project.id, event_type: "線上面試會議", title: "Today meeting", date: today, all_day: false, time: "14:00", end_time: "15:00", reminder_minutes: "10", location: "Google Meet" };
const teacherMessage = { id: "message-teacher", project_id: project.id, time: `${today} 09:00`, text: "Legacy teacher message" };
const replyMessage = { id: "message-reply", project_id: project.id, time: `${today} 09:10`, text: "My reply", message_type: "我的回覆", reply_to: teacherMessage.id };
const importantMessage = { id: "message-important", project_id: project.id, time: `${today} 09:20`, text: "Important note", message_type: "重要訊息" };

harness.state.workspace = {
  settings: { monthly_goal: 2 },
  projects: [project, completedProject, nextProject, deferredNextProject],
  tasks: [generalTask, phoneTask],
  calendar_events: [importantEvent],
  checklists: [{ id: "group-mobile", project_id: project.id, name: "Launch", items: [
    { id: "check-legacy-delivery", title: "第一堂 字幕＋課綱單元建置", done: true },
    { id: "check-mobile", title: "Final review", done: false },
  ] }],
  progress_logs: [], project_messages: [teacherMessage, replyMessage, importantMessage], history: [], archives: [], deleted_ids: {},
};
harness.state.selectedProjectId = project.id;

const migratedWorkspace = harness.normalizeWorkspace({
  settings: { monthly_goal: 2 },
  projects: [{ id: "legacy-video", mode: "recorded" }],
  tasks: [], calendar_events: [], progress_logs: [], project_messages: [], history: [], archives: [], deleted_ids: {},
  checklists: [{ id: "legacy-group", project_id: "legacy-video", items: [
    { id: "legacy-one", title: "第一堂＋字幕+課綱單元建置", done: true },
    { id: "legacy-two", title: "第二堂＋字幕+課綱單元建置", done: false },
  ] }],
});
assert(migratedWorkspace.projects[0].lesson_durations.length === 2, "Legacy per-lesson delivery checklists should create the missing recorded-course lesson rows");
assert(migratedWorkspace.projects[0].lesson_durations[0].syllabus_ready === true && migratedWorkspace.projects[0].lesson_durations[0].subtitles_uploaded === true, "Legacy combined syllabus and subtitle completion should migrate to both delivery checkboxes");
assert(migratedWorkspace.projects[0].lesson_durations[1].syllabus_ready === false && migratedWorkspace.projects[0].lesson_durations[1].subtitles_uploaded === false, "Incomplete legacy lesson delivery should remain unchecked after migration");
const dismissedWorkspace = harness.normalizeWorkspace({
  ...migratedWorkspace,
  projects: [{ ...migratedWorkspace.projects[0], lesson_durations: [], dismissed_lesson_delivery_numbers: [2] }],
});
assert(dismissedWorkspace.projects[0].lesson_durations.length === 1 && dismissedWorkspace.projects[0].lesson_durations[0].lesson_number === 1, "A deleted migrated lesson should not be recreated on the next login");

const dashboard = harness.renderDashboard();
assert(dashboard.includes("today-work-panel"), "Dashboard should identify today's work for mobile ordering");
assert(dashboard.includes("data-phone-add"), "Dashboard should provide a working phone-add action");
assert(dashboard.includes(`data-complete=\"${generalTask.id}\"`), "Today's work should provide a direct complete action");
assert(dashboard.includes(`data-task-edit=\"${generalTask.id}\"`), "Today's work should provide a direct edit action");
assert(dashboard.includes("mobile-task-complete"), "Mobile tasks should provide a one-tap completion control");
assert(dashboard.includes("task-overflow"), "Secondary mobile task actions should use an overflow menu");
assert(dashboard.includes("empty-state") || dashboard.includes("home-task-row"), "Dashboard sections should provide content or a guided empty state");
assert(dashboard.includes(`data-project-open="${project.id}"`) && dashboard.includes("專案：Mobile Course"), "Today's work should link directly to its course project");
assert(dashboard.includes(`data-project-month-open="${currentMonth}"`) && dashboard.includes(`data-project-month-open="${nextMonth}"`), "Dashboard should provide current and next month project goal shortcuts");
assert(dashboard.includes("today-events-panel") && dashboard.includes("Today meeting"), "Dashboard should show today's important-event section when it has content");
harness.state.workspace.calendar_events = [];
assert(!harness.renderDashboard().includes("today-events-panel"), "Dashboard should hide the important-event section when today has no entries");
harness.state.workspace.calendar_events = [importantEvent];
assert(harness.monthlyGoalProjects(currentMonth).length === 2, "Current month goal count should include active and completed formal projects");
assert(harness.monthlyGoalProjects(nextMonth).length === 1, "Monthly goal count should exclude deferred projects");
assert(harness.taskDurationMinutes(generalTask) === 60 && harness.taskTimeLabel(generalTask) === "10:00–11:00", "Tasks should report their valid start-to-end duration");
const overlappingTasks = harness.taskTimeConflicts({ date: today, time: "10:45", end_time: "11:15", status: "未完成" });
assert(overlappingTasks.some((task) => task.id === generalTask.id) && overlappingTasks.some((task) => task.id === phoneTask.id), "Conflict detection should find every overlapping pending task");
assert(harness.taskTimeConflicts({ date: today, time: "09:00", end_time: "10:00", status: "未完成" }).length === 0, "Adjacent tasks should not be treated as overlapping");
assert(harness.taskTimeConflicts(generalTask, generalTask.id).length === 0, "Editing a task should exclude the task itself from conflict detection");
assert(harness.taskInterval(phoneTask).estimated === true, "Legacy tasks without an end time should use the documented 30-minute estimate");
assert(harness.taskTimeConflicts({ date: today, time: "10:45", end_time: "11:15", status: "已完成" }).length === 0, "Completed candidate tasks should not trigger schedule conflicts");

const phoneList = harness.taskList([phoneTask], "", true);
assert(phoneList.includes(`data-task-edit=\"${phoneTask.id}\"`), "Phone tasks should remain editable");

const cardProjects = harness.renderProjects();
assert(cardProjects.includes('data-project-view="cards"') && cardProjects.includes('data-project-view="table"') && cardProjects.includes('data-project-view="gantt"'), "Project page should switch between card, summary, and Gantt views");
assert(cardProjects.includes('data-project-status="active"') && cardProjects.includes('data-project-status="completed"'), "Project page should separate active and completed projects");
assert(cardProjects.includes("Mobile Course") && !cardProjects.includes("Completed Course"), "Completed projects should stay hidden from the default active view");
assert(cardProjects.includes('id="projectMonthFilter"'), "Project page should provide a target-month filter");
harness.state.projectMonthFilter = nextMonth;
const nextMonthProjects = harness.renderProjects();
assert(nextMonthProjects.includes("Next Course") && !nextMonthProjects.includes("Mobile Course"), "Month filter should show only projects from the selected target month");
harness.state.projectMonthFilter = "全部月份";
assert(harness.projectFinished(project) === false && harness.projectFinished(completedProject) === true, "Project visibility should depend on project status instead of task completion");
harness.completeProjectForTest(project.id);
assert(project.status === "已完成" && project.completed_date === today, "Complete project should set project-level status and completion date");
assert(generalTask.status === "未完成", "Completing a project should not rewrite its individual work records");
harness.reopenProjectForTest(project.id);
assert(project.status === "進行中" && project.completed_date === "", "Reopening should return a project to the active view");
assert(harness.projectMilestone(project).progress === 80, "Course recording should map to the 80 percent milestone");
assert(JSON.stringify(harness.STAGE_DEFINITIONS.map((stage) => stage.progress)) === JSON.stringify([10, 15, 30, 50, 80, 90, 100]), "Project stages should use the requested seven progress percentages");
assert(harness.projectMilestone({ current_stage: "招募老師", status: "進行中" }).progress === 10, "Teacher recruiting should map to 10 percent");
assert(harness.projectMilestone({ current_stage: "面試中", status: "進行中" }).progress === 15, "Teacher interviews should map to 15 percent");
assert(harness.projectMilestone({ current_stage: "討論課綱（錄製大綱）", status: "進行中" }).progress === 30, "Syllabus discussion should map to 30 percent");
assert(harness.projectMilestone({ current_stage: "討論鐘點費（簽約）", status: "進行中" }).progress === 50, "Contract discussion should map to 50 percent");
assert(harness.projectMilestone({ current_stage: "完成規格書／規格書撰寫／影音錄製中", status: "進行中" }).progress === 80, "Specification and recording work should map to 80 percent");
assert(harness.projectMilestone({ current_stage: "已班級排課／錄製完成", status: "進行中" }).progress === 90, "Scheduling or completed recording should map to 90 percent");
assert(harness.projectMilestone({ current_stage: "已上架", status: "已上架" }).progress === 100, "Published projects should map to 100 percent");
assert(harness.normalizedStageValue({ current_stage: "課程錄製", status: "進行中" }) === "完成規格書／規格書撰寫／影音錄製中", "Legacy recording stages should remain compatible");
assert(harness.projectStageDisplay({ current_stage: "影片後製", status: "進行中" }) === "90% 已班級排課／錄製完成", "Legacy post-production stages should display the new category");
const completionSummary = harness.projectCompletionSummary(project.id);
assert(completionSummary.workTasks.length === 1 && completionSummary.phoneTasks.length === 1 && completionSummary.deliveryItems.length === 2 && completionSummary.checklistItems.length === 1, "Project completion should warn about pending work, calls, video delivery, and checklist items separately");
harness.state.projectView = "table";
const summaryProjects = harness.renderProjects();
assert(summaryProjects.includes("project-summary-table"), "Desktop summary view should render a project table");
assert(summaryProjects.includes("project-mobile-summary-list"), "Mobile summary view should render a compact project list");
assert(summaryProjects.includes("80%") && summaryProjects.includes("完成規格書／規格書撰寫／影音錄製中"), "Summary view should pair milestone percentage with its label");
harness.state.projectStatusFilter = "completed";
const completedSummary = harness.renderProjects();
assert(completedSummary.includes("Completed Course") && !completedSummary.includes("Mobile Course"), "Completed view should only display completed projects");
assert(completedSummary.includes("100%"), "Completed projects should report 100 percent progress");
harness.state.projectStatusFilter = "active";
harness.state.projectView = "gantt";
const ganttProjects = harness.renderProjects();
assert(ganttProjects.includes("project-gantt-grid") && ganttProjects.includes("project-gantt-today"), "Desktop Gantt view should render a dated timeline and today marker");
assert(ganttProjects.includes("今天 ") && ganttProjects.includes("project-gantt-deadline"), "Gantt view should label today and mark visible project deadlines");
assert(ganttProjects.includes('data-gantt-months="3"') && ganttProjects.includes('data-gantt-months="6"') && ganttProjects.includes('data-gantt-months="12"'), "Gantt view should provide three, six, and twelve month ranges");
assert(ganttProjects.includes("project-gantt-actual") && ganttProjects.includes("project-gantt-expected"), "Gantt bars should compare actual and expected progress");
assert(ganttProjects.includes("80%｜完成規格書／規格書撰寫／影音錄製中"), "Gantt rows should explain what each milestone percentage means");
assert(ganttProjects.includes("project-gantt-mobile-list") && ganttProjects.includes("project-gantt-mobile-card"), "Mobile Gantt view should use compact schedule cards");
assert(ganttProjects.includes(`data-project-open="${project.id}"`), "Gantt projects should open their project detail directly");
assert(ganttProjects.includes('class="project-gantt-row" data-gantt-tooltip=') && ganttProjects.includes("下一步："), "The complete Gantt row should expose a hover summary");
const ganttTooltip = harness.projectGanttTooltip(project, harness.projectMilestone(project));
assert(!ganttTooltip.includes("進度：") && ganttTooltip.includes("里程碑："), "The Gantt hover summary should stay concise without a progress row");
assert(harness.projectGanttSchedule(project).actual === 80, "Gantt scheduling should use the project milestone as actual progress");
const overdueProject = { ...project, id: "project-overdue", start_date: "2000-01-01", target_date: "2000-02-01" };
const futureProject = { ...project, id: "project-future", start_date: "2099-01-01", target_date: "2099-02-01" };
const deferredProject = { ...futureProject, id: "project-deferred", cooperation_status: "暫緩" };
assert(harness.projectGanttPriority(overdueProject) < harness.projectGanttPriority(futureProject), "Overdue projects should sort before normal projects");
assert(harness.projectGanttPriority(futureProject) < harness.projectGanttPriority(deferredProject), "Deferred projects should sort after normal projects");
harness.state.projectView = "cards";

harness.state.projectMobileTab = "work";
const workDetail = harness.renderProjectDetail();
assert(workDetail.includes("project-mobile-tabs"), "Project details should provide mobile tabs");
assert(workDetail.includes('data-project-complete="project-mobile"'), "Active project details should provide a complete-project action");
assert(workDetail.includes('data-project-mobile-panel="work"'), "Project work panel should be available");
assert(workDetail.includes('data-project-mobile-panel="billing"') && workDetail.includes("影片時數與交付進度"), "Recorded project details should provide the combined duration, fee, and delivery panel");
assert(workDetail.includes('data-project-mobile-panel="checklist"'), "Project checklist panel should be available");
assert(workDetail.includes('data-project-mobile-panel="message"'), "Project message panel should be available");
assert(workDetail.includes('data-project-mobile-panel="history"'), "Project history panel should be available");
assert(workDetail.includes('data-open-email="teacher@gmail.com"') && workDetail.includes("寄信給講師"), "Project details should open an email to the teacher");
const billingSummary = harness.projectBillingSummary(project);
assert(billingSummary.totalSeconds === 7200 && billingSummary.actualHours === 2 && billingSummary.estimatedFee === 3000, "Duration records should total seconds and estimate the hourly fee accurately");
assert(harness.formatLongDuration(7200) === "2 小時 0 分 0 秒", "Total duration should use a readable hour-minute-second label");
assert(harness.billableHours(3660, "half_hour") === 1.5 && harness.billableHours(3660, "hour") === 2, "Optional billing rules should round the total duration predictably");
assert(workDetail.includes("2 小時 0 分 0 秒") && workDetail.includes("NT$3,000"), "The billing panel should display the total duration and estimated fee");
assert(workDetail.includes('data-duration-add="project-mobile"') && workDetail.includes('data-duration-record="duration-1"'), "The billing panel should allow lessons to be added and individually saved");
assert(JSON.stringify(harness.LESSON_DELIVERY_STEPS.map((step) => step.label)) === JSON.stringify(["系統課綱建置", "影片壓縮後上傳", "字幕上傳", "講義上傳"]), "Recorded lessons should expose only the four requested delivery steps");
assert(workDetail.includes('data-duration-field="syllabus_ready"') && workDetail.includes('data-duration-field="handout_uploaded"'), "Every recorded lesson should render direct delivery checkboxes");
assert(billingSummary.delivery.completedSteps === 6 && billingSummary.delivery.completedLessons === 1, "Delivery progress should count completed steps and fully delivered lessons");
assert(workDetail.includes("交付 6/8") && workDetail.includes("1 堂全數完成"), "The billing panel should summarize lesson delivery progress");
const operationalGroups = harness.projectOperationalChecklistGroups(project);
assert(operationalGroups.length === 1 && operationalGroups[0].items.length === 1 && operationalGroups[0].items[0].title === "Final review", "Recognized legacy lesson-delivery items should move out of the right operational checklist without deleting custom work");
harness.toggleLessonDeliveryForTest("duration-1", "subtitles_uploaded", true);
harness.toggleLessonDeliveryForTest("duration-1", "handout_uploaded", true);
assert(harness.lessonDeliverySummary(project).completedSteps === 8 && harness.lessonDeliverySummary(project).completedLessons === 2, "Delivery checkboxes should save independently and complete a lesson only after all four steps are checked");
harness.saveProjectBillingSettingsForTest({ mode: "直播", hourly_rate: "1800", billing_method: "half_hour" });
assert(project.mode === "live" && project.hourly_rate === 1800 && project.billing_method === "half_hour", "Billing settings should save the course type, hourly rate, and billing method");
const liveProjectDetail = harness.renderProjectDetail();
assert(!liveProjectDetail.includes('data-project-mobile-panel="billing"') && !liveProjectDetail.includes('data-project-mobile-tab="billing"'), "Live projects should hide both the billing panel and its mobile tab without deleting stored records");
assert(project.lesson_durations.length === 2, "Hiding live-project billing should preserve existing duration records");
assert(harness.projectOperationalChecklistGroups(project)[0].items.length === 2, "Live projects should retain legacy checklist items because lesson delivery is hidden");
project.mode = "recorded";
harness.saveLessonDurationRecordForTest("duration-1", { lesson_number: "1", hours: "1", minutes: "0", seconds: "0", note: "Updated lesson" });
assert(project.lesson_durations[0].hours === 1 && project.lesson_durations[0].note === "Updated lesson", "An individual lesson duration should save valid hour-minute-second values");
harness.addLessonDurationRecordForTest(project.id);
assert(project.lesson_durations.length === 3 && project.lesson_durations[2].lesson_number === 3, "Adding a lesson should create the next lesson number");
assert(harness.LESSON_DELIVERY_STEPS.every((step) => project.lesson_durations[2][step.field] === false), "A new lesson should start with every delivery step unchecked");
harness.deleteLessonDurationRecordForTest(project.lesson_durations[2].id);
assert(project.lesson_durations.length === 2, "An individual lesson duration should be removable after confirmation");
assert(project.dismissed_lesson_delivery_numbers.includes(3), "Deleting a lesson should remember that legacy delivery data must not recreate it");

harness.state.projectMobileTab = "message";
const messageDetail = harness.renderProjectDetail();
assert(messageDetail.includes('project-board-card project-mobile-panel active'), "Selected mobile project tab should activate its panel");
assert(JSON.stringify(harness.PROJECT_MESSAGE_TYPES) === JSON.stringify(["老師留言", "我的回覆", "重要訊息"]), "Message categories should contain only the requested three options");
assert(harness.projectMessageType(teacherMessage) === "老師留言", "Legacy messages without a category should remain visible as teacher messages");
assert(messageDetail.includes("message-type-picker") && messageDetail.includes('name="message_type"'), "New messages should provide three direct category buttons");
assert(messageDetail.includes("message-tone-teacher") && messageDetail.includes("message-tone-reply") && messageDetail.includes("message-tone-important"), "Message rows should render distinct teacher, reply, and important tones");
assert(messageDetail.includes('data-message-reply="message-teacher"') && messageDetail.includes("message-thread-replies"), "Teacher messages should provide an individual reply action and group linked replies underneath");
assert(messageDetail.includes('data-message-set-type="message-reply"') && !messageDetail.includes("message-row-type"), "Existing messages should use a compact action menu instead of an always-visible selector");
assert(messageDetail.indexOf("Important note") < messageDetail.indexOf("Legacy teacher message"), "Important messages should remain pinned above regular message threads");
harness.startProjectMessageReplyForTest(teacherMessage.id);
const replyingDetail = harness.renderProjectDetail();
assert(replyingDetail.includes("正在回覆") && replyingDetail.includes('value="我的回覆" checked'), "Replying should preselect the user's blue reply category and show the source message");
harness.addProjectMessageForTest({ message: "A linked reply", message_type: "老師留言" });
const linkedReply = harness.state.workspace.project_messages[0];
assert(linkedReply.message_type === "我的回覆" && linkedReply.reply_to === teacherMessage.id, "Submitting an individual reply should link it to the source and force the reply category");
harness.updateProjectMessageTypeForTest(replyMessage.id, "重要訊息");
assert(replyMessage.message_type === "重要訊息" && Boolean(replyMessage.updated_at), "Changing a message category should persist the new type and update time");
harness.state.selectedProjectId = completedProject.id;
const completedDetail = harness.renderProjectDetail();
assert(completedDetail.includes('data-project-reopen="project-completed"'), "Completed project details should provide a reopen action");
harness.state.selectedProjectId = project.id;

const settings = harness.renderSettings();
assert(settings.includes("mobile-account-panel"), "Mobile settings should expose sync and account actions");
assert(settings.includes("瀏覽器權限") && settings.includes("推播訂閱") && settings.includes("最近測試"), "Settings should explain notification reliability state");
assert(settings.includes("data-refresh-notifications") && settings.includes("data-test-notification"), "Notification settings should support rechecking and testing this device");
assert(settings.includes("data-export-year") && settings.includes("data-archive-year"), "Annual data should support separate export and archive actions");
const annualSelection = harness.archiveYearSelection(Number(today.slice(0, 4)));
assert(annualSelection.completedProjectIds.has(completedProject.id), "Annual export should include completed projects from the selected year");
assert(annualSelection.archivedEventIds.has(importantEvent.id), "Annual export should include important events from the selected year");
assert(source.includes('name="task_type"'), "Task forms should preserve phone task type");
assert(source.includes('name="end_time"') && source.includes("結束時間必須晚於開始時間"), "Task forms should capture and validate an optional end time");
assert(source.includes('task.end_time = minutesToTime'), "Calendar dragging should preserve a task's duration");
assert(source.includes('id="taskConflictWarning"') && source.includes("仍要儲存嗎"), "Task forms should warn about schedule conflicts while allowing an explicit override");
assert(source.includes("window.visualViewport"), "Mobile dialogs should follow the visible viewport when the keyboard opens");
assert(source.includes('type="month" name="target_month"'), "Project month should use the device month picker");
assert(source.includes('type="date" name="target_date"'), "Project date should use the device date picker");
assert(source.includes('type="date" name="start_date"'), "Project forms should capture the project start date for summary reporting");
assert(source.includes('name="teacher" required') && source.includes('autocomplete="off"'), "Teacher name should not request contact autofill");
assert(source.includes('name="teacher_email"') && !source.includes('name="course_link"'), "Project forms should collect teacher email instead of a course page URL");
assert(harness.validEmailAddress("teacher@gmail.com") === "teacher@gmail.com" && harness.validEmailAddress("not-an-email") === "", "Teacher email should be validated before saving or opening mail");
assert(source.includes("project-form-tabs"), "Project forms should provide mobile sections");
assert(source.includes('data-project-form-section="basic"') && source.includes('data-project-form-section="schedule"') && source.includes('data-project-form-section="links"'), "All project form sections should be available");
assert(source.includes("nav-icon-${item.icon}"), "Desktop and mobile navigation should render consistent line icons");

const calendar = harness.renderCalendar();
assert(calendar.includes("mobile-calendar-agenda"), "Calendar should provide an agenda-first mobile view");
assert(calendar.includes("mobile-date-strip"), "Mobile calendar should provide a seven-day date strip");
assert(calendar.includes("data-mobile-month-toggle"), "Full month view should remain available on mobile");
assert(calendar.includes("10:00–11:00"), "Calendar should display a task's start and end time");
assert(calendar.includes("Today meeting") && calendar.includes("新增重要行程"), "Calendar should display and create important events");

const styles = read("../styles.css");
assert((styles.match(/\{/g) || []).length === (styles.match(/\}/g) || []).length, "CSS braces should remain balanced");
const dashboardPanelStart = styles.indexOf("\n.home-panel {", styles.indexOf(".home-body"));
const dashboardPanelStyles = styles.slice(dashboardPanelStart, styles.indexOf("\n.today-work-panel {", dashboardPanelStart));
assert(dashboardPanelStyles.includes("background: var(--surface)") && dashboardPanelStyles.includes("border: 1px solid var(--border)"), "Dashboard panels should retain their white framed surfaces");
assert(styles.includes(".project-mobile-tabs"), "Mobile project tab styles should exist");
assert(styles.includes(".billing-summary") && styles.includes(".lesson-duration-row"), "Duration and fee calculator styles should exist");
assert(styles.includes(".lesson-delivery-checks") && styles.includes(".lesson-delivery-option.checked"), "Lesson delivery checkboxes should provide desktop, mobile, and completed states");
assert(styles.includes(".message-type-picker") && styles.includes(".message-thread-replies"), "Message category and linked-reply styles should exist");
assert(styles.includes("place-items: end stretch"), "Mobile dialogs should open as bottom sheets");
assert(styles.includes("env(safe-area-inset-bottom)"), "Mobile controls should account for device safe areas");
assert(styles.includes("position: sticky") && styles.includes("top: 84px"), "Mobile project tabs should remain visible while scrolling");
assert(styles.includes(".formal-panel .list") && styles.includes("grid-template-columns: repeat(2"), "Desktop dashboard should scan formal projects in two columns");
assert(styles.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"), "Today's work and phone panels should use equal desktop columns");
assert(styles.includes("margin-right: -10px") && styles.includes("border-radius: 0"), "Mobile dashboard sections should use a compact native-style layout");
assert(styles.includes(".home-task-main > .home-task-project-link") && styles.includes("min-width: 100%") && styles.includes("overflow-wrap: anywhere"), "Long dashboard task content should stay inside its WebKit grid track");
assert(styles.includes("margin-right: -8px") && styles.includes("margin-left: -8px"), "Narrow mobile dashboard sections should align with the reduced page padding");
assert(!styles.includes("font-size: 9px"), "Mobile supporting text should remain readable at 10px or larger");
assert(styles.includes('.modal-card .search-input') && styles.includes("font-size: 16px"), "Modal inputs should remain 16px to avoid iOS focus zoom");
assert(styles.includes(".nav-icon-house") && styles.includes(".nav-icon-calendar-days"), "Navigation icon masks should be available");
assert(styles.includes(".pill.gray") && styles.includes("border-radius: 5px"), "Status badges should use the standardized compact treatment");
assert(styles.includes("button:active:not(:disabled)"), "Buttons should provide restrained press feedback");
assert(styles.includes("--content-width: 1280px") && styles.includes('body[data-page="calendar"] .content'), "Standard pages should use a focused width while calendars remain wide");
assert(styles.includes(".item-card.completed") && styles.includes("opacity: 0.78"), "Completed work should use reduced visual weight");
assert(styles.includes(".project-summary-table") && styles.includes(".project-mobile-summary-list"), "Project summary should provide dedicated desktop and mobile layouts");
assert(styles.includes(".project-gantt-info") && styles.includes("position: sticky"), "Gantt project labels should remain fixed while scrolling horizontally");
assert(styles.includes(".project-gantt-mobile-card") && styles.includes(".project-gantt-today"), "Gantt view should provide mobile cards and a desktop today marker");
assert(styles.includes("border-left: 1px dashed") && styles.includes(".gantt-hover-card"), "Today should use a subtle dashed marker and Gantt bars should provide a hover card");
assert(styles.includes(".bottom-nav .active") && styles.includes("background: transparent"), "Mobile navigation should use a single active-state signal");
assert(source.includes("updateSyncIndicator") && source.includes("indicator.dataset.syncTone = tone"), "Sync feedback should use stable visual states");
assert(source.includes('showToast("已標記完成", () =>'), "Completing work should provide a short undo opportunity");
assert(styles.includes(".task-conflict-warning") && styles.includes("border-left: 4px solid var(--amber)"), "Schedule conflicts should use a clear warning treatment");

const index = read("../index.html");
assert(index.includes("mobile-button-label"), "Mobile top bar should use a compact add label");
assert(index.includes('href="app-icon.svg"') && index.includes('href="app-icon-192.png"'), "The app should publish browser and home-screen icons");
assert(index.includes('styles.css?v=38') && index.includes('app.js?v=38'), "The page should request versioned assets after the recorded-course delivery update");

const manifest = read("../manifest.json");
assert(manifest.includes("app-icon-192.png") && manifest.includes("app-icon-512.png") && manifest.includes("maskable"), "The PWA manifest should publish installable app icons");

const worker = read("../service-worker.js");
new Function(worker);
assert(worker.includes('teacher-operations-v38'), "PWA cache should be refreshed after the recorded-course delivery update");
assert(worker.includes('"/styles.css?v=38"') && worker.includes('"/app.js?v=38"'), "The PWA shell should cache versioned application assets");
assert(worker.includes("event.respondWith(updateCache.catch"), "Online application assets should load from the network before falling back to cache");
assert(worker.includes("icon-house.svg") && worker.includes("app-icon-512.png"), "The PWA shell should cache identity and navigation assets");
assert(worker.includes('LOGIN_PATHS.has(url.pathname)'), "The service worker should leave login documents and assets to the network");

const loginHTML = read("../login.html");
const loginScript = read("../login.js");
const loginStyles = read("../login.css");
assert(!loginHTML.includes("autofocus") && loginHTML.includes('enterkeyhint="go"'), "Mobile login should wait for an explicit tap before opening the keyboard");
assert(loginHTML.includes('login.css?v=29') && loginHTML.includes('login.js?v=29'), "Login assets should use a fresh deployment version");
assert(loginScript.includes('window.addEventListener("pageshow"') && loginScript.includes("resetLoginState"), "Restored login pages should reset stale interactive state");
assert(loginStyles.includes(".password-field input") && loginStyles.includes("font-size: 16px"), "The password field should use a stable mobile input font size");
assert(source.includes("cloudSavePending"), "Cloud saves made during an active request should remain queued");
assert(source.includes("scheduleSearchRender"), "Search input should debounce full-page rendering");
assert(!styles.includes("backdrop-filter: blur(12px)"), "Mobile navigation should avoid expensive live backdrop blur");
assert(styles.includes(".segmented-control.project-status-switch") && styles.includes("white-space: nowrap"), "Project status tabs should retain readable two-column labels");

console.log("mobile UX render tests: passed");
