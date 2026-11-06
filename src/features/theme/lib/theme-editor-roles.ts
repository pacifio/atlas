import { BASE_RULE_REGISTRY, PALETTE_KEYS, THEME_KEY_REGISTRY } from "@tryatlas/design/theme";

/**
 * What the theme editor offers, grouped
 * by what a colour is FOR, in plain names, rather than in token order.
 *
 * Every entry is a real slot in the theme file — a base token, a palette hue
 * or a theme key — so the editor writes exactly what an author would write by
 * hand. Base tokens that are not colours (radius, spacing, shadows) are not
 * here; they belong in the TOML.
 */

export type EditorTable = "base" | "palette" | "keys";

export interface EditorRole {
  table: EditorTable;
  name: string;
  label: string;
  /** Hover text: what the slot colours. */
  description: string;
}

export interface EditorRoleGroup {
  id: string;
  title: string;
  roles: readonly EditorRole[];
}

const describeBase = (token: string) =>
  BASE_RULE_REGISTRY.find((rule) => rule.token === token)?.description ?? "";

const base = (name: string, label: string): EditorRole => ({
  table: "base",
  name,
  label,
  description: describeBase(name),
});

/** The simple view: two colors, rest derived. `foreground` is the
 *  third seed and follows `background` until set, so it waits in Advanced. */
export const SIMPLE_ROLES: readonly EditorRole[] = [
  base("background", "Background"),
  base("primary", "Accent"),
];

/** The three base tokens everything else derives from (ADR-0022). */
export const SEED_TOKENS = ["background", "foreground", "primary"] as const;

const PALETTE_LABELS: Record<string, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  cyan: "Cyan",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

const sentenceCase = (key: string) => {
  const words = key.replace(/^syntax\./, "").replaceAll("_", " ");
  return words[0].toUpperCase() + words.slice(1);
};

export const ROLE_GROUPS: readonly EditorRoleGroup[] = [
  {
    id: "foundation",
    title: "Foundation",
    roles: [
      base("background", "Background"),
      base("foreground", "Text"),
      base("primary", "Accent"),
      base("muted-foreground", "Muted text"),
      base("border", "Border"),
      base("input", "Input border"),
    ],
  },
  {
    id: "surfaces",
    title: "Surfaces",
    roles: [
      base("card", "Raised surface"),
      base("popover", "Menus and popovers"),
      base("secondary", "Secondary fill"),
      base("muted", "Quiet fill"),
      base("accent", "Hover and selection"),
    ],
  },
  {
    id: "text-on-fills",
    title: "Text on fills",
    roles: [
      base("primary-foreground", "Text on accent"),
      base("secondary-foreground", "Secondary text"),
      base("card-foreground", "Text on raised surface"),
      base("popover-foreground", "Text in menus"),
      base("accent-foreground", "Text on hover"),
      base("ring", "Focus ring"),
    ],
  },
  {
    id: "sidebar",
    title: "Sidebar",
    roles: [
      base("sidebar", "Sidebar background"),
      base("sidebar-foreground", "Sidebar text"),
      base("sidebar-accent", "Sidebar hover"),
      base("sidebar-accent-foreground", "Sidebar hover text"),
      base("sidebar-primary", "Sidebar accent"),
      base("sidebar-primary-foreground", "Text on sidebar accent"),
      base("sidebar-border", "Sidebar border"),
      base("sidebar-ring", "Sidebar focus ring"),
    ],
  },
  {
    id: "status",
    title: "Status and charts",
    roles: [
      base("destructive", "Destructive"),
      base("destructive-foreground", "Text on destructive"),
      ...[1, 2, 3, 4, 5].map((n) => base(`chart-${n}`, `Chart ${n}`)),
    ],
  },
  {
    id: "palette",
    title: "Palette",
    roles: PALETTE_KEYS.map((hue) => ({
      table: "palette" as const,
      name: hue,
      label: PALETTE_LABELS[hue],
      description: `The theme's ${hue}: terminal, status and diff colours follow it.`,
    })),
  },
  {
    id: "syntax",
    title: "Syntax",
    roles: THEME_KEY_REGISTRY.filter((definition) => definition.key.startsWith("syntax.")).map(
      (definition) => ({
        table: "keys" as const,
        name: definition.key,
        label: sentenceCase(definition.key),
        description: definition.rule.description,
      }),
    ),
  },
];
