// The `northwind` scenario's "everything else": the app's identity at boot,
// the capture binding, Usage, chat history, the Atlas Agent's entitlement, the
// agent catalog and registry, Memory, Skills, and the Settings rows that would
// otherwise show the default scenario's Acme data.
//
// Every answer here is read off the world (`northwind-world.ts`) and the words
// (`northwind-content.ts`), so a Session that exists on the Timeline is the
// same Session in Usage, in the chat history sidebar and in Memory's
// provenance. Nothing a viewer can see names a fixture, a mock or Acme.
//
// `northwindMiscCommands` overrides typed fixture commands;
// `northwindMiscRawCommands` overrides the untyped boot commands in `base.ts`
// and the catch-all `fixtures/misc.ts`.

import { emit } from "@tauri-apps/api/event";
import type { SessionSummary } from "@/features/artifacts/types";
import type {
  AcpRegistryEntry,
  AcpRegistryListing,
} from "@/features/agents/lib/agent-registry-api";
import type { AppStateWire } from "@/features/app/stores/app-store";
import type { Binding, CaptureHealth, ConnectOptions, Detection } from "@/features/capture/types";
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
import type { PlanRecord } from "@/features/chat/lib/plans";
import type { Entitlement } from "@/features/chat/stores/ai-grant-store";
import type { LogEntry, LogSource } from "@/features/log/stores/log-store";
import type {
  GraphLayout,
  MemoryEdge,
  MemoryGraphData,
  MemoryNode,
} from "@/features/memory/components/memory-graph-canvas";
import type { EmbedStatus, QueryHit } from "@/features/memory/lib/memory-graph-api";
import type { Policy } from "@/features/memory/lib/memory-policy-api";
import type { SummarizerPref } from "@/features/memory/lib/memory-sharing-api";
import type {
  ClaudeImportPreview,
  EntryKind,
  EventKind,
  MemoryEntry,
  MemoryEvent,
  SharedState,
} from "@/features/memory/lib/shared-memory-api";
import type { InstalledPack, Pack, PackComponent, PackSearchHit } from "@/features/packs/lib/types";
import type { CliStatus } from "@/features/settings/components/settings-panel";
import { DEFAULT_SETTINGS } from "@/features/settings/lib/app-settings";
import type { EnvEntry, EnvKeyMeta, ProfileInfo } from "@/features/settings/lib/byok-api";
import type {
  AgentTarget,
  PackComponentMeta,
  ProjectionCell,
  ProjectionStatus,
  ReconcileView,
  Scope,
  SkillContent,
  SkillMeta,
  ToolInfo,
} from "@/features/skills/lib/types";
import type { DailyBucket, SessionRow, UsageDashboard } from "@/features/usage/types";
import type { UpdaterSnapshot, UpdateStatus } from "@/features/updater/lib/updater-api";
import type { AgentCatalog, AgentCatalogEntry } from "@/types/agent-catalog";
import type { NativeModelsRefresh } from "@/types/agents";
import type { MockHandlers, MockResponses, TypedHandlers } from "../types";
import type { AgentKey, MemoryContent } from "./northwind-content-types";
import { adoptSession } from "../fake-agent";
import { NORTHWIND_FILES } from "../fixtures/northwind-repo";
import { CONTENT } from "./northwind-content";
import { transcriptOf } from "./northwind-agent";
import { NORTHWIND_NATIVE_MODELS } from "./northwind-models";
import { lineStats } from "./northwind-timeline";
import { northwindFileText, northwindWriteFile } from "./northwind-git";
import {
  addMemory,
  CODEX_INSTALLED,
  HOME,
  iso,
  LOAD,
  ME,
  memory,
  ORG_ID,
  ORG_NAME,
  ORG_REMOTE_ID,
  ORG_SLUG,
  PROJECT,
  REMOTE_PROJECT_ID,
  sessions,
  whenMs,
  type SessionState,
} from "./northwind-world";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The build the videos show. */
const VERSION = "0.4.0";

/** Uzayer's Sessions — the only ones that ran on this machine. */
const mySessions = (): SessionState[] => sessions().filter((s) => s.content.author === ME.key);

/** Deterministic PRNG (Park–Miller), so a reload draws the same backfill. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Local "YYYY-MM-DD", the key Usage buckets on. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight `daysAgo` days before load, plus `hours`. */
function dayAt(daysAgo: number, hours: number): number {
  const d = new Date(LOAD);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + hours * HOUR;
}

// ── Boot identity ─────────────────────────────────────────────────────────

/** One org, one project, opened on launch (`activeWorkspaceId`). */
function appState(): AppStateWire {
  return {
    currentProject: null,
    recentProjects: [],
    workspaces: [PROJECT],
    groups: [],
    activeWorkspaceId: PROJECT.id,
    organisations: [
      {
        id: ORG_ID,
        name: ORG_NAME,
        slug: ORG_SLUG,
        syncEnabled: true,
        remoteId: ORG_REMOTE_ID,
      },
    ],
    activeOrganisationId: ORG_ID,
    // Both are on in the videos (Settings → General); stated rather than
    // inherited so a change of default cannot quietly turn them off on camera.
    settings: { ...DEFAULT_SETTINGS, agentOrgAccess: true, gitBlameInline: true },
    configStatus: { status: "ok" },
    configGeneration: 1,
    version: 3,
  };
}

// ── Capture ───────────────────────────────────────────────────────────────

const ROOT_COMMIT = "4b1e9c07d2a35f8e61c0b97a4d28e3f5c19a7d60";
const GIT_URL = "https://github.com/northwind-dev/northwind-shop.git";

const BINDING: Binding = {
  workspaceId: PROJECT.id,
  root: PROJECT.path,
  mode: "cloud",
  slug: PROJECT.name,
  // The SERVER org id: the popover finds the org's name by `remoteId`.
  orgId: ORG_REMOTE_ID,
  rootCommitSha: ROOT_COMMIT,
  fingerprintIsShallow: false,
  gitUrl: GIT_URL,
  enabled: true,
  importApproved: true,
  drainState: "ok",
  remoteWorkspaceId: REMOTE_PROJECT_ID,
  createdAt: iso(LOAD - 6 * DAY - 3 * HOUR),
};

const DETECTION: Detection = {
  root: PROJECT.path,
  isGitRepository: true,
  hasCommits: true,
  rootCommitSha: ROOT_COMMIT,
  isShallow: false,
  gitUrl: GIT_URL,
  suggestedSlug: PROJECT.name,
};

const HEALTHY: CaptureHealth = {
  state: "ok",
  summary: "Synced",
  issues: [],
  flaggedSessions: 0,
  failedRows: 0,
  pendingRows: 0,
};

const isProject = (path: unknown) => String(path) === PROJECT.path;

function sessionSummary(sessionId: string): SessionSummary {
  const known = mySessions().find((s) => s.content.id === sessionId);
  const s = known ?? mySessions()[0];
  const c = s.content;
  const tools = s.steps.filter((step) => step.kind === "tool");
  const edits = tools.filter((step) => step.tool === "edit" || step.tool === "write");
  return {
    id: sessionId,
    title: known ? c.title : "",
    agent: c.agent,
    model: c.model,
    source: c.agent === "atlas-agent" ? "atlas-agent" : "acp",
    startedAt: iso(s.startMs),
    updatedAt: iso(s.lastMs),
    lastActivityAt: iso(s.lastMs),
    activeSeconds: c.durationMin * 45,
    wallSeconds: c.durationMin * 60,
    messageCount: s.steps.filter((step) => step.kind === "prompt" || step.kind === "response")
      .length,
    toolCallCount: tools.length,
    checkpointCount: s.steps.filter((step) => step.kind === "checkpoint").length,
    branches: [c.branch],
    insertions: edits.reduce((n, step) => n + lineStats(step).insertions, 0),
    deletions: edits.reduce((n, step) => n + lineStats(step).deletions, 0),
    filesTouched: new Set(edits.map((step) => step.path)).size,
    totalTokens: c.agent === "atlas-agent" ? c.tokens.input + c.tokens.output : 0,
    inputTokens: c.agent === "atlas-agent" ? c.tokens.input : 0,
    outputTokens: c.agent === "atlas-agent" ? c.tokens.output : 0,
    cacheCreationTokens: c.tokens.cacheWrite,
    cacheReadTokens: c.tokens.cacheRead,
    contextUsed: Math.min(200_000, c.tokens.input + c.tokens.cacheRead / 4),
    contextSize: 200_000,
    needsAttention: false,
    attentionReason: null,
  };
}

