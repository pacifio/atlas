import { useEffect, useRef } from "react";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useFeedbackStore } from "../stores/feedback-store";
import { CATEGORIES, type FeedbackCategory } from "../lib/feedback-api";
import { DISCORD_URL, issueUrl, openExternal } from "../lib/feedback-links";
import { FeedbackPanelView } from "./views/feedback-panel-view";

/** The feedback panel's wiring; `FeedbackPanelView` says how it looks and why. */
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
  const settings = useSettingsStore.use.settings();

  const user = snapshot.status === "signed-in" ? snapshot.user : null;

  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <FeedbackPanelView
      categories={CATEGORIES}
      capturing={capturing}
      category={category}
      message={message}
      shot={shot}
      anonymous={anonymous}
      submitting={submitting}
      sent={sent}
      error={error}
      identity={
        user
          ? {
              avatar: <AccountAvatar user={user} size={13} />,
              name: user.name || user.email || "your Atlas account",
            }
          : null
      }
      telemetryOff={!settings.shareTelemetry}
      textareaRef={textareaRef}
      onClose={a.closePanel}
      onCategory={(id) => a.setCategory(id as FeedbackCategory)}
      onMessage={a.setMessage}
      onAttach={() => void a.attachScreenshot()}
      onRemoveShot={a.removeScreenshot}
      onToggleAnonymous={() => a.setAnonymous(!anonymous)}
      onSubmit={() => void a.submit()}
      onSendAnother={a.dismissSent}
      onOpenIssue={() => void openExternal(issueUrl(category, message))}
      onOpenCommunity={() => void openExternal(DISCORD_URL)}
    />
  );
}
