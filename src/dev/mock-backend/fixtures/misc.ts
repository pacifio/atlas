// The commands that belong to no one surface: chat history, plans,
// the updater, `config.toml`, the local model manager, the
// leftover agent verbs, and the housekeeping the shell fires on its own.
//
// None of these are big enough to earn a fixture file, but every one of them
// is reachable from a menu, a panel header or a settings row — and an
// unanswered command there is indistinguishable from a broken screen. The
// grouping is "everything the wave-2 domain files did not claim", which is why
// the sections below jump between subsystems.
//
// The native Browser tab is here too, as deliberate no-ops: it is a real
// `WebviewWindow` that a plain browser cannot host (see `README.md`), and the
// point of answering its commands is only to keep the unmocked badge honest
// about what is *missing* rather than about what is *native*.

import { emit } from "@tauri-apps/api/event";
import type { ComposedPrompt } from "@/features/chat/lib/mentions";
import type { AttachedProject } from "@/features/chat/lib/history-api";
import type { SessionProjectsChange } from "@/features/chat/lib/session-projects-api";
import type {
  AtlasTranscriptMessage,
  AtlasTranscriptMeta,
} from "@/features/chat/lib/atlas-transcripts";
import type { AuthEnvStatus, AuthMethodWire } from "@/features/chat/lib/agents-api";
import type {
  ImportCandidate,
  PullRequestLink,
  ResumedThread,
  ThreadProject,
  ThreadRow,
} from "@/features/chat/lib/history-api";
import type { Entitlement } from "@/features/chat/stores/ai-grant-store";
import type { PlanRecord } from "@/features/chat/lib/plans";
import type { AppSettings } from "@/features/settings/lib/app-settings";
import { DEFAULT_SETTINGS } from "@/features/settings/lib/app-settings";
import type { UpdateOutcome } from "@/features/settings/lib/atlas-config-api";
import type { ProjectSettingsInfo } from "@/features/settings/lib/project-settings-api";
import type { ModelStatus, SelectResult } from "@/features/settings/lib/models-api";
import type { UpdateStatus } from "@/features/updater/lib/updater-api";
import type { NativeModelsRefresh } from "@/types/agents";
import type {
  ProjectScript,
  SessionEnvironment,
} from "@/features/session-context/lib/session-context-api";
import type { MockHandlers } from "../types";
import { abs, MOCK_PROJECT, OTHER_PROJECTS } from "../project";
import { adoptSession } from "../fake-agent";
import { sessionLifecycleHandlers, withDerivedLifecycle } from "../session-lifecycle";
import { fixtureLink, sessionPullRequestHandlers } from "../session-pull-requests";
import { RESTING_LIFECYCLE } from "@/features/chat/lib/session-lifecycle";

const nothing = () => null;

/** `link` with its snapshot based on `base` instead of `main`: a chain. */
function chainedOn(link: PullRequestLink, base: string): PullRequestLink {
  return link.snapshot ? { ...link, snapshot: { ...link.snapshot, baseBranch: base } } : link;
}

// Anchored when the mock loads, not at a fixed instant. Everything `ago`
// feeds is rendered as a RELATIVE time ("5m", "3h ago"), so a frozen anchor
// does not freeze the fixture — it ages it, and every row that was meant to
// read as "minutes ago" silently became an absolute date once a week had
// passed. The deltas below are what is deterministic; the instant is not.
const T0 = Date.now();
const ago = (ms: number) => new Date(T0 - ms).toISOString();

// ── chat history (ADR-0001: Atlas's own thread-metadata store) ─────────────

/**
 * The sidebar and the history view read the same rows, so one list feeds both.
 * The spread is deliberate: a draft with no session id yet, a very long
 * agent-written title, settled rows for the sidebar's Settled shelf (one of
 * them archived before Settled replaced archiving), a pinned row, a snoozed
 * row, an unread one and a woken one, and two projects so the sidebar's
 * grouping has more than one group.
 */
