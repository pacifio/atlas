import { useEffect, useRef } from "react";
import { isBusyAgentStatus } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { useSessionLifecycleStore } from "../stores/session-lifecycle-store";

/**
 * Marks the session in front of the user as viewed — what clears "unread"
 * and "Woke" — through the lifecycle store's debounced `noteViewed`.
 *
 * "In front of the user" is the active chat tab's live session, while the
 * window has focus. It is marked when the tab becomes active, when the window
 * regains focus, and when a turn finishes in it while the user is there (they
 * watched it finish, so that completion is not unread). A turn finishing
 * while the window is in the background stays unread until the user comes
 * back. Switching away before the debounce runs out cancels the mark.
 *
 * Mounted once, by `SessionViewedTracker`.
 */
export function useMarkActiveSessionViewed(): void {
  const sessionId = useChatStore((s) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId]?.acpSessionId ?? null) : null,
  );
  const busy = useChatStore((s) => {
    const tab = s.activeSessionId;
    return tab ? isBusyAgentStatus(s.sessions[tab]?.status) : false;
  });
  const current = useRef<string | null>(null);

  useEffect(() => {
    const { noteViewed, cancelViewed } = useSessionLifecycleStore.getState().actions;
    current.current = sessionId;
    if (!sessionId || busy) return;
    if (document.hasFocus()) noteViewed(sessionId);
    return () => cancelViewed(sessionId);
  }, [sessionId, busy]);

  useEffect(() => {
    const { noteViewed, cancelViewed } = useSessionLifecycleStore.getState().actions;
    const onFocus = () => {
      if (current.current) noteViewed(current.current);
    };
    const onBlur = () => {
      if (current.current) cancelViewed(current.current);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}

/** Renders nothing; mounts {@link useMarkActiveSessionViewed} once for the app. */
export function SessionViewedTracker(): null {
  useMarkActiveSessionViewed();
  return null;
}
