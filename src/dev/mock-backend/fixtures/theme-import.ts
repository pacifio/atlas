// Theme import and export (Settings → Appearance → Import).
//
// The panel's whole job is showing what a conversion did, so the fakes have to
// cover the three answers that look different on screen:
//
//   1. a **native** shadcn import — nothing lost, one theme, two variants;
//   2. a **lossy** VS Code import — warnings, a big ignored count, categories;
//   3. a **failure** — bad JSON or an unknown schema, which must read as a
//      sentence rather than an empty panel.
//
// Plus the near-lossless middle case: a Zed family, which is the only source
// that produces more than one theme from one paste.
//
// Which one you get is decided the way Rust decides it, by sniffing the input,
// so pasting a real Zed theme into `bun run dev` behaves like the real thing.
// The `Theme` objects are the real converted output: `imported-themes.json` is
// generated from the committed fixtures by `cargo test -p atlas-theme`, so a
// mapping change in Rust cannot leave this fixture describing a theme the
// importer no longer produces.

import type { Theme } from "@/features/theme/lib/theme-api";
import {
  themeIdSlug,
  type CommittedThemeImport,
  type ShadcnExport,
  type ThemeImportCandidate,
  type ThemeImportPreview,
  type ThemeImportReport,
} from "@/features/theme/lib/theme-import-api";
import type { TypedHandlers } from "../types";
import importedThemesJson from "./imported-themes.json";
import builtinThemesJson from "./builtin-themes.json";

/** `[tweakcn Catppuccin, Rosé Pine, Rosé Pine Dawn, Nocturne Bright]`. */
const imported = importedThemesJson as Theme[];
const builtins = builtinThemesJson as Theme[];

const byId = (id: string): Theme => {
  const theme = imported.find((candidate) => candidate.id === id);
  if (!theme) throw new Error(`mock: no imported fixture for "${id}"`);
  return theme;
};

/** An ignored row that stands for `weight` real ones, exactly as Rust's do. */
interface WeightedIgnored {
  source: string;
  category: string;
  reason: string;
  weight: number;
}

/** What a fixture states; the counts and the category tally are computed. */
interface DraftReport {
  format: string;
  sourceName: string;
  fidelity: ThemeImportReport["fidelity"];
  variants: string[];
  summary?: string[];
  warnings?: string[];
  mapped?: ThemeImportReport["mapped"];
  derived?: ThemeImportReport["derived"];
  ignored?: WeightedIgnored[];
  /** Overrides for `mapped` and `derived` only: a few sample rows stand in for
   *  the hundred the real importer returns, so the counts are stated. */
  counts?: { mapped: number; derived: number };
}

function buildReport(draft: DraftReport): ThemeImportReport {
  const mapped = draft.mapped ?? [];
  const derived = draft.derived ?? [];
  const weighted = draft.ignored ?? [];
  const ignoredByCategory: Record<string, number> = {};
  for (const entry of weighted) {
    ignoredByCategory[entry.category] = (ignoredByCategory[entry.category] ?? 0) + entry.weight;
  }
  return {
    format: draft.format,
    sourceName: draft.sourceName,
    variants: draft.variants,
    fidelity: draft.fidelity,
    summary: draft.summary ?? [],
    mapped,
    derived,
    ignored: weighted.map(({ weight: _weight, ...entry }) => entry),
    warnings: draft.warnings ?? [],
    counts: {
      mapped: draft.counts?.mapped ?? mapped.length,
      derived: draft.counts?.derived ?? derived.length,
      ignored: Object.values(ignoredByCategory).reduce((total, count) => total + count, 0),
      ignoredByCategory,
    },
  };
}

function candidate(theme: Theme, draft: DraftReport): ThemeImportCandidate {
  return {
    id: theme.id,
    name: theme.name,
    author: theme.author,
    license: theme.license,
    variants: draft.variants,
    toml: [
      "#:schema https://docs.tryatlas.cc/schema/theme-v1.json",
      "schema = 1",
      `id = "${theme.id}"`,
      `name = "${theme.name}"`,
      `author = "${theme.author}"`,
      `license = "${theme.license}"`,
      "# …the full variant tables are written by Rust.",
      "",
    ].join("\n"),
    theme,
    report: buildReport(draft),
    existing: builtins.some((builtin) => builtin.id === theme.id) ? "built-in" : "new",
  };
}

