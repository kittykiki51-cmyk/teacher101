const STORAGE_KEY = "teacher_operations_web_workspace";
const OFFLINE_CACHE_KEY = "teacher_operations_cloud_offline_cache";
const OFFLINE_BASE_KEY = "teacher_operations_cloud_sync_base";
const OFFLINE_DIRTY_KEY = "teacher_operations_cloud_pending_changes";
const PUSH_STATUS_KEY = "teacher_operations_push_status";
const NOTIFICATION_TEST_KEY = "teacher_operations_notification_test";
const CLOUD_MODE = window.location?.protocol !== "file:";

const STATUS_COMPLETED = "已完成";
const STATUS_WAITING = "等待中";
const TASK_TYPE_PHONE = "電話聯繫";
const ROLE_FORMAL = "正式";
const ROLE_UNSET = "未設定";
const STAGE_NAMES = ["講師資料", "課綱與合約", "課程錄製", "影片後製", "課程上架"];
const WORKSPACE_COLLECTION_FIELDS = ["projects", "tasks", "checklists", "progress_logs", "project_messages", "history", "archives"];

const NAV_ITEMS = [
  { id: "dashboard", label: "營運首頁", mobileLabel: "首頁", icon: "house", title: "營運首頁" },
  { id: "projects", label: "課程專案", mobileLabel: "專案", icon: "folders", title: "課程專案" },
  { id: "calendar", label: "工作月曆", mobileLabel: "月曆", icon: "calendar-days", title: "工作月曆" },
  { id: "settings", label: "更多設定", mobileLabel: "設定", icon: "settings", title: "更多設定" },
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
  projectStatusFilter: "active",
  projectView: "cards",
  projectGanttMonths: 6,
  projectTableSort: "target_date",
  projectTableSortDirection: "asc",
  calendarQuery: "",
  calendarStatusFilter: "全部",
  calendarView: "month",
  calendarMobileMonthOpen: false,
  calendarMobilePanelOpen: false,
  projectMobileTab: "work",
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
let cloudSavePending = false;
let cloudBaseWorkspace = null;
let calendarSwipeUntil = 0;
let modalViewportCleanup = null;
let searchRenderTimer = null;
let lastCalendarActivationKey = "";
let lastCalendarActivationAt = 0;

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
  if (!CLOUD_MODE) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workspace));
    updateSyncIndicator("已自動保存", "saved");
    return;
  }
  localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
  localStorage.setItem(OFFLINE_DIRTY_KEY, "1");
  updateSyncIndicator("正在同步...", "syncing");
  cloudSavePending = true;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(saveCloudWorkspace, 450);
}

async function clearBrowserPrivateData() {
  localStorage.removeItem(OFFLINE_CACHE_KEY);
  localStorage.removeItem(OFFLINE_BASE_KEY);
  localStorage.removeItem(OFFLINE_DIRTY_KEY);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PUSH_STATUS_KEY);
  localStorage.removeItem(NOTIFICATION_TEST_KEY);
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("teacher-operations-")).map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (registration) await registration.unregister();
    }
  } catch {
    // Local cleanup should not prevent logout or session-expiry redirects.
  }
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    await clearBrowserPrivateData();
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
  storeCloudBaseWorkspace(state.workspace);
  localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
  cloudRevision = result.revision;
  cloudCsrfToken = result.csrf_token;
}

async function saveCloudWorkspace() {
  if (!CLOUD_MODE) return true;
  if (cloudSaveInFlight) {
    cloudSavePending = true;
    return true;
  }
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = null;
  cloudSaveInFlight = true;
  cloudSavePending = false;
  try {
    const workspaceJSON = JSON.stringify(state.workspace);
    const response = await apiFetch("/api/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": cloudCsrfToken },
      body: `{"workspace":${workspaceJSON},"revision":${JSON.stringify(cloudRevision)}}`,
    });
    const result = await response.json();
    if (response.status === 409) {
      const localWorkspace = normalizeWorkspace(state.workspace);
      const baseWorkspace = cloudBaseWorkspace;
      await loadCloudWorkspace();
      state.workspace = mergeWorkspaces(state.workspace, localWorkspace, baseWorkspace);
      localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
      cloudSavePending = true;
      showToast("已逐筆合併另一台裝置的更新");
      render();
      return true;
    }
    if (!response.ok) throw new Error(result.error || "同步失敗");
    cloudRevision = result.revision;
    storeCloudBaseWorkspace(JSON.parse(workspaceJSON));
    if (!cloudSavePending) localStorage.removeItem(OFFLINE_DIRTY_KEY);
    localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
    updateSyncIndicator(cloudSavePending ? "正在同步..." : "已同步雲端", cloudSavePending ? "syncing" : "saved");
    return true;
  } catch (error) {
    localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
    updateSyncIndicator(navigator.onLine ? "同步失敗" : "離線保存中", navigator.onLine ? "error" : "offline");
    showToast(navigator.onLine ? error.message : "目前離線，資料已保存在這台裝置");
    return false;
  } finally {
    cloudSaveInFlight = false;
    if (cloudSavePending) {
      window.clearTimeout(cloudSaveTimer);
      cloudSaveTimer = window.setTimeout(saveCloudWorkspace, 120);
    }
  }
}

async function reconnectCloudWorkspace() {
  const localWorkspace = cloneWorkspace(state.workspace);
  const baseWorkspace = cloudBaseWorkspace || readCloudBaseWorkspace();
  const hasPendingChanges = localStorage.getItem(OFFLINE_DIRTY_KEY) === "1" || cloudSavePending;
  if (!cloudCsrfToken) {
    await loadCloudWorkspace();
    if (hasPendingChanges) {
      state.workspace = mergeWorkspaces(state.workspace, localWorkspace, baseWorkspace);
      localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
      cloudSavePending = true;
    }
    render();
  }
  if (hasPendingChanges) {
    cloudSavePending = true;
    const accepted = await saveCloudWorkspace();
    if (!accepted) throw new Error("恢復同步失敗，離線修改仍保留在這台裝置");
  } else {
    updateSyncIndicator("已同步雲端", "saved");
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

function cloneWorkspace(value) {
  return normalizeWorkspace(JSON.parse(JSON.stringify(value)));
}

function readCloudBaseWorkspace() {
  try {
    const saved = localStorage.getItem(OFFLINE_BASE_KEY);
    return saved ? normalizeWorkspace(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

function storeCloudBaseWorkspace(value) {
  cloudBaseWorkspace = cloneWorkspace(value);
  localStorage.setItem(OFFLINE_BASE_KEY, JSON.stringify(cloudBaseWorkspace));
}

function workspaceImportIsValid(value) {
  const isRecord = (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Array.isArray(value.projects) || !Array.isArray(value.tasks)) return false;
  if (value.settings !== undefined && (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings))) return false;
  if (value.deleted_ids !== undefined && (!value.deleted_ids || typeof value.deleted_ids !== "object" || Array.isArray(value.deleted_ids))) return false;
  for (const field of [...WORKSPACE_COLLECTION_FIELDS, "checklist_templates"]) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some((item) => !isRecord(item)))) return false;
  }
  if ((value.projects || []).some((project) => project.stages !== undefined && (!Array.isArray(project.stages) || project.stages.some((item) => !isRecord(item))))) return false;
  if ((value.checklists || []).some((group) => group.items !== undefined && (!Array.isArray(group.items) || group.items.some((item) => !isRecord(item))))) return false;
  if ((value.checklist_templates || []).some((template) => !Array.isArray(template.sections) || template.sections.some((section) => !isRecord(section) || !Array.isArray(section.items) || section.items.some((item) => !isRecord(item))))) return false;
  if ((value.archives || []).some((archive) => WORKSPACE_COLLECTION_FIELDS.slice(0, -1).some((field) => archive[field] !== undefined && (!Array.isArray(archive[field]) || archive[field].some((item) => !isRecord(item)))))) return false;
  return true;
}

function mergeWorkspaces(remoteValue, localValue, baseValue = null) {
  const remote = normalizeWorkspace(remoteValue);
  const local = normalizeWorkspace(localValue);
  const base = baseValue ? normalizeWorkspace(baseValue) : emptyWorkspace();
  const deleted = { ...remote.deleted_ids, ...local.deleted_ids };
  const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  const keyOf = (item) => item?.id || `${item?.project_id || ""}|${item?.time || item?.date || ""}|${item?.text || item?.msg || item?.title || ""}`;
  const updatedAt = (item) => String(item?.updated_at || item?.last_update || item?.completed_at || item?.created_at || item?.time || item?.date || "");
  const chooseConcurrent = (remoteItem, localItem) => updatedAt(remoteItem) > updatedAt(localItem) ? remoteItem : localItem;
  const mergeRecord = (remoteItem, localItem, baseItem) => {
    const conflictWinner = chooseConcurrent(remoteItem, localItem);
    const result = {};
    new Set([...Object.keys(remoteItem), ...Object.keys(localItem)]).forEach((field) => {
      const remoteChanged = !sameValue(remoteItem[field], baseItem[field]);
      const localChanged = !sameValue(localItem[field], baseItem[field]);
      result[field] = localChanged && !remoteChanged ? localItem[field]
        : remoteChanged && !localChanged ? remoteItem[field]
          : sameValue(remoteItem[field], localItem[field]) ? remoteItem[field]
            : conflictWinner[field];
    });
    return result;
  };
  const mergeById = (remoteItems = [], localItems = [], baseItems = []) => {
    const remoteMap = new Map(remoteItems.map((item) => [keyOf(item), item]));
    const localMap = new Map(localItems.map((item) => [keyOf(item), item]));
    const baseMap = new Map(baseItems.map((item) => [keyOf(item), item]));
    const keys = new Set([...remoteMap.keys(), ...localMap.keys()]);
    return [...keys].map((key) => {
      const remoteItem = remoteMap.get(key);
      const localItem = localMap.get(key);
      const baseItem = baseMap.get(key);
      if (deleted[remoteItem?.id || localItem?.id]) return null;
      if (!remoteItem) return baseItem && sameValue(localItem, baseItem) ? null : localItem;
      if (!localItem) return baseItem && sameValue(remoteItem, baseItem) ? null : remoteItem;
      if (!baseItem) return chooseConcurrent(remoteItem, localItem);
      const remoteChanged = !sameValue(remoteItem, baseItem);
      const localChanged = !sameValue(localItem, baseItem);
      if (remoteChanged && !localChanged) return remoteItem;
      if (localChanged && !remoteChanged) return localItem;
      if (!remoteChanged && !localChanged) return remoteItem;
      if (sameValue(remoteItem, localItem)) return remoteItem;
      return mergeRecord(remoteItem, localItem, baseItem);
    }).filter(Boolean);
  };
  const mergeObject = (remoteObject = {}, localObject = {}, baseObject = {}) => {
    const result = {};
    new Set([...Object.keys(remoteObject), ...Object.keys(localObject)]).forEach((key) => {
      const remoteChanged = !sameValue(remoteObject[key], baseObject[key]);
      const localChanged = !sameValue(localObject[key], baseObject[key]);
      result[key] = localChanged && !remoteChanged ? localObject[key]
        : remoteChanged && !localChanged ? remoteObject[key]
          : localChanged ? localObject[key] : remoteObject[key];
    });
    return result;
  };
  const merged = normalizeWorkspace({
    ...remote,
    settings: mergeObject(remote.settings, local.settings, base.settings),
    projects: mergeById(remote.projects, local.projects, base.projects),
    tasks: mergeById(remote.tasks, local.tasks, base.tasks),
    checklists: mergeById(remote.checklists, local.checklists, base.checklists),
    progress_logs: mergeById(remote.progress_logs, local.progress_logs, base.progress_logs),
    project_messages: mergeById(remote.project_messages, local.project_messages, base.project_messages),
    history: mergeById(remote.history, local.history, base.history),
    archives: mergeById(remote.archives, local.archives, base.archives),
    deleted_ids: deleted,
  });
  if (remote.checklist_templates || local.checklist_templates || base.checklist_templates) {
    merged.checklist_templates = mergeById(remote.checklist_templates, local.checklist_templates, base.checklist_templates);
  }
  return merged;
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
  const prefix = date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()} 年 `;
  return `${prefix}${date.getMonth() + 1} 月 ${date.getDate()} 日`;
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

function validExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function validEmailAddress(value) {
  const email = String(value || "").trim();
  if (!email || email.length > 254 || /[\r\n]/.test(email)) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function pill(label, tone = "") {
  return `<span class="pill ${tone}">${escapeHTML(label)}</span>`;
}

function emptyState(message, actionLabel = "", actionAttributes = "") {
  return `<div class="empty-state"><span>${escapeHTML(message)}</span>${actionLabel ? `<button type="button" class="small-button" ${actionAttributes}>${escapeHTML(actionLabel)}</button>` : ""}</div>`;
}

function updateSyncIndicator(message, tone = "saved") {
  const indicator = $("#saveIndicator");
  if (!indicator) return;
  indicator.textContent = message;
  indicator.title = message;
  indicator.dataset.syncTone = tone;
}

function showToast(message, undoHandler = null) {
  const toast = $("#toast");
  toast.replaceChildren();
  const label = document.createElement("span");
  label.textContent = message;
  toast.append(label);
  if (typeof undoHandler === "function") {
    const undoButton = document.createElement("button");
    undoButton.type = "button";
    undoButton.textContent = "復原";
    undoButton.addEventListener("click", () => {
      window.clearTimeout(showToast.timer);
      toast.classList.remove("show");
      undoHandler();
    });
    toast.append(undoButton);
  }
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), undoHandler ? 5000 : 2200);
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
  const desktopNav = $("#desktopNav");
  const mobileNav = $("#mobileNav");
  if (!desktopNav.dataset.ready) {
    desktopNav.innerHTML = NAV_ITEMS.map((item) => `
      <button class="nav-button" data-page="${item.id}">
        <span class="nav-icon nav-icon-${item.icon}" aria-hidden="true"></span><span>${item.label}</span>
      </button>
    `).join("");
    mobileNav.innerHTML = NAV_ITEMS.map((item) => `
      <button data-page="${item.id}">
        <span class="nav-icon nav-icon-${item.icon}" aria-hidden="true"></span><span>${item.mobileLabel}</span>
      </button>
    `).join("");
    [desktopNav, mobileNav].forEach((nav) => nav.querySelectorAll("[data-page]").forEach((button) => {
      button.addEventListener("click", () => setPage(button.dataset.page));
    }));
    desktopNav.dataset.ready = "true";
    mobileNav.dataset.ready = "true";
  }
  [desktopNav, mobileNav].forEach((nav) => {
    nav.querySelectorAll("[data-page]").forEach((button) => {
      const active = button.dataset.page === activePage;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  });
}

function scheduleSearchRender(focusSelector) {
  window.clearTimeout(searchRenderTimer);
  searchRenderTimer = window.setTimeout(() => {
    searchRenderTimer = null;
    render();
    const input = $(focusSelector);
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    if (typeof input.setSelectionRange === "function") input.setSelectionRange(end, end);
  }, 120);
}

function render() {
  hideGanttTooltip();
  window.clearTimeout(searchRenderTimer);
  searchRenderTimer = null;
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
  document.body.dataset.page = state.page;
  $("#content").className = `content content-${state.page}`;
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
    <div class="dashboard-page">
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
      <section class="home-panel phone-panel">
        <div class="panel-title-row">
          <h3>今日電話聯繫</h3>
          <button class="primary-button small-primary" data-phone-add>新增電話</button>
        </div>
        <p class="muted panel-subtitle">${humanDate(todayISO())}，待聯繫排前面，完成後保留到今天結束。</p>
        <div class="list">${taskList(todayPhoneTasks().slice(0, 8), "今天尚未安排電話聯繫。", true)}</div>
      </section>
      <section class="home-panel today-work-panel">
        <h3>今日工作</h3>
        <p class="muted panel-subtitle">${humanDate(todayISO())}，電話聯繫已獨立顯示，其餘工作依時間排序。</p>
        ${tasks[0] ? `<p class="priority-line">今日優先：${escapeHTML(tasks[0].title || "未命名工作")}${projectById(tasks[0].project_id) ? `｜${escapeHTML(projectById(tasks[0].project_id).course || "")}` : ""}</p>` : ""}
        <div class="list">${homeTaskRows(tasks, "今天尚未安排其他工作。")}</div>
        <button class="ghost-button weekly-button" data-page="calendar">開啟工作月曆</button>
      </section>
    </div>
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
  if (!projects.length) return emptyState("本月尚未指定正式課程。", "新增課程專案", "data-new-project");
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
          <button class="ghost-button" data-project-open="${escapeHTML(project.id)}">開啟專案</button>
        </div>
      </article>
    `;
  }).join("");
}

