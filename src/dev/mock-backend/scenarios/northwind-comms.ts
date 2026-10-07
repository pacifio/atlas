// The `northwind` scenario's account and team chat: who is signed in, the one
// organisation they belong to, its members, and the two channels the videos
// are recorded in — plus the Prompt Drafts in them, as REAL Yjs documents, so
// what is typed survives a reopen and a teammate's edit arrives the way the
// socket delivers it.
//
// Everything is built from `northwind-world.ts`: the cast, the org ids, the
// chat messages and drafts in `northwind-content.ts`, the times. Nothing here
// writes prose except the one line in the Zuhayer DM.
//
// Same rules as `fixtures/comms.ts`, which this mirrors: the comms store is a
// PROJECTION, so every write mutates the state below and then announces itself
// on `atlas:comms` with an envelope whose `org` is the connection's org — a
// different org there makes the store reset and re-hydrate instead of update.
// Every wire object is snake_case; the renamed DTOs are camelCase.
//
// The cue helpers at the bottom (`zuhayerOnline`, `zuhayerMessage`, `postAsMe`,
// `zuhayerDraftEdit`, `zuhayerTyping`) are what the coordinator binds to keys
// during a take.

import { emit } from "@tauri-apps/api/event";
import * as Y from "yjs";

import type {
  AccountOrg,
  AuthSnapshot,
  CreatedOrg,
  OrgInvitation,
  OrgMember,
  Role,
} from "@/features/auth/lib/auth-api";
import type {
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
  encodeAwareness,
  fromBase64,
  PROMPT_TEXT_KEY,
  REMOTE,
  toBase64,
} from "@/features/comms/lib/draft-sync";
import {
  CHAT_REACTION_EMOJI,
  type ChatCall,
  type ChatConversation,
  type ChatFeatures,
  type ChatPin,
  type ChatReaction,
  type ChatReadState,
  type ChatSessionReference,
  type CommsMessage,
  type PromptDraft,
} from "@/features/comms/types";
import type { MockResponses, TypedHandlers } from "../types";
import type {
  ChannelKey,
  ChatMessageContent,
  DraftContent,
  PersonKey,
  ReactionName,
} from "./northwind-content-types";
import { CONTENT } from "./northwind-content";
import {
  addMessage,
  AGENT_LABEL,
  chat,
  commitByKey,
  LOAD,
  nowWhen,
  ME,
  ORG_NAME,
  ORG_REMOTE_ID,
  PEOPLE,
  personByUserId,
  presence,
  REMOTE_PROJECT_ID,
  rowId,
  session,
  sessionContent,
  userIdOf,
  whenMs,
} from "./northwind-world";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Rust's `Err(String)`: callers branch on a bare string, never an Error. */
function fail(message: string): never {
  // oxlint-disable-next-line no-throw-literal -- Rust's `Err(String)`, not an Error.
  throw message;
}

// ── Account and organisation ─────────────────────────────────────────────

/**
 * The account's one organisation. `id` is the SERVER id, and must equal the
 * local org row's `remoteId` (`bootstrap_app_state`): the members modal, the
 * comms roster and the socket all key off it, and a mismatch opens an empty
 * members table and an empty chat that both look like UI bugs. The name must
 * equal the local row's too — `mergeServerOrgs` copies the server's name onto
 * a linked row.
 */
const NORTHWIND: AccountOrg = { id: ORG_REMOTE_ID, name: ORG_NAME, role: "admin" };

const SIGNED_IN: AuthSnapshot = {
  status: "signed-in",
  // No photo: Uzayer renders as initials, like every teammate.
  user: { id: ME.userId, name: ME.name, email: ME.email, avatarPath: null },
  orgs: [NORTHWIND],
  activeOrgId: ORG_REMOTE_ID,
  commsOrgId: ORG_REMOTE_ID,
};

let auth: AuthSnapshot = structuredClone(SIGNED_IN);
let grantTimer: number | null = null;

function broadcastAuth(): null {
  void emit("atlas:auth-changed", auth);
  return null;
}

const currentOrgs = (): AccountOrg[] => (auth.status === "signed-in" ? (auth.orgs ?? []) : []);

const isoDaysAgo = (days: number): string => new Date(LOAD - days * DAY).toISOString();

let members: OrgMember[] = Object.values(PEOPLE).map((p) => ({
  id: p.memberId,
  userId: p.userId,
  name: p.name,
  email: p.email,
  role: p.role,
  createdAt: isoDaysAgo(p.joinedDaysAgo),
  avatarPath: null,
  isOwner: p.isOwner,
}));

let invitations: OrgInvitation[] = [];
let invitesMinted = 0;