// ── Usage ─────────────────────────────────────────────────────────────────

/** USD per 1M tokens: input, output, cache read, cache write. */
const PRICE: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [15, 75, 1.5, 18.75],
  "claude-sonnet-5-5": [3, 15, 0.3, 3.75],
  "gpt-5": [1.25, 10, 0.125, 0],
};

interface Spend {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const priced = (model: string, t: Spend): number => {
  const p = PRICE[model] ?? [0, 0, 0, 0];
  return (t.input * p[0] + t.output * p[1] + t.cacheRead * p[2] + t.cacheWrite * p[3]) / 1e6;
};

/** What the store-front looked like being built, oldest first: the backfill's titles. */
const BACKFILL_TITLES = [
  "Scaffold the Bun server and the page routes",
  "Add the product grid",
  "Seed the catalog",
  "Store prices as integer cents",
  "Format prices with formatCents",
  "Cart API with a cookie per shopper",
  "Cart page with quantity inputs",
  "Set up bun test",
  "Write cart tests",
  "Checkout form layout",
  "Validate name, email and address on checkout",
  "Recompute order totals on the server",
  "Order confirmation message",
  "Add a free shipping threshold",
  "Explain the order flow end to end",
  "Header with the cart count",
  "Free shipping banner",
  "Tidy styles.css into sections",
  "JSON 404 for unknown API paths",
  "Empty-cart state",
  "Keyboard focus styles for buttons",
  "Rename OrderBook methods",
  "Add a README with setup steps",
  "Move the API routes into src/server/api.ts",
  "Escape product names in HTML",
  "Write API tests with a cookie per shopper",
  "Add the MIT license",
  "Explain how the cart total is computed",
];

/**
 * Agent × model for one backfill session, weighted like a Claude Code user.
 * Never Codex: Uzayer installs it on camera in video 9.
 */
function pickAgent(r: number): { agent: AgentKey; model: string } {
  if (r < 0.55) return { agent: "claude-code", model: "claude-opus-5-5" };
  if (r < 0.8) return { agent: "claude-code", model: "claude-sonnet-5-5" };
  return { agent: "atlas-agent", model: "claude-sonnet-5-5" };
}

/**
 * Uzayer's agent work before the recorded Sessions: one or two short runs a
 * weekday, the odd one at a weekend, over the four weeks before capture began.
 * Smaller than the recorded Sessions on purpose — the shop was young.
 */
function backfill(): SessionRow[] {
  const rnd = prng(20_261_007);
  const rows: SessionRow[] = [];
  let title = 0;
  for (let daysAgo = 29; daysAgo >= 7; daysAgo--) {
    const day = new Date(dayAt(daysAgo, 0)).getDay();
    const weekend = day === 0 || day === 6;
    const count = weekend ? (rnd() < 0.35 ? 1 : 0) : rnd() < 0.55 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const { agent, model } = pickAgent(rnd());
      const input = Math.round(8_000 + rnd() * 26_000);
      const output = Math.round(input * (0.12 + rnd() * 0.08));
      const cacheRead =
        agent === "codex"
          ? Math.round(input * (2.5 + rnd()))
          : Math.round(input * (3.8 + rnd() * 1.6));
      const cacheWrite = agent === "codex" ? 0 : Math.round(input * (0.3 + rnd() * 0.15));
      const spend = { input, output, cacheRead, cacheWrite };
      const startedMs = dayAt(daysAgo, 9.5 + i * 4 + rnd() * 3);
      const minutes = 3 + Math.floor(rnd() * 9);
      rows.push({
        sessionId: `ses_${(0x5a17c3 + rows.length * 7919).toString(16)}${daysAgo}`,
        projectPath: PROJECT.path,
        agent,
        model,
        ...spend,
        reasoning: agent === "codex" ? Math.round(output * 0.4) : 0,
        messages: 4 + Math.floor(rnd() * 14),
        cost: priced(model, spend),
        startedMs,
        lastActivityMs: startedMs + minutes * MIN,
        title: BACKFILL_TITLES[title++ % BACKFILL_TITLES.length],
        ledgered: true,
      });
    }
  }
  return rows;
}

const BACKFILL = backfill();

/** A recorded Session as Usage reads it: the content's own tokens and cost. */
function usageRow(s: SessionState): SessionRow {
  const c = s.content;
  const prompts = s.steps.filter((step) => step.kind === "prompt").length;
  const tools = s.steps.filter((step) => step.kind === "tool").length;
  return {
    sessionId: c.id,
    projectPath: PROJECT.path,
    agent: c.agent,
    model: c.model,
    ...c.tokens,
    reasoning: c.agent === "codex" ? Math.round(c.tokens.output * 0.4) : 0,
    messages: Math.max(2, prompts * 2 + tools),
    cost: c.costUsd,
    startedMs: s.startMs,
    lastActivityMs: s.lastMs,
    title: c.title,
    ledgered: true,
  };
}

type Metrics = Omit<DailyBucket, "date" | "projectPath" | "agent" | "model">;
const zero = (): Metrics => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  messages: 0,
  sessions: 0,
});

function addInto(into: Metrics, row: SessionRow | DailyBucket, sessionCount: number): void {
  into.input += row.input;
  into.output += row.output;
  into.cacheRead += row.cacheRead;
  into.cacheWrite += row.cacheWrite;
  into.reasoning += row.reasoning;
  into.cost += row.cost;
  into.messages += row.messages;
  into.sessions += sessionCount;
}

/** Folded the way Rust folds: every rollup from `daily`, so filters agree with totals. */
function usageDashboard(): UsageDashboard {
  const rows = [...mySessions().map(usageRow), ...BACKFILL].sort(
    (a, b) => (b.lastActivityMs ?? b.startedMs) - (a.lastActivityMs ?? a.startedMs),
  );

  const buckets = new Map<string, DailyBucket>();
  for (const row of rows) {
    const date = dayKey(row.lastActivityMs ?? row.startedMs);
    const key = `${date}|${row.agent}|${row.model}`;
    const bucket = buckets.get(key) ?? {
      date,
      projectPath: PROJECT.path,
      agent: row.agent,
      model: row.model,
      ...zero(),
    };
    addInto(bucket, row, 1);
    buckets.set(key, bucket);
  }
  const daily = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));

  const rollup = <K extends "agent" | "model">(axis: K) => {
    const by = new Map<string, Metrics>();
    for (const bucket of daily) {
      const m = by.get(bucket[axis]) ?? zero();
      addInto(m, bucket, bucket.sessions);
      by.set(bucket[axis], m);
    }
    return [...by].map(([value, m]) => ({ [axis]: value, ...m }) as Metrics & Record<K, string>);
  };

  const totals = zero();
  for (const bucket of daily) addInto(totals, bucket, bucket.sessions);
  const times = rows.map((row) => row.startedMs);

  return {
    totals: {
      ...totals,
      byokInput: 0,
      byokOutput: 0,
      byokCost: 0,
      byokRequests: 0,
      totalTokens: totals.input + totals.output,
      totalCostUsd: totals.cost,
    },
    projects: [
      {
        projectPath: PROJECT.path,
        projectName: PROJECT.name,
        firstActivityMs: Math.min(...times),
        lastActivityMs: Math.max(...rows.map((row) => row.lastActivityMs ?? row.startedMs)),
        ...totals,
      },
    ],
    agents: rollup("agent"),
    models: rollup("model"),
    daily,
    sessions: rows,
    sessionsTotal: rows.length,
    byokDaily: [],
    byokSince: null,
    byokProjectPath: "byok",
    // Well before the 30-day window, so every day in it reads "dated per turn".
    ledgerSince: iso(dayAt(45, 9)),
    generatedAt: iso(Date.now()),
  };
}

