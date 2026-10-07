// Team chat (`comms`): a connected org with a populated sidebar, one long
// scrollable thread, and every awkward transcript row the real panel has to
// survive.
//
// Nothing here is a happy path on its own. The fixtures exist to put the
// states that only show up under load on screen at mount: a 46-message thread
// with code blocks, reactions, an edit, a deletion tombstone, an attachment
// and a send that failed; a conversation that is genuinely empty; unread
// counts and a mention badge; a channel name long enough to truncate
// everywhere it is rendered; a live call and an ended one.
//
// Writes mutate the module-level state and then announce themselves on
// `atlas:comms`, exactly as Rust does — because the store is a PROJECTION and
// builds nothing optimistically (`comms-store.ts`: "`send` does not build an
// optimistic row"). A fake that only resolved the invoke would leave every
// button inert: sending appends nothing, reading clears no badge, reacting
// paints no chip. Every mutating handler here therefore emits the event the
// store actually applies.
//
// Casing follows the wire, not the bridge: every field below is snake_case
// because these are wire objects (`atlas-comms::wire`, `#[serde]`-untouched),
// while the three DTOs Rust renames — `ConnectionInfoDto`, `DmResultDto`,
// `SendReceipt` — are camelCase. Each fake is typed with the frontend's own
// type so `bun run typecheck` catches drift from Rust.

import { emit } from "@tauri-apps/api/event";
import type {
  comms,
  CommsEnvelope,
  CommsEvent,
  CommsSnapshot,
  ConnectionInfo,
  ConversationWindow,
  DmResult,
  MessagePage,
  RecordingsResponse,
} from "@/features/comms/lib/comms-api";
import {
  CHAT_REACTION_EMOJI,
  type ChatAttachment,
  type ChatCall,
  type ChatCodeRef,
  type ChatConversation,
  type ChatFeatures,
  type ChatPin,
  type ChatReaction,
  type ChatReadState,
  type ChatSessionReference,
  type CommsMessage,
  type OrgMemberProfile,
  type PromptDraft,
  type RecordingTrack,
  type SendStatus,
} from "@/features/comms/types";
import type { TypedHandlers, Unit } from "../types";
import { abs, MOCK_ORG_ID } from "../project";

const MIN = 60_000;
/** Fixed "now", as in `log.ts`, so day dividers and relative times are stable
 *  between reloads instead of drifting a minute per refresh. */
const NOW = Date.parse("2026-09-18T11:30:00Z");

// ── people ────────────────────────────────────────────────────────────────

const ME = "usr_dev";
const PRIYA = "usr_priya";
const SAM = "usr_sam";
const MIRA = "usr_mira";
const TOBI = "usr_tobi";

/**
 * The org roster. Chat sends user ids and nothing else — every name, avatar,
 * presence dot and resolved `<@mention>` in the panel comes from here — so a
 * missing roster renders the whole DM section as "Unknown". See
 * `commsRosterHandlers` at the bottom for how this reaches the store.
 *
 * One deliberately long name, because `conversationTitle` joins two of them
 * for a group DM and the tab label clamps at 110px.
 */
export const COMMS_MEMBERS: OrgMemberProfile[] = [
  { id: ME, name: "Dev", email: "dev@acme.dev", image: null, role: "admin" },
  {
    id: PRIYA,
    name: "Priya Raghunathan",
    email: "priya@acme.dev",
    image: null,
    role: "product_owner",
  },
  { id: SAM, name: "Sam Oyelaran", email: "sam@acme.dev", image: null, role: "developer" },
  {
    id: MIRA,
    name: "Mirabel Fitzgerald-Okonkwo",
    email: "mirabel.fitzgerald@acme.dev",
    image: null,
    role: "developer",
  },
  { id: TOBI, name: "Tobi Adeyemi", email: "tobi@acme.dev", image: null, role: "member" },
];

/** Mira is deliberately offline: a roster where everyone is green never shows
 *  the absent state, which is the one the avatar has to get right. */
const ONLINE = [ME, PRIYA, SAM, TOBI];

/**
 * Reactions are taken FROM the server allowlist rather than typed as literals.
 * `react` with anything outside it is a 400, and two of the entries carry a
 * variation selector that is invisible in a diff — a hand-typed `❤️` is a
 * different byte string from the one the server allowed.
 */
const EMOJI = {
  thumbsUp: CHAT_REACTION_EMOJI[0],
  eyes: CHAT_REACTION_EMOJI[4],
  rocket: CHAT_REACTION_EMOJI[5],
  fire: CHAT_REACTION_EMOJI[6],
  thinking: CHAT_REACTION_EMOJI[7],
  bug: CHAT_REACTION_EMOJI[12],
  heart: CHAT_REACTION_EMOJI[14],
  check: CHAT_REACTION_EMOJI[15],
} as const;

// ── conversations ─────────────────────────────────────────────────────────

const DESKTOP = "conv_desktop";
const TOKENS = "conv_tokens";
const SECURITY = "conv_security";
const WATERCOOLER = "conv_watercooler";
const DM_PRIYA = "conv_dm_priya";
const GROUP = "conv_group";

function channel(
  id: string,
  name: string,
  lastActivitySeq: number,
  overrides: Partial<ChatConversation> = {},
): ChatConversation {
  return {
    id,
    kind: "channel",
    name,
    visibility: "public_org",
    workspace_ref_ids: [],
    created_by: PRIYA,
    created_at: NOW - 90 * 24 * 60 * MIN,
    archived_at: null,
    seq: 1,
    // Never populated for a channel — a channel roster is not broadcast
    // org-wide. Handing the UI an array here would fake a member count that
    // the real wire cannot supply.
    member_ids: null,
    last_activity_seq: lastActivitySeq,
    ...overrides,
  };
}

// `last_activity_seq` is 0 here for anything with a transcript: it is filled
// in from the built messages further down, because a hand-written number goes
// stale the moment a seed is added and the only symptom is a channel that
// refuses to sort to the top.
let conversations: ChatConversation[] = [
  channel(DESKTOP, "atlas-desktop", 0),
  // 71 characters, inside `CHANNEL_NAME_MAX` (80) and well past what any row,
  // tab or header can show: truncation is visible without hunting for a repro.
  channel(TOKENS, "design-system-tokens-and-the-entire-colour-system-rewrite-working-group", 0),
  // Private: the sidebar and tab strip swap the `#` for a padlock.
  channel(SECURITY, "security-review", 0, { visibility: "private" }),
  // Deliberately empty. "Loaded and empty" and "never loaded" render the same
  // transcript, and only the former may show the intro copy — the store gates
  // that on `hydrated`, so there has to be a conversation that reaches it with
  // nothing in it.
  channel(WATERCOOLER, "watercooler", 12),
  {
    id: DM_PRIYA,
    kind: "dm",
    name: null,
    visibility: "private",
    workspace_ref_ids: [],
    created_by: PRIYA,
    created_at: NOW - 30 * 24 * 60 * MIN,
    archived_at: null,
    seq: 1,
    member_ids: [ME, PRIYA],
    last_activity_seq: 0,
  },
  {
    id: GROUP,
    kind: "group_dm",
    name: null,
    visibility: "private",
    workspace_ref_ids: [],
    created_by: ME,
    created_at: NOW - 9 * 24 * 60 * MIN,
    archived_at: null,
    seq: 1,
    member_ids: [ME, SAM, MIRA, TOBI],
    last_activity_seq: 0,
  },
];