const THREADS: ThreadRow[] = [
  {
    threadId: "th-01",
    sessionId: "sess-01",
    agentId: "atlas-agent",
    title: "Move the user reads onto /v2 and keep the retry helper",
    updatedAt: ago(5 * 60_000),
    createdAt: ago(3 * 3_600_000),
    ...RESTING_LIFECYCLE,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    // Another process is writing this one: the live dot, and the composer's
    // "Send anyway" hold when it is opened.
    liveElsewhere: true,
    // A sibling project attached read-only: the composer chip's access toggle
    // and the row's attached-projects data both have something to show.
    attachedProjects: [
      {
        path: OTHER_PROJECTS[0].path,
        displayName: OTHER_PROJECTS[0].name,
        access: "read_only",
        attachedAt: ago(2 * 3_600_000),
        source: "mention",
      },
    ],
    model: "Claude Sonnet 4.5",
    pullRequests: [
      // Opened from the session, found on its branch, and linked by hand: the
      // badge's "+3", the hover list's three lines and the session's pull
      // request panel. number 412 is watched (the eye), and number 405 is based on
      // number 412's branch, so the two read as a chain of two.
      { ...fixtureLink(412, "created", ago(50 * 60_000)), watching: true },
      chainedOn(fixtureLink(405, "detected", ago(40 * 60_000)), "theo/payment-state-machine"),
      fixtureLink(398, "manual", ago(30 * 60_000)),
    ],
    forkedFromSessionId: null,
    heldWorking: false,
    // One of the fake repo's own branches (`fixtures/git.ts`).
    branch: "feature/auth-v2",
  },
  {
    threadId: "th-02",
    // No session yet: the composer is open but nothing has been sent.
    sessionId: null,
    agentId: "atlas-agent",
    title: "New conversation",
    updatedAt: ago(40 * 60_000),
    createdAt: ago(40 * 60_000),
    ...RESTING_LIFECYCLE,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: "main",
  },
  {
    threadId: "th-03",
    sessionId: "sess-03",
    agentId: "gemini-cli",
    title:
      "Regenerate the whole design-token ramp, including the dark-mode steps, and explain every value that moved",
    updatedAt: ago(26 * 3_600_000),
    createdAt: ago(28 * 3_600_000),
    ...RESTING_LIFECYCLE,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path, abs("src/styles")],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: "main",
  },
  {
    threadId: "th-04",
    sessionId: "sess-04",
    agentId: "claude-code",
    title: "Why does the PDF highlight drift after a rotate?",
    updatedAt: ago(3 * 86_400_000),
    createdAt: ago(3 * 86_400_000),
    ...RESTING_LIFECYCLE,
    // Unread: its last turn finished after the user last looked.
    lastViewedAt: ago(3 * 86_400_000 + 600_000),
    lastTurnCompletedAt: ago(3 * 86_400_000),
    projectName: OTHER_PROJECTS[0].name,
    folderPaths: [OTHER_PROJECTS[0].path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: "main",
  },
  {
    threadId: "th-05",
    sessionId: "sess-05",
    agentId: "atlas-agent",
    title: "Spike: swap HashMap for BTreeMap in the cache",
    updatedAt: ago(9 * 86_400_000),
    createdAt: ago(9 * 86_400_000),
    // Archived before Settled replaced archiving: the migration settled it at
    // its last activity.
    ...RESTING_LIFECYCLE,
    settledAt: ago(9 * 86_400_000),
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    // Detached HEAD when it ran, so Atlas never learned a branch.
    branch: null,
  },
  {
    threadId: "th-06",
    sessionId: "sess-06",
    agentId: "claude-code",
    title: "Trim the first paint: the titlebar dock mounts before the theme resolves",
    updatedAt: ago(2 * 3_600_000),
    createdAt: ago(2 * 3_600_000),
    ...RESTING_LIFECYCLE,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    // A branch nobody would size a column for. The card trims it rather than
    // pushing the agent's mark off its own edge — the only row here that
    // exercises that, and the reason it is this long.
    branch: "adib/revert-the-codeindex-and-restore-the-mention-search-ranking",
  },
  {
    threadId: "th-07",
    sessionId: "sess-07",
    agentId: "codex",
    title: "Port the seatbelt profile to bubblewrap",
    updatedAt: ago(7 * 3_600_000),
    createdAt: ago(8 * 3_600_000),
    ...RESTING_LIFECYCLE,
    // Pinned: the Pinned section, never auto-settled.
    pinnedAt: ago(6 * 3_600_000),
    pinOrder: "n",
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: "feature/auth-v2",
  },
  {
    threadId: "th-08",
    sessionId: "sess-08",
    agentId: "atlas-agent",
    title: "Explain the delta wire's additive-only rule",
    updatedAt: ago(19 * 3_600_000),
    createdAt: ago(19 * 3_600_000),
    ...RESTING_LIFECYCLE,
    // Snoozed for a few hours; the fake backend's timer wakes it.
    snoozedAt: ago(3_600_000),
    snoozedUntil: ago(-3 * 3_600_000),
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: null,
  },
  {
    threadId: "th-09",
    sessionId: "sess-09",
    agentId: "gemini-cli",
    title: "Why is the terminal buffer re-rendering on every keystroke?",
    updatedAt: ago(2 * 86_400_000),
    createdAt: ago(2 * 86_400_000),
    ...RESTING_LIFECYCLE,
    // Woke from a snooze an hour ago and not looked at since.
    lastSnoozeWakeAt: ago(3_600_000),
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: "main",
  },
  {
    threadId: "th-10",
    sessionId: "sess-10",
    agentId: "claude-code",
    title: "Checkpoint restore drops the new-file blob",
    updatedAt: ago(5 * 86_400_000),
    createdAt: ago(5 * 86_400_000),
    ...RESTING_LIFECYCLE,
    // Idle past the auto-settle window: on the Settled shelf, settled at its
    // last activity, as the idle sweep records it.
    settledAt: ago(5 * 86_400_000),
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: "fix/checkpoint-blobs",
  },
  {
    threadId: "th-11",
    sessionId: "sess-11",
    agentId: "atlas-agent",
    // Older than a week, so `timeAgo` falls back to a date: "Done · 20 May".
    title: "First pass at the memory briefing",
    updatedAt: ago(12 * 86_400_000),
    createdAt: ago(12 * 86_400_000),
    ...RESTING_LIFECYCLE,
    settledAt: ago(12 * 86_400_000),
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
    liveElsewhere: false,
    attachedProjects: [],
    model: null,
    pullRequests: [],
    forkedFromSessionId: null,
    heldWorking: false,
    branch: "main",
  },
];

