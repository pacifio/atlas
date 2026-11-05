// Kept for later: the session terminal drawer is unmounted (no UI reaches it) until the terminal rework. Not dead code; do not delete.
//
// A session's terminal drawer: shells under the composer, in the session's
// working directory, that stay with the session.
//
// Rendered by the chat panel, once per session tab, with two strings. Closed,
// it is one boolean subscription and renders nothing: no terminal, no
// listener, no measurement, and the terminal code is not even loaded. Open,
// it renders the body (`session-terminal-drawer-body.tsx`). The chat panel
// subscribes to none of it, so typing in the drawer, a shell's output and
// dragging the drawer's edge re-render the drawer and never the session.
//
// Closing the drawer unmounts it; its shells keep running in the session
// registry (`terminal-session.ts`), and reopening re-attaches them where they
// were. `session-drawer-store.ts` says when they end.

import { lazy, memo, Suspense } from "react";

import { useSessionDrawerStore } from "../stores/session-drawer-store";
import type { SessionTerminalDrawerProps } from "./session-terminal-drawer-body";

const SessionTerminalDrawerBody = lazy(() => import("./session-terminal-drawer-body"));

export const SessionTerminalDrawer = memo(function SessionTerminalDrawer({
  tabId,
  scope,
}: SessionTerminalDrawerProps) {
  const open = useSessionDrawerStore((s) => !!s.open[scope]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SessionTerminalDrawerBody tabId={tabId} scope={scope} />
    </Suspense>
  );
});