/** Channels we can see but have not joined — the Discover section, which is
 *  empty in every other fixture and so never gets looked at. */
let discoverable: ChatConversation[] = [
  channel("conv_design_critique", "design-critique", 41),
  channel("conv_hiring", "hiring", 33),
];

// ── transcripts ───────────────────────────────────────────────────────────

interface Seed {
  by: string;
  body: string;
  /** Minutes since the previous seed. Big values force a day divider and a
   *  new speaker stack. */
  gap?: number;
  /** Index of an earlier seed in the same list. */
  replyTo?: number;
  /** Minutes after posting that it was edited. */
  editedAfter?: number;
  deleted?: boolean;
  status?: SendStatus;
  attachments?: ChatAttachment[];
  codeRefs?: ChatCodeRef[];
  /** Timeline Sessions or Checkpoints shared into the message (`artifact_refs`). */
  sessionRefs?: ChatSessionReference[];
  reactions?: [emoji: string, users: string[]][];
  pinned?: boolean;
  draftId?: string;
  /** Posted by an incoming webhook, not a person: `by` is then the webhook's
   *  `whk_…` id, `name` the frozen `author_name`, and `via` the webhook's own
   *  name when the post overrode it. */
  webhook?: { name: string; via?: string };
}

const IMAGE_ATTACHMENT: ChatAttachment = {
  id: "file_scroll_trace",
  filename: "scroll-jump-trace.png",
  content_type: "image/png",
  bytes: 184_204,
};

const PDF_ATTACHMENT: ChatAttachment = {
  id: "file_perf_report",
  filename: "transcript-perf-report-2026-09-16.pdf",
  content_type: "application/pdf",
  bytes: 1_204_882,
};

const AUDIO_ATTACHMENT: ChatAttachment = {
  id: "file_voice_note",
  filename: "voice-note.m4a",
  content_type: "audio/mp4",
  bytes: 412_006,
};

const CODE_REFS: ChatCodeRef[] = [
  {
    path: "src/features/comms/stores/comms-store.ts",
    start_line: 204,
    end_line: 215,
    sha: "4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0",
  },
];

/**
 * The long thread. Forty-six rows is not padding: grouping, day dividers, the
 * scroll-anchor and the `loadOlder` affordance are all invisible under ten,
 * and the transcript's memoisation only misbehaves at length.
 */