function homeTaskRows(tasks, emptyText) {
  if (!tasks.length) return emptyState(emptyText, "新增工作", `data-calendar-add="${todayISO()}"`);
  return tasks.map((task) => {
    const project = projectById(task.project_id);
    const statusTone = task.status === STATUS_WAITING ? "amber" : task.date && task.date < todayISO() ? "red" : "muted-dot";
    return `
      <div class="home-task-row">
        <button type="button" class="task-dot mobile-task-complete ${statusTone}" data-complete="${escapeHTML(task.id)}" aria-label="完成 ${escapeHTML(task.title || "未命名工作")}">○</button>
        <button type="button" class="mobile-task-content" data-task-edit="${escapeHTML(task.id)}">
          <strong>${escapeHTML(task.title || "未命名工作")}</strong>
          <p class="muted">截止：${humanDate(task.date)} ${escapeHTML(task.time || "")}${project ? `｜${escapeHTML(project.course || "")}` : ""}</p>
        </button>
        <div class="home-task-actions"><button class="small-button" data-complete="${escapeHTML(task.id)}">完成</button><button class="small-button" data-task-edit="${escapeHTML(task.id)}">編輯</button></div>
        ${taskOverflowMenu(task, { postpone: true })}
      </div>
    `;
  }).join("");
}

