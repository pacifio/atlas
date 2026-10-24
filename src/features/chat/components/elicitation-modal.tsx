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
// Every visual is lifted from `permission-modal.tsx` (chrome, header band) and
// the auth modal (rows, buttons, `text-xs`/`text-xs` scale). No new visual
// patterns — the inputs are the same class the composer and settings already
// use.

import { useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { DialogOverlay } from "@/ui/dialog";
import { HelpCircle, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { agents } from "../lib/agents-api";
import {
  elicitationComplete,
  parseElicitationSchema,
  type ElicitationField,
} from "../lib/elicitation-schema";

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
}: {
  pending: PendingElicitation;
  onClose: () => void;
}) {
  const fields = useMemo(
    () => (pending.mode === "form" ? parseElicitationSchema(pending.requestedSchema) : []),
    [pending.mode, pending.requestedSchema],
  );
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const f of parseElicitationSchema(pending.requestedSchema)) {
      if (f.default !== null) seed[f.name] = f.default;
      else if (f.kind === "boolean") seed[f.name] = false;
    }
    return seed;
  });
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

  const complete = elicitationComplete(fields, values);
  const set = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && void respond("cancel")}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-[24%] z-modal -translate-x-1/2",
            "w-[480px] max-w-[92vw] rounded-lg border border-border bg-card",
            "shadow-md text-foreground",
          )}
        >
          <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
            <HelpCircle className="mt-0.5 size-4 text-muted-foreground" />
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-medium">The agent has a question</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-secondary-foreground break-words">
                {pending.message}
              </Dialog.Description>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 p-3">
            {pending.mode === "url" && pending.url && (
              <button
                onClick={() => void openUrl(pending.url!)}
                className="flex w-full items-center gap-2 rounded-sm border border-border bg-background px-2.5 py-1.5 text-left text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
              >
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Open page</span>
              </button>
            )}

            {pending.mode === "form" &&
              fields.length === 0 && (
                // A form with nothing to fill is still answerable — the agent may
                // just want a yes/no. Saying so beats an empty box.
                <p className="px-0.5 text-xs text-secondary-foreground">
                  Confirm to continue, or decline to tell the agent no.
                </p>
              )}

            {fields.map((f) => (
              <div key={f.name} className="flex flex-col gap-1">
                <label className="text-xs font-medium text-foreground">
                  {f.title}
                  {f.required && <span className="ml-1 text-muted-foreground">*</span>}
                </label>
                {f.description && (
                  <p className="text-2xs leading-snug text-muted-foreground">{f.description}</p>
                )}
                {f.kind === "boolean" ? (
                  <button
                    onClick={() => set(f.name, !values[f.name])}
                    className={cn(
                      "flex items-center gap-2 self-start rounded-sm border border-border px-2.5 py-1 text-xs transition-colors",
                      values[f.name]
                        ? "bg-element-selected text-foreground"
                        : "text-secondary-foreground hover:bg-element-hover",
                    )}
                  >
                    {values[f.name] ? "Yes" : "No"}
                  </button>
                ) : f.kind === "enum" ? (
                  <div className="flex flex-wrap gap-1">
                    {f.choices.map((c) => {
                      // Multi-select fields hold an array, so "picked" is
                      // membership and clicking toggles rather than replaces.
                      const picked = f.multi
                        ? Array.isArray(values[f.name]) &&
                          (values[f.name] as string[]).includes(c.value)
                        : values[f.name] === c.value;
                      return (
                        <button
                          key={c.value}
                          title={c.description}
                          onClick={() => {
                            if (!f.multi) return set(f.name, c.value);
                            const cur = Array.isArray(values[f.name])
                              ? (values[f.name] as string[])
                              : [];
                            set(
                              f.name,
                              cur.includes(c.value)
                                ? cur.filter((v) => v !== c.value)
                                : [...cur, c.value],
                            );
                          }}
                          className={cn(
                            "rounded-sm border border-border px-2 py-1 text-xs transition-colors",
                            picked
                              ? "bg-element-selected text-foreground"
                              : "text-secondary-foreground hover:bg-element-hover",
                          )}
                        >
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    type={f.kind === "number" ? "number" : "text"}
                    value={String(values[f.name] ?? "")}
                    onChange={(e) =>
                      set(f.name, f.kind === "number" ? Number(e.target.value) : e.target.value)
                    }
                    spellCheck={false}
                    autoComplete="off"
                    className="h-8 w-full rounded-sm border border-border bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-border-strong"
                  />
                )}
              </div>
            ))}

            <div className="mt-0.5 flex items-center gap-2">
              <button
                disabled={busy || !complete}
                onClick={() => void respond("accept", pending.mode === "form" ? values : {})}
                className="h-7 rounded-sm border border-border px-2.5 text-xs text-foreground hover:bg-element-hover disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {pending.mode === "url" ? "I'm done" : "Send"}
              </button>
              <button
                disabled={busy}
                onClick={() => void respond("decline")}
                className="h-7 rounded-sm px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Decline
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
