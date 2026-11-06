/**
 * Which files the file view can also show rendered, the toggle's wording, and
 * the remembered choice of source or rendered for each kind.
 */

import { textFingerprint } from "@/features/git/lib/diff-rendering";
import { filePreviewDelimiter } from "./delimited-preview";

export type RenderedMode = "markdown" | "table" | "html";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export const isHtmlPreviewFile = (path: string): boolean => /\.html?$/i.test(path);

/** What `path` can be rendered as, or null when it is source only. */
export function renderedModeOf(path: string): RenderedMode | null {
  if (isMarkdownPreviewFile(path)) return "markdown";
  if (filePreviewDelimiter({ name: path })) return "table";
  if (isHtmlPreviewFile(path)) return "html";
  return null;
}

export function renderedToggleLabel(mode: RenderedMode, rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

/** Markdown opens as source (it is mostly edited); a table and a page open rendered. */
const RENDERED_BY_DEFAULT: Record<RenderedMode, boolean> = {
  markdown: false,
  table: true,
  html: true,
};

const storageKey = (mode: RenderedMode) => `atlas.fileView.rendered.${mode}`;

/** The remembered choice, or the kind's default. Storage can throw (private
 *  windows, blocked site data); the default stands in then. */
export function readRenderedPreference(mode: RenderedMode): boolean {
  try {
    const stored = localStorage.getItem(storageKey(mode));
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    /* fall through to the default */
  }
  return RENDERED_BY_DEFAULT[mode];
}

export function writeRenderedPreference(mode: RenderedMode, rendered: boolean): void {
  try {
    localStorage.setItem(storageKey(mode), String(rendered));
  } catch {
    /* a preference that cannot be kept is still applied for this session */
  }
}

/** The highlight-cache identity of one version of a file. */
export function fileCacheKey(path: string, contents: string): string {
  return `file-view:${path}:${textFingerprint(contents)}`;
}