// ── Chat history ──────────────────────────────────────────────────────────

/** The agent id a history row carries — what the sidebar's icon resolves. */
const THREAD_AGENT: Record<AgentKey, string> = {
  "claude-code": "claude-code",
  codex: "codex-acp",
  "atlas-agent": "atlas-agent",
};

/**
 * Uzayer's agent chats in Atlas: his recorded Sessions run from the composer.
 * Imported ones ran in a terminal before capture and never were Atlas chats;
 * Codex is not installed yet (video 9 installs it), so its run is not here.
 */
function seedThreads(): ThreadRow[] {
  return mySessions()
    .filter((s) => !s.content.imported && s.content.agent !== "codex")
    .map((s) => ({
      threadId: `th_${s.content.id.slice(2)}`,
      sessionId: s.content.id,
      agentId: THREAD_AGENT[s.content.agent],
      title: s.content.title,
      updatedAt: iso(s.lastMs),
      createdAt: iso(s.startMs),
      archived: false,
      projectName: PROJECT.name,
      folderPaths: [PROJECT.path],
      // The branch the Session itself records: `main`, except the run that
      // built server-side discount validation on `server-discounts`.
      branch: s.content.branch,
      // The demo's own sessions: no other process is writing any of them.
      liveElsewhere: false,
    }));
}

let threads: ThreadRow[] = seedThreads();
const threadsChanged = () => void emit("atlas:threads-changed");

/** One project; current when the sidebar is scoped to it, as Rust marks it
 *  (unscoped, nothing is current and the sidebar heads the list with it). */
function threadProjects(cwd: string | null): ThreadProject[] {
  const live = threads.filter((thread) => !thread.archived);
  if (live.length === 0) return [];
  const isCurrent = cwd !== null && cwd !== "";
  return [{ name: PROJECT.name, paths: [PROJECT.path], isCurrent, threads: live }];
}

function transcript(sessionId: string): AtlasTranscriptMessage[] {
  const s = mySessions().find((candidate) => candidate.content.id === sessionId);
  if (!s) return [];
  return s.steps.flatMap((step): AtlasTranscriptMessage[] => {
    const timestamp = iso(s.startMs + step.min * MIN);
    if (step.kind === "prompt") return [{ role: "user", content: step.text, timestamp }];
    if (step.kind === "response") {
      return [{ role: "assistant", content: step.text, timestamp, model: s.content.model }];
    }
    return [];
  });
}

// ── Agents ────────────────────────────────────────────────────────────────

/** A monochrome `currentColor` glyph, as registry manifests publish them. */
function glyph(path: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">${path}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const STAR = '<path d="M8 1l1.6 4.9H15l-4.2 3 1.6 4.9L8 10.8 3.6 13.8l1.6-4.9L1 5.9h5.4z"/>';
const RING = '<path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a4 4 0 110 8 4 4 0 010-8z"/>';
const BARS = '<path d="M2 3h12v2H2zm0 4h8v2H2zm0 4h12v2H2z"/>';
const CUBE = '<path d="M8 1l6 3.5v7L8 15l-6-3.5v-7zm0 2.3L4 5.6l4 2.3 4-2.3z"/>';
const PI = '<path d="M2 3h12v2h-2.5v8h-2V5h-3v8h-2V5H2z"/>';
const DIAMOND = '<path d="M8 1l7 7-7 7-7-7z"/>';

const registryEntry = (
  over: Partial<AcpRegistryEntry> & Pick<AcpRegistryEntry, "id" | "name">,
): AcpRegistryEntry => ({
  version: "1.0.0",
  description: null,
  repository: null,
  website: null,
  iconDataUrl: null,
  installed: false,
  platformSupported: true,
  distributionKind: "binary",
  unverified: false,
  unsupportedReason: null,
  installedVersion: null,
  updateAvailable: false,
  ...over,
});

/** Settings → Agents, and the source of the picker's "Available to install". */
const registry: AcpRegistryEntry[] = [
  registryEntry({
    id: "claude-acp",
    name: "Claude Code",
    version: "1.8.3",
    description: "Anthropic's coding agent, speaking ACP over stdio.",
    repository: "https://github.com/anthropics/claude-code-acp",
    website: "https://claude.com/product/claude-code",
    iconDataUrl: glyph(STAR),
    installed: true,
  }),
  registryEntry({
    id: "codex-acp",
    name: "Codex",
    version: "0.44.0",
    description: "OpenAI's Codex CLI with an ACP bridge.",
    repository: "https://github.com/openai/codex",
    website: "https://openai.com/codex",
    iconDataUrl: glyph(RING),
  }),
  registryEntry({
    id: "opencode",
    name: "OpenCode",
    version: "0.6.14",
    description: "Open-source terminal agent with a provider-agnostic model layer.",
    repository: "https://github.com/sst/opencode",
    website: "https://opencode.ai",
    iconDataUrl: glyph(BARS),
    distributionKind: "npx",
  }),
  registryEntry({
    id: "cursor",
    name: "Cursor",
    version: "2.1.0",
    description: "Cursor's agent, headless, in your terminal.",
    website: "https://cursor.com",
    iconDataUrl: glyph(CUBE),
  }),
  registryEntry({
    id: "pi-acp",
    name: "Pi",
    version: "0.3.0",
    description: "A minimal, extensible coding agent.",
    iconDataUrl: glyph(PI),
    distributionKind: "npx",
  }),
  registryEntry({
    id: "gemini-cli-acp",
    name: "Gemini CLI",
    version: "0.12.1",
    description: "Google's Gemini CLI, fetched by npm on first spawn.",
    repository: "https://github.com/google-gemini/gemini-cli",
    website: "https://ai.google.dev",
    iconDataUrl: glyph(DIAMOND),
    distributionKind: "npx",
  }),
  registryEntry({
    id: "goose",
    name: "Goose",
    version: "1.6.0",
    description: "Block's extensible on-machine agent.",
    repository: "https://github.com/block/goose",
    website: "https://block.github.io/goose",
  }),
];

const catalogEntry = (
  over: Partial<AgentCatalogEntry> & Pick<AgentCatalogEntry, "id" | "name">,
): AgentCatalogEntry => ({
  agentType: over.id,
  description: null,
  version: null,
  kind: "external",
  source: "installed",
  resolvedPath: null,
  installed: true,
  supportsModes: false,
  supportsModels: false,
  transcript: "none",
  login: null,
  authKinds: [],
  supportsLogout: false,
  supportsFork: false,
  supportsRewind: false,
  iconDataUrl: null,
  helpUrl: null,
  repository: null,
  website: null,
  platformSupported: true,
  distributionKind: "",
  unverified: false,
  unsupportedReason: null,
  ...over,
});

let catalog: AgentCatalogEntry[] = [
  catalogEntry({
    id: "atlas-agent",
    name: "Atlas Agent",
    description: "Atlas's own agent, running in-process — no subprocess, no install.",
    version: VERSION,
    kind: "native",
    source: "in-process",
    // In-process: there is no installed-map entry, exactly as Rust reports it.
    installed: false,
    supportsModes: true,
    supportsModels: true,
    transcript: "native",
    authKinds: ["env_var"],
    supportsRewind: true,
  }),
  catalogEntry({
    id: "claude-acp",
    agentType: "claude-code",
    name: "Claude Code",
    description: "Anthropic's coding agent, speaking ACP over stdio.",
    version: "1.8.3",
    resolvedPath: `${HOME}/.atlas/agents/claude-acp/bin/claude-code-acp`,
    supportsModes: true,
    supportsModels: true,
    login: { program: "claude", args: ["setup-token"] },
    authKinds: ["agent", "terminal"],
    supportsLogout: true,
    supportsFork: true,
    iconDataUrl: glyph(STAR),
    helpUrl: "https://github.com/anthropics/claude-code-acp",
    repository: "https://github.com/anthropics/claude-code-acp",
    website: "https://claude.com/product/claude-code",
    distributionKind: "binary",
  }),
];

const listing = (): AcpRegistryListing => ({
  entries: registry,
  lastRefreshedAt: iso(LOAD - 20 * MIN),
  lastError: null,
  isFetching: false,
});

const agentCatalog = (): AgentCatalog => ({
  entries: catalog,
  lastRefreshedAt: iso(LOAD - 20 * MIN),
  lastDiscoveredAt: iso(LOAD - 20 * MIN),
  lastError: null,
});

/** Install writes the installed map; the picker re-hydrates itself afterwards
 *  (`FeaturedAgentOffers` calls `hydrateAgentRegistry`), and Rust emits no
 *  event for it either. */
function installAgent(id: string): null {
  const entry = registry.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`'${id}' is not in the registry`);
  entry.installed = true;
  if (!catalog.some((candidate) => candidate.id === id)) {
    catalog = [
      ...catalog,
      catalogEntry({
        id,
        name: entry.name,
        description: entry.description,
        version: entry.version,
        source: entry.distributionKind === "npx" ? "npx" : "installed",
        resolvedPath:
          entry.distributionKind === "npx" ? null : `${HOME}/.atlas/agents/${id}/bin/${id}`,
        supportsModes: id === "codex-acp",
        supportsModels: id === "codex-acp",
        iconDataUrl: entry.iconDataUrl,
        helpUrl: entry.repository ?? entry.website,
        repository: entry.repository,
        website: entry.website,
        distributionKind: entry.distributionKind,
      }),
    ];
  }
  return null;
}

