import type { EditorColorTheme, EditorThemeColors } from "./types";

/**
 * Built-in editor color themes. `atlas` reproduces the exact original
 * "monochrome + #ffff00 accent" look (values lifted verbatim from the old
 * atlasTheme/atlasHighlightStyle + diff-syntax.css + diff-view.tsx), so picking
 * it returns the app to its historical appearance. The others are the standard
 * dark palettes (Dracula, One Dark, Monokai, Vesper).
 */

const atlas: EditorColorTheme = {
  id: "atlas",
  name: "Atlas",
  description: "Monochrome AMOLED black with a single yellow accent.",
  dark: true,
  colors: {
    bg: "#000000",
    fg: "#b3b3b3",
    caret: "#b3b3b3",
    gutterBg: "#000000",
    gutterFg: "#222222",
    activeLineGutterFg: "#777777",
    activeLineBg: "#ffffff0a",
    selectionBg: "#303030",
    matchBracketBg: "#2d2d2d",
    matchBracketOutline: "#3d3d3d",
    foldBg: "#1a1a1a",
    foldBorder: "#2a2a2a",
    foldFg: "#555555",

    comment: "#555555",
    keyword: "#585858",
    string: "#aaaaaa",
    number: "#aaaaaa",
    type: "#cccccc",
    func: "#ffff00",
    variable: "#ffffff",
    operator: "#b3b3b3",
    tagName: "#cccccc",
    attributeName: "#777777",
    constant: "#aaaaaa",
    regexp: "#999999",
    escape: "#999999",
    definition: "#ffffff",
    propertyName: "#b3b3b3",
    bool: "#aaaaaa",
    null: "#aaaaaa",

    addLineBg: "#0d2211",
    removeLineBg: "#220d0d",
    contextBg: "#0a0a0a",
    addSideBg: "rgba(34,197,94,0.13)",
    removeSideBg: "rgba(244,63,63,0.13)",
    emphAddBg: "rgba(52,211,153,0.34)",
    emphRemoveBg: "rgba(244,63,63,0.34)",
  },
};

const dracula: EditorColorTheme = {
  id: "dracula",
  name: "Dracula",
  description: "The classic purple-tinted dark theme with vivid syntax.",
  dark: true,
  colors: {
    bg: "#282a36",
    fg: "#f8f8f2",
    caret: "#f8f8f2",
    gutterBg: "#282a36",
    gutterFg: "#6272a4",
    activeLineGutterFg: "#f8f8f2",
    activeLineBg: "#ffffff0a",
    selectionBg: "#44475a",
    matchBracketBg: "#44475a",
    matchBracketOutline: "#6272a4",
    foldBg: "#21222c",
    foldBorder: "#44475a",
    foldFg: "#6272a4",

    comment: "#6272a4",
    keyword: "#ff79c6",
    string: "#f1fa8c",
    number: "#bd93f9",
    type: "#8be9fd",
    func: "#50fa7b",
    variable: "#f8f8f2",
    operator: "#ff79c6",
    tagName: "#ff79c6",
    attributeName: "#50fa7b",
    constant: "#bd93f9",
    regexp: "#ff5555",
    escape: "#ff5555",
    definition: "#f8f8f2",
    propertyName: "#8be9fd",
    bool: "#bd93f9",
    null: "#bd93f9",

    addLineBg: "#1e3a2a",
    removeLineBg: "#3a1e28",
    contextBg: "#21222c",
    addSideBg: "rgba(80,250,123,0.13)",
    removeSideBg: "rgba(255,85,85,0.13)",
    emphAddBg: "rgba(80,250,123,0.30)",
    emphRemoveBg: "rgba(255,85,85,0.30)",
  },
};

const oneDark: EditorColorTheme = {
  id: "one-dark",
  name: "One Dark",
  description: "Atom's balanced blue-and-slate dark theme.",
  dark: true,
  colors: {
    bg: "#282c34",
    fg: "#abb2bf",
    caret: "#528bff",
    gutterBg: "#282c34",
    gutterFg: "#4b5263",
    activeLineGutterFg: "#abb2bf",
    activeLineBg: "#ffffff0a",
    selectionBg: "#3e4451",
    matchBracketBg: "#3e4451",
    matchBracketOutline: "#528bff",
    foldBg: "#21252b",
    foldBorder: "#3e4451",
    foldFg: "#5c6370",

    comment: "#5c6370",
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    type: "#e5c07b",
    func: "#61afef",
    variable: "#e06c75",
    operator: "#56b6c2",
    tagName: "#e06c75",
    attributeName: "#d19a66",
    constant: "#d19a66",
    regexp: "#98c379",
    escape: "#56b6c2",
    definition: "#61afef",
    propertyName: "#abb2bf",
    bool: "#d19a66",
    null: "#d19a66",

    addLineBg: "#1c3323",
    removeLineBg: "#331c1f",
    contextBg: "#21252b",
    addSideBg: "rgba(152,195,121,0.13)",
    removeSideBg: "rgba(224,108,117,0.13)",
    emphAddBg: "rgba(152,195,121,0.30)",
    emphRemoveBg: "rgba(224,108,117,0.30)",
  },
};