function taskOverflowMenu(task, options = {}) {
  return `<details class="task-overflow">
    <summary aria-label="更多工作操作" title="更多工作操作">⋯</summary>
    <div class="task-overflow-menu">
      ${options.postpone ? `<button type="button" data-postpone="${escapeHTML(task.id)}">延後一天</button>` : ""}
      ${options.goToProject && task.project_id ? `<button type="button" data-project-open="${escapeHTML(task.project_id)}">前往專案</button>` : ""}
      <button type="button" data-task-edit="${escapeHTML(task.id)}">編輯</button>
      ${options.delete ? `<button type="button" class="danger-text" data-calendar-delete="${escapeHTML(task.id)}">刪除</button>` : ""}
    </div>
  </details>`;
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
  const filteredProjects = state.workspace.projects.filter((project) => {
    const haystack = `${project.teacher || ""} ${project.course || ""} ${(project.tags || []).join(" ")}`.toLowerCase();
    const mode = project.mode === "live" ? "直播" : "錄播";
    return (!query || haystack.includes(query))
      && (state.projectRoleFilter === "全部" || project.role === state.projectRoleFilter)
      && (state.projectModeFilter === "全部類型" || mode === state.projectModeFilter);
  });
  const activeCount = filteredProjects.filter((project) => !projectFinished(project)).length;
  const completedCount = filteredProjects.length - activeCount;
  const completionRate = filteredProjects.length ? Math.round((completedCount / filteredProjects.length) * 100) : 0;
  const projects = filteredProjects
    .filter((project) => state.projectStatusFilter === "completed" ? projectFinished(project) : !projectFinished(project))
    .sort(state.projectView === "table"
    ? projectTableComparator
    : state.projectStatusFilter === "completed"
      ? (a, b) => String(b.completed_date || b.target_date || "").localeCompare(String(a.completed_date || a.target_date || ""))
      : (a, b) => projectSortRank(a, currentMonth) - projectSortRank(b, currentMonth)
      || String(a.target_month || "9999-99").localeCompare(String(b.target_month || "9999-99"))
      || String(a.target_date || "9999-12-31").localeCompare(String(b.target_date || "9999-12-31")));
  const emptyText = state.projectStatusFilter === "completed" ? "目前沒有已完成的課程專案。" : "目前沒有進行中的課程專案。";
  return `
    <div class="desktop-page-title project-page-title">
      <div>
        <h2>課程專案</h2>
        <p class="muted">依目標月份與角色管理正式、候補、觀察及下月前置課程。</p>
      </div>
      <button class="primary-button" data-new-project>新增課程專案</button>
    </div>
    <div class="project-status-bar">
      <div class="segmented-control project-status-switch" aria-label="專案完成狀態">
        <button type="button" class="${state.projectStatusFilter === "active" ? "active" : ""}" data-project-status="active" aria-pressed="${state.projectStatusFilter === "active"}">進行中 <span>${activeCount}</span></button>
        <button type="button" class="${state.projectStatusFilter === "completed" ? "active" : ""}" data-project-status="completed" aria-pressed="${state.projectStatusFilter === "completed"}">已完成 <span>${completedCount}</span></button>
      </div>
      <p class="project-status-summary">全部 ${filteredProjects.length} 個｜完成率 ${completionRate}%</p>
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
    <div class="project-view-toolbar">
      <p class="muted">共 ${projects.length} 個專案</p>
      <div class="segmented-control project-view-switch" aria-label="專案顯示方式">
        <button type="button" class="${state.projectView === "cards" ? "active" : ""}" data-project-view="cards" aria-pressed="${state.projectView === "cards"}">卡片</button>
        <button type="button" class="${state.projectView === "table" ? "active" : ""}" data-project-view="table" aria-pressed="${state.projectView === "table"}">總表</button>
        <button type="button" class="${state.projectView === "gantt" ? "active" : ""}" data-project-view="gantt" aria-pressed="${state.projectView === "gantt"}">甘特</button>
      </div>
    </div>
    ${state.projectView === "table" ? projectSummaryTable(projects, emptyText)
      : state.projectView === "gantt" ? projectGantt(projects, emptyText)
        : `<div class="project-list-grid">${projectCards(projects, emptyText)}</div>`}
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

function projectStartDate(project) {
  if (project.start_date) return String(project.start_date).slice(0, 10);
  if (project.created_at) return String(project.created_at).slice(0, 10);
  const firstTaskDate = tasksForProject(project.id).map((task) => task.date).filter(Boolean).sort()[0];
  return firstTaskDate || (project.target_month ? `${project.target_month}-01` : "");
}

function projectMilestone(project) {
  const stage = `${project.current_stage || ""} ${project.status || ""}`;
  const completedStages = (project.stages || []).filter((item) => item.status === STATUS_COMPLETED).map((item) => item.name || "").join(" ");
  const context = `${stage} ${completedStages}`;
  if (projectFinished(project) || /已上架|正式上架/.test(stage)) return { progress: 100, label: "已上架" };
  if (/排課|錄製完成|錄完|後製|剪輯|課程上架/.test(context)) return { progress: 90, label: "排課／錄製完成" };
  if (/錄製|開錄|課綱.*完成/.test(context)) return { progress: 80, label: "課綱完成・錄製課程" };
  if (/課綱|合約/.test(context)) return { progress: 60, label: "初版課綱已討論" };
  return { progress: 50, label: "已完成面試" };
}

function projectTableSortValue(project, key) {
  if (key === "course") return project.course || "";
  if (key === "teacher") return project.teacher || "";
  if (key === "start_date") return projectStartDate(project) || "9999-12-31";
  if (key === "progress") return projectMilestone(project).progress;
  if (key === "status") return projectRisk(project).label;
  return (projectFinished(project) ? project.completed_date || project.target_date : project.target_date) || "9999-12-31";
}

function projectTableComparator(a, b) {
  const left = projectTableSortValue(a, state.projectTableSort);
  const right = projectTableSortValue(b, state.projectTableSort);
  const result = typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right), "zh-Hant");
  return state.projectTableSortDirection === "desc" ? -result : result;
}

function projectSortButton(label, key) {
  const active = state.projectTableSort === key;
  const marker = active ? (state.projectTableSortDirection === "asc" ? "↑" : "↓") : "";
  return `<button type="button" class="project-sort-button ${active ? "active" : ""}" data-project-sort="${key}">${label}<span aria-hidden="true">${marker}</span></button>`;
}

function projectSummaryTable(projects, emptyText) {
  if (!projects.length) return `<div class="project-empty">${emptyState(emptyText, "新增課程專案", "data-new-project")}</div>`;
  const rows = projects.map((project) => {
    const milestone = projectMilestone(project);
    const risk = projectRisk(project);
    const next = projectNextStep(project);
    const finished = projectFinished(project);
    const endDate = finished ? project.completed_date || project.target_date : project.target_date;
    return `<tr class="${finished ? "finished" : ""}">
      <td><button type="button" class="project-table-link" data-project-open="${escapeHTML(project.id)}">${escapeHTML(project.course || "未命名課程")}</button></td>
      <td>${escapeHTML(project.teacher || "未設定老師")}</td>
      <td>${humanDate(projectStartDate(project))}</td>
      <td><span class="project-date-label">${finished ? "完成" : "預計"}</span>${humanDate(endDate)}</td>
      <td><div class="project-progress-cell"><div class="project-progress-copy"><strong>${milestone.progress}%</strong><span>${escapeHTML(milestone.label)}</span></div><div class="project-progress-track" aria-label="${milestone.progress}% ${escapeHTML(milestone.label)}"><span style="--project-progress:${milestone.progress}%"></span></div></div></td>
      <td>${escapeHTML(project.current_stage || "未設定")}</td>
      <td><span class="project-table-next">${next.date ? `${humanDate(next.date)}　` : ""}${escapeHTML(next.title)}</span></td>
      <td>${pill(risk.label, finished ? "gray" : risk.tone)}</td>
      <td><button type="button" class="small-button" data-project-open="${escapeHTML(project.id)}">開啟</button></td>
    </tr>`;
  }).join("");
  const mobileRows = projects.map((project) => {
    const milestone = projectMilestone(project);
    const risk = projectRisk(project);
    const next = projectNextStep(project);
    return `<button type="button" class="project-mobile-summary" data-project-open="${escapeHTML(project.id)}">
      <span class="project-mobile-summary-head"><strong>${escapeHTML(project.course || "未命名課程")}</strong><b>${milestone.progress}%</b></span>
      <span class="project-mobile-summary-meta">${escapeHTML(project.teacher || "未設定老師")}｜${humanDate(project.target_date)}｜${escapeHTML(risk.label)}</span>
      <span class="project-progress-track" aria-hidden="true"><span style="--project-progress:${milestone.progress}%"></span></span>
      <span class="project-mobile-summary-stage">${escapeHTML(milestone.label)}｜下一步：${escapeHTML(next.title)}</span>
    </button>`;
  }).join("");
  return `<div class="project-table-shell">
    <table class="project-summary-table">
      <thead><tr>
        <th>${projectSortButton("專案名稱", "course")}</th>
        <th>${projectSortButton("老師", "teacher")}</th>
        <th>${projectSortButton("開始日期", "start_date")}</th>
        <th>${projectSortButton("上架／完成", "target_date")}</th>
        <th>${projectSortButton("執行進度", "progress")}</th>
        <th>目前階段</th><th>下一步</th><th>${projectSortButton("狀態", "status")}</th><th>操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="project-mobile-summary-list">${mobileRows}</div>
  </div>`;
}

function projectGanttRange(monthCount = 6) {
  const today = parseDate(todayISO()) || new Date();
  const monthsBeforeToday = monthCount >= 12 ? 2 : 1;
  const start = new Date(today.getFullYear(), today.getMonth() - monthsBeforeToday, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + monthCount, 0);
  const totalDays = Math.round((end - start) / 86400000) + 1;
  const months = Array.from({ length: monthCount }, (_, index) => {
    const monthStart = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const monthEnd = new Date(start.getFullYear(), start.getMonth() + index + 1, 0);
    const left = Math.round(((monthStart - start) / 86400000) / totalDays * 10000) / 100;
    const width = Math.round(((monthEnd - monthStart) / 86400000 + 1) / totalDays * 10000) / 100;
    return { label: `${monthStart.getFullYear()}年${monthStart.getMonth() + 1}月`, left, width };
  });
  const todayPosition = Math.round(((today - start) / 86400000) / totalDays * 10000) / 100;
  return { start, end, totalDays, months, todayPosition };
}

function projectGanttSchedule(project) {
  const start = parseDate(projectStartDate(project));
  const end = parseDate((projectFinished(project) ? project.completed_date : project.target_date) || project.target_date);
  const actual = projectMilestone(project).progress;
  if (!start || !end || end < start) return { expected: 0, actual, label: "日期待補", tone: "gray" };
  const today = parseDate(todayISO()) || new Date();
  const total = Math.max(1, Math.round((end - start) / 86400000));
  const elapsed = Math.round((today - start) / 86400000);
  const expected = Math.max(0, Math.min(100, Math.round(elapsed / total * 100)));
  if (projectFinished(project)) return { expected: 100, actual: 100, label: "已完成", tone: "green" };
  if (projectDeferred(project)) return { expected, actual, label: "暫緩", tone: "amber" };
  if ((today > end && actual < 100) || expected - actual >= 15) return { expected, actual, label: "需追蹤", tone: "red" };
  return { expected, actual, label: "進度正常", tone: "green" };
}

function projectRemainingLabel(project) {
  if (projectFinished(project)) return `完成於 ${humanDate(project.completed_date || project.target_date)}`;
  const end = parseDate(project.target_date);
  const today = parseDate(todayISO());
  if (!end || !today) return "尚未設定結束日期";
  const days = Math.ceil((end - today) / 86400000);
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `剩餘 ${days} 天`;
}

function projectGanttPriority(project) {
  if (projectFinished(project)) return 5;
  if (projectDeferred(project)) return 4;
  const schedule = projectGanttSchedule(project);
  const end = parseDate(project.target_date);
  const today = parseDate(todayISO());
  const remainingDays = end && today ? Math.ceil((end - today) / 86400000) : null;
  if (remainingDays !== null && remainingDays < 0) return 0;
  if (schedule.label === "需追蹤") return 1;
  if (remainingDays !== null && remainingDays <= 7) return 2;
  return 3;
}

function projectGanttComparator(left, right) {
  const priority = projectGanttPriority(left) - projectGanttPriority(right);
  if (priority) return priority;
  const leftDate = String((projectFinished(left) ? left.completed_date : left.target_date) || "9999-12-31");
  const rightDate = String((projectFinished(right) ? right.completed_date : right.target_date) || "9999-12-31");
  return projectFinished(left) ? rightDate.localeCompare(leftDate) : leftDate.localeCompare(rightDate);
}

function projectGanttTooltip(project, milestone) {
  const next = projectNextStep(project);
  return [
    project.course || "未命名課程",
    `日期：${humanDate(projectStartDate(project))}－${humanDate(project.completed_date || project.target_date)}｜${projectRemainingLabel(project)}`,
    `目前階段：${project.current_stage || "未設定"}`,
    `里程碑：${milestone.label}`,
    `下一步：${next.date ? `${humanDate(next.date)}　` : ""}${next.title}`,
  ].join("\n");
}

function showGanttTooltip(target) {
  const content = target.dataset.ganttTooltip;
  if (!content) return;
  let tooltip = document.querySelector("#ganttHoverCard");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "ganttHoverCard";
    tooltip.className = "gantt-hover-card";
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
  }
  tooltip.textContent = content;
  tooltip.hidden = false;
  const anchor = target.matches(".project-gantt-row") ? target.querySelector(".project-gantt-bar") || target : target;
  const targetBox = anchor.getBoundingClientRect();
  const tooltipBox = tooltip.getBoundingClientRect();
  const left = Math.max(10, Math.min(window.innerWidth - tooltipBox.width - 10, targetBox.left + targetBox.width / 2 - tooltipBox.width / 2));
  const above = targetBox.top - tooltipBox.height - 10;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${above >= 10 ? above : targetBox.bottom + 10}px`;
}

function hideGanttTooltip() {
  const tooltip = document.querySelector("#ganttHoverCard");
  if (tooltip) tooltip.hidden = true;
}

function projectGantt(projects, emptyText) {
  if (!projects.length) return `<div class="project-empty">${emptyState(emptyText, "新增課程專案", "data-new-project")}</div>`;
  const ganttProjects = projects.slice().sort(projectGanttComparator);
  const range = projectGanttRange(state.projectGanttMonths);
  const monthBands = range.months.map((month) => `<span style="--month-left:${month.left}%;--month-width:${month.width}%"></span>`).join("");
  const monthLabels = range.months.map((month) => `<span style="--month-left:${month.left}%;--month-width:${month.width}%">${month.label}</span>`).join("");
  const todayVisible = range.todayPosition >= 0 && range.todayPosition <= 100;
  const todayLine = todayVisible ? `<span class="project-gantt-today" style="--today-position:${range.todayPosition}%"><b>今天 ${new Date().getMonth() + 1}/${new Date().getDate()}</b></span>` : "";
  const rows = ganttProjects.map((project) => {
    const start = parseDate(projectStartDate(project));
    const end = parseDate((projectFinished(project) ? project.completed_date : project.target_date) || project.target_date);
    const schedule = projectGanttSchedule(project);
    const milestone = projectMilestone(project);
    const tooltip = escapeHTML(projectGanttTooltip(project, milestone));
    const overlaps = start && end && end >= range.start && start <= range.end;
    let bar = `<span class="project-gantt-outside">不在目前範圍</span>`;
    if (overlaps) {
      const visibleStart = start < range.start ? range.start : start;
      const visibleEnd = end > range.end ? range.end : end;
      const left = Math.max(0, Math.round(((visibleStart - range.start) / 86400000) / range.totalDays * 10000) / 100);
      const width = Math.max(1.2, Math.round((((visibleEnd - visibleStart) / 86400000) + 1) / range.totalDays * 10000) / 100);
      const deadlineVisible = end >= range.start && end <= range.end;
      const deadlineLabel = `${projectFinished(project) ? "完成日期" : "預計完成"}：${humanDate(end ? dateISO(end) : "")}｜${projectRemainingLabel(project)}`;
      bar = `<button type="button" class="project-gantt-bar ${schedule.tone} ${projectFinished(project) ? "finished" : ""}" style="--bar-left:${left}%;--bar-width:${width}%;--actual-progress:${schedule.actual}%;--expected-progress:${schedule.expected}%" data-project-open="${escapeHTML(project.id)}" data-gantt-tooltip="${tooltip}" aria-label="${escapeHTML(project.course || "未命名課程")}，實際進度 ${schedule.actual}%，${escapeHTML(milestone.label)}">
        <span class="project-gantt-actual"></span><span class="project-gantt-expected" title="今日預計進度 ${schedule.expected}%"></span>${deadlineVisible ? `<span class="project-gantt-deadline" title="${escapeHTML(deadlineLabel)}"></span>` : ""}<b>${schedule.actual}%</b>
      </button>`;
    }
    return `<div class="project-gantt-row" data-gantt-tooltip="${tooltip}">
      <button type="button" class="project-gantt-info" data-project-open="${escapeHTML(project.id)}">
        <strong>${escapeHTML(project.course || "未命名課程")}</strong>
        <span>${escapeHTML(project.teacher || "未設定老師")}｜${humanDate(projectStartDate(project))}－${humanDate(end ? dateISO(end) : "")}</span>
        <small class="project-gantt-status ${schedule.tone}-text" title="${schedule.actual}%｜${escapeHTML(milestone.label)}｜${schedule.label}">${schedule.actual}%｜${escapeHTML(milestone.label)} · ${schedule.label}</small>
      </button>
      <div class="project-gantt-track">${monthBands}${todayLine}${bar}</div>
    </div>`;
  }).join("");
  const mobileRows = ganttProjects.map((project) => {
    const schedule = projectGanttSchedule(project);
    const milestone = projectMilestone(project);
    const mobileTone = schedule.label === "進度正常" ? "gray" : schedule.tone;
    return `<button type="button" class="project-gantt-mobile-card" data-project-open="${escapeHTML(project.id)}">
      <span class="project-gantt-mobile-head"><strong>${escapeHTML(project.course || "未命名課程")}</strong>${pill(schedule.label, mobileTone)}</span>
      <span class="project-gantt-mobile-meta">${escapeHTML(project.teacher || "未設定老師")}｜${humanDate(projectStartDate(project))}－${humanDate(project.completed_date || project.target_date)}</span>
      <span class="project-gantt-mobile-progress"><i style="--actual-progress:${schedule.actual}%"></i><b>${schedule.actual}%</b></span>
      <span class="project-gantt-mobile-foot"><small>${escapeHTML(milestone.label)}</small><small class="${schedule.tone}-text">${projectRemainingLabel(project)}</small></span>
    </button>`;
  }).join("");
  return `<section class="project-gantt-view">
    <div class="project-gantt-toolbar">
      <div class="project-gantt-legend"><span class="planned">計畫期間</span><span class="actual">實際進度</span><span class="expected">今日預計位置</span></div>
      <div class="segmented-control project-gantt-range" aria-label="甘特圖時間範圍">
        ${[3, 6, 12].map((months) => `<button type="button" class="${state.projectGanttMonths === months ? "active" : ""}" data-gantt-months="${months}">${months === 12 ? "全年" : `${months}個月`}</button>`).join("")}
      </div>
    </div>
    <div class="project-gantt-scroll">
      <div class="project-gantt-grid">
        <div class="project-gantt-header"><div class="project-gantt-info project-gantt-info-header">專案與執行進度</div><div class="project-gantt-months">${monthLabels}${todayLine}</div></div>
        ${rows}
      </div>
    </div>
    <div class="project-gantt-mobile-list">${mobileRows}</div>
  </section>`;
}