const DESKTOP_SEEDS: Seed[] = [
  {
    by: PRIYA,
    body: "Morning. Taking the transcript-scroll bug today — the one where a new message yanks you back to the bottom while you're reading history.",
  },
  {
    by: PRIYA,
    gap: 2,
    body: "Repro is reliable: open a channel with a few hundred rows, scroll up ten screens or so, then let a message land.",
  },
  {
    by: SAM,
    gap: 4,
    body: "That's `atEndRef`, isn't it. It gets re-armed from the resize observer, so any content growth counts as \"the reader is at the end\".",
    reactions: [
      [EMOJI.eyes, [PRIYA, MIRA]],
      [EMOJI.thinking, [TOBI]],
    ],
  },
  {
    by: ME,
    gap: 3,
    body: "Here's the block I keep re-reading:\n\n```ts\nuseLayoutEffect(() => {\n  const grew = messages.length - prevLen.current;\n  prevLen.current = messages.length;\n  if (grew > 0 && !atEndRef.current) setNewCount((n) => n + grew);\n  if (atEndRef.current) scrollToBottom();\n  invalidate();\n}, [messages.length, atEndRef, invalidate, scrollToBottom]);\n```",
    codeRefs: CODE_REFS,
    pinned: true,
  },
  {
    by: SAM,
    gap: 2,
    replyTo: 3,
    body: "Right, and `invalidate()` at the bottom is what re-measures — so the observer fires, which re-arms the ref, which re-pins. It's a loop with one frame of delay in it.",
  },
  {
    by: MIRA,
    gap: 6,
    body: "Is this the same thing as the image-resize jump, or a second bug wearing the same hat?",
  },
  {
    by: SAM,
    gap: 1,
    body: "Same thing. An image resolving its aspect ratio is content growth like any other.",
    reactions: [[EMOJI.thumbsUp, [MIRA]]],
  },
  {
    by: PRIYA,
    gap: 5,
    body: "Trace from this morning, ten scrollbacks then a send. The two spikes are the two re-pins.",
    attachments: [IMAGE_ATTACHMENT],
    reactions: [
      [EMOJI.fire, [SAM, TOBI, ME]],
      [EMOJI.eyes, [MIRA]],
    ],
  },
  { by: TOBI, gap: 3, body: "Nice. Is that DevTools or our own instrumentation?" },
  { by: PRIYA, gap: 1, body: "Ours — the transcript already reports every anchor decision." },
  {
    by: MIRA,
    gap: 8,
    body: "Unrelated but while everyone's here: the composer eats the first keystroke after a tab switch about one time in five.",
  },
  {
    by: MIRA,
    gap: 1,
    body: "Filed it, no need to chase it in this thread.",
    // Edited: the "edited" marker sits in the same footer row as the pending
    // and failed markers, so at least one message has to carry it.
    editedAfter: 4,
  },
  { by: SAM, gap: 2, body: "Was going to say — that's the autofocus racing the mount." },
  {
    by: ME,
    gap: 4,
    body: "Let's keep this one on the scroll. <@usr_priya> do you want the anchor half and I take the composer?",
  },
  {
    by: PRIYA,
    gap: 2,
    body: "Works for me.",
    reactions: [[EMOJI.check, [ME]]],
  },

  // Overnight. Forces a day divider and breaks the speaker stack.
  {
    by: SAM,
    gap: 1_800,
    body: "Morning. Spent an hour on the Rust side of this and it's cleaner than I feared:\n\n```rust\npub fn append(&mut self, msg: WireMessage) -> Result<(), CommsError> {\n    if self.seen.contains(&msg.id) {\n        return Ok(());\n    }\n    self.seen.insert(msg.id.clone());\n    self.log.push(msg);\n    Ok(())\n}\n```\n\nThe dedupe is already idempotent, so replaying a window costs nothing.",
    reactions: [[EMOJI.rocket, [PRIYA, ME]]],
  },
  {
    by: SAM,
    gap: 2,
    body: "Which means the renderer can re-open a conversation as often as it likes.",
  },
  {
    by: PRIYA,
    gap: 7,
    body: "Good. That's what makes the self-heal on mount safe — I was worried it would double rows.",
  },
  {
    by: TOBI,
    gap: 12,
    body: "Sorry, catching up. Does any of this change the wire format?",
  },
  {
    by: SAM,
    gap: 1,
    replyTo: 18,
    body: "No. Frozen, and nothing here needs it to move.",
    reactions: [[EMOJI.thumbsUp, [TOBI, PRIYA, MIRA]]],
  },
  {
    by: MIRA,
    gap: 9,
    body: "",
    // A tombstone. The row survives, the body does not — and the reply below
    // has to render "original message deleted" rather than break.
    deleted: true,
  },
  {
    by: TOBI,
    gap: 2,
    replyTo: 20,
    body: "I saw it before it went. Agreed, but let's not do that this week.",
  },
  {
    by: PRIYA,
    gap: 15,
    body: "Perf report from the overnight run, for anyone who wants the numbers rather than the summary.",
    attachments: [PDF_ATTACHMENT],
  },
  {
    by: PRIYA,
    gap: 1,
    body: "Short version: 6.2ms median frame, 41ms worst, all of it in the re-measure.",
  },
  {
    by: ME,
    gap: 4,
    body: "41ms is a dropped frame and a half. Worth fixing properly rather than debouncing it.",
    reactions: [[EMOJI.thumbsUp, [PRIYA, SAM]]],
  },
  { by: SAM, gap: 3, body: "Agreed. Debounce would only move the jump later." },
  {
    by: TOBI,
    gap: 6,
    body: "Recorded a quick walkthrough of the repro if it's easier to watch than read.",
    attachments: [AUDIO_ATTACHMENT],
  },
  {
    by: MIRA,
    gap: 11,
    body: "Question about scope: does this cover the jump when you're in the Files tab and switch back?",
  },
  {
    by: ME,
    gap: 2,
    body: "It does — the messages subtree unmounts on the other tabs precisely so re-entry lands at the live edge like a fresh open.",
  },
  {
    by: MIRA,
    gap: 1,
    body: "Perfect.",
    reactions: [[EMOJI.heart, [ME]]],
  },
  {
    by: PRIYA,
    gap: 20,
    body: "One more repro that might be its own bug: a reaction landing on an off-screen row also re-pins.",
  },

  // Second night.
  {
    by: SAM,
    gap: 1_950,
    body: "That one IS separate — reaction rows change height without changing `messages.length`, so the layout effect never runs and only the observer sees it.",
    reactions: [[EMOJI.bug, [PRIYA, MIRA, TOBI]]],
  },
  { by: SAM, gap: 2, body: "Filing it as a follow-up rather than growing this." },
  {
    by: PRIYA,
    gap: 5,
    body: "Thanks. I'll pick it up once the anchor change is in.",
  },
  {
    by: TOBI,
    gap: 14,
    body: "Draft of the release note for this, if someone wants to sanity-check the wording before it goes out.",
    draftId: "draft_scroll_note",
  },
  {
    by: ME,
    gap: 3,
    body: 'Reads well. I\'d drop "significantly" — we can say 6.2ms instead.',
    reactions: [[EMOJI.thumbsUp, [TOBI]]],
  },
  { by: TOBI, gap: 2, body: "Done." },
  {
    by: MIRA,
    gap: 18,
    body: "Is anyone else seeing the panel forget its scroll position when the socket reconnects?",
  },
  {
    by: SAM,
    gap: 2,
    replyTo: 37,
    body: "Yes, but that's a resync re-reading every open tab. Expected for now — it merges rather than clobbers, so at least nothing is lost.",
  },
  {
    by: PRIYA,
    gap: 25,
    body: "Anchor fix is up. The observer no longer re-arms the ref; only a real scroll-to-end does.\n\n```diff\n-  onContentResize: () => { atEndRef.current = true; }\n+  onContentResize: () => { if (atEndRef.current) scrollToBottom(); }\n```",
    pinned: true,
    reactions: [
      [EMOJI.rocket, [SAM, ME, TOBI, MIRA]],
      [EMOJI.fire, [SAM]],
    ],
  },
  { by: SAM, gap: 4, body: "That's the whole bug in two lines. Lovely." },
  {
    by: ME,
    gap: 2,
    body: "Reviewed. One note on the test — it asserts on `scrollTop` directly, which will be flaky in CI.",
  },
  {
    by: PRIYA,
    gap: 6,
    body: "Fair. Switching it to the anchor decision the transcript already reports.",
  },
  {
    by: TOBI,
    gap: 9,
    body: "Anything left that blocks the release, or are we clear?",
  },
  {
    by: PRIYA,
    gap: 3,
    body: "Clear from my side once the test lands.",
    reactions: [[EMOJI.check, [TOBI, ME]]],
  },
  {
    by: ME,
    gap: 4,
    // Session References: a whole recorded Session and one Checkpoint inside
    // it, pointing at real rows in `artifacts.ts` so the cards open on the
    // Timeline. `rw_1d55e903` is acme-app's Workspace there.
    body: "Unrelated, but the /v2 move is done — here's the session if anyone wants to see how the retry helper ended up.",
    sessionRefs: [
      {
        kind: "session",
        workspace_ref_id: "rw_1d55e903",
        session_id: "sess-8f21ac",
        session_title: "Move the user reads onto /v2 and keep the retry helper honest",
        agent: "claude-code",
        started_at: NOW - 150 * MIN,
        messages: 14,
        tool_calls: 23,
        checkpoints: 2,
      },
    ],
    reactions: [[EMOJI.eyes, [PRIYA, SAM]]],
  },
  {
    by: SAM,
    gap: 3,
    body: "This checkpoint is the one to review — the rest is call sites.",
    sessionRefs: [
      {
        kind: "checkpoint",
        workspace_ref_id: "rw_1d55e903",
        session_id: "sess-8f21ac",
        session_title: "Move the user reads onto /v2 and keep the retry helper honest",
        row_id: "sess-8f21ac-e30",
        commit_sha: "4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0",
        branch: "feature/auth-v2",
        insertions: 96,
        deletions: 41,
        files: 3,
      },
    ],
  },
  {
    // An incoming webhook (ADR-0020 on the server): the id is the webhook's,
    // never a member's, so without `author_kind` this rendered as "Unknown".
    by: "whk_ci",
    gap: 2,
    webhook: { name: "GitHub Actions" },
    body: "Build #412 passed on `feature/auth-v2` in 3m 12s.",
  },
  {
    // The same webhook posting under a per-message username: drawn as
    // "Release · via GitHub Actions", so the override can never stand alone.
    by: "whk_ci",
    gap: 1,
    webhook: { name: "Release", via: "GitHub Actions" },
    body: "Draft release **v0.4.0** created from `feature/auth-v2`.",
  },
  {
    by: ME,
    gap: 5,
    // A send that failed and STAYED in the transcript. Rust keeps the row and
    // marks it, because a message that silently disappears from the composer
    // and the transcript both is the worst outcome available.
    body: "Merging once CI is green — I'll watch it.",
    status: "failed",
  },
  {
    by: ME,
    gap: 1,
    // Still in flight: the pending marker and the failed one share a footer.
    body: "(retrying that last one)",
    status: "sending",
  },
];

/** Older history, reachable only by paging up — so `loadOlder` has something
 *  to return and the "load older" affordance is not a no-op. */
