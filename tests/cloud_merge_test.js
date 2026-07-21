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
const harness = new Function("window", "localStorage", `${testableSource}\nreturn { mergeWorkspaces, workspaceImportIsValid };`)(browserWindow, storage);

function workspace(overrides = {}) {
  return {
    settings: { monthly_goal: 2 },
    projects: [], tasks: [], checklists: [], progress_logs: [], project_messages: [], history: [], archives: [],
    deleted_ids: {},
    ...overrides,
  };
}

const base = workspace({
  settings: { monthly_goal: 2, owner: "base" },
  tasks: [
    { id: "task-a", title: "A old", updated_at: "2026-07-21T13:00:00Z" },
    { id: "task-b", title: "B old", updated_at: "2026-07-21T13:00:00Z" },
  ],
});
const remote = workspace({
  settings: { monthly_goal: 2, owner: "remote" },
  tasks: [
    { id: "task-a", title: "A remote", updated_at: "2026-07-21T14:00:00Z" },
    { id: "task-b", title: "B old", updated_at: "2026-07-21T13:00:00Z" },
  ],
});
const local = workspace({
  settings: { monthly_goal: 3, owner: "base" },
  tasks: [
    { id: "task-a", title: "A old", updated_at: "2026-07-21T13:00:00Z" },
    { id: "task-b", title: "B local", updated_at: "2026-07-21T14:01:00Z" },
  ],
});

const merged = harness.mergeWorkspaces(remote, local, base);
assert(merged.tasks.find((item) => item.id === "task-a").title === "A remote", "Remote-only task changes must survive a conflict");
assert(merged.tasks.find((item) => item.id === "task-b").title === "B local", "Local-only task changes must survive a conflict");
assert(merged.settings.monthly_goal === 3 && merged.settings.owner === "remote", "Independent settings changes should merge by field");

const newerRemote = workspace({ tasks: [{ id: "task-c", title: "Remote newest", updated_at: "2026-07-21T15:00:00Z" }] });
const olderLocal = workspace({ tasks: [{ id: "task-c", title: "Local older", updated_at: "2026-07-21T14:00:00Z" }] });
const common = workspace({ tasks: [{ id: "task-c", title: "Common", updated_at: "2026-07-21T13:00:00Z" }] });
assert(harness.mergeWorkspaces(newerRemote, olderLocal, common).tasks[0].title === "Remote newest", "Newer same-record edits should win");

const fieldBase = workspace({ projects: [{ id: "project-a", course: "Original", note: "Original", updated_at: "2026-07-21T13:00:00Z" }] });
const fieldRemote = workspace({ projects: [{ id: "project-a", course: "Remote course", note: "Original", updated_at: "2026-07-21T14:00:00Z" }] });
const fieldLocal = workspace({ projects: [{ id: "project-a", course: "Original", note: "Local note", updated_at: "2026-07-21T14:01:00Z" }] });
const fieldMerged = harness.mergeWorkspaces(fieldRemote, fieldLocal, fieldBase).projects[0];
assert(fieldMerged.course === "Remote course" && fieldMerged.note === "Local note", "Independent fields on the same record should both survive a conflict");

const deletedLocal = workspace({ tasks: [], deleted_ids: { "task-a": "2026-07-21T16:00:00Z" } });
assert(harness.mergeWorkspaces(remote, deletedLocal, base).tasks.every((item) => item.id !== "task-a"), "Deletion tombstones must win during merge");

assert(harness.workspaceImportIsValid(workspace()), "A complete workspace backup should be importable");
assert(!harness.workspaceImportIsValid({ projects: [], tasks: [null] }), "Malformed collection entries must be rejected");
assert(!harness.workspaceImportIsValid({ projects: [], tasks: [], checklists: [{ id: "group", items: "broken" }] }), "Malformed nested checklist items must be rejected");
assert(!harness.workspaceImportIsValid({ projects: [{ id: "project", stages: [[]] }], tasks: [] }), "Nested arrays must not be accepted as workspace records");
assert(source.includes("OFFLINE_DIRTY_KEY") && source.includes("OFFLINE_BASE_KEY"), "Offline changes should retain a three-way merge base across app restarts");
assert(source.includes("已合併上次尚未同步的離線修改"), "Startup should recover pending offline changes instead of overwriting them");
assert(source.includes("async function reconnectCloudWorkspace()") && source.includes("if (!cloudCsrfToken)"), "Reconnecting after an offline startup should fetch a valid revision and CSRF token before saving");
assert(source.includes("為避免遺失已暫停登出"), "Logout should retain local data when the final cloud save cannot complete");

console.log("cloud merge tests: passed");
