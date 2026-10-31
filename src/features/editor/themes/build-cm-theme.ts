import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { EditorThemeColors } from "./types";
import { getActiveTheme } from "@/features/theme/apply-theme";
import type { ResolvedTheme } from "@/features/theme/resolve-theme";
import { THEME_KEY_REGISTRY, type ThemeKey } from "@/features/theme/theme-key-registry";
import { themeBase } from "@/features/theme/theme-values";

/**
 * Atlas's per-appearance default for every theme key, read from the registry
 * rather than restated here.
 *
 * This file used to carry thirty-seven hex fallbacks — one per key it reads —
 * for the window before the first `applyTheme`. They were a second copy of
 * `keys.toml`, kept in step by hand, and nothing would have failed if one had
 * drifted: the editor would simply have painted a colour no theme asked for
 * while it waited. The registry is the one source (decision 42), and
 * `theme-values.ts` already falls back the same way.
 */
const KEY_DEFAULTS = Object.fromEntries(
  THEME_KEY_REGISTRY.map((definition) => [definition.key, definition.rule.atlasDefault.dark]),
) as Record<ThemeKey, string>;

/**
 * The editor's type metrics. `13px` is the `--text-base` step of the Atlas
 * scale and matches the other CodeMirror surface in the app (the chat
 * composer); the editor used to sit a step above at `14px`, which read as
 * oversized next to every panel around it. `20px` of leading (~1.54) is the
 * comfortable end of the range for code — the previous `18px` (~1.29) packed
 * lines tightly enough to work against legibility rather than for it.
 *
 * Both live on the editor root, NOT on `.cm-content`: CodeMirror measures line
 * height off the content element to position gutter markers, so metrics
 * applied to content alone desync the line numbers from their lines. The
 * stylesheet fallback in `styles/globals.css` (`.cm-editor`) mirrors these two
 * values for the case where the runtime theme injection loses its race.
 */
// `editorFontSize`, set on <html> by `display-settings.ts`; the 20/13 line
// height scales with it, and CodeMirror re-measures when the variable changes.
const EDITOR_FONT_SIZE = "var(--atlas-editor-font-size, 13px)";
const EDITOR_LINE_HEIGHT = "calc(var(--atlas-editor-font-size, 13px) * 20 / 13)";
// The fold-gutter label sits a step down from the editor body — text-sm (12px)
// is the exact step the previous literal `12px` already rendered at.
const FOLD_GUTTER_FONT_SIZE = "var(--text-sm)";

/**
 * Build the CodeMirror chrome theme from a color theme. Mirrors the structure of
 * the original hand-rolled `atlasTheme` so behaviour is identical — only the
 * syntax values are theme-driven; the background is always the interface base
 * surface (see `resolveEditorColors`).
 */
export function editorColorsFromTheme(theme: ResolvedTheme | null): EditorThemeColors {
  const key = (name: ThemeKey) => theme?.keys[name] ?? KEY_DEFAULTS[name];
  // `tokens.css` defines the whole base-token set on `:root`, so an unresolved
  // base token has a real value to read rather than a literal to restate.
  const token = (name: string) => theme?.base[name] ?? themeBase(name);
  return {
    bg: key("editor.background"),
    fg: key("editor.foreground"),
    caret: key("editor.caret"),
    gutterBg: key("editor.gutter.background"),
    gutterFg: key("editor.gutter.foreground"),
    activeLineGutterFg: key("editor.active_line.gutter_foreground"),
    activeLineBg: key("editor.active_line.background"),
    selectionBg: key("editor.selection.background"),
    matchBracketBg: key("editor.match_bracket.background"),
    matchBracketOutline: key("editor.match_bracket.border"),
    // The fold placeholder is a secondary surface with a secondary label; it
    // does not need three theme keys of its own.
    foldBg: token("secondary"),
    foldBorder: token("border"),
    foldFg: token("secondary-foreground"),
    comment: key("syntax.comment"),
    keyword: key("syntax.keyword"),
    string: key("syntax.string"),
    number: key("syntax.number"),
    type: key("syntax.type"),
    func: key("syntax.function"),
    variable: key("syntax.variable"),
    operator: key("syntax.operator"),
    tagName: key("syntax.tag"),
    attributeName: key("syntax.attribute"),
    constant: key("syntax.constant"),
    regexp: key("syntax.regexp"),
    escape: key("syntax.escape"),
    definition: key("syntax.definition"),
    propertyName: key("syntax.property"),
    // Booleans and nulls ARE constants; three keys for one role is two too
    // many, and every built-in theme set all three to the same colour.
    bool: key("syntax.constant"),
    null: key("syntax.constant"),
    addLineBg: key("diff.added.background"),
    removeLineBg: key("diff.removed.background"),
    contextBg: key("diff.context.background"),
    // Side-by-side reads the same fill as inline: they are the same diff.
    addSideBg: key("diff.added.background"),
    removeSideBg: key("diff.removed.background"),
    emphAddBg: key("diff.added.emphasis"),
    emphRemoveBg: key("diff.removed.emphasis"),
  };
}