const DESKTOP_ARCHIVE_SEEDS: Seed[] = [
  { by: PRIYA, body: "Kicking off the transcript work. Thread for anything scroll-related." },
  { by: SAM, gap: 40, body: "Do we have numbers on how long a channel actually gets?" },
  { by: PRIYA, gap: 35, body: "p95 is about 4,000 messages. p99 is 40,000." },
  { by: SAM, gap: 30, body: "Then virtualisation is not optional." },
  {
    by: MIRA,
    gap: 55,
    body: "It is if we cap the window and page. Which is what the API does anyway.",
  },
  { by: SAM, gap: 25, body: "Fair." },
  { by: TOBI, gap: 90, body: "What's the page size server-side?" },
  { by: PRIYA, gap: 20, body: "Fifty, and `has_more` tells you when to stop asking." },
  { by: ME, gap: 45, body: "Pages come back oldest-first, so they append rather than reverse." },
  { by: MIRA, gap: 60, body: "Noted. That caught me out in the web client." },
  { by: SAM, gap: 120, body: "Starting on the window merge today." },
  { by: SAM, gap: 15, body: "The rule is: an empty incoming window never replaces content." },
  { by: PRIYA, gap: 35, body: "Because a pre-hydration snapshot can land after a full one?" },
  { by: SAM, gap: 5, body: "Exactly that. Silently, with no error anywhere." },
  { by: TOBI, gap: 80, body: "Grim. Good catch." },
  { by: MIRA, gap: 40, body: "Is there a test for it?" },
  { by: SAM, gap: 10, body: "There is now." },
  {
    by: PRIYA,
    gap: 70,
    body: "Right — that's the foundation done. Everything after this is the UI.",
  },
];

const TOKENS_SEEDS: Seed[] = [
  { by: MIRA, body: "Starting the token rewrite. Every surface moves onto the shadcn base keys." },
  {
    by: SAM,
    gap: 25,
    body: "Including the diff view? That one has four line kinds with their own backgrounds.",
  },
  { by: MIRA, gap: 10, body: "Including the diff view. It's the reason the derived keys exist." },
  {
    by: MIRA,
    gap: 240,
    body: "<@usr_dev> can you look at the ramp before I go further? I don't want to redo forty files.",
    reactions: [[EMOJI.eyes, [ME]]],
  },
  { by: TOBI, gap: 30, body: "<@usr_dev> also worth a look for the PDF highlight colours." },
  { by: MIRA, gap: 180, body: "Bumping — blocked on this one." },
];

const SECURITY_SEEDS: Seed[] = [
  {
    by: PRIYA,
    body: "Quarterly review is open. Private on purpose — findings go here, not in the open channels.",
  },
  { by: SAM, gap: 90, body: "Three items so far, none of them shipping code." },
  { by: PRIYA, gap: 45, body: "Write them up and I'll triage tomorrow." },
];

const DM_PRIYA_SEEDS: Seed[] = [
  { by: PRIYA, body: "Do you have ten minutes today? Nothing urgent." },
  { by: ME, gap: 20, body: "Sure — after standup?" },
  { by: PRIYA, gap: 5, body: "Perfect." },
  { by: PRIYA, gap: 900, body: "That was useful, thanks. I'll write up what we agreed." },
  { by: ME, gap: 15, body: "No rush. The scroll fix is the only thing with a date on it." },
  {
    by: PRIYA,
    gap: 480,
    body: "Written up and posted in #atlas-desktop.",
    reactions: [[EMOJI.thumbsUp, [ME]]],
  },
  {
    by: PRIYA,
    gap: 30,
    body: "One more thing when you get a chance — the hiring channel needs an owner.",
  },
];

const GROUP_SEEDS: Seed[] = [
  { by: ME, body: "Pulling the three of you in rather than derailing the channel." },
  { by: SAM, gap: 8, body: "Go on." },
  {
    by: MIRA,
    gap: 12,
    body: "If it's about the token ramp I have opinions and a spreadsheet.",
    reactions: [[EMOJI.thinking, [SAM, TOBI]]],
  },
  { by: TOBI, gap: 6, body: "It is always about the token ramp." },
  { by: ME, gap: 4, body: "It is about the token ramp. Call?" },
];

// ── building ──────────────────────────────────────────────────────────────

/** Flat reaction ROWS, as the server sends them — the panel derives counts
 *  itself, so an aggregate here would be a shape nothing can consume. */
const reactionRows: ChatReaction[] = [];
const pinsByConv = new Map<string, string[]>();
const transcripts = new Map<string, CommsMessage[]>();
const archives = new Map<string, CommsMessage[]>();

let nextSeq = 1;

function build(convId: string, startAt: number, seeds: Seed[]): CommsMessage[] {
  let at = startAt;
  const ids = seeds.map((_, i) => `msg_${convId.slice(5)}_${String(i).padStart(2, "0")}`);
  const out = seeds.map((seed, i) => {
    at += (seed.gap ?? 3) * MIN;
    const id = ids[i];
    for (const [emoji, users] of seed.reactions ?? []) {
      for (const user of users) reactionRows.push({ message_id: id, user_id: user, emoji });
    }
    if (seed.pinned) pinsByConv.set(convId, [id, ...(pinsByConv.get(convId) ?? [])]);
    return {
      id,
      conv_id: convId,
      seq: nextSeq++,
      author_id: seed.by,
      body: seed.body,
      reply_to_id: seed.replyTo === undefined ? null : ids[seed.replyTo],
      edited_at: seed.editedAfter === undefined ? null : at + seed.editedAfter * MIN,
      created_at: at,
      attachments: seed.attachments ?? [],
      code_refs: seed.codeRefs ?? [],
      ...(seed.sessionRefs ? { artifact_refs: seed.sessionRefs } : {}),
      draft_id: seed.draftId ?? null,
      ...(seed.webhook
        ? {
            author_kind: "webhook" as const,
            author_name: seed.webhook.name,
            author_via: seed.webhook.via ?? seed.webhook.name,
            author_avatar_hash: null,
          }
        : {}),
      ...(seed.deleted ? { deleted: true } : {}),
      ...(seed.status ? { status: seed.status } : {}),
    } satisfies CommsMessage;
  });
  return out;
}

// Order matters: `nextSeq` is org-wide and monotonic, and the sidebar sorts on
// `last_activity_seq`, so archives must be built before the windows that
// follow them.
archives.set(DESKTOP, build(DESKTOP, NOW - 6_000 * MIN, DESKTOP_ARCHIVE_SEEDS));
transcripts.set(SECURITY, build(SECURITY, NOW - 3_400 * MIN, SECURITY_SEEDS));
transcripts.set(TOKENS, build(TOKENS, NOW - 2_900 * MIN, TOKENS_SEEDS));
transcripts.set(DM_PRIYA, build(DM_PRIYA, NOW - 2_600 * MIN, DM_PRIYA_SEEDS));
transcripts.set(GROUP, build(GROUP, NOW - 700 * MIN, GROUP_SEEDS));
transcripts.set(DESKTOP, build(DESKTOP, NOW - 4_080 * MIN, DESKTOP_SEEDS));
transcripts.set(WATERCOOLER, []);

