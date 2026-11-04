// The agent asking the user for data mid-turn (ACP `elicitation/create`), as
// a dialog: one field per schema property, or a page to open and confirm.
//
// Props only. The container (`elicitation-modal.tsx`) parses the schema,
// sends the answer and keeps the dialog open when a send fails. This view
// holds the field values while the user fills them in, and computes whether
// the form is complete.
//
// Every control is a separate tab stop, as before: the enum chips are single
// package `Toggle`s rather than a `ToggleGroup`, whose roving focus would turn
// them into one stop walked by arrow keys. No `initialFocus`: Base UI focuses
// the first tabbable control, as it always has (moving it is a proposed
// behaviour change, not yet approved).
//
// Composed from the package's dialog parts, not `DialogContent`, to keep the
// frosted scrim (`DialogOverlay blur`) the package reserves for blocking
// prompts; `DialogContent`'s built-in overlay cannot carry it.

import { useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ExternalLink, HelpCircle } from "lucide-react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Icon,
  Input,
  Switch,
  Toggle,
} from "@tryatlas/design";
import { elicitationComplete, type ElicitationField } from "../../lib/elicitation-schema";

/** A field's starting value: the schema's default, else `false` for a
 *  boolean, else nothing. */
function seedValues(fields: ElicitationField[]): Record<string, unknown> {
  const seed: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.default !== null) seed[f.name] = f.default;
    else if (f.kind === "boolean") seed[f.name] = false;
  }
  return seed;
}

export function ElicitationDialogView({
  mode,
  message,
  url,
  fields,
  busy,
  remoteDriver = null,
  onAccept,
  onDecline,
  onCancel,
  onOpenUrl,
}: {
  mode: "form" | "url";
  message: string;
  /** `url` mode's page; `null` shows no Open page button. */
  url: string | null;
  fields: ElicitationField[];
  /** A reply is in flight: Send and Decline wait for it. */
  busy: boolean;
  /** Who holds the session's remote-control seat when it is not this
   *  account; only they can answer, so both actions are off. */
  remoteDriver?: string | null;
  onAccept: (values: Record<string, unknown>) => void;
  onDecline: () => void;
  /** Esc or a click outside: the question is withdrawn, not declined. */
  onCancel: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => seedValues(fields));
  const complete = elicitationComplete(fields, values);
  const set = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }));
  const locked = remoteDriver !== null;

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogPortal>
        <DialogOverlay blur />
        <DialogPrimitive.Popup
          data-testid="elicitation-dialog"
          // The package dialog's surface, anchored a quarter down the window
          // like every blocking prompt rather than centred.
          className="fixed top-[24%] left-1/2 z-modal w-[480px] max-w-[92vw] -translate-x-1/2 rounded-xl border border-border bg-card text-foreground shadow-lg outline-none data-open:animate-scale-in data-closed:animate-scale-out"
        >
          <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
            <Icon icon={HelpCircle} size="lg" className="mt-0.5 shrink-0 text-muted-foreground" />
            <DialogHeader className="min-w-0">
              <DialogTitle>The agent has a question</DialogTitle>
              <DialogDescription className="break-words">{message}</DialogDescription>
            </DialogHeader>
          </div>

          <div className="flex flex-col gap-3 p-4">
            {mode === "url" && url && (
              <div>
                <Button variant="outline" size="md" onClick={() => onOpenUrl(url)}>
                  <Icon icon={ExternalLink} size="sm" />
                  Open page
                </Button>
              </div>
            )}

            {mode === "form" && fields.length === 0 && (
              // A form with nothing to fill is still answerable — the agent may
              // just want a yes/no. Saying so beats an empty box.
              <p className="text-xs text-secondary-foreground">
                Confirm to continue, or decline to tell the agent no.
              </p>
            )}

            {fields.map((f) => (
              <Field key={f.name}>
                <FieldLabel>
                  {f.title}
                  {f.required && <span className="text-muted-foreground">*</span>}
                </FieldLabel>
                {f.description && <FieldDescription>{f.description}</FieldDescription>}
                {f.kind === "boolean" ? (
                  <label className="flex items-center gap-2 self-start text-xs text-secondary-foreground">
                    <Switch
                      checked={values[f.name] === true}
                      onCheckedChange={(next) => set(f.name, next)}
                      aria-label={f.title}
                    />
                    {values[f.name] ? "Yes" : "No"}
                  </label>
                ) : f.kind === "enum" ? (
                  <div className="flex flex-wrap gap-1">
                    {f.choices.map((c) => {
                      // Multi-select fields hold an array, so "picked" is
                      // membership and pressing toggles rather than replaces.
                      const picked = f.multi
                        ? Array.isArray(values[f.name]) &&
                          (values[f.name] as string[]).includes(c.value)
                        : values[f.name] === c.value;
                      return (
                        <Toggle
                          key={c.value}
                          variant="outline"
                          title={c.description ?? undefined}
                          pressed={picked}
                          onPressedChange={() => {
                            // A single choice stays picked when pressed again:
                            // it is replaced by another choice, never cleared.
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
                        >
                          {c.label}
                        </Toggle>
                      );
                    })}
                  </div>
                ) : (
                  <Input
                    type={f.kind === "number" ? "number" : "text"}
                    value={String(values[f.name] ?? "")}
                    onChange={(e) =>
                      set(f.name, f.kind === "number" ? Number(e.target.value) : e.target.value)
                    }
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={f.title}
                  />
                )}
              </Field>
            ))}

            {remoteDriver && (
              <p
                data-testid="elicitation-seat-notice"
                className="text-xs text-secondary-foreground"
              >
                {remoteDriver} is driving from remote control — only they can answer this. Take over
                at the composer to answer it yourself.
              </p>
            )}
            <div className="mt-0.5 flex items-center gap-2">
              <Button
                variant="default"
                size="md"
                disabled={busy || !complete || locked}
                onClick={() => onAccept(mode === "form" ? values : {})}
              >
                {mode === "url" ? "I'm done" : "Send"}
              </Button>
              <Button variant="outline" size="md" disabled={busy || locked} onClick={onDecline}>
                Decline
              </Button>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
