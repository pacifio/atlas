// Handing a pull request task to a session: which agent, which session, and
// what lands in its composer.
//
// The agent is the user's default for the project (`defaultAgentForNewSession`
// — the `defaultAgent` setting when that agent is installed, the native agent
// otherwise), named on every action so the user knows who will do the work.
// Nothing here asks an agent what it is: a session is started the same way for
// every agent (ADR-0002).
//
// The task is written into the composer, never sent: the user reads it, edits
// it if they like, and sends it. The short prompt is the composer's text; the
// pull request material rides beside it as a pasted-text chip, minted here and
// remembered in the mention registry so the chip comes back whole when the
// composer mounts and reads its draft.

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { defaultAgentForNewSession } from "@/features/chat/lib/default-agent";
import { openAgentChatInNewTab } from "@/features/chat/lib/open-agent-session";
import { pastedTextMention } from "@/features/chat/lib/pasted-text";
import { rememberMention } from "@/features/chat/lib/mention-registry";
import { toShortForm } from "@/features/chat/lib/mentions";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { activateProject } from "@/features/sidebar/lib/sidebar-actions";
import type { SwitchableAgent } from "@/types/agent";
import type { Handoff } from "./pull-request-handoff";

export interface ActionAgent {
  agent: SwitchableAgent;
  /** The name the actions show ("Claude Code", "Atlas Agent", …). */
  label: string;
}

/** The agent a pull request action in `projectPath` uses. */
export function actionAgent(projectPath: string): ActionAgent {
  const agent = defaultAgentForNewSession(projectPath);
  return { agent, label: agentMeta(agent).label };
}

/** The chat tab beside the pull request, when its session belongs to the same
 *  project: "the current session" the Explain action can use instead of a new
 *  one. */
export function currentSessionTab(projectPath: string): string | null {
  const layout = useLayoutStore.getState();
  const chat = useChatStore.getState();
  const tabId = chat.activeSessionId;
  if (!tabId || !layout.tabs.some((t) => t.id === tabId && t.type === "chat")) return null;
  const session = chat.sessions[tabId];
  if (!session) return null;
  const root = projectPath.replace(/\/+$/, "");
  const cwd = session.bindCwd ?? session.workingDirectory;
  if (cwd) return cwd === root || cwd.startsWith(`${root}/`) ? tabId : null;
  // Not bound yet: it opens in the current project.
  return useAppStore.getState().currentProject?.path === root ? tabId : null;
}

/** `currentSessionTab`, re-read as the session beside the tab changes. */
export function useCurrentSessionTab(projectPath: string): string | null {
  // Subscribed for the re-render; the answer is read whole each time.
  useChatStore((s) => s.activeSessionId);
  useLayoutStore((s) => s.tabs.length);
  return currentSessionTab(projectPath);
}

/** The folder a session tab works in: its bound worktree, else its working
 *  directory, else (not started yet) the project. */
export function sessionCwd(tabId: string, projectPath: string): string {
  const session = useChatStore.getState().sessions[tabId];
  return session?.bindCwd ?? session?.workingDirectory ?? projectPath;
}

/** The composer text for a hand-off: the prompt, then the context chip's
 *  short form. The chip is remembered so the composer can rebuild it. */
export function composeHandoff(handoff: Handoff, projectPath: string | null): string {
  if (!handoff.context.trim()) return handoff.prompt;
  const chip = pastedTextMention(handoff.context);
  rememberMention(chip, projectPath);
  return `${handoff.prompt}\n\n${toShortForm(chip)} `;
}

/**
 * Write `handoff` into a session's composer.
 *
 * `into` is an existing chat tab (the current session): the task is appended
 * to whatever it holds. Otherwise a new session tab opens on `agent`, bound to
 * `cwd` when that is not the project root (a pull request's worktree). The
 * project is made active first, as "New session on branch" does, so the
 * session and its chip resolve against it.
 */
export async function openHandoffSession(opts: {
  projectPath: string;
  cwd: string;
  agent: SwitchableAgent;
  handoff: Handoff;
  into?: string | null;
}): Promise<string> {
  const { projectPath, cwd, agent, handoff, into } = opts;
  await activateProject(projectPath);
  const chat = useChatStore.getState();
  const text = composeHandoff(handoff, projectPath);
  if (into && chat.sessions[into]) {
    const current = chat.drafts[into] ?? "";
    const next = current.trim() ? `${current}\n\n${text}` : text;
    chat.actions.setDraft(into, next);
    useLayoutStore.getState().actions.setActiveTab(into);
    requestAnimationFrame(() =>
      window.dispatchEvent(
        new CustomEvent("atlas:chat-insert", { detail: { text: next, tabId: into } }),
      ),
    );
    return into;
  }
  const tabId = openAgentChatInNewTab(agent);
  if (cwd.replace(/\/+$/, "") !== projectPath.replace(/\/+$/, "")) {
    chat.actions.setBindCwd(tabId, cwd);
  }
  useChatStore.getState().actions.setDraft(tabId, text);
  // A composer that mounted before the draft was written still gets it.
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("atlas:chat-insert", { detail: { text, tabId } })),
  );
  return tabId;
}