let threads: ThreadRow[] = THREADS.map((thread) => withDerivedLifecycle({ ...thread }));

/** Tell every history surface to re-read, exactly as Rust's store does. */
function threadsChanged(): void {
  void emit("atlas:threads-changed");
}

/** Attached projects of sessions with no history row (a fresh mock tab). */
const draftProjects = new Map<string, AttachedProject[]>();

function sessionProjects(sessionId: string): AttachedProject[] {
  return (
    threads.find((t) => t.sessionId === sessionId)?.attachedProjects ??
    draftProjects.get(sessionId) ??
    []
  );
}

function projectsChange(
  sessionId: string,
  projects: AttachedProject[],
  changed: boolean,
): SessionProjectsChange {
  if (changed) {
    const row = threads.find((t) => t.sessionId === sessionId);
    if (row) {
      threads = threads.map((t) => (t === row ? { ...t, attachedProjects: projects } : t));
    } else {
      draftProjects.set(sessionId, projects);
    }
    threadsChanged();
  }
  return { projects, changed, appliedLive: true };
}

/** As Rust answers it (`AgentHost::thread_projects`): scoped to `cwd`, only
 *  the project(s) holding it, each current; unscoped, every project and none
 *  current — the mixed list the sidebar groups under headings. */
function threadProjects(cwd: string | null): ThreadProject[] {
  const byProject = new Map<string, ThreadRow[]>();
  for (const thread of threads) {
    if (thread.sessionId === null) continue;
    const rows = byProject.get(thread.projectName) ?? [];
    rows.push(thread);
    byProject.set(thread.projectName, rows);
  }
  const scoped = cwd !== null && cwd !== "";
  return [...byProject]
    .filter(([, rows]) => !scoped || rows.some((row) => row.folderPaths.includes(cwd)))
    .map(([name, rows]) => ({
      name,
      paths: [...new Set(rows.flatMap((row) => row.folderPaths))],
      isCurrent: scoped,
      threads: rows,
    }));
}

// ── plans (`.atlas/plans.json`) ────────────────────────────────────────────

/** Two plans, because the panel collapses each entry: one has to be opened to
 *  see anything, and a single row hides that the list scrolls. */
let plans: PlanRecord[] = [
  {
    id: "plan-01",
    sessionId: "sess-01",
    sessionTitle: "Move the user reads onto /v2",
    userMessage: "Move every user read onto /v2 without breaking the admin table.",
    plan: `## Move user reads to /v2

1. Add \`withRetry\` to \`src/lib/api.ts\` — 5xx and network errors only.
2. Point \`listUsers\` at \`/v2/users\`, keeping the page/size params.
3. Leave \`getUser\` on v1 until ACME-1184 lands.

| Step | Risk |
| --- | --- |
| 1 | none — additive |
| 2 | the admin table pages differently |
| 3 | deferred |
`,
    timestamp: ago(3 * 3_600_000),
  },
  {
    id: "plan-02",
    sessionId: "sess-03",
    sessionTitle: null,
    userMessage: "Regenerate the token ramp.",
    plan: `## Token ramp

- Derive every step from \`--accent\`; no hand-picked hexes.
- Keep \`--destructive\` out of the ramp: it is a role, not a step.
`,
    timestamp: ago(26 * 3_600_000),
  },
];

