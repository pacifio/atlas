import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { EditorColorTheme } from "./types";
import { resolveEditorColors } from "./themes";

/**
 * Build the CodeMirror chrome theme from a color theme. Mirrors the structure of
 * the original hand-rolled `atlasTheme` so behaviour is identical — only the
 * syntax values are theme-driven; the background is always the interface base
 * surface (see `resolveEditorColors`).
 */
export function buildEditorChromeTheme(theme: EditorColorTheme): Extension {
  const c = resolveEditorColors(theme);
  return EditorView.theme(
    {
      "&": {
        backgroundColor: c.bg,
        color: c.fg,
        height: "100%",
      },
      ".cm-content": {
        fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace",
        fontSize: "14px",
        lineHeight: "18px",
        caretColor: c.caret,
        padding: "4px 0",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: c.caret,
        borderLeftWidth: "2px",
      },
      ".cm-gutters": {
        backgroundColor: c.gutterBg,
        color: c.gutterFg,
        border: "none",
        minWidth: "40px",
      },
      ".cm-activeLineGutter": {
        color: c.activeLineGutterFg,
        backgroundColor: "transparent",
      },
      ".cm-activeLine": {
        backgroundColor: c.activeLineBg,
      },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: `${c.selectionBg} !important`,
      },
      ".cm-focused .cm-selectionBackground": {
        backgroundColor: `${c.selectionBg} !important`,
      },
      ".cm-matchingBracket": {
        backgroundColor: c.matchBracketBg,
        outline: `1px solid ${c.matchBracketOutline}`,
      },
      ".cm-foldGutter .cm-gutterElement": {
        color: c.foldFg,
        fontSize: "12px",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: c.foldBg,
        border: `1px solid ${c.foldBorder}`,
        color: c.foldFg,
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-scroller": {
        overflow: "auto",
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": { display: "none" },
      },
      ".cm-line": {
        padding: "0 4px",
      },
    },
    { dark: theme.dark },
  );
}

/**
 * Build the syntax HighlightStyle from a color theme. Same tag→color map as the
 * original `atlasHighlightStyle`; comments and keywords keep the italic accent.
 */
export function buildHighlightStyle(theme: EditorColorTheme): HighlightStyle {
  const c = theme.colors;
  return HighlightStyle.define([
    { tag: tags.comment, color: c.comment, fontStyle: "italic" },
    { tag: tags.keyword, color: c.keyword, fontStyle: "italic" },
    { tag: [tags.string, tags.special(tags.string)], color: c.string },
    { tag: tags.number, color: c.number },
    { tag: [tags.typeName, tags.className], color: c.type },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: c.func,
    },
    { tag: tags.variableName, color: c.variable },
    { tag: tags.operator, color: c.operator },
    { tag: tags.punctuation, color: c.operator },
    { tag: tags.tagName, color: c.tagName },
    { tag: tags.attributeName, color: c.attributeName },
    {
      tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)],
      color: c.constant,
    },
    { tag: tags.regexp, color: c.regexp },
    { tag: tags.escape, color: c.escape },
    { tag: tags.definition(tags.variableName), color: c.definition },
    { tag: tags.propertyName, color: c.propertyName },
    { tag: tags.bool, color: c.bool },
    { tag: tags.null, color: c.null },
  ]);
}
