// The shape of the `northwind` scenario's CONTENT: what people asked their
// agents, what the agents did, what the team said about it. The data lives in
// `northwind-content.ts`; everything that turns it into wire answers lives in
// `northwind-world.ts` and the `northwind-*.ts` adapters beside it.
//
// The split exists so the words can be written (or rewritten) without touching
// any wiring: fill a stub in `northwind-content.ts`, reload
// `localhost:1420/?scenario=northwind`, and every surface that shows that
// Session — the Timeline row and detail, the commit's "Produced by", the chat
// card, the comment thread, the Usage tab — picks it up.
//
// Time is always RELATIVE to the moment the page loads (`When`), so the board
// reads "Today" and "Yesterday" on whatever day the video is recorded.

/** The cast. `uzayer` is the signed-in user on the desktop. */
export type PersonKey = "uzayer" | "zuhayer";

/** The agents that appear on the record. */
export type AgentKey = "claude-code" | "codex" | "atlas-agent";

/** Team-chat channels. */
export type ChannelKey = "shop" | "general";

/**
 * A moment relative to page load: `daysAgo` local days back, at local `at`
 * ("HH:MM"). `{ daysAgo: 0, at: "now-25" }` means 25 minutes before load — use
 * that form for anything "today" so it is never in the future, whatever hour
 * the video is recorded at.
 */
export interface When {
  daysAgo: number;
  /** "HH:MM" local, or "now-<minutes>" (only meaningful with `daysAgo: 0`). */
  at: string;
}

// ── Sessions ──────────────────────────────────────────────────────────────

/** One tool call inside a Session. Paths are repo-relative (`src/server/cart.ts`). */
export interface ToolStep {
  kind: "tool";
  /** Stable within the Session; comments anchor to it (`anchor.step`). */
  id: string;
  /** Minutes after the Session started. */
  min: number;
  /**
   * `read` / `edit` / `write` (new file) / `bash` / `grep` / `memory` (an
   * Atlas memory tool) / `org` (an Atlas Agent organisation tool).
   */
  tool: "read" | "edit" | "write" | "bash" | "grep" | "memory" | "org";
  /** The row's title, as the agent reported it ("Edit src/client/checkout.ts"). */
  title: string;
  /** For read/edit/write. */
  path?: string;
  /** For bash: the command. For grep: the pattern. For memory/org: the tool name. */
  command?: string;
  /** Free-form arguments, shown under **Arguments**. Derived from the above when omitted. */
  args?: Record<string, unknown>;
  /** What came back, shown under **Result**. Keep it short; a few lines. */
  result?: string;
  /** For edit/write: the text replaced and the text written (omit `before` for a new file). */
  diff?: { before?: string; after: string };
  /** Line stats for edit/write. Derived from `diff` when omitted. */
  insertions?: number;
  deletions?: number;
  /** Defaults to "completed". */
  status?: "completed" | "failed";
}

export interface PromptStep {
  kind: "prompt";
  id: string;
  min: number;
  text: string;
}

export interface ThinkingStep {
  kind: "thinking";
  id: string;
  min: number;
  text: string;
}

export interface ResponseStep {
  kind: "response";
  id: string;
  min: number;
  /** Markdown. */
  text: string;
}

/** The commit this Session's work landed in. `commit` is a key in `commits`. */
export interface CheckpointStep {
  kind: "checkpoint";
  id: string;
  min: number;
  commit: string;
}

export type Step = PromptStep | ThinkingStep | ToolStep | ResponseStep | CheckpointStep;

export interface SessionContent {
  /** Stable id; chat cards, comments and commits refer to it. */
  id: string;
  title: string;
  author: PersonKey;
  agent: AgentKey;
  /** Model id as the agent reports it ("claude-opus-4", "gpt-5", "claude-sonnet-4"). */
  model: string;
  started: When;
  /** Wall-clock length of the Session in minutes (last step ≤ this). */
  durationMin: number;
  branch: string;
  /** Token spend. ACP agents (Claude Code, Codex) report context occupancy; Atlas Agent reports a full split. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** List-price cost in USD, for the Usage tab. Atlas Agent's is billed ("Measured"); the rest are estimates. */
  costUsd: number;
  /**
   * Imported from a terminal run before capture was on (video 2's history
   * step). Renders with the imported glyph.
   */
  imported?: boolean;
  /**
   * Written to while the video records: the board shows the pulsing dot, and
   * the `zuhayerSessionLive` cue streams `liveSteps` into it one at a time.
   */
  live?: { liveSteps: Step[] };
  /**
   * The Session only exists AFTER a given video's live beat. `video1` = the
   * discount-code run video 1 does on camera: with `?video=1` it is left out,
   * and the scripted run creates it instead.
   */
  createdOnCamera?: "video1";
  /**
   * The Session happens after video 1 in the story (it builds on the
   * discount-code field), so `?video=1` leaves it out too, with its commit.
   */
  afterVideo1?: true;
  steps: Step[];
  /** Present on a stub: who/agent/what/files, for whoever fills it in. */
  brief?: string;
}

// ── Commits ──────────────────────────────────────────────────────────────

export interface CommitFile {
  path: string;
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}

export interface CommitContent {
  /** Stable key; checkpoints and blame refer to it. */
  key: string;
  /** 40 hex chars. The one video 10 shows must stay stable between takes. */
  sha: string;
  subject: string;
  body?: string;
  author: PersonKey;
  when: When;
  files: CommitFile[];
  /**
   * Sessions whose work landed here, in order — the "Produced by N sessions"
   * row in Source Control → History. Empty for human-only commits.
   */
  sessions: string[];
  /** Set when the commit was rebased after it was made: the hash it had before. */
  rebasedFrom?: string;
}

