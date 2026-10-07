// The Timeline board (the Artifacts tab), one Session's timeline, and the
// grounded Session-Chat beside it.
//
// `artifacts_board` is the one unanswered command that takes the whole app
// down: the panel signature-compares the result before storing it, so a `null`
// throws on `.length` before a single row renders. Everything else here is what
// makes the tab worth opening once it does.
//
// Rows are DERIVED from the timelines rather than written beside them. A row
// saying "12 tool calls" opens a detail that has to agree, so the counts, the
// branch list and the diffstat are folded out of the entries; only what an
// entry cannot carry — token spend, context occupancy, the attention flag —
// is seeded per Session.
//
// Dates are relative to the day the dev server runs rather than fixed. The
// board groups by day / week / month and labels the newest bucket "Today", so a
// hard-coded month would leave all three grain controls pointing at one stale
// group. The one Session that is still running has its `updatedAt` stamped at
// read time for the same reason: liveness is a 90-second window, and a fixture
// written at import time stops being live a minute and a half into the session.

import { emit } from "@tauri-apps/api/event";

import type {
  ArtifactPayload,
  BoardCheckpoint,
  BoardSession,
  EntryCounts,
  SessionDetail,
  SessionSummary,
  TimelineEntry,
  ToolTally,
  BoardPage,
} from "@/features/artifacts/types";
import type { Comment, CommentThreads } from "@/features/artifacts/lib/comments-api";
import type { CommentTarget } from "@/features/chat/components/chat-comments-controller";
import type {
  RetrieveResult,
  SessionChatThreadWire,
  SourceRef,
  ThreadMeta,
} from "@/features/artifacts/lib/session-chat-api";
import type { save } from "@tauri-apps/plugin-dialog";
import type { modelchat, ModelChatEvent } from "@/lib/byok/byok-chat";
import type { Project } from "@/features/projects/stores/project-store";
import type { TypedHandlers, Unit } from "../types";
import { abs, ALL_PROJECTS, MOCK_PROJECT } from "../project";

const [APP, PLATFORM, DOCS] = ALL_PROJECTS;

/** Local-clock ISO stamp, `daysAgo` back at a given hour — the board groups on
 *  local midnight, so a UTC-built date would land yesterday for half the world. */
function at(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** `minutes` after `iso` — how an entry is placed inside its Session. */
function after(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

// ── seeds ─────────────────────────────────────────────────────────────────

/** The token half of a summary, which no entry carries. */
type Spend = Pick<
  SessionSummary,
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "cacheCreationTokens"
  | "cacheReadTokens"
  | "contextUsed"
  | "contextSize"
>;

/** The native agent's shape: a real input/output split, cache beside it. */
function split(input: number, output: number, cacheWrite: number, cacheRead: number): Spend {
  return {
    totalTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    contextUsed: null,
    contextSize: null,
  };
}

/** Every ACP agent's shape: occupancy only, so `tokenLabel` renders a gauge. */
function context(used: number, size: number): Spend {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: used,
    contextSize: size,
  };
}

/** A Session that spent only cache — `tokenLabel`'s last branch. */
function cachedOnly(read: number): Spend {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: read,
    contextUsed: null,
    contextSize: null,
  };
}

interface Seed {
  id: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  /** `acp`, `native` or `external_jsonl` — drives the row's state glyph. */
  source: string;
  project: Project;
  startedAt: string;
  lastActivityAt: string;
  activeSeconds: number;
  wallSeconds: number;
  spend: Spend;
  /** The branch the Session started on; Checkpoint branches are added by the fold. */
  branch: string | null;
  /** Set on a Session whose record has a hole — the row says so in red. */
  attention?: string;
}

/** The Session still being written. Its `updatedAt` is stamped at read time. */
const LIVE_ID = "sess-8f21ac";

/**
 * The states the board has to survive, one Session each: running, errored,
 * cancelled, imported, untitled, silent, and a spread of days deep enough that
 * day / week / month each group differently.
 */
