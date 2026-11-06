// `@` mentions in the agent's composer: what the picker offers, and how a
// sent message is cut back into text and chips. The web's
// `lib/atlas/mentions.ts` and `mention-sources.ts`, over the desktop's own
// data — the same lists the rest of the app already reads, so a picker that
// opens costs (almost) nothing new.
//
// Nothing here decides access. A list is what its door answered this member,
// and a mention only names a thing: Atlas opens it through the doors again,
// as the member, and a mention of something they cannot read is refused like
// any other read.

import { invoke } from "@tauri-apps/api/core";

import { sessionTitle } from "@/features/artifacts/lib/board";
import type { BoardPage } from "@/features/artifacts/types";
import { conversationTitle } from "@/features/comms/lib/derive";
import { comms } from "@/features/comms/lib/comms-api";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { inbox } from "@/features/inbox/lib/inbox-api";
import { useMembersStore } from "@/features/organisations/stores/members-store";

import type { Mention, MentionKind } from "./org-agent-types";
import { ATLAS_LIMITS } from "./org-agent-types";
import { asksByRecent, isTempAsk, useOrgAgentStore } from "../stores/org-agent-store";

// ── Text and chips ──────────────────────────────────────────────────────────

/** How a mention is spelled in the text. */
export function mentionText(mention: Pick<Mention, "label">): string {
  return `@${mention.label}`;
}

/** A label as the wire takes it: one line, trimmed, bounded. */
export function labelOf(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const max = ATLAS_LIMITS.mentionLabelChars;
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut || fallback;
}

/** What a message sends: each mention once, in the order it appears, within
 *  the wire's bounds. */
export function mentionsToSend(mentions: readonly Mention[]): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const m of mentions) {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...m, label: m.label.slice(0, ATLAS_LIMITS.mentionLabelChars) });
    if (out.length === ATLAS_LIMITS.mentions) break;
  }
  return out;
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; mention: Mention };

/** A sent message, cut into text and mentions for drawing: every `@label` of
 *  one of its mentions, longest label first so `@Ada Lovelace` is not read as
 *  `@Ada`. */
