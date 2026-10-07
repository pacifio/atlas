/**
 * `ui_chat`: steer a chat tab's composer through the chat's own window
 * events. **Own-session refusal** (CONTEXT.md): on the chat the calling
 * session runs in, the agent may prefill or insert text for the user to send,
 * but never send it, and never switch that chat's agent out from under its
 * own turn. No override.
 */

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore, findTabByAcpSession } from "@/features/chat/stores/chat-store";
import { switchAgentForTab } from "@/features/chat/lib/switch-agent";
import { isSendHeldElsewhere } from "@/features/chat/stores/live-elsewhere-store";
import { readArgs, refuse } from "./args";
import { tabInScope } from "./scope";
import type { UiActionRequest } from "./types";

const OPS = ["focus", "prefill", "insert", "send", "jump", "switch_agent"] as const;

const emit = (name: string, detail: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

export function performChat(request: UiActionRequest): unknown {
  const a = readArgs("ui_chat", request.args);
  const op = a.oneOf("op", OPS);
  const sessions = useChatStore.getState().sessions;
  const own = findTabByAcpSession(sessions, request.sessionId);
  const tabId =
    a.optStr("tabId") ??
    own ??
    refuse("ui_chat: you have no chat tab of your own here; pass tabId (ui_state lists tabs)");
  const tab = tabInScope(tabId);
  if (tab.type !== "chat") return refuse(`tab ${tabId} is not a chat`);
  // By the tab's own session, not by equality with the first match: a stale
  // session entry for the same ACP session can precede the live tab's.
  const isOwn =
    tabId === own ||
    (request.sessionId !== "" && sessions[tabId]?.acpSessionId === request.sessionId);

  // Read every argument before touching the window, so a malformed call
  // changes nothing.
  const text = op === "prefill" || op === "insert" || op === "send" ? a.str("text") : undefined;
  const index =
    op === "jump"
      ? (a.optInt("index", 0) ?? refuse("ui_chat: index must be an integer ≥ 0"))
      : undefined;
  const agent = op === "switch_agent" ? a.str("agent") : undefined;
  if (isOwn && op === "send") {
    return refuse(
      "ui_chat: you may not send a message in your own chat; use prefill so the user sends it",
    );
  }
  // ADR-0001 amendment, Rule 7: another process (likely a terminal) is still
  // writing this session, and a send from here would fork it. Only the user
  // can choose that ("Send anyway" in the composer). The chat would hold the
  // message anyway; refusing tells the caller instead of leaving it queued.
  if (op === "send" && isSendHeldElsewhere(sessions[tabId]?.acpSessionId)) {
    return refuse(
      `ui_chat: tab ${tabId}'s session is active in another process (likely a terminal); ` +
        "sending would fork it. Use prefill and let the user choose Send anyway",
    );
  }
  if (isOwn && op === "switch_agent") {
    return refuse("ui_chat: you may not switch the agent of your own chat; ask the user");
  }

  useLayoutStore.getState().actions.setActiveTab(tabId);
  useChatStore.getState().actions.setActiveSession(tabId);
  switch (op) {
    case "focus":
      emit("atlas:chat-focus", { tabId });
      break;
    case "prefill":
      // Replaces the draft; the composer offers Undo.
      emit("atlas:chat-prefill", { tabId, text });
      break;
    case "insert":
      // Untargeted insert appends to the active composer (a targeted one
      // replaces), so the tab is made active first.
      emit("atlas:chat-insert", { text });
      break;
    case "send":
      emit("atlas:chat-send", { tabId, text });
      break;
    case "jump":
      emit("atlas:chat-jump", { index });
      break;
    case "switch_agent":
      switchAgentForTab(tabId, agent as string);
      break;
  }
  return { tabId, op };
}