const TAKEN_SLUGS = new Set(["northwind", "atlas", "support"]);

// ── Conversations ────────────────────────────────────────────────────────

export const CONV_ID: Record<ChannelKey, string> = {
  shop: "conv_nw_shop",
  general: "conv_nw_general",
};
export const DM_ZUHAYER_ID = "conv_nw_dm_zuhayer";

const channelKeyOf = (convId: string): ChannelKey | undefined =>
  (Object.keys(CONV_ID) as ChannelKey[]).find((k) => CONV_ID[k] === convId);

const ORG_CREATED = LOAD - ME.joinedDaysAgo * DAY;

function channel(id: string, name: string, workspaceRefIds: string[]): ChatConversation {
  return {
    id,
    kind: "channel",
    name,
    visibility: "public_org",
    // The Projects a channel is scoped to, by registry (Workspace) id.
    workspace_ref_ids: workspaceRefIds,
    created_by: ME.userId,
    created_at: ORG_CREATED + 20 * MIN,
    archived_at: null,
    seq: 1,
    member_ids: null,
    last_activity_seq: 0,
  };
}

let conversations: ChatConversation[] = [
  channel(CONV_ID.shop, "shop", [REMOTE_PROJECT_ID]),
  channel(CONV_ID.general, "general", []),
  {
    id: DM_ZUHAYER_ID,
    kind: "dm",
    name: null,
    visibility: "private",
    workspace_ref_ids: [],
    created_by: userIdOf("zuhayer"),
    created_at: ORG_CREATED + 3 * 60 * MIN,
    archived_at: null,
    seq: 1,
    member_ids: [ME.userId, userIdOf("zuhayer")],
    last_activity_seq: 0,
  },
];

const transcripts = new Map<string, CommsMessage[]>(conversations.map((c) => [c.id, []]));
const reactionRows: ChatReaction[] = [];
const pinsByConv = new Map<string, string[]>();
const reads = new Map<string, ChatReadState>();

let nextSeq = 0;
let connection: ConnectionInfo = { state: "open", reason: null, epoch: 1, orgId: ORG_REMOTE_ID };

function push(ev: CommsEvent): void {
  const envelope: CommsEnvelope = { org: ORG_REMOTE_ID, epoch: connection.epoch, ev };
  void emit("atlas:comms", envelope);
}

function conversation(convId: string): ChatConversation {
  const found = conversations.find((c) => c.id === convId);
  if (!found) throw new Error(`[northwind] no conversation ${convId}`);
  return found;
}

const onlineIds = (): string[] => [...presence.online].map(userIdOf);

// ── Session cards ────────────────────────────────────────────────────────

/**
 * The card a message carries, as the sender's snapshot of the Session (or one
 * commit inside it). Opening it reads `artifacts_cloud_session` for
 * `REMOTE_PROJECT_ID` + `session_id`; a checkpoint card then focuses the
 * checkpoint entry whose `commitSha` equals `commit_sha`.
 */
export function sessionReference(ref: {
  session: string;
  checkpoint?: string;
}): ChatSessionReference | null {
  const state = session(ref.session);
  const content = state?.content ?? sessionContent(ref.session);
  if (!content) return null;
  const steps = state?.steps ?? content.steps;
  if (ref.checkpoint) {
    const commit = commitByKey(ref.checkpoint);
    if (!commit) return null;
    const step = steps.find((s) => s.kind === "checkpoint" && s.commit === commit.key);
    return {
      kind: "checkpoint",
      workspace_ref_id: REMOTE_PROJECT_ID,
      session_id: content.id,
      session_title: content.title,
      row_id: rowId(content.id, step?.id ?? commit.key),
      commit_sha: commit.sha,
      branch: content.branch,
      insertions: commit.files.reduce((n, f) => n + f.insertions, 0),
      deletions: commit.files.reduce((n, f) => n + f.deletions, 0),
      files: new Set(commit.files.map((f) => f.path)).size,
    };
  }
  return {
    kind: "session",
    workspace_ref_id: REMOTE_PROJECT_ID,
    session_id: content.id,
    session_title: content.title,
    agent: AGENT_LABEL[content.agent],
    started_at: state?.startMs ?? whenMs(content.started),
    messages: steps.filter((s) => s.kind === "prompt" || s.kind === "response").length,
    tool_calls: steps.filter((s) => s.kind === "tool").length,
    checkpoints: steps.filter((s) => s.kind === "checkpoint").length,
  };
}

// ── Messages ─────────────────────────────────────────────────────────────