// ── `config.toml` ──────────────────────────────────────────────────────────

// Rust owns the settings file and answers with the whole merged result, so the
// fake keeps one and merges patches into it — a settings toggle that answered
// with the unchanged defaults would silently revert itself on the next event.
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let generation = 1;
const projectSettings = new Map<string, ProjectSettingsInfo>();
const projectSettingsFor = (projectPath: string): ProjectSettingsInfo =>
  projectSettings.get(projectPath) ?? {
    path: `${projectPath}/.atlas/config.toml`,
    values: {},
    ignoredKeys: [],
    refusedKeys: [],
    error: null,
  };

// ── local model manager (memory's embedding models) ────────────────────────

/**
 * One downloaded-and-selected model, one downloadable, one too big for the
 * machine — the three rows the manager draws differently.
 */
const MODELS: ModelStatus[] = [
  {
    id: "minilm-l6-v2",
    kind: "embedding",
    name: "all-MiniLM-L6-v2",
    repo: "sentence-transformers/all-MiniLM-L6-v2",
    files: [
      {
        repo: "sentence-transformers/all-MiniLM-L6-v2",
        file: "model.safetensors",
        dest: "minilm-l6-v2/model.safetensors",
      },
      {
        repo: "sentence-transformers/all-MiniLM-L6-v2",
        file: "tokenizer.json",
        dest: "minilm-l6-v2/tokenizer.json",
      },
    ],
    dim: 384,
    sizeMb: 87,
    description: "The default. Fast on CPU, good enough for code search.",
    compatible: true,
    downloaded: true,
    selected: true,
  },
  {
    id: "bge-small-en-v1.5",
    kind: "embedding",
    name: "bge-small-en-v1.5",
    repo: "BAAI/bge-small-en-v1.5",
    files: [
      { repo: "BAAI/bge-small-en-v1.5", file: "model.safetensors", dest: "bge-small/model.st" },
    ],
    dim: 384,
    sizeMb: 133,
    description: "Slightly better recall on prose, same dimension — re-index not required.",
    compatible: true,
    downloaded: false,
    selected: false,
  },
  {
    id: "e5-large-v2",
    kind: "embedding",
    name: "intfloat/e5-large-v2 (1024-dim, requires a full re-index of every project)",
    repo: "intfloat/e5-large-v2",
    files: [{ repo: "intfloat/e5-large-v2", file: "model.safetensors", dest: "e5-large/model.st" }],
    dim: 1024,
    sizeMb: 1340,
    description: "Best quality, but the index has to be rebuilt and it will not fit in 8 GB.",
    // The disabled row: `compatible: false` is what greys the download button.
    compatible: false,
    downloaded: false,
    selected: false,
  },
];

const models: ModelStatus[] = MODELS.map((model) => ({ ...model }));

/** A download that takes a few seconds, so the progress states are visible. */
function simulateDownload(model: ModelStatus): void {
  const fileCount = model.files.length;
  const total = model.sizeMb * 1_000_000;
  const steps = 12;
  for (let step = 1; step <= steps; step++) {
    setTimeout(() => {
      const done = step / steps;
      const fileIndex = Math.min(fileCount - 1, Math.floor(done * fileCount));
      void emit("atlas:model-download:progress", {
        id: model.id,
        file: model.files[fileIndex]?.dest ?? "",
        fileIndex,
        fileCount,
        received: Math.round(total * (done * fileCount - fileIndex)),
        total,
      });
      if (step === steps) {
        model.downloaded = true;
        void emit("atlas:model-download:done", { id: model.id, success: true, error: null });
        void emit("atlas:models-changed");
      }
    }, step * 300);
  }
}

// ── project scripts ───────────────────────────────────────────────────────

/** Each project's `[[scripts]]`, as `.atlas/config.toml` would hold them. The
 *  fake project starts with two, so the scripts row shows its split; the
 *  second has never been approved, so running it shows the confirmation. */
const projectScripts = new Map<string, ProjectScript[]>([
  [
    MOCK_PROJECT.path,
    [
      { id: "dev", name: "Dev server", command: "bun run dev", icon: "play" },
      { id: "test", name: "Test", command: "bun run test", icon: "test" },
    ],
  ],
]);