if (CODEX_INSTALLED) installAgent("codex-acp");

function uninstallAgent(id: string): null {
  const entry = registry.find((candidate) => candidate.id === id);
  if (entry) entry.installed = false;
  catalog = catalog.filter((candidate) => candidate.id !== id || candidate.kind === "native");
  return null;
}

/** The gateway's models for the Atlas Agent (ADR-0007). */
const NATIVE_MODELS = NORTHWIND_NATIVE_MODELS;

// ── Memory ────────────────────────────────────────────────────────────────

/** The memory corpus spells agents its own way (`memory-agent.ts`). */
const MEMORY_AGENT: Record<AgentKey, string> = {
  "claude-code": "claude",
  codex: "codex",
  "atlas-agent": "atlas-agent",
};

const ENTRY_KIND: Record<MemoryContent["kind"], EntryKind> = {
  decision: "decision",
  fact: "fact",
  failure: "failure",
  file: "file_changed",
  plan: "plan",
  architecture: "architecture",
};

const EVENT_KIND: Record<MemoryContent["kind"], EventKind> = {
  decision: "decision",
  fact: "fact",
  failure: "failure",
  file: "file_changed",
  plan: "plan_set",
  architecture: "architecture",
};

/** User edits and forgets, by content id — the world's list is append-only. */
const entryEdits = new Map<string, { content: string; updatedAt: number }>();
const forgotten = new Set<string>();
let sharing = true;
let fromExternalSessions = false;

function entries(): MemoryEntry[] {
  return memory()
    .map((m, index): MemoryEntry | null => {
      if (forgotten.has(m.id)) return null;
      const at = whenMs(m.when);
      const edit = entryEdits.get(m.id);
      // Older memories have been injected into a few sessions since.
      const uses = Math.max(0, Math.floor((LOAD - at) / DAY));
      return {
        id: index + 1,
        kind: ENTRY_KIND[m.kind],
        key: m.id.replace(/^mem-/, ""),
        content: edit?.content ?? m.text,
        status: m.kind === "plan" ? "active" : "",
        source: edit ? "user" : MEMORY_AGENT[m.agent],
        agent: MEMORY_AGENT[m.agent],
        sessionId: m.session ?? "",
        confidence: edit ? 1 : m.confidence,
        createdAt: at,
        updatedAt: edit?.updatedAt ?? at,
        lastUsedAt: uses ? LOAD - Math.min(uses, 3) * 5 * HOUR : null,
        uses,
        revision: index + 1,
        state: "active",
      };
    })
    .filter((entry): entry is MemoryEntry => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The event log behind the Shared view: each Session's start, then its memories. */
function events(): MemoryEvent[] {
  const raw: Omit<MemoryEvent, "seq">[] = [];
  const started = new Set<string>();
  const ordered = memory()
    .filter((m) => !forgotten.has(m.id))
    .sort((a, b) => whenMs(a.when) - whenMs(b.when));
  for (const m of ordered) {
    const at = whenMs(m.when);
    const agent = MEMORY_AGENT[m.agent];
    const sessionId = m.session ?? "";
    if (sessionId && !started.has(sessionId)) {
      started.add(sessionId);
      raw.push({
        ts: at - 2 * MIN,
        agent,
        sessionId,
        kind: "session_start",
        key: "",
        payload: { cwd: PROJECT.path },
      });
    }
    const text = entryEdits.get(m.id)?.content ?? m.text;
    raw.push({
      ts: at,
      agent,
      sessionId,
      kind: EVENT_KIND[m.kind],
      key: m.kind === "file" ? (m.files?.[0] ?? "") : m.id.replace(/^mem-/, ""),
      payload:
        m.kind === "file"
          ? { path: m.files?.[0] ?? "", summary: text }
          : m.kind === "plan"
            ? { status: "active", text }
            : { text },
    });
  }
  return raw.map((event, index) => ({ seq: index + 1, ...event }));
}

/** Rust's fold (`SharedState::apply`), enough of it for six kinds. */
function sharedState(): SharedState {
  const state: SharedState = {
    lastSeq: 0,
    activePlan: null,
    decisions: [],
    recentChanges: [],
    facts: [],
    failures: [],
    architecture: [],
    sessionAgents: {},
    updatedAt: 0,
  };
  for (const event of events()) {
    state.lastSeq = event.seq;
    state.updatedAt = event.ts;
    const text = String(event.payload.text ?? "");
    const { seq, agent } = event;
    if (event.kind === "session_start") state.sessionAgents[event.sessionId] = agent;
    else if (event.kind === "plan_set") state.activePlan = { seq, agent, text, status: "active" };
    else if (event.kind === "decision") state.decisions.push({ seq, agent, key: event.key, text });
    else if (event.kind === "file_changed") {
      state.recentChanges.push({
        seq,
        agent,
        path: String(event.payload.path),
        summary: String(event.payload.summary ?? ""),
      });
    } else if (event.kind === "fact") state.facts.push({ seq, agent, text });
    else if (event.kind === "failure") state.failures.push({ seq, agent, text });
    else if (event.kind === "architecture") state.architecture.push({ seq, agent, text });
  }
  return state;
}

/** What each CLAUDE.md rule is about, for the Policy table's hint column. */
const POLICY_HINT: Record<string, string> = {
  "Package manager": "npm / pnpm / yarn / bun",
  Branching: "Committing, branches, main",
  Testing: "Running tests before a commit",
};

const policies: Policy[] = CONTENT.policies.map((p) => ({
  id: p.policy,
  key: p.policy,
  hint: POLICY_HINT[p.policy] ?? p.policy,
  value: p.value,
  category: /\b(always|never|every)\b/i.test(p.value) ? "strong" : "soft",
  origin: "preference",
  match_kind: p.match === "exact" ? "keyword" : "semantic",
  source: "claude",
  file_path: `${PROJECT.path}/${p.source}`,
  doc_title: p.source,
  score: p.match === "exact" ? 1 : 0.82,
}));

/** The Graph view: CLAUDE.md, every memory, linked where they share a file. */
function graph(): MemoryGraphData {
  const mems = memory().filter((m) => !forgotten.has(m.id));
  const nodes: MemoryNode[] = [
    {
      id: "claude:CLAUDE.md",
      title: "CLAUDE.md",
      summary: "Project instructions: bun only, no commits to main, tests before every commit",
      kind: "instruction",
      source: "claude",
      snippet: CONTENT.policies.map((p) => p.value).join(" "),
      degree: 0,
      timestampMs: LOAD - 6 * DAY,
    },
    ...mems.map((m) => {
      const text = entryEdits.get(m.id)?.content ?? m.text;
      return {
        id: `shared:${m.kind}:${m.id}`,
        title: text.split(/[.:(]/)[0].slice(0, 60),
        summary: text.slice(0, 90),
        kind: m.kind,
        source: MEMORY_AGENT[m.agent],
        snippet: text,
        degree: 0,
        timestampMs: whenMs(m.when),
      };
    }),
  ];
  const edges: MemoryEdge[] = [];
  for (let i = 0; i < mems.length; i++) {
    edges.push({
      from: "claude:CLAUDE.md",
      to: `shared:${mems[i].kind}:${mems[i].id}`,
      weight: 0.38 + (i % 4) * 0.04,
      kind: "similarity",
    });
    for (let j = i + 1; j < mems.length; j++) {
      const a = mems[i];
      const b = mems[j];
      const shared = (a.files ?? []).some((file) => (b.files ?? []).includes(file));
      const sameArea = a.text.includes("order") && b.text.includes("order");
      if (!shared && !sameArea) continue;
      const [older, newer] = whenMs(a.when) <= whenMs(b.when) ? [a, b] : [b, a];
      edges.push({
        from: `shared:${older.kind}:${older.id}`,
        to: `shared:${newer.kind}:${newer.id}`,
        weight: shared ? 0.71 : 0.52,
        kind: "similarity",
      });
    }
  }
  for (const node of nodes) {
    node.degree = edges.filter((e) => e.from === node.id || e.to === node.id).length;
  }
  return { nodes, edges };
}

function queryGraph(query: string, topK: number): QueryHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);
  if (terms.length === 0) return [];
  return graph()
    .nodes.map((node) => ({
      id: node.id,
      hits: terms.filter((term) => `${node.title} ${node.snippet}`.toLowerCase().includes(term))
        .length,
    }))
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, topK)
    .map((row, index) => ({ id: row.id, score: Number((0.81 - index * 0.04).toFixed(4)) }));
}

