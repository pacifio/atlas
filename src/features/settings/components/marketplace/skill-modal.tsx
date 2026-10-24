// The dialog a skill or pack opens in, from Installed (deliver to tools,
// update, uninstall) and from Discover (install). One column, like a settings
// page: what it does, then where it goes, then the actions in the footer.

import type { ReactNode } from "react";
import { Switch } from "@/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import type { ProjectionStatus, ToolInfo } from "@/features/skills/lib/types";
import { SettingsGroup, SettingsRow, SettingsSection } from "../layout/settings-layout";

export interface ModalSkill {
  name: string;
  description?: string | null;
}

export function SkillDialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[min(44rem,calc(100vh-4rem))] max-w-[min(44rem,calc(100vw-2rem))] gap-5">
        <DialogHeader className="mr-8">
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>
        <div className="-mx-4 flex min-h-0 flex-col gap-5 overflow-y-auto px-4">{children}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A single skill's description, or a pack's skills with theirs. */
export function SkillDescriptions({
  skills,
  fallback = "No description published.",
}: {
  skills: ModalSkill[];
  fallback?: ReactNode;
}) {
  if (skills.length === 1 && skills[0]!.description) {
    return <p className="text-sm text-secondary-foreground">{skills[0]!.description}</p>;
  }
  if (skills.length <= 1) return <p className="caption">{fallback}</p>;
  return (
    <SettingsSection title={`${skills.length} skills`}>
      <SettingsGroup>
        {skills.map((s) => (
          <SettingsRow key={s.name} title={s.name} description={s.description ?? undefined} />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}

/** One switch per agent tool the skill can be delivered to. */
export function DeliverTo({
  tools,
  detectedFor,
  statusFor,
  busyFor,
  onToggle,
}: {
  tools: ToolInfo[];
  detectedFor: (t: ToolInfo) => boolean;
  statusFor: (t: ToolInfo) => ProjectionStatus;
  busyFor: (t: ToolInfo) => boolean;
  onToggle: (t: ToolInfo, status: ProjectionStatus) => void;
}) {
  return (
    <SettingsSection
      title="Deliver to"
      description="Puts a copy where each agent tool looks for skills."
    >
      <SettingsGroup>
        {tools.map((t) => {
          const status = statusFor(t);
          const detected = detectedFor(t);
          const fixed = status === "pack" || status === "conflict" || status === "external";
          return (
            <SettingsRow
              key={t.id}
              title={t.displayName}
              description={
                !detected
                  ? "Not installed here."
                  : status === "pack"
                    ? "Delivered by its pack."
                    : status === "external"
                      ? "Installed there outside Atlas."
                      : status === "conflict"
                        ? "A different skill with this name is already there."
                        : status === "drifted"
                          ? "The copy there has changed. Turning it on again replaces it."
                          : undefined
              }
              disabled={!detected}
              control={
                <Switch
                  checked={status === "synced" || status === "pack" || status === "external"}
                  disabled={!detected || busyFor(t) || fixed}
                  aria-label={`Deliver to ${t.displayName}`}
                  onCheckedChange={() => onToggle(t, status)}
                />
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