// `last_activity_seq` is what the sidebar sorts on, so it is DERIVED rather
// than written by hand: a literal drifts the moment a seed is added, and the
// symptom is a channel that mysteriously refuses to move to the top.
// Watercooler keeps its literal — it has no messages to derive from.
for (const conv of conversations) {
  const list = transcripts.get(conv.id) ?? [];
  if (list.length > 0) conv.last_activity_seq = list[list.length - 1].seq;
}

/**
 * Anchor a call to a point in the transcript.
 *
 * Calls share the org-wide `seq` with messages and the conversation
 * interleaves the two on it, so a hardcoded call seq parks every call at one
 * end of the timeline no matter what the times say.
 */
function afterMessage(convId: string, index: number): { seq: number; at: number } {
  const list = transcripts.get(convId) ?? [];
  const anchor = list[Math.min(index, list.length - 1)];
  return { seq: anchor.seq, at: anchor.created_at + 5 * MIN };
}

const DESKTOP_CALL = afterMessage(DESKTOP, 38);
const DM_CALL = afterMessage(DM_PRIYA, 3);
const GROUP_CALL = afterMessage(GROUP, 4);

// ── read state ────────────────────────────────────────────────────────────

/**
 * Unread counts are SERVER-held — nothing in the frontend computes them — so
 * the badges only exist if this table says they do. One conversation carries
 * mentions (a different badge and a different colour from a plain count), one
 * carries a two-digit count, one is caught up.
 */
const caughtUp = (convId: string) => conversation(convId).last_activity_seq;

const reads = new Map<string, ChatReadState>([
  [DESKTOP, { conv_id: DESKTOP, last_read_seq: caughtUp(DESKTOP), unread: 0, mentions: 0 }],
  [TOKENS, { conv_id: TOKENS, last_read_seq: 0, unread: 14, mentions: 2 }],
  [SECURITY, { conv_id: SECURITY, last_read_seq: 0, unread: 3, mentions: 0 }],
  [WATERCOOLER, { conv_id: WATERCOOLER, last_read_seq: 0, unread: 0, mentions: 0 }],
  [DM_PRIYA, { conv_id: DM_PRIYA, last_read_seq: 0, unread: 1, mentions: 0 }],
  [GROUP, { conv_id: GROUP, last_read_seq: caughtUp(GROUP), unread: 0, mentions: 0 }],
]);

// ── calls ─────────────────────────────────────────────────────────────────

/**
 * Calls interleave with messages on the same `seq`, and an ENDED call stays in
 * the timeline — the card is the record that it happened. Three states worth
 * seeing: one finished with a recording and a transcript, one finished whose
 * recording failed, and one still running.
 */
const calls = new Map<string, ChatCall>([
  [
    "call_desktop_sync",
    {
      id: "call_desktop_sync",
      conv_id: DESKTOP,
      mode: "video",
      started_by: PRIYA,
      started_at: DESKTOP_CALL.at,
      ended_at: DESKTOP_CALL.at + 42 * MIN,
      seq: DESKTOP_CALL.seq,
      transcript_state: "ready",
      join_slug: "desktop-sync",
      recording_state: "ready",
    },
  ],
  [
    "call_dm_quick",
    {
      id: "call_dm_quick",
      conv_id: DM_PRIYA,
      mode: "audio",
      started_by: ME,
      started_at: DM_CALL.at,
      ended_at: DM_CALL.at + 12 * MIN,
      seq: DM_CALL.seq,
      transcript_state: "failed",
      join_slug: null,
      recording_state: "failed",
    },
  ],
  [
    "call_group_live",
    {
      id: "call_group_live",
      conv_id: GROUP,
      mode: "audio",
      started_by: MIRA,
      // Still running, so the card counts up from a REAL clock — the fixed
      // `NOW` would have it reading "hours ago" and still in progress.
      started_at: Date.now() - 6 * MIN,
      ended_at: null,
      seq: GROUP_CALL.seq,
      transcript_state: "none",
      join_slug: "token-ramp",
      recording_state: "recording",
    },
  ],
]);

/**
 * The org's plan, as `GET /features` answers it. The catalogue defaults —
 * free Voice Calls on, paid Meetings off — because that is what nearly every
 * Organisation has, and it is the plan the header has to get right: the
 * phone starts a Voice Call and the camera is disabled with its reason.
 * Flip `calls.paid` to see the Meeting rows.
 */
const MOCK_FEATURES: ChatFeatures = {
  features: { "calls.mesh": true, "calls.paid": false, "chat.webhooks": true },
  mesh_call_max: 20,
};

const RECORDINGS = new Map<string, RecordingsResponse>([
  [
    "call_desktop_sync",
    {
      state: "ready",
      tracks: [
        {
          id: "trk_priya",
          filename: "priya-raghunathan.m4a",
          bytes: 8_412_006,
          url: "https://chat.acme.dev/recordings/trk_priya?ticket=mock",
        },
        {
          id: "trk_sam",
          filename: "sam-oyelaran.m4a",
          bytes: 7_118_440,
          url: "https://chat.acme.dev/recordings/trk_sam?ticket=mock",
        },
      ] satisfies RecordingTrack[],
    },
  ],
  // Kept ready but empty: "the call recorded nothing" is a real answer and a
  // different empty state from "recording failed".
  ["call_group_live", { state: "recording", tracks: [] }],
]);

// ── drafts ────────────────────────────────────────────────────────────────

const drafts = new Map<string, PromptDraft[]>([
  [
    DESKTOP,
    [
      {
        id: "draft_anchor_rfc",
        conv_id: DESKTOP,
        title: "RFC: one owner for the transcript scroll anchor",
        created_by: PRIYA,
        created_at: NOW - 900 * MIN,
        updated_at: NOW - 40 * MIN,
        sent_at: null,
        sent_by: null,
        sent_message_id: null,
      },
      {
        // Already sent: the row renders differently, and `sent_message_id`
        // points at a message that really exists in the transcript above.
        id: "draft_scroll_note",
        conv_id: DESKTOP,
        title: "Release note — scroll anchor fix",
        created_by: TOBI,
        created_at: NOW - 1_200 * MIN,
        updated_at: NOW - 1_100 * MIN,
        sent_at: NOW - 1_090 * MIN,
        sent_by: TOBI,
        sent_message_id: "msg_desktop_34",
      },
    ],
  ],
  [
    TOKENS,
    [
      {
        id: "draft_token_ramp",
        conv_id: TOKENS,
        title:
          "Proposed ramp for the neutral scale, with the dark-mode variants and the three derived keys the diff view needs",
        created_by: MIRA,
        created_at: NOW - 2_400 * MIN,
        updated_at: NOW - 300 * MIN,
        sent_at: null,
        sent_by: null,
        sent_message_id: null,
      },
    ],
  ],
]);

// ── connection + the event bridge ──────────────────────────────────────────

let connection: ConnectionInfo = {
  state: "open",
  reason: null,
  epoch: 4,
  orgId: MOCK_ORG_ID,
};

