// The Organisation agent — Atlas's conversational agent over the
// Organisation's data (sessions, projects, comments, chats, schedules). It
// runs on the server; the desktop, the web (app.tryatlas.cc/agent) and mobile
// are its consumers. Not the coding agent: that one is built to edit code, and
// is the wrong tool for conversation over team data or for setting schedules.
//
// The server API is not built yet. This module is the one seam the UI talks
// through, so wiring it is a change here and nowhere else: `reply` becomes an
// IPC call (Rust holds the token, as every other cloud door does), and the
// conversation list becomes a read of the server's history.

/** Something the agent read to answer — a session, a project, a comment, a
 *  chat — linked so the answer can be checked. */
export interface OrgAgentSource {
  title: string;
  /** What kind of thing it is, for its glyph. */
  kind: "session" | "project" | "comment" | "chat" | "page";
  url: string;
}

/** One message in a conversation. An answer carries what the server says
 *  about how it was made; every field past `text` is optional, and the
 *  thread draws only what is there. */
export interface OrgAgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Epoch ms. */
  at: number;
  /** How long the agent thought before answering. */
  thoughtMs?: number;
  sources?: OrgAgentSource[];
  /** The person's verdict on an answer. */
  feedback?: "up" | "down";
  /** A question asked with deep research on. */
  deepResearch?: boolean;
}

/** How hard the agent works on an answer — the composer's effort picker. */
export type OrgAgentEffort = "low" | "medium" | "high";

/** Questions a person may ask a day, and how many of those may be deep
 *  research — the web's numbers. The server will report both; until then
 *  the composer counts today's questions itself. */
export const ORG_AGENT_DAILY_LIMIT = 200;
export const ORG_AGENT_DEEP_RESEARCH_DAILY = 5;

/** What the server answers with. */
export interface OrgAgentAnswer {
  text: string;
  thoughtMs?: number;
  sources?: OrgAgentSource[];
}

/** One conversation with the agent — its own session, like a coding chat. */
export interface OrgAgentConversation {
  id: string;
  /** "New chat" until the first prompt names it. */
  title: string;
  messages: OrgAgentMessage[];
  createdAt: number;
  updatedAt: number;
}

/** The questions the empty state offers — the web's own three. */
export const ORG_AGENT_SUGGESTIONS = [
  "What did I work on this week?",
  "What is the team working on today?",
  "Which of my sessions have open comments?",
] as const;

/** What the agent answers until the server exists. */
export const ORG_AGENT_PLACEHOLDER =
  "The organisation agent isn't connected on the desktop yet. Once it is, I'll answer from your team's sessions, projects, comments and chats — only what you can see yourself — with links to what I found.";

/**
 * The agent's answer to `prompt` in `conversation`. Placeholder: a short
 * pause and a fixed answer, so the sending state, the thinking line and the
 * unread marks all have something to show. Replaced by the server call.
 */
export async function reply(
  _conversation: OrgAgentConversation,
  _prompt: string,
): Promise<OrgAgentAnswer> {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 900));
  return { text: ORG_AGENT_PLACEHOLDER, thoughtMs: Date.now() - started };
}