function projectCards(projects, emptyText) {
  if (!projects.length) return `<div class="project-empty">${emptyState(emptyText, "新增課程專案", "data-new-project")}</div>`;
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
          ${pill(badge, finished ? "gray" : "")}
        </div>
        <p class="project-stage-line ${risk.tone}-text">${finished ? "此專案已結束，不再列入待處理工作" : `目前階段：${escapeHTML(project.current_stage || "未設定")}　狀態：${escapeHTML(risk.label)}`}</p>
        <p class="project-next-line ${finished ? "muted" : next.date ? "primary-text" : "red-text"}">${finished
          ? `完成日期：${humanDate(project.completed_date || project.target_date)}`
          : `下一步（自動）：${next.date ? humanDate(next.date) : "尚未排程"}　${escapeHTML(next.title)}`}</p>
        <div class="project-card-actions">
          <button class="ghost-button small-project-button ${finished ? "" : "project-open-button"}" data-project-open="${escapeHTML(project.id)}">開啟專案</button>
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
        <button class="ghost-button mobile-project-back" data-page="projects">返回專案</button>
        ${pill(finished ? "已完成｜此專案結束" : risk.label, finished ? "green" : risk.tone)}
        <div class="toolbar summary-buttons">
          ${finished
            ? `<button class="primary-button" data-project-reopen="${escapeHTML(project.id)}">重新開啟專案</button>`
            : `<button class="primary-button" data-project-complete="${escapeHTML(project.id)}">完成專案</button>`}
          <button class="ghost-button" data-task-add="${escapeHTML(project.id)}">新增工作</button>
          <button class="ghost-button" data-project-edit="${escapeHTML(project.id)}">編輯專案</button>
          ${links["雲端資料夾"] ? `<button class="ghost-button" data-open-url="${escapeHTML(links["雲端資料夾"])}">開啟雲端</button>` : ""}
          ${links["講師 Gmail"] ? `<button class="ghost-button" data-open-email="${escapeHTML(links["講師 Gmail"])}">寄信給講師</button>` : ""}
        </div>
      </div>
    </section>
    <nav class="project-mobile-tabs" aria-label="專案內容分頁">
      ${[["work", "工作"], ["checklist", "清單"], ["message", "留言"], ["history", "紀錄"]].map(([value, label]) => `<button class="${state.projectMobileTab === value ? "active" : ""}" data-project-mobile-tab="${value}">${label}</button>`).join("")}
    </nav>
    <div class="project-detail-columns">
      <section class="project-work-card project-mobile-panel ${state.projectMobileTab === "work" ? "active" : ""}" data-project-mobile-panel="work">
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
      <section class="project-work-card project-mobile-panel ${state.projectMobileTab === "checklist" ? "active" : ""}" data-project-mobile-panel="checklist">
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
    <section class="project-board-card project-mobile-panel ${state.projectMobileTab === "message" ? "active" : ""}" data-project-mobile-panel="message">
      <div><h3>留言板</h3><p class="muted">記錄跟老師說了什麼、目前狀況；送出時會自動加上日期時間。</p></div>
      <form class="message-compose" id="messageForm">
        <textarea class="textarea" name="message" rows="3" aria-label="留言內容"></textarea>
        <button class="primary-button" type="submit">新增留言</button>
      </form>
      <div class="message-list">${messages.map((message) => `<div class="message-row"><span>${escapeHTML((message.time || message.created_at || "").replace("T", " ").slice(0, 16))}　${escapeHTML(message.text || "")}</span><button class="danger-button" data-message-delete="${escapeHTML(message.id)}">刪除</button></div>`).join("") || `<p class="muted">尚無留言。</p>`}</div>
    </section>
    <section class="project-history-card project-mobile-panel ${state.projectMobileTab === "history" ? "active" : ""}" data-project-mobile-panel="history">
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
    <button type="button" class="mobile-project-task-complete mobile-task-complete" data-complete="${escapeHTML(task.id)}" aria-label="完成 ${escapeHTML(task.title || "未命名工作")}">○</button>
    <button type="button" class="compact-task-content mobile-task-content" data-task-edit="${escapeHTML(task.id)}"><strong class="${task.status === STATUS_WAITING ? "amber-text" : ""}">${status}　${escapeHTML(task.title || "未命名工作")}</strong><small>${humanDate(task.date)} ${escapeHTML(task.time || "")}</small></button>
    <div class="toolbar"><button class="primary-button compact-button" data-complete="${escapeHTML(task.id)}">完成</button><button class="ghost-button compact-button" data-postpone="${escapeHTML(task.id)}">延後</button><button class="ghost-button compact-button" data-task-edit="${escapeHTML(task.id)}">編輯</button></div>
    ${taskOverflowMenu(task, { postpone: true })}
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
  if (!tasks.length) return emptyState(emptyText, phoneMode ? "新增電話" : "新增工作", phoneMode ? "data-phone-add" : `data-calendar-add="${todayISO()}"`);
  return tasks.map((task) => {
    const project = projectById(task.project_id);
    const completed = task.status === STATUS_COMPLETED || task.phone_status === "已聯繫";
    const statusTone = completed ? "green" : task.status === STATUS_WAITING ? "amber" : task.date && task.date < todayISO() ? "red" : "";
    return `
      <article class="item-card ${completed ? "completed" : ""}">
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
          <button class="small-button" data-task-edit="${escapeHTML(task.id)}">編輯</button>
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

const CALENDAR_PROJECT_COLORS = [
  { color: "#5166e6", soft: "#eef0ff", border: "#cdd4ff" },
  { color: "#16847a", soft: "#e8f6f3", border: "#b7e1da" },
  { color: "#a66321", soft: "#fff4e5", border: "#eed1a6" },
  { color: "#b34f68", soft: "#fceef2", border: "#edc4cf" },
  { color: "#6f5bb5", soft: "#f1eefb", border: "#d5ccef" },
  { color: "#3d7896", soft: "#eaf5fa", border: "#bedce9" },
  { color: "#5f7d3d", soft: "#eff6e9", border: "#cde0bd" },
];

function calendarColor(task) {
  const project = projectById(task.project_id);
  if (!project) return CALENDAR_PROJECT_COLORS[0];
  const key = `${project.id || ""}${project.course || ""}`;
  const hash = [...key].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 0);
  return CALENDAR_PROJECT_COLORS[1 + (hash % (CALENDAR_PROJECT_COLORS.length - 1))];
}

function calendarColorStyle(task) {
  const color = calendarColor(task);
  return `--event-color:${color.color};--event-soft:${color.soft};--event-border:${color.border}`;
}

function calendarTaskKind(task) {
  if (task.task_type === TASK_TYPE_PHONE) return { short: "電話", label: "電話聯繫" };
  if (task.project_id) return { short: "專案", label: "專案工作" };
  return { short: "個人", label: "個人工作" };
}

function calendarEvent(task, extraClass = "") {
  const kind = calendarTaskKind(task);
  return `<button type="button" draggable="true" class="calendar-event ${extraClass} ${task.status === STATUS_COMPLETED ? "completed" : ""}" style="${calendarColorStyle(task)}" data-calendar-task="${escapeHTML(task.id)}" title="${escapeHTML(kind.label)}，拖曳以調整日期或時間"><i class="calendar-event-kind">${escapeHTML(kind.short)}</i><b>${escapeHTML(task.time || "全天")}</b><span>${escapeHTML(task.title || "未命名工作")}</span></button>`;
}

function renderCalendarPanelTask(task) {
  const project = projectById(task.project_id);
  const completed = task.status === STATUS_COMPLETED;
  const kind = calendarTaskKind(task);
  return `<article class="calendar-panel-task ${completed ? "completed" : ""}" style="${calendarColorStyle(task)}">
    <div class="calendar-panel-task-main">
      ${completed ? `<span class="calendar-task-color" aria-hidden="true"></span>` : `<button type="button" class="calendar-task-color mobile-task-complete" data-complete="${escapeHTML(task.id)}" aria-label="完成 ${escapeHTML(task.title || "未命名工作")}"></button>`}
      <button type="button" class="calendar-panel-task-copy mobile-task-content" data-task-edit="${escapeHTML(task.id)}"><p class="calendar-panel-title">${escapeHTML(task.title || "未命名工作")}</p><p class="calendar-panel-meta">${escapeHTML(kind.label)} · ${escapeHTML(task.time || "全天")} · ${escapeHTML(project?.course || "我的工作")}${task.reminder_minutes !== undefined && task.reminder_minutes !== "" ? ` · ${escapeHTML(reminderLabel(task.reminder_minutes))}` : ""}</p>${task.note ? `<p class="calendar-panel-note">${escapeHTML(task.note)}</p>` : ""}</button>
      ${taskOverflowMenu(task, { postpone: !completed, delete: true, goToProject: Boolean(project) })}
    </div>
    <div class="calendar-panel-actions">
      ${completed ? pill("已完成", "green") : `<button class="small-button" data-complete="${escapeHTML(task.id)}">完成</button>`}
      ${project ? `<button class="small-button project-jump-button" data-project-open="${escapeHTML(project.id)}">前往專案</button>` : ""}
      ${completed ? "" : `<button class="small-button" data-postpone="${escapeHTML(task.id)}">延後一天</button>`}
      <button class="small-button" data-task-edit="${escapeHTML(task.id)}">編輯</button>
      <button class="calendar-delete-button" data-calendar-delete="${escapeHTML(task.id)}">刪除</button>
    </div>
  </article>`;
}

function renderCalendarPanel(tasks) {
  if (!tasks.length) return `<div class="calendar-panel-empty"><strong>這一天沒有工作</strong><p>雙擊日期或使用下方按鈕安排事項。</p><button type="button" class="small-button" data-calendar-add="${escapeHTML(state.selectedCalendarDate)}">新增當日工作</button></div>`;
  return tasks.map(renderCalendarPanelTask).join("");
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
    ${renderMobileCalendarAgenda(anchor, selectedTasks, selectedDateLabel)}
    <div class="grid calendar-layout ${state.calendarView}-view-layout">
      <div class="calendar-view-main">${state.calendarView === "month" ? renderMonthCalendar(anchor) : state.calendarView === "week" ? renderWeekCalendar(anchor) : renderDayCalendar(anchor)}</div>
      <button type="button" class="calendar-sheet-backdrop ${state.calendarMobilePanelOpen ? "open" : ""}" data-calendar-panel-close aria-label="關閉所選日期工作"></button>
      <aside class="calendar-day-panel ${state.calendarMobilePanelOpen ? "open" : ""}" aria-live="polite">
        <div class="calendar-day-header"><div><p class="calendar-day-kicker">${selectedDate === todayISO() ? "今日工作項目" : "所選日期工作"}</p><h4>${escapeHTML(selectedDateLabel)}</h4></div><div class="toolbar">${pill(`${selectedTasks.length} 件`, selectedTasks.length ? "green" : "gray")}<button class="icon-button calendar-add-button" data-calendar-add="${escapeHTML(selectedDate)}" title="新增工作">＋</button><button class="icon-button calendar-panel-close" data-calendar-panel-close title="關閉">×</button></div></div>
        <div class="calendar-panel-list">${renderCalendarPanel(selectedTasks)}</div>
      </aside>
    </div>
  </section>`;
}

function renderMobileCalendarAgenda(anchor, selectedTasks, selectedDateLabel) {
  const start = weekStart(anchor);
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  return `<div class="mobile-calendar-agenda">
    <div class="mobile-agenda-navigation">
      <button type="button" class="icon-button" data-mobile-calendar-shift="-7" aria-label="上一週">‹</button>
      <button type="button" class="small-button" data-mobile-calendar-today>今天</button>
      <strong>${escapeHTML(weekRangeLabel(anchor))}</strong>
      <button type="button" class="icon-button" data-mobile-calendar-shift="7" aria-label="下一週">›</button>
    </div>
    <div class="mobile-date-strip">
      ${dates.map((date) => {
        const iso = dateISO(date);
        const count = tasksOnDate(iso).length;
        return `<button type="button" class="mobile-date-button ${iso === todayISO() ? "today" : ""} ${iso === state.selectedCalendarDate ? "selected" : ""}" data-calendar-date="${iso}" data-calendar-inline>
          <span>${["日", "一", "二", "三", "四", "五", "六"][date.getDay()]}</span><strong>${date.getDate()}</strong>${count ? `<i>${count}</i>` : ""}
        </button>`;
      }).join("")}
    </div>
    <section class="mobile-agenda-list">
      <div class="calendar-day-header"><div><p class="calendar-day-kicker">${state.selectedCalendarDate === todayISO() ? "今日工作項目" : "當日工作項目"}</p><h4>${escapeHTML(selectedDateLabel)}</h4></div><div class="toolbar">${pill(`${selectedTasks.length} 件`, selectedTasks.length ? "green" : "gray")}<button class="icon-button calendar-add-button" data-calendar-add="${escapeHTML(state.selectedCalendarDate)}" title="新增工作">＋</button></div></div>
      <div class="calendar-panel-list">${renderCalendarPanel(selectedTasks)}</div>
    </section>
    <button type="button" class="mobile-month-toggle" data-mobile-month-toggle aria-expanded="${state.calendarMobileMonthOpen}">${state.calendarMobileMonthOpen ? "收起完整月曆" : "查看完整月曆"}</button>
    <div class="mobile-month-calendar ${state.calendarMobileMonthOpen ? "open" : ""}">${renderMonthCalendar(anchor)}</div>
  </div>`;
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
  const tasks = dates.flatMap((date) => tasksOnDate(dateISO(date)));
  const hours = calendarHours(tasks, dates.some((date) => dateISO(date) === todayISO()));
  return `<div class="week-calendar" data-calendar-scroll>
    <div class="week-time-header"><span class="time-gutter"></span>${dates.map((date) => { const iso = dateISO(date); return `<button type="button" class="week-date-heading ${iso === todayISO() ? "today" : ""} ${iso === state.selectedCalendarDate ? "selected" : ""}" data-calendar-date="${iso}"><span>週${["日", "一", "二", "三", "四", "五", "六"][date.getDay()]}</span><strong>${date.getDate()}</strong></button>`; }).join("")}</div>
    <div class="week-all-day"><strong>全天</strong>${dates.map((date) => { const iso = dateISO(date); const allDay = tasksOnDate(iso).filter((task) => !task.time); return `<div data-calendar-drop="${iso}" data-drop-all-day>${allDay.map((task) => calendarEvent(task, "week-event")).join("")}</div>`; }).join("")}</div>
    <div class="time-grid-scroll"><div class="week-hours">${hours.map((hour) => { const prefix = String(hour).padStart(2, "0"); return `<div class="week-hour-row"><time>${prefix}:00</time>${dates.map((date) => { const iso = dateISO(date); const hourTasks = tasksOnDate(iso).filter((task) => String(task.time || "").startsWith(prefix)); return `<div class="week-time-cell ${iso === state.selectedCalendarDate ? "selected" : ""}" data-calendar-drop="${iso}" data-drop-time="${prefix}:00" title="雙擊新增工作">${currentTimeMarker(iso, hour)}${hourTasks.map((task) => calendarEvent(task, "week-event")).join("")}</div>`; }).join("")}</div>`; }).join("")}</div></div>
  </div>`;
}

function renderDayCalendar(anchor) {
  const iso = dateISO(anchor);
  const tasks = tasksOnDate(iso);
  const allDay = tasks.filter((task) => !task.time);
  const hours = calendarHours(tasks, iso === todayISO());
  return `<div class="day-agenda"><div class="all-day-row" data-calendar-drop="${iso}" data-drop-all-day><strong>全天</strong><div>${allDay.map((task) => calendarEvent(task, "agenda-event")).join("") || `<span class="muted">沒有全天工作</span>`}</div></div><div class="time-grid-scroll" data-calendar-scroll>${hours.map((hour) => { const prefix = String(hour).padStart(2, "0"); const hourTasks = tasks.filter((task) => String(task.time || "").startsWith(prefix)); return `<div class="hour-row" data-calendar-drop="${iso}" data-drop-time="${prefix}:00" title="雙擊新增工作"><time>${prefix}:00</time><div>${currentTimeMarker(iso, hour)}${hourTasks.map((task) => calendarEvent(task, "agenda-event")).join("")}</div></div>`; }).join("")}</div></div>`;
}

function calendarHours(tasks, includesToday = false) {
  const taskHours = tasks.filter((task) => task.time).map((task) => Number(String(task.time).slice(0, 2))).filter((hour) => Number.isInteger(hour));
  if (includesToday) taskHours.push(new Date().getHours());
  const start = Math.max(0, Math.min(7, ...taskHours));
  const end = Math.min(23, Math.max(22, ...taskHours));
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function currentTimeMarker(iso, hour) {
  const now = new Date();
  if (iso !== todayISO() || hour !== now.getHours()) return "";
  return `<span class="current-time-line" style="--minute-offset:${now.getMinutes() / 60}" aria-label="現在時間"></span>`;
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

function readLocalRecord(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function shortDateTime(value) {
  const text = String(value || "");
  return text ? text.slice(0, 16).replace("T", " ") : "";
}

function notificationSettingsState() {
  const permission = "Notification" in window ? window.Notification.permission : "unsupported";
  const push = readLocalRecord(PUSH_STATUS_KEY);
  const test = readLocalRecord(NOTIFICATION_TEST_KEY);
  const permissionLabel = !CLOUD_MODE ? "需使用 HTTPS 雲端版"
    : permission === "unsupported" ? "瀏覽器不支援"
      : permission === "granted" ? "已允許"
        : permission === "denied" ? "已封鎖" : "尚未啟用";
  const permissionTone = permission === "granted" ? "success" : permission === "denied" || permission === "unsupported" ? "danger" : "pending";
  const pushLabel = permission !== "granted" ? "等待通知權限"
    : push?.subscribed ? `已訂閱${push.checked_at ? `・${shortDateTime(push.checked_at)}` : ""}`
      : push ? `未訂閱・${shortDateTime(push.checked_at)}` : "尚未檢查";
  const pushTone = push?.subscribed && permission === "granted" ? "success" : push ? "danger" : "pending";
  const testLabel = !test ? "尚未測試"
    : `${test.success ? "成功" : "失敗"}・${shortDateTime(test.checked_at)}${!test.success && test.message ? `・${test.message}` : ""}`;
  return { permission, permissionLabel, permissionTone, pushLabel, pushTone, testLabel, testTone: test?.success ? "success" : test ? "danger" : "pending" };
}

function renderSettings() {
  const data = state.workspace;
  const notifications = notificationSettingsState();
  return `
    <section class="card">
      <div class="card-header">
        <div><h3>資料設定</h3><p class="muted">${CLOUD_MODE ? "資料會自動同步至雲端" : "目前資料保存在這個瀏覽器"}</p></div>
      </div>
      <div class="grid dashboard-grid">
        <div class="import-panel mobile-account-panel">
          <h4>雲端與帳號</h4>
          <p class="muted">${CLOUD_MODE ? "資料會自動同步至雲端" : "目前使用瀏覽器本機資料"}</p>
          <div class="toolbar"><button class="ghost-button" data-mobile-refresh>重新同步</button>${CLOUD_MODE ? `<button class="danger-button" data-mobile-logout>登出</button>` : ""}</div>
        </div>
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
          <p class="muted">確認這台裝置是否能收到排程提醒。</p>
          <div class="notification-status-list">
            <div><span>瀏覽器權限</span><strong class="${notifications.permissionTone}">${escapeHTML(notifications.permissionLabel)}</strong></div>
            <div><span>推播訂閱</span><strong class="${notifications.pushTone}">${escapeHTML(notifications.pushLabel)}</strong></div>
            <div><span>最近測試</span><strong class="${notifications.testTone}">${escapeHTML(notifications.testLabel)}</strong></div>
          </div>
          <div class="toolbar notification-actions">
            <button class="primary-button" data-notifications ${!CLOUD_MODE || notifications.permission === "unsupported" || notifications.permission === "denied" ? "disabled" : ""}>${notifications.permission === "granted" ? "確認啟用通知" : "啟用這台裝置的通知"}</button>
            <button class="ghost-button" data-test-notification ${notifications.permission === "granted" ? "" : "disabled"}>測試通知</button>
            <button class="ghost-button" data-refresh-notifications ${!CLOUD_MODE || notifications.permission === "unsupported" ? "disabled" : ""}>重新檢查</button>
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
          <p class="muted">可只匯出年度資料；封存會先下載完整備份，再把已完成資料移至封存區。</p>
          <div class="archive-controls">
            <input class="search-input" id="archiveYear" type="number" min="2000" max="2100" value="${new Date().getFullYear() - 1}" aria-label="封存年度">
            <div class="toolbar"><button class="ghost-button" data-export-year>匯出年度資料</button><button class="danger-button" data-archive-year>封存已完成資料</button></div>
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

function selectCalendarDate(iso, openMobilePanel = true) {
  state.selectedCalendarDate = iso;
  state.calendarMobilePanelOpen = openMobilePanel;
  const selected = parseDate(iso);
  if (selected) state.selectedMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
}

function calendarDoubleActivation(key) {
  const now = Date.now();
  const isDouble = lastCalendarActivationKey === key && now - lastCalendarActivationAt <= 350;
  lastCalendarActivationKey = isDouble ? "" : key;
  lastCalendarActivationAt = isDouble ? 0 : now;
  return isDouble;
}

function navigateCalendarPeriod(offset) {
  const now = new Date();
  const anchor = offset === 0 ? now : (parseDate(state.selectedCalendarDate) || now);
  if (offset !== 0) {
    if (state.calendarView === "month") anchor.setMonth(anchor.getMonth() + offset);
    else anchor.setDate(anchor.getDate() + offset * (state.calendarView === "week" ? 7 : 1));
  }
  selectCalendarDate(dateISO(anchor), false);
  render();
}

function scrollCalendarToCurrentTime() {
  const scrollArea = document.querySelector("[data-calendar-scroll]");
  const marker = scrollArea?.querySelector(".current-time-line");
  if (!scrollArea || !marker) return;
  window.requestAnimationFrame(() => {
    const scrollBox = scrollArea.getBoundingClientRect();
    const markerBox = marker.getBoundingClientRect();
    scrollArea.scrollTop += markerBox.top - scrollBox.top - (scrollArea.clientHeight * 0.32);
  });
}

function bindCalendarSwipe() {
  const surface = document.querySelector(".calendar-view-main");
  if (!surface) return;
  let startX = 0;
  let startY = 0;
  surface.addEventListener("touchstart", (event) => {
    if (event.target.closest("button, input, select, textarea, [data-calendar-task]")) return;
    const touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });
  surface.addEventListener("touchend", (event) => {
    if (!startX && !startY) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    startX = 0;
    startY = 0;
    if (Math.abs(deltaX) < 55 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return;
    calendarSwipeUntil = Date.now() + 450;
    navigateCalendarPeriod(deltaX < 0 ? 1 : -1);
  }, { passive: true });
}

function bindContentEvents() {
  document.querySelectorAll("[data-search-close]").forEach((button) => button.addEventListener("click", () => setPage(state.pageBeforeSearch || "dashboard")));
  const projectSearch = $("#projectSearch");
  if (projectSearch) {
    projectSearch.addEventListener("input", (event) => {
      state.query = event.target.value;
      scheduleSearchRender("#projectSearch");
    });
  }
  const roleFilter = $("#projectRoleFilter");
  if (roleFilter) roleFilter.addEventListener("change", (event) => { state.projectRoleFilter = event.target.value; render(); });
  const modeFilter = $("#projectModeFilter");
  if (modeFilter) modeFilter.addEventListener("change", (event) => { state.projectModeFilter = event.target.value; render(); });
  document.querySelectorAll("[data-project-status]").forEach((button) => button.addEventListener("click", () => {
    state.projectStatusFilter = button.dataset.projectStatus;
    if (state.projectTableSort === "target_date") state.projectTableSortDirection = state.projectStatusFilter === "completed" ? "desc" : "asc";
    render();
  }));
  document.querySelectorAll("[data-project-view]").forEach((button) => button.addEventListener("click", () => {
    state.projectView = button.dataset.projectView;
    render();
  }));
  document.querySelectorAll("[data-gantt-months]").forEach((button) => button.addEventListener("click", () => {
    state.projectGanttMonths = Number(button.dataset.ganttMonths) || 6;
    render();
  }));
  document.querySelectorAll(".project-gantt-row[data-gantt-tooltip]").forEach((row) => {
    row.addEventListener("mouseenter", () => showGanttTooltip(row));
    row.addEventListener("mouseleave", hideGanttTooltip);
  });
  document.querySelectorAll(".project-gantt-bar[data-gantt-tooltip]").forEach((bar) => {
    bar.addEventListener("focus", () => showGanttTooltip(bar));
    bar.addEventListener("blur", hideGanttTooltip);
  });
  document.querySelector(".project-gantt-scroll")?.addEventListener("scroll", hideGanttTooltip, { passive: true });
  document.querySelectorAll("[data-project-sort]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.projectSort;
    if (state.projectTableSort === key) {
      state.projectTableSortDirection = state.projectTableSortDirection === "asc" ? "desc" : "asc";
    } else {
      state.projectTableSort = key;
      state.projectTableSortDirection = key === "progress" ? "desc" : "asc";
    }
    render();
  }));
  const calendarSearch = $("#calendarSearch");
  if (calendarSearch) calendarSearch.addEventListener("input", (event) => {
    state.calendarQuery = event.target.value;
    scheduleSearchRender("#calendarSearch");
  });
  const calendarStatusFilter = $("#calendarStatusFilter");
  if (calendarStatusFilter) calendarStatusFilter.addEventListener("change", (event) => {
    state.calendarStatusFilter = event.target.value;
    render();
  });

  document.querySelectorAll("[data-project-open]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedProjectId = button.dataset.projectOpen;
      state.projectMobileTab = "work";
      state.page = "projectDetail";
      render();
    });
  });

  document.querySelectorAll("[data-project-mobile-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.projectMobileTab = button.dataset.projectMobileTab;
      render();
    });
  });

  document.querySelectorAll("[data-project-edit]").forEach((button) => button.addEventListener("click", () => openProjectDialog(projectById(button.dataset.projectEdit))));
  document.querySelectorAll("[data-project-complete]").forEach((button) => button.addEventListener("click", () => completeProject(button.dataset.projectComplete)));
  document.querySelectorAll("[data-project-reopen]").forEach((button) => button.addEventListener("click", () => reopenProject(button.dataset.projectReopen)));

  document.querySelectorAll("#content [data-page]").forEach((button) => {
    button.addEventListener("click", () => setPage(button.dataset.page));
  });

  document.querySelectorAll("[data-new-project]").forEach((button) => {
    button.addEventListener("click", () => openProjectDialog());
  });

  document.querySelectorAll("[data-task-add]").forEach((button) => button.addEventListener("click", () => openTaskDialog(null, button.dataset.taskAdd)));
  document.querySelectorAll("[data-phone-add]").forEach((button) => button.addEventListener("click", () => openTaskDialog({ date: todayISO(), status: "未完成", reminder_minutes: "0", task_type: TASK_TYPE_PHONE, phone_status: "待聯繫" })));
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
  document.querySelectorAll("[data-refresh-notifications]").forEach((button) => button.addEventListener("click", refreshNotificationStatus));
  document.querySelectorAll("[data-mobile-refresh]").forEach((button) => button.addEventListener("click", refreshWorkspace));
  document.querySelectorAll("[data-mobile-logout]").forEach((button) => button.addEventListener("click", logoutCloud));

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
  document.querySelectorAll("[data-open-url]").forEach((button) => button.addEventListener("click", () => {
    const url = validExternalUrl(button.dataset.openUrl);
    if (!url) {
      showToast("基於安全考量，只能開啟 http 或 https 網址");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }));
  document.querySelectorAll("[data-open-email]").forEach((button) => button.addEventListener("click", () => {
    const email = validEmailAddress(button.dataset.openEmail);
    if (!email) {
      showToast("講師 Email 格式不正確");
      return;
    }
    window.location.href = `mailto:${email}`;
  }));

  document.querySelectorAll("[data-complete]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.workspace.tasks.find((item) => item.id === button.dataset.complete);
      if (!task) return;
      const tasksBeforeCompletion = state.workspace.tasks.map((item) => ({ ...item }));
      completeTask(task);
      saveWorkspace();
      showToast("已標記完成", () => {
        state.workspace.tasks = tasksBeforeCompletion;
        saveWorkspace();
        render();
        showToast("已復原完成狀態");
      });
      render();
    });
  });

  document.querySelectorAll("[data-phone]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.workspace.tasks.find((item) => item.id === button.dataset.phone);
      if (!task) return;
      const tasksBeforeUpdate = state.workspace.tasks.map((item) => ({ ...item }));
      task.phone_status = button.dataset.status;
      if (button.dataset.status === "已聯繫") {
        completeTask(task);
      }
      saveWorkspace();
      showToast(`電話狀態已更新：${button.dataset.status}`, () => {
        state.workspace.tasks = tasksBeforeUpdate;
        saveWorkspace();
        render();
        showToast("已復原電話狀態");
      });
      render();
    });
  });

  document.querySelectorAll("[data-calendar-view]").forEach((button) => button.addEventListener("click", () => {
    state.calendarView = button.dataset.calendarView;
    render();
  }));

  document.querySelectorAll("[data-mobile-calendar-shift]").forEach((button) => button.addEventListener("click", () => {
    const anchor = parseDate(state.selectedCalendarDate) || new Date();
    anchor.setDate(anchor.getDate() + Number(button.dataset.mobileCalendarShift));
    selectCalendarDate(dateISO(anchor), false);
    render();
  }));
  document.querySelectorAll("[data-mobile-calendar-today]").forEach((button) => button.addEventListener("click", () => {
    selectCalendarDate(todayISO(), false);
    render();
  }));
  document.querySelectorAll("[data-mobile-month-toggle]").forEach((button) => button.addEventListener("click", () => {
    state.calendarMobileMonthOpen = !state.calendarMobileMonthOpen;
    render();
  }));

  document.querySelectorAll("[data-period]").forEach((button) => {
    button.addEventListener("click", () => navigateCalendarPeriod(Number(button.dataset.period)));
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

  document.querySelectorAll("[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.target.closest("[data-calendar-task]") || Date.now() < calendarSwipeUntil) return;
      const date = button.dataset.calendarDate;
      const isDoubleActivation = calendarDoubleActivation(`date:${date}`);
      selectCalendarDate(date, !button.hasAttribute("data-calendar-inline"));
      render();
      if (isDoubleActivation) openTaskDialog({ date, status: "未完成", reminder_minutes: "0" });
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
      if (target.dataset.dropAllDay !== undefined) task.time = "";
      task.updated_at = new Date().toISOString();
      state.selectedCalendarDate = task.date;
      saveWorkspace(); showToast("工作時間已調整"); render();
    });
  });
  document.querySelectorAll("[data-drop-time]").forEach((target) => target.addEventListener("click", (event) => {
    if (event.target.closest("[data-calendar-task]")) return;
    const date = target.dataset.calendarDrop;
    const time = target.dataset.dropTime;
    const isDoubleActivation = calendarDoubleActivation(`time:${date}:${time}`);
    selectCalendarDate(date);
    render();
    if (isDoubleActivation) openTaskDialog({ date, time, status: "未完成", reminder_minutes: "0" });
  }));
  document.querySelectorAll("[data-calendar-add]").forEach((button) => button.addEventListener("click", () => {
    openTaskDialog({ date: button.dataset.calendarAdd || state.selectedCalendarDate, status: "未完成", reminder_minutes: "0" });
  }));
  document.querySelectorAll("[data-calendar-panel-close]").forEach((button) => button.addEventListener("click", () => {
    state.calendarMobilePanelOpen = false;
    render();
  }));
  document.querySelectorAll("[data-calendar-delete]").forEach((button) => button.addEventListener("click", () => deleteTask(button.dataset.calendarDelete)));

  bindCalendarSwipe();
  scrollCalendarToCurrentTime();

  document.querySelectorAll("[data-import]").forEach((button) => button.addEventListener("click", openImporter));
  document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", exportWorkspace));
  document.querySelectorAll("[data-export-csv]").forEach((button) => button.addEventListener("click", exportTasksCSV));
  document.querySelectorAll("[data-export-year]").forEach((button) => button.addEventListener("click", exportYearData));
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

function selectedArchiveYear() {
  const year = Number($("#archiveYear")?.value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    showToast("請輸入正確的封存年度");
    return null;
  }
  return year;
}

function archiveYearSelection(year) {
  const yearPrefix = `${year}-`;
  const completedTaskIds = new Set(state.workspace.tasks
    .filter((task) => task.status === STATUS_COMPLETED && String(task.completed_at || task.date || "").startsWith(yearPrefix))
    .map((task) => task.id));
  const completedProjectIds = new Set(state.workspace.projects
    .filter((project) => projectFinished(project) && String(project.completed_date || project.target_date || project.target_month || "").startsWith(yearPrefix))
    .map((project) => project.id));
  const archivedTaskIds = new Set(state.workspace.tasks.filter((task) => completedTaskIds.has(task.id) || completedProjectIds.has(task.project_id)).map((task) => task.id));
  return {
    completedTaskIds,
    completedProjectIds,
    archivedTaskIds,
    projects: state.workspace.projects.filter((project) => completedProjectIds.has(project.id)),
    tasks: state.workspace.tasks.filter((task) => archivedTaskIds.has(task.id)),
    checklists: state.workspace.checklists.filter((group) => completedProjectIds.has(group.project_id)),
    progress_logs: state.workspace.progress_logs.filter((item) => completedProjectIds.has(item.project_id)),
    project_messages: state.workspace.project_messages.filter((item) => completedProjectIds.has(item.project_id)),
    history: state.workspace.history.filter((item) => completedProjectIds.has(item.project_id)),
  };
}

function buildYearArchive(year, selection) {
  return {
    id: uid("archive"), year, created_at: new Date().toISOString(),
    projects: selection.projects,
    tasks: selection.tasks,
    checklists: selection.checklists,
    progress_logs: selection.progress_logs,
    project_messages: selection.project_messages,
    history: selection.history,
  };
}

function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportYearData() {
  const year = selectedArchiveYear();
  if (year === null) return;
  const selection = archiveYearSelection(year);
  if (!selection.completedTaskIds.size && !selection.completedProjectIds.size) {
    showToast(`${year} 年沒有可封存的已完成資料`);
    return;
  }
  downloadJson(buildYearArchive(year, selection), `老師專案年度資料_${year}.json`);
  showToast(`已匯出 ${year} 年資料：${selection.completedProjectIds.size} 個專案、${selection.archivedTaskIds.size} 件工作`);
}

function archiveYear() {
  const year = selectedArchiveYear();
  if (year === null) return;
  const selection = archiveYearSelection(year);
  if (!selection.completedTaskIds.size && !selection.completedProjectIds.size) {
    showToast(`${year} 年沒有可封存的已完成資料`);
    return;
  }
  if (!confirm(`將先下載完整備份，再封存 ${year} 年已完成工作 ${selection.completedTaskIds.size} 件、已完成專案 ${selection.completedProjectIds.size} 件。封存後會從日常畫面隱藏，但仍可還原。確定繼續？`)) return;
  exportWorkspace();
  const archive = buildYearArchive(year, selection);
  state.workspace.archives.push(archive);
  [...selection.completedProjectIds, ...selection.archivedTaskIds, ...archive.checklists.map((item) => item.id), ...archive.progress_logs.map((item) => item.id), ...archive.project_messages.map((item) => item.id), ...archive.history.map((item) => item.id)].forEach(markDeleted);
  state.workspace.tasks = state.workspace.tasks.filter((task) => !selection.archivedTaskIds.has(task.id));
  state.workspace.projects = state.workspace.projects.filter((project) => !selection.completedProjectIds.has(project.id));
  state.workspace.checklists = state.workspace.checklists.filter((group) => !selection.completedProjectIds.has(group.project_id));
  state.workspace.progress_logs = state.workspace.progress_logs.filter((item) => !selection.completedProjectIds.has(item.project_id));
  state.workspace.project_messages = state.workspace.project_messages.filter((item) => !selection.completedProjectIds.has(item.project_id));
  state.workspace.history = state.workspace.history.filter((item) => !selection.completedProjectIds.has(item.project_id));
  saveWorkspace();
  showToast(`${year} 年已完成資料已封存`);
  render();
}

function downloadArchive(archiveId) {
  const archive = state.workspace.archives.find((item) => item.id === archiveId);
  if (!archive) return;
  downloadJson(archive, `老師專案封存_${archive.year}.json`);
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

function refreshWorkspace() {
  if (CLOUD_MODE) {
    const localWorkspace = cloneWorkspace(state.workspace);
    const baseWorkspace = cloudBaseWorkspace;
    const hasPendingChanges = cloudSavePending || localStorage.getItem(OFFLINE_DIRTY_KEY) === "1";
    loadCloudWorkspace().then(() => {
      if (hasPendingChanges) {
        state.workspace = mergeWorkspaces(state.workspace, localWorkspace, baseWorkspace);
        saveWorkspace();
        showToast("已重新整理並保留尚未同步的修改");
      } else {
        showToast("已重新整理雲端資料");
      }
      render();
    }).catch((error) => showToast(error.message));
  } else {
    state.workspace = loadWorkspace();
    showToast("已重新整理");
    render();
  }
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
    scheduleSearchRender("#globalSearch");
  });
  window.addEventListener("offline", () => {
    updateSyncIndicator("離線保存中", "offline");
    showToast("目前離線，仍可繼續使用");
  });
  window.addEventListener("online", async () => {
    updateSyncIndicator("正在恢復同步...", "syncing");
    try {
      await reconnectCloudWorkspace();
      showToast("已恢復連線並同步");
    } catch (error) {
      updateSyncIndicator("同步失敗", "error");
      showToast(error.message || "恢復同步失敗，請稍後再試");
    }
  });
  $("#refreshButton").addEventListener("click", refreshWorkspace);
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
      if (!workspaceImportIsValid(parsed)) throw new Error("備份資料格式不正確");
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
      <form class="form-grid" id="projectForm" autocomplete="off" novalidate>
        <nav class="project-form-tabs" aria-label="專案資料分區">
          <button type="button" class="active" data-project-form-tab="basic" aria-selected="true">基本資料</button>
          <button type="button" data-project-form-tab="schedule" aria-selected="false">進度安排</button>
          <button type="button" data-project-form-tab="links" aria-selected="false">相關連結</button>
        </nav>
        <section class="project-form-section active" data-project-form-section="basic">
          <label>
            <span>老師名稱</span>
            <input class="search-input" name="teacher" required value="${escapeHTML(project?.teacher || "")}" placeholder="例如：林老師" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
          </label>
          <label>
            <span>課程名稱</span>
            <input class="search-input" name="course" required value="${escapeHTML(project?.course || "")}" placeholder="例如：AI 角色影音創作" autocomplete="off" autocorrect="off" spellcheck="false">
          </label>
        </section>
        <section class="project-form-section" data-project-form-section="schedule">
          <div class="three-col">
            <label>
              <span>專案開始日</span>
              <input class="search-input" type="date" name="start_date" value="${escapeHTML(project ? projectStartDate(project) : todayISO())}" required>
            </label>
            <label>
              <span>目標月份</span>
              <input class="search-input" type="month" name="target_month" value="${escapeHTML(project?.target_month || currentMonth)}" required>
            </label>
            <label>
              <span>預計上架日</span>
              <input class="search-input" type="date" name="target_date" value="${escapeHTML(project?.target_date || "")}" required>
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
          ${project ? "" : `<label><span>建立時套用檢查清單</span><select class="select" name="template"><option value="">不套用</option>${(state.workspace.checklist_templates || []).map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name || "未命名範本")}</option>`).join("")}</select></label>`}
        </section>
        <section class="project-form-section" data-project-form-section="links">
          <label><span>雲端資料夾</span><input class="search-input" type="url" inputmode="url" name="cloud" value="${escapeHTML(project?.links?.["雲端資料夾"] || "")}" placeholder="https://..." autocomplete="off"></label>
          <label><span>講師 Gmail</span><input class="search-input" type="email" inputmode="email" name="teacher_email" value="${escapeHTML(project?.links?.["講師 Gmail"] || "")}" placeholder="teacher@gmail.com" autocomplete="email" autocapitalize="none" spellcheck="false"></label>
        </section>
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
  layer.querySelectorAll("[data-project-form-tab]").forEach((button) => button.addEventListener("click", () => {
    activateProjectFormSection(layer, button.dataset.projectFormTab);
  }));
  const deleteButton = layer.querySelector("[data-project-delete]");
  if (deleteButton) deleteButton.addEventListener("click", () => deleteProject(deleteButton.dataset.projectDelete));
  setupModalViewport(layer);
  if (!window.matchMedia("(max-width: 760px)").matches) layer.querySelector("input[name='teacher']").focus({ preventScroll: true });
}

function activateProjectFormSection(layer, sectionName) {
  layer.querySelectorAll("[data-project-form-tab]").forEach((button) => {
    const active = button.dataset.projectFormTab === sectionName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  layer.querySelectorAll("[data-project-form-section]").forEach((section) => {
    section.classList.toggle("active", section.dataset.projectFormSection === sectionName);
  });
}

function closeModal() {
  const layer = $("#modalLayer");
  if (modalViewportCleanup) modalViewportCleanup();
  modalViewportCleanup = null;
  layer.hidden = true;
  layer.innerHTML = "";
}

function setupModalViewport(layer) {
  if (modalViewportCleanup) modalViewportCleanup();
  const viewport = window.visualViewport;
  const updateViewport = () => {
    const height = Math.round(viewport?.height || window.innerHeight);
    const offsetTop = Math.round(viewport?.offsetTop || 0);
    layer.style.setProperty("--modal-viewport-height", `${height}px`);
    layer.style.setProperty("--modal-viewport-top", `${offsetTop}px`);
    layer.classList.toggle("keyboard-open", Boolean(viewport && height < window.innerHeight - 120));
  };
  const keepFocusedFieldVisible = (event) => {
    if (!event.target.matches("input, select, textarea")) return;
    window.setTimeout(() => {
      const field = event.target;
      if (!field.isConnected) return;
      const bounds = field.getBoundingClientRect();
      const visibleTop = viewport?.offsetTop || 0;
      const visibleBottom = visibleTop + (viewport?.height || window.innerHeight);
      if (bounds.top < visibleTop + 12 || bounds.bottom > visibleBottom - 12) {
        field.scrollIntoView({ block: "center", behavior: "auto" });
      }
    }, 120);
  };
  viewport?.addEventListener("resize", updateViewport);
  viewport?.addEventListener("scroll", updateViewport);
  layer.addEventListener("focusin", keepFocusedFieldVisible);
  updateViewport();
  modalViewportCleanup = () => {
    viewport?.removeEventListener("resize", updateViewport);
    viewport?.removeEventListener("scroll", updateViewport);
    layer.removeEventListener("focusin", keepFocusedFieldVisible);
    layer.classList.remove("keyboard-open");
    layer.style.removeProperty("--modal-viewport-height");
    layer.style.removeProperty("--modal-viewport-top");
  };
}

function saveProjectFromForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const teacher = String(form.get("teacher") || "").trim();
  const course = String(form.get("course") || "").trim();
  const startDate = String(form.get("start_date") || "").trim();
  const targetMonth = String(form.get("target_month") || "").trim();
  const targetDate = String(form.get("target_date") || "").trim();
  if (!teacher || !course) {
    activateProjectFormSection(event.currentTarget.closest(".modal-layer"), "basic");
    showToast("請填寫老師名稱與課程名稱");
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}$/.test(targetMonth) || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    activateProjectFormSection(event.currentTarget.closest(".modal-layer"), "schedule");
    showToast("請確認日期格式");
    return;
  }
  const rawCloudLink = String(form.get("cloud") || "").trim();
  const rawTeacherEmail = String(form.get("teacher_email") || "").trim();
  const cloudLink = validExternalUrl(rawCloudLink);
  const teacherEmail = validEmailAddress(rawTeacherEmail);
  if ((rawCloudLink && !cloudLink) || (rawTeacherEmail && !teacherEmail)) {
    activateProjectFormSection(event.currentTarget.closest(".modal-layer"), "links");
    showToast(rawCloudLink && !cloudLink ? "雲端資料夾必須是 http 或 https 網址" : "請輸入正確的講師 Email");
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
    teacher, course, source_name: course, start_date: startDate, target_month: targetMonth, target_date: targetDate,
    role: String(form.get("role") || ROLE_UNSET),
    mode: form.get("mode") === "直播" ? "live" : "recorded",
    cooperation_status: String(form.get("cooperation") || "順利"),
    current_stage: stage,
    links: { ...(project.links || {}), "雲端資料夾": cloudLink, "講師 Gmail": teacherEmail },
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
  state.projectMobileTab = "work";
  state.page = "projectDetail";
  saveWorkspace();
  closeModal();
  showToast(`已${existing ? "更新" : "建立"}「${course}」`);
  render();
}

function addHistory(text, projectId, type = "activity") {
  state.workspace.history.unshift({ id: uid("history"), project_id: projectId, time: new Date().toISOString().slice(0, 16), text, type });
}

function projectCompletionSummary(projectId) {
  const pendingTasks = tasksForProject(projectId).filter((task) => task.status !== STATUS_COMPLETED);
  const phoneTasks = pendingTasks.filter((task) => task.task_type === TASK_TYPE_PHONE);
  const workTasks = pendingTasks.filter((task) => task.task_type !== TASK_TYPE_PHONE);
  const checklistItems = state.workspace.checklists
    .filter((group) => group.project_id === projectId)
    .flatMap((group) => (group.items || []).filter((item) => !item.done).map((item) => ({ ...item, group_name: group.name || "檢查清單" })));
  return { workTasks, phoneTasks, checklistItems, total: workTasks.length + phoneTasks.length + checklistItems.length };
}

function completionIssueLine(label, items) {
  if (!items.length) return "";
  const names = items.slice(0, 3).map((item) => item.title || "未命名").join("、");
  return `・${label} ${items.length} 項${names ? `：${names}${items.length > 3 ? "⋯" : ""}` : ""}`;
}

function completeProject(projectId) {
  const project = projectById(projectId);
  if (!project || projectFinished(project)) return;
  const summary = projectCompletionSummary(projectId);
  const issueLines = [
    completionIssueLine("未完成工作", summary.workTasks),
    completionIssueLine("待聯繫電話", summary.phoneTasks),
    completionIssueLine("未完成檢查清單", summary.checklistItems),
  ].filter(Boolean).join("\n");
  const message = summary.total
    ? `「${project.course || "未命名專案"}」仍有未完成項目：\n\n${issueLines}\n\n這些項目不會被自動改為完成。仍要結束整個專案嗎？`
    : `已確認沒有未完成工作或檢查項目。確定將「${project.course || "未命名專案"}」標記為整個專案已完成？`;
  if (!confirm(message)) return;
  project.status = "已完成";
  project.completed_date = todayISO();
  project.last_update = todayISO();
  addHistory(`完成整個課程專案「${project.course || "未命名專案"}」`, project.id, "project");
  saveWorkspace();
  showToast("專案已完成，將從進行中總表隱藏");
  render();
}

function reopenProject(projectId) {
  const project = projectById(projectId);
  if (!project || !projectFinished(project)) return;
  project.status = "進行中";
  project.completed_date = "";
  if (["已完成", "已上架"].includes(project.current_stage)) project.current_stage = "課程上架";
  project.last_update = todayISO();
  addHistory(`重新開啟課程專案「${project.course || "未命名專案"}」`, project.id, "project");
  saveWorkspace();
  showToast("專案已重新移回進行中");
  render();
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
  const targetProjectId = projectId || task?.project_id || (state.page === "projectDetail" ? state.selectedProjectId : "");
  const isPhoneTask = task?.task_type === TASK_TYPE_PHONE;
  layer.hidden = false;
  layer.innerHTML = `<div class="modal-card compact-modal" role="dialog" aria-modal="true">
    <div class="modal-header"><h3>${task?.id ? (isPhoneTask ? "編輯電話聯繫" : "編輯工作") : (isPhoneTask ? "新增電話聯繫" : "新增工作排程")}</h3><button class="icon-button" data-close-modal aria-label="關閉">×</button></div>
    <form class="form-grid" id="taskForm" autocomplete="off">
      <label><span>工作內容</span><input class="search-input" name="title" required value="${escapeHTML(task?.title || "")}"></label>
      <div class="two-col"><label><span>日期</span><input class="search-input" type="date" name="date" value="${escapeHTML(task?.date || todayISO())}" required></label><label><span>時間</span><input class="search-input" type="time" name="time" value="${escapeHTML(task?.time || "")}"></label></div>
      <div class="two-col">
        <label><span>狀態</span><select class="select" name="status">${["未完成", "等待中", "已完成"].map((value) => `<option ${String(task?.status || "未完成") === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
        <label><span>提醒</span><select class="select" name="reminder_minutes">${[["", "不提醒"], ["0", "準時提醒"], ["10", "提前 10 分鐘"], ["60", "提前 1 小時"], ["1440", "提前 1 天"]].map(([value, label]) => `<option value="${value}" ${String(task?.reminder_minutes ?? "") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </div>
      <label><span>重複</span><select class="select" name="recurrence">${[["none", "不重複"], ["daily", "每天"], ["weekly", "每週"], ["monthly", "每月"]].map(([value, label]) => `<option value="${value}" ${String(task?.recurrence || "none") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label><span>所屬課程（選填）</span><select class="select" name="project_id"><option value="">我的工作</option>${state.workspace.projects.filter((project) => !projectFinished(project)).map((project) => `<option value="${escapeHTML(project.id)}" ${targetProjectId === project.id ? "selected" : ""}>${escapeHTML(project.course || project.teacher || "未命名專案")}</option>`).join("")}</select></label>
      <label><span>備註（選填）</span><textarea class="textarea" name="note" rows="3" placeholder="補充資訊、網址或處理方式">${escapeHTML(task?.note || "")}</textarea></label>
      <input type="hidden" name="task_id" value="${escapeHTML(task?.id || "")}"><input type="hidden" name="check_item_id" value="${escapeHTML(task?.linked_checklist_item_id || "")}"><input type="hidden" name="task_type" value="${escapeHTML(task?.task_type || "一般工作")}">
      <div class="modal-actions split-actions">${task?.id ? `<button type="button" class="danger-button" data-task-delete="${escapeHTML(task.id)}">刪除工作</button>` : `<span></span>`}<div class="toolbar"><button type="button" class="ghost-button" data-close-modal>取消</button><button class="primary-button">儲存工作</button></div></div>
    </form></div>`;
  layer.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  layer.querySelector("[data-task-delete]")?.addEventListener("click", (event) => deleteTask(event.currentTarget.dataset.taskDelete));
  $("#taskForm").addEventListener("submit", saveTaskFromForm);
  setupModalViewport(layer);
}

function saveTaskFromForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const taskId = String(form.get("task_id") || "");
  const taskType = String(form.get("task_type") || "一般工作");
  const task = state.workspace.tasks.find((item) => item.id === taskId) || { id: uid("task"), project_id: String(form.get("project_id") || ""), created_at: new Date().toISOString().slice(0, 19), task_type: taskType, phone_status: taskType === TASK_TYPE_PHONE ? "待聯繫" : "" };
  const wasCompleted = task.status === STATUS_COMPLETED;
  Object.assign(task, { title: String(form.get("title") || "").trim(), date: String(form.get("date") || ""), time: String(form.get("time") || ""), status: String(form.get("status") || "未完成"), project_id: String(form.get("project_id") || ""), task_type: taskType, reminder_minutes: String(form.get("reminder_minutes") || ""), recurrence: String(form.get("recurrence") || "none"), recurrence_series_id: task.recurrence_series_id || task.id, note: String(form.get("note") || "").trim(), linked_checklist_item_id: String(form.get("check_item_id") || task.linked_checklist_item_id || ""), updated_at: new Date().toISOString() });
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
  task.updated_at = new Date().toISOString();
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

function saveNotificationRecord(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function refreshNotificationStatus() {
  try {
    if (!("Notification" in window) || window.Notification.permission !== "granted") {
      saveNotificationRecord(PUSH_STATUS_KEY, { subscribed: false, checked_at: new Date().toISOString() });
      showToast("這台裝置尚未允許通知");
      render();
      return;
    }
    if (!("serviceWorker" in navigator)) throw new Error("此瀏覽器不支援背景通知");
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager?.getSubscription();
    saveNotificationRecord(PUSH_STATUS_KEY, { subscribed: Boolean(subscription), checked_at: new Date().toISOString() });
    showToast(subscription ? "通知訂閱正常" : "尚未建立推播訂閱，請按確認啟用通知");
    render();
  } catch (error) {
    saveNotificationRecord(PUSH_STATUS_KEY, { subscribed: false, checked_at: new Date().toISOString(), message: error.message });
    showToast(error.message);
    render();
  }
}

async function enableNotifications() {
  try {
    if (!("Notification" in window)) throw new Error("此瀏覽器不支援通知");
    const permission = await window.Notification.requestPermission();
    if (permission !== "granted") {
      saveNotificationRecord(PUSH_STATUS_KEY, { subscribed: false, checked_at: new Date().toISOString() });
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
    saveNotificationRecord(PUSH_STATUS_KEY, { subscribed: true, checked_at: new Date().toISOString() });
    showToast("這台裝置已啟用到時提醒");
    render();
  } catch (error) {
    saveNotificationRecord(PUSH_STATUS_KEY, { subscribed: false, checked_at: new Date().toISOString(), message: error.message });
    showToast(error.message);
    render();
  }
}

async function testNotification() {
  try {
    await registerServiceWorker();
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("老師專案管理提醒", {
      body: "Chrome 通知測試成功",
      tag: `notification-test-${Date.now()}`,
      data: { url: "/" },
    });
    saveNotificationRecord(NOTIFICATION_TEST_KEY, { success: true, checked_at: new Date().toISOString() });
    showToast("通知測試已送出");
    render();
  } catch (error) {
    saveNotificationRecord(NOTIFICATION_TEST_KEY, { success: false, checked_at: new Date().toISOString(), message: error.message });
    showToast(error.message);
    render();
  }
}

async function removePushSubscription() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    if (cloudCsrfToken) {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": cloudCsrfToken },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
    }
    await subscription.unsubscribe();
    saveNotificationRecord(PUSH_STATUS_KEY, { subscribed: false, checked_at: new Date().toISOString() });
  } catch {
    // Logout still clears the local worker and cache if push cleanup fails.
  }
}

async function logoutCloud() {
  window.clearTimeout(cloudSaveTimer);
  const saved = await saveCloudWorkspace();
  if (!saved || cloudSavePending) {
    showToast("尚有資料未完成同步，為避免遺失已暫停登出");
    return;
  }
  try {
    await removePushSubscription();
    await apiFetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": cloudCsrfToken } });
  } finally {
    await clearBrowserPrivateData();
    window.location.replace("/login");
  }
}

async function initializeApp() {
  setupGlobalEvents();
  render();
  if (!CLOUD_MODE) return;
  updateSyncIndicator("正在讀取雲端資料...", "syncing");
  try {
    const cachedWorkspace = cloneWorkspace(state.workspace);
    const cachedBase = readCloudBaseWorkspace();
    const hasPendingOfflineChanges = localStorage.getItem(OFFLINE_DIRTY_KEY) === "1";
    await loadCloudWorkspace();
    if (hasPendingOfflineChanges) {
      state.workspace = mergeWorkspaces(state.workspace, cachedWorkspace, cachedBase);
      localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(state.workspace));
      saveWorkspace();
      showToast("已合併上次尚未同步的離線修改");
    }
    await registerServiceWorker();
    const url = new URL(window.location.href);
    const snoozeId = url.searchParams.get("snooze");
    if (snoozeId) {
      snoozeTask(snoozeId);
      url.searchParams.delete("snooze");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (!hasPendingOfflineChanges) updateSyncIndicator("已連線雲端", "saved");
    render();
  } catch (error) {
    updateSyncIndicator("離線資料模式", "offline");
    showToast("無法連線雲端，已載入這台裝置的最近資料");
    await registerServiceWorker().catch(() => null);
    render();
  }
}

initializeApp();
