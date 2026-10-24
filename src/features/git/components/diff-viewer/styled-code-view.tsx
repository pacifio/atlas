import {
  CodeView,
  FileDiff,
  type FileDiffProps,
  type CodeViewHandle,
  type CodeViewProps,
  type ControlledCodeViewProps,
  type UncontrolledCodeViewProps,
} from "@pierre/diffs/react";
import type { CodeViewItem } from "@pierre/diffs";
import { useMemo, type ReactNode, type Ref } from "react";
import { getActiveTheme } from "@/features/theme/apply-theme";
import { useThemeVersion } from "@/features/theme/theme-values";
import { DIFF_THEME_NAMES } from "../../lib/diff-theme";
import {
  DiffWorkerPoolProvider,
  PREFERRED_HIGHLIGHTER,
  useDiffPoolFailed,
} from "./diff-worker-pool";

/**
 * The one place Atlas renders `@pierre/diffs`. Everything that styles the
 * viewer lives here, so no caller restyles it and no caller can forget the
 * worker pool.
 *
 * The viewer draws inside a shadow root, which page CSS cannot reach, but
 * custom properties inherit through it. So this stylesheet, handed to the
 * viewer as `unsafeCSS`, names only `--atlas-` theme keys (and the
 * app's font and type-scale variables): a theme switch recolours the diff
 * exactly as it recolours the page, with no re-render.
 */