const SEEDS: Seed[] = [
  {
    id: LIVE_ID,
    title: "Move the user reads onto /v2 and keep the retry helper honest",
    agent: "claude-code",
    model: "claude-opus-4",
    source: "acp",
    project: APP,
    startedAt: at(0, 9, 12),
    lastActivityAt: at(0, 11, 48),
    activeSeconds: 4_180,
    wallSeconds: 9_360,
    spend: context(853_100, 1_000_000),
    branch: "feature/auth-v2",
  },
  {
    // The failure the attention banner exists for: rows the capture worker
    // could not write, so the timeline below is knowingly incomplete.
    id: "sess-a19c40",
    title: "Regenerate the dark-mode ramp from the shadcn base tokens",
    agent: "codex",
    model: "gpt-5",
    source: "acp",
    project: APP,
    startedAt: at(0, 8, 5),
    lastActivityAt: at(0, 8, 51),
    activeSeconds: 1_640,
    wallSeconds: 2_760,
    spend: context(412_880, 400_000),
    branch: "main",
    attention: "4 tool results could not be recorded — the store was locked by another window",
  },
  {
    // A title long enough to prove the nav truncates rather than reflows, and
    // that the detail header wraps it instead of pushing the stats strip off.
    id: "sess-77b0e2",
    title:
      "Walk every place the pricing table is read, explain why the General tab crashes when models_pricing_get answers with nothing at all, and propose the smallest guard that keeps the empty state honest rather than papering over it",
    agent: "atlas-agent",
    model: "claude-sonnet-4",
    source: "atlas-agent",
    project: APP,
    startedAt: at(1, 16, 20),
    lastActivityAt: at(1, 18, 4),
    activeSeconds: 3_020,
    wallSeconds: 6_240,
    spend: split(184_220, 21_940, 64_480, 1_204_600),
    branch: "main",
  },
  {
    // Cancelled mid-turn: the last tool call never got a result, which is a
    // different shape from a failure and reads differently in the timeline.
    id: "sess-3c91d8",
    title: "Port the PDF highlight rects onto the rotated canvas",
    agent: "claude-code",
    model: "claude-opus-4",
    source: "acp",
    project: APP,
    startedAt: at(1, 11, 2),
    lastActivityAt: at(1, 11, 9),
    activeSeconds: 42,
    wallSeconds: 420,
    spend: context(38_400, 1_000_000),
    branch: "fix/pdf-annotations",
    attention: "Turn cancelled after 42s — one tool call has no recorded result",
  },
  {
    // Zero tool calls, zero Checkpoints: a question, an answer, nothing else.
    // The detail's filter rows and stats strip all have to render at zero.
    id: "sess-5de0b1",
    title: "What does codegen-units = 1 actually buy us here?",
    agent: "atlas-agent",
    model: "claude-sonnet-4",
    source: "atlas-agent",
    project: APP,
    startedAt: at(1, 9, 30),
    lastActivityAt: at(1, 9, 34),
    activeSeconds: 190,
    wallSeconds: 240,
    spend: split(9_120, 2_640, 0, 18_300),
    branch: "main",
  },
  {
    // Titled entirely from an injected memory block: `sessionTitle` strips it
    // to nothing, so every surface must fall back to "Untitled".
    id: "sess-0ab4f7",
    title:
      "--- RELEVANT PROJECT MEMORY ---\nThe pricing table is read in three places.\n--- END RELEVANT PROJECT MEMORY ---",
    agent: "claude-code",
    model: "claude-opus-4",
    source: "acp",
    project: APP,
    startedAt: at(2, 14, 10),
    lastActivityAt: at(2, 15, 2),
    activeSeconds: 2_240,
    wallSeconds: 3_120,
    spend: context(221_400, 1_000_000),
    branch: "main",
  },
  {
    // Imported from another program's transcript: written to the store minutes
    // ago, months old in fact — the reason `imported` outranks `live`.
    id: "sess-imported-9f",
    title: "Bisect the Metal kernel-compile panic on the embed loader",
    agent: "claude-code",
    model: "claude-opus-4",
    source: "external_jsonl",
    project: PLATFORM,
    startedAt: at(3, 10, 0),
    lastActivityAt: at(3, 12, 36),
    activeSeconds: 5_400,
    wallSeconds: 9_360,
    spend: cachedOnly(2_408_900),
    branch: "renovate/design-tokens-and-the-entire-colour-system-rewrite",
  },
  {
    id: "sess-b21c55",
    title: "Split the migration scripts per tenant and dry-run the first batch",
    agent: "opencode",
    model: "gemini-2.5-pro",
    source: "acp",
    project: PLATFORM,
    startedAt: at(4, 13, 25),
    lastActivityAt: at(4, 16, 41),
    activeSeconds: 7_820,
    wallSeconds: 11_760,
    spend: context(96_400, 200_000),
    branch: "main",
  },
  {
    // No agent and no model recorded — both facets have to tolerate a hole,
    // and the row still needs a glyph.
    id: "sess-6ef203",
    title: "Tidy the release checklist",
    agent: null,
    model: null,
    source: "external_jsonl",
    project: DOCS,
    startedAt: at(6, 10, 15),
    lastActivityAt: at(6, 10, 52),
    activeSeconds: 1_180,
    wallSeconds: 2_220,
    spend: cachedOnly(41_200),
    branch: null,
  },
  {
    id: "sess-c40918",
    title: "Rewrite the README layout table and the token rules under it",
    agent: "atlas-agent",
    model: "claude-sonnet-4",
    source: "atlas-agent",
    project: DOCS,
    startedAt: at(9, 9, 5),
    lastActivityAt: at(9, 10, 47),
    activeSeconds: 3_640,
    wallSeconds: 6_120,
    spend: split(72_400, 14_820, 21_000, 388_600),
    // `docs` is not a repository in the git fixture, so nothing here commits.
    branch: null,
  },
  {
    // Last month, so the month grain has a second bucket and "Week of …" and
    // the year-less date labels both get exercised.
    id: "sess-d7712a",
    title: "First pass at the checkpoint store schema",
    agent: "claude-code",
    model: "claude-opus-4",
    source: "acp",
    project: APP,
    startedAt: at(41, 15, 40),
    lastActivityAt: at(41, 19, 12),
    activeSeconds: 10_240,
    wallSeconds: 12_720,
    spend: context(640_200, 1_000_000),
    branch: "main",
  },
];

// ── spilled payloads ──────────────────────────────────────────────────────

/**
 * Bodies over 64 KB are sent as a preview plus a blob ref. One ref below is
 * deliberately absent from this map: a pruned blob store is a real state, and
 * the "Show full" button has to say so rather than spin.
 */
const BLOBS = new Map<string, ArtifactPayload>([
  [
    "blob-api-review",
    {
      text: [
        "Full review of src/lib/api.ts",
        "",
        ...Array.from(
          { length: 60 },
          (_, i) =>
            `${String(i + 1).padStart(3, " ")}. request() still swallows the body on a 5xx; withRetry only sees the status.`,
        ),
      ].join("\n"),
      binary: false,
      bytes: 94_310,
    },
  ],
  [
    "blob-cargo-log",
    {
      text: Array.from(
        { length: 120 },
        (_, i) => `   Compiling atlas-engine-core v0.1.0 (unit ${i + 1}/1161)`,
      ).join("\n"),
      binary: false,
      bytes: 132_880,
    },
  ],
  [
    // A screenshot the agent took: valid payload, unreadable as text.
    "blob-screenshot",
    { text: null, binary: true, bytes: 481_920 },
  ],
]);

// ── timelines ─────────────────────────────────────────────────────────────

type EntrySeed = Partial<TimelineEntry> & Pick<TimelineEntry, "id" | "kind" | "at">;

function entry(seed: EntrySeed): TimelineEntry {
  return {
    turnSeq: 0,
    text: null,
    truncated: false,
    bodyRef: null,
    toolName: null,
    toolTitle: null,
    toolStatus: null,
    paths: [],
    arguments: null,
    argumentsRef: null,
    result: null,
    resultRef: null,
    resultBinary: false,
    commitSha: null,
    commitSubject: null,
    branch: null,
    linkState: null,
    insertions: 0,
    deletions: 0,
    files: [],
    ...seed,
    // The store records the body's real size even when it ships a preview, so
    // a seed only states this when it differs from what it sent.
    bodyBytes: seed.bodyBytes ?? seed.text?.length ?? 0,
  };
}

