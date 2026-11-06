// Rust's `atlas:org-agent` channel into the store, for the life of the app.
//
// Started from `App.tsx`, before any agent view mounts, so a conversation
// answered while its panel is closed still lands (and is marked unread), and
// so a Deep research report that arrives with the window in the background
// can say so. The current state is read once at start, for an app that
// mounted after the socket's last announcement.

import { toast } from "sonner";

import { showNativeNotification } from "@/lib/native-notify";
import { isWindowFocused } from "@/lib/window-focus";

import { useOrgAgentStore } from "../stores/org-agent-store";
import { orgAgent } from "./org-agent-api";
import { openTarget } from "./org-agent-navigate";

/** Re-read the effort data at most this often while the window regains focus
 *  (the web's guidance: on open, after a turn, and at most every minute). */
const FOCUS_REFRESH_MS = 60_000;

export function startOrgAgentBridge(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  const actions = () => useOrgAgentStore.getState().actions;

  void orgAgent
    .listen((envelope) => actions().onEnvelope(envelope))
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => {});

  void orgAgent
    .status()
    .then((s) => {
      if (!disposed) actions().adopt(s.orgId, s.state);
    })
    .catch(() => {});

  // Finished reports and today's counts move on the web too: read them when
  // the person comes back to the window.
  let lastFocusRefresh = 0;
  const onFocus = () => {
    const s = useOrgAgentStore.getState();
    if (s.connection !== "open" || Date.now() - lastFocusRefresh < FOCUS_REFRESH_MS) return;
    lastFocusRefresh = Date.now();
    void s.actions.refreshNotifications();
    void s.actions.refreshEffort();
    void s.actions.refreshStatus();
  };
  window.addEventListener("focus", onFocus);

  // A Deep research report landing: a banner when the window is in the
  // background, a toast that opens it when it is not.
  const onReport = (e: Event) => {
    const detail = (e as CustomEvent<{ askId: string; title: string; partial: boolean }>).detail;
    if (!detail) return;
    const body = detail.partial ? `${detail.title} (written from what was found)` : detail.title;
    if (isWindowFocused()) {
      toast("Deep research is ready", {
        description: body,
        action: { label: "Open", onClick: () => openTarget({ kind: "ask", askId: detail.askId }) },
      });
      return;
    }
    void showNativeNotification({
      tag: `org-agent-report:${detail.askId}`,
      group: "org-agent",
      title: "Deep research is ready",
      body,
    });
  };
  window.addEventListener("atlas:org-agent-report", onReport);

  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("atlas:org-agent-report", onReport);
  };
}