export const DIFF_VIEW_CSS = `
/* The viewer derives its line tints on :host, from the overrides it can see
   there; set only on the rows below, they would arrive too late. */
:host,
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-font-size: var(--atlas-editor-font-size, 13px);
  --diffs-line-height: calc(var(--atlas-editor-font-size, 13px) * 20 / 13);
  --diffs-bg: var(--atlas-editor-background) !important;
  --diffs-light-bg: var(--atlas-editor-background) !important;
  --diffs-dark-bg: var(--atlas-editor-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-fg-number-override: var(--atlas-editor-gutter-foreground);

  --diffs-addition-color-override: var(--atlas-diff-added-text);
  --diffs-deletion-color-override: var(--atlas-diff-removed-text);
  --diffs-modified-color-override: var(--atlas-diff-modified-text);

  --diffs-bg-context-override: var(--atlas-diff-context-background);
  --diffs-bg-hover-override: var(--atlas-element-hover);
  --diffs-bg-separator-override: color-mix(
    in srgb,
    var(--atlas-editor-background) 95%,
    var(--atlas-editor-foreground)
  );
  --diffs-bg-buffer-override: var(--atlas-editor-gutter-background);
  --diffs-bg-selection-override: var(--atlas-editor-selection-background);

  /* Line tints: the code surface mixed with the palette's addition / deletion
     hue, stronger under the line number than across the code. Solid mixes,
     not the theme's translucent line backgrounds, which nearly vanish over
     the viewer's own surface. Every term is a variable, so the diff palette
     setting and a theme switch recolour them in place.

     These are mix *targets*, not the painted colour: the viewer paints a line
     as its surface mixed with the target at 15% (dark) / 9% (light), so 30%
     hue here lands as under 5% on screen. Don't read them as loud and halve
     them; the changed-word emphasis below is what stood out. */
  --diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--atlas-editor-background) 50%, var(--atlas-diff-added-text)),
    color-mix(in srgb, var(--atlas-editor-background) 70%, var(--atlas-diff-added-text))
  );
  --diffs-bg-addition-number-override: light-dark(
    color-mix(in srgb, var(--atlas-editor-background) 35%, var(--atlas-diff-added-text)),
    color-mix(in srgb, var(--atlas-editor-background) 60%, var(--atlas-diff-added-text))
  );
  --diffs-bg-addition-hover-override: color-mix(
    in srgb,
    var(--atlas-editor-background) 85%,
    var(--atlas-diff-added-text)
  );
  --diffs-bg-deletion-override: light-dark(
    color-mix(in srgb, var(--atlas-editor-background) 50%, var(--atlas-diff-removed-text)),
    color-mix(in srgb, var(--atlas-editor-background) 70%, var(--atlas-diff-removed-text))
  );
  --diffs-bg-deletion-number-override: light-dark(
    color-mix(in srgb, var(--atlas-editor-background) 35%, var(--atlas-diff-removed-text)),
    color-mix(in srgb, var(--atlas-editor-background) 60%, var(--atlas-diff-removed-text))
  );
  --diffs-bg-deletion-hover-override: color-mix(
    in srgb,
    var(--atlas-editor-background) 85%,
    var(--atlas-diff-removed-text)
  );
  /* Changed words: the theme's emphasis colour at about two thirds of its
     strength. Themes write emphasis at around a third opacity for an editor's
     merge view; painted at full strength over a diff line it saturates, a
     solid block per word. Scaled here, every theme and both diff palettes
     step down alike, to about the viewer's own default (0.15–0.2). */
  --diffs-bg-addition-emphasis-override: color-mix(
    in srgb,
    var(--atlas-diff-added-emphasis) 65%,
    transparent
  );
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--atlas-diff-removed-emphasis) 65%,
    transparent
  );

  background-color: var(--diffs-bg) !important;
  color: var(--atlas-editor-foreground) !important;
}

/* A 1fr track's automatic minimum grows with the mounted lines. In split wrap
   mode that shifts width between columns, rewraps rows, and sends the
   virtualizer chasing its scroll position. Pin both columns to one width. */
[data-diff-type="split"][data-overflow="wrap"] {
  --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
}

[data-file-info] {
  background-color: var(--atlas-editor-background) !important;
  border-block-color: transparent !important;
  color: var(--atlas-editor-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  /* On the code surface, with no rule under it: the file's name and its first
     line read as one block. */
  background-color: var(--atlas-editor-background) !important;
  border-bottom-color: transparent !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: var(--text-sm) !important;
  line-height: 1 !important;
  /* A collapsed item is never remeasured, so the painted header must be exactly
     the virtualizer's diffHeaderHeight. Centre controls in it; no padding. */
  height: 32px !important;
  min-height: 32px !important;
  box-sizing: border-box !important;
  padding-block: 0 !important;
  padding-inline: 8px 12px !important;
}

/* A full-width hover band would stop short at the native scrollbar gutter,
   which descendants cannot paint; an inset edge cue never looks clipped. */
[data-diffs-header]:hover {
  background-color: var(--atlas-editor-background) !important;
  box-shadow: inset 3px 0 color-mix(in srgb, var(--atlas-editor-foreground) 24%, transparent);
}

/* Hunk separators lead to the unchanged lines between hunks ("N unmodified
   lines", the expand control in its own cell): a band one step off the code
   surface, its text half-strength, both brought forward on hover. */
:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  /* Exact and margin-free: the virtualizer places rows by hunkSeparatorHeight. */
  height: 24px !important;
  margin-block: 0 !important;
  --diffs-bg-separator: color-mix(
    in srgb,
    var(--atlas-editor-background) 97%,
    var(--atlas-editor-foreground)
  );
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content],
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-expand-button] {
  color: color-mix(
    in srgb,
    var(--atlas-editor-foreground) 50%,
    var(--atlas-editor-background)
  ) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  font-family: var(--font-sans) !important;
  font-size: var(--text-xs) !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  :is([data-separator-content], [data-expand-button]):hover {
  color: var(--atlas-editor-foreground) !important;
  background-color: color-mix(
    in srgb,
    var(--atlas-editor-background) 92%,
    var(--atlas-editor-foreground)
  ) !important;
}

[data-diffs-header] [data-header-content],
[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
}

/* File names clip with overflow: hidden for the start ellipsis; a 1em line box
   would cut their descenders. */
[data-diffs-header] :is([data-title], [data-prev-name]) {
  line-height: 16px !important;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: var(--text-xs) !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-additions-count] {
  color: var(--atlas-diff-added-text) !important;
}

[data-diffs-header] [data-deletions-count] {
  color: var(--atlas-diff-removed-text) !important;
}

[data-diffs-header] :is([data-change-icon], [data-rename-icon]) {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  cursor: pointer;
  transition: color 120ms ease;
  font-family: var(--font-sans) !important;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--atlas-editor-foreground) 84%, var(--primary)) !important;
}

/* Find in diff (diff-find.ts): every match a tint, the current one the
   theme's active search fill. A highlight is styled by the tree its text is
   in, so these rules live here, inside the viewer's shadow roots. */
::highlight(atlas-diff-find) {
  background-color: var(--atlas-search-match-background);
}

::highlight(atlas-diff-find-current) {
  background-color: var(--atlas-search-match-active-background);
  color: var(--atlas-editor-foreground);
}

/* Expanding a file mounts its body at once; fade it in. Appearance only: the
   viewer owns geometry, so height cannot animate. */
[data-diff],
[data-file] {
  transition: opacity 200ms ease-out;
}

@starting-style {
  [data-diff],
  [data-file] {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-diff],
  [data-file] {
    transition: none;
  }
}
`;

/** Header and separator heights the stylesheet above paints, given to the
 *  virtualizer so it never has to measure a collapsed item. */
const ITEM_METRICS = {
  diffHeaderHeight: 32,
  hunkSeparatorHeight: 24,
  // The viewer's general spacing is a fallback in some expanded-file paths;
  // anything but zero puts an 8px gap back above the first header.
  spacing: 0,
  paddingTop: 0,
  // The 8px under a file's last line is painted unconditionally by the
  // viewer's own stylesheet, so the metric must count it: at zero, each
  // expanded file's virtual height runs 8px short and the end of the list
  // sits past the reachable scroll range.
  paddingBottom: 8,
} as const;