// ── Comments on Sessions ─────────────────────────────────────────────────

export interface CommentContent {
  id: string;
  session: string;
  /** What the comment is pinned to. `step` is a step id in that Session. */
  anchor: { kind: "prompt" | "response" | "tool_call" | "session"; step?: string };
  author: PersonKey;
  /** Plain text; mention someone as `<@usr_uzayer>` / `<@usr_zuhayer>`. */
  body: string;
  when: When;
  /** A reply: the root comment's id. */
  parent?: string;
  /** On a root: the thread was resolved. */
  resolved?: { by: PersonKey; when: When };
}

// ── Team chat ─────────────────────────────────────────────────────────────

/** Reaction names map onto the server's emoji allowlist. */
export type ReactionName = "thumbsUp" | "eyes" | "rocket" | "fire" | "check" | "heart";

export interface ChatMessageContent {
  id: string;
  channel: ChannelKey;
  author: PersonKey;
  /** Markdown; mention as `<@usr_uzayer>`. */
  body: string;
  when: When;
  /** A Session card under the message; `checkpoint` (a commit key) makes it a Checkpoint card. */
  sessionRef?: { session: string; checkpoint?: string };
  /** The id of an earlier message in the same channel. */
  replyTo?: string;
  reactions?: [ReactionName, PersonKey[]][];
  /** Posted by sending this prompt draft. */
  draft?: string;
}

// ── Prompt drafts ────────────────────────────────────────────────────────

export interface DraftContent {
  id: string;
  channel: ChannelKey;
  title: string;
  createdBy: PersonKey;
  created: When;
  updated: When;
  /** The prompt text. Lines may come from different people; it is one document. */
  text: string;
  /** Sent drafts are locked; `message` is the chat message that announced it. */
  sent?: { by: PersonKey; when: When; message: string };
}

// ── Scripted agent runs (the composer's fake agent) ──────────────────────

/**
 * Something the fake agent does after the user sends a prompt in an agent
 * chat. Beats play in order with short gaps, so it reads as a streamed turn.
 */
export type Beat =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      tool: ToolStep["tool"];
      title: string;
      path?: string;
      command?: string;
      args?: Record<string, unknown>;
      result?: string;
      diff?: { before?: string; after: string };
      /** How long it "runs" before the result lands. Default 700. */
      ms?: number;
    }
  | {
      /**
       * An approval card (Allow / Allow for this session / Decline). `effect`
       * names what Allow does — see `EFFECTS` in `northwind.ts`.
       */
      kind: "approval";
      title: string;
      /** Shown in the card: who it reaches and the exact words. */
      args: Record<string, unknown>;
      effect: "postShopReport" | "replyToComment" | "postDiscountSession";
      /** Spoken back after Allow / after Decline. */
      allowed: string;
      declined: string;
    };

export interface ScriptedRun {
  id: string;
  /** Lower-case substrings; the first run whose every entry is in the prompt wins. */
  match: string[];
  /** Restrict to one agent; omit for any. */
  agent?: AgentKey;
  /**
   * Play this Session's steps (after its prompt, up to its checkpoint) as the
   * turn, instead of `beats`. Used where the run IS a recorded Session, so the
   * chat's tool calls and the Timeline's rows are the same rows and a comment
   * on one shows on the other.
   */
  replay?: string;
  beats: Beat[];
  /**
   * After the last beat: `discountSession` records the video-1 Session on the
   * Timeline and leaves its edits uncommitted in the git panel, so committing
   * them there shows "Produced by 1 session". `rememberDecision` adds
   * `memoryOnRemember` to Memory → Shared → Memories (video 11).
   */
  afterwards?: "discountSession" | "rememberDecision";
}

// ── Memory, policy, skills (video 11) ───────────────────────────────────

export interface MemoryContent {
  id: string;
  kind: "decision" | "fact" | "failure" | "file" | "plan" | "architecture";
  text: string;
  agent: AgentKey;
  session?: string;
  confidence: number;
  when: When;
  /** Files it is about. */
  files?: string[];
}

export interface PolicyContent {
  policy: string;
  value: string;
  source: string;
  match: string;
}

// ── Live cues (fired from the keyboard during a take) ───────────────────

export interface CueContent {
  /** `zuhayerComments`: Zuhayer's comment lands on this Session's step. */
  zuhayerComment: { session: string; step: string; body: string };
  /** `zuhayerMessage`: lands in #shop. */
  zuhayerMessage: { body: string; sessionRef?: { session: string; checkpoint?: string } };
  /** `zuhayerShare`: video 1 beat 5's fallback — Zuhayer references your Session in #shop. */
  zuhayerShare: { body: string; sessionRef: { session: string; checkpoint?: string } };
  /** `zuhayerDraftEdit`: Zuhayer types this into the draft, after `afterText` (or at the end). */
  zuhayerDraftEdit: { draftTitle: string; text: string; afterText?: string };
}

// ── The whole thing ──────────────────────────────────────────────────────

export interface NorthwindContent {
  sessions: SessionContent[];
  commits: CommitContent[];
  comments: CommentContent[];
  chat: ChatMessageContent[];
  drafts: DraftContent[];
  runs: ScriptedRun[];
  memory: MemoryContent[];
  /** Added by `/remember` in video 11 — absent until that run. */
  memoryOnRemember: MemoryContent;
  policies: PolicyContent[];
  cues: CueContent;
}
