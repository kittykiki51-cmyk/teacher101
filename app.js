const STORAGE_KEY = "teacher_operations_web_workspace";
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
});

let state = {
  page: "dashboard",
  query: "",
  projectRoleFilter: "全部",
  projectModeFilter: "全部類型",
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
  if (CLOUD_MODE) return emptyWorkspace();
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
      await loadCloudWorkspace();
      showToast("另一台裝置已有新資料，已重新載入");
      render();
      return;
    }
    if (!response.ok) throw new Error(result.error || "同步失敗");
    cloudRevision = result.revision;
    if (indicator) indicator.textContent = "已同步雲端";
  } catch (error) {
    if (indicator) indicator.textContent = "同步失敗";
    showToast(error.message);
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
  };
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
  $("#pageTitle").textContent = state.page === "projectDetail" && selectedProject
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
  };
  $("#content").innerHTML = (renderers[state.page] || renderDashboard)();
  bindContentEvents();
}

function renderDashboard() {
  const currentMonth = monthKey(new Date());
  const targetProjects = state.workspace.projects
    .filter((project) => project.target_month === currentMonth && project.role === "正式")
    .sort((a, b) => `${a.target_date || "9999-12-31"} ${a.course || ""}`.localeCompare(`${b.target_date || "9999-12-31"} ${b.course || ""}`, "zh-Hant"));
  const launched = targetProjects.filter((project) => ["已上架", "已完成"].includes(project.status) || project.current_stage === "已完成");
  const inProgress = targetProjects.filter((project) => !launched.includes(project));
  const monthGoal = Number(state.workspace.settings.monthly_goal || 2);
  const remaining = Math.max(0, monthGoal - launched.length);
  const today = new Date();
  const tasks = priorityTasks().slice(0, 8);
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
  const projects = state.workspace.projects.filter((project) => {
    const haystack = `${project.teacher || ""} ${project.course || ""} ${(project.tags || []).join(" ")}`.toLowerCase();
    const mode = project.mode === "live" ? "直播" : "錄播";
    return (!query || haystack.includes(query))
      && (state.projectRoleFilter === "全部" || project.role === state.projectRoleFilter)
      && (state.projectModeFilter === "全部類型" || mode === state.projectModeFilter);
  }).sort((a, b) => Number(projectFinished(a)) - Number(projectFinished(b))
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
    </div>
    <div class="project-list-grid">
      ${projectCards(projects, "沒有符合條件的課程專案。")}
    </div>
  `;
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
            </div>
          </div>
          ${pill(phoneMode ? task.phone_status || "待聯繫" : task.status || "未完成", statusTone)}
        </div>
        <div class="toolbar">
          ${completed ? "" : `<button class="small-button" data-complete="${escapeHTML(task.id)}">完成</button>`}
          ${phoneMode ? `<button class="small-button" data-phone="${escapeHTML(task.id)}" data-status="已聯繫">已聯繫</button><button class="small-button" data-phone="${escapeHTML(task.id)}" data-status="待回覆">待回覆</button>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function renderCalendar() {
  const base = state.selectedMonth;
  const year = base.getFullYear();
  const month = base.getMonth();
  const displayedMonth = monthKey(base);
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startOffset = first.getDay();
  const cells = [];
  for (let i = 0; i < startOffset; i += 1) cells.push(null);
  for (let day = 1; day <= last.getDate(); day += 1) cells.push(new Date(year, month, day));
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const monthTasks = state.workspace.tasks.filter((task) => task.date && task.date.startsWith(displayedMonth)).sort(sortTasks);
  if (!state.selectedCalendarDate?.startsWith(displayedMonth)) {
    state.selectedCalendarDate = dateISO(first);
  }
  const selectedDate = state.selectedCalendarDate;
  const selectedTasks = state.workspace.tasks.filter((task) => task.date === selectedDate).sort(sortTasks);
  const selectedDateLabel = new Intl.DateTimeFormat("zh-Hant", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(`${selectedDate}T00:00:00`));
  return `
    <section class="card calendar-card">
      <div class="card-header">
        <div><h3>${year} 年 ${month + 1} 月</h3><p class="muted">${monthTasks.length} 件工作</p></div>
        <div class="toolbar">
          <button class="small-button" data-month="-1">上個月</button>
          <button class="small-button" data-month="0">今天</button>
          <button class="small-button" data-month="1">下個月</button>
        </div>
      </div>
      <div class="grid calendar-layout">
        <div class="calendar-grid">
          ${days.map((day) => `<div class="day-name">${day}</div>`).join("")}
          ${cells.map((date) => renderDayCell(date)).join("")}
        </div>
        <aside class="calendar-day-panel" aria-live="polite">
          <div class="calendar-day-header">
            <div>
              <p class="calendar-day-kicker">當日行事曆工作</p>
              <h4>${escapeHTML(selectedDateLabel)}</h4>
            </div>
            ${pill(`${selectedTasks.length} 件`, selectedTasks.length ? "green" : "gray")}
          </div>
          <div class="list">${taskList(selectedTasks, "這一天沒有排程工作。")}</div>
        </aside>
      </div>
    </section>
  `;
}

function renderDayCell(date) {
  if (!date) return `<div class="day-cell empty"></div>`;
  const iso = dateISO(date);
  const tasks = state.workspace.tasks.filter((task) => task.date === iso).sort(sortTasks);
  const selected = iso === state.selectedCalendarDate;
  return `
    <button type="button" class="day-cell ${iso === todayISO() ? "today" : ""} ${selected ? "selected" : ""} ${tasks.length ? "has-tasks" : ""}" data-calendar-date="${iso}" aria-label="${date.getMonth() + 1} 月 ${date.getDate()} 日，${tasks.length} 件工作" aria-pressed="${selected}">
      <div class="day-number">${date.getDate()}</div>
      ${tasks.slice(0, 3).map((task) => `<span class="day-dot">${escapeHTML(task.title || "未命名工作")}</span>`).join("")}
      ${tasks.length > 3 ? `<span class="day-dot">另有 ${tasks.length - 3} 件</span>` : ""}
    </button>
  `;
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
        <div><h3>資料設定</h3><p class="muted">目前資料保存在這個瀏覽器</p></div>
      </div>
      <div class="grid dashboard-grid">
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
            <button class="danger-button" data-clear>清除瀏覽器資料</button>
          </div>
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
  document.querySelectorAll("[data-message-delete]").forEach((button) => button.addEventListener("click", () => deleteProjectMessage(button.dataset.messageDelete)));
  document.querySelectorAll("[data-open-url]").forEach((button) => button.addEventListener("click", () => window.open(button.dataset.openUrl, "_blank", "noopener")));

  document.querySelectorAll("[data-complete]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.workspace.tasks.find((item) => item.id === button.dataset.complete);
      if (!task) return;
      task.status = STATUS_COMPLETED;
      task.completed_at = new Date().toISOString().slice(0, 19);
      if (task.task_type === TASK_TYPE_PHONE) task.phone_status = "已聯繫";
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
        task.status = STATUS_COMPLETED;
        task.completed_at = new Date().toISOString().slice(0, 19);
      }
      saveWorkspace();
      showToast(`電話狀態已更新：${button.dataset.status}`);
      render();
    });
  });

  document.querySelectorAll("[data-month]").forEach((button) => {
    button.addEventListener("click", () => {
      const offset = Number(button.dataset.month);
      const now = new Date();
      state.selectedMonth = offset === 0
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(state.selectedMonth.getFullYear(), state.selectedMonth.getMonth() + offset, 1);
      state.selectedCalendarDate = offset === 0 ? todayISO() : dateISO(state.selectedMonth);
      render();
    });
  });

  document.querySelectorAll("[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCalendarDate = button.dataset.calendarDate;
      render();
    });
  });

  document.querySelectorAll("[data-import]").forEach((button) => button.addEventListener("click", openImporter));
  document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", exportWorkspace));
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