const SHADCN: ThemeImportPreview = {
  origin: "pasted text",
  format: "shadcn registry item",
  themes: [
    candidate(byId("catppuccin"), {
      format: "shadcn",
      sourceName: "Catppuccin",
      fidelity: "native",
      variants: ["dark", "light"],
      summary: [
        "shadcn themes describe application chrome only: Atlas's editor, terminal, syntax and diff keys fall back to the built-in defaults for the appearance.",
      ],
      warnings: [
        "`spacing` was kept in the theme file but Atlas ignores it — spacing and the type scale are app-owned (decision 20).",
      ],
      mapped: [
        {
          target: "dark.base.background",
          source: "--background (dark)",
          value: "oklch(0.2155 0.0254 284.0647)",
        },
        {
          target: "dark.base.primary",
          source: "--primary (dark)",
          value: "oklch(0.7871 0.1187 304.7693)",
        },
        {
          target: "dark.base.font-sans",
          source: "--font-sans (@theme)",
          value: "Montserrat, sans-serif",
        },
        {
          target: "light.base.background",
          source: "--background (light)",
          value: "oklch(0.9578 0.0058 264.5321)",
        },
      ],
      derived: [
        {
          target: "dark.base.destructive-foreground",
          from: "contrast with destructive",
          value: "#0a0a0a",
        },
        {
          target: "dark.palette.blue",
          from: "base.primary",
          value: "oklch(0.7871 0.1187 304.7693)",
        },
      ],
      ignored: [
        {
          source: "--shadow-color, --shadow-opacity, --shadow-blur, …",
          category: "shadow recipe",
          reason: "Atlas takes the composed shadow ramp, not the parts it was built from",
          weight: 6,
        },
      ],
      counts: { mapped: 88, derived: 20 },
    }),
  ],
};

const ZED: ThemeImportPreview = {
  origin: "rose-pine.json",
  format: "Zed theme",
  themes: [
    candidate(byId("rose-pine"), {
      format: "zed",
      sourceName: "Rosé Pine",
      fidelity: "near-lossless",
      variants: ["dark"],
      summary: [
        "Atlas's theme keys were modeled on Zed's roles, so the editor, terminal, syntax and diff colors transfer directly.",
        "Zed has no shadcn layer, so all 45 base tokens were derived from the style — check `primary`, `accent` and `card` first if the chrome looks off.",
      ],
      mapped: [
        { target: "dark.keys.border.subtle", source: "border", value: "#26233aff" },
        { target: "dark.keys.syntax.keyword", source: "syntax.keyword", value: "#31748fff" },
        { target: "dark.keys.terminal.ansi.red", source: "terminal.ansi.red", value: "#eb6f92ff" },
      ],
      derived: [
        { target: "dark.base.accent", from: "style.element.hover", value: "#ffffff14" },
        { target: "dark.base.radius", from: "atlas default", value: "8px" },
      ],
      ignored: [
        {
          source: "5 icon roles key(s)",
          category: "icon roles",
          reason: "Atlas icons take their color from the text roles",
          weight: 5,
        },
        {
          source: "9 app chrome key(s)",
          category: "app chrome",
          reason: "Atlas's chrome follows the panel tokens",
          weight: 9,
        },
        {
          source: "syntax.* (13 scopes)",
          category: "syntax scopes",
          reason: "Atlas has 20 syntax roles; Zed's finer scopes collapse onto them",
          weight: 13,
        },
        {
          source: "syntax.keyword.font_style",
          category: "font styles",
          reason:
            "an Atlas theme key carries a color only; the scope is imported with its color and no italics",
          weight: 1,
        },
      ],
      counts: { mapped: 96, derived: 26 },
    }),
    candidate(byId("rose-pine-dawn"), {
      format: "zed",
      sourceName: "Rosé Pine Dawn",
      fidelity: "near-lossless",
      variants: ["light"],
      summary: ["A family member becomes its own Atlas theme with a single appearance."],
      mapped: [
        { target: "light.keys.border.subtle", source: "border", value: "#f4ede8ff" },
        { target: "light.keys.syntax.string", source: "syntax.string", value: "#ea9d34ff" },
      ],
      derived: [{ target: "light.base.primary", from: "style.text.accent", value: "#907aa9ff" }],
      ignored: [
        {
          source: "5 icon roles key(s)",
          category: "icon roles",
          reason: "Atlas icons take their color from the text roles",
          weight: 5,
        },
        {
          source: "9 app chrome key(s)",
          category: "app chrome",
          reason: "Atlas's chrome follows the panel tokens",
          weight: 9,
        },
      ],
      counts: { mapped: 96, derived: 26 },
    }),
  ],
};

