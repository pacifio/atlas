/**
 * Where UI actions arrive. Mounted once at app level, beside the elicitation
 * host — never inside a chat tab, because a request must be answered whether
 * or not the calling session's tab is visible (ARCHITECTURE.md, "streams are
 * tab-independent").
 *
 * Every request this window owns gets exactly one answer, and the answer
 * comes before Rust's own ten-second bound, so a slow action reports its own
 * error rather than a generic timeout.
 *
 * The organisation calls that cross to the window (drawing on a Space page)
 * arrive here too, under their own event: one bridge, one ownership rule,
 * one deadline, one answer command — two dispatchers.
 */

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { withDeadline } from "@/features/chat/lib/with-deadline";
import { listenOrgWindowAction } from "@/features/org-actions/lib/org-actions-api";
import { performOrgWindowAction } from "@/features/org-actions/lib/org-window-actions";
import { listenUiAction, respondUiAction } from "../lib/ui-actions-api";
import { ownsUiActionRequest } from "../lib/ownership";
import { performUiAction } from "../lib/ui-actions";
import { fail, type UiActionReply, type UiActionRequest } from "../lib/types";

const ACTION_DEADLINE_MS = 8_000;
/** Request ids already answered, so a duplicate delivery is not performed twice. */
const SEEN_CAP = 256;

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

export function UiActionBridge() {
  useEffect(() => {
    const seen = new Set<string>();
    const answer = (
      request: UiActionRequest,
      perform: (request: UiActionRequest) => Promise<UiActionReply>,
    ) => {
      if (seen.has(request.requestId) || !ownsUiActionRequest(request, windowLabel())) return;
      seen.add(request.requestId);
      if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
      void (async () => {
        let reply: UiActionReply;
        try {
          reply = await withDeadline(
            perform(request),
            ACTION_DEADLINE_MS,
            `${request.tool} did not finish`,
          );
        } catch (e) {
          reply = fail(e instanceof Error ? e.message : String(e));
        }
        await respondUiAction(request.requestId, reply).catch(() => {});
      })();
    };
    const unlisten = [
      listenUiAction((request) => answer(request, performUiAction)),
      listenOrgWindowAction((request) => answer(request, performOrgWindowAction)),
    ];
    return () => {
      for (const stop of unlisten) void stop.then((off) => off());
    };
  }, []);
  return null;
}