const memoryChanged = (kinds: string[]) =>
  void emit("atlas:memory-changed", { root: PROJECT.path, kinds });

/**
 * Video 11 beat 1: `/remember` stores the discount-code decision. The open
 * Memory tab's Shared view re-pulls on `atlas:memory-changed` (the store's
 * one app-lifetime subscription), so the new row appears without a refresh.
 */
export function rememberDecision(): void {
  addMemory(CONTENT.memoryOnRemember);
  memoryChanged([ENTRY_KIND[CONTENT.memoryOnRemember.kind]]);
}

// ── Skills ────────────────────────────────────────────────────────────────

const TOOLS: ToolInfo[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    detectedGlobal: true,
    detectedProject: true,
    supportsSymlink: true,
    delivery: "native-dir",
  },
  {
    id: "codex",
    displayName: "Codex",
    detectedGlobal: true,
    detectedProject: true,
    supportsSymlink: true,
    delivery: "native-dir",
  },
  {
    id: "atlas",
    displayName: "Atlas",
    detectedGlobal: true,
    detectedProject: true,
    supportsSymlink: true,
    delivery: "native-dir",
  },
];

const SKILLS_DIR: Record<string, Record<Scope, string>> = {
  "claude-code": { global: `${HOME}/.claude/skills`, project: `${PROJECT.path}/.claude/skills` },
  codex: { global: `${HOME}/.codex/skills`, project: `${PROJECT.path}/.agents/skills` },
  atlas: {
    global: `${HOME}/.atlas/agent-skills`,
    project: `${PROJECT.path}/.atlas/agent-skills`,
  },
};

const asScope = (value: unknown): Scope => (value === "project" ? "project" : "global");

interface NwSkill {
  name: string;
  description: string;
  scope: Scope;
  /** Tool ids it is delivered to. */
  tools: string[];
  body: string;
}

/** A project skill's body: its SKILL.md in the repo, without the front matter. */
const skillBody = (name: string): string =>
  (NORTHWIND_FILES[`.agents/skills/${name}/SKILL.md`]?.text ?? "").replace(
    /^---\n[\s\S]*?\n---\n\n/,
    "",
  );

let skills: NwSkill[] = [
  {
    name: "remember",
    description:
      "Save the decisions, facts, dead ends and architecture this conversation established to Atlas's shared memory, so other agents and future sessions can build on them.",
    scope: "global",
    tools: ["claude-code", "codex", "atlas"],
    body: `# remember

Save what this conversation established to Atlas's shared memory.

1. Pick out the decisions, facts, dead ends and architecture worth keeping.
2. Write each one as a single sentence that stands on its own.
3. Store each with the memory tool, naming the files it is about.
`,
  },
  {
    name: "code-review",
    description:
      "Review the changes on this branch against the project's conventions and the issue.",
    scope: "global",
    tools: ["claude-code", "codex", "atlas"],
    body: `# code-review

Review the diff since the merge-base with main.

\`\`\`bash
git diff --stat $(git merge-base HEAD main)..HEAD
\`\`\`

Report findings by severity; quote the line, say why, suggest the fix.
`,
  },
  {
    name: "commit-messages",
    description: "Write a short, imperative commit subject from the staged diff.",
    scope: "global",
    tools: ["claude-code"],
    body: `# commit-messages

Read \`git diff --cached\` and write one imperative subject line under 60
characters. Add a body only when the why is not obvious from the diff.
`,
  },
  {
    name: "release-notes",
    description: "Write release notes for northwind-shop from the commits since the last tag.",
    scope: "project",
    tools: ["claude-code", "codex", "atlas"],
    body: skillBody("release-notes"),
  },
  {
    name: "api-routes",
    description: "How northwind-shop's API routes are laid out, and the rules a new one follows.",
    scope: "project",
    tools: ["claude-code", "atlas"],
    body: skillBody("api-routes"),
  },
];

const skillPath = (skill: NwSkill): string =>
  `${skill.scope === "project" ? PROJECT.path : HOME}/.agents/skills/${skill.name}/SKILL.md`;

function findSkill(scope: Scope, name: string): NwSkill {
  const skill = skills.find((s) => s.scope === scope && s.name === name);
  if (!skill) throw new Error(`skill '${name}' was not found in ${scope} scope`);
  return skill;
}