/**
 * Announce a change the way Rust does.
 *
 * The envelope's `org` MUST match `connection.orgId`: the store treats a
 * mismatch as the socket having been retargeted under it, and answers by
 * resetting every slice it holds and re-hydrating. An envelope with the wrong
 * org here would empty the panel instead of updating it.
 */
function push(ev: CommsEvent): void {
  const envelope: CommsEnvelope = { org: MOCK_ORG_ID, epoch: connection.epoch, ev };
  void emit("atlas:comms", envelope);
}

function conversation(convId: string): ChatConversation {
  const found = conversations.find((c) => c.id === convId);
  if (!found) throw new Error(`[mock-backend] no conversation ${convId}`);
  return found;
}

function windowFor(convId: string): ConversationWindow {
  const messages = transcripts.get(convId) ?? [];
  const ids = new Set(messages.map((m) => m.id));
  return {
    messages,
    reactions: reactionRows.filter((row) => ids.has(row.message_id)),
    pinned_message_ids: pinsByConv.get(convId) ?? [],
  };
}

function announceConversations(): void {
  push({ kind: "conversationsChanged", conversations, discoverable });
}

let newMessageCount = 0;
function appendMessage(
  convId: string,
  authorId: string,
  body: string,
  status?: SendStatus,
): CommsMessage {
  const message: CommsMessage = {
    id: `msg_live_${++newMessageCount}`,
    conv_id: convId,
    seq: ++nextSeq,
    author_id: authorId,
    body,
    reply_to_id: null,
    edited_at: null,
    created_at: Date.now(),
    attachments: [],
    code_refs: [],
    draft_id: null,
    ...(status ? { status } : {}),
  };
  transcripts.set(convId, [...(transcripts.get(convId) ?? []), message]);
  const conv = conversations.find((c) => c.id === convId);
  if (conv) conv.last_activity_seq = message.seq;
  push({ kind: "messageAppended", conv_id: convId, message });
  return message;
}

// ── handlers ──────────────────────────────────────────────────────────────

/** Typing hints age out on a 6s timer and there is no "stopped" frame, so the
 *  echo is rate-limited rather than fired per keystroke. */
let lastTypingEcho = 0;

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface CommsResponses {
  comms_status: ConnectionInfo;
  comms_snapshot: CommsSnapshot;
  comms_base_url: string;
  comms_reconnect: Unit;
  comms_disconnect: Unit;
  comms_open_conversation: ConversationWindow;
  comms_conversation_snapshot: ConversationWindow;
  comms_close_conversation: Unit;
  comms_load_older: MessagePage;
  comms_search: MessagePage;
  comms_pins: ChatPin[];
  // Inline `invoke<{…}>` types in `comms-api.ts`, read off its wrappers.
  comms_send: Awaited<ReturnType<typeof comms.send>>;
  comms_edit: Unit;
  comms_delete: Unit;
  comms_react: Unit;
  comms_pin: Unit;
  comms_read: Unit;
  comms_typing: Unit;
  comms_upload_attachment: Awaited<ReturnType<typeof comms.uploadAttachment>>;
  comms_cancel_upload: Unit;
  comms_fetch_attachment: string;
  comms_save_attachment: Unit;
  comms_create_channel: ChatConversation;
  comms_create_dm: DmResult;
  comms_create_group_dm: ChatConversation;
  comms_join: ChatConversation;
  comms_leave: Unit;
  comms_invite: Unit;
  comms_patch_conversation: ChatConversation;
  comms_drafts: PromptDraft[];
  comms_create_draft: PromptDraft;
  comms_draft_open: Unit;
  comms_draft_update: Unit;
  comms_draft_awareness: Unit;
  comms_start_call: ChatCall;
  comms_features: ChatFeatures;
  comms_call_recordings: RecordingsResponse;
  comms_fetch_recording: string;
  comms_save_recording: Unit;
  comms_save_transcript: Unit;
}

