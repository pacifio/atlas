// The lists the gallery walks. Dev-only: this module is reachable only from
// the design-system mock scenario, which `vite.config.ts` injects when serving.

/** The shadcn base tokens, in the order `tokens.css` declares them. A theme
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

export const TYPE_SCALE = [
  { name: "3xs", utility: "text-3xs", px: 9 },
  { name: "2xs", utility: "text-2xs", px: 10 },
  { name: "xs", utility: "text-xs", px: 11 },
  { name: "sm", utility: "text-sm", px: 12 },
  { name: "base", utility: "text-base", px: 13 },
  { name: "md", utility: "text-md", px: 14 },
  { name: "lg", utility: "text-lg", px: 16 },
  { name: "xl", utility: "text-xl", px: 20 },
  { name: "2xl", utility: "text-2xl", px: 24 },
] as const;

export const TEXT_STYLES = [
  { utility: "eyebrow", use: "Section header above a group of rows." },
  { utility: "label", use: "The text on and beside a control." },
  { utility: "body", use: "Running prose — a description, a message." },
  { utility: "caption", use: "The dimmed second line under something." },
  { utility: "code", use: "Any monospace run: a path, a hash, a command." },
  { utility: "heading", use: "A panel or dialog title." },
] as const;

export const CONTROL_HEIGHTS = [
  { name: "xs", cssVar: "--control-xs", utility: "h-control-xs", use: "Inline chip, keycap." },
  { name: "sm", cssVar: "--control-sm", utility: "h-control-sm", use: "Dense toolbar control." },
  { name: "md", cssVar: "--control-md", utility: "h-control-md", use: "The default control." },
  { name: "lg", cssVar: "--control-lg", utility: "h-control-lg", use: "Primary action, search." },
] as const;

export const LAYOUT_CONSTANTS = [
  { name: "titlebar", cssVar: "--titlebar-height", utility: "h-titlebar" },
] as const;

export const RADII = [
  { name: "rounded", cssVar: "--radius-sm", use: "Bare `rounded` is an alias of sm." },
  { name: "rounded-sm", cssVar: "--radius-sm", use: "Controls: buttons, inputs, keycaps." },
  { name: "rounded-md", cssVar: "--radius-md", use: "Cards and rows." },
  { name: "rounded-lg", cssVar: "--radius-lg", use: "Popovers and menus." },
  { name: "rounded-xl", cssVar: "--radius-xl", use: "Dialogs." },
  { name: "rounded-full", cssVar: "--radius-full", use: "Pills and avatars." },
] as const;

export const ELEVATIONS = [
  { utility: "shadow-sm", cssVar: "--elevation-raised", use: "Raised off the surface." },
  { utility: "shadow-md", cssVar: "--elevation-menu", use: "Menus and popovers." },
  { utility: "shadow-lg", cssVar: "--elevation-dialog", use: "Dialogs." },
] as const;

export const Z_LAYERS = [
  { name: "panel", cssVar: "--z-panel", utility: "z-panel" },
  { name: "titlebar", cssVar: "--z-titlebar", utility: "z-titlebar" },
  { name: "drawer", cssVar: "--z-drawer", utility: "z-drawer" },
  { name: "overlay", cssVar: "--z-overlay", utility: "z-overlay" },
  { name: "modal", cssVar: "--z-modal", utility: "z-modal" },
  { name: "popover", cssVar: "--z-popover", utility: "z-popover" },
  { name: "toast", cssVar: "--z-toast", utility: "z-toast" },
  { name: "tooltip", cssVar: "--z-tooltip", utility: "z-tooltip" },
  { name: "drag", cssVar: "--z-drag", utility: "z-drag" },
] as const;

export const DURATIONS = [
  { name: "instant", cssVar: "--duration-instant", utility: "duration-instant" },
  { name: "fast", cssVar: "--duration-fast", utility: "duration-fast" },
  { name: "base", cssVar: "--duration-base", utility: "duration-base" },
  { name: "slow", cssVar: "--duration-slow", utility: "duration-slow" },
] as const;

export const EASINGS = [
  { name: "ease-out-strong", cssVar: "--ease-out-strong", use: "Entrances; the default." },
  { name: "ease-in-out-strong", cssVar: "--ease-in-out-strong", use: "Two-way state changes." },
  { name: "ease-drawer", cssVar: "--ease-drawer", use: "Panels and drawers sliding in." },
] as const;