/** As in Rust (`project-script-approvals.json`): project, id and command. */
const approvedScripts = new Set<string>([`${MOCK_PROJECT.path}\u0000dev\u0000bun run dev`]);
const approvalKey = (project: string, script: { id: string; command: string }) =>
  `${project}\u0000${script.id}\u0000${script.command}`;
const withApproval = (project: string, scripts: ProjectScript[]): ProjectScript[] =>
  scripts.map((script) => ({
    ...script,
    approved: approvedScripts.has(approvalKey(project, script)),
  }));

// ── handlers ──────────────────────────────────────────────────────────────

export const miscHandlers: MockHandlers = {
  // ── session context (`commands/session_context.rs`, `project_scripts.rs`) ──
  session_environment: (): SessionEnvironment => ({ name: "m4-pro", kind: "local" }),
  project_scripts_list: ({ projectPath }): ProjectScript[] =>
    withApproval(String(projectPath), projectScripts.get(String(projectPath)) ?? []),
  project_scripts_approve: ({ projectPath, id, command }) => {
    approvedScripts.add(
      approvalKey(String(projectPath), { id: String(id), command: String(command) }),
    );
    return null;
  },
  // As in Rust: trimmed, a blank id derived from the name, ids made unique.
  project_scripts_save: ({ projectPath, scripts }): ProjectScript[] => {
    const seen = new Set<string>();
    const saved = (scripts as ProjectScript[]).map((script) => {
      const base =
        script.id.trim() ||
        script.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") ||
        "script";
      let id = base;
      for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
      seen.add(id);
      return { id, name: script.name.trim(), command: script.command.trim(), icon: script.icon };
    });
    // As in Rust: what the save brought in was typed in Atlas, so it is approved.
    const before = new Set(
      (projectScripts.get(String(projectPath)) ?? []).map((s) => approvalKey("", s)),
    );
    for (const script of saved) {
      if (!before.has(approvalKey("", script))) {
        approvedScripts.add(approvalKey(String(projectPath), script));
      }
    }
    projectScripts.set(String(projectPath), saved);
    return withApproval(String(projectPath), saved);
  },

  // ── chat history ────────────────────────────────────────────────────────
  // As in Rust: every row (the composer's live-elsewhere feed relies on that).
  threads_history: (): ThreadRow[] => threads,
  threads_sync_project: () => 0,
  threads_projects: ({ cwd }): ThreadProject[] =>
    threadProjects(cwd === null || cwd === undefined ? null : String(cwd)),
  threads_resume: ({ threadId }): ResumedThread => {
    const thread = threads.find((candidate) => candidate.threadId === String(threadId));
    if (!thread) throw new Error(`no such thread: ${String(threadId)}`);
    const key = { agent_id: thread.agentId, session_id: thread.sessionId ?? thread.threadId };
    adoptSession(key, thread.agentId, thread.folderPaths[0] ?? "");
    return {
      key,
      // The agent could only continue, not replay — the state the UI has to
      // tell the user about, and the one nothing else here exercises.
      resumedWithoutHistory: thread.agentId !== "atlas-agent",
    };
  },
  threads_delete: ({ threadId }): null => {
    threads = threads.filter((thread) => thread.threadId !== String(threadId));
    threadsChanged();
    return null;
  },
  // Projects attached to a session (`session_projects.rs`). Keyed by the live
  // session id; a session with a history row keeps the list on the row. The
  // fake agent takes a change from the next turn, as the native agent does.
  session_projects_list: ({ sessionId }): AttachedProject[] => sessionProjects(String(sessionId)),
  session_projects_attach: ({
    sessionId,
    path,
    displayName,
    access,
    source,
  }): SessionProjectsChange => {
    const id = String(sessionId);
    const want = String(path).replace(/\/+$/, "");
    if (want === "/" || want === "/Users/dev" || !want.startsWith("/")) {
      throw new Error(
        `${want} is your home folder or above it; attach a project inside it instead.`,
      );
    }
    const current = sessionProjects(id);
    if (current.some((p) => p.path === want)) return projectsChange(id, current, false);
    const next: AttachedProject[] = [
      ...current,
      {
        path: want,
        displayName: displayName ? String(displayName) : (want.split("/").pop() ?? want),
        access: access === "read_write" ? "read_write" : "read_only",
        attachedAt: new Date().toISOString(),
        source: source === "agent_request" || source === "clone" ? source : "mention",
      },
    ];
    return projectsChange(id, next, true);
  },
  session_projects_detach: ({ sessionId, path }): SessionProjectsChange => {
    const id = String(sessionId);
    const current = sessionProjects(id);
    const next = current.filter((p) => p.path !== String(path));
    return projectsChange(id, next, next.length !== current.length);
  },
  session_projects_set_access: ({ sessionId, path, access }): SessionProjectsChange => {
    const id = String(sessionId);
    const current = sessionProjects(id);
    const want = access === "read_write" ? "read_write" : "read_only";
    let changed = false;
    const next = current.map((p) => {
      if (p.path !== String(path) || p.access === want) return p;
      changed = true;
      return { ...p, access: want } satisfies AttachedProject;
    });
    return projectsChange(id, next, changed);
  },
  // As in Rust: settling sinks the row to the Settled shelf, it stays listed;
  // pin, snooze and viewed/unread follow the store's rules.
  ...sessionLifecycleHandlers({
    get: () => threads,
    set: (rows) => {
      threads = rows;
    },
    changed: threadsChanged,
  }),
  ...sessionPullRequestHandlers({
    get: () => threads,
    set: (rows) => {
      threads = rows;
    },
    changed: threadsChanged,
  }),
  // Importing is the slowest thing in the app (every agent is started to be
  // asked), so all three answer kinds are represented rather than just "ready".
  threads_import_candidates: (): ImportCandidate[] => [
    {
      pluginId: "claude-code",
      displayName: "Claude Code",
      status: { kind: "ready", importable: 34 },
    },
    { pluginId: "gemini-cli", displayName: "Gemini CLI", status: { kind: "unsupported" } },
    {
      pluginId: "opencode",
      displayName: "opencode",
      status: { kind: "error", message: "timed out waiting for initialize (10s)" },
    },
  ],
  threads_import: ({ pluginIds }): number => ((pluginIds ?? []) as string[]).length * 17,

  // ── plans ───────────────────────────────────────────────────────────────
  plans_load: (): PlanRecord[] => plans,
  plans_append: ({ record }): null => {
    plans = [record as PlanRecord, ...plans];
    return null;
  },

  // ── `config.toml` ───────────────────────────────────────────────────────
  update_atlas_settings: ({ patch, expectedGeneration }): UpdateOutcome => {
    // A stale generation is a real answer, not an error: the settings panel
    // re-reads and retries. Nothing else in the mock can produce it, so the
    // branch is here to be reachable by hand from the console.
    if (Number(expectedGeneration) !== generation) {
      return { kind: "conflict", settings, generation };
    }
    settings = { ...settings, ...(patch as Partial<AppSettings>) };
    generation += 1;
    void emit("atlas:config-changed", { settings, generation });
    return { kind: "applied", settings, generation };
  },
  reset_atlas_config: (): { settings: AppSettings; generation: number } => {
    settings = { ...DEFAULT_SETTINGS };
    generation += 1;
    void emit("atlas:config-changed", { settings, generation });
    return { settings, generation };
  },
  open_atlas_config: nothing,
  // `.atlas/config.toml` per project, kept in memory: enough to exercise the
  // scope picker and the inherited / overridden rows in the browser.
  get_project_settings: ({ projectPath }): ProjectSettingsInfo =>
    projectSettingsFor(String(projectPath)),
  update_project_settings: ({ projectPath, patch }): ProjectSettingsInfo => {
    const info = projectSettingsFor(String(projectPath));
    const values: Record<string, unknown> = { ...info.values };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === null) delete values[key];
      else values[key] = value;
    }
    const next = { ...info, values: values as Partial<AppSettings> };
    projectSettings.set(String(projectPath), next);
    return next;
  },
  // No `config.toml` on a browser's disk: the settings shown come from the
  // boot snapshot, and `null` is the "no file read" answer the API allows.
  get_atlas_config_info: nothing,

  // ── OS notifications and the dock badge ─────────────────────────────────
  // A browser has neither. `null` is what the wrappers read as "no native
  // backend" / "not granted", the honest state here.
  notifier_init: nothing,
  notifier_request_authorization: nothing,
  // Fire-and-forget banners, and the icon cache: no banner is ever shown, so
  // there is no path to look up and nothing to remove. `null` is the wrappers'
  // "no cached icon" answer.
  notifier_show: nothing,
  notifier_remove: nothing,
  notifier_remove_group: nothing,
  notifier_icon_lookup: nothing,
  notifier_icon_store: nothing,

  // ── quit guard ──────────────────────────────────────────────────────────
  // Closing a browser tab is not a quit Rust can hold, so `ready` arms
  // nothing and no `atlas:quit-requested` is ever emitted to answer.
  quit_guard_ready: nothing,
  quit_guard_answer: nothing,
  "plugin:window|set_badge_count": nothing,

  // ── updater ─────────────────────────────────────────────────────────────
  // An update IS available, because "you are up to date" hides the whole
  // release-notes / restart affordance.
  update_check_now: (): UpdateStatus => ({
    available: true,
    version: "0.3.4",
    currentVersion: "0.0.0-mock",
  }),
  update_apply: nothing,
  update_ignore: nothing,

  // ── local model manager ─────────────────────────────────────────────────
  models_list: (): ModelStatus[] => models,
  model_download: ({ id }): null => {
    const model = models.find((candidate) => candidate.id === String(id));
    if (!model) throw new Error(`unknown model ${String(id)}`);
    if (!model.compatible) throw new Error("not enough memory for this model");
    simulateDownload(model);
    return null;
  },
  model_remove: ({ id }): null => {
    const model = models.find((candidate) => candidate.id === String(id));
    if (model) {
      model.downloaded = false;
      model.selected = false;
    }
    void emit("atlas:models-changed");
    return null;
  },
  model_select: ({ id }): SelectResult => {
    const next = models.find((candidate) => candidate.id === String(id));
    if (!next) throw new Error(`unknown model ${String(id)}`);
    const previous = models.find((candidate) => candidate.selected && candidate.kind === next.kind);
    // Each kind has its own selection, as in Rust.
    for (const model of models) {
      if (model.kind === next.kind) model.selected = model.id === next.id;
    }
    void emit("atlas:models-changed");
    // Changing dimension is what forces the re-index prompt.
    return { needsReindex: previous?.dim !== next.dim };
  },
  force_reindex: nothing,

  // ── the native agent's entitlement ──────────────────────────────────────
  // `localOrg` is the honest answer for the fake project's local-only org,
  // and it is the one state that needs no gateway to be plausible.
  native_agent_entitlement: (): Entitlement => ({ state: "localOrg" }),
  native_agent_refresh_models: (): NativeModelsRefresh => ({
    // Stated providers, new models, several legacy ones in a provider and one
    // model with no stated provider, so the picker's rail, "New" badge,
    // Legacy fold ("N models") and agent-filed group all have something to
    // show.
    models: [
      {
        id: "gpt-5",
        name: "GPT-5",
        description: "The default for new sessions.",
        provider: "openai",
      },
      { id: "gpt-5.5", name: "GPT-5.5", description: null, provider: "openai", is_new: true },
      { id: "gpt-5-mini", name: "GPT-5 mini", description: null, provider: "openai" },
      { id: "o3", name: "o3", description: null, provider: "openai", legacy: true },
      { id: "o4-mini", name: "o4-mini", description: null, provider: "openai", legacy: true },
      { id: "gpt-4.1", name: "GPT-4.1", description: null, provider: "openai", legacy: true },
      { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", is_new: true },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic", legacy: true },
      { id: "gemini-3.6-pro", name: "Gemini 3.6 Pro", provider: "google" },
      { id: "house-coder", name: "House coder", description: "A self-hosted model." },
    ],
    defaultModel: "gpt-5",
    changed: false,
    reconnected: false,
  }),

  // ── leftover agent verbs ────────────────────────────────────────────────
  // Every one of these sits behind a menu item in the agent picker or the
  // agent settings page; they answer rather than do, because the fake agent in
  // `fake-agent.ts` owns the session lifecycle.
  agents_kill: nothing,
  agents_kill_plugin: nothing,
  agents_load_session: ({ agentId, sessionId }) => ({
    agent_id: String(agentId),
    session_id: String(sessionId),
  }),
  agents_fork_session: (): string | null => null,
  agents_rewind_last_turn: (): string | null => null,
  agents_set_config_option: nothing,
  agents_set_mode: nothing,
  agents_set_model: nothing,
  agents_respond_elicitation: nothing,
  ui_action_respond: nothing,
  // agents_respond_permission lives in `fake-agent.ts` (`agentHandlers`) —
  // it needs to update the transcript, not just resolve.
  agents_logout: nothing,
  agents_authenticate: nothing,
  agents_run_auth_method: (): string => "mock-auth-run",
  agents_start_diagnostics: (): string => "mock-diagnostics-run",
  // agents_list_running lives in `fake-agent.ts`: only it knows which sessions
  // are live.
  // One satisfied method and one that still needs a variable exported: the
  // settings row renders the two differently, and only the second one shows
  // the instructions.
  agents_list_auth_methods: (): AuthMethodWire[] => [
    {
      id: "oauth",
      name: "Sign in with the provider",
      description: "Opens a browser window and stores the token in the keychain.",
      kind: "terminal",
      link: null,
      terminalCommand: "acme-agent login",
      terminalArgs: ["login", "--device"],
      terminalLabel: "Run in a terminal",
      apiKeyProvider: null,
    },
    {
      id: "api-key",
      name: "API key",
      description: "Export the key before starting the agent.",
      kind: "env_var",
      envVars: [{ name: "ACME_API_KEY", label: "Acme API key", secret: true, optional: false }],
      link: "https://example.invalid/keys",
      terminalCommand: null,
      terminalArgs: null,
      terminalLabel: null,
      apiKeyProvider: "acme",
    },
  ],
  agents_auth_env_status: (): AuthEnvStatus[] => [
    {
      methodId: "api-key",
      name: "ACME_API_KEY",
      label: "Acme API key",
      optional: false,
      satisfied: false,
      source: null,
    },
    {
      methodId: "api-key",
      name: "ACME_ORG",
      label: null,
      optional: true,
      satisfied: true,
      source: "shell-env",
    },
  ],

  // ── Atlas's own transcript store ────────────────────────────────────────
  agent_transcripts_list: (): AtlasTranscriptMeta[] =>
    threads
      .filter((thread) => thread.sessionId !== null)
      .map((thread) => ({
        id: thread.sessionId ?? thread.threadId,
        file_path: `~/.config/atlas/agent-transcripts/${thread.sessionId}.jsonl`,
        started_at: thread.createdAt,
        last_modified: thread.updatedAt,
        message_count: 12,
        preview: thread.title,
        total_tokens: 48_120,
        plugin_id: thread.agentId,
      })),
  agent_transcripts_read: ({ sessionId }): AtlasTranscriptMessage[] => [
    {
      role: "user",
      content: "Move every user read onto /v2 without breaking the admin table.",
      timestamp: ago(3 * 3_600_000),
    },
    {
      role: "assistant",
      content:
        "`listUsers` is the only caller that pages, so I moved it first and left `getUser` on v1 until ACME-1184 lands.",
      timestamp: ago(3 * 3_600_000 - 40_000),
      model: `mock/${String(sessionId)}`,
    },
  ],

  // ── prompt composition ──────────────────────────────────────────────────
  // Rust re-writes mentions into ACP resource links; the fake keeps the prose
  // verbatim and links whatever file mentions came through, which is enough
  // for the composer's chips to survive a send.
  compose_prompt: ({ prose, mentions }): Omit<ComposedPrompt, "pastedTexts"> => ({
    prose: String(prose ?? ""),
    resourceLinks: ((mentions ?? []) as { kind?: string; id?: string; label?: string }[])
      .filter((mention) => mention.kind === "file")
      .map((mention) => ({
        uri: `file://${String(mention.id ?? "")}`,
        name: String(mention.label ?? mention.id ?? ""),
      })),
  }),

  // ── housekeeping the shell fires on its own ─────────────────────────────
  save_project_session: nothing,
  scratch_write_bytes: (): string => abs(".atlas/scratch/pasted.png"),
  window_zoom: nothing,
  clipboard_write_text: nothing,
  // A paste carrying file paths is a Finder-only gesture (see `README.md`),
  // so the browser answer is always "no files came with it".
  clipboard_file_paths: (): string[] => [],
  "plugin:opener|reveal_item_in_dir": nothing,
  usage_write_file: nothing,
  usage_export_markdown: nothing,

  // ── native Browser tab — answered, never faked ──────────────────────────
  // These drive a real child `WebviewWindow`. There is nothing to stand in for
  // it in a plain browser, so the panel draws its chrome around an empty area;
  // that is the known limitation, not a missing fake.
  browser_embed_create: nothing,
  browser_embed_destroy: nothing,
  browser_embed_navigate: nothing,
  browser_embed_back: nothing,
  browser_embed_forward: nothing,
  browser_embed_reload: nothing,
  browser_embed_set_bounds: nothing,
  browser_embed_set_visible: nothing,
  browser_open_window: nothing,
  fetch_readable: ({ url }) => ({
    title: "Reader mode is served by Rust, not the webview",
    url: String(url ?? "https://example.invalid"),
    html: "<h1>Readable</h1><p>The reader pane is ordinary HTML, so it themes and renders here even though the Browser tab itself cannot.</p>",
  }),
  // A plain browser has no CSP refusing remote images, so the URL itself is
  // the answer. Relative paths would need the real disk; they show alt text.
  markdown_preview_image: ({ src }) => {
    const s = String(src ?? "");
    if (/^https?:\/\//i.test(s)) return s;
    throw new Error("local images need the real backend");
  },
};