/** The long one: every kind, every tool status, and long enough to scroll. */
function liveTimeline(seed: Seed): TimelineEntry[] {
  const t = (minutes: number) => after(seed.startedAt, minutes);
  const out: TimelineEntry[] = [
    entry({
      id: `${seed.id}-e01`,
      kind: "prompt",
      at: t(0),
      turnSeq: 1,
      // Carries an injected memory block, which the detail renders as its own
      // card rather than as part of what was asked.
      text: [
        "--- RELEVANT PROJECT MEMORY ---",
        "The API client was moved to /v2 in ACME-1184. `withRetry` was left as a TODO.",
        "Pagination defaults are page=0, size=50.",
        "--- END RELEVANT PROJECT MEMORY ---",
        "",
        "Move every user read onto /v2 and finish the retry helper. Keep the error type we already throw.",
      ].join("\n"),
    }),
    entry({
      id: `${seed.id}-e02`,
      kind: "thinking",
      at: t(1),
      turnSeq: 1,
      text: "The client has one request() choke point, so the retry belongs there rather than at each call site. Check what ApiError carries before wrapping it.",
    }),
    entry({
      id: `${seed.id}-e03`,
      kind: "tool_call",
      at: t(2),
      turnSeq: 1,
      toolName: "read_file",
      toolTitle: "Read src/lib/api.ts",
      toolStatus: "completed",
      paths: [abs("src/lib/api.ts")],
      arguments: JSON.stringify({ path: abs("src/lib/api.ts") }, null, 2),
      result: "export const api = { getUser, listUsers, updateUser, deleteUser } …",
    }),
    entry({
      id: `${seed.id}-e04`,
      kind: "tool_call",
      at: t(3),
      turnSeq: 1,
      toolName: "grep",
      toolTitle: "Search for listUsers(",
      toolStatus: "completed",
      arguments: JSON.stringify({ pattern: "listUsers\\(", path: abs("src") }, null, 2),
      result: "src/main.tsx:41\nsrc/components/user-table.tsx:88\nsrc/legacy/auth.ts:24",
    }),
    entry({
      id: `${seed.id}-e05`,
      kind: "response",
      at: t(5),
      turnSeq: 1,
      text: "Three call sites. `request()` is the only place a response is unwrapped, so the retry goes there and every caller inherits it.",
    }),
  ];

  // A run of ordinary edit/verify turns. The timeline is the one surface that
  // has to stay readable at length — a detail with six entries proves nothing
  // about the scroll, the sticky turn headers or the filter counts.
  const files = [
    "src/lib/api.ts",
    "src/lib/utils.ts",
    "src/components/user-table.tsx",
    "src/main.tsx",
    "src/styles/tokens.css",
  ];
  files.forEach((file, i) => {
    const base = 6 + i * 4;
    const n = (suffix: string) => `${seed.id}-e${String(base + 5).padStart(2, "0")}${suffix}`;
    out.push(
      entry({
        id: n("a"),
        kind: "tool_call",
        at: t(base),
        turnSeq: 2 + i,
        toolName: "edit_file",
        toolTitle: `Edit ${file}`,
        toolStatus: "completed",
        paths: [abs(file)],
        arguments: JSON.stringify({ path: abs(file), replacements: i + 1 }, null, 2),
        result: `Applied ${i + 1} replacement${i === 0 ? "" : "s"}.`,
        insertions: 12 + i * 9,
        deletions: 3 + i * 2,
        files: [file],
      }),
      entry({
        id: n("b"),
        kind: "tool_call",
        at: t(base + 1),
        turnSeq: 2 + i,
        toolName: "bash",
        toolTitle: "bun run typecheck",
        toolStatus: "completed",
        arguments: JSON.stringify({ command: "bun run typecheck" }, null, 2),
        result: "tsc --noEmit — no errors",
      }),
      entry({
        id: n("c"),
        kind: "response",
        at: t(base + 2),
        turnSeq: 2 + i,
        text: `\`${file}\` is on the new client. Moving on.`,
      }),
    );
  });

  out.push(
    entry({
      id: `${seed.id}-e30`,
      kind: "checkpoint",
      at: t(27),
      turnSeq: 7,
      commitSha: "4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0",
      commitSubject: "feat(api): move user reads onto /v2",
      branch: "feature/auth-v2",
      linkState: "linked",
      insertions: 96,
      deletions: 41,
      files: ["src/lib/api.ts", "src/lib/utils.ts", "src/components/user-table.tsx"],
    }),
    entry({
      id: `${seed.id}-e31`,
      kind: "tool_call",
      at: t(31),
      turnSeq: 8,
      toolName: "bash",
      toolTitle: "cargo check --workspace",
      toolStatus: "failed",
      arguments: JSON.stringify({ command: "cargo check --workspace" }, null, 2),
      result:
        "error[E0308]: mismatched types\n  --> src-tauri/src/commands/capture.rs:1551:9\n   |\n   = note: expected `Vec<BoardSession>`, found `Option<_>`",
      resultRef: "blob-cargo-log",
    }),
    entry({
      id: `${seed.id}-e32`,
      kind: "response",
      at: t(33),
      turnSeq: 8,
      // Over the inline cap: a preview plus a blob ref, which is what "Show
      // full" is for.
      text: "Here is the whole review of the client, file by file — the short version is that `request()` still swallows the response body on a 5xx, so `withRetry` only ever sees the status code…",
      truncated: true,
      bodyBytes: 94_310,
      bodyRef: "blob-api-review",
    }),
    entry({
      id: `${seed.id}-e33`,
      kind: "tool_call",
      at: t(35),
      turnSeq: 9,
      toolName: "screenshot",
      toolTitle: "Capture the admin table",
      toolStatus: "completed",
      result: null,
      resultRef: "blob-screenshot",
      resultBinary: true,
    }),
    entry({
      id: `${seed.id}-e34`,
      kind: "checkpoint",
      at: t(38),
      turnSeq: 9,
      commitSha: "c0ffee11223344556677889900aabbccddeeff01",
      // Squashed away after the fact: the Checkpoint survives, the commit does
      // not, and the row has to read as a state rather than an error.
      commitSubject: null,
      branch: "feature/auth-v2",
      linkState: "orphaned",
      insertions: 31,
      deletions: 8,
      files: ["src/lib/api.ts"],
    }),
    entry({
      id: `${seed.id}-e35`,
      kind: "prompt",
      at: t(40),
      turnSeq: 10,
      text: "Now add the backoff jitter and re-run the suite.",
    }),
    entry({
      id: `${seed.id}-e36`,
      kind: "tool_call",
      at: t(41),
      turnSeq: 10,
      toolName: "bash",
      toolTitle: "bun run test",
      // Still going: the one entry that proves the running state renders.
      toolStatus: "running",
      arguments: JSON.stringify({ command: "bun run test" }, null, 2),
    }),
  );
  return out;
}

/** Prompt, answer, nothing else — the Session with no tools and no commits. */
function quietTimeline(seed: Seed): TimelineEntry[] {
  return [
    entry({
      id: `${seed.id}-e01`,
      kind: "prompt",
      at: seed.startedAt,
      turnSeq: 1,
      text: "What does codegen-units = 1 actually buy us here?",
    }),
    entry({
      id: `${seed.id}-e02`,
      kind: "response",
      at: after(seed.startedAt, 3),
      turnSeq: 1,
      text: "About 74 MB of binary, at roughly 50 s per one-file touch. Raising it is the trade, not a free win.",
    }),
  ];
}

