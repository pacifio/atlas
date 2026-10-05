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
import type {
  AtlasTranscriptMessage,
  AtlasTranscriptMeta,
} from "@/features/chat/lib/atlas-transcripts";
import type { AuthEnvStatus, AuthMethodWire } from "@/features/chat/lib/agents-api";
import type {
  ImportCandidate,
  ResumedThread,
  ThreadProject,
  ThreadRow,
} from "@/features/chat/lib/history-api";
import type { Entitlement } from "@/features/chat/stores/ai-grant-store";
import type { PlanRecord } from "@/features/chat/lib/plans";
import type { AppSettings } from "@/features/settings/lib/app-settings";
import { DEFAULT_SETTINGS } from "@/features/settings/lib/app-settings";
import type { UpdateOutcome } from "@/features/settings/lib/atlas-config-api";
import type { ModelStatus, SelectResult } from "@/features/settings/lib/models-api";
import type { UpdateStatus } from "@/features/updater/lib/updater-api";
import type { NativeModelsRefresh } from "@/types/agents";
import type { MockHandlers } from "../types";
import { abs, MOCK_PROJECT, OTHER_PROJECTS } from "../project";

const nothing = () => null;

const T0 = Date.parse("2026-09-17T09:12:00Z");
const ago = (ms: number) => new Date(T0 - ms).toISOString();

// ── chat history (ADR-0001: Atlas's own thread-metadata store) ─────────────

/**
 * The sidebar and the history view read the same rows, so one list feeds both.
 * The spread is deliberate: a draft with no session id yet, a very long
 * agent-written title, an archived row that only the history view may show,
 * and two projects so the sidebar's grouping has more than one group.
 */
const THREADS: ThreadRow[] = [
  {
    threadId: "th-01",
    sessionId: "sess-01",
    agentId: "atlas-agent",
    title: "Move the user reads onto /v2 and keep the retry helper",
    updatedAt: ago(5 * 60_000),
    createdAt: ago(3 * 3_600_000),
    archived: false,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
  },
  {
    threadId: "th-02",
    // No session yet: the composer is open but nothing has been sent.
    sessionId: null,
    agentId: "atlas-agent",
    title: "New conversation",
    updatedAt: ago(40 * 60_000),
    createdAt: ago(40 * 60_000),
    archived: false,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
  },
  {
    threadId: "th-03",
    sessionId: "sess-03",
    agentId: "gemini-cli",
    title:
      "Regenerate the whole design-token ramp, including the dark-mode steps, and explain every value that moved",
    updatedAt: ago(26 * 3_600_000),
    createdAt: ago(28 * 3_600_000),
    archived: false,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path, abs("src/styles")],
  },
  {
    threadId: "th-04",
    sessionId: "sess-04",
    agentId: "claude-code",
    title: "Why does the PDF highlight drift after a rotate?",
    updatedAt: ago(3 * 86_400_000),
    createdAt: ago(3 * 86_400_000),
    archived: false,
    projectName: OTHER_PROJECTS[0].name,
    folderPaths: [OTHER_PROJECTS[0].path],
  },
  {
    threadId: "th-05",
    sessionId: "sess-05",
    agentId: "atlas-agent",
    title: "Spike: swap HashMap for BTreeMap in the cache",
    updatedAt: ago(9 * 86_400_000),
    createdAt: ago(9 * 86_400_000),
    // The only archived row — the history view's filter has something to do.
    archived: true,
    projectName: MOCK_PROJECT.name,
    folderPaths: [MOCK_PROJECT.path],
  },
];

let threads: ThreadRow[] = THREADS.map((thread) => ({ ...thread }));

/** Tell every history surface to re-read, exactly as Rust's store does. */
function threadsChanged(): void {
  void emit("atlas:threads-changed");
}

function threadProjects(cwd: string | null): ThreadProject[] {
  const byProject = new Map<string, ThreadRow[]>();
  for (const thread of threads) {
    if (thread.archived) continue;
    const rows = byProject.get(thread.projectName) ?? [];
    rows.push(thread);
    byProject.set(thread.projectName, rows);
  }
  return [...byProject].map(([name, rows]) => ({
    name,
    paths: [...new Set(rows.flatMap((row) => row.folderPaths))],
    isCurrent: cwd === null ? name === MOCK_PROJECT.name : rows[0].folderPaths.includes(cwd),
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

// ── handlers ──────────────────────────────────────────────────────────────

export const miscHandlers: MockHandlers = {
  // ── shared threads (ATL-395) ────────────────────────────────────────────
  // Nothing joined in the browser mock: the panel renders its share and join
  // forms, which is what there is to look at without a server.
  shared_thread_list: () => [],
  // ── chat history ────────────────────────────────────────────────────────
  threads_history: ({ archivedOnly }): ThreadRow[] =>
    threads.filter((thread) => (archivedOnly ? thread.archived : !thread.archived)),
  threads_projects: ({ cwd }): ThreadProject[] =>
    threadProjects(cwd === null || cwd === undefined ? null : String(cwd)),
  threads_resume: ({ threadId }): ResumedThread => {
    const thread = threads.find((candidate) => candidate.threadId === String(threadId));
    if (!thread) throw new Error(`no such thread: ${String(threadId)}`);
    return {
      key: { agent_id: thread.agentId, session_id: thread.sessionId ?? thread.threadId },
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
  threads_archive: ({ threadId }): null => {
    threads = threads.map((thread) =>
      thread.threadId === String(threadId) ? { ...thread, archived: true } : thread,
    );
    threadsChanged();
    return null;
  },
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
    model.downloaded = true;
    void emit("atlas:models-changed");
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
    const previous = models.find((candidate) => candidate.selected);
    for (const model of models) model.selected = model.id === next.id;
    void emit("atlas:models-changed");
    // Changing dimension is what forces the re-index prompt.
    return { needsReindex: previous?.dim !== next.dim };
  },
  force_reindex: nothing,
  codebase_index_build: nothing,

  // ── the native agent's entitlement ──────────────────────────────────────
  // `localOrg` is the honest answer for the fake project's local-only org,
  // and it is the one state that needs no gateway to be plausible.
  native_agent_entitlement: (): Entitlement => ({ state: "localOrg" }),
  native_agent_refresh_models: (): NativeModelsRefresh => ({
    models: [
      { id: "gpt-5", name: "GPT-5", description: "The default for new sessions." },
      { id: "gpt-5-mini", name: "GPT-5 mini", description: null },
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
  compose_prompt: ({ prose, mentions }): ComposedPrompt => ({
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
};