/** Reactions come FROM the server allowlist — two entries carry an invisible
 *  variation selector, and a hand-typed copy would be a different string. */
const EMOJI: Record<ReactionName, string> = {
  thumbsUp: CHAT_REACTION_EMOJI[0],
  eyes: CHAT_REACTION_EMOJI[4],
  rocket: CHAT_REACTION_EMOJI[5],
  fire: CHAT_REACTION_EMOJI[6],
  heart: CHAT_REACTION_EMOJI[14],
  check: CHAT_REACTION_EMOJI[15],
};

/** World message ids already in a transcript. */
const known = new Set<string>();

function toWire(m: ChatMessageContent, seq: number, createdAt: number): CommsMessage {
  const ref = m.sessionRef ? sessionReference(m.sessionRef) : null;
  return {
    id: m.id,
    conv_id: CONV_ID[m.channel],
    seq,
    author_id: userIdOf(m.author),
    body: m.body,
    reply_to_id: m.replyTo ?? null,
    edited_at: null,
    created_at: createdAt,
    attachments: [],
    code_refs: [],
    ...(ref ? { artifact_refs: [ref] } : {}),
    draft_id: m.draft ?? null,
  };
}

function append(message: CommsMessage): void {
  const convId = message.conv_id;
  transcripts.set(convId, [...(transcripts.get(convId) ?? []), message]);
  const conv = conversations.find((c) => c.id === convId);
  if (conv) conv.last_activity_seq = message.seq;
}

function addReactions(m: ChatMessageContent): void {
  for (const [name, people] of m.reactions ?? []) {
    for (const person of people) {
      reactionRows.push({ message_id: m.id, user_id: userIdOf(person), emoji: EMOJI[name] });
    }
  }
}