export function segmentsOf(text: string, mentions: readonly Mention[] | undefined): Segment[] {
  if (!mentions || mentions.length === 0) return [{ kind: "text", text }];
  const byText = new Map<string, Mention>();
  for (const m of mentions) if (!byText.has(mentionText(m))) byText.set(mentionText(m), m);
  const keys = [...byText.keys()].sort((a, b) => b.length - a.length);
  const out: Segment[] = [];
  let i = 0;
  let plain = "";
  while (i < text.length) {
    const key =
      text[i] === "@" && (i === 0 || /\s|\(/.test(text[i - 1]!))
        ? keys.find((k) => text.startsWith(k, i))
        : undefined;
    if (key) {
      if (plain) out.push({ kind: "text", text: plain });
      plain = "";
      out.push({ kind: "mention", text: key, mention: byText.get(key)! });
      i += key.length;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) out.push({ kind: "text", text: plain });
  return out;
}

/** A pasted or typed Atlas link that names a thing by its ids, as a mention.
 *  Only links that carry ids: the desktop has no handle resolver, so a bare
 *  `ses-123` stays text (the agent reads handles in text on its own). */
export function mentionFromLink(raw: string): Mention | null {
  const s = raw.trim();
  if (!s || /\s/.test(s) || s.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(s, "https://app.tryatlas.cc");
  } catch {
    return null;
  }
  if (url.origin !== "https://app.tryatlas.cc") return null;
  if (!s.startsWith("/") && !s.startsWith(url.origin)) return null;
  const p = url.searchParams;
  const parts = url.pathname.split("/").filter(Boolean);
  switch (parts[0]) {
    case "timeline": {
      const workspace = p.get("workspace");
      const session = p.get("session");
      if (!workspace || !session) return null;
      const comment = p.get("comment");
      return comment
        ? { kind: "comment", id: comment, label: "Comment", within: [workspace, session] }
        : { kind: "session", id: session, label: "Session", within: [workspace] };
    }
    case "chat": {
      const c = p.get("c");
      if (!c) return null;
      const m = p.get("m");
      return m
        ? { kind: "message", id: m, label: "Message", within: [c] }
        : { kind: "conversation", id: c, label: conversationLabel(c) };
    }
    case "agent": {
      const ask = p.get("ask");
      return ask && ask !== "new" ? { kind: "ask", id: ask, label: "Atlas conversation" } : null;
    }
    default:
      return null;
  }
}

// ── What the picker offers ──────────────────────────────────────────────────

export interface MentionOption {
  key: string;
  mention: Mention;
  /** A second line: a handle, a project, who wrote it. */
  detail?: string;
}

export interface MentionGroup {
  key: string;
  heading: string;
  kind: MentionKind;
  options: MentionOption[];
}

/** How many of each group the picker shows. */
const PER_GROUP = 5;
/** Fewer letters than this and chat messages are not searched. */
const MESSAGE_SEARCH_MIN = 3;
/** How long the board and the inbox stay fresh for the picker. */
const TTL_MS = 20_000;

const matches = (q: string, ...fields: (string | null | undefined)[]) =>
  q === "" || fields.some((f) => f?.toLowerCase().includes(q));

function option(kind: MentionKind, m: Omit<Mention, "kind">, detail?: string): MentionOption {
  return { key: `${kind}:${m.id}`, mention: { kind, ...m }, ...(detail ? { detail } : {}) };
}

function conversationLabel(convId: string): string {
  const { conversations, members, me } = useCommsStore.getState();
  const c = conversations.find((x) => x.id === convId);
  if (!c) return "Conversation";
  if (c.kind === "channel") return `#${c.name ?? "channel"}`;
  return conversationTitle(c, new Map(members.map((m) => [m.id, m])), me) || "Direct message";
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Forget the picker's cached lists (tests). */
export function resetMentionSourcesForTests(): void {
  cache.clear();
}

/**
 * The picker's groups for `query` (what follows the `@`), in the Organisation
 * the agent is connected to. Every source is best-effort: one that fails
 * leaves its group out rather than the picker empty.
 */
export async function searchMentionGroups(query: string, orgId: string): Promise<MentionGroup[]> {
  const q = query.trim().toLowerCase();
  const fromLink = mentionFromLink(query);

  const people = (async (): Promise<MentionOption[]> => {
    const store = useMembersStore.getState();
    if (store.byOrg[orgId]?.loadedAt == null) await store.actions.load(orgId).catch(() => {});
    return (useMembersStore.getState().byOrg[orgId]?.members ?? [])
      .filter((m) => matches(q, m.name, m.email))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => option("person", { id: m.userId, label: labelOf(m.name, "Member") }, m.email));
  })().catch(() => []);

  const conversations = (async (): Promise<MentionOption[]> => {
    const { connection, conversations } = useCommsStore.getState();
    if (connection.orgId !== orgId) return [];
    return conversations
      .filter((c) => c.archived_at == null)
      .map((c) => ({ c, label: conversationLabel(c.id) }))
      .filter(({ label }) => matches(q, label))
      .sort((a, b) => b.c.last_activity_seq - a.c.last_activity_seq)
      .map(({ c, label }) =>
        option(
          "conversation",
          { id: c.id, label: labelOf(label, "Conversation") },
          c.kind === "channel" ? "Channel" : "Direct message",
        ),
      );
  })().catch(() => []);

  const board = cached(`board:${orgId}`, async () => {
    const page = await invoke<BoardPage>("artifacts_board", { projects: [], filter: null });
    return page.sessions.filter((s) => s.remoteProjectId);
  }).catch(() => []);

  const sessions = board.then((rows) =>
    rows
      .map((s) => ({ s, title: sessionTitle(s.title) ?? "Untitled session" }))
      .filter(({ s, title }) => matches(q, title, s.id, s.projectName))
      .map(({ s, title }) =>
        option(
          "session",
          {
            id: s.id,
            label: labelOf(title, "Session"),
            within: [s.remoteProjectId!],
            // A server session id is its handle (`ses-983`) when it has one.
            ...(/^ses-[1-9]\d{0,14}$/.test(s.id) ? { handle: s.id } : {}),
          },
          s.projectName || undefined,
        ),
      ),
  );

  const projects = board.then((rows) => {
    const seen = new Map<string, string>();
    for (const s of rows)
      if (s.remoteProjectId && !seen.has(s.remoteProjectId))
        seen.set(s.remoteProjectId, s.projectName);
    return [...seen.entries()]
      .filter(([, name]) => matches(q, name))
      .map(([id, name]) => option("project", { id, label: labelOf(name, "Project") }, "Project"));
  });

  const messages =
    q.length >= MESSAGE_SEARCH_MIN
      ? comms
          .search(query.trim())
          .then((page) => {
            const members = new Map(useCommsStore.getState().members.map((m) => [m.id, m.name]));
            return page.messages.map((m) =>
              option(
                "message",
                { id: m.id, label: labelOf(m.body, "Message"), within: [m.conv_id] },
                members.get(m.author_id),
              ),
            );
          })
          .catch(() => [] as MentionOption[])
      : Promise.resolve([] as MentionOption[]);

  const agent = useOrgAgentStore.getState();
  const asks = asksByRecent(agent.asks)
    .filter((a) => !isTempAsk(a.id) && a.title && matches(q, a.title))
    .map((a) =>
      option("ask", { id: a.id, label: labelOf(a.title, "Conversation") }, "Atlas conversation"),
    );
  const loops = (agent.loops ?? [])
    .filter((l) => l.status !== "deleted" && matches(q, l.name))
    .map((l) => option("loop", { id: l.id, label: labelOf(l.name, "Loop") }, "Loop"));

  const comments = cached(`inbox:${orgId}`, () => inbox.page("all"))
    .then((page) => {
      const seen = new Map<string, MentionOption>();
      for (const e of page.entries) {
        if (
          seen.has(e.commentId) ||
          !e.excerpt ||
          !matches(q, e.excerpt, e.sessionTitle, e.actorName)
        )
          continue;
        seen.set(
          e.commentId,
          option(
            "comment",
            {
              id: e.commentId,
              label: labelOf(e.excerpt, "Comment"),
              within: [e.workspaceId, e.sessionId],
            },
            e.sessionTitle ?? e.workspaceSlug,
          ),
        );
      }
      return [...seen.values()];
    })
    .catch(() => [] as MentionOption[]);

  const [p, c, s, w, m, cm] = await Promise.all([
    people,
    conversations,
    sessions,
    projects,
    messages,
    comments,
  ]);

  const groups: MentionGroup[] = [];
  const push = (key: string, heading: string, kind: MentionKind, options: MentionOption[]) => {
    if (options.length > 0)
      groups.push({ key, heading, kind, options: options.slice(0, PER_GROUP) });
  };
  if (fromLink)
    push("link", "From a link", fromLink.kind, [{ key: `link:${fromLink.id}`, mention: fromLink }]);
  push("people", "People", "person", p);
  push("conversations", "Channels and DMs", "conversation", c);
  push("projects", "Projects", "project", w);
  push("sessions", "Sessions", "session", s);
  push("messages", "Chat messages", "message", m);
  push("asks", "Atlas conversations", "ask", asks);
  push("loops", "Loops", "loop", loops);
  push("comments", "Comments", "comment", cm);
  return groups;
}
