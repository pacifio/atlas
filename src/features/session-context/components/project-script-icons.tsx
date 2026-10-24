// The glyphs a project script can carry, and their names for the picker.

import { Bug, FlaskConical, Hammer, ListChecks, Play, Wrench, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ProjectScriptIcon } from "../lib/session-context-api";

export const PROJECT_SCRIPT_ICONS: readonly {
  value: ProjectScriptIcon;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "play", label: "Run", icon: Play },
  { value: "test", label: "Test", icon: FlaskConical },
  { value: "lint", label: "Lint", icon: ListChecks },
  { value: "configure", label: "Configure", icon: Wrench },
  { value: "build", label: "Build", icon: Hammer },
  { value: "debug", label: "Debug", icon: Bug },
];

export function projectScriptIcon(icon: ProjectScriptIcon): LucideIcon {
  return PROJECT_SCRIPT_ICONS.find((entry) => entry.value === icon)?.icon ?? Play;
}

export function ProjectScriptGlyph({
  icon,
  muted = false,
}: {
  icon: ProjectScriptIcon;
  /** Muted beside a row label; a menu item colours its own glyphs. */
  muted?: boolean;
}) {
  const Icon = projectScriptIcon(icon);
  return (
    <Icon size={14} aria-hidden className={cn("shrink-0", muted && "text-muted-foreground")} />
  );
}
