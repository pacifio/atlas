import { useEffect, useRef } from "react";
import {
  Camera,
  Check,
  EyeOff,
  Github,
  MessageCircleQuestion,
  MessagesSquare,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useFeedbackStore } from "../stores/feedback-store";
import { CATEGORIES } from "../lib/feedback-api";
import { DISCORD_URL, issueUrl, openExternal } from "../lib/feedback-links";

/** Status bar is `h-7` (28px); sit 8px above it, or 12px off the edge when it's
 *  hidden. The one magic number here — there is no CSS var for the bar height. */
const BAR_OFFSET = 36;
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
export function FeedbackPanel() {
  const open = useFeedbackStore.use.open();
  const capturing = useFeedbackStore.use.capturing();
  const category = useFeedbackStore.use.category();
  const message = useFeedbackStore.use.message();
  const shot = useFeedbackStore.use.shot();
  const anonymous = useFeedbackStore.use.anonymous();
  const submitting = useFeedbackStore.use.submitting();
  const sent = useFeedbackStore.use.sent();
  const error = useFeedbackStore.use.error();
  const a = useFeedbackStore.use.actions();

  const snapshot = useAuthStore.use.snapshot();
  const settings = useProjectStore.use.settings();
  const barVisible = useLayoutStore.use.bottomPanel().visible;

  const user = snapshot.status === "signed-in" ? snapshot.user : null;
  const signedIn = !!user;
  const displayName = user ? user.name || user.email || "your Atlas account" : null;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const radioRef = useRef<HTMLDivElement>(null);

  // Focus after the enter animation has a frame to start.
  useEffect(() => {
    if (open && !capturing) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open, capturing]);

  // Window-level so Esc still closes if focus escaped the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        a.closePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, a]);

  if (!open) return null;

  const canSubmit = message.trim().length > 0 && !submitting;
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  /** Roving focus across the category pills, so the group is one Tab stop. */
  const onRadioKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = CATEGORIES.findIndex((c) => c.id === category);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % CATEGORIES.length
        : (i - 1 + CATEGORIES.length) % CATEGORIES.length;
    a.setCategory(CATEGORIES[next].id);
    requestAnimationFrame(() => {
      radioRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
    });
  };

  return (
    <div
      role="dialog"
      aria-label="Send feedback"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
          e.preventDefault();
          void a.submit();
        }
      }}
      className={cn(
        // `rounded-xl` matches the create-organisation modal — the house radius
        // for a panel this size. `rounded-2xl` read as a pill at 380px wide.
        "fixed right-3 w-[380px] rounded-xl overflow-hidden select-none",
        // Border, translucent fill and blur all on THIS element — which is also
        // the one the enter animation transforms. Splitting them would isolate
        // the layer and flatten the blur.
        "border border-white/10 bg-[var(--bg-elevated)]/85 backdrop-blur-2xl",
        "atlas-panel-in-br",
        // Still laid out (and animated in) while `screencapture` is on screen,
        // just invisible, so the panel never lands in the user's own shot.
        capturing && "invisible",
      )}
      style={{
        zIndex: "var(--z-max)" as unknown as number,
        bottom: barVisible ? BAR_OFFSET : EDGE_OFFSET,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
        // No `will-change` — it would isolate the layer and kill the blur.
      }}
    >
      <div className="flex items-center gap-2 px-3.5 h-9 border-b border-white/5">
        <MessageCircleQuestion size={13} strokeWidth={1.5} className="text-text-secondary" />
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
          Send feedback
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={a.closePanel}
          aria-label="Close feedback"
          className="grid h-5 w-5 place-items-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <X size={12} />
        </button>
      </div>

      {sent ? (
        <div role="status" className="flex flex-col items-center gap-2 px-6 py-7">
          <div className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.04]">
            <Check size={16} strokeWidth={1.75} className="text-[var(--status-success)]" />
          </div>
          <p className="text-[12px] text-text-primary">Thanks — we got it.</p>
          <button
            type="button"
            onClick={a.dismissSent}
            className="mt-1 h-6 rounded-full px-3 text-[11px] text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            Send another
          </button>
        </div>
      ) : (
        <>
          <div
            ref={radioRef}
            role="radiogroup"
            aria-label="Feedback category"
            onKeyDown={onRadioKey}
            className="flex flex-wrap gap-1 px-3.5 pt-3"
          >
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={category === c.id}
                tabIndex={category === c.id ? 0 : -1}
                onClick={() => a.setCategory(c.id)}
                className={cn(
                  "h-6 rounded-full px-2.5 text-[11px] border transition-colors cursor-pointer",
                  category === c.id
                    ? "border-white/15 bg-white/[0.10] text-text-primary"
                    : "border-white/[0.06] bg-white/[0.02] text-text-tertiary hover:text-text-secondary hover:bg-white/[0.05]",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => a.setMessage(e.target.value)}
            rows={5}
            maxLength={4000}
            aria-label="Your feedback"
            placeholder={active.placeholder}
            className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[12px] leading-relaxed text-text-primary placeholder:text-text-ghost outline-none select-text"
          />

          <div className="flex items-center gap-2 px-3.5 pb-2.5">
            {shot ? (
              <div className="group relative h-11 w-[72px] shrink-0 overflow-hidden rounded-md border border-white/10">
                <img
                  src={`data:${shot.mimeType};base64,${shot.dataBase64}`}
                  alt="Attached screenshot"
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={a.removeScreenshot}
                  aria-label="Remove screenshot"
                  className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white/80 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                >
                  <X size={9} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void a.attachScreenshot()}
                title="Drag a region — or press Space, then click the Atlas window."
                className="inline-flex h-6 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 text-[11px] text-text-tertiary hover:bg-white/[0.06] hover:text-text-primary transition-colors cursor-pointer"
              >
                <Camera size={11} strokeWidth={1.75} />
                Attach screenshot
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="px-3.5 pb-2 text-[10px] text-[var(--status-error)]">
              {error}
            </p>
          )}

          {!settings.shareTelemetry && (
            // Say it plainly rather than in a tooltip: this is the one path that
            // transmits with usage data switched off, and the user pressed a
            // button labelled "Send".
            <p className="px-3.5 pb-2 text-[10px] leading-snug text-text-ghost">
              Usage data is off. This feedback is still sent, because you asked for it to be.
            </p>
          )}

          <div className="flex items-center gap-2 px-3.5 py-2 border-t border-white/5">
            {signedIn && user ? (
              <button
                type="button"
                onClick={() => a.setAnonymous(!anonymous)}
                title={
                  anonymous ? "Send with your Atlas account instead" : "Send anonymously instead"
                }
                className="inline-flex min-w-0 items-center gap-1.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
              >
                {/* The face is the point: at a glance you can tell whether this
                    report will be attributable to you. Anonymous swaps it for a
                    shield rather than dropping the slot, so the row doesn't
                    reflow as you toggle. */}
                {anonymous ? (
                  <EyeOff size={11} strokeWidth={1.75} className="shrink-0" />
                ) : (
                  <AccountAvatar user={user} size={13} />
                )}
                <span className="truncate">
                  {anonymous ? "Sending anonymously" : `Sending as ${displayName}`}
                </span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[10px] text-text-ghost">
                <EyeOff size={11} strokeWidth={1.75} className="shrink-0" />
                Sending anonymously
              </span>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => void a.submit()}
              disabled={!canSubmit}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors",
                canSubmit
                  ? "bg-[var(--accent-primary)] text-[var(--primary-foreground)] hover:opacity-90 cursor-pointer"
                  : "bg-white/[0.06] text-text-ghost cursor-not-allowed",
              )}
            >
              {submitting ? "Sending…" : "Send"}
            </button>
          </div>
        </>
      )}

      <div className="flex items-center gap-3 px-3.5 h-8 border-t border-white/5 bg-black/20">
        <button
          type="button"
          onClick={() => void openExternal(issueUrl(category, message))}
          className="inline-flex items-center gap-1.5 text-[10px] text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
        >
          <Github size={10} />
          Open a GitHub issue
        </button>
        <div className="w-px h-3 bg-white/10" aria-hidden />
        <button
          type="button"
          onClick={() => void openExternal(DISCORD_URL)}
          className="inline-flex items-center gap-1.5 text-[10px] text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
        >
          <MessagesSquare size={10} />
          Join the community
        </button>
      </div>
    </div>
  );
}
