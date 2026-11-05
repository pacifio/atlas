import { detectLanguage, PLAINTEXT } from "./language-id";
import { cacheKey, useIconThemeStore } from "../stores/icon-theme-store";
import { MINIMAL_ICON_THEME_ID, type IconKind, type IconRequest } from "./icon-theme-api";
import { safeFontIdent } from "./font-face-css";

/**
 * The active icon theme's icon for a path, as markup, for the places React
 * does not render: HTML built from a string (the transcript's cached markdown,
 * `markdown-render.ts`) and Tiptap node views written against the DOM.
 *
 * Same answers as `<FileIcon>`, from the same store: a path asked for here and
 * shown in the explorer is resolved once. Nothing here fetches per path — a
 * miss registers a want, and the store batches every want of a frame into one
 * `resolve_icons`.
 *
 * Markup is cached per path for the life of a theme, so painting the same
 * file's chip in forty messages builds its string once.
 */

/** An element that wants its path's icon: `data-file-icon` (`file` or
 *  `folder`) and `data-file-path`. Its children are the fallback. */
const SLOT = "[data-file-icon][data-file-path]";

function requestFor(path: string, kind: IconKind): IconRequest {
  const detected = kind === "file" ? detectLanguage(path) : PLAINTEXT;
  return { path, kind, languageId: detected === PLAINTEXT ? undefined : detected };
}

/**
 * An SVG icon as an `<img>` source, or null when it must stay inline.
 *
 * A transcript can hold hundreds of chips. Inline, each icon is a subtree of
 * paths for the browser to style and lay out on every window grow; as an image
 * it is one element, and the browser decodes each distinct icon once. An icon
 * drawn in `currentColor` stays inline, because inside an image that colour is
 * always black and would not follow the theme.
 */
