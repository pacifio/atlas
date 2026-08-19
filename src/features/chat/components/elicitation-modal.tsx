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
// the auth modal (rows, buttons, `text-xs`/`text-[11px]` scale). No new visual
// patterns — the inputs are the same class the composer and settings already
// use.

import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { HelpCircle, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { agents } from "../lib/agents-api";

/** One field the agent wants filled, projected from its JSON schema. */
export interface ElicitationField {
  name: string;
  title: string;
  description: string | null;
  kind: "string" | "number" | "boolean" | "enum";
  required: boolean;
  /** `enum` only. */
  choices: string[];
  default: string | number | boolean | null;
}

/** Project `requestedSchema` (a JSON Schema object) into renderable fields.
 *
 *  Exported for tests: this is where a malformed or exotic schema either
 *  degrades gracefully or produces a form the user cannot complete. Anything
 *  whose type is unrecognised falls back to a text input rather than being
 *  dropped — a field the agent required but Atlas silently omitted would make
 *  the whole request unanswerable.
 */
export function parseElicitationSchema(schema: unknown): ElicitationField[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const props = s.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: ElicitationField[] = [];
  for (const [name, rawProp] of Object.entries(props as Record<string, unknown>)) {
    if (!rawProp || typeof rawProp !== "object") continue;
    const prop = rawProp as Record<string, unknown>;
    const choices = Array.isArray(prop.enum) ? prop.enum.map(String) : [];
    const type = typeof prop.type === "string" ? prop.type : "";
    const kind: ElicitationField["kind"] =
      choices.length > 0
        ? "enum"
        : type === "boolean"
          ? "boolean"
          : type === "number" || type === "integer"
            ? "number"
            : "string";
    out.push({
      name,
      title: typeof prop.title === "string" && prop.title ? prop.title : name,
      description: typeof prop.description === "string" ? prop.description : null,
      kind,
      required: required.has(name),
      choices,
      default:
        typeof prop.default === "string" ||
        typeof prop.default === "number" ||
        typeof prop.default === "boolean"
          ? prop.default
          : null,
    });
  }
  return out;
}

/** Whether every required field has a usable answer.
 *
 *  Booleans are always answered (false IS an answer), which is why they are
 *  excluded rather than checked for truthiness — treating an unchecked required
 *  checkbox as "unanswered" would make it impossible to submit "no". */
export function elicitationComplete(
  fields: ElicitationField[],
  values: Record<string, unknown>,
): boolean {
  return fields
    .filter((f) => f.required && f.kind !== "boolean")
    .every((f) => {
      const v = values[f.name];
      return v !== undefined && v !== null && String(v).trim().length > 0;
    });
}

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
    } catch (e) {
      console.warn("respondElicitation failed:", e);
    } finally {
      onClose();
    }
  };

  const complete = elicitationComplete(fields, values);
  const set = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && void respond("cancel")}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-[24%] z-[var(--z-modal)] -translate-x-1/2",
            "w-[480px] max-w-[92vw] rounded-lg border border-border-default bg-bg-elevated",
            "shadow-[var(--shadow-overlay)] text-text-primary",
          )}
        >
          <div className="flex items-start gap-2.5 border-b border-border-default px-4 py-3">
            <HelpCircle className="mt-0.5 size-4 text-text-tertiary" />
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-medium">The agent has a question</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-secondary break-words">
                {pending.message}
              </Dialog.Description>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 p-3">
            {pending.mode === "url" && pending.url && (
              <button
                onClick={() => void openUrl(pending.url!)}
                className="flex w-full items-center gap-2 rounded-sm border border-border-default bg-bg-base px-2.5 py-1.5 text-left text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <ExternalLink className="size-3.5 shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate">Open page</span>
              </button>
            )}

            {pending.mode === "form" &&
              fields.length === 0 && (
                // A form with nothing to fill is still answerable — the agent may
                // just want a yes/no. Saying so beats an empty box.
                <p className="px-0.5 text-xs text-text-secondary">
                  Confirm to continue, or decline to tell the agent no.
                </p>
              )}

            {fields.map((f) => (
              <div key={f.name} className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-text-primary">
                  {f.title}
                  {f.required && <span className="ml-1 text-text-tertiary">*</span>}
                </label>
                {f.description && (
                  <p className="text-[10px] leading-snug text-text-tertiary">{f.description}</p>
                )}
                {f.kind === "boolean" ? (
                  <button
                    onClick={() => set(f.name, !values[f.name])}
                    className={cn(
                      "flex items-center gap-2 self-start rounded-sm border border-border-default px-2.5 py-1 text-[11px] transition-colors",
                      values[f.name]
                        ? "bg-bg-selected text-text-primary"
                        : "text-text-secondary hover:bg-bg-hover",
                    )}
                  >
                    {values[f.name] ? "Yes" : "No"}
                  </button>
                ) : f.kind === "enum" ? (
                  <div className="flex flex-wrap gap-1">
                    {f.choices.map((c) => (
                      <button
                        key={c}
                        onClick={() => set(f.name, c)}
                        className={cn(
                          "rounded-sm border border-border-default px-2 py-1 text-[11px] transition-colors",
                          values[f.name] === c
                            ? "bg-bg-selected text-text-primary"
                            : "text-text-secondary hover:bg-bg-hover",
                        )}
                      >
                        {c}
                      </button>
                    ))}
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
                    className="h-8 w-full rounded-sm border border-border-default bg-bg-base px-2.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-[var(--border-focus,var(--border-default))]"
                  />
                )}
              </div>
            ))}

            <div className="mt-0.5 flex items-center gap-2">
              <button
                disabled={busy || !complete}
                onClick={() => void respond("accept", pending.mode === "form" ? values : {})}
                className="h-7 rounded-sm border border-border-default px-2.5 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {pending.mode === "url" ? "I'm done" : "Send"}
              </button>
              <button
                disabled={busy}
                onClick={() => void respond("decline")}
                className="h-7 rounded-sm px-2 text-xs text-text-tertiary hover:text-text-primary"
              >
                Decline
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