export const commsHandlers: TypedHandlers<CommsResponses> = {
  comms_status: (): ConnectionInfo => connection,
  comms_snapshot: (): CommsSnapshot => ({
    connection,
    me: ME,
    conversations,
    discoverable,
    reads: [...reads.values()],
    online: ONLINE,
    calls: [...calls.values()],
  }),
  comms_base_url: (): string => "https://chat.acme.dev",

  comms_reconnect: (): null => {
    connection = { ...connection, state: "open", reason: null, epoch: connection.epoch + 1 };
    push({ kind: "connection", state: "open", reason: null, retry_at_ms: null });
    push({ kind: "resync" });
    return null;
  },
  comms_disconnect: (): null => {
    connection = { ...connection, state: "disconnected", reason: "offline" };
    push({ kind: "connection", state: "disconnected", reason: "offline", retry_at_ms: null });
    return null;
  },

  // ── reading ─────────────────────────────────────────────────────────────
  comms_open_conversation: ({ convId }): ConversationWindow => windowFor(String(convId)),
  comms_conversation_snapshot: ({ convId }): ConversationWindow => windowFor(String(convId)),
  comms_close_conversation: (): null => null,
  comms_load_older: ({ convId, beforeSeq, limit }): MessagePage => {
    const older = (archives.get(String(convId)) ?? []).filter((m) => m.seq < Number(beforeSeq));
    const size = Number(limit ?? 50);
    const page = older.slice(-size);
    return { messages: page, has_more: page.length < older.length };
  },
  // Newest-first, unlike history paging — a different order in the same shape
  // is exactly the kind of thing a fake gets quietly wrong.
  comms_search: ({ q, convId }): MessagePage => {
    const needle = String(q ?? "").toLowerCase();
    const pool = convId
      ? (transcripts.get(String(convId)) ?? [])
      : [...transcripts.values(), ...archives.values()].flat();
    const hits = pool
      .filter((m) => !m.deleted && m.body.toLowerCase().includes(needle))
      .sort((a, b) => b.seq - a.seq);
    return { messages: hits.slice(0, 25), has_more: hits.length > 25 };
  },
  comms_pins: ({ convId }): ChatPin[] => {
    const id = String(convId);
    const messages = transcripts.get(id) ?? [];
    return (pinsByConv.get(id) ?? []).map((messageId) => ({
      conv_id: id,
      message_id: messageId,
      pinned_by: PRIYA,
      at: NOW - 120 * MIN,
      // The pin rail carries its own message so it renders in one request —
      // and `null` is a real answer when the message has since been deleted.
      message: messages.find((m) => m.id === messageId) ?? null,
    }));
  },

  // ── writing ─────────────────────────────────────────────────────────────
  comms_send: ({ convId, body, replyToId, attachments }): { clientMsgId: string } => {
    const id = String(convId);
    const files = (attachments ?? []) as string[];
    const text = String(body ?? "");
    if (!text.trim() && files.length === 0) throw new Error("nothing to send");
    const message = appendMessage(id, ME, text);
    if (replyToId) {
      const updated: CommsMessage = { ...message, reply_to_id: String(replyToId) };
      transcripts.set(
        id,
        (transcripts.get(id) ?? []).map((m) => (m.id === message.id ? updated : m)),
      );
      push({ kind: "messageUpdated", conv_id: id, replaced_id: null, message: updated });
    }
    // Rust's `SendReceipt` is `#[serde(rename_all = "camelCase")]`, so the
    // wire key is `clientMsgId`. The frontend type used to say `client_msg_id`
    // (fixed) — nothing reads this value, the optimistic row is reconciled by
    // the `ack` event instead.
    return { clientMsgId: `cmid_${message.id}` };
  },
  comms_edit: ({ messageId, body }): null => {
    for (const [convId, list] of transcripts) {
      const found = list.find((m) => m.id === messageId);
      if (!found) continue;
      const updated: CommsMessage = { ...found, body: String(body), edited_at: Date.now() };
      transcripts.set(
        convId,
        list.map((m) => (m.id === updated.id ? updated : m)),
      );
      push({ kind: "messageUpdated", conv_id: convId, replaced_id: null, message: updated });
      return null;
    }
    throw new Error(`no message ${String(messageId)}`);
  },
  comms_delete: ({ messageId }): null => {
    for (const [convId, list] of transcripts) {
      const found = list.find((m) => m.id === messageId);
      if (!found) continue;
      // The row stays and the body goes — deleting a message must not open a
      // hole in a transcript someone else is replying into.
      const updated: CommsMessage = { ...found, body: "", attachments: [], deleted: true };
      transcripts.set(
        convId,
        list.map((m) => (m.id === updated.id ? updated : m)),
      );
      push({ kind: "messageUpdated", conv_id: convId, replaced_id: null, message: updated });
      return null;
    }
    throw new Error(`no message ${String(messageId)}`);
  },
  comms_react: ({ messageId, emoji, on }): null => {
    const id = String(messageId);
    const value = String(emoji);
    const at = reactionRows.findIndex(
      (row) => row.message_id === id && row.user_id === ME && row.emoji === value,
    );
    if (on && at === -1) reactionRows.push({ message_id: id, user_id: ME, emoji: value });
    if (!on && at !== -1) reactionRows.splice(at, 1);
    push({
      kind: "reactionsChanged",
      message_id: id,
      rows: reactionRows.filter((row) => row.message_id === id),
    });
    return null;
  },
  comms_pin: ({ messageId, on }): null => {
    const id = String(messageId);
    for (const [convId, list] of transcripts) {
      if (!list.some((m) => m.id === id)) continue;
      const rail = pinsByConv.get(convId) ?? [];
      // A rail is complete and authoritative for its conversation, so an unpin
      // is expressed by REPLACING it without the id, never by a union.
      const next = on ? [id, ...rail.filter((x) => x !== id)] : rail.filter((x) => x !== id);
      pinsByConv.set(convId, next);
      push({ kind: "pinsChanged", conv_id: convId, pinned_message_ids: next });
      return null;
    }
    return null;
  },
  comms_read: ({ convId, seq }): null => {
    const id = String(convId);
    const read: ChatReadState = {
      conv_id: id,
      last_read_seq: Number(seq),
      unread: 0,
      mentions: 0,
    };
    reads.set(id, read);
    push({ kind: "readChanged", read });
    return null;
  },
  comms_typing: ({ convId }): null => {
    // Echo somebody ELSE typing back, so the indicator is reachable without a
    // second client. Rate-limited: hints expire on a 6s timer and there is no
    // "stopped typing" frame to cancel a flood of them.
    const now = Date.now();
    if (now - lastTypingEcho < 4_000) return null;
    lastTypingEcho = now;
    push({ kind: "typing", conv_id: String(convId), user_id: PRIYA, at_ms: now });
    return null;
  },

  // ── attachments ─────────────────────────────────────────────────────────
  comms_upload_attachment: ({ uploadId, path }): { fileId: string } => {
    const id = String(uploadId);
    const total = 248_112;
    // Progress events start arriving before this resolves, which is the whole
    // reason `uploadId` is minted by the renderer — the chip has to be able to
    // match them before it has a file id.
    push({
      kind: "uploadProgress",
      upload_id: id,
      sent_bytes: Math.round(total * 0.4),
      total_bytes: total,
      state: "uploading",
      error: null,
    });
    setTimeout(() => {
      push({
        kind: "uploadProgress",
        upload_id: id,
        sent_bytes: total,
        total_bytes: total,
        state: "complete",
        error: null,
      });
    }, 600);
    return { fileId: `file_up_${String(path).split("/").pop() ?? id}` };
  },
  comms_cancel_upload: (): null => null,
  // Resolves to a local path the viewer feeds through `convertFileSrc`. The
  // seeded PNG is served as a data URL by `mockAssetUrl`, so an image
  // attachment actually shows an image rather than a broken box.
  comms_fetch_attachment: ({ fileId }): string =>
    String(fileId) === IMAGE_ATTACHMENT.id
      ? abs("public/logo.png")
      : abs(`.atlas/comms-cache/${String(fileId)}`),
  comms_save_attachment: (): null => null,

  // ── conversation lifecycle ──────────────────────────────────────────────
  comms_create_channel: ({ name, visibility, workspaceRefIds }): ChatConversation => {
    const conv = channel(`conv_new_${conversations.length}`, String(name), ++nextSeq, {
      visibility: visibility === "private" ? "private" : "public_org",
      workspace_ref_ids: (workspaceRefIds ?? []) as string[],
      created_by: ME,
      created_at: Date.now(),
    });
    conversations = [...conversations, conv];
    transcripts.set(conv.id, []);
    reads.set(conv.id, { conv_id: conv.id, last_read_seq: 0, unread: 0, mentions: 0 });
    announceConversations();
    return conv;
  },
  comms_create_dm: ({ userId }): DmResult => {
    const existing = conversations.find(
      (c) => c.kind === "dm" && (c.member_ids ?? []).includes(String(userId)),
    );
    // 200 vs 201 — the server makes this idempotent, and the UI reads the two
    // differently, so the fake has to be able to answer "already existed".
    if (existing) return { conversation: existing, created: false };
    const conv: ChatConversation = {
      id: `conv_dm_${String(userId)}`,
      kind: "dm",
      name: null,
      visibility: "private",
      workspace_ref_ids: [],
      created_by: ME,
      created_at: Date.now(),
      archived_at: null,
      seq: 1,
      member_ids: [ME, String(userId)],
      last_activity_seq: ++nextSeq,
    };
    conversations = [...conversations, conv];
    transcripts.set(conv.id, []);
    reads.set(conv.id, { conv_id: conv.id, last_read_seq: 0, unread: 0, mentions: 0 });
    announceConversations();
    return { conversation: conv, created: true };
  },
  comms_create_group_dm: ({ memberIds }): ChatConversation => {
    const members = (memberIds ?? []) as string[];
    const conv: ChatConversation = {
      id: `conv_group_${members.join("_")}`,
      kind: "group_dm",
      name: null,
      visibility: "private",
      workspace_ref_ids: [],
      created_by: ME,
      created_at: Date.now(),
      archived_at: null,
      seq: 1,
      member_ids: [ME, ...members],
      last_activity_seq: ++nextSeq,
    };
    conversations = [...conversations, conv];
    transcripts.set(conv.id, []);
    reads.set(conv.id, { conv_id: conv.id, last_read_seq: 0, unread: 0, mentions: 0 });
    announceConversations();
    return conv;
  },
  comms_join: ({ convId }): ChatConversation => {
    const id = String(convId);
    const conv = discoverable.find((c) => c.id === id);
    if (!conv) throw new Error(`cannot join ${id}`);
    discoverable = discoverable.filter((c) => c.id !== id);
    conversations = [...conversations, conv];
    transcripts.set(id, transcripts.get(id) ?? []);
    reads.set(id, { conv_id: id, last_read_seq: 0, unread: 0, mentions: 0 });
    announceConversations();
    return conv;
  },
  comms_leave: ({ convId, userId }): null => {
    const id = String(convId);
    // Leaving on someone else's behalf is a kick and leaves the channel in
    // our own list; only leaving ourselves removes it.
    if (userId && userId !== ME) {
      push({ kind: "memberChanged", conv_id: id, user_id: String(userId), change: "left" });
      return null;
    }
    conversations = conversations.filter((c) => c.id !== id);
    announceConversations();
    return null;
  },
  comms_invite: ({ convId, userId }): null => {
    push({
      kind: "memberChanged",
      conv_id: String(convId),
      user_id: String(userId),
      change: "joined",
    });
    return null;
  },
  comms_patch_conversation: ({ convId, name, archived, workspaceRefIds }): ChatConversation => {
    const conv = conversation(String(convId));
    if (name !== undefined) conv.name = String(name);
    if (archived !== undefined) conv.archived_at = archived ? Date.now() : null;
    if (workspaceRefIds !== undefined) conv.workspace_ref_ids = workspaceRefIds as string[];
    announceConversations();
    return conv;
  },

  // ── prompt drafts ───────────────────────────────────────────────────────
  // Poll-owned by the caller; the server announces nothing about the LIST, so
  // an unanswered `comms_drafts` is a tab that shimmers forever.
  comms_drafts: ({ convId }): PromptDraft[] => drafts.get(String(convId)) ?? [],
  comms_create_draft: ({ convId, title }): PromptDraft => {
    const id = String(convId);
    const draft: PromptDraft = {
      id: `draft_${Date.now()}`,
      conv_id: id,
      title: String(title),
      created_by: ME,
      created_at: Date.now(),
      updated_at: Date.now(),
      sent_at: null,
      sent_by: null,
      sent_message_id: null,
    };
    drafts.set(id, [draft, ...(drafts.get(id) ?? [])]);
    return draft;
  },
  comms_draft_open: ({ draftId }): null => {
    const id = String(draftId);
    const draft = [...drafts.values()].flat().find((d) => d.id === id);
    if (!draft) return null;
    // The subscription is answered with an event, not a return value — a
    // handler that only resolved would leave the editor waiting forever.
    // `snapshot: null` with no updates is a legitimate empty document: the
    // server stores opaque Yjs bytes it cannot read, and has none yet.
    push({ kind: "draftOpened", draft_id: id, draft, snapshot: null, updates: [] });
    return null;
  },
  comms_draft_update: (): null => null,
  comms_draft_awareness: (): null => null,

  // ── calls ───────────────────────────────────────────────────────────────
  // The server's rules, as far as the header can see them: no provider means
  // a Meeting, a Meeting needs `calls.paid` (off here, per MOCK_FEATURES),
  // and a Voice Call is audio-only, guest-less, one live per conversation.
  comms_start_call: ({ convId, mode, public: isPublic, provider }): ChatCall => {
    // Thrown as the Rust bridge rejects: the refusal envelope as a string.
    const refuse = (code: string, message: string) => JSON.stringify({ code, message });
    if (provider === "mesh") {
      if (mode !== "audio" || isPublic) {
        throw refuse("bad_request", "A voice call is audio only and has no guest link.");
      }
      for (const live of calls.values()) {
        if (live.conv_id === String(convId) && live.ended_at === null) return live;
      }
    } else if (!MOCK_FEATURES.features["calls.paid"]) {
      throw refuse("feature_disabled", "Meetings are not available on this Organization's plan.");
    }
    const call: ChatCall = {
      id: `call_${Date.now()}`,
      conv_id: String(convId),
      mode: mode === "video" ? "video" : "audio",
      started_by: ME,
      started_at: Date.now(),
      ended_at: null,
      seq: ++nextSeq,
      transcript_state: "none",
      join_slug: isPublic ? `guest-${Date.now()}` : null,
      recording_state: "off",
    };
    calls.set(call.id, call);
    push({ kind: "callChanged", call });
    return call;
  },
  comms_features: (): ChatFeatures => MOCK_FEATURES,
  // Links are minted per read and die in ~60s, so this is asked at open time
  // and never cached. A call with nothing kept answers with an empty list.
  comms_call_recordings: ({ callId }): RecordingsResponse =>
    RECORDINGS.get(String(callId)) ?? { state: "off", tracks: [] },
  comms_fetch_recording: ({ trackId, filename }): string => {
    const id = String(trackId);
    push({
      kind: "downloadProgress",
      download_id: id,
      got_bytes: 0,
      total_bytes: 8_412_006,
      state: "downloading",
      error: null,
    });
    setTimeout(() => {
      push({
        kind: "downloadProgress",
        download_id: id,
        got_bytes: 8_412_006,
        total_bytes: 8_412_006,
        state: "complete",
        error: null,
      });
    }, 700);
    return abs(`.atlas/comms-cache/${String(filename)}`);
  },
  comms_save_recording: (): null => null,
  comms_save_transcript: (): null => null,
};

