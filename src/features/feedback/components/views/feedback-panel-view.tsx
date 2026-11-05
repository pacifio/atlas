import { useRef, type ReactNode, type RefObject } from "react";
import { Camera, Check, EyeOff, MessageCircleQuestion, MessagesSquare, X } from "lucide-react";
import {
  Button,
  GitHubMark,
  Hint,
  IconButton,
  ToggleGroup,
  ToggleGroupItem,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";

export interface FeedbackCategoryOption {
  id: string;
  label: string;
  placeholder: string;
}

export interface FeedbackPanelViewProps {
  categories: ReadonlyArray<FeedbackCategoryOption>;
  capturing: boolean;
  category: string;
  message: string;
  shot: { mimeType: string; dataBase64: string } | null;
  anonymous: boolean;
  submitting: boolean;
  sent: boolean;
  error: string | null;
  /** The signed-in account, or null when signed out (always anonymous). */
  identity: { avatar: ReactNode; name: string } | null;
  telemetryOff: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
  onCategory: (id: string) => void;
  onMessage: (message: string) => void;
  onAttach: () => void;
  onRemoveShot: () => void;
  onToggleAnonymous: () => void;
  onSubmit: () => void;
  onSendAnother: () => void;
  onOpenIssue: () => void;
  onOpenCommunity: () => void;
}

/** Inset from the window's bottom-right corner. The status bar the panel
 *  used to sit above is gone (2026-09-16); the feedback entry is now the
 *  project sidebar's menu and Settings. */
const EDGE_OFFSET = 12;

/**
 * Floating feedback panel, anchored bottom-right.
 *
 * **Non-modal on purpose** — no scrim, no focus trap. The user is describing
 * what is on screen *behind* this, and may want to re-read it or point at it;
 * dimming the app would be exactly backwards. For the same reason there is no
 * click-outside-to-close: a stray click in the app must not destroy a
 * half-written bug report. Esc and the X are the two ways out, and neither
 * discards the draft.
 */
export function FeedbackPanelView({
  categories,
  capturing,
  category,
  message,
  shot,
  anonymous,
  submitting,
  sent,
  error,
  identity,
  telemetryOff,
  textareaRef,
  onClose,
  onCategory,
  onMessage,
  onAttach,
  onRemoveShot,
  onToggleAnonymous,
  onSubmit,
  onSendAnother,
  onOpenIssue,
  onOpenCommunity,
}: FeedbackPanelViewProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const canSubmit = message.trim().length > 0 && !submitting;
  const active = categories.find((c) => c.id === category) ?? categories[0];

  /** ArrowLeft/ArrowRight SELECT the previous/next category (wrapping), not
   *  just move focus, so the group stays one Tab stop holding the choice. */
  const selectAdjacent = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = categories.findIndex((c) => c.id === category);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % categories.length
        : (i - 1 + categories.length) % categories.length;
    onCategory(categories[next].id);
    requestAnimationFrame(() => {
      groupRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    });
  };

  return (
    <div
      role="dialog"
      aria-label="Send feedback"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className={cn(
        // `rounded-xl` matches the create-organisation modal — the house radius
        // for a panel this size. `rounded-2xl` read as a pill at 380px wide.
        "fixed right-3 z-toast w-[380px] rounded-xl overflow-hidden select-none",
        // Border, translucent fill and blur all on THIS element — which is also
        // the one the enter animation transforms. Splitting them would isolate
        // the layer and flatten the blur.
        // `inset-highlight` + `shadow-lg` is the same recipe as the other
        // floating panels (a themed top edge plus a heavy drop shadow); the
        // old hardcoded black shadow rendered fine in dark but was much too
        // heavy for a light theme, so this is also a light-mode fix.
        "border border-border-subtle bg-card/95 backdrop-blur-2xl inset-highlight shadow-lg",
        "atlas-panel-in-br",
        // Still laid out (and animated in) while `screencapture` is on screen,
        // just invisible, so the panel never lands in the user's own shot.
        capturing && "invisible",
      )}
      style={{
        bottom: EDGE_OFFSET,
        // No `will-change` — it would isolate the layer and kill the blur.
      }}
    >
      <div className="flex items-center gap-2 px-3.5 h-9 border-b border-border-subtle">
        <MessageCircleQuestion size={13} strokeWidth={1.5} className="text-secondary-foreground" />
        <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Send feedback
        </span>
        <div className="flex-1" />
        <Hint label="Close">
          <IconButton size="xs" icon={X} label="Close feedback" onClick={onClose} />
        </Hint>
      </div>

      {sent ? (
        <div role="status" className="flex flex-col items-center gap-2 px-6 py-7">
          <div className="grid h-9 w-9 place-items-center rounded-full border border-border-subtle bg-element-hover">
            <Check size={16} strokeWidth={1.75} className="text-success" />
          </div>
          <p className="text-sm text-foreground">Thanks — we got it.</p>
          <Button variant="ghost" size="xs" className="mt-1" onClick={onSendAnother}>
            Send another
          </Button>
        </div>
      ) : (
        <>
          <ToggleGroup
            ref={groupRef}
            aria-label="Feedback category"
            value={[category]}
            onValueChange={(v) => {
              if (v[0]) onCategory(v[0]);
            }}
            onKeyDown={selectAdjacent}
            className="mx-3.5 mt-3 flex-wrap"
          >
            {categories.map((c) => (
              <ToggleGroupItem key={c.id} value={c.id} variant="outline">
                {c.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => onMessage(e.target.value)}
            rows={5}
            maxLength={4000}
            aria-label="Your feedback"
            placeholder={active?.placeholder}
            className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-relaxed text-foreground placeholder:text-disabled outline-none select-text"
          />

          <div className="flex items-center gap-2 px-3.5 pb-2.5">
            {shot ? (
              <div className="group relative h-11 w-[72px] shrink-0 overflow-hidden rounded-md border border-border-subtle">
                <img
                  src={`data:${shot.mimeType};base64,${shot.dataBase64}`}
                  alt="Attached screenshot"
                  className="h-full w-full object-cover"
                />
                <Hint label="Remove screenshot">
                  <button
                    type="button"
                    onClick={onRemoveShot}
                    aria-label="Remove screenshot"
                    // ratchet-allow: a fixed dark scrim over an arbitrary screenshot
                    // thumbnail, not over app chrome — it must stay legible regardless
                    // of theme, so it deliberately does not follow a theme token (no
                    // key in the current set expresses "contrast badge on
                    // unpredictable image content" either).
                    className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full scrim text-white/80 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                  >
                    <X size={9} />
                  </button>
                </Hint>
              </div>
            ) : (
              <Button
                variant="outline"
                size="xs"
                onClick={onAttach}
                title="Drag a region — or press Space, then click the Atlas window."
              >
                <Camera size={11} strokeWidth={1.75} />
                Attach screenshot
              </Button>
            )}
          </div>

          {error && (
            <p role="alert" className="px-3.5 pb-2 text-2xs text-error">
              {error}
            </p>
          )}

          {telemetryOff && (
            // Say it plainly rather than in a tooltip: this is the one path that
            // transmits with usage data switched off, and the user pressed a
            // button labelled "Send".
            <p className="px-3.5 pb-2 text-2xs leading-snug text-disabled">
              Usage data is off. This feedback is still sent, because you asked for it to be.
            </p>
          )}

          <div className="flex items-center gap-2 px-3.5 py-2 border-t border-border-subtle">
            {identity ? (
              <Hint
                label={
                  anonymous ? "Send with your Atlas account instead" : "Send anonymously instead"
                }
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={anonymous}
                  // A FIXED name, not the visible text: the label below changes
                  // between states, so letting it double as the accessible name
                  // made a screen reader read "Sending as Jane, switch, off" —
                  // a state contradicting its own name. This names what the
                  // switch controls; `aria-checked` says where it stands.
                  aria-label="Send anonymously"
                  onClick={onToggleAnonymous}
                  // The row used to read as static text: a colour-only hover
                  // that only showed once the pointer was already there, plus a
                  // native `title` that arrived ~1s late. Padding + a rounded
                  // hover fill make it look like the control it is, without
                  // changing the gutter (the negative margin cancels the
                  // padding) or the row height (the Send button is taller).
                  // The focus ring is the app-wide `:focus-visible` one.
                  className="inline-flex min-w-0 items-center gap-1.5 -mx-1.5 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-secondary-foreground hover:bg-element-hover transition-colors cursor-pointer"
                >
                  {/* The face is the point: at a glance you can tell whether this
                      report will be attributable to you. Anonymous swaps it for a
                      shield rather than dropping the slot, so the row doesn't
                      reflow as you toggle. */}
                  {anonymous ? (
                    <EyeOff size={11} strokeWidth={1.75} className="shrink-0" />
                  ) : (
                    identity.avatar
                  )}
                  <span className="truncate">
                    {anonymous ? "Sending anonymously" : `Sending as ${identity.name}`}
                  </span>
                </button>
              </Hint>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-2xs text-disabled">
                <EyeOff size={11} strokeWidth={1.75} className="shrink-0" />
                Sending anonymously
              </span>
            )}
            <div className="flex-1" />
            <Button variant="default" size="sm" onClick={onSubmit} disabled={!canSubmit}>
              {submitting ? "Sending…" : "Send"}
            </Button>
          </div>
        </>
      )}

      <div className="flex items-center gap-1 px-2 h-8 border-t border-border-subtle bg-muted/40">
        <Button variant="ghost" size="xs" onClick={onOpenIssue}>
          <GitHubMark width={10} height={10} />
          Open a GitHub issue
        </Button>
        <div className="w-px h-3 bg-border-subtle" aria-hidden />
        <Button variant="ghost" size="xs" onClick={onOpenCommunity}>
          <MessagesSquare size={10} />
          Join the community
        </Button>
      </div>
    </div>
  );
}