/** Cancelled mid-turn: a tool call that never reported back. */
function cancelledTimeline(seed: Seed): TimelineEntry[] {
  const t = (minutes: number) => after(seed.startedAt, minutes);
  return [
    entry({
      id: `${seed.id}-e01`,
      kind: "prompt",
      at: t(0),
      turnSeq: 1,
      text: "Keep the highlight rects aligned when the page rotates.",
    }),
    entry({
      id: `${seed.id}-e02`,
      kind: "tool_call",
      at: t(1),
      turnSeq: 1,
      toolName: "read_file",
      toolTitle: "Read src/features/pdf/lib/rects.ts",
      toolStatus: "completed",
      paths: [abs("src/features/pdf/lib/rects.ts")],
      result: "export function rotate(rect: Rect, deg: number): Rect { … }",
    }),
    entry({
      id: `${seed.id}-e03`,
      kind: "tool_call",
      at: t(2),
      turnSeq: 1,
      toolName: "edit_file",
      toolTitle: "Edit src/features/pdf/lib/rects.ts",
      // Neither completed nor failed: the turn was cancelled underneath it.
      toolStatus: "pending",
      paths: [abs("src/features/pdf/lib/rects.ts")],
      arguments: JSON.stringify({ path: abs("src/features/pdf/lib/rects.ts") }, null, 2),
      // The blob this points at is gone — a pruned store, and the reason the
      // "Show full" failure copy exists.
      bodyRef: "blob-pruned-by-vacuum",
      truncated: true,
      bodyBytes: 71_200,
      text: "Rewriting rotate() to carry the page's rotation rather than assuming zero…",
    }),
  ];
}

/** The shape most Sessions have: a turn or two, a few tools, one Checkpoint. */
function standardTimeline(seed: Seed, index: number): TimelineEntry[] {
  const t = (minutes: number) => after(seed.startedAt, minutes);
  const file = ["src/lib/api.ts", "src/styles/tokens.css", "README.md", "src/main.tsx"][index % 4];
  const out: TimelineEntry[] = [
    entry({
      id: `${seed.id}-e01`,
      kind: "prompt",
      at: t(0),
      turnSeq: 1,
      text: seed.title ?? "Pick this back up where it stopped.",
    }),
    entry({
      id: `${seed.id}-e02`,
      kind: "thinking",
      at: t(1),
      turnSeq: 1,
      text: `Start from ${file} — it is the only place the change has to be true.`,
    }),
    entry({
      id: `${seed.id}-e03`,
      kind: "tool_call",
      at: t(2),
      turnSeq: 1,
      toolName: "read_file",
      toolTitle: `Read ${file}`,
      toolStatus: "completed",
      paths: [abs(file)],
      arguments: JSON.stringify({ path: abs(file) }, null, 2),
      result: "…",
    }),
    entry({
      id: `${seed.id}-e04`,
      kind: "tool_call",
      at: t(4),
      turnSeq: 1,
      toolName: "edit_file",
      toolTitle: `Edit ${file}`,
      // Every second Session carries a failure, so the red state is never more
      // than a row or two away on the board.
      toolStatus: index % 2 === 0 ? "completed" : "failed",
      paths: [abs(file)],
      arguments: JSON.stringify({ path: abs(file), replacements: 2 }, null, 2),
      result: index % 2 === 0 ? "Applied 2 replacements." : "no such file or directory",
      insertions: index % 2 === 0 ? 18 : 0,
      deletions: index % 2 === 0 ? 6 : 0,
      files: index % 2 === 0 ? [file] : [],
    }),
    entry({
      id: `${seed.id}-e05`,
      kind: "response",
      at: t(6),
      turnSeq: 1,
      text: `Done in \`${file}\`. Want me to take the same pass through the tests?`,
    }),
  ];
  // No branch means no repository — `docs` is a plain folder in the git
  // fixture, and a Checkpoint there would be a commit that cannot exist.
  if (seed.attention === undefined && seed.branch) {
    out.push(
      entry({
        id: `${seed.id}-e06`,
        kind: "checkpoint",
        at: t(8),
        turnSeq: 2,
        commitSha: `${index}a7c${seed.id.replace(/[^0-9a-f]/g, "")}0000000000000000000000000`.slice(
          0,
          40,
        ),
        commitSubject: `chore: ${seed.title?.slice(0, 48).toLowerCase() ?? "checkpoint"}`,
        branch: seed.branch ?? "main",
        linkState: "linked",
        insertions: 18 + index * 4,
        deletions: 6 + index,
        files: [file],
      }),
    );
  }
  return out;
}

const TIMELINES = new Map<string, TimelineEntry[]>(
  SEEDS.map((seed, index) => {
    if (seed.id === LIVE_ID) return [seed.id, liveTimeline(seed)];
    if (seed.id === "sess-5de0b1") return [seed.id, quietTimeline(seed)];
    if (seed.id === "sess-3c91d8") return [seed.id, cancelledTimeline(seed)];
    return [seed.id, standardTimeline(seed, index)];
  }),
);

// ── folds ─────────────────────────────────────────────────────────────────

function countsOf(entries: TimelineEntry[]): EntryCounts {
  return {
    prompts: entries.filter((e) => e.kind === "prompt").length,
    responses: entries.filter((e) => e.kind === "response").length,
    thinking: entries.filter((e) => e.kind === "thinking").length,
    toolCalls: entries.filter((e) => e.kind === "tool_call").length,
    checkpoints: entries.filter((e) => e.kind === "checkpoint").length,
  };
}

function toolsOf(entries: TimelineEntry[]): ToolTally[] {
  const tally = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== "tool_call") continue;
    const name = e.toolName ?? "Other";
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([toolName, count]) => ({ toolName, count }));
}

/**
 * The row, folded out of the timeline it opens.
 *
 * Only the live Session's `updatedAt` is computed rather than seeded: the board
 * infers liveness from a 90-second window, so it has to be stamped now.
 */