/**
 * Console trigger: a message arrives while you are looking at something else.
 *
 * Typing hint first, then the message a beat later, because that is the order
 * a real socket delivers them in and the hint's removal is driven by the
 * message landing rather than by its own timer.
 */
const INCOMING = [
  "One more thing before you go — the anchor test is green on CI.",
  "<@usr_dev> can you take a look at the follow-up when you have a minute?",
  "Pushed the fix. Numbers are 6.2ms median, 9ms worst.\n\n```ts\nconst SCROLL_BOTTOM = 1 << 30;\n```",
  "Never mind, found it.",
];
let incomingAt = 0;

export function commsIncomingMessage(): void {
  const body = INCOMING[incomingAt++ % INCOMING.length];
  push({ kind: "typing", conv_id: DESKTOP, user_id: PRIYA, at_ms: Date.now() });
  setTimeout(() => {
    appendMessage(DESKTOP, PRIYA, body);
    // The badge is server-held, so an arriving message only counts if the
    // read table says so — nothing in the frontend increments it.
    const current = reads.get(DESKTOP);
    const read: ChatReadState = {
      conv_id: DESKTOP,
      last_read_seq: current?.last_read_seq ?? 0,
      unread: (current?.unread ?? 0) + 1,
      mentions: (current?.mentions ?? 0) + (body.includes(`<@${ME}>`) ? 1 : 0),
    };
    reads.set(DESKTOP, read);
    push({ kind: "readChanged", read });
  }, 1_200);
}