const VSCODE: ThemeImportPreview = {
  origin: "nocturne-bright.json",
  format: "VS Code color theme",
  themes: [
    candidate(byId("nocturne-bright"), {
      format: "vscode",
      sourceName: "Nocturne Bright",
      fidelity: "lossy",
      variants: ["dark"],
      summary: [
        "resolved `include`: ./vscode-base.json",
        "a VS Code theme is a starting point, not a copy: it describes a workbench Atlas does not have, and Atlas's chrome (panels, tabs, comms, agent chips) is derived rather than stated.",
      ],
      warnings: [
        "`semanticTokenColors` carries 2 selectors with modifiers; a conditional rule cannot be applied unconditionally, so they were left out.",
      ],
      mapped: [
        { target: "dark.keys.editor.background", source: "editor.background", value: "#20232b" },
        { target: "dark.keys.syntax.comment", source: "tokenColors[comment]", value: "#6b7280" },
        {
          target: "dark.keys.syntax.property",
          source: "semanticTokenColors.property",
          value: "#8ec07c",
        },
      ],
      derived: [
        { target: "dark.base.card", from: "editorWidget.background", value: "#21232a" },
        { target: "dark.keys.search.match.background", from: "atlas default", value: "#5a9cf826" },
      ],
      ignored: [
        {
          source: "18 editor furniture key(s)",
          category: "editor furniture",
          reason: "minimap, rulers, indent guides, inlay hints — Atlas draws none of them",
          weight: 18,
        },
        {
          source: "14 widget key(s)",
          category: "widget",
          reason: "Atlas's popovers, menus and toasts follow the popover tokens",
          weight: 14,
        },
        {
          source: "9 app chrome key(s)",
          category: "app chrome",
          reason: "Atlas's status and title bars follow the panel tokens",
          weight: 9,
        },
        {
          source: "tokenColors (11 rules)",
          category: "textmate scopes",
          reason:
            "Atlas has 20 syntax roles; grammar-specific and markup scopes have no equivalent",
          weight: 11,
        },
        {
          source: "semanticTokenColors (2 selectors)",
          category: "semantic tokens",
          reason: "only bare token types are read",
          weight: 2,
        },
        {
          source: "tokenColors[keyword].fontStyle",
          category: "font styles",
          reason:
            "an Atlas theme key carries a color only; the scope is imported with its color and no italics",
          weight: 3,
        },
      ],
      counts: { mapped: 61, derived: 73 },
    }),
  ],
};

/** The messages Rust produces for the three ways an import goes wrong. */
function rejection(source: string): string | null {
  const text = source.trim();
  if (!text) return "nothing to import: paste a theme, give a URL, or choose a file";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
    } catch (cause) {
      return `invalid theme in pasted text: invalid JSON: ${String(cause).replace(/^SyntaxError:\s*/, "")}`;
    }
    return null;
  }
  if (text.includes("--") || text.includes("{")) return null;
  return "invalid theme in pasted text: unrecognized theme format: expected a shadcn registry item, a shadcn globals.css, a Zed theme family, or a VS Code color theme";
}

function previewFor(args: { text?: string; url?: string; path?: string }): ThemeImportPreview {
  const source = args.text ?? "";
  if (!args.url && !args.path) {
    const error = rejection(source);
    if (error) throw new Error(error);
  }
  const haystack = `${source} ${args.url ?? ""} ${args.path ?? ""}`.toLowerCase();
  if (haystack.includes('"themes"') || haystack.includes("zed")) return ZED;
  if (
    haystack.includes("tokencolors") ||
    haystack.includes("semantictokencolors") ||
    haystack.includes('"include"') ||
    haystack.includes("vscode") ||
    haystack.includes("vs-code")
  ) {
    return VSCODE;
  }
  if (haystack.includes("no-usable-colours")) {
    throw new Error("invalid theme in pasted text: no usable colors found");
  }
  return SHADCN;
}

/** Rust labels a preview with where the bytes came from; so does the mock. */
function originOf(args: { text?: string; url?: string; path?: string }): string {
  if (args.path) return args.path.split("/").pop() ?? args.path;
  if (args.url) return args.url;
  return "pasted text";
}

