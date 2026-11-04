/**
 * Ask agent: hand a piece of work to a session, from any surface.
 *
 * The agent is the default editor. A surface that shows work (a file, a diff,
 * a memory, a commit, an error) offers "ask the agent" one hover or keystroke
 * away, and every surface does it the same way: the same box, the same keys
 * (⌘↵ sends, ⌘⇧↵ drafts into the composer, Esc cancels, Enter is a newline),
 * the same context chips, the same choice of session. After a send the user
 * stays where they are and gets "Sent to ‹session› · Open".
 *
 * ## How to add ask-agent to a surface
 *
 * Describe the work as an `AgentContext` (`./agent-context`) and either open
 * the box or send directly:
 *
 * ```tsx
 * import { AskAgentButton, ASK_ROW } from "@/features/ask-agent/components/ask-agent-button";
 * import { useAskAgentContext } from "@/features/ask-agent/lib/focused-context";
 * import type { AgentContext } from "@/features/ask-agent/lib/agent-context";
 *
 * function HunkRow({ path, hunk, staged }: Hunk) {
 *   const ctx: AgentContext = { kind: "diff_hunk", path, hunk, staged };
 *   const ref = useAskAgentContext<HTMLDivElement>(() => [ctx]); // ⌘K "Ask agent about…"
 *   return (
 *     <div ref={ref} tabIndex={0} className={ASK_ROW}>
 *       <pre>{hunk}</pre>
 *       <AskAgentButton context={[ctx]} />  {// shows on row hover and focus }
 *     </div>
 *   );
 * }
 * ```
 *
 * For an error, `<FixWithAgentButton error={{ kind: "error", source, message, log }} />`
 * opens the box pre-filled with "Fix this:". Without the box,
 * `await askAgent({ context, prompt, send: true })` sends from code and
 * `confirmAsk(result)` shows the pill. `openAskAgent({ context, anchor })`
 * opens the box against any element or rect.
 *
 * ## What happens
 *
 * Each context becomes an `agent_context` chip in the target session's
 * composer (`@ctx:<id>` in its text); the agent receives the prompt followed
 * by each context as a quoted excerpt with its source (`contextAsText`).
 * `send: true` goes through the session's own send path (`atlas:chat-send`),
 * so a running turn queues it and a starting session holds it, as for
 * anything typed. Nothing on the wire is new.
 *
 * Targets: `"active"` is the session in view, else the most recently viewed
 * open one, else a new one. `"new"` opens a session in the current project,
 * in the background. A tab id targets that open session. No call navigates;
 * the result says where it went, and `openAskedSession` goes there.
 */

import { toast } from "sonner";

import { useChatStore, UNTITLED_SESSION } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openAgentChatInNewTab } from "@/features/chat/lib/open-agent-session";
import { rememberMention } from "@/features/chat/lib/mention-registry";
import { toShortForm, type MentionAgentContext } from "@/features/chat/lib/mentions";
import { projectPathForTab } from "@/features/chat/lib/tab-project";
import type { ChatSendDetail } from "@/features/chat/hooks/use-queue-drain";
import type { ChatInsertDetail } from "@/features/chat/lib/response-selection";

import { useAskAgentStore, type AskAnchor } from "../stores/ask-agent-store";
import { agentContextMention, capContext, type AgentContext } from "./agent-context";

export type { AgentContext } from "./agent-context";

/** Where the ask goes: the session in view, a new one, or an open session's
 *  tab id. */
export type AskTarget = "active" | "new" | (string & {});

export interface AskAgentOptions {
  context: readonly AgentContext[];
  prompt?: string;
  /** Send now (`true`) or leave it drafted in the composer (`false`). */
  send: boolean;
  target?: AskTarget;
}

export interface AskResult {
  /** The session's tab. */
  tabId: string;
  /** Its title, for the confirmation. */
  title: string;
  /** False when it was drafted, by choice or because the send could not
   *  reach the session. */
  sent: boolean;
  /** A new session was opened for it. */
  created: boolean;
}

/** An open session, as the target picker lists it. */
export interface OpenSession {
  tabId: string;
  title: string;
}

/** Where `target` lands, given the session in view and the open sessions
 *  (most recently viewed first). Pure. */
export function resolveAskTarget(
  target: AskTarget,
  active: string | null,
  open: readonly OpenSession[],
): { kind: "existing"; tabId: string } | { kind: "new" } {
  if (target === "new") return { kind: "new" };
  if (target === "active") {
    if (active && open.some((s) => s.tabId === active)) return { kind: "existing", tabId: active };
    return open.length > 0 ? { kind: "existing", tabId: open[0].tabId } : { kind: "new" };
  }
  if (open.some((s) => s.tabId === target)) return { kind: "existing", tabId: target };
  throw new Error(`No open session ${target}`);
}

function sessionTitle(tabId: string): string {
  return useChatStore.getState().sessions[tabId]?.title || UNTITLED_SESSION;
}

