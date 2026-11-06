// The lists the gallery walks. Dev-only: this module is reachable only from
// the design-system mock scenario, which `vite.config.ts` injects when serving.

/** The shadcn base tokens, in the order the package's `themes.css` declares them. A theme
 *  must supply every one of these, so this list is also the checklist a theme
 *  author reads. */
export const BASE_COLOR_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
] as const;

export const LAYOUT_CONSTANTS = [
  { name: "titlebar", cssVar: "--titlebar-height", utility: "h-titlebar" },
] as const;
