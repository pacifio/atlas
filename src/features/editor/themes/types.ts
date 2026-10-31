/**
 * Editor color theme model — the single source of truth for every code surface
 * in Atlas (the file view, the diff viewer, the source-control diff
 * views). One flat token object drives BOTH the CodeMirror runtime theme
 * (see build-cm-theme.ts) and the CSS custom properties consumed by the
 * `.cm-*` / `.diff-syntax .hljs-*` stylesheets (see apply-editor-theme.ts).
 */

export interface EditorThemeColors {
  // — Editor chrome —
  bg: string;
  fg: string;
  caret: string;
  gutterBg: string;
  gutterFg: string;
  activeLineGutterFg: string;
  activeLineBg: string;
  selectionBg: string;
  matchBracketBg: string;
  matchBracketOutline: string;
  foldBg: string;
  foldBorder: string;
  foldFg: string;

  // — Syntax — (`func` is the signature accent) —
  comment: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  func: string;
  variable: string;
  operator: string;
  tagName: string;
  attributeName: string;
  constant: string;
  regexp: string;
  escape: string;
  definition: string;
  propertyName: string;
  bool: string;
  null: string;

  // — Diff line backgrounds (unified + side-by-side) —
  addLineBg: string;
  removeLineBg: string;
  contextBg: string;
  addSideBg: string;
  removeSideBg: string;
  emphAddBg: string;
  emphRemoveBg: string;
}

export interface EditorColorTheme {
  id: string;
  name: string;
  description: string;
  dark: boolean;
  colors: EditorThemeColors;
}
