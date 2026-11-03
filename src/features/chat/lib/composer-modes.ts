// Display helpers for the composer's permission-mode and agent/model picker.

import type { ClaudePermissionMode } from "@/types/agent";

/**
 * Per-mode dot color for the generic ACP permission picker, mirroring Claude's
 * semantic scale: restrictive = blue, auto-edit = green, unrestricted = red.
 * Keyed off the agent-advertised mode id (Codex: read-only / auto / full-access)
 * with broad fallbacks so other agents' modes still get a sensible tint.
 */
export function acpModeColor(modeId: string | undefined): string {
  const id = (modeId ?? "").toLowerCase();
  if (/full|bypass|\ball\b|danger|yolo|unrestricted/.test(id))
    return "var(--atlas-status-error-foreground)";
  if (/read.?only|\bplan\b|ask|suggest/.test(id)) return "var(--primary)";
  if (/auto|default|edit|accept|agent|project/.test(id))
    return "var(--atlas-status-success-foreground)";
  return "var(--muted-foreground)";
}

/**
 * Composer permission-mode picker for non-Claude ACP agents (Codex). Unlike
 * Claude's fixed 4-mode cycling pill, the modes here are agent-advertised
 * (id + name + description), so this renders a dropup popover listing them.
 * Self-contained: own narrow store selectors + click-outside, so it doesn't
 * widen MessageInput's render surface.
 */
/** Mode names arrive verbatim from the agent — OpenCode sends lowercase ids as
 *  names ("build", "plan"). Title-case a single all-lowercase word for display;
 *  multi-word or already-cased names (Claude's "Accept Edits") pass through. */
export function displayModeName(name: string): string {
  return /^[a-z][a-z0-9-]*$/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export type ComposerGroup = "model" | "mode";
export const GROUP_ORDER: ComposerGroup[] = ["model", "mode"];

/** Colour class for the Claude permission-mode dot (mirrors the old pill). */
export function claudeModeDotClass(mode: ClaudePermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "bg-[var(--atlas-status-success-foreground)]";
    case "plan":
      return "bg-[var(--primary)]";
    case "bypassPermissions":
      return "bg-[var(--atlas-status-error-foreground)]";
    case "auto":
      return "bg-[var(--atlas-status-warning-foreground)]";
    default:
      return "bg-[var(--muted-foreground)]";
  }
}