function skillMeta(skill: NwSkill): SkillMeta {
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    enabledAgents: [...skill.tools],
    path: skillPath(skill),
    delivery: "native-dir",
    managed: true,
    pack: null,
  };
}

function cellsOf(skill: NwSkill): ProjectionCell[] {
  return TOOLS.map((tool) => {
    const on = skill.tools.includes(tool.id);
    return {
      tool: tool.id,
      scope: skill.scope,
      status: (on ? "synced" : "absent") satisfies ProjectionStatus,
      mode: on ? "symlink" : null,
    };
  });
}

const targets = (scope: Scope): AgentTarget[] =>
  TOOLS.map((tool) => ({
    id: tool.id,
    displayName: tool.displayName,
    skillsDir: SKILLS_DIR[tool.id][scope],
    delivery: tool.delivery,
    detected: true,
  }));

function setDelivered(scope: unknown, name: unknown, tool: unknown, on: boolean): null {
  const skill = findSkill(asScope(scope), String(name));
  const id = String(tool);
  skill.tools = on
    ? [...new Set([...skill.tools, id])]
    : skill.tools.filter((candidate) => candidate !== id);
  return null;
}

/** Discover (skills.sh): believable public repos only. Every "Popular" seed
 *  query — agent, react, design, review, database, python — matches something. */
const SEARCH_INDEX: PackSearchHit[] = [
  ["anthropics/skills", "skill-creator", 182_440],
  ["anthropics/skills", "webapp-testing", 96_210],
  ["anthropics/skills", "frontend-design", 141_087],
  ["vercel-labs/agent-skills", "react-best-practices", 118_530],
  ["vercel-labs/agent-skills", "web-design-guidelines", 64_902],
  ["obra/superpowers", "systematic-debugging", 88_315],
  ["obra/superpowers", "test-driven-development", 79_660],
  ["obra/superpowers", "requesting-code-review", 41_208],
  ["supabase/agent-skills", "postgres-database-design", 27_904],
  ["astral-sh/skills", "python-uv-projects", 23_115],
  ["openai/skills", "agents-md", 35_771],
].map(([source, skillId, installs]) => ({
  id: `${source}/${skillId}`,
  skillId: String(skillId),
  name: String(skillId),
  installs: Number(installs),
  source: String(source),
}));

function previewOf(source: string): Pack {
  const name = source.split("/")[1] ?? source;
  return {
    name,
    root: `/tmp/atlas-preview/${name}`,
    manifest: null,
    components: SEARCH_INDEX.filter((hit) => hit.source === source).map((hit): PackComponent => ({
      kind: "skill",
      name: hit.skillId,
      relPath: `skills/${hit.skillId}/SKILL.md`,
      description: null,
    })),
  };
}

// ── Settings ──────────────────────────────────────────────────────────────

const ZSHRC = `${HOME}/.zshrc`;

const secrets = new Map<string, string>([
  ["ANTHROPIC_API_KEY", "sk-ant-api03-pX4vN9qL2wT7rB0kE5mY8cH3jD6fS1aZu2Gi"],
  ["OPENAI_API_KEY", "sk-proj-Rt5Wq8Lm2Ke7Xv0Bn4Cy9Hs3Pd6Fa1Jg-Tz8u"],
]);

let envEntries: EnvEntry[] = [
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    last4: "u2Gi",
    file: ZSHRC,
    line: 14,
    editable: true,
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    last4: "Tz8u",
    file: ZSHRC,
    line: 15,
    editable: true,
  },
];

const CLI: CliStatus = {
  installed: true,
  path: `${HOME}/.local/bin/atlas`,
  installedVersion: VERSION,
  currentVersion: VERSION,
};

// ── Log (⌘K → Log) ────────────────────────────────────────────────────────

type LogSeed = [
  minutesAgo: number,
  source: LogSource,
  kind: string,
  summary: string,
  payload?: Record<string, unknown>,
];

const LOG_SEEDS: LogSeed[] = [
  [
    3,
    "agent",
    "agent-org-action",
    "atlas-agent org_sessions: by Zuhayer Masud",
    {
      agent: "atlas-agent",
      tool: "org_sessions",
      status: "success",
    },
  ],
  [
    4,
    "agent",
    "agent-org-action",
    "atlas-agent org_inbox: 2 unread",
    {
      agent: "atlas-agent",
      tool: "org_inbox",
      status: "success",
    },
  ],
  [
    35,
    "agent",
    "agent-org-action",
    "atlas-agent org_members: Northwind",
    {
      agent: "atlas-agent",
      tool: "org_members",
      status: "success",
    },
  ],
  [154, "git", "commit", "Make discount codes case-insensitive", { files: 2 }],
  [
    155,
    "agent",
    "turn",
    "Make discount codes case-insensitive",
    {
      model: "claude-opus-5-5",
      tokens: 27_800,
    },
  ],
  [158, "editor", "save", "api.ts", { path: "src/server/api.ts" }],
  [170, "git", "pull", "main: 3 new commits from Zuhayer"],
  [180, "project", "open", PROJECT.name, { path: PROJECT.path }],
  [182, "system", "index", "Codebase index rebuilt: 24 files", { durationMs: 1_840 }],
];

function projectLog(): string {
  const rows: LogEntry[] = LOG_SEEDS.map(([minutesAgo, source, kind, summary, payload], i) => ({
    id: `log_${(LOAD - minutesAgo * MIN).toString(36)}_${i}`,
    timestamp: iso(LOAD - minutesAgo * MIN),
    source,
    kind,
    summary,
    orgId: ORG_ID,
    projectPath: PROJECT.path,
    projectName: PROJECT.name,
    ...(payload ? { payload } : {}),
  }));
  // Oldest first on disk; the store sorts newest-first on read.
  return `${rows
    .reverse()
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
}

let projectLogText: string | null = null;

// ── Plans ─────────────────────────────────────────────────────────────────

let plans: PlanRecord[] = [
  {
    id: "plan_server_discounts",
    sessionId: "s-server-discounts",
    sessionTitle: "Move discount code validation to the server",
    userMessage: "Move discount code validation to the server.",
    plan: `## Validate discount codes on the server

1. Add \`src/server/discounts.ts\` with the codes and their percentages.
2. Apply the code in \`OrderBook.place\` when the total is computed.
3. Reject an unknown code with a 400 the checkout form can show.
4. Keep the browser's check for instant feedback only.
`,
    timestamp: iso(LOAD - DAY - 2 * HOUR),
  },
];

// ── Typed overrides ───────────────────────────────────────────────────────

