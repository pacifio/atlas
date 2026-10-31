/**
 * The Settings sidebar and its search index.
 *
 * Two kinds of section share the sidebar:
 *
 * - **Pages** backed by `config.toml`. Their rows, titles and search entries
 *   come from the settings registry (`settings-registry.gen.ts`), so a key
 *   added to `src-tauri/settings-registry.toml` is findable the moment it has
 *   a row.
 * - **Pages** that manage something else: themes, icon themes, skills, API
 *   keybindings, agents. They are drawn with the same
 *   layout, but their rows are not registry keys, so `EXTRA_SEARCH_ITEMS`
 *   names what can be found on them.
 */

import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Brain,
  DownloadCloud,
  GitBranch,
  GitPullRequest,
  Info,
  Keyboard,
  LayoutTemplate,
  MessageSquare,
  Palette,
  Settings,
  ShieldCheck,
  WandSparkles,
  Zap,
} from "lucide-react";
import {
  DEFAULT_SETTINGS,
  SETTINGS_PAGES,
  SETTINGS_REGISTRY,
  type SettingKey,
  type SettingMeta,
  type SettingsPageId,
} from "./app-settings";
import type { SettingsSection } from "../stores/settings-nav-store";

export interface SidebarEntry {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}

export interface SidebarGroup {
  label: string;
  entries: readonly SidebarEntry[];
}

/** Every registry page is a section the sidebar can show; a page added to the
 *  registry without a section fails here, not at runtime. */
type PagesAreSections = SettingsPageId extends SettingsSection ? true : never;
const PAGES_ARE_SECTIONS: PagesAreSections = true;
void PAGES_ARE_SECTIONS;

const pageTitle = (id: SettingsPageId) => SETTINGS_PAGES.find((page) => page.id === id)!.title;

export const SIDEBAR: readonly SidebarGroup[] = [
  {
    label: "Preferences",
    entries: [
      { id: "general", label: pageTitle("general"), icon: Settings },
      { id: "appearance", label: pageTitle("appearance"), icon: Palette },
      { id: "chat", label: pageTitle("chat"), icon: MessageSquare },
      { id: "memory", label: pageTitle("memory"), icon: Brain },
      { id: "notifications", label: pageTitle("notifications"), icon: Bell },
      { id: "source-control", label: pageTitle("source-control"), icon: GitBranch },
      { id: "pull-requests", label: pageTitle("pull-requests"), icon: GitPullRequest },
      { id: "keybindings", label: "Keybindings", icon: Keyboard },
      { id: "privacy", label: pageTitle("privacy"), icon: ShieldCheck },
      { id: "updates", label: pageTitle("updates"), icon: DownloadCloud },
      { id: "about", label: "About", icon: Info },
    ],
  },
  {
    label: "Library",
    entries: [
      { id: "agents", label: pageTitle("agents"), icon: WandSparkles },
      { id: "skills", label: "Skills", icon: Zap },
      { id: "layouts", label: "Layouts", icon: LayoutTemplate },
    ],
  },
];

const ALL_ENTRIES = SIDEBAR.flatMap((group) => group.entries);

/** A section's sidebar entry — its label and its icon, for the breadcrumb. */
export function sectionEntry(id: SettingsSection): SidebarEntry | undefined {
  return ALL_ENTRIES.find((entry) => entry.id === id);
}

export function sectionLabel(id: SettingsSection): string {
  return sectionEntry(id)?.label ?? id;
}

export function sectionDescription(id: SettingsSection): string | undefined {
  return SETTINGS_PAGES.find((page) => page.id === id)?.description;
}

const META_BY_KEY = new Map(SETTINGS_REGISTRY.map((meta) => [meta.key, meta]));

export function settingMeta(key: SettingKey): SettingMeta {
  const meta = META_BY_KEY.get(key);
  if (!meta) throw new Error(`no registry entry for ${key}`);
  return meta;
}

