// Organisation mentions for the chat composer: a member, a conversation, a
// recorded session (issue 122).
//
// Each becomes a resource link carrying its id (`atlas-org://…`, written by
// `compose_prompt.rs` from the one `OrgLink` definition the org tools also
// parse), so "send it to @Grace" or "the comments on @Session" need no name
// resolution. Ids only — nothing is inlined.
//
// # Which organisation
//
// The organisation of the chat's **Project binding**, never the window's
// active organisation: that is the organisation the org tools act in (the
// grant's scope, `org_server/adapter.rs::scope_of`), so a mention can only
// name something the tools can reach. The binding is read with the existing
// `capture_binding` command; a Project that is not bound to the cloud (local
// mode, capture off, no organisation) offers none of these kinds.
//
// # Where the candidates come from
//
// The renderer already holds them, so no new command:
//
// - **members** — the organisation roster in `members-store`, keyed by the
//   server organisation id (the binding's `orgId`); loaded on first use.
// - **conversations** — the comms store's joined conversations, but only
//   while chat is connected to that same organisation (the store holds one
//   organisation at a time); otherwise none are offered.
// - **recorded sessions** — the Timeline board (`artifacts_board`, the
//   Timeline's own read) for the chat's Project, narrowed to the rows in the
//   binding's Workspace. The board lives in the Timeline panel's local state,
//   not a store, so it is read here the way the panel reads it.
//
// A recorded session is NOT a past session: `past_session` is a transcript on
// this disk, inlined at send; `recorded_session` is the organisation's record,
// sent as a link. Different kind, label, short form and icon.

import { invoke } from "@tauri-apps/api/core";

import type { Binding } from "@/features/capture/types";
import type { BoardPage, BoardSession } from "@/features/artifacts/types";
import { sessionTitle } from "@/features/artifacts/lib/board";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { conversationTitle } from "@/features/comms/lib/derive";
import type { ChatConversation, ConversationKind } from "@/features/comms/types";

// ── Types (re-exported by `mentions.ts` as part of `MentionData`) ────────────

export interface MentionMember {
  kind: "member";
  /** The member's user id — the human, never the membership id. */
  id: string;
  displayName: string;
  email: string;
}

export interface MentionConversation {
  kind: "conversation";
  id: string;
  /** A channel's name, or a DM titled by who else is in it. */
  displayName: string;
  conversationKind: ConversationKind;
}

export interface MentionRecordedSession {
  kind: "recorded_session";
  /** The session id — the same on the board and on the server. */
  id: string;
  displayName: string;
  sessionId: string;
  /** The server Workspace id it is recorded in. */
  workspaceId: string;
}

export type OrgMentionKind = "member" | "conversation" | "recorded_session";
export type OrgMention = MentionMember | MentionConversation | MentionRecordedSession;

/** Where the chat's Project is bound: the org tools' scope, seen from here. */
export interface ProjectOrgScope {
  /** The server organisation id. */
  orgId: string;
  /** The server Workspace id, once the binding has recorded it. */
  workspaceId: string | null;
}

// ── The Project's binding and board, cached briefly ──────────────────────────

/** How long a Project's binding and board stay fresh for the picker. The
 *  Timeline re-reads its board every 15 s; the picker needs no fresher view,
 *  and a keystroke must not cost a board read. */
const SOURCE_TTL_MS = 15_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

const bindings = new Map<string, Cached<ProjectOrgScope | null>>();
const boards = new Map<string, Cached<BoardSession[]>>();

function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // A failed read is not cached: the next keystroke tries again.
  value.catch(() => cache.delete(key));
  return value;
}

/** Forget every cached binding and board (tests). */
export function resetOrgMentionSourcesForTests(): void {
  bindings.clear();
  boards.clear();
}

/** The organisation and Workspace the chat's Project is bound to — the same
 *  rule as `scope_of` in `org_server/adapter.rs`: cloud mode, recording, and
 *  an organisation. `null` for anything else. */
