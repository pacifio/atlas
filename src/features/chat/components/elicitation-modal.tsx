// The agent asking the USER something mid-turn (P3.3, ACP `elicitation/create`).
//
// Distinct from the permission modal, which asks "may I do this thing I have
// already decided on" and offers a fixed set of agent-supplied options. An
// elicitation asks for DATA — a branch name, a choice between environments, a
// confirmation — described by a JSON schema the agent sends with the request.
//
// Two modes:
//   `form` → inputs generated from `requestedSchema`.
//   `url`  → send the user to a page and wait. This is the modern browser-auth
//            path, so it reuses the same "open page" affordance
//            `AgentOAuthModal` uses for a login CLI's OAuth URL.
//
// This is the container: it parses the schema, sends the reply and keeps the
// dialog up when a send fails. `ElicitationDialogView` draws it.

import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { agents } from "../lib/agents-api";
import {
  elicitationComplete,
  parseElicitationSchema,
  type ElicitationField,
} from "../lib/elicitation-schema";
import { ElicitationDialogView } from "./views/elicitation-dialog-view";

// The schema projection moved to `../lib/elicitation-schema` once the question
// card needed it too. Re-exported so this file stays the one import site for
// everything elicitation-shaped.
export { elicitationComplete, parseElicitationSchema };
export type { ElicitationField };

export interface PendingElicitation {
  agentId: string;
  requestId: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: unknown;
  url?: string | null;
}

export function ElicitationModal({
  pending,
  onClose,
  remoteDriver = null,
}: {
  pending: PendingElicitation;
  onClose: () => void;
  /** Who holds the session's remote-control seat when it is not this
   *  account. An elicitation is steering (design review §4.4): Rust refuses
   *  the local answer while someone else drives, so the dialog says so and
   *  waits instead of bouncing an error. `null` when the seat is ours or the
   *  question is not a session's (a sign-in, which stays desktop-only). */
  remoteDriver?: string | null;
}) {
  const fields = useMemo(
    () => (pending.mode === "form" ? parseElicitationSchema(pending.requestedSchema) : []),
    [pending.mode, pending.requestedSchema],
  );
  const [busy, setBusy] = useState(false);

  const respond = async (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) => {
    setBusy(true);
    try {
      await agents.respondElicitation(pending.agentId, pending.requestId, action, content);
      onClose();
    } catch (e) {
      // Stay open: the agent is still waiting on this reply, so dismissing on a
      // failed send would strand it with nothing left to retry from.
      setBusy(false);
      toast.error(`Could not send your answer: ${e}`);
    }
  };

  return (
    <ElicitationDialogView
      mode={pending.mode}
      message={pending.message}
      url={pending.url ?? null}
      fields={fields}
      busy={busy}
      remoteDriver={remoteDriver}
      onAccept={(values) => void respond("accept", values)}
      onDecline={() => void respond("decline")}
      onCancel={() => void respond("cancel")}
      onOpenUrl={(url) => void openUrl(url)}
    />
  );
}