function exportOf(id: string): ShadcnExport {
  const theme = builtins.find((candidate) => candidate.id === id) ?? builtins[0];
  const dropped =
    Object.keys(theme.dark?.keys ?? {}).length + Object.keys(theme.dark?.palette ?? {}).length;
  const json = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: theme.id,
    type: "registry:style",
    title: theme.name,
    author: theme.author,
    cssVars: {
      ...(theme.light ? { light: stripThemeLevel(theme.light.base) } : {}),
      ...(theme.dark ? { dark: stripThemeLevel(theme.dark.base) } : {}),
      theme: themeLevel((theme.dark ?? theme.light)?.base ?? {}),
    },
  };
  return {
    id: theme.id,
    name: theme.name,
    json: `${JSON.stringify(json, null, 2)}\n`,
    variants: [theme.light && "light", theme.dark && "dark"].filter((v): v is string => Boolean(v)),
    report: {
      exported: Object.keys(theme.dark?.base ?? theme.light?.base ?? {}).length,
      dropped,
      droppedByCategory: countFamilies(theme),
      notes: [
        "Base tokens cross verbatim: shadcn's names are Atlas's names, so the chrome is exact.",
        `${dropped} Atlas values have no shadcn equivalent and were dropped — the editor, terminal, syntax, diff, comms and agent colors. To move this theme to another Atlas install, copy the TOML instead.`,
      ],
    },
  };
}

const THEME_LEVEL = [
  "radius",
  "font-sans",
  "font-serif",
  "font-mono",
  "tracking-normal",
  "spacing",
];

function stripThemeLevel(base: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([token]) => !THEME_LEVEL.includes(token)));
}

function themeLevel(base: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([token]) => THEME_LEVEL.includes(token)));
}

function countFamilies(theme: Theme): Record<string, number> {
  const out: Record<string, number> = {};
  for (const variant of [theme.dark, theme.light]) {
    if (!variant) continue;
    if (Object.keys(variant.palette).length > 0) {
      out.palette = (out.palette ?? 0) + Object.keys(variant.palette).length;
    }
    for (const key of Object.keys(variant.keys)) {
      const family = key.split(".")[0];
      out[family] = (out[family] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Themes committed during this session.
 *
 * A committed import has to become a theme the picker lists and `get_theme`
 * answers for, or "Add theme" leaves the app on the fallback and the one thing
 * the panel exists to do cannot be checked in the browser. `scenarios/base.ts`
 * merges this over the built-ins, so the sequence a user actually performs —
 * convert, name, add, watch the app repaint — works end to end on the mock.
 *
 * Session-only, like every other mock write.
 */
export const importedUserThemes: Theme[] = [];

function install(toml: string, typedId: string, name: string): CommittedThemeImport {
  // Rust slugs the typed id before saving, and the reply's `id` is the one the
  // panel applies — so a typed "My Theme!" has to come back as "my-theme" here
  // too, or the mock would hide exactly the mismatch the reply exists to fix.
  const id = themeIdSlug(typedId);
  if (!id) throw new Error("a theme id needs at least one letter or digit");
  // The preview's TOML is a stub here, so the theme is taken from the snapshot
  // the same preview was built from, then renamed the way Rust renames it.
  const source = imported.find((theme) => toml.includes(`id = "${theme.id}"`)) ?? imported[0];
  const installed: Theme = { ...source, id, name: name.trim() || source.name };
  const existing = importedUserThemes.findIndex((theme) => theme.id === id);
  if (existing >= 0) importedUserThemes[existing] = installed;
  else importedUserThemes.push(installed);
  return { id, path: `~/.config/atlas/themes/${id}.toml` };
}

/**
 * What the frontend reads from each command below — the return type of its
 * wrapper in `theme-import-api.ts`, which `invoke` infers its `T` from.
 */
export interface ThemeImportResponses {
  preview_theme_import: ThemeImportPreview;
  commit_theme_import: CommittedThemeImport;
  export_theme_shadcn: ShadcnExport;
}

export const themeImportHandlers: TypedHandlers<ThemeImportResponses> = {
  preview_theme_import: ({ input }): ThemeImportPreview => {
    const args = (input ?? {}) as { text?: string; url?: string; path?: string };
    return { ...previewFor(args), origin: originOf(args) };
  },
  commit_theme_import: ({ toml, id, name }): CommittedThemeImport =>
    install(String(toml), String(id), String(name)),
  export_theme_shadcn: ({ id }): ShadcnExport => exportOf(String(id)),
};