export function projectOrgScope(projectPath: string | null): Promise<ProjectOrgScope | null> {
  if (!projectPath) return Promise.resolve(null);
  return cached(bindings, projectPath, async () => {
    const binding = await invoke<Binding | null>("capture_binding", { projectPath });
    if (!binding || binding.mode !== "cloud" || !binding.enabled || !binding.orgId) return null;
    return { orgId: binding.orgId, workspaceId: binding.remoteWorkspaceId };
  }).catch(() => null);
}

function projectBoard(projectPath: string): Promise<BoardSession[]> {
  return cached(boards, projectPath, async () => {
    const page = await invoke<BoardPage>("artifacts_board", { projects: [projectPath] });
    return page.sessions;
  }).catch(() => []);
}

// ── Search ───────────────────────────────────────────────────────────────────

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  return !q || fields.some((f) => f?.toLowerCase().includes(q));
}

async function searchMembers(q: string, scope: ProjectOrgScope): Promise<MentionMember[]> {
  const { byOrg, actions } = useMembersStore.getState();
  if (byOrg[scope.orgId]?.loadedAt == null) await actions.load(scope.orgId);
  const members = useMembersStore.getState().byOrg[scope.orgId]?.members ?? [];
  return members
    .filter((m) => matches(q, m.name, m.email))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ kind: "member" as const, id: m.userId, displayName: m.name, email: m.email }));
}

function searchConversations(q: string, scope: ProjectOrgScope): MentionConversation[] {
  const { connection, conversations, members, me } = useCommsStore.getState();
  // The comms store holds one organisation at a time; offering another
  // organisation's conversations would hand the tools ids they cannot reach.
  if (connection.orgId !== scope.orgId) return [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const title = (c: ChatConversation) =>
    c.kind === "channel" ? (c.name ?? "channel") : conversationTitle(c, byId, me);
  return conversations
    .filter((c) => c.archived_at == null)
    .map((c) => ({ c, name: title(c) }))
    .filter(({ name }) => matches(q, name))
    .sort((a, b) => b.c.last_activity_seq - a.c.last_activity_seq)
    .map(({ c, name }) => ({
      kind: "conversation" as const,
      id: c.id,
      displayName: name,
      conversationKind: c.kind,
    }));
}

async function searchRecordedSessions(
  q: string,
  scope: ProjectOrgScope,
  projectPath: string,
): Promise<MentionRecordedSession[]> {
  const workspaceId = scope.workspaceId;
  if (!workspaceId) return [];
  const rows = await projectBoard(projectPath);
  return rows
    .filter((s) => s.remoteProjectId === workspaceId)
    .map((s) => ({ s, name: sessionTitle(s.title) ?? "Untitled session" }))
    .filter(({ name }) => matches(q, name))
    .map(({ s, name }) => ({
      kind: "recorded_session" as const,
      id: s.id,
      displayName: name,
      sessionId: s.id,
      workspaceId,
    }));
}

/**
 * Organisation mentions matching `query`, for one kind or (`scope: null`)
 * all three, in the organisation the chat's Project is bound to. Board order
 * for recorded sessions (newest activity first), most recent activity for
 * conversations, alphabetical for members; at most `limit` of each kind.
 */
export async function searchOrgMentions(
  query: string,
  scope: OrgMentionKind | null,
  projectPath: string | null,
  limit: number,
): Promise<OrgMention[]> {
  const org = await projectOrgScope(projectPath);
  if (!org || !projectPath) return [];
  const q = query.trim().toLowerCase();
  const want = (k: OrgMentionKind) => scope === null || scope === k;
  const [members, sessions] = await Promise.all([
    want("member") ? searchMembers(q, org).catch(() => []) : [],
    want("recorded_session") ? searchRecordedSessions(q, org, projectPath) : [],
  ]);
  const conversations = want("conversation") ? searchConversations(q, org) : [];
  return [
    ...members.slice(0, limit),
    ...conversations.slice(0, limit),
    ...sessions.slice(0, limit),
  ];
}