/** The open sessions, most recently viewed first. */
export function openSessions(): OpenSession[] {
  const { tabs, tabHistory } = useLayoutStore.getState();
  const chats = tabs.filter((t) => t.type === "chat").map((t) => t.id);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let i = tabHistory.length - 1; i >= 0; i--) {
    const id = tabHistory[i];
    if (chats.includes(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of chats) if (!seen.has(id)) ordered.push(id);
  return ordered.map((tabId) => ({ tabId, title: sessionTitle(tabId) }));
}

/** The session in view, when it is one. */
export function activeSession(): string | null {
  const { activeSessionId } = useChatStore.getState();
  const tabs = useLayoutStore.getState().tabs;
  return activeSessionId && tabs.some((t) => t.id === activeSessionId && t.type === "chat")
    ? activeSessionId
    : null;
}

/** The composer text for an ask: the prompt, then each chip's short form. */
export function composeAsk(prompt: string, mentions: readonly MentionAgentContext[]): string {
  const tokens = mentions.map(toShortForm).join(" ");
  const text = prompt.trim();
  if (!tokens) return text;
  return text ? `${text}\n\n${tokens} ` : `${tokens} `;
}

/** Dispatch a cancelable event until a listener takes it (calls
 *  `preventDefault`), retrying every RETRY_MS for a tab whose panel is still
 *  mounting. */
function dispatchUntilHeard(name: string, detail: unknown, tries: number): Promise<boolean> {
  return new Promise((resolve) => {
    let made = 0;
    const attempt = () => {
      if (!window.dispatchEvent(new CustomEvent(name, { detail, cancelable: true }))) {
        resolve(true);
      } else if (++made >= tries) {
        resolve(false);
      } else {
        setTimeout(attempt, RETRY_MS);
      }
    };
    attempt();
  });
}

/** Write `text` after the session's draft: into its composer when mounted,
 *  else into the stored draft its composer reads on mount. */
function draftInto(tabId: string, text: string): void {
  const detail: ChatInsertDetail = { text, tabId, append: true };
  const heard = !window.dispatchEvent(
    new CustomEvent("atlas:chat-insert", { detail, cancelable: true }),
  );
  if (heard) return;
  const chat = useChatStore.getState();
  const cur = chat.drafts[tabId] ?? "";
  chat.actions.setDraft(tabId, cur.trim() ? `${cur}\n\n${text}` : text);
}

/** A timer, not a frame: frames stop in a hidden window, and the ask would
 *  hang. About two seconds in all, enough for a new panel to mount. */
const RETRY_MS = 16;
const MOUNT_TRIES = 120;

/**
 * Hand `context` and `prompt` to a session. Resolves with where it went;
 * rejects only for a target that is not an open session, or for nothing to
 * send. Never navigates.
 */
export async function askAgent(opts: AskAgentOptions): Promise<AskResult> {
  const prompt = opts.prompt ?? "";
  if (opts.context.length === 0 && !prompt.trim()) throw new Error("Nothing to ask");
  const where = resolveAskTarget(opts.target ?? "active", activeSession(), openSessions());
  const created = where.kind === "new";
  const tabId =
    where.kind === "new" ? openAgentChatInNewTab(undefined, { background: true }) : where.tabId;

  const mentions = opts.context.map((ctx) => agentContextMention(ctx));
  // So the composer turns each `@ctx:<id>` back into its chip.
  const projectPath = projectPathForTab(tabId);
  for (const m of mentions) rememberMention(m, projectPath);
  const text = composeAsk(prompt, mentions);

  let sent = false;
  if (opts.send) {
    const detail: ChatSendDetail = { tabId, text: text.trim(), mentions };
    sent = await dispatchUntilHeard("atlas:chat-send", detail, created ? MOUNT_TRIES : 1);
  }
  // Not sent — by choice, or no panel took it — so nothing is lost: it waits
  // in the composer.
  if (!sent) draftInto(tabId, text);
  return { tabId, title: sessionTitle(tabId), sent, created };
}

/** Go to the session an ask went to. */
export function openAskedSession(tabId: string): void {
  useLayoutStore.getState().actions.setActiveTab(tabId);
  useChatStore.getState().actions.setActiveSession(tabId);
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
}

/** Open the ask box, pre-filled, against `anchor` (an element, a rect, or
 *  nothing for the top of the window). */
export function openAskAgent(request: {
  context?: readonly AgentContext[];
  prompt?: string;
  anchor?: AskAnchor;
  target?: AskTarget;
}): void {
  useAskAgentStore.getState().actions.open({
    context: (request.context ?? []).map(capContext),
    prompt: request.prompt,
    anchor: request.anchor ?? null,
    target: request.target,
  });
}

/** The confirmation: "Sent to ‹session› · Open". */
export function confirmAsk(result: AskResult): void {
  const verb = result.sent ? "Sent to" : "Drafted in";
  const where = result.created ? "a new session" : result.title;
  toast(`${verb} ${where}`, {
    action: { label: "Open", onClick: () => openAskedSession(result.tabId) },
  });
}