function summaryOf(seed: Seed): SessionSummary {
  const entries = TIMELINES.get(seed.id) ?? [];
  const counts = countsOf(entries);
  const branches = [seed.branch, ...entries.map((e) => e.branch)].filter(
    (branch): branch is string => Boolean(branch),
  );
  const files = new Set(entries.flatMap((e) => e.files));
  return {
    id: seed.id,
    title: seed.title,
    agent: seed.agent,
    model: seed.model,
    source: seed.source,
    startedAt: seed.startedAt,
    updatedAt: seed.id === LIVE_ID ? new Date().toISOString() : seed.lastActivityAt,
    lastActivityAt: seed.lastActivityAt,
    activeSeconds: seed.activeSeconds,
    wallSeconds: seed.wallSeconds,
    messageCount: counts.prompts + counts.responses,
    toolCallCount: counts.toolCalls,
    checkpointCount: counts.checkpoints,
    branches: [...new Set(branches)],
    insertions: entries.reduce((sum, e) => sum + e.insertions, 0),
    deletions: entries.reduce((sum, e) => sum + e.deletions, 0),
    filesTouched: files.size,
    ...seed.spend,
    needsAttention: seed.attention !== undefined,
    attentionReason: seed.attention ?? null,
  };
}

/**
 * Which Projects are bound to Cloud.
 *
 * `APP` is synced and the other two are not, so the board shows both second-line
 * states side by side rather than one of them theoretically.
 */
const SYNCED_PROJECTS = new Map<string, string>([[APP.path, "rw_1d55e903"]]);

function boardRow(seed: Seed): BoardSession {
  const remoteProjectId = SYNCED_PROJECTS.get(seed.project.path) ?? null;
  return {
    ...summaryOf(seed),
    projectPath: seed.project.path,
    projectName: seed.project.name,
    synced: remoteProjectId !== null,
    // Own work in a synced Project is on both sides; the real command decides
    // this by looking the Session id up in the cloud cache.
    origin: remoteProjectId !== null ? "both" : "local",
    remoteProjectId,
    authorId: null,
  };
}

/**
 * Teammates' Sessions, which exist only on the server.
 *
 * No `projectPath`: this machine has no checkout to read them from, which is
 * the case the detail pane has to route over the network for. Each carries an
 * `authorId` — a roster `userId` from `integrations.ts`, so the row shows a
 * name and a face — because that is the one thing a remote row says that a
 * local one does not. Two sit in `acme-app`'s Workspace beside your own rows;
 * one is in another Project the Organisation shares.
 */
const TEAMMATE_ROWS: {
  base: number;
  id: string;
  title: string;
  projectName: string;
  remoteProjectId: string;
  authorId: string;
}[] = [
  {
    base: 1,
    id: "ses_teammate_01",
    title: "Rework the billing webhook retries",
    // The name the Organisation gave the Project, which is what both the web
    // board and the desktop row now show — not the slug, and never the id.
    projectName: "Acme Infra (platform)",
    remoteProjectId: "rw_8c41f20b",
    authorId: "usr_tobi",
  },
  {
    base: 6,
    id: "ses_teammate_02",
    title: "Split the invoice PDF renderer out of the API worker",
    projectName: "acme-app",
    remoteProjectId: "rw_1d55e903",
    authorId: "usr_sam",
  },
  {
    base: 7,
    id: "ses_teammate_03",
    title: "Audit the feature flags still reading the v1 config",
    projectName: "acme-app",
    remoteProjectId: "rw_1d55e903",
    authorId: "usr_priya",
  },
];

function teammateBoardRows(): BoardSession[] {
  return TEAMMATE_ROWS.map((row) => ({
    ...summaryOf(SEEDS[row.base]),
    id: row.id,
    title: row.title,
    projectPath: "",
    projectName: row.projectName,
    synced: true,
    origin: "remote",
    remoteProjectId: row.remoteProjectId,
    authorId: row.authorId,
    needsAttention: false,
    attentionReason: null,
  }));
}

function detailOf(seed: Seed): SessionDetail {
  const entries = TIMELINES.get(seed.id) ?? [];
  return { summary: summaryOf(seed), entries, counts: countsOf(entries), tools: toolsOf(entries) };
}

function seedFor(projectPath: string, sessionId: string): Seed | undefined {
  return SEEDS.find((seed) => seed.id === sessionId && seed.project.path === projectPath);
}