export function buildEditorChromeTheme(theme: ResolvedTheme | null): Extension {
  const c = editorColorsFromTheme(theme);
  return EditorView.theme(
    {
      "&": {
        backgroundColor: c.bg,
        color: c.fg,
        height: "100%",
        // The theme owns the mono stack; `tokens.css` has the fallback chain.
        fontFamily: "var(--font-mono)",
        fontSize: EDITOR_FONT_SIZE,
        lineHeight: EDITOR_LINE_HEIGHT,
      },
      ".cm-content": {
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
        fontSize: FOLD_GUTTER_FONT_SIZE,
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
    { dark: theme?.appearance !== "light" },
  );
}

/**
 * Build the syntax HighlightStyle from a color theme.
 *
 * A `HighlightStyle` only colors the tags it names — anything a grammar emits
 * that isn't listed here renders in the plain foreground color. That is why the
 * prose block below matters: Markdown parses fine, but with only the code tags
 * mapped, a `.md` file came out as flat grey text, indistinguishable from
 * having no grammar at all (issue #75).
 *
 * Child tags inherit their parent's rule (`tags.controlKeyword` is a
 * `tags.keyword`), so the code list stays short while still covering the
 * keyword/operator variants the individual grammars reach for.
 * `build-cm-theme.test.ts` pins the set that must resolve to a style.
 */
export function buildHighlightStyle(theme: ResolvedTheme | null): HighlightStyle {
  const c = editorColorsFromTheme(theme);
  return HighlightStyle.define([
    // — Code —
    { tag: tags.comment, color: c.comment, fontStyle: "italic" },
    { tag: tags.keyword, color: c.keyword, fontStyle: "italic" },
    { tag: [tags.string, tags.special(tags.string)], color: c.string },
    { tag: tags.number, color: c.number },
    { tag: [tags.typeName, tags.className, tags.namespace], color: c.type },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: c.func },
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
    { tag: [tags.definition(tags.variableName), tags.labelName], color: c.definition },
    { tag: tags.propertyName, color: c.propertyName },
    { tag: tags.bool, color: c.bool },
    { tag: tags.null, color: c.null },
    // `atom` is what several grammars use where others use bool/null.
    { tag: tags.atom, color: c.constant },
    // Shebangs, pragmas, front-matter fences. Uses `attributeName` because
    // that is what `--atlas-syntax-attribute` already resolves to for the diff viewer's
    // `.hljs-meta` (see apply-editor-theme.ts) — one concept, one color across
    // both code surfaces.
    { tag: tags.meta, color: c.attributeName },

    // — Prose (Markdown) —
    // Headings carry the accent because they are the document's structure, the
    // way function names are a source file's.
    { tag: tags.heading, color: c.func, fontWeight: "600" },
    { tag: tags.strong, color: c.definition, fontWeight: "600" },
    { tag: tags.emphasis, color: c.definition, fontStyle: "italic" },
    { tag: tags.strikethrough, color: c.comment, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: c.type, textDecoration: "underline" },
    { tag: tags.monospace, color: c.string },
    { tag: tags.quote, color: c.comment, fontStyle: "italic" },
    { tag: tags.list, color: c.operator },
    // The `#`, `**` and `-` markers themselves: legible but receding, so the
    // text they mark up stays the thing being read.
    { tag: [tags.processingInstruction, tags.contentSeparator], color: c.comment },
  ]);
}

/**
 * The complete extension bundle for one editor theme: the chrome (colors, type
 * metrics) plus the syntax highlighter.
 *
 * CodeMirror needs BOTH halves — a language extension parses the document, and
 * a `syntaxHighlighting` style colors what it parsed. Keeping them in one
 * function is what stops a caller from installing the theme and quietly
 * omitting the highlighter, which looks exactly like a missing grammar.
 *
 * Everything here is state-free, so the editor can hold it in a `Compartment`
 * and reconfigure on a theme change without touching the document or its undo
 * history.
 */
export function editorThemeExtensions(theme: ResolvedTheme | null = getActiveTheme()): Extension {
  return [buildEditorChromeTheme(theme), syntaxHighlighting(buildHighlightStyle(theme))];
}
