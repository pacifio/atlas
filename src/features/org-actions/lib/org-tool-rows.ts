/**
 * What an **organisation call** (CONTEXT.md; ADR-0014) is about, in one line:
 * the organisation, the member, the conversation, the recorded session or the
 * recipient it named. The same line leads the call's tool row in the chat and
 * its row in the Logs panel, so the two never read differently.
 *
 * Table-driven: every `atlas_org` tool is one entry in `ORG_TOOL_ROWS`, built
 * from the call's arguments and, once it has answered, its JSON answer. The
 * arguments are always there (a row names what was ASKED even when the call
 * failed); the answer only improves the name — an email resolved to the
 * member's name, a channel to its canonical spelling.
 */

/** The organisation tool server's name in the agent's MCP configuration
 *  (`ORG_SERVER_NAME` in `src-tauri/src/commands/org_server/mod.rs`). */
export const ORG_SERVER_NAME = "atlas_org";

/** A call's line, in the marker row's two parts: the verb in muted weight and
 *  the name it acted on. */
export interface OrgToolRow {
  verb: string;
  detail: string;
}

type Json = Record<string, unknown>;

/** One tool's line, from its arguments and (once answered) its answer. */
type OrgRowLine = (args: Json, answer: Json | null) => OrgToolRow;

const obj = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** "Looked up <name>", or the listing when nothing was named. */
function lookup(named: string | null, listing: string): OrgToolRow {
  return named ? { verb: "Looked up", detail: named } : { verb: listing, detail: "" };
}

/** A conversation as a person reads it: a channel by `#name`, a DM by who is
 *  in it. */
function conversationName(conversation: Json | null): string | null {
  if (!conversation) return null;
  const name = str(conversation.name);
  if (name) return `#${name}`;
  const members = Array.isArray(conversation.members) ? conversation.members : [];
  const names = members.map((m) => str(obj(m)?.name)).filter((n): n is string => n !== null);
  return names.length ? `DM with ${names.join(", ")}` : null;
}

/**
 * Every organisation tool's line. A new tool adds one entry here; a tool with
 * no entry still gets its row, named by the tool.
 */
const ORG_TOOL_ROWS: Record<string, OrgRowLine> = {
  org_whoami: (_args, answer) => {
    const org = str(obj(answer?.organisation)?.name);
    return org ? { verb: "Who am I in", detail: org } : { verb: "Who am I", detail: "" };
  },
  org_members: (args, answer) =>
    lookup(str(obj(answer?.member)?.name) ?? str(args.name), "Listed members"),
  org_conversations: (args, answer) =>
    lookup(conversationName(obj(answer?.conversation)) ?? str(args.name), "Listed conversations"),
  // Read-only: the row says the inbox was read, never that anything in it was.
  org_inbox: (args, answer) => {
    const verb = args.unread_only === true ? "Read unread inbox" : "Read inbox";
    const unread = typeof answer?.unread === "number" ? answer.unread : null;
    return unread === null
      ? { verb, detail: "" }
      : { verb: `${verb}:`, detail: `${unread} unread` };
  },
  // The session read: its title once answered (the current one has one), the
  // id asked for, or "this session" when none was named.
  org_comments: (args, answer) => {
    const verb = args.unresolved_only === true ? "Read unresolved comments on" : "Read comments on";
    return { verb, detail: sessionName(args, answer) };
  },
  // Visible, reversible and auto-approved: the row is the whole trail, so it
  // says which way the thread went and which comment it was.
  org_comment_resolve: (args, answer) => ({
    verb: args.resolved === false ? "Unresolved comment" : "Resolved comment",
    detail: str(obj(answer?.comment)?.id) ?? str(args.comment) ?? "",
  }),
  // An outward action (ADR-0014): once posted, whose thread it answered; the
  // comment it was aimed at until then (asked, refused or failed).
  org_comment_reply: (args, answer) => {
    const thread = obj(answer?.thread);
    const author = str(obj(thread?.author)?.name);
    if (author) return { verb: "Replied on", detail: `${author}'s comment` };
    const posted = thread ? str(thread.id) : null;
    return posted
      ? { verb: "Replied on comment", detail: posted }
      : { verb: "Reply to", detail: str(args.comment) ?? "" };
  },
  // An outward action (ADR-0014): once sent, the conversation it went into
  // (a DM opened for it says so); where it was aimed until then (asked,
  // refused or failed).
  org_send: (args, answer) => {
    const sentTo =
      answer && (str(answer.message_id) ?? str(answer.client_msg_id))
        ? conversationName(obj(answer.conversation))
        : null;
    if (!sentTo) return { verb: "Send to", detail: str(args.to) ?? "" };
    return { verb: "Sent to", detail: answer?.created_dm === true ? `new ${sentTo}` : sentTo };
  },
  // The board read: whose sessions and which keywords, the author by the
  // name the answer resolved (an email or id reads as the member's name).
  org_sessions: (args, answer) => {
    const asked = str(args.author);
    const author =
      asked?.toLowerCase() === "me" ? "you" : (str(obj(answer?.author)?.name) ?? asked);
    const q = str(args.q);
    if (!author && !q) return { verb: "Listed recorded sessions", detail: "" };
    const verb = q ? "Searched recorded sessions" : "Listed recorded sessions";
    const detail = [author ? `by ${author}` : null, q ? `for "${q}"` : null]
      .filter(Boolean)
      .join(" ");
    return { verb, detail };
  },
  // One recorded session's page, or one entry's full text in it.
  org_session: (args, answer) => {
    const entry = str(args.entry);
    const session = sessionName(args, answer);
    if (entry) return { verb: "Read entry", detail: `${entry} of ${session}` };
    return session === "this session"
      ? { verb: "Read", detail: session }
      : { verb: "Read recorded session", detail: session };
  },
  // Admins only: a member's activity recorded through Atlas — never named as
  // performance. The member by the name the answer resolved, else as asked.
  org_member_activity: (args, answer) => ({
    verb: "Recorded activity of",
    detail: str(obj(answer?.member)?.name) ?? str(args.member) ?? "",
  }),
  // Auto-approved and audited (ADR-0014): the row is the trail, so it names
  // the page and the conversation whose Space holds it — as created once
  // answered, as asked until then.
  org_page_create: (args, answer) => {
    const created = answer ? str(answer.page_id) : null;
    const name = (created ? str(answer?.name) : null) ?? str(args.name) ?? "";
    const where =
      (created ? conversationName(obj(answer?.conversation)) : null) ?? str(args.conversation);
    const detail = where ? `${name} in ${where}` : name;
    return { verb: created ? "Created page" : "Create page", detail };
  },
  // Auto-approved and audited (ADR-0014): once drawn, how much and on which
  // page (by the name the window answered); the page asked for until then.
  org_page_write: (args, answer) => {
    const placed = typeof answer?.nodes_placed === "number" ? answer.nodes_placed : null;
    const page = str(answer?.name) ?? str(answer?.page_id) ?? str(args.page) ?? "";
    if (placed === null) return { verb: "Draw on page", detail: str(args.page) ?? "" };
    return { verb: `Drew ${placed} ${placed === 1 ? "node" : "nodes"} on`, detail: page };
  },
};