export const northwindMiscCommands: Partial<TypedHandlers<MockResponses>> = {
  // ── capture ────────────────────────────────────────────────────────────
  capture_binding: ({ projectPath }): Binding | null => (isProject(projectPath) ? BINDING : null),
  capture_detect: ({ projectPath }): Detection =>
    isProject(projectPath)
      ? DETECTION
      : {
          root: String(projectPath),
          isGitRepository: false,
          hasCommits: false,
          rootCommitSha: null,
          isShallow: false,
          gitUrl: null,
          suggestedSlug: String(projectPath).split("/").pop() ?? "",
        },
  capture_health: ({ projectPath }): CaptureHealth =>
    isProject(projectPath)
      ? HEALTHY
      : { ...HEALTHY, state: "off", summary: "Session capture is off" },
  capture_import_preview: () => ({
    sessionCount: mySessions().length,
    newSessionCount: 0,
    earliest: iso(Math.min(...mySessions().map((s) => s.startMs))),
    latest: iso(Math.max(...mySessions().map((s) => s.lastMs))),
    totalBytes: 3_412_608,
    isBulkDisclosure: false,
  }),
  capture_session_summary: ({ projectPath, sessionId }): SessionSummary | null =>
    isProject(projectPath) ? sessionSummary(String(sessionId)) : null,
  capture_connect_options: (): ConnectOptions => ({
    workspaces: [
      {
        id: REMOTE_PROJECT_ID,
        slug: PROJECT.name,
        rootCommitSha: ROOT_COMMIT,
        gitUrl: GIT_URL,
        name: PROJECT.name,
        visibility: "org",
      },
    ],
    preselected: REMOTE_PROJECT_ID,
    warning: null,
  }),

  // ── usage and log ──────────────────────────────────────────────────────
  usage_dashboard: (): UsageDashboard => usageDashboard(),
  load_project_log: ({ project }): string => {
    if (!isProject(project)) return "";
    projectLogText ??= projectLog();
    return projectLogText;
  },
  append_project_log: ({ project, entryJson }): null => {
    if (isProject(project)) {
      projectLogText = `${projectLogText ?? projectLog()}${String(entryJson)}\n`;
    }
    return null;
  },
  clear_project_log: (): null => {
    projectLogText = "";
    return null;
  },
  load_pinned_log: (): string => "",

  // ── agents ─────────────────────────────────────────────────────────────
  acp_registry_list: listing,
  acp_registry_refresh: listing,
  acp_registry_metadata: ({ agentId }): AcpRegistryEntry | null =>
    registry.find((entry) => entry.id === String(agentId)) ?? null,
  acp_registry_install: async ({ agentId }): Promise<null> => {
    // Long enough for the row's spinner to read as a download.
    await new Promise((resolve) => setTimeout(resolve, 900));
    return installAgent(String(agentId));
  },
  acp_registry_install_detected: ({ agentId }): null => installAgent(String(agentId)),
  acp_registry_uninstall: ({ agentId }): null => uninstallAgent(String(agentId)),
  acp_registry_update: (): null => null,
  agents_catalog: agentCatalog,
  agents_catalog_refresh: agentCatalog,

  // ── memory ─────────────────────────────────────────────────────────────
  memory_embed_status: (): EmbedStatus => ({
    downloaded: true,
    model: "all-MiniLM-L6-v2",
    model_dir: `${HOME}/Library/Application Support/dev.atlas.app/models/all-MiniLM-L6-v2`,
  }),
  memory_index_build: ({ projectPath }) => {
    const data = isProject(projectPath) ? graph() : { nodes: [], edges: [] };
    return { ...data, dim: data.nodes.length ? 384 : 0, doc_count: data.nodes.length };
  },
  memory_index_query: ({ projectPath, query, topK }): QueryHit[] =>
    isProject(projectPath) ? queryGraph(String(query ?? ""), Number(topK ?? 12)) : [],
  memory_graph_layout_load: (): GraphLayout => ({ positions: {} }),
  memory_graph_layout_save: (): null => null,
  memory_policies: ({ projectPath }): Policy[] => (isProject(projectPath) ? policies : []),
  memory_policy_update: ({ filePath, oldText, newText }): null => {
    const row = policies.find(
      (policy) => policy.file_path === String(filePath) && policy.value === String(oldText),
    );
    if (!row) throw new Error("original text not found in file");
    // The real command rewrites that span of the file, so CLAUDE.md and the
    // git panel show the edit too.
    const rel = row.file_path.slice(PROJECT.path.length + 1);
    const text = northwindFileText(rel);
    if (text?.includes(String(oldText))) {
      northwindWriteFile(rel, text.replace(String(oldText), String(newText)));
    }
    row.value = String(newText);
    return null;
  },
  memory_sharing_get: (): boolean => sharing,
  memory_sharing_set: ({ enabled }): null => {
    sharing = Boolean(enabled);
    return null;
  },
  memory_from_external_sessions_get: (): boolean => fromExternalSessions,
  memory_from_external_sessions_set: ({ enabled }): null => {
    fromExternalSessions = Boolean(enabled);
    return null;
  },
  memory_summarizer_get: (): SummarizerPref => ({ mode: "raw", provider: "", model: "" }),
  memory_get_state: ({ projectPath }): SharedState =>
    isProject(projectPath)
      ? sharedState()
      : {
          lastSeq: 0,
          activePlan: null,
          decisions: [],
          recentChanges: [],
          facts: [],
          failures: [],
          architecture: [],
          sessionAgents: {},
          updatedAt: 0,
        },
  memory_list_events: ({ projectPath }): MemoryEvent[] =>
    isProject(projectPath) ? events().reverse() : [],
  memory_query: ({ projectPath, query, limit }): MemoryEvent[] => {
    const needle = String(query ?? "")
      .trim()
      .toLowerCase();
    if (!needle || !isProject(projectPath)) return [];
    return events()
      .filter((event) =>
        `${event.agent} ${event.kind} ${event.key} ${JSON.stringify(event.payload)}`
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, Number(limit ?? 20));
  },
  memory_list_entries: ({ projectPath }): MemoryEntry[] =>
    isProject(projectPath) ? entries() : [],
  memory_edit_entry: ({ id, content }): MemoryEntry => {
    const target = memory()[Number(id) - 1];
    if (!target || forgotten.has(target.id)) throw new Error(`no memory entry ${String(id)}`);
    entryEdits.set(target.id, { content: String(content), updatedAt: Date.now() });
    memoryChanged([ENTRY_KIND[target.kind]]);
    const edited = entries().find((entry) => entry.id === Number(id));
    if (!edited) throw new Error(`no memory entry ${String(id)}`);
    return edited;
  },
  memory_forget_entry: ({ id }): boolean => {
    const target = memory()[Number(id) - 1];
    if (!target || forgotten.has(target.id)) return false;
    forgotten.add(target.id);
    memoryChanged([ENTRY_KIND[target.kind]]);
    return true;
  },
  memory_claude_import_preview: (): ClaudeImportPreview => ({
    sources: [`${HOME}/.claude/projects/${PROJECT.path.replace(/\//g, "-")}/memory`],
    alreadyImported: true,
    lines: [],
  }),
  memory_claude_import_confirm: (): number => 0,

  // ── skills ─────────────────────────────────────────────────────────────
  skills_list: ({ scope }): SkillMeta[] =>
    skills.filter((skill) => skill.scope === asScope(scope)).map(skillMeta),
  skills_read: ({ scope, name }): SkillContent => {
    const skill = findSkill(asScope(scope), String(name));
    return {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      raw: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`,
    };
  },
  skills_path: ({ scope, name }): string => skillPath(findSkill(asScope(scope), String(name))),
  skills_project: ({ scope, name, tool }): null => setDelivered(scope, name, tool, true),
  skills_unproject: ({ scope, name, tool }): null => setDelivered(scope, name, tool, false),
  skills_set_enabled: ({ scope, name, agent, enabled }): null =>
    setDelivered(scope, name, agent, Boolean(enabled)),
  skills_adopt: ({ scope, name }): SkillMeta => skillMeta(findSkill(asScope(scope), String(name))),
  skills_promote: ({ name }): SkillMeta => {
    const skill = findSkill("project", String(name));
    skill.scope = "global";
    return skillMeta(skill);
  },
  skills_freeze: (): null => null,
  skills_delete: ({ scope, name }): null => {
    const s = asScope(scope);
    skills = skills.filter((skill) => !(skill.scope === s && skill.name === String(name)));
    return null;
  },
  skills_reconcile: ({ scope }): ReconcileView => ({
    tools: TOOLS,
    skills: skills
      .filter((skill) => skill.scope === asScope(scope))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        managed: true,
        pack: null,
        cells: cellsOf(skill),
      })),
  }),
  tools_list: ({ scope }): AgentTarget[] => targets(asScope(scope)),
  agents_list_skill_targets: ({ scope }): AgentTarget[] => targets(asScope(scope)),
  pack_list: (): InstalledPack[] => [],
  pack_components_list: (): PackComponentMeta[] => [],
  pack_search: ({ query }): PackSearchHit[] => {
    const q = String(query ?? "")
      .trim()
      .toLowerCase();
    if (!q) throw new Error("query must not be empty");
    const words: Record<string, string[]> = {
      agent: ["agents-md", "skill-creator", "requesting-code-review"],
      design: ["frontend-design", "web-design-guidelines", "postgres-database-design"],
      database: ["postgres-database-design"],
      python: ["python-uv-projects"],
      review: ["requesting-code-review"],
    };
    return SEARCH_INDEX.filter(
      (hit) =>
        hit.name.includes(q) || hit.source.includes(q) || (words[q] ?? []).includes(hit.skillId),
    );
  },
  pack_remote_preview: ({ source }): Pack => previewOf(String(source)),
  pack_install_skill: ({ scope, skillId }): SkillMeta => {
    const s = asScope(scope);
    const id = String(skillId);
    const existing = skills.find((skill) => skill.scope === s && skill.name === id);
    if (existing) return skillMeta(existing);
    const added: NwSkill = {
      name: id,
      description: id.replace(/-/g, " "),
      scope: s,
      tools: [],
      body: `# ${id}\n`,
    };
    skills = [...skills, added];
    return skillMeta(added);
  },

  // ── settings ───────────────────────────────────────────────────────────
  cli_status: (): CliStatus => CLI,
  cli_install_helper: (): CliStatus => CLI,
  byok_env_list: (): EnvKeyMeta[] =>
    envEntries.map(({ provider, envVar, last4 }) => ({ provider, envVar, last4 })),
  byok_env_entries: (): EnvEntry[] => envEntries.map((entry) => ({ ...entry })),
  byok_profile_info: (): ProfileInfo => ({
    shell: "zsh",
    target: ZSHRC,
    scanned: [
      { path: ZSHRC, exists: true },
      { path: `${HOME}/.zprofile`, exists: true },
      { path: `${HOME}/.zshenv`, exists: false },
    ],
  }),
  byok_env_reveal: ({ envVar }): string | null => secrets.get(String(envVar)) ?? null,
  byok_env_set: ({ envVar, value }): string => {
    const name = String(envVar);
    const secret = String(value);
    if (!secret.trim()) throw new Error("a key cannot be empty");
    secrets.set(name, secret);
    const existing = envEntries.find((entry) => entry.envVar === name);
    if (existing) existing.last4 = secret.slice(-4);
    else {
      envEntries = [
        ...envEntries,
        {
          provider: name.replace(/_?API_?KEY$/i, "").toLowerCase() || "custom",
          envVar: name,
          last4: secret.slice(-4),
          file: ZSHRC,
          line: 14 + envEntries.length,
          editable: true,
        },
      ];
    }
    return ZSHRC;
  },
  byok_env_unset: ({ envVar }): null => {
    envEntries = envEntries.filter((entry) => entry.envVar !== String(envVar));
    secrets.delete(String(envVar));
    return null;
  },
};