const monokai: EditorColorTheme = {
  id: "monokai",
  name: "Monokai",
  description: "High-contrast green/pink palette on warm charcoal.",
  dark: true,
  colors: {
    bg: "#272822",
    fg: "#f8f8f2",
    caret: "#f8f8f0",
    gutterBg: "#272822",
    gutterFg: "#90908a",
    activeLineGutterFg: "#f8f8f2",
    activeLineBg: "#ffffff0a",
    selectionBg: "#49483e",
    matchBracketBg: "#49483e",
    matchBracketOutline: "#75715e",
    foldBg: "#1e1f1c",
    foldBorder: "#49483e",
    foldFg: "#75715e",

    comment: "#75715e",
    keyword: "#f92672",
    string: "#e6db74",
    number: "#ae81ff",
    type: "#66d9ef",
    func: "#a6e22e",
    variable: "#f8f8f2",
    operator: "#f92672",
    tagName: "#f92672",
    attributeName: "#a6e22e",
    constant: "#ae81ff",
    regexp: "#e6db74",
    escape: "#ae81ff",
    definition: "#a6e22e",
    propertyName: "#66d9ef",
    bool: "#ae81ff",
    null: "#ae81ff",

    addLineBg: "#26331c",
    removeLineBg: "#331c22",
    contextBg: "#1e1f1c",
    addSideBg: "rgba(166,226,46,0.13)",
    removeSideBg: "rgba(249,38,114,0.13)",
    emphAddBg: "rgba(166,226,46,0.30)",
    emphRemoveBg: "rgba(249,38,114,0.30)",
  },
};

const vesper: EditorColorTheme = {
  id: "vesper",
  name: "Vesper",
  description: "Minimal near-black with warm peach and mint accents.",
  dark: true,
  colors: {
    bg: "#101010",
    fg: "#ffffff",
    caret: "#ffc799",
    gutterBg: "#101010",
    gutterFg: "#3a3a3a",
    activeLineGutterFg: "#8b8b8b",
    activeLineBg: "#ffffff0a",
    selectionBg: "rgba(255,255,255,0.13)",
    matchBracketBg: "#2a2a2a",
    matchBracketOutline: "#3a3a3a",
    foldBg: "#1a1a1a",
    foldBorder: "#2a2a2a",
    foldFg: "#555555",

    comment: "#8b8b8b",
    keyword: "#a0a0a0",
    string: "#99ffe4",
    number: "#ffc799",
    type: "#ffcfa8",
    func: "#ffc799",
    variable: "#ffffff",
    operator: "#a0a0a0",
    tagName: "#a0a0a0",
    attributeName: "#ffc799",
    constant: "#ffc799",
    regexp: "#99ffe4",
    escape: "#99ffe4",
    definition: "#ffffff",
    propertyName: "#e0e0e0",
    bool: "#ffc799",
    null: "#ffc799",

    addLineBg: "#14261a",
    removeLineBg: "#2a1414",
    contextBg: "#0d0d0d",
    addSideBg: "rgba(153,255,228,0.10)",
    removeSideBg: "rgba(255,120,120,0.12)",
    emphAddBg: "rgba(153,255,228,0.24)",
    emphRemoveBg: "rgba(255,120,120,0.30)",
  },
};

export const EDITOR_THEMES: EditorColorTheme[] = [
  atlas,
  dracula,
  oneDark,
  monokai,
  vesper,
];

export const DEFAULT_EDITOR_THEME_ID = "atlas";

export function getEditorTheme(
  id: string | undefined | null,
): EditorColorTheme {
  return EDITOR_THEMES.find((t) => t.id === id) ?? atlas;
}

/**
 * Atlas keeps ONE background across every editor theme: the interface base
 * surface (`--bg-base`, AMOLED black). A theme only recolors syntax and the
 * diff add/remove signal — never the neutral background. So we always force the
 * editor chrome background, the gutter, and the diff *context* (unchanged-line)
 * background to `--bg-base`, ignoring whatever `bg`/`gutterBg`/`contextBg` a
 * theme declares. Uses the CSS var (not a literal) so it tracks the interface.
 */
export function resolveEditorColors(
  theme: EditorColorTheme,
): EditorThemeColors {
  return {
    ...theme.colors,
    bg: "var(--bg-base)",
    gutterBg: "var(--bg-base)",
    contextBg: "var(--bg-base)",
  };
}
