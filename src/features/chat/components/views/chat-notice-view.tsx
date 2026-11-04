import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { Button, Callout, Hint, Icon, IconButton, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { COMPOSER_STRIP } from "../composer-strip";

export type ChatNoticeTone = "neutral" | "info" | "success" | "warning" | "error";

export interface ChatNoticeAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  title?: string;
  disabled?: boolean;
  /** In flight: the button is disabled and a spinner stands before the label. */
  busy?: boolean;
}

const GLYPH_TONE: Record<ChatNoticeTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
};

/**
 * The status notices of a session's composer, in its two constructions.
 *
 * `above` is the card that floats over the composer (agent update, agent
 * exited, retry countdown): a neutral card in the content column, its message
 * selectable, one filled action. The tone colours only the glyph — the card
 * itself stays the surface it always was.
 *
 * `tucked` is the strip tucked into the top of the composer, for every notice
 * that explains the composer's state (agent removed, mode not restored, a
 * branch change, live in a terminal), so they read as part of the composer
 * rather than as a stray banner floating above it. Its geometry is
 * `COMPOSER_STRIP` (that file says why it overlaps the composer). It is not a
 * `Callout`: the package callout owns its shape, padding and fill, and has no
 * strip variant yet, so the strip stays desktop markup on theme tokens until
 * the package grows one. Its actions are quiet text buttons, and `onDismiss`
 * adds the ✕ every strip carries at the far right.
 *
 * `live` makes the notice a status region. Off by default: the retry pill
 * re-renders its countdown every second, and as a status region a screen
 * reader would read it every second.
 */
export function ChatNoticeView({
  placement,
  tone = "neutral",
  icon,
  busy,
  children,
  action,
  extraActions,
  onDismiss,
  dismissLabel = "Hide",
  title,
  live = false,
  "data-testid": testId,
}: {
  placement: "above" | "tucked";
  tone?: ChatNoticeTone;
  icon?: LucideIcon;
  /** A spinner in place of the icon. */
  busy?: boolean;
  children: ReactNode;
  action?: ChatNoticeAction;
  extraActions?: ChatNoticeAction[];
  onDismiss?: () => void;
  dismissLabel?: string;
  title?: string;
  live?: boolean;
  "data-testid"?: string;
}) {
  const tucked = placement === "tucked";
  const glyph = busy ? (
    <Spinner size="sm" label="" />
  ) : icon ? (
    <Icon icon={icon} size="sm" className={cn("shrink-0", GLYPH_TONE[tone])} />
  ) : null;
  const actions = [action, ...(extraActions ?? [])].filter((a): a is ChatNoticeAction => !!a);

  const trailing =
    actions.length > 0 || onDismiss ? (
      <span className="flex shrink-0 items-center gap-0.5">
        {actions.map((a) => (
          <Button
            key={a.label}
            variant={tucked ? "ghost" : "default"}
            size={tucked ? "xs" : "sm"}
            title={a.title}
            disabled={a.disabled || a.busy}
            onClick={a.onClick}
          >
            {a.busy ? <Spinner size="xs" label="" /> : a.icon && <Icon icon={a.icon} size="xs" />}
            {a.label}
          </Button>
        ))}
        {onDismiss && (
          <Hint label={dismissLabel} side="top">
            <IconButton
              variant="ghost"
              size="xs"
              icon={X}
              label={dismissLabel}
              onClick={onDismiss}
            />
          </Hint>
        )}
      </span>
    ) : undefined;

  const message = (
    <span className="flex min-w-0 items-center gap-1.5">
      {glyph}
      {tucked ? (
        <span className="min-w-0 truncate text-muted-foreground">{children}</span>
      ) : (
        <span className="min-w-0 select-text">{children}</span>
      )}
    </span>
  );

  if (tucked) {
    return (
      <div
        role={live ? "status" : undefined}
        title={title}
        data-testid={testId}
        data-placement="tucked"
        className={COMPOSER_STRIP}
      >
        {message}
        {trailing}
      </div>
    );
  }

  return (
    <Callout
      tone="neutral"
      icon={false}
      role={live ? "status" : undefined}
      title={title}
      data-testid={testId}
      data-placement="above"
      action={trailing}
      className="mb-2 items-center"
    >
      {message}
    </Callout>
  );
}