// ── Untyped overrides (base.ts boot commands, fixtures/misc.ts) ───────────

export const northwindMiscRawCommands: MockHandlers = {
  // ── boot ────────────────────────────────────────────────────────────────
  bootstrap_app_state: (): AppStateWire => appState(),
  "plugin:app|version": (): string => VERSION,
  update_state: (): UpdaterSnapshot => ({ phase: "idle", version: null, currentVersion: VERSION }),
  update_check_now: (): UpdateStatus => ({
    available: false,
    version: null,
    currentVersion: VERSION,
  }),
  codebase_index_status: ({ projectPath }) =>
    isProject(projectPath)
      ? { indexed: true, fileCount: 24, summaryCount: 19, builtAtMs: LOAD - 3 * HOUR }
      : { indexed: false, fileCount: 0, summaryCount: 0, builtAtMs: 0 },
  load_project_session: (): string => "{}",
  load_editor_state: (): string => "{}",

  // ── chat history ────────────────────────────────────────────────────────
  threads_history: ({ archivedOnly }): ThreadRow[] =>
    threads.filter((thread) => (archivedOnly ? thread.archived : !thread.archived)),
  threads_projects: ({ cwd }): ThreadProject[] =>
    threadProjects(cwd === null || cwd === undefined ? null : String(cwd)),
  threads_resume: ({ threadId }): ResumedThread => {
    const thread = threads.find((candidate) => candidate.threadId === String(threadId));
    if (!thread) throw new Error(`no such thread: ${String(threadId)}`);
    const key = { agent_id: thread.agentId, session_id: thread.sessionId ?? thread.threadId };
    // Loaded with its recorded transcript, the way the agent replays it.
    adoptSession(
      key,
      thread.agentId,
      thread.folderPaths[0] ?? "",
      thread.sessionId ? transcriptOf(thread.sessionId) : [],
    );
    return {
      key,
      resumedWithoutHistory: false,
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
  threads_import_candidates: (): ImportCandidate[] => [
    {
      pluginId: "claude-acp",
      displayName: "Claude Code",
      status: { kind: "ready", importable: 0 },
    },
  ],
  threads_import: (): number => 0,
  agent_transcripts_list: (): AtlasTranscriptMeta[] =>
    threads
      .filter((thread) => thread.sessionId !== null)
      .map((thread) => {
        const s = mySessions().find((candidate) => candidate.content.id === thread.sessionId);
        const t = s?.content.tokens;
        return {
          id: thread.sessionId ?? thread.threadId,
          file_path: `${HOME}/.config/atlas/agent-transcripts/${thread.sessionId}.jsonl`,
          started_at: thread.createdAt,
          last_modified: thread.updatedAt,
          message_count: transcript(thread.sessionId ?? "").length,
          preview: thread.title,
          total_tokens: t ? t.input + t.output : 0,
          plugin_id: thread.agentId,
        };
      }),
  agent_transcripts_read: ({ sessionId }): AtlasTranscriptMessage[] =>
    transcript(String(sessionId)),

  // ── plans ───────────────────────────────────────────────────────────────
  plans_load: (): PlanRecord[] => plans,
  plans_append: ({ record }): null => {
    plans = [record as PlanRecord, ...plans];
    return null;
  },

  // ── the Atlas Agent ─────────────────────────────────────────────────────
  // Northwind is a synced org with AI access: no grant bar over the composer.
  native_agent_entitlement: (): Entitlement => ({
    state: "entitled",
    models: NATIVE_MODELS.map((model) => model.id),
  }),
  native_agent_refresh_models: (): NativeModelsRefresh => ({
    models: NATIVE_MODELS,
    defaultModel: NATIVE_MODELS[0]!.id,
    changed: false,
    reconnected: false,
  }),
  agents_list_auth_methods: (): AuthMethodWire[] => [
    {
      id: "claude-login",
      name: "Log in with your Claude account",
      description: "Opens a browser window and stores the token in the keychain.",
      kind: "terminal",
      link: null,
      terminalCommand: "claude",
      terminalArgs: ["setup-token"],
      terminalLabel: "Run in a terminal",
      apiKeyProvider: null,
    },
  ],
  agents_auth_env_status: (): AuthEnvStatus[] => [],
};

/**
 * Run from the scenario's `init`. Settings → Skills → Discover caches its
 * "Popular" list in localStorage across reloads; a cache written while another
 * scenario was loaded would show that scenario's repos on camera.
 */
export function northwindMiscInit(): void {
  try {
    localStorage.removeItem("atlas:skills:popular:v1");
  } catch {
    // Storage blocked: Discover simply re-runs its searches.
  }
}