/** Seed: the world's chat, oldest first, on one org-wide `seq`. */
function seed(): void {
  const ordered = chat()
    .map((m, i) => ({ m, i, at: whenMs(m.when) }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  // The DM's one line sits between the seeded channel history, by time.
  const dm: CommsMessage = {
    id: "m-dm-zuhayer-01",
    conv_id: DM_ZUHAYER_ID,
    seq: 0,
    author_id: userIdOf("zuhayer"),
    body: "Added you to the northwind-shop repo. `bun run dev` and it's on localhost:3000.",
    reply_to_id: null,
    edited_at: null,
    created_at: ORG_CREATED + 3 * 60 * MIN,
    attachments: [],
    code_refs: [],
    draft_id: null,
  };
  let dmPlaced = false;
  for (const { m, at } of ordered) {
    if (!dmPlaced && dm.created_at < at) {
      append({ ...dm, seq: ++nextSeq });
      dmPlaced = true;
    }
    known.add(m.id);
    append(toWire(m, ++nextSeq, at));
    addReactions(m);
  }
  if (!dmPlaced) append({ ...dm, seq: ++nextSeq });
  // Caught up everywhere: the recording opens on a clean sidebar.
  for (const conv of conversations) {
    reads.set(conv.id, {
      conv_id: conv.id,
      last_read_seq: conv.last_activity_seq,
      unread: 0,
      mentions: 0,
    });
  }
}
seed();

/**
 * Fold in world messages another adapter added with `addMessage` (or that
 * became visible because their Session now exists), announcing each the way
 * the socket would.
 */
function syncFromWorld(): void {
  for (const m of chat()) {
    if (known.has(m.id)) continue;
    known.add(m.id);
    const message = toWire(m, ++nextSeq, Math.max(Date.now(), whenMs(m.when)));
    append(message);
    addReactions(m);
    push({ kind: "messageAppended", conv_id: message.conv_id, message });
    if (message.author_id === ME.userId) markRead(message.conv_id);
    else bumpUnread(message.conv_id, message.body);
  }
}

function markRead(convId: string): void {
  const read: ChatReadState = {
    conv_id: convId,
    last_read_seq: conversation(convId).last_activity_seq,
    unread: 0,
    mentions: 0,
  };
  reads.set(convId, read);
  push({ kind: "readChanged", read });
}

/** Unread counts are server-held; nothing in the frontend increments them. If
 *  the conversation is on screen the panel reads it straight back. */
function bumpUnread(convId: string, body: string): void {
  const current = reads.get(convId);
  const read: ChatReadState = {
    conv_id: convId,
    last_read_seq: current?.last_read_seq ?? 0,
    unread: (current?.unread ?? 0) + 1,
    mentions: (current?.mentions ?? 0) + (body.includes(`<@${ME.userId}>`) ? 1 : 0),
  };
  reads.set(convId, read);
  push({ kind: "readChanged", read });
}

let liveCount = 0;

/** Post a message now, as `author`, and record it in the world too. */
function post(
  channelKey: ChannelKey,
  author: PersonKey,
  body: string,
  sessionRef?: { session: string; checkpoint?: string },
  replyTo?: string,
): CommsMessage {
  syncFromWorld();
  const content: ChatMessageContent = {
    id: `m-live-${++liveCount}`,
    channel: channelKey,
    author,
    body,
    when: nowWhen(),
    ...(sessionRef ? { sessionRef } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
  known.add(content.id);
  addMessage(content);
  const message = toWire(content, ++nextSeq, Date.now());
  append(message);
  push({ kind: "messageAppended", conv_id: message.conv_id, message });
  return message;
}

function windowFor(convId: string): ConversationWindow {
  syncFromWorld();
  const messages = transcripts.get(convId) ?? [];
  const ids = new Set(messages.map((m) => m.id));
  return {
    messages,
    reactions: reactionRows.filter((row) => ids.has(row.message_id)),
    pinned_message_ids: pinsByConv.get(convId) ?? [],
  };
}

function findMessage(messageId: string): CommsMessage | undefined {
  for (const list of transcripts.values()) {
    const found = list.find((m) => m.id === messageId);
    if (found) return found;
  }
  return undefined;
}

function replaceMessage(updated: CommsMessage): void {
  const list = transcripts.get(updated.conv_id) ?? [];
  transcripts.set(
    updated.conv_id,
    list.map((m) => (m.id === updated.id ? updated : m)),
  );
  push({ kind: "messageUpdated", conv_id: updated.conv_id, replaced_id: null, message: updated });
}

function announceConversations(): void {
  push({ kind: "conversationsChanged", conversations, discoverable: [] });
}

// ── Prompt drafts ────────────────────────────────────────────────────────

const draftMeta = new Map<string, PromptDraft>();
/** ONE server-side document per draft: the store's opaque bytes, readable here. */
const draftDocs = new Map<string, Y.Doc>();

function seedDraft(d: DraftContent): void {
  const meta: PromptDraft = {
    id: d.id,
    conv_id: CONV_ID[d.channel],
    title: d.title,
    created_by: userIdOf(d.createdBy),
    created_at: whenMs(d.created),
    updated_at: whenMs(d.updated),
    sent_at: d.sent ? whenMs(d.sent.when) : null,
    sent_by: d.sent ? userIdOf(d.sent.by) : null,
    sent_message_id: d.sent?.message ?? null,
  };
  draftMeta.set(d.id, meta);
  const doc = new Y.Doc();
  doc.getText(PROMPT_TEXT_KEY).insert(0, d.text);
  draftDocs.set(d.id, doc);
}
for (const d of CONTENT.drafts) seedDraft(d);

function draftDoc(draftId: string): Y.Doc {
  let doc = draftDocs.get(draftId);
  if (!doc) {
    doc = new Y.Doc();
    draftDocs.set(draftId, doc);
  }
  return doc;
}

function touchDraft(draftId: string): void {
  const meta = draftMeta.get(draftId);
  if (meta) draftMeta.set(draftId, { ...meta, updated_at: Date.now() });
}

/** The text of a draft right now, as the server document holds it. */
export function draftText(draftId: string): string {
  return draftDoc(draftId).getText(PROMPT_TEXT_KEY).toString();
}

const ZUHAYER_EDIT = Symbol("zuhayer-edit");

// ── Handlers ─────────────────────────────────────────────────────────────

const FEATURES: ChatFeatures = {
  features: { "calls.mesh": true, "calls.paid": false, "chat.webhooks": true },
  mesh_call_max: 20,
};

const calls = new Map<string, ChatCall>();

export const northwindCommsCommands: Partial<TypedHandlers<MockResponses>> = {
  // ── Atlas account ──────────────────────────────────────────────────────
  auth_snapshot: (): AuthSnapshot => auth,
  auth_refresh: (): AuthSnapshot => {
    broadcastAuth();
    return auth;
  },
  auth_sign_in: (): AuthSnapshot => {
    auth = {
      status: "connecting",
      userCode: "QHPX-RKTN",
      verificationUri: "https://app.tryatlas.cc/device",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    broadcastAuth();
    grantTimer = window.setTimeout(() => {
      grantTimer = null;
      if (auth.status !== "connecting") return;
      auth = structuredClone(SIGNED_IN);
      broadcastAuth();
    }, 2_000);
    return auth;
  },
  auth_cancel_sign_in: (): AuthSnapshot => {
    if (grantTimer !== null) clearTimeout(grantTimer);
    grantTimer = null;
    auth = { status: "signed-out" };
    broadcastAuth();
    return auth;
  },
  auth_sign_out: (): boolean => {
    auth = { status: "signed-out" };
    broadcastAuth();
    return true;
  },
  auth_set_active_org: ({ orgId }): null => {
    if (auth.status !== "signed-in") return null;
    const id = orgId === null || orgId === undefined ? null : String(orgId);
    auth = { ...auth, activeOrgId: id ?? auth.orgs?.[0]?.id ?? null, commsOrgId: id };
    return broadcastAuth();
  },
  auth_create_org: ({ name, slug }): CreatedOrg => {
    const handle = String(slug);
    if (TAKEN_SLUGS.has(handle)) fail(`The handle “${handle}” is already taken.`);
    TAKEN_SLUGS.add(handle);
    const created: CreatedOrg = { id: `org_${handle}`, name: String(name) };
    if (auth.status === "signed-in") {
      auth = { ...auth, orgs: [...currentOrgs(), { ...created, role: "admin" }] };
      broadcastAuth();
    }
    return created;
  },
  auth_delete_org: ({ remoteId }): null => {
    if (auth.status === "signed-in") {
      auth = { ...auth, orgs: currentOrgs().filter((o) => o.id !== String(remoteId)) };
      broadcastAuth();
    }
    return null;
  },
  auth_check_org_slug: ({ slug }): boolean => {
    const handle = String(slug ?? "");
    if (handle.length < 3) fail("Handles must be at least 3 characters.");
    return !TAKEN_SLUGS.has(handle);
  },
  auth_list_members: ({ orgId }): OrgMember[] =>
    String(orgId) === ORG_REMOTE_ID ? members.map((m) => ({ ...m })) : [],
  auth_list_invitations: ({ orgId }): OrgInvitation[] =>
    String(orgId) === ORG_REMOTE_ID ? invitations.map((i) => ({ ...i })) : [],
  auth_invite_member: ({ email, role }): OrgInvitation => {
    const address = String(email).trim();
    if (members.some((m) => m.email === address)) {
      fail("Couldn't invite them — you may not be an admin, or they're already in.");
    }
    invitesMinted += 1;
    const invitation: OrgInvitation = {
      id: `inv_nw_${invitesMinted}`,
      email: address,
      role: (role ?? "member") as Role,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
      acceptUrl: `https://app.tryatlas.cc/invite/${invitesMinted}x7Rk2pQm`,
    };
    invitations = [invitation, ...invitations];
    return invitation;
  },
  auth_cancel_invitation: ({ invitationId }): null => {
    invitations = invitations.filter((i) => i.id !== String(invitationId));
    return null;
  },
  auth_update_member_role: ({ memberId, role }): null => {
    const target = members.find((m) => m.id === String(memberId));
    if (!target) fail("Only an admin can change a member's role.");
    if (target.isOwner) fail("The organization's owner is always an admin.");
    target.role = (role ?? null) as Role | null;
    return null;
  },
  auth_remove_member: ({ memberIdOrEmail }): null => {
    const key = String(memberIdOrEmail);
    const target = members.find((m) => m.id === key || m.email === key);
    if (!target) fail("Only an admin can remove a member.");
    if (target.isOwner) fail("The organization's owner cannot be removed.");
    members = members.filter((m) => m !== target);
    return null;
  },
  auth_leave_org: (): null => fail("The organization's owner cannot leave it."),

  // ── Team chat: connection ──────────────────────────────────────────────
  comms_status: (): ConnectionInfo => connection,
  comms_snapshot: (): CommsSnapshot => {
    syncFromWorld();
    return {
      connection,
      me: ME.userId,
      conversations,
      discoverable: [],
      reads: [...reads.values()],
      online: onlineIds(),
      calls: [...calls.values()],
    };
  },
  comms_base_url: (): string => "https://chat.tryatlas.cc",
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

  // ── reading ────────────────────────────────────────────────────────────
  comms_open_conversation: ({ convId }): ConversationWindow => windowFor(String(convId)),
  comms_conversation_snapshot: ({ convId }): ConversationWindow => windowFor(String(convId)),
  comms_close_conversation: (): null => null,
  // The whole history fits in the first window.
  comms_load_older: (): MessagePage => ({ messages: [], has_more: false }),
  comms_search: ({ q, convId }): MessagePage => {
    const needle = String(q ?? "").toLowerCase();
    const pool = convId
      ? (transcripts.get(String(convId)) ?? [])
      : [...transcripts.values()].flat();
    const hits = pool
      .filter((m) => !m.deleted && m.body.toLowerCase().includes(needle))
      .sort((a, b) => b.seq - a.seq);
    return { messages: hits.slice(0, 25), has_more: hits.length > 25 };
  },
  comms_pins: ({ convId }): ChatPin[] => {
    const id = String(convId);
    return (pinsByConv.get(id) ?? []).map((messageId) => ({
      conv_id: id,
      message_id: messageId,
      pinned_by: ME.userId,
      at: Date.now(),
      message: findMessage(messageId) ?? null,
    }));
  },

  // ── writing ────────────────────────────────────────────────────────────
  comms_send: ({ convId, body, replyToId, attachments }): { clientMsgId: string } => {
    const id = String(convId);
    const text = String(body ?? "");
    const files = (attachments ?? []) as string[];
    if (!text.trim() && files.length === 0) throw new Error("nothing to send");
    const key = channelKeyOf(id);
    let message: CommsMessage;
    if (key) {
      message = post(key, "uzayer", text, undefined, replyToId ? String(replyToId) : undefined);
    } else {
      message = {
        id: `m-live-${++liveCount}`,
        conv_id: id,
        seq: ++nextSeq,
        author_id: ME.userId,
        body: text,
        reply_to_id: replyToId ? String(replyToId) : null,
        edited_at: null,
        created_at: Date.now(),
        attachments: [],
        code_refs: [],
        draft_id: null,
      };
      append(message);
      push({ kind: "messageAppended", conv_id: id, message });
    }
    markRead(id);
    return { clientMsgId: `cmid_${message.id}` };
  },
  comms_edit: ({ messageId, body }): null => {
    const found = findMessage(String(messageId));
    if (!found) throw new Error(`no message ${String(messageId)}`);
    replaceMessage({ ...found, body: String(body), edited_at: Date.now() });
    return null;
  },
  comms_delete: ({ messageId }): null => {
    const found = findMessage(String(messageId));
    if (!found) throw new Error(`no message ${String(messageId)}`);
    replaceMessage({ ...found, body: "", attachments: [], artifact_refs: [], deleted: true });
    return null;
  },
  comms_react: ({ messageId, emoji, on }): null => {
    const id = String(messageId);
    const value = String(emoji);
    const at = reactionRows.findIndex(
      (row) => row.message_id === id && row.user_id === ME.userId && row.emoji === value,
    );
    if (on && at === -1) reactionRows.push({ message_id: id, user_id: ME.userId, emoji: value });
    if (!on && at !== -1) reactionRows.splice(at, 1);
    push({
      kind: "reactionsChanged",
      message_id: id,
      rows: reactionRows.filter((row) => row.message_id === id),
    });
    return null;
  },
  comms_pin: ({ messageId, on }): null => {
    const found = findMessage(String(messageId));
    if (!found) return null;
    const rail = pinsByConv.get(found.conv_id) ?? [];
    const next = on
      ? [found.id, ...rail.filter((x) => x !== found.id)]
      : rail.filter((x) => x !== found.id);
    pinsByConv.set(found.conv_id, next);
    push({ kind: "pinsChanged", conv_id: found.conv_id, pinned_message_ids: next });
    return null;
  },
  comms_read: ({ convId, seq }): null => {
    const id = String(convId);
    const read: ChatReadState = { conv_id: id, last_read_seq: Number(seq), unread: 0, mentions: 0 };
    reads.set(id, read);
    push({ kind: "readChanged", read });
    return null;
  },
  // Nobody else is typing unless a cue says so.
  comms_typing: (): null => null,

  // ── attachments (never used on camera; answered so nothing hangs) ──────
  comms_upload_attachment: ({ uploadId }): { fileId: string } => {
    push({
      kind: "uploadProgress",
      upload_id: String(uploadId),
      sent_bytes: 1,
      total_bytes: 1,
      state: "complete",
      error: null,
    });
    return { fileId: `file_${String(uploadId)}` };
  },
  comms_cancel_upload: (): null => null,
  comms_save_attachment: (): null => null,

  // ── conversation lifecycle ─────────────────────────────────────────────
  comms_create_channel: ({ name, visibility, workspaceRefIds }): ChatConversation => {
    const conv: ChatConversation = {
      ...channel(`conv_nw_${String(name)}`, String(name), (workspaceRefIds ?? []) as string[]),
      visibility: visibility === "private" ? "private" : "public_org",
      created_at: Date.now(),
      last_activity_seq: ++nextSeq,
    };
    conversations = [...conversations, conv];
    transcripts.set(conv.id, []);
    reads.set(conv.id, {
      conv_id: conv.id,
      last_read_seq: conv.last_activity_seq,
      unread: 0,
      mentions: 0,
    });
    announceConversations();
    return conv;
  },
  comms_create_dm: ({ userId }): DmResult => {
    const other = String(userId);
    const existing = conversations.find(
      (c) => c.kind === "dm" && (c.member_ids ?? []).includes(other),
    );
    if (existing) return { conversation: existing, created: false };
    const conv: ChatConversation = {
      id: `conv_nw_dm_${personByUserId(other)?.key ?? other}`,
      kind: "dm",
      name: null,
      visibility: "private",
      workspace_ref_ids: [],
      created_by: ME.userId,
      created_at: Date.now(),
      archived_at: null,
      seq: 1,
      member_ids: [ME.userId, other],
      last_activity_seq: ++nextSeq,
    };
    conversations = [...conversations, conv];
    transcripts.set(conv.id, []);
    reads.set(conv.id, {
      conv_id: conv.id,
      last_read_seq: conv.last_activity_seq,
      unread: 0,
      mentions: 0,
    });
    announceConversations();
    return { conversation: conv, created: true };
  },
  comms_create_group_dm: ({ memberIds }): ChatConversation => {
    const ids = (memberIds ?? []) as string[];
    const conv: ChatConversation = {
      id: `conv_nw_group_${ids.join("_")}`,
      kind: "group_dm",
      name: null,
      visibility: "private",
      workspace_ref_ids: [],
      created_by: ME.userId,
      created_at: Date.now(),
      archived_at: null,
      seq: 1,
      member_ids: [ME.userId, ...ids],
      last_activity_seq: ++nextSeq,
    };
    conversations = [...conversations, conv];
    transcripts.set(conv.id, []);
    reads.set(conv.id, {
      conv_id: conv.id,
      last_read_seq: conv.last_activity_seq,
      unread: 0,
      mentions: 0,
    });
    announceConversations();
    return conv;
  },
  comms_join: ({ convId }): ChatConversation => conversation(String(convId)),
  comms_leave: ({ convId, userId }): null => {
    const id = String(convId);
    if (userId && userId !== ME.userId) {
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

  // ── prompt drafts ──────────────────────────────────────────────────────
  comms_drafts: ({ convId }): PromptDraft[] =>
    [...draftMeta.values()]
      .filter((d) => d.conv_id === String(convId))
      .sort((a, b) => b.updated_at - a.updated_at),
  // The server announces nothing about creation; the tab folds in the answer.
  comms_create_draft: ({ convId, title }): PromptDraft => {
    const now = Date.now();
    const draft: PromptDraft = {
      id: `d-live-${now.toString(36)}`,
      conv_id: String(convId),
      title: String(title),
      created_by: ME.userId,
      created_at: now,
      updated_at: now,
      sent_at: null,
      sent_by: null,
      sent_message_id: null,
    };
    draftMeta.set(draft.id, draft);
    draftDoc(draft.id);
    return draft;
  },
  comms_draft_open: ({ draftId }): null => {
    const id = String(draftId);
    const draft = draftMeta.get(id);
    if (!draft) return null;
    const snapshot = toBase64(Y.encodeStateAsUpdate(draftDoc(id)));
    // Answered by event, never by return value — as the socket answers it.
    setTimeout(() => push({ kind: "draftOpened", draft_id: id, draft, snapshot, updates: [] }), 40);
    return null;
  },
  comms_draft_update: ({ draftId, update }): null => {
    const id = String(draftId);
    const meta = draftMeta.get(id);
    if (!meta || meta.sent_at !== null) return null;
    const bytes = fromBase64(String(update));
    if (!bytes || bytes.length === 0) return null;
    try {
      Y.applyUpdate(draftDoc(id), bytes, REMOTE);
      touchDraft(id);
    } catch (e) {
      console.warn("[northwind] malformed draft update:", e);
    }
    return null;
  },
  comms_draft_awareness: (): null => null,

  // ── calls (not on camera; the header still asks) ───────────────────────
  comms_start_call: ({ convId, mode, public: isPublic, provider }): ChatCall => {
    if (provider !== "mesh" && !FEATURES.features["calls.paid"]) {
      throw JSON.stringify({
        code: "feature_disabled",
        message: "Meetings are not available on this Organization's plan.",
      });
    }
    const call: ChatCall = {
      id: `call_${Date.now()}`,
      conv_id: String(convId),
      mode: mode === "video" ? "video" : "audio",
      started_by: ME.userId,
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
  comms_features: (): ChatFeatures => FEATURES,
  comms_call_recordings: (): RecordingsResponse => ({ state: "off", tracks: [] }),
  comms_save_recording: (): null => null,
  comms_save_transcript: (): null => null,
};

// ── Cues ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Zuhayer opens Atlas: the green dot in chat and the face in the Timeline header. */
export function zuhayerOnline(): void {
  presence.online.add("zuhayer");
  const online = onlineIds();
  push({ kind: "presence", online });
  void emit("atlas:artifacts-cloud", { kind: "presence", projectId: REMOTE_PROJECT_ID, online });
}

/** Someone is typing in a channel (or any conversation id). Hints age out in 6s. */
export function zuhayerTyping(
  conv: ChannelKey | string = "shop",
  who: PersonKey = "zuhayer",
): void {
  const convId = conv in CONV_ID ? CONV_ID[conv as ChannelKey] : conv;
  push({ kind: "typing", conv_id: convId, user_id: userIdOf(who), at_ms: Date.now() });
}

/** Zuhayer posts in #shop: a typing hint first, then the message ~1.2s later. */
export function zuhayerMessage(
  body: string,
  sessionRef?: { session: string; checkpoint?: string },
): void {
  zuhayerTyping("shop");
  setTimeout(() => {
    const message = post("shop", "zuhayer", body, sessionRef);
    bumpUnread(message.conv_id, body);
  }, 1_200);
}

/** A message under Uzayer's name (Atlas Agent's approved posts). */
export function postAsMe(
  channelKey: ChannelKey,
  body: string,
  sessionRef?: { session: string; checkpoint?: string },
): CommsMessage {
  const message = post(channelKey, "uzayer", body, sessionRef);
  markRead(message.conv_id);
  return message;
}

/**
 * Zuhayer types `text` into the draft titled `draftTitle`, character by
 * character, after `afterText` (or at the end). Each keystroke goes into the
 * server document and out as a `draftUpdate`; his cursor travels with it as
 * `draftAwareness`, restated on a heartbeat so it never expires mid-edit and
 * lingers a few seconds after he stops.
 */
export async function zuhayerDraftEdit(
  draftTitle: string,
  text: string,
  afterText?: string,
): Promise<void> {
  const wanted = draftTitle.trim().toLowerCase();
  const meta = [...draftMeta.values()]
    .filter((d) => d.title.trim().toLowerCase() === wanted)
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  if (!meta) {
    console.warn(`[northwind] zuhayerDraftEdit: no draft titled "${draftTitle}"`);
    return;
  }
  if (meta.sent_at !== null) {
    console.warn(`[northwind] zuhayerDraftEdit: "${draftTitle}" is sent and locked`);
    return;
  }
  const id = meta.id;
  const doc = draftDoc(id);
  const ytext = doc.getText(PROMPT_TEXT_KEY);
  const zuhayer = userIdOf("zuhayer");

  const current = ytext.toString();
  const anchor = afterText ? current.indexOf(afterText) : -1;
  // Tracked as a RELATIVE position, so if Uzayer types above Zuhayer's cursor
  // mid-take, Zuhayer keeps typing where he was rather than at a stale offset.
  let rel = Y.createRelativePositionFromTypeIndex(
    ytext,
    anchor === -1 ? current.length : anchor + (afterText?.length ?? 0),
  );
  const cursor = (): number =>
    Y.createAbsolutePositionFromRelativePosition(rel, doc)?.index ?? ytext.length;

  const announceCursor = () =>
    push({
      kind: "draftAwareness",
      draft_id: id,
      user_id: zuhayer,
      state: encodeAwareness({ cursor: cursor() }),
    });
  const heartbeat = setInterval(announceCursor, 2_000);

  try {
    announceCursor();
    await sleep(700);
    let lastAwareness = 0;
    for (const ch of text) {
      const at = cursor();
      const before = Y.encodeStateVector(doc);
      doc.transact(() => ytext.insert(at, ch), ZUHAYER_EDIT);
      // Re-anchored AFTER the insert: a relative position taken before it
      // would sit in front of the character just typed.
      rel = Y.createRelativePositionFromTypeIndex(ytext, at + ch.length);
      push({
        kind: "draftUpdate",
        draft_id: id,
        update: toBase64(Y.encodeStateAsUpdate(doc, before)),
      });
      const now = Date.now();
      if (now - lastAwareness > 120 || ch === "\n") {
        lastAwareness = now;
        announceCursor();
      }
      // A pause at a line end reads as thinking about the next sentence.
      await sleep(ch === "\n" ? 380 : 28 + Math.random() * 22);
    }
    announceCursor();
    touchDraft(id);
  } finally {
    // The named cursor stays where he stopped for a while, then ages out.
    setTimeout(() => clearInterval(heartbeat), 8_000);
  }
}
