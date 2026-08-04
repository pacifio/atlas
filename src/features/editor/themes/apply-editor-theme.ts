import { getEditorTheme, resolveEditorColors } from "./themes";
import type { EditorThemeColors } from "./types";

/**
 * Map the theme tokens to the CSS custom properties consumed by the stylesheet
 * surfaces (`styles/globals.css` `.cm-*` fallback, `styles/diff-syntax.css`
 * `.hljs-*`, and the diff line backgrounds in diff-view.tsx / git-diff-panel.tsx).
 * The CSS references each as `var(--…, <atlas-hex>)`, so if this applier never
 * runs (or loses a production race) the surfaces degrade to the default Atlas
 * look rather than breaking.
 *
 * Exported for `css-fallbacks.test.ts`, which reads those hand-written `var()`
 * fallbacks back out of the stylesheets and holds them to the values this
 * mapping produces for the default theme. Without that, the fallbacks are three
 * copies of one palette kept in step by memory — and they had already drifted.
 */
export function editorThemeCssVars(c: EditorThemeColors): Record<string, string> {
  return {
    // chrome (globals.css .cm-* fallback)
    "--cm-bg": c.bg,
    "--cm-fg": c.fg,
    "--cm-caret": c.caret,
    "--cm-gutter-bg": c.gutterBg,
    "--cm-gutter-fg": c.gutterFg,
    "--cm-active-gutter-fg": c.activeLineGutterFg,
    "--cm-active-line-bg": c.activeLineBg,
    "--cm-selection-bg": c.selectionBg,
    "--cm-bracket-bg": c.matchBracketBg,
    "--cm-bracket-outline": c.matchBracketOutline,
    "--cm-fold-bg": c.foldBg,
    "--cm-fold-border": c.foldBorder,
    "--cm-fold-fg": c.foldFg,

    // syntax (diff-syntax.css .hljs-*)
    "--cm-comment": c.comment,
    "--cm-keyword": c.keyword,
    "--cm-string": c.string,
    "--cm-number": c.number,
    "--cm-type": c.type,
    "--cm-func": c.func,
    "--cm-variable": c.variable,
    "--cm-tag": c.tagName,
    "--cm-attr": c.attributeName,
    "--cm-constant": c.constant,
    "--cm-regexp": c.regexp,
    "--cm-property": c.propertyName,
    "--cm-meta": c.attributeName,

    // diff line backgrounds
    "--diff-add-line-bg": c.addLineBg,
    "--diff-remove-line-bg": c.removeLineBg,
    "--diff-context-bg": c.contextBg,
    "--diff-add-side-bg": c.addSideBg,
    "--diff-remove-side-bg": c.removeSideBg,
    "--diff-emph-add-bg": c.emphAddBg,
    "--diff-emph-remove-bg": c.emphRemoveBg,
  };
}

/** Apply the given editor theme id by writing its tokens as CSS custom
 * properties onto `document.documentElement`. Pure DOM, safe pre-mount. */
export function applyEditorTheme(id: string | undefined | null): void {
  if (typeof document === "undefined") return;
  const theme = getEditorTheme(id);
  const root = document.documentElement;
  const vars = editorThemeCssVars(resolveEditorColors(theme));
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}