/** Every Checkpoint on the board, newest first — the picker's whole content. */
function checkpoints(projects: string[]): BoardCheckpoint[] {
  const out: BoardCheckpoint[] = [];
  for (const seed of SEEDS) {
    if (!projects.includes(seed.project.path)) continue;
    for (const e of TIMELINES.get(seed.id) ?? []) {
      if (e.kind !== "checkpoint" || !e.commitSha) continue;
      out.push({
        sessionId: seed.id,
        sessionTitle: seed.title,
        commitSha: e.commitSha,
        commitSubject: e.commitSubject,
        branch: e.branch,
        linkState: e.linkState ?? "linked",
        insertions: e.insertions,
        deletions: e.deletions,
        files: e.files.length,
        at: e.at,
        projectPath: seed.project.path,
        projectName: seed.project.name,
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ── Session-Chat ──────────────────────────────────────────────────────────

/** Threads per Session id, mutated by save/delete so the picker reacts. */
const threads = new Map<string, SessionChatThreadWire[]>([
  [
    LIVE_ID,
    [
      {
        id: "chat-9a41",
        title: "Why did the typecheck fail on capture.rs?",
        agentSessionId: LIVE_ID,
        projectPath: APP.path,
        provider: "anthropic",
        model: "claude-opus-4",
        checkpointScope: null,
        createdAt: at(0, 10, 2),
        updatedAt: at(0, 10, 9),
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Why did the typecheck fail on capture.rs?",
            timestamp: at(0, 10, 2),
          },
          {
            id: "msg-2",
            role: "assistant",
            content:
              "`artifacts_board` returns `Result<Vec<BoardSession>, String>`, but the branch added at 1551 answers with the `Option` from `open_reader`. The `cargo check` in this session shows the same span.",
            timestamp: at(0, 10, 3),
            sources: [
              {
                kind: "tool_call",
                label: "cargo check --workspace",
                entryId: `${LIVE_ID}-e31`,
                commitSha: null,
              },
            ],
          },
        ],
      },
      {
        // Scoped to one Checkpoint: reopening it must stay scoped.
        id: "chat-2b70",
        title: "Review the /v2 commit like a PR",
        agentSessionId: LIVE_ID,
        projectPath: APP.path,
        provider: "anthropic",
        model: "claude-opus-4",
        checkpointScope: ["4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0"],
        createdAt: at(0, 11, 12),
        updatedAt: at(0, 11, 20),
        messages: [],
      },
    ],
  ],
]);

/** The grounded answer the fake provider streams back. */
const ANSWER = [
  "Three things happened in this session, in order.",
  "",
  "1. Every user read moved onto the `/v2` client — `request()` is the only",
  "   place a response is unwrapped, so the retry lives there and the four call",
  "   sites inherit it.",
  "2. The first Checkpoint (`4f21a90`) carries that work: 96 insertions across",
  "   three files.",
  "3. `cargo check --workspace` then failed on the board command:",
  "",
  "```rust",
  "// src-tauri/src/commands/capture.rs:1551",
  "pub async fn artifacts_board(projects: Vec<String>) -> Result<Vec<BoardSession>, String> {",
  "    // the new early-return answers with open_reader()'s Option",
  "}",
  "```",
  "",
  "The second Checkpoint is orphaned — its commit was squashed away afterwards,",
  "so the record kept the Checkpoint and dropped the link rather than attaching",
  "to the wrong commit.",
].join("\n");

/** Streams cancelled from the UI, so `modelchat_cancel` can stop one mid-flight. */
const cancelled = new Set<string>();

function streamAnswer(streamId: string): void {
  const chunks = ANSWER.match(/\S+\s*/g) ?? [];
  let sent = 0;
  const step = () => {
    if (cancelled.has(streamId)) {
      cancelled.delete(streamId);
      void emit("atlas:modelchat", { stream_id: streamId, kind: "done" } satisfies ModelChatEvent);
      return;
    }
    if (sent >= chunks.length) {
      void emit("atlas:modelchat", {
        stream_id: streamId,
        kind: "usage",
        input_tokens: 4_820,
        output_tokens: chunks.length * 2,
      } satisfies ModelChatEvent);
      void emit("atlas:modelchat", { stream_id: streamId, kind: "done" } satisfies ModelChatEvent);
      return;
    }
    void emit("atlas:modelchat", {
      stream_id: streamId,
      kind: "text_delta",
      delta: chunks[sent++],
    } satisfies ModelChatEvent);
    // Slow enough to read as streaming, fast enough not to be a wait.
    setTimeout(step, 16);
  };
  setTimeout(step, 140);
}

/** Model ids per provider, matching the ids the pricing fake prices. */
const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4", "claude-3-5-haiku"],
  openai: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "o3", "gpt-4.1"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  groq: ["llama-3.3-70b-versatile"],
  openrouter: ["anthropic/claude-opus-4", "openai/gpt-5", "google/gemini-2.5-pro"],
};

/** What the retriever would have cited, drawn from the Session's own entries. */
function sourcesFor(detail: SessionDetail, scope: string[]): SourceRef[] {
  const entries = detail.entries.filter((e) => {
    if (scope.length === 0) return true;
    return e.kind !== "checkpoint" || (e.commitSha !== null && scope.includes(e.commitSha));
  });
  const out: SourceRef[] = [];
  for (const e of entries) {
    if (out.length >= 6) break;
    if (e.kind === "checkpoint" && e.commitSha) {
      out.push({
        kind: "checkpoint",
        label: e.commitSubject ?? e.commitSha.slice(0, 7),
        entryId: e.id,
        commitSha: e.commitSha,
      });
    } else if (e.kind === "tool_call" && e.toolName) {
      out.push({
        kind: "tool_call",
        label: e.toolTitle ?? e.toolName,
        entryId: e.id,
        commitSha: null,
      });
    } else if (e.kind === "prompt" && e.text) {
      out.push({ kind: "prompt", label: e.text.slice(0, 60), entryId: e.id, commitSha: null });
    }
  }
  return out;
}

// ── handlers ──────────────────────────────────────────────────────────────

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface ArtifactsResponses {
  artifacts_board: BoardPage;
  artifacts_session: SessionDetail | null;
  artifacts_cloud_retarget: Unit;
  artifacts_cloud_follow: Unit;
  artifacts_cloud_unfollow: Unit;
  /** The live chat's cloud identity; `null` = not a shared session. */
  chat_comment_target: CommentTarget | null;
  artifacts_cloud_refresh: boolean;
  artifacts_cloud_session: SessionDetail;
  artifacts_cloud_payload: ArtifactPayload;
  artifacts_cloud_session_url: string | null;
  artifacts_cloud_comments: CommentThreads;
  artifacts_cloud_comment_create: Comment;
  artifacts_cloud_comment_update: Comment;
  artifacts_cloud_comment_delete: Comment;
  artifacts_checkpoints: BoardCheckpoint[];
  artifacts_payload: ArtifactPayload;
  session_chat_threads_list: ThreadMeta[];
  session_chat_thread_get: SessionChatThreadWire;
  session_chat_thread_save: Unit;
  session_chat_thread_delete: Unit;
  session_chat_retrieve: RetrieveResult;
  // An inline `invoke<{…}>` type in `byok-chat.ts`, read off its wrapper.
  modelchat_models: Awaited<ReturnType<typeof modelchat.models>>;
  modelchat_stream: Unit;
  modelchat_cancel: Unit;
  // `save()` from `@tauri-apps/plugin-dialog`, which calls this command.
  "plugin:dialog|save": Awaited<ReturnType<typeof save>>;
}

/**
 * Comments, by Session id, mutated in place so the thread reacts.
 *
 * Seeded on the live Session's first prompt and on a tool call, so both the
 * hover-to-reveal state and the always-visible count state are on screen at
 * once — and so the tool-call anchor, which the web UI cannot reach, is covered.
 */
const COMMENTS = new Map<string, Comment[]>();

function seedComments() {
  if (COMMENTS.size > 0) return;
  const entries = TIMELINES.get(LIVE_ID) ?? [];
  const prompt = entries.find((e) => e.kind === "prompt");
  const tool = entries.find((e) => e.kind === "tool_call");
  // The SECOND call of a run, deliberately: a group of consecutive calls is one
  // row on the rail, and a comment on any but its first used to have nowhere to
  // render — it counted in the panel and the badge and appeared nowhere.
  const laterTool = entries.filter((e) => e.kind === "tool_call")[1];
  const rows: Comment[] = [];
  if (prompt) {
    rows.push(
      mockComment({
        id: "cm_1",
        anchorKind: "message",
        anchorId: prompt.id,
        body: "Is <@usr_priya> expecting the retry helper to keep its old signature?",
        mentions: ["usr_priya"],
        authorId: "usr_sam",
      }),
      mockComment({
        id: "cm_2",
        anchorKind: "message",
        anchorId: prompt.id,
        parentId: "cm_1",
        body: "No — I signed off on the breaking change last week.",
      }),
    );
  }
  if (tool) {
    rows.push(
      mockComment({
        id: "cm_3",
        anchorKind: "tool_call",
        anchorId: tool.id,
        body: "This is the call that was timing out in CI.",
      }),
    );
  }
  if (laterTool) {
    rows.push(
      mockComment({
        id: "cm_5",
        anchorKind: "tool_call",
        anchorId: laterTool.id,
        body: "Was this search narrow enough? It missed the legacy call site.",
        authorId: "usr_sam",
      }),
    );
  }
  rows.push(
    mockComment({
      id: "cm_4",
      anchorKind: "session",
      anchorId: LIVE_ID,
      body: "Picking this up tomorrow.",
    }),
  );
  const laterPrompt = entries.filter((e) => e.kind === "prompt")[1];
  if (laterPrompt) {
    rows.push(
      mockComment({
        id: "cm_6",
        anchorKind: "message",
        anchorId: laterPrompt.id,
        body: "Should this wait for the admin table fix to land first?",
        authorId: "usr_tobi",
        createdAt: at(0, 9, 40),
        resolvedAt: at(0, 11, 2),
        resolvedBy: "usr_dev",
      }),
      mockComment({
        id: "cm_7",
        anchorKind: "message",
        anchorId: laterPrompt.id,
        parentId: "cm_6",
        body: "It landed this morning — safe to go ahead.",
        authorId: "usr_dev",
        createdAt: at(0, 10, 58),
        editedAt: at(0, 11, 1),
      }),
    );
  }
  COMMENTS.set(LIVE_ID, rows);

  // A teammate's Session is discussed too: the thread a reviewer lands on.
  const teammate = TEAMMATE_ROWS[1];
  const teammateEntries = TIMELINES.get(SEEDS[teammate.base].id) ?? [];
  const teammatePrompt = teammateEntries.find((e) => e.kind === "prompt");
  const teammateTool = teammateEntries.find((e) => e.kind === "tool_call");
  const threads: Comment[] = [];
  if (teammatePrompt) {
    threads.push(
      mockComment({
        id: "ct_1",
        sessionId: teammate.id,
        anchorKind: "message",
        anchorId: teammatePrompt.id,
        body: "<@usr_dev> this touches the retry helper you just changed.",
        mentions: ["usr_dev"],
        authorId: "usr_priya",
      }),
      mockComment({
        id: "ct_2",
        sessionId: teammate.id,
        anchorKind: "message",
        anchorId: teammatePrompt.id,
        parentId: "ct_1",
        body: "Good catch, I'll rebase onto it.",
        authorId: "usr_sam",
      }),
    );
  }
  if (teammateTool) {
    threads.push(
      mockComment({
        id: "ct_3",
        sessionId: teammate.id,
        anchorKind: "tool_call",
        anchorId: teammateTool.id,
        body: "This run took 4 minutes on CI — worth caching?",
        authorId: "usr_tobi",
      }),
    );
  }
  threads.push(
    mockComment({
      id: "ct_4",
      sessionId: teammate.id,
      anchorKind: "session",
      anchorId: teammate.id,
      body: "Looks good to merge once the renderer tests pass.",
      guestName: "Lena (Northwind)",
      authorId: "",
    }),
  );
  COMMENTS.set(teammate.id, threads);
}

export function mockComment(over: Partial<Comment> & { id: string }): Comment {
  return {
    sessionId: LIVE_ID,
    anchorKind: "message",
    anchorId: "",
    parentId: null,
    authorId: "usr_priya",
    guestName: null,
    body: "",
    mentions: [],
    createdAt: at(0, 10, 4),
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

function patchComment(
  sessionId: string,
  commentId: string,
  patch: (row: Comment) => Comment,
): Comment {
  seedComments();
  const rows = COMMENTS.get(sessionId) ?? [];
  const at = rows.findIndex((row) => row.id === commentId);
  if (at < 0) throw new Error("not found");
  const next = patch(rows[at]);
  COMMENTS.set(
    sessionId,
    rows.map((row, i) => (i === at ? next : row)),
  );
  return next;
}

function threadsFor(sessionId: string): CommentThreads {
  seedComments();
  const rows = COMMENTS.get(sessionId) ?? [];
  const byAnchor: Record<string, Comment[]> = {};
  const session: Comment[] = [];
  for (const row of rows) {
    if (row.anchorKind === "session") session.push(row);
    else (byAnchor[row.anchorId] ??= []).push(row);
  }
  return { byAnchor, session };
}

export const artifactsHandlers: TypedHandlers<ArtifactsResponses> = {
  // Targeting is a Rust-side concern with nothing to answer — except that the
  // real board sockets each hear their Project's roster on connect, which is
  // what lights the Timeline header's online stack. Sam is on one Project and
  // Mira on the other: Mira is offline in team chat (`comms.ts`), so her face
  // here proves the two sources are unioned rather than one replacing the
  // other. `usr_dev` is the viewer and must never appear in the stack.
  artifacts_cloud_retarget: ({ orgId }): null => {
    if (orgId == null) return null;
    setTimeout(() => {
      void emit("atlas:artifacts-cloud", {
        kind: "presence",
        projectId: "rw_1d55e903",
        online: ["usr_dev", "usr_sam", "usr_mira"],
      });
      void emit("atlas:artifacts-cloud", {
        kind: "presence",
        projectId: "rw_8c41f20b",
        online: ["usr_dev", "usr_priya"],
      });
    }, 300);
    return null;
  },
  // The harness never fails, so a retry always "succeeds".
  artifacts_cloud_refresh: (): boolean => true,
  artifacts_cloud_follow: (): null => null,
  artifacts_cloud_unfollow: (): null => null,
  // A chat is only in the cloud in the scenarios that say so.
  chat_comment_target: (): null => null,

  // A teammate's Session comes back in the SAME shape a local one does — the
  // real command maps the wire entries in Rust, so nothing downstream learns
  // that a Session can arrive two ways.
  artifacts_cloud_session: ({ sessionId }): SessionDetail => {
    const teammate = TEAMMATE_ROWS.find((row) => row.id === String(sessionId));
    const seed =
      SEEDS.find((s) => s.id === String(sessionId)) ?? SEEDS[teammate?.base ?? 1] ?? SEEDS[1];
    const detail = detailOf(seed);
    return {
      ...detail,
      summary: {
        ...detail.summary,
        id: String(sessionId),
        title: teammate?.title ?? detail.summary.title,
      },
      // A remote Checkpoint has no commit subject and nothing carries a blob
      // key: the desktop resolves the first from git and the second from its
      // own sidecar, and a Session captured elsewhere has neither here.
      entries: detail.entries.map((e) => ({
        ...e,
        commitSubject: null,
        bodyRef: null,
        argumentsRef: null,
        resultRef: null,
      })),
    };
  },

  artifacts_cloud_session_url: ({ projectId, sessionId }): string =>
    `https://app.tryatlas.cc/timeline?org=org_demo&workspace=${String(projectId)}&session=${String(sessionId)}`,

  artifacts_cloud_payload: ({ part }): ArtifactPayload => ({
    text: `[mock] the full ${String(part)} of this entry, fetched from the server.`,
    binary: false,
    bytes: 64,
  }),

  artifacts_cloud_comments: ({ sessionId }): CommentThreads => threadsFor(String(sessionId)),

  artifacts_cloud_comment_create: ({
    sessionId,
    anchorKind,
    anchorId,
    parentId,
    body,
  }): Comment => {
    seedComments();
    const id = String(sessionId);
    const created = mockComment({
      id: `cm_${Date.now()}`,
      sessionId: id,
      anchorKind: anchorKind as Comment["anchorKind"],
      anchorId: String(anchorId),
      parentId: parentId == null ? null : String(parentId),
      body: String(body),
      // The signed-in account (`usr_dev` in `integrations.ts`), as the server
      // stamps it from the token — so a new comment reads as "You" and can be
      // edited and deleted.
      authorId: "usr_dev",
      mentions: [...String(body).matchAll(/<@([^>]+)>/g)].map((m) => m[1]),
      createdAt: new Date().toISOString(),
    });
    COMMENTS.set(id, [...(COMMENTS.get(id) ?? []), created]);
    return created;
  },

  artifacts_cloud_comment_update: ({ sessionId, commentId, body, resolved }): Comment =>
    patchComment(String(sessionId), String(commentId), (row) => ({
      ...row,
      body: body == null ? row.body : String(body),
      editedAt: body == null ? row.editedAt : new Date().toISOString(),
      resolvedAt: resolved == null ? row.resolvedAt : resolved ? new Date().toISOString() : null,
      resolvedBy: resolved == null ? row.resolvedBy : resolved ? "usr_priya" : null,
    })),

  // The row survives with a null body so replies keep their places — which is
  // exactly what the real server does, and what the tombstone renders from.
  artifacts_cloud_comment_delete: ({ sessionId, commentId }): Comment =>
    patchComment(String(sessionId), String(commentId), (row) => ({
      ...row,
      body: null,
      mentions: [],
      deletedAt: new Date().toISOString(),
    })),

  artifacts_board: ({ projects }): BoardPage => {
    const paths = Array.isArray(projects) ? (projects as string[]) : [];
    const local = SEEDS.filter((seed) => paths.includes(seed.project.path)).map(boardRow);
    // The merge the real command does: local rows, plus whatever the
    // Organisation has that this machine does not.
    const sessions = [...local, ...teammateBoardRows()].sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
    // The fixture answers in one tick, so the remote half is never outstanding
    // and never fails. Flip `cloudFailed` by hand to exercise the retry notice.
    return { sessions, cloudPending: false, cloudFailed: false };
  },
  // `None` when the Session is not in that project's store — the panel renders
  // its "this Session is gone" state rather than erroring.
  artifacts_session: ({ projectPath, sessionId }): SessionDetail | null => {
    const seed = seedFor(String(projectPath), String(sessionId));
    return seed ? detailOf(seed) : null;
  },
  artifacts_checkpoints: ({ projects }): BoardCheckpoint[] =>
    checkpoints(Array.isArray(projects) ? (projects as string[]) : []),
  artifacts_payload: ({ blobRef }): ArtifactPayload => {
    const blob = BLOBS.get(String(blobRef));
    // A vacuumed blob store is a real state; Rust surfaces it as a read error.
    if (!blob) throw new Error(`no blob ${String(blobRef)}`);
    return blob;
  },

  // ── Session-Chat ────────────────────────────────────────────────────────
  session_chat_threads_list: ({ agentSessionId }): ThreadMeta[] =>
    (threads.get(String(agentSessionId)) ?? [])
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  session_chat_thread_get: ({ agentSessionId, id }): SessionChatThreadWire => {
    const thread = (threads.get(String(agentSessionId)) ?? []).find(
      (candidate) => candidate.id === id,
    );
    if (!thread) throw new Error(`no such thread ${String(id)}`);
    return thread;
  },
  session_chat_thread_save: ({ thread }): null => {
    const saved: SessionChatThreadWire = thread;
    const existing = threads.get(saved.agentSessionId) ?? [];
    threads.set(saved.agentSessionId, [
      saved,
      ...existing.filter((candidate) => candidate.id !== saved.id),
    ]);
    return null;
  },
  session_chat_thread_delete: ({ agentSessionId, id }): null => {
    const key = String(agentSessionId);
    threads.set(
      key,
      (threads.get(key) ?? []).filter((thread) => thread.id !== id),
    );
    return null;
  },
  session_chat_retrieve: ({
    projectPath,
    sessionId,
    query,
    checkpoints: scope,
  }): RetrieveResult => {
    const question = String(query ?? "").trim();
    // Rust rejects this before touching the store; the panel relies on it.
    if (!question) throw new Error("empty query");
    const seed = seedFor(String(projectPath), String(sessionId));
    if (!seed) throw new Error("this Session is not in that project's store");
    const detail = detailOf(seed);
    const scoped = Array.isArray(scope) ? (scope as string[]) : [];
    const sources = sourcesFor(detail, scoped);
    return {
      prompt: [
        `You are answering a question about one recorded session in ${seed.project.name}.`,
        "",
        `Session: ${seed.title ?? "Untitled"}`,
        `Agent: ${seed.agent ?? "unknown"} · ${detail.counts.toolCalls} tool calls · ${detail.counts.checkpoints} checkpoints`,
        scoped.length > 0 ? `Scoped to: ${scoped.join(", ")}` : "Scope: the whole session",
        "",
        "Excerpts:",
        ...sources.map((source) => `- [${source.kind}] ${source.label}`),
        "",
        `Question: ${question}`,
      ].join("\n"),
      sources,
    };
  },

  // The BYOK streaming path Session-Chat generates through. Shared with the
  // canvas copilot and AI commit messages, so it is answered generically.
  modelchat_models: ({ provider }): { id: string }[] =>
    (MODELS[String(provider)] ?? ["default"]).map((id) => ({ id })),
  modelchat_stream: ({ streamId }): null => {
    streamAnswer(String(streamId));
    return null;
  },
  modelchat_cancel: ({ streamId }): null => {
    cancelled.add(String(streamId));
    return null;
  },

  // Export writes through `write_file_content`, which the file fakes already
  // answer; only the save dialog is missing, and an unanswered one resolves
  // `null` — indistinguishable from "the developer pressed Escape".
  "plugin:dialog|save": ({ options }): string => {
    const name = String(options?.defaultPath ?? "export");
    return `${MOCK_PROJECT.path}/${name}`;
  },
};