/** The recorded session a session or comment tool acted on, as a person
 *  reads it. */
function sessionName(args: Json, answer: Json | null): string {
  const session = obj(answer?.session);
  const named = str(args.session);
  const asked = named && named.toLowerCase() !== "current" ? named : null;
  return str(session?.title) ?? str(session?.id) ?? asked ?? "this session";
}

/**
 * The bare tool name of an organisation call, or `null` for any other call.
 * The native seam names an MCP call `<server>.<tool>`; an ACP agent's own
 * convention is `mcp__<server>__<tool>`. A bare `org_…` name is not enough:
 * any other server may have one.
 */
export function orgToolOf(toolName: string): string | null {
  for (const prefix of [`${ORG_SERVER_NAME}.`, `mcp__${ORG_SERVER_NAME}__`]) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return null;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The text a tool answered with. A chat tool call carries the whole MCP
 *  result (the tool's text inside `content`); the audit record carries the
 *  text itself. */
function answerText(text: string): string {
  const content = obj(parse(text))?.content;
  if (Array.isArray(content)) {
    const block = content.map(obj).find((b) => b && typeof b.text === "string");
    if (block) return block.text as string;
  }
  return text;
}

/** An organisation tool's JSON answer, or `null` when there is none yet or it
 *  is not an object. */
export function orgAnswerOf(text: string | null | undefined): Json | null {
  if (!text) return null;
  return obj(parse(answerText(text)));
}

/** Why a call failed, in the words the model was told: the plain refusal, or
 *  the `error` of a JSON one (an ambiguous name, with its candidates). */
export function orgFailureOf(text: string): string {
  const inner = answerText(text);
  return str(obj(parse(inner))?.error) ?? inner;
}

/**
 * An organisation call's line. `answer` is the text it answered with, and
 * only for a call that succeeded — a failure's text is the reason, not an
 * answer to read names from.
 */
export function orgToolRow(
  tool: string,
  args: Json | null | undefined,
  answer: string | null,
): OrgToolRow {
  const line = ORG_TOOL_ROWS[tool];
  if (!line) return { verb: tool, detail: "" };
  return line(args ?? {}, orgAnswerOf(answer));
}

/** The line as one string, for the Logs row. */
export function orgRowSubject(row: OrgToolRow): string {
  return row.detail ? `${row.verb} ${row.detail}` : row.verb;
}
