// Where Atlas's words may point, on the desktop. The web's
// `lib/atlas/links.ts` with one change: a target is a place in THIS app — a
// Timeline session, a chat conversation, a Space — rather than a web route,
// and `org-agent-navigate.ts` opens it in place.
//
// The rule stays closed (design §8.3 in the server repo): an answer is model
// output, and the model has read what other people wrote. So a link goes to a
// handle this Ask's tools actually returned, or to one of Atlas's own routes,
// and to nothing else — every other URL is drawn as text.

import type { Card, Mention } from "./org-agent-types";

/** A place the desktop can open. `web` is an Atlas route with no desktop page
 *  of its own (a project page, a Shared Thread), opened on app.tryatlas.cc. */
export type OrgAgentTarget =
  | {
      kind: "session";
      workspaceId: string;
      sessionId: string;
      commentId?: string;
      commitSha?: string;
    }
  | { kind: "conversation"; convId: string; messageId?: string }
  | { kind: "space"; convId: string; pageId?: string }
  | { kind: "ask"; askId: string }
  | { kind: "loops" }
  | { kind: "web"; route: string };

/** The app's own top-level routes an answer may link to. A whitelist of
 *  segments, not "anything starting with /": `//evil.example` and
 *  `/\evil.example` are both read by a browser as another origin. */
