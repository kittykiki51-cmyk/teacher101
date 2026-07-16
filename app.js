const STORAGE_KEY = "teacher_operations_web_workspace";
const OFFLINE_CACHE_KEY = "teacher_operations_cloud_offline_cache";
const CLOUD_MODE = window.location?.protocol !== "file:";

const STATUS_COMPLETED = "已完成";
const STATUS_WAITING = "等待中";
const TASK_TYPE_PHONE = "電話聯繫";
const ROLE_FORMAL = "正式";
const ROLE_UNSET = "未設定";
const STAGE_NAMES = ["講師資料", "課綱與合約", "課程錄製", "影片後製", "課程上架"];

const NAV_ITEMS = [
  { id: "dashboard", label: "營運首頁", icon: "", title: "營運首頁" },
  { id: "projects", label: "課程專案", icon: "", title: "課程專案" },
  { id: "calendar", label: "工作月曆", icon: "", title: "工作月曆" },
  { id: "settings", label: "更多設定", icon: "", title: "更多設定" },
];

const emptyWorkspace = () => ({
  version: "web-draft-1",
  settings: { monthly_goal: 2 },
  projects: [],
  tasks: [],
  checklists: [],
  progress_logs: [],
  project_messages: [],
  history: [],
  archives: [],
  deleted_ids: {},
});

let state = {
  page: "dashboard",
  query: "",
  projectRoleFilter: "全部",
  projectModeFilter: "全部類型",
  hideCompletedProjects: true,
  calendarQuery: "",
  calendarStatusFilter: "全部",
  calendarView: "month",
  globalQuery: "",
  pageBeforeSearch: "dashboard",
  selectedProjectId: "",
  selectedTaskIds: new Set(),
  expandedCompletedProjectIds: new Set(),
  selectedMonth: new Date(),
  selectedCalendarDate: todayISO(),
  workspace: loadWorkspace(),
};

let cloudRevision = 0;
let cloudCsrfToken = "";
let cloudSaveTimer = null;
let cloudSaveInFlight = false;

const $ = (selector) => document.querySelector(selector);

function loadWorkspace() {
  if (CLOUD_MODE) {
    try {
      const cached = localStorage.getItem(OFFLINE_CACHE_KEY);
      return cached ? normalizeWorkspace(JSON.parse(cached)) : emptyWorkspace();
    } catch {
      return emptyWorkspace();
    }
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeWorkspace(JSON.parse(saved));
    if (window.INITIAL_WORKSPACE) return normalizeWorkspace(window.INITIAL_WORKSPACE);
    return emptyWorkspace();
  } catch {
    return window.INITIAL_WORKSPACE ? normalizeWorkspace(window.INITIAL_WORKSPACE) : emptyWorkspace();
  }
}

function saveWorkspace() {
  const indicator = $("#saveIndicator");
  if (!CLOUD_MODE) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workspace));
    if (indicator) indicator.textContent = "已自動保存";
    return;
  }
  localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
  if (indicator) indicator.textContent = "正在同步...";
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(saveCloudWorkspace, 450);
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("登入已過期");
  }
  return response;
}

async function loadCloudWorkspace() {
  const response = await apiFetch("/api/workspace");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "雲端資料讀取失敗");
  state.workspace = normalizeWorkspace(result.workspace);
  localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
  cloudRevision = result.revision;
  cloudCsrfToken = result.csrf_token;
}

async function saveCloudWorkspace() {
  if (!CLOUD_MODE || cloudSaveInFlight) return;
  cloudSaveInFlight = true;
  const indicator = $("#saveIndicator");
  try {
    const response = await apiFetch("/api/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": cloudCsrfToken },
      body: JSON.stringify({ workspace: state.workspace, revision: cloudRevision }),
    });
    const result = await response.json();
    if (response.status === 409) {
      const localWorkspace = normalizeWorkspace(state.workspace);
      await loadCloudWorkspace();
      state.workspace = mergeWorkspaces(state.workspace, localWorkspace);
      localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
      cloudSaveInFlight = false;
      showToast("已逐筆合併另一台裝置的更新");
      await saveCloudWorkspace();
      render();
      return;
    }
    if (!response.ok) throw new Error(result.error || "同步失敗");
    cloudRevision = result.revision;
    localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
    if (indicator) indicator.textContent = "已同步雲端";
  } catch (error) {
    localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
    if (indicator) indicator.textContent = navigator.onLine ? "同步失敗" : "離線保存中";
    showToast(navigator.onLine ? error.message : "目前離線，資料已保存在這台裝置");
  } finally {
    cloudSaveInFlight = false;
  }
}