/** Structural equality — enough for the scalars, string lists and the
 *  theme-override table a setting can hold. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

export function isDefaultValue(key: SettingKey, value: unknown): boolean {
  return same(value, DEFAULT_SETTINGS[key]);
}

/** Live settings on `page` whose value differs from the default. */
export function changedOnPage(
  page: SettingsSection,
  settings: Record<SettingKey, unknown>,
): SettingMeta[] {
  return SETTINGS_REGISTRY.filter(
    (meta) =>
      meta.page === page && meta.status === "live" && !isDefaultValue(meta.key, settings[meta.key]),
  );
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchItem {
  id: string;
  title: string;
  /** Where it lives, shown under the title: "General › Interface". */
  where: string;
  section: SettingsSection;
  /** The row to scroll to, if the item is a single row. */
  anchor?: string;
  /** Extra words that should find it. */
  terms?: string;
}

/** Things worth finding that are not a `config.toml` key. */
const EXTRA_SEARCH_ITEMS: readonly SearchItem[] = [
  {
    id: "config-file",
    title: "Settings file",
    where: "Privacy › Settings file",
    section: "privacy",
    anchor: "config-file",
    terms: "config.toml open edit unknown keys reset recreate defaults",
  },
  {
    id: "send-feedback",
    title: "Send feedback",
    where: "General › Help",
    section: "general",
    anchor: "send-feedback",
    terms: "bug report feature request",
  },
  {
    id: "model-pricing",
    title: "Model pricing",
    where: "Agents › All agents",
    section: "agents",
    anchor: "model-pricing",
    terms: "models.dev price cost tokens",
  },
  {
    id: "check-updates",
    title: "Check for updates",
    where: "Updates › Atlas",
    section: "updates",
    anchor: "check-updates",
    terms: "version upgrade restart",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    where: "Keybindings",
    section: "keybindings",
    terms: "shortcuts keys hotkeys keymap vscode zed jetbrains cursor presets",
  },
  {
    id: "theme-import",
    title: "Import a theme",
    where: "Appearance › Themes",
    section: "appearance",
    anchor: "themeLight",
    terms: "colour color vscode zed shadcn convert export",
  },
  {
    id: "icon-theme-install",
    title: "Install a file icon theme",
    where: "Appearance › File icons",
    section: "appearance",
    anchor: "iconTheme",
    terms: "open vsx material icons",
  },
  {
    id: "agents",
    title: "Install agents",
    where: "Agents",
    section: "agents",
    terms: "acp registry claude code gemini install update",
  },
  {
    id: "skills",
    title: "Skills and packs",
    where: "Skills",
    section: "skills",
    terms: "slash commands",
  },
  {
    id: "api-keys",
    title: "API keys",
    where: "Agents › Provider keys",
    section: "agents",
    anchor: "provider-keys",
    terms: "byok openai anthropic provider environment shell profile",
  },
  {
    id: "local-models",
    title: "Local models",
    where: "Memory › Embedding model",
    section: "memory",
    anchor: "embedding-model",
    terms: "embedding on-device download",
  },
  {
    id: "layouts",
    title: "Layouts",
    where: "Layouts",
    section: "layouts",
    terms: "tab bar panels focus develop research",
  },
];

/** Every searchable item: each live or elsewhere-set registry key, plus the
 *  extras above. */
export function searchItems(): SearchItem[] {
  const fromRegistry = SETTINGS_REGISTRY.filter(
    (meta) => meta.status === "live" || meta.status === "elsewhere",
  ).map((meta): SearchItem => ({
    id: meta.key,
    title: meta.title,
    where: `${sectionLabel(meta.page)} › ${meta.section}`,
    section: meta.page,
    anchor: meta.status === "live" ? meta.key : undefined,
    terms: `${meta.key} ${meta.summary}`,
  }));
  return [...fromRegistry, ...EXTRA_SEARCH_ITEMS];
}

/**
 * Rank: exact title, title prefix, title word prefix, then every query word
 * anywhere in title, place or terms. Unmatched items drop out.
 */
export function searchSettings(query: string, items = searchItems()): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const scored: [SearchItem, number][] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const haystack = `${title} ${item.where.toLowerCase()} ${(item.terms ?? "").toLowerCase()}`;
    let score = 0;
    if (title === q) score = 4;
    else if (title.startsWith(q)) score = 3;
    else if (title.split(/\s+/).some((word) => word.startsWith(q))) score = 2;
    else if (words.every((word) => haystack.includes(word))) score = 1;
    if (score > 0) scored.push([item, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([item]) => item);
}