function svgImageSource(svg: string): string | null {
  if (/currentcolor/i.test(svg)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Markup per cache key, for the theme generation it was built under. */
const markup = new Map<string, string>();
let markupGeneration = -1;

/**
 * The icon for `path` as an HTML string, sized to fill its box.
 *
 * - a string: the theme's icon (inline SVG, already sanitised; an `<img>`; or
 *   a font glyph);
 * - `null`: the theme has no icon for it, or no theme is active — keep the
 *   fallback;
 * - `undefined`: not known yet. A want is registered; ask again after the
 *   store changes, or let {@link paintFileIcons} do that.
 */
export function fileIconMarkup(path: string, kind: IconKind = "file"): string | null | undefined {
  const state = useIconThemeStore.getState();
  if (state.themeId === MINIMAL_ICON_THEME_ID) return null;
  if (state.generation !== markupGeneration) {
    markup.clear();
    markupGeneration = state.generation;
  }
  const request = requestFor(path, kind);
  const key = cacheKey(request);
  const hit = markup.get(key);
  if (hit !== undefined) return hit;
  if (!(key in state.resolved)) {
    state.actions.want(request);
    return undefined;
  }
  const icon = state.resolved[key];
  if (!icon) return null;
  let html: string;
  if (icon.kind === "glyph") {
    const span = document.createElement("span");
    span.className = "atlas-file-icon-glyph";
    if (icon.fontId) span.style.fontFamily = safeFontIdent(`atlas-icon-font-${icon.fontId}`);
    if (icon.color) span.style.color = icon.color;
    span.textContent = icon.character;
    html = span.outerHTML;
  } else {
    const prepared = state.prepared[icon.definition];
    if (!prepared) {
      // Settled without an asset (it failed, or sanitising left nothing):
      // keep the fallback, and do not wait for an answer that is not coming.
      if (state.missing[icon.definition]) return null;
      // Resolved, and its asset still in flight.
      return undefined;
    }
    const src = prepared.url ?? (prepared.svg ? svgImageSource(prepared.svg) : null);
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      html = img.outerHTML;
    } else if (prepared.svg) html = prepared.svg;
    else return null;
  }
  markup.set(key, html);
  return html;
}

// ---------------------------------------------------------------------------
// Painting slots in HTML the app did not render through React
// ---------------------------------------------------------------------------

/** What each slot held before a theme icon replaced it: the fallback to go
 *  back to when a later theme has nothing for that path. */
const fallbacks = new WeakMap<Element, string>();
/** What each slot shows now, so a repaint compares strings it already has
 *  instead of serialising the slot's DOM. */
const painted = new WeakMap<Element, string>();
/** Slots still waiting for an answer, by the request they wait on. */
const waiting = new Map<string, { path: string; kind: IconKind; slots: Set<HTMLElement> }>();
let unsubscribe: (() => void) | null = null;

/** Put the answer for one slot in it. Returns false when there is none yet. */
function paintSlot(slot: HTMLElement): boolean {
  const path = slot.dataset.filePath;
  if (!path) return true;
  const kind: IconKind = slot.dataset.fileIcon === "folder" ? "folder" : "file";
  const html = fileIconMarkup(path, kind);
  if (html === undefined) {
    const key = cacheKey(requestFor(path, kind));
    let entry = waiting.get(key);
    if (!entry) {
      entry = { path, kind, slots: new Set() };
      waiting.set(key, entry);
    } else {
      // A streaming tail replaces its HTML on every tick, so the slots the
      // last tick added are detached by now. Drop them here, not only when
      // the store next changes, which may be never.
      for (const old of entry.slots) if (!old.isConnected) entry.slots.delete(old);
    }
    entry.slots.add(slot);
    return false;
  }
  let fallback = fallbacks.get(slot);
  if (fallback === undefined) {
    // First paint: what the slot holds is the glyph it was built with.
    fallback = slot.innerHTML;
    fallbacks.set(slot, fallback);
    painted.set(slot, fallback);
  }
  const next = html ?? fallback;
  // Unchanged markup is not rewritten: a repaint touches no DOM at all.
  if (painted.get(slot) !== next) {
    slot.innerHTML = next;
    painted.set(slot, next);
  }
  slot.dataset.fileIconPainted = html === null ? "fallback" : "theme";
  return true;
}

/** Whether rendered HTML holds slots to paint. A substring test on a string
 *  already in hand, so HTML without chips never has its DOM walked. */
export function hasFileIcons(html: string): boolean {
  return html.includes("data-file-icon");
}

/**
 * Paint the theme's icon into every slot under `root`.
 *
 * Synchronous for every path already resolved, so a remounted message (scroll
 * back, a tab switch) shows its icons in the same frame as its text. The rest
 * keep their fallback glyph and fill in when the store answers. A slot is a
 * box of fixed size, so neither moment moves the text around it.
 */
export function paintFileIcons(root: ParentNode): void {
  listen();
  for (const slot of root.querySelectorAll<HTMLElement>(SLOT)) paintSlot(slot);
}

/**
 * One store subscription for every slot, made on the first paint and kept: it
 * fills in waiting slots as answers land, and repaints every slot on screen
 * when the icon theme, or its light/dark variant, changes. Per store update it
 * costs a generation compare and a walk of what is still waiting.
 */
function listen(): void {
  if (unsubscribe) return;
  let generation = useIconThemeStore.getState().generation;
  unsubscribe = useIconThemeStore.subscribe((state) => {
    if (state.generation !== generation) {
      generation = state.generation;
      // Every slot on screen was painted under the old theme. The ones not
      // mounted now are painted when they mount.
      waiting.clear();
      for (const slot of document.querySelectorAll<HTMLElement>(SLOT)) paintSlot(slot);
      return;
    }
    for (const [key, entry] of waiting) {
      // A message that unmounted while it waited: nothing left to paint.
      for (const slot of entry.slots) if (!slot.isConnected) entry.slots.delete(slot);
      if (entry.slots.size === 0) {
        waiting.delete(key);
        continue;
      }
      if (fileIconMarkup(entry.path, entry.kind) === undefined) continue;
      waiting.delete(key);
      for (const slot of entry.slots) if (slot.isConnected) paintSlot(slot);
    }
  });
}

/** Test seam: how many slots are waiting for an answer. */
export function waitingSlotCountForTests(): number {
  let count = 0;
  for (const entry of waiting.values()) count += entry.slots.size;
  return count;
}

/** Test seam: forget every cached string, waiting slot and the subscription. */
export function resetIconMarkupForTests(): void {
  markup.clear();
  markupGeneration = -1;
  waiting.clear();
  unsubscribe?.();
  unsubscribe = null;
}
