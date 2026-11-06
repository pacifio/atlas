import {
  FileDiff,
  GitBranch,
  Info,
  Layers,
  ListTodo,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/**
 * What each kind of memory looks like, by its wire spelling
 * (`EntryKind::as_str`).
 *
 * An icon rather than the kind's name: the names are the column's own data and
 * they are not the same length, so a fixed-width label column either clipped
 * `ARCHITECTURE` or left a gap after `FACT` — and the version before this gave
 * it `w-16`, which the long ones overran straight into the content beside them.
 * An icon is one width by construction. The name stays reachable as the row's
 * tooltip, which is where a reader who does not know the glyph will look.
 */
export const KIND_ICON: Record<string, LucideIcon> = {
  fact: Info,
  decision: GitBranch,
  failure: TriangleAlert,
  architecture: Layers,
  preference: SlidersHorizontal,
  plan: ListTodo,
  plan_set: ListTodo,
  file_changed: FileDiff,
};

/** The kind's own word, for the tooltip the icon stands in for. */
export function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}