export type StyledCodeViewOptions<A> = Omit<
  NonNullable<CodeViewProps<A, undefined>["options"]>,
  "unsafeCSS" | "itemMetrics" | "layout" | "theme" | "themeType" | "preferredHighlighter"
>;

type StyledCodeViewProps<A> = (
  | Omit<ControlledCodeViewProps<A, undefined>, "options">
  | Omit<UncontrolledCodeViewProps<A, undefined>, "options">
) & {
  readonly options?: StyledCodeViewOptions<A>;
  readonly viewerRef?: Ref<CodeViewHandle<A, undefined>>;
  /** Appended to {@link DIFF_VIEW_CSS}; same theme-variable rule. */
  readonly extraCSS?: string;
  /** Shown while the worker pool starts. */
  readonly fallback?: ReactNode;
};

/** The appearance the viewer resolves `light-dark()` with. Re-read on every
 *  theme apply; the colours themselves are variables and need no re-read. */
export function useDiffAppearance(): "light" | "dark" {
  useThemeVersion();
  return getActiveTheme()?.appearance ?? "dark";
}

export function StyledCodeView<A = undefined>({
  options,
  viewerRef,
  className,
  extraCSS,
  fallback,
  ...props
}: StyledCodeViewProps<A>) {
  const appearance = useDiffAppearance();
  return (
    <DiffWorkerPoolProvider fallback={fallback}>
      <PoolAwareCodeView<A>
        {...props}
        viewerRef={viewerRef}
        className={className ? `outline-none ${className}` : "outline-none"}
        options={{
          ...options,
          theme: DIFF_THEME_NAMES,
          themeType: appearance,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          unsafeCSS: extraCSS ? `${DIFF_VIEW_CSS}\n${extraCSS}` : DIFF_VIEW_CSS,
          itemMetrics: ITEM_METRICS,
          layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
        }}
      />
    </DiffWorkerPoolProvider>
  );
}

const plainCache = new WeakMap<object, CodeViewItem<unknown>>();

/** As plain text, for when the workers failed: `text` is the one language that
 *  costs the UI thread nothing to "highlight". One copy per item object. */
function asPlainText<A>(item: CodeViewItem<A>): CodeViewItem<A> {
  let plain = plainCache.get(item) as CodeViewItem<A> | undefined;
  if (!plain) {
    plain =
      item.type === "diff"
        ? { ...item, fileDiff: { ...item.fileDiff, lang: "text" } }
        : { ...item, file: { ...item.file, lang: "text" } };
    plainCache.set(item, plain as CodeViewItem<unknown>);
  }
  return plain;
}

function PoolAwareCodeView<A>({
  viewerRef,
  ...props
}: CodeViewProps<A, undefined> & { viewerRef?: Ref<CodeViewHandle<A, undefined>> }) {
  const failed = useDiffPoolFailed();
  const items = props.items;
  const plainItems = useMemo(
    () => (failed && items ? items.map(asPlainText) : items),
    [failed, items],
  );
  const ref = viewerRef ? { ref: viewerRef } : {};
  if (plainItems !== items) {
    const plain = { ...props, items: plainItems } as ControlledCodeViewProps<A, undefined>;
    return <CodeView<A> {...plain} {...ref} />;
  }
  return <CodeView<A> {...props} {...ref} />;
}

export type StyledFileDiffProps<A> = Omit<FileDiffProps<A, undefined>, "options"> & {
  readonly options?: Omit<
    NonNullable<FileDiffProps<A, undefined>["options"]>,
    "unsafeCSS" | "theme" | "themeType" | "preferredHighlighter"
  >;
  /** Appended to {@link DIFF_VIEW_CSS}; same theme-variable rule. */
  readonly extraCSS?: string;
  readonly fallback?: ReactNode;
};

/**
 * One file's diff, not virtualized: for a short excerpt that sits in a page's
 * flow (the pull request Guide's stops) rather than a scrolling list. Styled
 * and pooled exactly as {@link StyledCodeView}.
 */
export function StyledFileDiff<A = undefined>({
  options,
  extraCSS,
  fallback,
  ...props
}: StyledFileDiffProps<A>) {
  const appearance = useDiffAppearance();
  return (
    <DiffWorkerPoolProvider fallback={fallback}>
      <PoolAwareFileDiff<A>
        {...props}
        options={{
          ...options,
          theme: DIFF_THEME_NAMES,
          themeType: appearance,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          unsafeCSS: extraCSS ? `${DIFF_VIEW_CSS}\n${extraCSS}` : DIFF_VIEW_CSS,
        }}
      />
    </DiffWorkerPoolProvider>
  );
}

function PoolAwareFileDiff<A>(props: FileDiffProps<A, undefined>) {
  const failed = useDiffPoolFailed();
  const fileDiff = useMemo(
    () => (failed ? { ...props.fileDiff, lang: "text" as const } : props.fileDiff),
    [failed, props.fileDiff],
  );
  return <FileDiff<A> {...props} fileDiff={fileDiff} />;
}