function uid(prefix = "id") {
  if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeWorkspace(value) {
  const data = value && typeof value === "object" ? value : emptyWorkspace();
  return {
    ...emptyWorkspace(),
    ...data,
    settings: { ...emptyWorkspace().settings, ...(data.settings || {}) },
    projects: Array.isArray(data.projects) ? data.projects : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    checklists: Array.isArray(data.checklists) ? data.checklists : [],
    progress_logs: Array.isArray(data.progress_logs) ? data.progress_logs : [],
    project_messages: Array.isArray(data.project_messages) ? data.project_messages : [],
    history: Array.isArray(data.history) ? data.history : [],
    archives: Array.isArray(data.archives) ? data.archives : [],
    deleted_ids: data.deleted_ids && typeof data.deleted_ids === "object" ? data.deleted_ids : {},
  };
}

function mergeWorkspaces(remoteValue, localValue) {
  const remote = normalizeWorkspace(remoteValue);
  const local = normalizeWorkspace(localValue);
  const deleted = { ...remote.deleted_ids, ...local.deleted_ids };
  const mergeById = (remoteItems, localItems) => {
    const keyOf = (item) => item.id || `${item.project_id || ""}|${item.time || item.date || ""}|${item.text || item.msg || item.title || ""}`;
    const items = new Map(remoteItems.map((item) => [keyOf(item), item]));
    localItems.forEach((item) => { const key = keyOf(item); items.set(key, { ...(items.get(key) || {}), ...item }); });
    return [...items.values()].filter((item) => !deleted[item.id]);
  };
  return normalizeWorkspace({
    ...remote,
    settings: { ...remote.settings, ...local.settings },
    projects: mergeById(remote.projects, local.projects),
    tasks: mergeById(remote.tasks, local.tasks),
    checklists: mergeById(remote.checklists, local.checklists),
    progress_logs: mergeById(remote.progress_logs, local.progress_logs),
    project_messages: mergeById(remote.project_messages, local.project_messages),
    history: mergeById(remote.history, local.history),
    archives: mergeById(remote.archives, local.archives),
    deleted_ids: deleted,
  });
}

function markDeleted(id) {
  if (!id) return;
  state.workspace.deleted_ids[id] = new Date().toISOString();
}

function todayISO() {
  return dateISO(new Date());
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function humanDate(value) {
  const date = parseDate(value);
  if (!date) return "未設定";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function projectById(id) {
  return state.workspace.projects.find((project) => project.id === id);
}

function checklistGroups(projectId) {
  return state.workspace.checklists.filter((group) => group.project_id === projectId);
}

function progressLogs(projectId) {
  return state.workspace.progress_logs
    .filter((log) => log.project_id === projectId)
    .sort((a, b) => `${b.date || ""} ${b.created_at || ""}`.localeCompare(`${a.date || ""} ${a.created_at || ""}`));
}

function projectMessages(projectId) {
  return state.workspace.project_messages
    .filter((message) => message.project_id === projectId)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function tasksForProject(projectId) {
  return state.workspace.tasks.filter((task) => task.project_id === projectId);
}

function pendingTasks() {
  return state.workspace.tasks.filter((task) => task.status !== STATUS_COMPLETED);
}

function todayTasks() {
  const today = todayISO();
  return pendingTasks()
    .filter((task) => task.date === today && task.task_type !== TASK_TYPE_PHONE)
    .sort(sortTasks);
}

function priorityTasks() {
  return pendingTasks()
    .filter((task) => task.task_type !== TASK_TYPE_PHONE)
    .sort((a, b) => {
      const aDate = a.date || "9999-12-31";
      const bDate = b.date || "9999-12-31";
      return `${aDate} ${a.time || ""}`.localeCompare(`${bDate} ${b.time || ""}`, "zh-Hant");
    });
}

function todayPhoneTasks() {
  const today = todayISO();
  return state.workspace.tasks
    .filter((task) => task.task_type === TASK_TYPE_PHONE && task.date === today)
    .sort((a, b) => Number(a.status === STATUS_COMPLETED) - Number(b.status === STATUS_COMPLETED) || sortTasks(a, b));
}

function overdueTasks() {
  const today = todayISO();
  return pendingTasks().filter((task) => task.date && task.date < today).sort(sortTasks);
}

function sortTasks(a, b) {
  return `${a.date || "9999-12-31"} ${a.time || ""}`.localeCompare(`${b.date || "9999-12-31"} ${b.time || ""}`, "zh-Hant");
}

function projectProgress(project) {
  const tasks = tasksForProject(project.id);
  const checks = state.workspace.checklists
    .filter((group) => group.project_id === project.id)
    .flatMap((group) => group.items || []);
  const units = [
    ...tasks.map((task) => task.status === STATUS_COMPLETED),
    ...checks.map((item) => Boolean(item.done)),
  ];
  if (!units.length) return 0;
  return Math.round((units.filter(Boolean).length / units.length) * 100);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pill(label, tone = "") {
  return `<span class="pill ${tone}">${escapeHTML(label)}</span>`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function setPage(page) {
  state.page = page;
  if (page !== "search") {
    state.globalQuery = "";
    if ($("#globalSearch")) $("#globalSearch").value = "";
  }
  render();
}

function renderNav() {
  const activePage = state.page === "projectDetail" ? "projects" : state.page;
  const html = NAV_ITEMS.map((item) => `
    <button class="nav-button ${activePage === item.id ? "active" : ""}" data-page="${item.id}">
      <span>${item.icon}</span><span>${item.label}</span>
    </button>
  `).join("");
  $("#desktopNav").innerHTML = html;
  $("#mobileNav").innerHTML = NAV_ITEMS.map((item) => `
    <button class="${activePage === item.id ? "active" : ""}" data-page="${item.id}">
      <span>${item.icon}</span><span>${item.label}</span>
    </button>
  `).join("");
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => setPage(button.dataset.page));
  });
}

function render() {
  renderNav();
  const item = NAV_ITEMS.find((entry) => entry.id === state.page) || NAV_ITEMS[0];
  const selectedProject = projectById(state.selectedProjectId);
  $("#pageTitle").textContent = state.page === "search" ? "全站搜尋" : state.page === "projectDetail" && selectedProject
    ? selectedProject.course || "專案內容"
    : item.title;
  $("#todayLabel").textContent = new Intl.DateTimeFormat("zh-Hant", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  const renderers = {
    dashboard: renderDashboard,
    projects: renderProjects,
    projectDetail: renderProjectDetail,
    calendar: renderCalendar,
    phone: renderPhone,
    settings: renderSettings,
    search: renderGlobalSearch,
  };
  $("#content").innerHTML = (renderers[state.page] || renderDashboard)();
  bindContentEvents();
}

function renderGlobalSearch() {
  const query = state.globalQuery.trim().toLowerCase();
  if (!query) return `<section class="card"><p class="muted">輸入關鍵字即可搜尋所有資料。</p></section>`;
  const includes = (...values) => values.join(" ").toLowerCase().includes(query);
  const results = [];
  state.workspace.projects.forEach((project) => {
    if (includes(project.teacher || "", project.course || "", project.current_stage || "")) results.push({ type: "專案", title: project.course || "未命名專案", detail: project.teacher || "", project_id: project.id });
  });
  state.workspace.tasks.forEach((task) => {
    if (includes(task.title || "", task.note || "", projectById(task.project_id)?.course || "")) results.push({ type: "工作", title: task.title || "未命名工作", detail: `${task.date || "未排日期"} ${task.time || ""}`, task_id: task.id });
  });
  state.workspace.project_messages.forEach((message) => {
    if (includes(message.text || "")) results.push({ type: "留言", title: message.text || "", detail: projectById(message.project_id)?.course || "", project_id: message.project_id });
  });
  state.workspace.checklists.forEach((group) => (group.items || []).forEach((item) => {
    if (includes(group.name || "", item.title || "")) results.push({ type: "清單", title: item.title || "", detail: group.name || "", project_id: group.project_id });
  }));
  state.workspace.history.forEach((item) => {
    if (includes(item.text || item.msg || "")) results.push({ type: "紀錄", title: item.text || item.msg || "", detail: String(item.time || "").replace("T", " "), project_id: item.project_id });
  });
  return `<section class="card search-results-page">
    <div class="card-header"><div><h3>搜尋結果</h3><p class="muted">找到 ${results.length} 筆資料</p></div><button class="ghost-button" data-search-close>返回</button></div>
    <div class="search-result-list">${results.slice(0, 100).map((item) => `<button class="search-result-row" ${item.task_id ? `data-task-edit="${escapeHTML(item.task_id)}"` : item.project_id ? `data-project-open="${escapeHTML(item.project_id)}"` : ""}><span class="pill">${escapeHTML(item.type)}</span><span><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.detail)}</small></span></button>`).join("") || `<p class="muted">沒有符合的資料。</p>`}</div>
  </section>`;
}

function renderDashboard() {
  const currentMonth = monthKey(new Date());
  const targetProjects = state.workspace.projects
    .filter((project) => project.target_month === currentMonth && project.role === "正式")
    .sort((a, b) => `${a.target_date || "9999-12-31"} ${a.course || ""}`.localeCompare(`${b.target_date || "9999-12-31"} ${b.course || ""}`, "zh-Hant"));
  const launched = targetProjects.filter((project) => ["已上架", "已完成"].includes(project.status) || project.current_stage === "已完成");
  const inProgress = targetProjects.filter((project) => !launched.includes(project));
  const monthGoal = Number(state.workspace.settings.monthly_goal ?? 2);
  const remaining = Math.max(0, monthGoal - launched.length);
  const today = new Date();
  const tasks = todayTasks().slice(0, 8);
  return `
    <div class="desktop-page-title">
      <div>
        <h2>${escapeHTML(monthLabel(currentMonth))}營運首頁</h2>
        <p class="muted">早上打開先看本月上架目標、今日電話聯繫與今日工作。</p>
      </div>
      <button class="primary-button" data-new-project>新增課程專案</button>
    </div>
    <section class="goal-card">
      <div class="goal-head">
        <h3>本月課程上架目標</h3>
        <button class="ghost-button" data-page="settings">調整目標</button>
      </div>
      <div class="goal-number-row">
        <strong>${monthGoal}</strong>
        <span>門課程</span>
      </div>
      <p class="goal-summary">本月目標：${monthGoal} 門｜已完成：${launched.length} 門｜進行中：${inProgress.length} 門｜尚需完成：${remaining} 門</p>
    </section>
    <div class="home-body">
      <section class="home-panel formal-panel">
        <h3>本月正式課程</h3>
        <p class="muted panel-subtitle">只列出本月真正要推進上架的正式課程。</p>
        <div class="list">${homeProjectCards(targetProjects)}</div>
      </section>
      <section class="home-panel">
        <div class="panel-title-row">
          <h3>今日電話聯繫</h3>
          <button class="primary-button small-primary">新增電話</button>
        </div>
        <p class="muted panel-subtitle">${today.getMonth() + 1}/${today.getDate()}，待聯繫排前面，完成後保留到今天結束。</p>
        <div class="list">${taskList(todayPhoneTasks().slice(0, 8), "今天尚未安排電話聯繫。", true)}</div>
      </section>
      <section class="home-panel">
        <h3>今日工作</h3>
        <p class="muted panel-subtitle">${today.getMonth() + 1}/${today.getDate()}，電話聯繫已獨立顯示，其餘工作依時間排序。</p>
        ${tasks[0] ? `<p class="priority-line">今日優先：${escapeHTML(tasks[0].title || "未命名工作")}${projectById(tasks[0].project_id) ? `｜${escapeHTML(projectById(tasks[0].project_id).course || "")}` : ""}</p>` : ""}
        <div class="list">${homeTaskRows(tasks, "今天尚未安排其他工作。")}</div>
        <button class="primary-button weekly-button" data-page="calendar">本週任務狀態</button>
      </section>
    </div>
  `;
}

function monthLabel(key) {
  const [year, month] = key.split("-");
  return `${Number(year)} 年 ${Number(month)} 月`;
}

function projectSimpleStatus(project) {
  const tasks = tasksForProject(project.id).filter((task) => task.status !== STATUS_COMPLETED);
  if (["已上架", "已完成"].includes(project.status) || project.current_stage === "已完成") return "已完成";
  if (project.waiting_for || tasks.some((task) => task.status === STATUS_WAITING)) return "需追蹤";
  if (tasks.some((task) => task.date && task.date < todayISO())) return "卡住";
  if (project.current_stage === "課程上架") return "可上架";
  return "順利";
}

function homeProjectCards(projects) {
  if (!projects.length) return `<p class="empty-green">本月尚未指定正式課程。</p>`;
  return projects.map((project) => {
    const status = projectSimpleStatus(project);
    const tone = status === "已完成" || status === "順利" || status === "可上架" ? "green" : status === "需追蹤" ? "amber" : "red";
    const tasks = tasksForProject(project.id).filter((task) => task.status !== STATUS_COMPLETED).sort(sortTasks);
    const next = tasks[0];
    const lastMessage = projectMessages(project.id)[0]?.text || progressLogs(project.id)[0]?.text || "";
    return `
      <article class="home-project-card" data-project-open="${escapeHTML(project.id)}">
        <div class="item-row">
          <h4>${escapeHTML(project.teacher || "未設定老師")}｜${escapeHTML(project.course || "未命名課程")}</h4>
          ${pill(status, tone)}
        </div>
        <p class="muted">目前階段：${escapeHTML(project.current_stage || "未設定")}</p>
        <p class="next-line">下一步行動：${next ? `${humanDate(next.date)}　${escapeHTML(next.title || "未命名工作")}` : "尚未排程　目前沒有未完成工作"}</p>
        ${lastMessage ? `<p class="muted">最後紀錄：${escapeHTML(String(lastMessage).replaceAll("\\n", " ").slice(0, 42))}</p>` : ""}
        <div class="home-project-actions">
          <button class="ghost-button" data-project-open="${escapeHTML(project.id)}">查看專案</button>
          <button class="primary-button small-primary">新增紀錄</button>
        </div>
      </article>
    `;
  }).join("");
}

function homeTaskRows(tasks, emptyText) {
  if (!tasks.length) return `<p class="empty-green">${emptyText}</p>`;
  return tasks.map((task) => {
    const project = projectById(task.project_id);
    const statusTone = task.status === STATUS_WAITING ? "amber" : task.date && task.date < todayISO() ? "red" : "muted-dot";
    return `
      <div class="home-task-row">
        <span class="task-dot ${statusTone}">○</span>
        <div>
          <strong>${escapeHTML(task.title || "未命名工作")}</strong>
          <p class="muted">截止：${humanDate(task.date)} ${escapeHTML(task.time || "")}${project ? `｜${escapeHTML(project.course || "")}` : ""}</p>
        </div>
      </div>
    `;
  }).join("");
}

function pipelineColumn(role) {
  const projects = state.workspace.projects.filter((project) => (project.role || "未設定") === role);
  return `
    <div class="pipeline-column">
      <div class="item-row">
        <strong>${escapeHTML(role)}</strong>
        ${pill(projects.length)}
      </div>
      <div class="list">
        ${projects.slice(0, 5).map((project) => `
          <button class="pipeline-item" data-project-open="${escapeHTML(project.id)}">
            <span>${escapeHTML(project.teacher || "未設定老師")}</span>
            <strong>${escapeHTML(project.course || "未命名課程")}</strong>
            <small>${escapeHTML(project.current_stage || "未設定")} · ${humanDate(project.target_date)}</small>
          </button>
        `).join("") || `<p class="muted">沒有專案</p>`}
      </div>
    </div>
  `;
}

function metric(label, value, note) {
  return `<div class="metric"><p class="muted">${escapeHTML(label)}</p><strong>${escapeHTML(value)}</strong><p class="muted">${escapeHTML(note)}</p></div>`;
}

function renderProjects() {
  const query = state.query.trim().toLowerCase();
  const currentMonth = monthKey(new Date());
  const projects = state.workspace.projects.filter((project) => {
    const haystack = `${project.teacher || ""} ${project.course || ""} ${(project.tags || []).join(" ")}`.toLowerCase();
    const mode = project.mode === "live" ? "直播" : "錄播";
    return (!query || haystack.includes(query))
      && (state.projectRoleFilter === "全部" || project.role === state.projectRoleFilter)
      && (state.projectModeFilter === "全部類型" || mode === state.projectModeFilter)
      && (!state.hideCompletedProjects || !projectFinished(project));
  }).sort((a, b) => projectSortRank(a, currentMonth) - projectSortRank(b, currentMonth)
    || String(a.target_month || "9999-99").localeCompare(String(b.target_month || "9999-99"))
    || String(a.target_date || "9999-12-31").localeCompare(String(b.target_date || "9999-12-31")));
  return `
    <div class="desktop-page-title project-page-title">
      <div>
        <h2>課程專案</h2>
        <p class="muted">依目標月份與角色管理正式、候補、觀察及下月前置課程。</p>
      </div>
      <button class="primary-button" data-new-project>新增課程專案</button>
    </div>
    <div class="project-filters">
      <input class="search-input" id="projectSearch" value="${escapeHTML(state.query)}" placeholder="搜尋老師或課程">
      <select class="select" id="projectRoleFilter" aria-label="角色篩選">
        ${["全部", "正式", "候補", "觀察", "下月前置"].map((value) => `<option ${state.projectRoleFilter === value ? "selected" : ""}>${value}</option>`).join("")}
      </select>
      <select class="select" id="projectModeFilter" aria-label="類型篩選">
        ${["全部類型", "錄播", "直播"].map((value) => `<option ${state.projectModeFilter === value ? "selected" : ""}>${value}</option>`).join("")}
      </select>
      <button class="ghost-button completed-project-toggle ${state.hideCompletedProjects ? "active" : ""}" data-hide-completed aria-pressed="${state.hideCompletedProjects}">
        ${state.hideCompletedProjects ? "顯示已完成" : "隱藏已完成"}
      </button>
    </div>
    <div class="project-list-grid">
      ${projectCards(projects, "沒有符合條件的課程專案。")}
    </div>
  `;
}

function projectDeferred(project) {
  return project.status === "已放棄"
    || project.current_stage === "已放棄"
    || project.cooperation_status === "暫緩";
}

function projectSortRank(project, currentMonth) {
  if (projectFinished(project)) return 3;
  if (projectDeferred(project)) return 2;
  if (project.target_month === currentMonth) return 0;
  return 1;
}

function projectFinished(project) {
  return ["已上架", "已完成", "已封存"].includes(project.status)
    || ["已上架", "已完成"].includes(project.current_stage);
}

function projectRisk(project) {
  if (projectFinished(project)) return { label: "已完成｜此專案結束", tone: "green" };
  const due = parseDate(project.target_date);
  const pending = tasksForProject(project.id).filter((task) => task.status !== STATUS_COMPLETED);
  const overdue = pending.some((task) => task.date && task.date < todayISO());
  if (overdue || (due && Math.ceil((due - new Date()) / 86400000) <= 7)) return { label: "立即處理", tone: "red" };
  if (project.waiting_for || project.cooperation_status === "需觀察") return { label: "需要關注", tone: "amber" };
  return { label: "進度正常", tone: "green" };
}

function projectNextStep(project) {
  const pending = tasksForProject(project.id).filter((task) => task.status !== STATUS_COMPLETED).sort(sortTasks);
  const task = pending[0];
  return {
    title: task?.title || project.next_step || "目前沒有未完成工作",
    date: task?.date || project.next_step_date || "",
  };
}

function projectCards(projects, emptyText) {
  if (!projects.length) return `<div class="project-empty card"><p class="muted">${escapeHTML(emptyText)}</p></div>`;
  return projects.map((project) => {
    const finished = projectFinished(project);
    const risk = projectRisk(project);
    const next = projectNextStep(project);
    const mode = project.mode === "live" ? "直播" : "錄播";
    const cooperation = project.cooperation_status || "順利";
    const meta = cooperation === "順利" ? `${project.teacher || "未設定老師"}｜${mode}` : `${project.teacher || "未設定老師"}｜${mode}｜合作：${cooperation}`;
    const badge = finished ? "已完成｜此專案結束" : `${String(project.target_month || "未設定").replace("-", "/")} ${project.role || ROLE_UNSET}`;
    return `
      <article class="desktop-project-card ${finished ? "finished" : ""}">
        <div class="project-card-head">
          <div>
            <h3>${escapeHTML(project.course || "未命名課程")}</h3>
            <p class="project-meta ${cooperation === "需觀察" ? "amber-text" : cooperation === "暫緩" ? "red-text" : "muted"}">${escapeHTML(meta)}</p>
          </div>
          ${pill(badge, finished ? "green" : "")}
        </div>
        <p class="project-stage-line ${risk.tone}-text">${finished ? "此專案已結束，不再列入待處理工作" : `目前階段：${escapeHTML(project.current_stage || "未設定")}　狀態：${escapeHTML(risk.label)}`}</p>
        <p class="project-next-line ${finished ? "muted" : next.date ? "primary-text" : "red-text"}">${finished
          ? `完成日期：${humanDate(project.completed_date || project.target_date)}`
          : `下一步（自動）：${next.date ? humanDate(next.date) : "尚未排程"}　${escapeHTML(next.title)}`}</p>
        <div class="project-card-actions">
          <button class="primary-button small-project-button" data-project-open="${escapeHTML(project.id)}">開啟專案</button>
          <button class="ghost-button small-project-button" data-project-edit="${escapeHTML(project.id)}">編輯資料</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderProjectDetail() {
  const project = projectById(state.selectedProjectId);
  if (!project) {
    state.page = "projects";
    return `<p class="muted">找不到這個專案。</p>`;
  }
  const finished = projectFinished(project);
  const risk = projectRisk(project);
  const next = projectNextStep(project);
  const mode = project.mode === "live" ? "直播" : "錄播";
  const cooperation = project.cooperation_status || "順利";
  const pending = tasksForProject(project.id).filter((task) => task.status !== STATUS_COMPLETED).sort(sortTasks);
  const completed = tasksForProject(project.id).filter((task) => task.status === STATUS_COMPLETED).sort(sortTasks);
  const groups = checklistGroups(project.id);
  const messages = projectMessages(project.id).slice(0, 8);
  const history = state.workspace.history.filter((item) => item.project_id === project.id && importantHistory(item)).slice(0, 5);
  const links = project.links || {};
  const selectedCount = [...state.selectedTaskIds].filter((id) => pending.some((task) => task.id === id)).length;
  return `
    <section class="project-summary-card">
      <div class="project-summary-main">
        <h2>${escapeHTML(project.teacher || "未設定老師")}｜${escapeHTML(project.course || "未命名課程")}</h2>
        <p class="summary-meta ${cooperation === "需觀察" ? "amber-text" : cooperation === "暫緩" ? "red-text" : "primary-text"}">${escapeHTML(project.target_month || "未設定")}　${escapeHTML(project.role || ROLE_UNSET)}　｜　${mode}${cooperation === "順利" ? "" : `　｜　合作：${escapeHTML(cooperation)}`}</p>
        <p>預計上架 ${humanDate(project.target_date)}　｜　目前階段 ${escapeHTML(project.current_stage || "未設定")}</p>
        <p class="summary-next ${finished ? "green-text" : next.date ? "primary-text" : "red-text"}">${finished
          ? `此專案已完成結束｜完成日期 ${humanDate(project.completed_date || project.target_date)}`
          : `下一步（自動）：${next.date ? humanDate(next.date) : "尚未排程"}　${escapeHTML(next.title)}`}</p>
        <p class="${project.waiting_for ? "amber-text" : "muted"}">等待對象：${escapeHTML(project.waiting_for || "無")}</p>
      </div>
      <div class="project-summary-actions">
        ${pill(finished ? "已完成｜此專案結束" : risk.label, finished ? "green" : risk.tone)}
        <div class="toolbar summary-buttons">
          <button class="ghost-button" data-task-add="${escapeHTML(project.id)}">新增工作</button>
          <button class="ghost-button" data-project-edit="${escapeHTML(project.id)}">編輯專案</button>
          ${links["雲端資料夾"] ? `<button class="ghost-button" data-open-url="${escapeHTML(links["雲端資料夾"])}">開啟雲端</button>` : ""}
          ${links["課程頁"] ? `<button class="ghost-button" data-open-url="${escapeHTML(links["課程頁"])}">開啟課程頁</button>` : ""}
        </div>
      </div>
    </section>
    <div class="project-detail-columns">
      <section class="project-work-card">
        <div class="detail-card-header">
          <div><h3>工作排程</h3><p class="muted">所有日期、狀態與下一步都以這裡為準；可勾選後批次刪除。</p></div>
          <div class="toolbar">
            <button class="danger-button" data-delete-selected ${selectedCount ? "" : "disabled"}>${selectedCount ? `刪除已選 (${selectedCount})` : "刪除已選"}</button>
            <button class="primary-button" data-task-add="${escapeHTML(project.id)}">新增工作排程</button>
          </div>
        </div>
        <div class="compact-list">
          ${pending.map(renderProjectTask).join("") || `<p class="muted empty-detail">目前沒有未完成工作。</p>`}
          ${completed.length ? `<div class="completed-toggle"><strong>已完成（${completed.length}）</strong><button class="ghost-button" data-toggle-completed="${escapeHTML(project.id)}">${state.expandedCompletedProjectIds.has(project.id) ? "收起" : "展開"}</button></div>` : ""}
          ${state.expandedCompletedProjectIds.has(project.id) ? completed.map(renderCompletedProjectTask).join("") : ""}
        </div>
      </section>
      <section class="project-work-card">
        <div class="detail-card-header">
          <div><h3>檢查清單</h3><p class="muted">確認完整度，不進入月曆。</p></div>
          <div class="toolbar">
            <button class="ghost-button" data-template-import>匯入範本</button>
            <button class="ghost-button" data-template-save>儲存為範本</button>
            <button class="primary-button" data-check-add="${escapeHTML(project.id)}">新增清單項目</button>
          </div>
        </div>
        <div class="checklist-detail-list">
          ${groups.map(renderProjectChecklistGroup).join("") || `<p class="muted empty-detail">尚未建立檢查清單。</p>`}
        </div>
      </section>
    </div>
    <section class="project-board-card">
      <div><h3>留言板</h3><p class="muted">記錄跟老師說了什麼、目前狀況；送出時會自動加上日期時間。</p></div>
      <form class="message-compose" id="messageForm">
        <textarea class="textarea" name="message" rows="3" aria-label="留言內容"></textarea>
        <button class="primary-button" type="submit">新增留言</button>
      </form>
      <div class="message-list">${messages.map((message) => `<div class="message-row"><span>${escapeHTML((message.time || message.created_at || "").replace("T", " ").slice(0, 16))}　${escapeHTML(message.text || "")}</span><button class="danger-button" data-message-delete="${escapeHTML(message.id)}">刪除</button></div>`).join("") || `<p class="muted">尚無留言。</p>`}</div>
    </section>
    <section class="project-history-card">
      <h3>重要紀錄</h3>
      ${history.map((item) => `<p class="muted">${escapeHTML((item.time || "").replace("T", " "))}　${escapeHTML(item.text || item.msg || "")}</p>`).join("") || `<p class="muted">尚無重要紀錄。</p>`}
    </section>
  `;
}

function renderProjectTask(task) {
  const selected = state.selectedTaskIds.has(task.id);
  const status = task.status === STATUS_WAITING ? "等待中" : "未完成";
  return `<div class="compact-task-row">
    <input type="checkbox" data-task-select="${escapeHTML(task.id)}" ${selected ? "checked" : ""} aria-label="選取工作">
    <div><strong class="${task.status === STATUS_WAITING ? "amber-text" : ""}">${status}　${escapeHTML(task.title || "未命名工作")}</strong><small>${humanDate(task.date)} ${escapeHTML(task.time || "")}</small></div>
    <div class="toolbar"><button class="primary-button compact-button" data-complete="${escapeHTML(task.id)}">完成</button><button class="ghost-button compact-button" data-postpone="${escapeHTML(task.id)}">延後</button><button class="ghost-button compact-button" data-task-edit="${escapeHTML(task.id)}">編輯</button></div>
  </div>`;
}

function renderCompletedProjectTask(task) {
  return `<div class="completed-task-row"><strong>${escapeHTML(task.title || "未命名工作")}</strong><small>完成於 ${humanDate((task.completed_at || "").slice(0, 10) || task.date)}</small></div>`;
}

function renderProjectChecklistGroup(group) {
  const items = group.items || [];
  const done = items.filter((item) => item.done).length;
  return `<div class="checklist-group-detail">
    <div class="checklist-group-head"><strong>${escapeHTML(group.name || "未命名清單")}</strong><div class="toolbar"><button class="ghost-button compact-button" data-check-add="${escapeHTML(group.project_id)}" data-group-id="${escapeHTML(group.id)}">＋子項目</button><button class="ghost-button compact-button" data-group-rename="${escapeHTML(group.id)}">重新命名</button><button class="danger-button compact-button" data-group-delete="${escapeHTML(group.id)}">刪除清單</button><span class="primary-text">${done}/${items.length}</span></div></div>
    ${items.map((item) => `<div class="checklist-item-detail"><input type="checkbox" data-check-toggle="${escapeHTML(item.id)}" data-group-id="${escapeHTML(group.id)}" ${item.done ? "checked" : ""}><span class="${item.done ? "done-text" : ""}">${escapeHTML(item.title || "")}</span>${item.done ? "" : `<button class="ghost-button compact-button" data-check-schedule="${escapeHTML(item.id)}" data-group-id="${escapeHTML(group.id)}">排程</button>`}<button class="danger-button compact-button" data-check-delete="${escapeHTML(item.id)}" data-group-id="${escapeHTML(group.id)}">刪除</button></div>`).join("")}
  </div>`;
}

function importantHistory(item) {
  const type = String(item.type || "");
  const text = String(item.text || item.msg || "");
  return ["delivery", "status", "stage"].includes(type) || ["收到回覆", "等待老師", "完成工作", "正式上架", "上架日", "目標月份", "課程角色", "建立專案時套用"].some((key) => text.includes(key));
}

function miniStat(label, value) {
  return `<div><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
}

function deliverySummary(project) {
  const promised = Number(project.commitment_total || 0);
  const received = Number(project.received_total || 0);
  if (!promised && !received) return project.current_status_note || "尚未設定交付堂數";
  return `已收到 ${received} / 承諾 ${promised} 堂`;
}

function renderChecklistGroup(group) {
  const items = group.items || [];
  const done = items.filter((item) => item.done).length;
  return `
    <div class="check-group">
      <div class="item-row"><strong>${escapeHTML(group.name || "未命名清單")}</strong><span class="muted">${done}/${items.length}</span></div>
      ${items.slice(0, 5).map((item) => `<div class="check-item ${item.done ? "done" : ""}"><span>${item.done ? "✓" : "○"}</span>${escapeHTML(item.title || "")}</div>`).join("")}
    </div>
  `;
}

function taskList(tasks, emptyText, phoneMode = false) {
  if (!tasks.length) return `<p class="muted">${emptyText}</p>`;
  return tasks.map((task) => {
    const project = projectById(task.project_id);
    const completed = task.status === STATUS_COMPLETED || task.phone_status === "已聯繫";
    const statusTone = completed ? "green" : task.status === STATUS_WAITING ? "amber" : task.date && task.date < todayISO() ? "red" : "";
    return `
      <article class="item-card">
        <div class="item-row">
          <div>
            <p class="item-title">${escapeHTML(task.title || "未命名工作")}</p>
            <div class="item-meta">
              <span>${humanDate(task.date)}</span>
              ${task.time ? `<span>${escapeHTML(task.time)}</span>` : ""}
              <span>${escapeHTML(project ? project.course : "我的工作")}</span>
              ${task.reminder_minutes !== undefined && task.reminder_minutes !== "" ? `<span>${escapeHTML(reminderLabel(task.reminder_minutes))}</span>` : ""}
              ${task.recurrence && task.recurrence !== "none" ? `<span>${escapeHTML(({ daily: "每天重複", weekly: "每週重複", monthly: "每月重複" })[task.recurrence] || "重複工作")}</span>` : ""}
            </div>
            ${task.note ? `<p class="task-note">${escapeHTML(task.note)}</p>` : ""}
          </div>
          ${pill(phoneMode ? task.phone_status || "待聯繫" : task.status || "未完成", statusTone)}
        </div>
        <div class="toolbar">
          ${phoneMode ? "" : `<button class="small-button" data-task-edit="${escapeHTML(task.id)}">編輯</button>`}
          ${completed ? "" : `<button class="small-button" data-complete="${escapeHTML(task.id)}">完成</button>`}
          ${phoneMode ? `<button class="small-button" data-phone="${escapeHTML(task.id)}" data-status="已聯繫">已聯繫</button><button class="small-button" data-phone="${escapeHTML(task.id)}" data-status="待回覆">待回覆</button>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function reminderLabel(value) {
  return ({ "0": "準時提醒", "10": "提前 10 分鐘", "60": "提前 1 小時", "1440": "提前 1 天" })[String(value)] || "已設定提醒";
}

function calendarTaskMatches(task) {
  const query = state.calendarQuery.trim().toLowerCase();
  const project = projectById(task.project_id);
  const statusMatches = state.calendarStatusFilter === "全部"
    || (state.calendarStatusFilter === "未完成" && task.status !== STATUS_COMPLETED)
    || (state.calendarStatusFilter === "已完成" && task.status === STATUS_COMPLETED);
  return statusMatches && (!query || `${task.title || ""} ${task.note || ""} ${project?.course || ""}`.toLowerCase().includes(query));
}

function tasksOnDate(iso) {
  return state.workspace.tasks.filter((task) => task.date === iso && calendarTaskMatches(task)).sort(sortTasks);
}

function calendarEvent(task, extraClass = "") {
  return `<button type="button" draggable="true" class="calendar-event ${extraClass} ${task.status === STATUS_COMPLETED ? "completed" : ""}" data-calendar-task="${escapeHTML(task.id)}" title="拖曳以調整日期或時間"><b>${escapeHTML(task.time || "全天")}</b>${escapeHTML(task.title || "未命名工作")}</button>`;
}

function renderCalendar() {
  const anchor = parseDate(state.selectedCalendarDate) || new Date();
  const selectedDate = dateISO(anchor);
  const selectedTasks = tasksOnDate(selectedDate);
  const selectedDateLabel = new Intl.DateTimeFormat("zh-Hant", { month: "long", day: "numeric", weekday: "long" }).format(anchor);
  const viewLabels = { month: "月", week: "週", day: "日" };
  const title = state.calendarView === "month"
    ? `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`
    : state.calendarView === "week" ? weekRangeLabel(anchor) : selectedDateLabel;
  return `<section class="card calendar-card">
    <div class="card-header calendar-main-header">
      <div><h3>${escapeHTML(title)}</h3><p class="muted">${selectedTasks.length} 件所選日期工作</p></div>
      <div class="calendar-header-actions">
        <div class="segmented-control">${Object.entries(viewLabels).map(([value, label]) => `<button class="${state.calendarView === value ? "active" : ""}" data-calendar-view="${value}">${label}</button>`).join("")}</div>
        <div class="toolbar"><button class="small-button" data-period="-1">上一${viewLabels[state.calendarView]}</button><button class="small-button" data-period="0">今天</button><button class="small-button" data-period="1">下一${viewLabels[state.calendarView]}</button></div>
      </div>
    </div>
    <div class="calendar-filters">
      <input class="search-input" id="calendarSearch" value="${escapeHTML(state.calendarQuery)}" placeholder="搜尋工作、課程或備註">
      <select class="select" id="calendarStatusFilter" aria-label="工作狀態篩選">${["全部", "未完成", "已完成"].map((value) => `<option ${state.calendarStatusFilter === value ? "selected" : ""}>${value}</option>`).join("")}</select>
      <button class="primary-button" data-calendar-add="${escapeHTML(selectedDate)}">新增工作</button>
    </div>
    <div class="grid calendar-layout ${state.calendarView}-view-layout">
      <div class="calendar-view-main">${state.calendarView === "month" ? renderMonthCalendar(anchor) : state.calendarView === "week" ? renderWeekCalendar(anchor) : renderDayCalendar(anchor)}</div>
      <aside class="calendar-day-panel" aria-live="polite">
        <div class="calendar-day-header"><div><p class="calendar-day-kicker">${selectedDate === todayISO() ? "今日工作項目" : "所選日期工作"}</p><h4>${escapeHTML(selectedDateLabel)}</h4></div><div class="toolbar">${pill(`${selectedTasks.length} 件`, selectedTasks.length ? "green" : "gray")}<button class="icon-button calendar-add-button" data-calendar-add="${escapeHTML(selectedDate)}" title="新增工作">＋</button></div></div>
        <div class="list">${taskList(selectedTasks, "這一天沒有排程工作。")}</div>
      </aside>
    </div>
  </section>`;
}

function renderMonthCalendar(anchor) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const cells = Array.from({ length: 42 }, (_, index) => new Date(year, month, index - startOffset + 1));
  return `<div class="calendar-grid">${["日", "一", "二", "三", "四", "五", "六"].map((day) => `<div class="day-name">${day}</div>`).join("")}${cells.map((date) => renderDayCell(date, month)).join("")}</div>`;
}

function renderDayCell(date, displayedMonth) {
  const iso = dateISO(date);
  const tasks = tasksOnDate(iso);
  return `<div class="day-cell ${date.getMonth() !== displayedMonth ? "outside-month" : ""} ${iso === todayISO() ? "today" : ""} ${iso === state.selectedCalendarDate ? "selected" : ""} ${tasks.length ? "has-tasks" : ""}" data-calendar-date="${iso}" data-calendar-drop="${iso}" role="button" tabindex="0" title="單擊選取，雙擊新增工作">
    <div class="day-number"><span>${date.getDate()}</span></div>
    ${tasks.slice(0, 3).map((task) => calendarEvent(task)).join("")}${tasks.length > 3 ? `<span class="calendar-more">另有 ${tasks.length - 3} 件</span>` : ""}
  </div>`;
}

function weekStart(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function weekRangeLabel(date) {
  const start = weekStart(date);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
}

function renderWeekCalendar(anchor) {
  const start = weekStart(anchor);
  const dates = Array.from({ length: 7 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  return `<div class="week-calendar">${dates.map((date) => { const iso = dateISO(date); const tasks = tasksOnDate(iso); return `<section class="week-day ${iso === todayISO() ? "today" : ""}" data-calendar-date="${iso}" data-calendar-drop="${iso}" title="單擊選取，雙擊新增工作"><header><span>${["日", "一", "二", "三", "四", "五", "六"][date.getDay()]}</span><strong>${date.getDate()}</strong></header><div class="week-events">${tasks.map((task) => calendarEvent(task, "week-event")).join("") || `<span class="week-empty">＋</span>`}</div></section>`; }).join("")}</div>`;
}

function renderDayCalendar(anchor) {
  const iso = dateISO(anchor);
  const tasks = tasksOnDate(iso);
  const allDay = tasks.filter((task) => !task.time);
  const hours = Array.from({ length: 16 }, (_, index) => index + 7);
  return `<div class="day-agenda"><div class="all-day-row" data-calendar-drop="${iso}"><strong>全天</strong><div>${allDay.map((task) => calendarEvent(task, "agenda-event")).join("") || `<span class="muted">沒有全天工作</span>`}</div></div>${hours.map((hour) => { const prefix = String(hour).padStart(2, "0"); const hourTasks = tasks.filter((task) => String(task.time || "").startsWith(prefix)); return `<div class="hour-row" data-calendar-drop="${iso}" data-drop-time="${prefix}:00" title="雙擊新增工作"><time>${prefix}:00</time><div>${hourTasks.map((task) => calendarEvent(task, "agenda-event")).join("")}</div></div>`; }).join("")}</div>`;
}

function renderPhone() {
  const phones = state.workspace.tasks.filter((task) => task.task_type === TASK_TYPE_PHONE).sort(sortTasks);
  const today = todayPhoneTasks();
  return `
    <section class="card">
      <div class="card-header">
        <div><h3>電話聯繫</h3><p class="muted">今日 ${today.length} 件，全部 ${phones.length} 件</p></div>
        ${pill(`${today.length} 今日`, "amber")}
      </div>
      <div class="list">${taskList(phones, "目前沒有電話聯繫工作。", true)}</div>
    </section>
  `;
}

function renderSettings() {
  const data = state.workspace;
  const notificationState = !CLOUD_MODE
    ? "部署到 HTTPS 雲端後即可啟用"
    : !("Notification" in window)
      ? "此瀏覽器不支援通知"
      : Notification.permission === "granted"
        ? "這台裝置已允許通知"
        : Notification.permission === "denied" ? "通知已被瀏覽器封鎖" : "尚未啟用";
  return `
    <section class="card">
      <div class="card-header">
        <div><h3>資料設定</h3><p class="muted">${CLOUD_MODE ? "資料會自動同步至雲端" : "目前資料保存在這個瀏覽器"}</p></div>
      </div>
      <div class="grid dashboard-grid">
        <form class="import-panel goal-settings-panel" id="goalSettingsForm">
          <h4>本月上架目標</h4>
          <p class="muted">設定營運首頁要追蹤的課程門數。</p>
          <div class="goal-setting-row">
            <label for="monthlyGoal">目標門數</label>
            <input class="search-input" id="monthlyGoal" name="monthly_goal" type="number" min="0" max="99" step="1" value="${escapeHTML(data.settings.monthly_goal ?? 2)}" required>
            <button class="primary-button" type="submit">儲存目標</button>
          </div>
        </form>
        <div class="import-panel notification-panel">
          <h4>Chrome 到時提醒</h4>
          <p class="muted">${notificationState}</p>
          <div class="toolbar" style="margin-top:12px">
            <button class="primary-button" data-notifications ${!CLOUD_MODE || !("Notification" in window) || Notification.permission === "denied" ? "disabled" : ""}>啟用這台裝置的通知</button>
            <button class="ghost-button" data-test-notification ${Notification.permission === "granted" ? "" : "disabled"}>測試通知</button>
          </div>
        </div>
        <div class="import-panel">
          <h4>匯入桌面版資料</h4>
          <p class="muted">請選擇桌面版匯出的 JSON。ZIP 匯入會在後續雲端版加入。</p>
          <div class="toolbar" style="margin-top:12px">
            <button class="primary-button" data-import>選擇 JSON</button>
            <button class="ghost-button" data-export>匯出目前資料</button>
            <button class="ghost-button" data-export-csv>匯出工作 CSV</button>
          </div>
        </div>
        <div class="import-panel archive-panel">
          <h4>年度備份與封存</h4>
          <p class="muted">先下載完整 JSON，再把指定年度已完成資料移至封存區；可隨時下載或還原。</p>
          <div class="archive-controls">
            <input class="search-input" id="archiveYear" type="number" min="2000" max="2100" value="${new Date().getFullYear() - 1}" aria-label="封存年度">
            <button class="danger-button" data-archive-year>備份並封存</button>
          </div>
          <div class="archive-list">${(data.archives || []).slice().sort((a, b) => Number(b.year) - Number(a.year)).map((archive) => `<div class="archive-row"><div><strong>${escapeHTML(archive.year)} 年封存</strong><p class="muted">${archive.projects?.length || 0} 個專案・${archive.tasks?.length || 0} 件工作・${String(archive.created_at || "").slice(0, 10)}</p></div><div class="toolbar"><button class="small-button" data-archive-download="${escapeHTML(archive.id)}">下載</button><button class="ghost-button" data-archive-restore="${escapeHTML(archive.id)}">還原</button><button class="danger-button" data-archive-delete="${escapeHTML(archive.id)}">刪除</button></div></div>`).join("") || `<p class="muted archive-empty">目前沒有封存資料。</p>`}</div>
        </div>
        <div class="card">
          <h4>資料摘要</h4>
          <div class="list" style="margin-top:10px">
            ${metric("專案", data.projects.length, "projects")}
            ${metric("工作", data.tasks.length, "tasks")}
            ${metric("檢查清單", data.checklists.length, "checklists")}
          </div>
        </div>
      </div>
    </section>
  `;
}

function bindContentEvents() {
  document.querySelectorAll("[data-search-close]").forEach((button) => button.addEventListener("click", () => setPage(state.pageBeforeSearch || "dashboard")));
  const projectSearch = $("#projectSearch");
  if (projectSearch) {
    projectSearch.addEventListener("input", (event) => {
      state.query = event.target.value;
      render();
    });
  }
  const roleFilter = $("#projectRoleFilter");
  if (roleFilter) roleFilter.addEventListener("change", (event) => { state.projectRoleFilter = event.target.value; render(); });
  const modeFilter = $("#projectModeFilter");
  if (modeFilter) modeFilter.addEventListener("change", (event) => { state.projectModeFilter = event.target.value; render(); });
  const hideCompleted = $("[data-hide-completed]");
  if (hideCompleted) hideCompleted.addEventListener("click", () => {
    state.hideCompletedProjects = !state.hideCompletedProjects;
    render();
  });
  const calendarSearch = $("#calendarSearch");
  if (calendarSearch) calendarSearch.addEventListener("input", (event) => {
    state.calendarQuery = event.target.value;
    render();
    $("#calendarSearch")?.focus();
  });
  const calendarStatusFilter = $("#calendarStatusFilter");
  if (calendarStatusFilter) calendarStatusFilter.addEventListener("change", (event) => {
    state.calendarStatusFilter = event.target.value;
    render();
  });

  document.querySelectorAll("[data-project-open]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedProjectId = button.dataset.projectOpen;
      state.page = "projectDetail";
      render();
    });
  });

  document.querySelectorAll("[data-project-edit]").forEach((button) => button.addEventListener("click", () => openProjectDialog(projectById(button.dataset.projectEdit))));

  document.querySelectorAll("#content [data-page]").forEach((button) => {
    button.addEventListener("click", () => setPage(button.dataset.page));
  });

  document.querySelectorAll("[data-new-project]").forEach((button) => {
    button.addEventListener("click", () => openProjectDialog());
  });

  document.querySelectorAll("[data-task-add]").forEach((button) => button.addEventListener("click", () => openTaskDialog(null, button.dataset.taskAdd)));
  document.querySelectorAll("[data-task-edit]").forEach((button) => button.addEventListener("click", () => openTaskDialog(state.workspace.tasks.find((task) => task.id === button.dataset.taskEdit))));
  document.querySelectorAll("[data-postpone]").forEach((button) => button.addEventListener("click", () => postponeTask(button.dataset.postpone)));
  document.querySelectorAll("[data-task-select]").forEach((input) => input.addEventListener("change", () => {
    input.checked ? state.selectedTaskIds.add(input.dataset.taskSelect) : state.selectedTaskIds.delete(input.dataset.taskSelect);
    render();
  }));
  const deleteSelected = $("[data-delete-selected]");
  if (deleteSelected) deleteSelected.addEventListener("click", deleteSelectedTasks);
  document.querySelectorAll("[data-toggle-completed]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.toggleCompleted;
    state.expandedCompletedProjectIds.has(id) ? state.expandedCompletedProjectIds.delete(id) : state.expandedCompletedProjectIds.add(id);
    render();
  }));

  document.querySelectorAll("[data-check-add]").forEach((button) => button.addEventListener("click", () => addChecklistItem(button.dataset.checkAdd, button.dataset.groupId || "")));
  document.querySelectorAll("[data-check-toggle]").forEach((input) => input.addEventListener("change", () => toggleChecklistItem(input.dataset.groupId, input.dataset.checkToggle, input.checked)));
  document.querySelectorAll("[data-check-delete]").forEach((button) => button.addEventListener("click", () => deleteChecklistItem(button.dataset.groupId, button.dataset.checkDelete)));
  document.querySelectorAll("[data-group-rename]").forEach((button) => button.addEventListener("click", () => renameChecklistGroup(button.dataset.groupRename)));
  document.querySelectorAll("[data-group-delete]").forEach((button) => button.addEventListener("click", () => deleteChecklistGroup(button.dataset.groupDelete)));
  document.querySelectorAll("[data-check-schedule]").forEach((button) => button.addEventListener("click", () => scheduleChecklistItem(button.dataset.groupId, button.dataset.checkSchedule)));
  document.querySelectorAll("[data-template-import]").forEach((button) => button.addEventListener("click", importChecklistTemplate));
  document.querySelectorAll("[data-template-save]").forEach((button) => button.addEventListener("click", saveChecklistTemplate));
  document.querySelectorAll("[data-notifications]").forEach((button) => button.addEventListener("click", enableNotifications));
  document.querySelectorAll("[data-test-notification]").forEach((button) => button.addEventListener("click", testNotification));

  const messageForm = $("#messageForm");
  if (messageForm) messageForm.addEventListener("submit", addProjectMessage);
  const goalSettingsForm = $("#goalSettingsForm");
  if (goalSettingsForm) goalSettingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const goal = Number(new FormData(goalSettingsForm).get("monthly_goal"));
    if (!Number.isInteger(goal) || goal < 0 || goal > 99) {
      showToast("目標門數請輸入 0 到 99 的整數");
      return;
    }
    state.workspace.settings.monthly_goal = goal;
    saveWorkspace();
    showToast("本月目標已更新");
    render();
  });
  document.querySelectorAll("[data-message-delete]").forEach((button) => button.addEventListener("click", () => deleteProjectMessage(button.dataset.messageDelete)));
  document.querySelectorAll("[data-open-url]").forEach((button) => button.addEventListener("click", () => window.open(button.dataset.openUrl, "_blank", "noopener")));

  document.querySelectorAll("[data-complete]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.workspace.tasks.find((item) => item.id === button.dataset.complete);
      if (!task) return;
      completeTask(task);
      saveWorkspace();
      showToast("已標記完成");
      render();
    });
  });

  document.querySelectorAll("[data-phone]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.workspace.tasks.find((item) => item.id === button.dataset.phone);
      if (!task) return;
      task.phone_status = button.dataset.status;
      if (button.dataset.status === "已聯繫") {
        completeTask(task);
      }
      saveWorkspace();
      showToast(`電話狀態已更新：${button.dataset.status}`);
      render();
    });
  });

  document.querySelectorAll("[data-calendar-view]").forEach((button) => button.addEventListener("click", () => {
    state.calendarView = button.dataset.calendarView;
    render();
  }));

  document.querySelectorAll("[data-period]").forEach((button) => {
    button.addEventListener("click", () => {
      const offset = Number(button.dataset.period);
      const now = new Date();
      const anchor = offset === 0 ? now : (parseDate(state.selectedCalendarDate) || now);
      if (offset !== 0) {
        if (state.calendarView === "month") anchor.setMonth(anchor.getMonth() + offset);
        else anchor.setDate(anchor.getDate() + offset * (state.calendarView === "week" ? 7 : 1));
      }
      state.selectedMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      state.selectedCalendarDate = dateISO(anchor);
      render();
    });
  });

  document.querySelectorAll("[data-calendar-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openTaskDialog(state.workspace.tasks.find((task) => task.id === button.dataset.calendarTask));
    });
    button.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      event.dataTransfer.setData("text/task-id", button.dataset.calendarTask);
      event.dataTransfer.effectAllowed = "move";
    });
  });

  let calendarSelectionTimer = null;
  let lastCalendarTarget = null;
  let lastCalendarClickAt = 0;
  const selectCalendarDate = (iso) => {
    state.selectedCalendarDate = iso;
    const selected = parseDate(state.selectedCalendarDate);
    if (selected) state.selectedMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  };
  document.querySelectorAll("[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.target.closest("[data-calendar-task]")) return;
      const clickedAt = Date.now();
      const isDoubleActivation = lastCalendarTarget === button && clickedAt - lastCalendarClickAt <= 400;
      window.clearTimeout(calendarSelectionTimer);
      if (isDoubleActivation) {
        lastCalendarTarget = null;
        lastCalendarClickAt = 0;
        selectCalendarDate(button.dataset.calendarDate);
        render();
        openTaskDialog({ date: state.selectedCalendarDate, status: "未完成", reminder_minutes: "0" });
        return;
      }
      lastCalendarTarget = button;
      lastCalendarClickAt = clickedAt;
      calendarSelectionTimer = window.setTimeout(() => {
        lastCalendarTarget = null;
        lastCalendarClickAt = 0;
        selectCalendarDate(button.dataset.calendarDate);
        render();
      }, 400);
    });
  });
  document.querySelectorAll("[data-calendar-drop]").forEach((target) => {
    target.addEventListener("dragover", (event) => { event.preventDefault(); target.classList.add("drag-over"); });
    target.addEventListener("dragleave", () => target.classList.remove("drag-over"));
    target.addEventListener("drop", (event) => {
      event.preventDefault();
      const task = state.workspace.tasks.find((item) => item.id === event.dataTransfer.getData("text/task-id"));
      if (!task) return;
      task.date = target.dataset.calendarDrop;
      if (target.dataset.dropTime) task.time = target.dataset.dropTime;
      task.updated_at = new Date().toISOString();
      state.selectedCalendarDate = task.date;
      saveWorkspace(); showToast("工作時間已調整"); render();
    });
  });
  let lastTimeTarget = null;
  let lastTimeClickAt = 0;
  document.querySelectorAll("[data-drop-time]").forEach((target) => target.addEventListener("click", (event) => {
    if (event.target.closest("[data-calendar-task]")) return;
    const clickedAt = Date.now();
    if (lastTimeTarget === target && clickedAt - lastTimeClickAt <= 400) {
      lastTimeTarget = null;
      lastTimeClickAt = 0;
      openTaskDialog({ date: target.dataset.calendarDrop, time: target.dataset.dropTime, status: "未完成", reminder_minutes: "0" });
      return;
    }
    lastTimeTarget = target;
    lastTimeClickAt = clickedAt;
  }));
  document.querySelectorAll("[data-calendar-add]").forEach((button) => button.addEventListener("click", () => {
    openTaskDialog({ date: button.dataset.calendarAdd || state.selectedCalendarDate, status: "未完成", reminder_minutes: "0" });
  }));

  document.querySelectorAll("[data-import]").forEach((button) => button.addEventListener("click", openImporter));
  document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", exportWorkspace));
  document.querySelectorAll("[data-export-csv]").forEach((button) => button.addEventListener("click", exportTasksCSV));
  document.querySelectorAll("[data-archive-year]").forEach((button) => button.addEventListener("click", archiveYear));
  document.querySelectorAll("[data-archive-download]").forEach((button) => button.addEventListener("click", () => downloadArchive(button.dataset.archiveDownload)));
  document.querySelectorAll("[data-archive-restore]").forEach((button) => button.addEventListener("click", () => restoreArchive(button.dataset.archiveRestore)));
  document.querySelectorAll("[data-archive-delete]").forEach((button) => button.addEventListener("click", () => deleteArchive(button.dataset.archiveDelete)));
  document.querySelectorAll("[data-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!confirm("確定清除這個瀏覽器中的網頁版資料？")) return;
      localStorage.removeItem(STORAGE_KEY);
      state.workspace = emptyWorkspace();
      showToast("已清除瀏覽器資料");
      render();
    });
  });
}