function setupGlobalEvents() {
  $("#importButton").addEventListener("click", openImporter);
  $("#exportButton").addEventListener("click", exportWorkspace);
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
          <select class="select" name="stage">${[...STAGE_NAMES, "已上架", "已完成"].map((value) => `<option ${(project?.status === "已完成" ? "已完成" : project?.status === "已上架" ? "已上架" : project?.current_stage || STAGE_NAMES[0]) === value ? "selected" : ""}>${value}</option>`).join("")}</select>
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
      <label><span>狀態</span><select class="select" name="status">${["未完成", "等待中", "已完成"].map((value) => `<option ${String(task?.status || "未完成") === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      <input type="hidden" name="task_id" value="${escapeHTML(task?.id || "")}"><input type="hidden" name="project_id" value="${escapeHTML(targetProjectId)}"><input type="hidden" name="check_item_id" value="${escapeHTML(task?.linked_checklist_item_id || "")}">
      <div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>取消</button><button class="primary-button">儲存工作</button></div>
    </form></div>`;
  layer.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  $("#taskForm").addEventListener("submit", saveTaskFromForm);
}

function saveTaskFromForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const taskId = String(form.get("task_id") || "");
  const task = state.workspace.tasks.find((item) => item.id === taskId) || { id: uid("task"), project_id: String(form.get("project_id") || ""), created_at: new Date().toISOString().slice(0, 19), task_type: "一般工作" };
  Object.assign(task, { title: String(form.get("title") || "").trim(), date: String(form.get("date") || ""), time: String(form.get("time") || ""), status: String(form.get("status") || "未完成"), linked_checklist_item_id: String(form.get("check_item_id") || task.linked_checklist_item_id || "") });
  if (!taskId) state.workspace.tasks.push(task);
  if (task.linked_checklist_item_id) {
    state.workspace.checklists.forEach((group) => (group.items || []).forEach((item) => { if (item.id === task.linked_checklist_item_id) item.linked_task_id = task.id; }));
  }
  addHistory(`${taskId ? "更新" : "新增"}工作排程「${task.title}」`, task.project_id, "task");
  saveWorkspace(); closeModal(); showToast("工作排程已儲存"); render();
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
    if (indicator) indicator.textContent = "已連線雲端";
    render();
  } catch (error) {
    if (indicator) indicator.textContent = "連線失敗";
    showToast(error.message);
  }
}

initializeApp();