const ROUTE =
  /^\/(?:timeline|chat|space|projects|threads|inbox|dashboard|agent|rc)(?=$|[/?#])[^\s\\]*$/;

/** Is `href` one of Atlas's own routes, and nothing that could leave it? */
export function isAtlasRoute(href: string): boolean {
  // Control characters are stripped by URL parsers, which can turn a harmless
  // looking string into a scheme-relative one.
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return ROUTE.test(href);
}

/** Handles an answer can carry: `ses-N`, `wp-N`, `cm-N`, `fact-N`,
 *  `conv:<id>`, `msg:<id>`. Bounded on both sides so `aws-1` or `wp-12a` is
 *  not mistaken for one. */
export const HANDLE_PATTERN =
  /(?<![\w-])(?:(?:ses|wp|cm|fact)-[1-9]\d{0,14}|(?:conv|msg):[A-Za-z0-9_-]{1,128})(?![\w-])/g;

/** An Atlas route as a desktop target, or `null` for one this app cannot
 *  place (it then stays text). */
export function routeTarget(route: string): OrgAgentTarget | null {
  if (!isAtlasRoute(route)) return null;
  let url: URL;
  try {
    url = new URL(route, "https://app.tryatlas.cc");
  } catch {
    return null;
  }
  const p = url.searchParams;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case "timeline": {
      const workspaceId = p.get("workspace");
      const sessionId = p.get("session");
      if (!workspaceId || !sessionId) return { kind: "web", route };
      const commentId = p.get("comment");
      return { kind: "session", workspaceId, sessionId, ...(commentId ? { commentId } : {}) };
    }
    case "chat": {
      const convId = p.get("c");
      if (!convId) return { kind: "web", route };
      const messageId = p.get("m");
      return { kind: "conversation", convId, ...(messageId ? { messageId } : {}) };
    }
    case "space":
      return parts[1] ? { kind: "space", convId: parts[1] } : { kind: "web", route };
    case "agent": {
      const ask = p.get("ask");
      if (ask && ask !== "new") return { kind: "ask", askId: ask };
      if (p.get("view") === "loops") return { kind: "loops" };
      return { kind: "web", route };
    }
    default:
      return { kind: "web", route };
  }
}

/** Where each handle in this Ask's results opens. Built from the cards, so a
 *  handle links only when a tool returned it to this member: one the model
 *  made up, or copied out of something it read, stays text. */
export function handleIndex(cards: readonly Card[]): Map<string, OrgAgentTarget> {
  const index = new Map<string, OrgAgentTarget>();
  for (const card of cards) {
    switch (card.kind) {
      case "session":
        index.set(card.handle, {
          kind: "session",
          workspaceId: card.workspace_id,
          sessionId: card.session_id,
        });
        break;
      case "project":
        index.set(card.handle, {
          kind: "web",
          route: `/projects/${encodeURIComponent(card.handle)}`,
        });
        break;
      case "comment":
        index.set(card.handle, {
          kind: "session",
          workspaceId: card.workspace_id,
          sessionId: card.session_id,
          commentId: card.comment_id,
        });
        break;
      case "conversation":
        index.set(`conv:${card.conv_id}`, { kind: "conversation", convId: card.conv_id });
        break;
      case "message":
        index.set(`msg:${card.message_id}`, {
          kind: "conversation",
          convId: card.conv_id,
          messageId: card.message_id,
        });
        break;
      default:
        break;
    }
  }
  return index;
}

/** The target a handle opens, or `null` to leave it as text. A project handle
 *  needs no card: `/projects/wp-N` answers one the member cannot read as not
 *  found, so linking it reveals nothing. */
export function targetForHandle(
  handle: string,
  index: ReadonlyMap<string, OrgAgentTarget>,
): OrgAgentTarget | null {
  return (
    index.get(handle) ??
    (/^wp-[1-9]\d{0,14}$/.test(handle) ? { kind: "web", route: `/projects/${handle}` } : null)
  );
}

/** Where a card opens, or `null` for one with no page of its own. */
export function cardTarget(card: Card): OrgAgentTarget | null {
  switch (card.kind) {
    case "project":
      return { kind: "web", route: `/projects/${encodeURIComponent(card.handle)}` };
    case "session":
      return { kind: "session", workspaceId: card.workspace_id, sessionId: card.session_id };
    case "checkpoint":
      return {
        kind: "session",
        workspaceId: card.workspace_id,
        sessionId: card.session_id,
        commitSha: card.commit_sha,
      };
    case "comment":
      return {
        kind: "session",
        workspaceId: card.workspace_id,
        sessionId: card.session_id,
        commentId: card.comment_id,
      };
    case "conversation":
      return { kind: "conversation", convId: card.conv_id };
    case "message":
      return { kind: "conversation", convId: card.conv_id, messageId: card.message_id };
    case "space_page":
      return { kind: "space", convId: card.conv_id, pageId: card.page_id };
    case "link":
      return routeTarget(card.route);
    case "loop":
      return { kind: "loops" };
    case "person":
    case "fact":
      return null;
  }
}

/** Where a mention chip opens, built from its ids and never from a URL it
 *  carried. `null` for one with no page (a person). */
export function mentionTarget(m: Mention): OrgAgentTarget | null {
  const [outer, inner] = m.within ?? [];
  switch (m.kind) {
    case "person":
    case "fact":
      return null;
    case "conversation":
      return { kind: "conversation", convId: m.id };
    case "message":
      return outer ? { kind: "conversation", convId: outer, messageId: m.id } : null;
    case "file":
    case "draft":
      return outer ? { kind: "conversation", convId: outer } : null;
    case "project":
      return { kind: "web", route: `/projects/${encodeURIComponent(m.handle ?? m.id)}` };
    case "session":
      return outer ? { kind: "session", workspaceId: outer, sessionId: m.id } : null;
    case "comment":
      return outer && inner
        ? { kind: "session", workspaceId: outer, sessionId: inner, commentId: m.id }
        : null;
    case "thread":
      return outer
        ? {
            kind: "web",
            route: `/threads/${encodeURIComponent(m.id)}?workspace=${encodeURIComponent(outer)}`,
          }
        : null;
    case "space_page":
      return { kind: "space", convId: m.id };
    case "rc_room":
      return { kind: "web", route: `/rc/rooms/${encodeURIComponent(m.id)}` };
    case "ask":
      return { kind: "ask", askId: m.id };
    case "loop":
      return { kind: "loops" };
  }
}

/** A stable key for a card, by the record it names: two results naming one
 *  record draw once. */
export function cardKey(card: Card): string {
  switch (card.kind) {
    case "person":
      return `person:${card.user_id}`;
    case "project":
      return `project:${card.workspace_id}`;
    case "session":
      return `session:${card.session_id}`;
    case "checkpoint":
      return `checkpoint:${card.commit_sha}`;
    case "conversation":
      return `conv:${card.conv_id}`;
    case "message":
      return `msg:${card.message_id}`;
    case "comment":
      return `comment:${card.comment_id}`;
    case "space_page":
      return `page:${card.page_id}`;
    case "fact":
      return `fact:${card.fact_id}`;
    case "loop":
      return `loop:${card.loop_id}`;
    case "link":
      return `link:${card.route}`;
  }
}