function openImporter() {
  $("#fileInput").click();
}

function exportWorkspace() {
  const blob = new Blob([JSON.stringify(state.workspace, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `老師專案管理網頁備份_${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("已匯出 JSON 備份");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportTasksCSV() {
  const header = ["日期", "時間", "工作內容", "課程專案", "狀態", "提醒分鐘", "備註"];
  const rows = state.workspace.tasks.slice().sort(sortTasks).map((task) => {
    const project = projectById(task.project_id);
    return [task.date, task.time, task.title, project?.course || "", task.status, task.reminder_minutes ?? "", task.note || ""];
  });
  const csv = `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `老師專案工作_${todayISO()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("已匯出工作 CSV");
}

function archiveYear() {
  const year = Number($("#archiveYear")?.value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    showToast("請輸入正確的封存年度");
    return;
  }
  const yearPrefix = `${year}-`;
  const completedTaskIds = new Set(state.workspace.tasks
    .filter((task) => task.status === STATUS_COMPLETED && String(task.date || task.completed_at || "").startsWith(yearPrefix))
    .map((task) => task.id));
  const completedProjectIds = new Set(state.workspace.projects
    .filter((project) => projectFinished(project) && String(project.target_month || project.target_date || "").startsWith(String(year)))
    .map((project) => project.id));
  if (!completedTaskIds.size && !completedProjectIds.size) {
    showToast(`${year} 年沒有可封存的已完成資料`);
    return;
  }
  if (!confirm(`將先下載完整備份，再移除 ${year} 年已完成工作 ${completedTaskIds.size} 件、已完成專案 ${completedProjectIds.size} 件。確定繼續？`)) return;
  exportWorkspace();
  const archivedTaskIds = new Set(state.workspace.tasks.filter((task) => completedTaskIds.has(task.id) || completedProjectIds.has(task.project_id)).map((task) => task.id));
  const archive = {
    id: uid("archive"), year, created_at: new Date().toISOString(),
    projects: state.workspace.projects.filter((project) => completedProjectIds.has(project.id)),
    tasks: state.workspace.tasks.filter((task) => archivedTaskIds.has(task.id)),
    checklists: state.workspace.checklists.filter((group) => completedProjectIds.has(group.project_id)),
    progress_logs: state.workspace.progress_logs.filter((item) => completedProjectIds.has(item.project_id)),
    project_messages: state.workspace.project_messages.filter((item) => completedProjectIds.has(item.project_id)),
    history: state.workspace.history.filter((item) => completedProjectIds.has(item.project_id)),
  };
  state.workspace.archives.push(archive);
  [...completedProjectIds, ...archivedTaskIds, ...archive.checklists.map((item) => item.id), ...archive.progress_logs.map((item) => item.id), ...archive.project_messages.map((item) => item.id), ...archive.history.map((item) => item.id)].forEach(markDeleted);
  state.workspace.tasks = state.workspace.tasks.filter((task) => !completedTaskIds.has(task.id) && !completedProjectIds.has(task.project_id));
  state.workspace.projects = state.workspace.projects.filter((project) => !completedProjectIds.has(project.id));
  state.workspace.checklists = state.workspace.checklists.filter((group) => !completedProjectIds.has(group.project_id));
  state.workspace.progress_logs = state.workspace.progress_logs.filter((item) => !completedProjectIds.has(item.project_id));
  state.workspace.project_messages = state.workspace.project_messages.filter((item) => !completedProjectIds.has(item.project_id));
  state.workspace.history = state.workspace.history.filter((item) => !completedProjectIds.has(item.project_id));
  saveWorkspace();
  showToast(`${year} 年已完成資料已封存`);
  render();
}

function downloadArchive(archiveId) {
  const archive = state.workspace.archives.find((item) => item.id === archiveId);
  if (!archive) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `老師專案封存_${archive.year}.json`; link.click(); URL.revokeObjectURL(url);
  showToast("封存資料已下載");
}

function restoreArchive(archiveId) {
  const archive = state.workspace.archives.find((item) => item.id === archiveId);
  if (!archive || !confirm(`確定還原 ${archive.year} 年封存資料？`)) return;
  const restore = (key) => {
    const existing = new Set(state.workspace[key].map((item) => item.id));
    (archive[key] || []).forEach((item) => { delete state.workspace.deleted_ids[item.id]; if (!existing.has(item.id)) state.workspace[key].push(item); });
  };
  ["projects", "tasks", "checklists", "progress_logs", "project_messages", "history"].forEach(restore);
  markDeleted(archive.id);
  state.workspace.archives = state.workspace.archives.filter((item) => item.id !== archiveId);
  saveWorkspace(); showToast("封存資料已還原"); render();
}

function deleteArchive(archiveId) {
  const archive = state.workspace.archives.find((item) => item.id === archiveId);
  if (!archive || !confirm(`永久刪除 ${archive.year} 年封存？此操作無法復原。`)) return;
  markDeleted(archive.id);
  state.workspace.archives = state.workspace.archives.filter((item) => item.id !== archiveId);
  saveWorkspace(); showToast("封存已永久刪除"); render();
}

function setupGlobalEvents() {
  $("#importButton").addEventListener("click", openImporter);
  $("#exportButton").addEventListener("click", exportWorkspace);
  $("#quickAddButton")?.addEventListener("click", () => openTaskDialog({ date: todayISO(), status: "未完成", reminder_minutes: "0" }));
  $("#globalSearch")?.addEventListener("input", (event) => {
    const value = event.target.value;
    if (state.page !== "search") state.pageBeforeSearch = state.page;
    state.globalQuery = value;
    state.page = value.trim() ? "search" : state.pageBeforeSearch;
    render();
    $("#globalSearch")?.focus();
  });
  window.addEventListener("offline", () => {
    if ($("#saveIndicator")) $("#saveIndicator").textContent = "離線保存中";
    showToast("目前離線，仍可繼續使用");
  });
  window.addEventListener("online", () => {
    if ($("#saveIndicator")) $("#saveIndicator").textContent = "正在恢復同步...";
    saveCloudWorkspace().then(() => showToast("已恢復連線並同步"));
  });
  $("#refreshButton").addEventListener("click", () => {
    if (CLOUD_MODE) {
      loadCloudWorkspace().then(() => { showToast("已重新整理雲端資料"); render(); }).catch((error) => showToast(error.message));
    } else {
      state.workspace = loadWorkspace();
      showToast("已重新整理");
      render();
    }
  });
  const logoutButton = $("#logoutButton");
  if (CLOUD_MODE) {
    logoutButton.hidden = false;
    logoutButton.addEventListener("click", logoutCloud);
  }
  $("#fileInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      showToast("目前第一版請匯入 JSON 檔");
      event.target.value = "";
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed.projects || !parsed.tasks) throw new Error("資料格式缺少 projects 或 tasks");
      state.workspace = normalizeWorkspace(parsed);
      saveWorkspace();
      state.page = "dashboard";
      showToast("資料匯入完成");
      render();
    } catch (error) {
      showToast(`匯入失敗：${error.message}`);
    } finally {
      event.target.value = "";
    }
  });
}

function openProjectDialog(project = null) {
  const currentMonth = monthKey(new Date());
  const layer = $("#modalLayer");
  layer.hidden = false;
  layer.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="projectDialogTitle">
      <div class="modal-header">
        <div>
          <h3 id="projectDialogTitle">${project ? "編輯課程專案" : "新增課程專案"}</h3>
          <p class="muted">課程專案資料</p>
        </div>
        <button class="icon-button" data-close-modal>×</button>
      </div>
      <form class="form-grid" id="projectForm">
        <label>
          <span>老師名稱</span>
          <input class="search-input" name="teacher" required value="${escapeHTML(project?.teacher || "")}" placeholder="例如：林老師">
        </label>
        <label>
          <span>課程名稱</span>
          <input class="search-input" name="course" required value="${escapeHTML(project?.course || "")}" placeholder="例如：AI 角色影音創作">
        </label>
        <div class="two-col">
          <label>
            <span>目標月份</span>
            <input class="search-input" name="target_month" value="${escapeHTML(project?.target_month || currentMonth)}" pattern="\\d{4}-\\d{2}" required>
          </label>
          <label>
            <span>預計上架日</span>
            <input class="search-input" name="target_date" value="${escapeHTML(project?.target_date || "")}" pattern="\\d{4}-\\d{2}-\\d{2}" required placeholder="YYYY-MM-DD">
          </label>
        </div>
        <div class="three-col">
          <label>
            <span>角色</span>
            <select class="select" name="role">${["未設定", "正式", "候補", "下月前置", "觀察"].map((value) => `<option ${(project?.role || ROLE_UNSET) === value ? "selected" : ""}>${value}</option>`).join("")}</select>
          </label>
          <label>
            <span>類型</span>
            <select class="select" name="mode">${["錄播", "直播"].map((value) => `<option ${(project?.mode === "live" ? "直播" : "錄播") === value ? "selected" : ""}>${value}</option>`).join("")}</select>
          </label>
          <label>
            <span>合作</span>
            <select class="select" name="cooperation">${["順利", "需觀察", "暫緩"].map((value) => `<option ${(project?.cooperation_status || "順利") === value ? "selected" : ""}>${value}</option>`).join("")}</select>
          </label>
        </div>
        <label>
          <span>目前階段</span>
          <select class="select" name="stage">${[...STAGE_NAMES, "已上架", "已完成", "已放棄"].map((value) => `<option ${(project?.status === "已完成" ? "已完成" : project?.status === "已上架" ? "已上架" : project?.status === "已放棄" ? "已放棄" : project?.current_stage || STAGE_NAMES[0]) === value ? "selected" : ""}>${value}</option>`).join("")}</select>
        </label>
        <label><span>雲端資料夾</span><input class="search-input" name="cloud" value="${escapeHTML(project?.links?.["雲端資料夾"] || "")}" placeholder="https://..."></label>
        <label><span>課程頁</span><input class="search-input" name="course_link" value="${escapeHTML(project?.links?.["課程頁"] || "")}" placeholder="https://..."></label>
        ${project ? "" : `<label><span>建立時套用檢查清單</span><select class="select" name="template"><option value="">不套用</option>${(state.workspace.checklist_templates || []).map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name || "未命名範本")}</option>`).join("")}</select></label>`}
        <input type="hidden" name="project_id" value="${escapeHTML(project?.id || "")}">
        <div class="modal-actions split-actions">
          ${project ? `<button type="button" class="danger-button" data-project-delete="${escapeHTML(project.id)}">刪除專案</button>` : `<span></span>`}
          <div class="toolbar"><button type="button" class="ghost-button" data-close-modal>取消</button><button type="submit" class="primary-button">儲存專案</button></div>
        </div>
      </form>
    </div>
  `;

  layer.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });
  layer.addEventListener("click", (event) => {
    if (event.target === layer) closeModal();
  }, { once: true });
  $("#projectForm").addEventListener("submit", saveProjectFromForm);
  const deleteButton = layer.querySelector("[data-project-delete]");
  if (deleteButton) deleteButton.addEventListener("click", () => deleteProject(deleteButton.dataset.projectDelete));
  layer.querySelector("input[name='teacher']").focus();
}

function closeModal() {
  const layer = $("#modalLayer");
  layer.hidden = true;
  layer.innerHTML = "";
}

function saveProjectFromForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const teacher = String(form.get("teacher") || "").trim();
  const course = String(form.get("course") || "").trim();
  const targetMonth = String(form.get("target_month") || "").trim();
  const targetDate = String(form.get("target_date") || "").trim();
  if (!teacher || !course) {
    showToast("請填寫老師名稱與課程名稱");
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(targetMonth) || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    showToast("請確認日期格式");
    return;
  }

  const stage = String(form.get("stage") || STAGE_NAMES[0]);
  const existing = projectById(String(form.get("project_id") || ""));
  const project = existing || {
    id: uid("project"), status: "進行中", tags: [], schedule_priority: "自動",
    next_step: "", next_step_date: "", next_step_task_id: "", waiting_for: "",
    created_at: new Date().toISOString().slice(0, 19),
  };
  const currentIndex = STAGE_NAMES.indexOf(stage);
  Object.assign(project, {
    teacher, course, source_name: course, target_month: targetMonth, target_date: targetDate,
    role: String(form.get("role") || ROLE_UNSET),
    mode: form.get("mode") === "直播" ? "live" : "recorded",
    cooperation_status: String(form.get("cooperation") || "順利"),
    current_stage: stage,
    links: { "雲端資料夾": String(form.get("cloud") || "").trim(), "課程頁": String(form.get("course_link") || "").trim() },
    stages: STAGE_NAMES.map((name, index) => ({ id: project.stages?.[index]?.id || uid("stage"), name, status: index < currentIndex ? STATUS_COMPLETED : index === currentIndex ? "進行中" : "未完成" })),
    last_update: todayISO(),
  });
  if (["已上架", "已完成"].includes(stage)) {
    project.status = stage;
    project.completed_date ||= todayISO();
  } else if (stage === "已放棄") {
    project.status = "已放棄";
    project.completed_date = "";
  } else {
    project.status = "進行中";
    project.completed_date = "";
  }
  if (!existing) state.workspace.projects.push(project);
  const template = (state.workspace.checklist_templates || []).find((item) => item.id === form.get("template"));
  if (!existing && template) {
    (template.sections || []).forEach((section) => state.workspace.checklists.push({
      id: uid("group"), project_id: project.id, name: section.name || "未命名分組",
      items: (section.items || []).map((item) => ({ id: uid("check"), title: item.title || "未命名項目", done: false, linked_task_id: "" })),
    }));
    addHistory(`建立專案時套用檢查範本「${template.name || ""}」`, project.id, "template");
  }
  addHistory(`${existing ? "更新" : "建立"}課程專案「${course}」`, project.id, "project");
  state.selectedProjectId = project.id;
  state.page = "projectDetail";
  saveWorkspace();
  closeModal();
  showToast(`已${existing ? "更新" : "建立"}「${course}」`);
  render();
}

function addHistory(text, projectId, type = "activity") {
  state.workspace.history.unshift({ id: uid("history"), project_id: projectId, time: new Date().toISOString().slice(0, 16), text, type });
}

function deleteProject(projectId) {
  const project = projectById(projectId);
  if (!project || !confirm(`確定刪除「${project.course}」及其工作、清單與留言？`)) return;
  [projectId,
    ...state.workspace.tasks.filter((item) => item.project_id === projectId).map((item) => item.id),
    ...state.workspace.checklists.filter((item) => item.project_id === projectId).map((item) => item.id),
    ...state.workspace.project_messages.filter((item) => item.project_id === projectId).map((item) => item.id),
  ].forEach(markDeleted);
  state.workspace.projects = state.workspace.projects.filter((item) => item.id !== projectId);
  state.workspace.tasks = state.workspace.tasks.filter((item) => item.project_id !== projectId);
  state.workspace.checklists = state.workspace.checklists.filter((item) => item.project_id !== projectId);
  state.workspace.project_messages = state.workspace.project_messages.filter((item) => item.project_id !== projectId);
  state.page = "projects";
  state.selectedProjectId = "";
  saveWorkspace();
  closeModal();
  showToast("已刪除專案");
  render();
}

function openTaskDialog(task = null, projectId = "") {
  const layer = $("#modalLayer");
  const targetProjectId = projectId || task?.project_id || state.selectedProjectId;
  layer.hidden = false;
  layer.innerHTML = `<div class="modal-card compact-modal" role="dialog" aria-modal="true">
    <div class="modal-header"><h3>${task?.id ? "編輯工作" : "新增工作排程"}</h3><button class="icon-button" data-close-modal aria-label="關閉">×</button></div>
    <form class="form-grid" id="taskForm">
      <label><span>工作內容</span><input class="search-input" name="title" required value="${escapeHTML(task?.title || "")}"></label>
      <div class="two-col"><label><span>日期</span><input class="search-input" type="date" name="date" value="${escapeHTML(task?.date || todayISO())}" required></label><label><span>時間</span><input class="search-input" type="time" name="time" value="${escapeHTML(task?.time || "")}"></label></div>
      <div class="two-col">
        <label><span>狀態</span><select class="select" name="status">${["未完成", "等待中", "已完成"].map((value) => `<option ${String(task?.status || "未完成") === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
        <label><span>提醒</span><select class="select" name="reminder_minutes">${[["", "不提醒"], ["0", "準時提醒"], ["10", "提前 10 分鐘"], ["60", "提前 1 小時"], ["1440", "提前 1 天"]].map(([value, label]) => `<option value="${value}" ${String(task?.reminder_minutes ?? "") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </div>
      <label><span>重複</span><select class="select" name="recurrence">${[["none", "不重複"], ["daily", "每天"], ["weekly", "每週"], ["monthly", "每月"]].map(([value, label]) => `<option value="${value}" ${String(task?.recurrence || "none") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label><span>所屬課程（選填）</span><select class="select" name="project_id"><option value="">我的工作</option>${state.workspace.projects.filter((project) => !projectFinished(project)).map((project) => `<option value="${escapeHTML(project.id)}" ${targetProjectId === project.id ? "selected" : ""}>${escapeHTML(project.course || project.teacher || "未命名專案")}</option>`).join("")}</select></label>
      <label><span>備註（選填）</span><textarea class="textarea" name="note" rows="3" placeholder="補充資訊、網址或處理方式">${escapeHTML(task?.note || "")}</textarea></label>
      <input type="hidden" name="task_id" value="${escapeHTML(task?.id || "")}"><input type="hidden" name="check_item_id" value="${escapeHTML(task?.linked_checklist_item_id || "")}">
      <div class="modal-actions split-actions">${task?.id ? `<button type="button" class="danger-button" data-task-delete="${escapeHTML(task.id)}">刪除工作</button>` : `<span></span>`}<div class="toolbar"><button type="button" class="ghost-button" data-close-modal>取消</button><button class="primary-button">儲存工作</button></div></div>
    </form></div>`;
  layer.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  layer.querySelector("[data-task-delete]")?.addEventListener("click", (event) => deleteTask(event.currentTarget.dataset.taskDelete));
  $("#taskForm").addEventListener("submit", saveTaskFromForm);
}

function saveTaskFromForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const taskId = String(form.get("task_id") || "");
  const task = state.workspace.tasks.find((item) => item.id === taskId) || { id: uid("task"), project_id: String(form.get("project_id") || ""), created_at: new Date().toISOString().slice(0, 19), task_type: "一般工作" };
  const wasCompleted = task.status === STATUS_COMPLETED;
  Object.assign(task, { title: String(form.get("title") || "").trim(), date: String(form.get("date") || ""), time: String(form.get("time") || ""), status: String(form.get("status") || "未完成"), project_id: String(form.get("project_id") || ""), reminder_minutes: String(form.get("reminder_minutes") || ""), recurrence: String(form.get("recurrence") || "none"), recurrence_series_id: task.recurrence_series_id || task.id, note: String(form.get("note") || "").trim(), linked_checklist_item_id: String(form.get("check_item_id") || task.linked_checklist_item_id || ""), updated_at: new Date().toISOString() });
  if (!taskId) state.workspace.tasks.push(task);
  if (!wasCompleted && task.status === STATUS_COMPLETED) completeTask(task);
  if (task.linked_checklist_item_id) {
    state.workspace.checklists.forEach((group) => (group.items || []).forEach((item) => { if (item.id === task.linked_checklist_item_id) item.linked_task_id = task.id; }));
  }
  addHistory(`${taskId ? "更新" : "新增"}工作排程「${task.title}」`, task.project_id, "task");
  saveWorkspace(); closeModal(); showToast("工作排程已儲存"); render();
}

function recurrenceDate(task) {
  const date = parseDate(task.date);
  if (!date || !task.recurrence || task.recurrence === "none") return "";
  if (task.recurrence === "daily") date.setDate(date.getDate() + 1);
  if (task.recurrence === "weekly") date.setDate(date.getDate() + 7);
  if (task.recurrence === "monthly") {
    const targetDay = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(targetDay, lastDay));
  }
  return dateISO(date);
}

function completeTask(task) {
  task.status = STATUS_COMPLETED;
  task.completed_at = new Date().toISOString().slice(0, 19);
  task.updated_at = new Date().toISOString();
  if (task.task_type === TASK_TYPE_PHONE) task.phone_status = "已聯繫";
  const nextDate = recurrenceDate(task);
  if (!nextDate) return;
  const seriesId = task.recurrence_series_id || task.id;
  const exists = state.workspace.tasks.some((item) => item.recurrence_series_id === seriesId && item.date === nextDate && item.status !== STATUS_COMPLETED);
  if (!exists) state.workspace.tasks.push({ ...task, id: uid("task"), date: nextDate, status: "未完成", phone_status: task.task_type === TASK_TYPE_PHONE ? "待聯繫" : task.phone_status, completed_at: "", snooze_until: "", recurrence_series_id: seriesId, created_at: new Date().toISOString().slice(0, 19), updated_at: new Date().toISOString() });
}

function deleteTask(taskId) {
  const task = state.workspace.tasks.find((item) => item.id === taskId);
  if (!task || !confirm(`確定刪除「${task.title || "這項工作"}」？`)) return;
  markDeleted(taskId);
  state.workspace.tasks = state.workspace.tasks.filter((item) => item.id !== taskId);
  state.workspace.checklists.forEach((group) => (group.items || []).forEach((item) => { if (item.linked_task_id === taskId) item.linked_task_id = ""; }));
  saveWorkspace(); closeModal(); showToast("工作已刪除"); render();
}

function snoozeTask(taskId) {
  const task = state.workspace.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const value = new Date(); value.setMinutes(value.getMinutes() + 10);
  task.snooze_until = `${dateISO(value)}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  task.updated_at = new Date().toISOString();
  saveWorkspace(); showToast("提醒已延後 10 分鐘");
}

function postponeTask(taskId) {
  const task = state.workspace.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const value = parseDate(task.date) || new Date();
  value.setDate(value.getDate() + 1);
  task.date = dateISO(value);
  saveWorkspace(); showToast("已延後一天"); render();
}

function deleteSelectedTasks() {
  const ids = [...state.selectedTaskIds];
  if (!ids.length || !confirm(`確定刪除已勾選的 ${ids.length} 件工作？`)) return;
  ids.forEach(markDeleted);
  state.workspace.tasks = state.workspace.tasks.filter((task) => !state.selectedTaskIds.has(task.id));
  state.selectedTaskIds.clear();
  saveWorkspace(); showToast("已刪除所選工作"); render();
}

function findChecklistItem(groupId, itemId) {
  const group = state.workspace.checklists.find((item) => item.id === groupId);
  return { group, item: group?.items?.find((item) => item.id === itemId) };
}

function addChecklistItem(projectId, groupId = "") {
  let group = state.workspace.checklists.find((item) => item.id === groupId);
  if (!group) {
    const name = prompt("清單名稱", "新清單");
    if (!name) return;
    group = { id: uid("group"), project_id: projectId, name: name.trim(), items: [] };
    state.workspace.checklists.push(group);
  }
  const title = prompt("清單項目內容");
  if (!title) return;
  group.items.push({ id: uid("check"), title: title.trim(), done: false, linked_task_id: "" });
  saveWorkspace(); showToast("已新增清單項目"); render();
}

function toggleChecklistItem(groupId, itemId, done) {
  const found = findChecklistItem(groupId, itemId);
  if (!found.item) return;
  found.item.done = done;
  saveWorkspace(); render();
}

function deleteChecklistItem(groupId, itemId) {
  const found = findChecklistItem(groupId, itemId);
  if (!found.group || !confirm("確定刪除這個清單項目？")) return;
  markDeleted(itemId);
  found.group.items = found.group.items.filter((item) => item.id !== itemId);
  saveWorkspace(); render();
}

function renameChecklistGroup(groupId) {
  const group = state.workspace.checklists.find((item) => item.id === groupId);
  const name = group && prompt("重新命名清單", group.name);
  if (!name) return;
  group.name = name.trim(); saveWorkspace(); render();
}

function deleteChecklistGroup(groupId) {
  if (!confirm("確定刪除整份清單？")) return;
  markDeleted(groupId);
  state.workspace.checklists = state.workspace.checklists.filter((item) => item.id !== groupId);
  saveWorkspace(); render();
}

function scheduleChecklistItem(groupId, itemId) {
  const found = findChecklistItem(groupId, itemId);
  if (!found.item) return;
  const linked = state.workspace.tasks.find((task) => task.id === found.item.linked_task_id);
  openTaskDialog(linked || { title: found.item.title, project_id: found.group.project_id, date: todayISO(), status: "未完成", linked_checklist_item_id: itemId });
}

function importChecklistTemplate() {
  const templates = state.workspace.checklist_templates || [];
  if (!templates.length) { showToast("目前沒有可匯入的檢查清單範本"); return; }
  const name = prompt(`輸入範本名稱：\n${templates.map((item) => item.name).join("、")}`);
  const template = templates.find((item) => item.name === name);
  if (!template) return;
  (template.sections || []).forEach((section) => state.workspace.checklists.push({ id: uid("group"), project_id: state.selectedProjectId, name: section.name || "未命名分組", items: (section.items || []).map((item) => ({ id: uid("check"), title: item.title || "未命名項目", done: false, linked_task_id: "" })) }));
  saveWorkspace(); showToast("已匯入檢查清單範本"); render();
}

function saveChecklistTemplate() {
  const groups = checklistGroups(state.selectedProjectId);
  if (!groups.length) { showToast("目前沒有清單可儲存"); return; }
  const name = prompt("範本名稱");
  if (!name) return;
  state.workspace.checklist_templates ||= [];
  state.workspace.checklist_templates.push({ id: uid("template"), name: name.trim(), sections: groups.map((group) => ({ name: group.name, items: (group.items || []).map((item) => ({ title: item.title })) })) });
  saveWorkspace(); showToast("已儲存為範本");
}

function addProjectMessage(event) {
  event.preventDefault();
  const text = String(new FormData(event.currentTarget).get("message") || "").trim();
  if (!text) { showToast("請先輸入留言內容"); return; }
  state.workspace.project_messages.unshift({ id: uid("msg"), project_id: state.selectedProjectId, time: new Date().toISOString().slice(0, 16).replace("T", " "), text });
  addHistory(`新增留言：${text.slice(0, 28)}`, state.selectedProjectId, "message");
  saveWorkspace(); showToast("已新增留言"); render();
}

function deleteProjectMessage(messageId) {
  if (!confirm("確定刪除這則留言？")) return;
  markDeleted(messageId);
  state.workspace.project_messages = state.workspace.project_messages.filter((item) => item.id !== messageId);
  saveWorkspace(); showToast("已刪除留言"); render();
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!CLOUD_MODE || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
}

async function enableNotifications() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("未取得通知權限");
      render();
      return;
    }
    await registerServiceWorker();
    const registration = await navigator.serviceWorker.ready;
    const configResponse = await apiFetch("/api/push/config");
    const config = await configResponse.json();
    cloudCsrfToken = config.csrf_token || cloudCsrfToken;
    if (!config.enabled || !config.public_key) throw new Error("雲端推播金鑰尚未設定");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.public_key),
      });
    }
    const response = await apiFetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": cloudCsrfToken },
      body: JSON.stringify(subscription),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "通知訂閱失敗");
    showToast("這台裝置已啟用到時提醒");
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function testNotification() {
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("老師專案管理提醒", {
      body: "Chrome 通知測試成功",
      tag: `notification-test-${Date.now()}`,
      data: { url: "/" },
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function logoutCloud() {
  try {
    window.clearTimeout(cloudSaveTimer);
    await saveCloudWorkspace();
    await apiFetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": cloudCsrfToken } });
  } finally {
    window.location.replace("/login");
  }
}

async function initializeApp() {
  setupGlobalEvents();
  render();
  if (!CLOUD_MODE) return;
  const indicator = $("#saveIndicator");
  if (indicator) indicator.textContent = "正在讀取雲端資料...";
  try {
    await loadCloudWorkspace();
    await registerServiceWorker();
    const url = new URL(window.location.href);
    const snoozeId = url.searchParams.get("snooze");
    if (snoozeId) {
      snoozeTask(snoozeId);
      url.searchParams.delete("snooze");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (indicator) indicator.textContent = "已連線雲端";
    render();
  } catch (error) {
    if (indicator) indicator.textContent = "離線資料模式";
    showToast("無法連線雲端，已載入這台裝置的最近資料");
    await registerServiceWorker().catch(() => null);
    render();
  }
}

initializeApp();
