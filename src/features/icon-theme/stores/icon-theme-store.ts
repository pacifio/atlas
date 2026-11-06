import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import {
  getIconThemeAssets,
  getIconThemeFonts,
  listIconThemes,
  MINIMAL_ICON_THEME_ID,
  onIconThemesChanged,
  resolveIcons,
  type IconAppearance,
  type IconAsset,
  type IconFontFace,
  type IconKind,
  type IconRequest,
  type IconThemeSummary,
  type ResolvedIcon,
} from "../lib/icon-theme-api";
import { sanitizeSvg } from "../lib/sanitize-svg";
import { clearIconThemePreviews } from "../lib/icon-preview";

/**
 * The icon theme, as the UI consumes it.
 *
 * Rust owns the theme documents and the precedence rules. This store owns
 * three things Rust cannot: which icons are *on screen*, what has already been
 * fetched, and when to throw all of it away.
 *
 * ## Why it batches
 *
 * A file tree renders 40 virtualised rows at once and asks each one for an
 * icon. Forty `invoke()` calls per scroll tick would be forty IPC round trips
 * against a command runtime shared with the UI channel. So a row does not
 * fetch: it *registers* a want, and one flush per frame turns every want into
 * a single `resolve_icons`, then a single `get_icon_theme_assets` for whatever
 * definitions are new. A row that scrolls past before the flush costs nothing
 * beyond a map entry.
 *
 * ## Why it is lazy
 *
 * Material is 1,251 SVGs, about 1 MB. Nothing here runs at startup, and
 * nothing fetches an icon for a file the user has not looked at (decision 12).
 * The asset cache is keyed by definition id, not by path, so a project of a
 * thousand TypeScript files transfers the TypeScript icon once.
 */

/** A path + kind, as a cache key. Case matters: so does the theme's. */
function cacheKey(request: IconRequest): string {
  // The path goes last so any separator inside it cannot be mistaken for one:
  // `kind` is from a fixed set and a language id is always a bare word.
  return `${request.kind}|${request.languageId ?? ""}|${request.path}`;
}

/** An SVG asset, already sanitised and ready for `dangerouslySetInnerHTML`. */
export interface PreparedIcon {
  /** Inline SVG markup, or `null` for an image asset. */
  svg: string | null;
  /** A `data:` URL for a raster asset, or `null`. */
  url: string | null;
}

interface IconThemeState {
  themes: IconThemeSummary[];
  /**
   * Bumped every time the caches are thrown away.
   *
   * A row registers its want in an effect keyed on its own path, so after a
   * theme switch clears `resolved` nothing would ask again: every mounted icon
   * would sit on its lucide fallback until it happened to unmount. This is the
   * one piece of state that changes for *every* row when the theme does, so
   * the effect depends on it and the whole screen re-asks at once.
   */
  generation: number;
  /** The active theme's id. `minimal` means "use Atlas's own icons". */
  themeId: string;
  appearance: IconAppearance;
  /** Whether the active theme wants the explorer's chevrons hidden. */
  hidesExplorerArrows: boolean;
  /** Resolution results, keyed by path+kind. `null` = the theme has nothing. */
  resolved: Record<string, ResolvedIcon | null>;
  /** Asset bytes, keyed by definition id. Shared across every path using it. */
  prepared: Record<string, PreparedIcon>;
  /**
   * Definitions whose asset will never arrive under this theme: it failed to
   * load, came back absent, or `sanitizeSvg` stripped it to nothing. Without
   * this a caller could not tell "still in flight" from "never", and would
   * wait forever (`icon-markup.ts`). Callers keep their fallback.
   */
  missing: Record<string, true>;
  /** Font faces, fetched only once a glyph icon has actually been resolved. */
  fonts: IconFontFace[];
  loading: boolean;
  error: string | null;
  actions: {
    /** Load the catalog. Safe to call repeatedly. */
    load: () => Promise<void>;
    /** Switch themes and drop every cached resolution and asset. */
    setTheme: (themeId: string, appearance: IconAppearance) => void;
    /** Register a want. Resolved on the next flush; returns nothing. */
    want: (request: IconRequest) => void;
  };
}

/** Everything that was true only of the previous theme. */
function emptyCaches(): Pick<IconThemeState, "resolved" | "prepared" | "missing" | "fonts"> {
  return { resolved: {}, prepared: {}, missing: {}, fonts: [] };
}

let generation = 0;
function nextGeneration(): number {
  generation += 1;
  return generation;
}

const baseStore = create<IconThemeState>()((set, get) => ({
  themes: [],
  generation: 0,
  // Nothing is assumed before `setTheme` runs: an unconfigured app draws its
  // own icons rather than briefly drawing the wrong theme's.
  themeId: MINIMAL_ICON_THEME_ID,
  appearance: "dark",
  hidesExplorerArrows: false,
  ...emptyCaches(),
  loading: false,
  error: null,
  actions: {
    load: async () => {
      set({ loading: true, error: null });
      try {
        const themes = await listIconThemes();
        set((state) => ({
          themes,
          loading: false,
          hidesExplorerArrows:
            themes.find((theme) => theme.id === state.themeId)?.hidesExplorerArrows ?? false,
        }));
      } catch (error) {
        // A catalog that will not load is not a reason to have no icons: the
        // resolver still answers for whatever `themeId` says, and a theme that
        // is gone answers with a rejected promise the row already tolerates.
        set({ loading: false, error: String(error) });
      }
    },

    setTheme: (themeId, appearance) => {
      const current = get();
      if (current.themeId === themeId && current.appearance === appearance) return;
      // Everything cached was resolved against the old theme, so it all goes.
      // This is what makes a theme switch repaint live rather than on reload.
      pending.clear();
      set({
        themeId,
        appearance,
        generation: nextGeneration(),
        ...emptyCaches(),
        hidesExplorerArrows:
          current.themes.find((theme) => theme.id === themeId)?.hidesExplorerArrows ?? false,
      });
    },

    want: (request) => {
      if (get().themeId === MINIMAL_ICON_THEME_ID) return;
      const key = cacheKey(request);
      if (key in get().resolved || pending.has(key)) return;
      pending.set(key, request);
      schedule();
    },
  },
}));

export const useIconThemeStore = createSelectors(baseStore);

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

const pending = new Map<string, IconRequest>();
let scheduled = false;

/**
 * Flush on a macrotask rather than a microtask.
 *
 * React runs every row's effect in one commit; a microtask would fire between
 * two of them and split the batch. A zero-delay timeout lands after the whole
 * commit, so one render of a 40-row tree is one `resolve_icons`.
 */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void flush();
  }, 0);
}

async function flush(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  const { themeId, appearance, generation: at } = baseStore.getState();
  if (themeId === MINIMAL_ICON_THEME_ID) return;

  let answers: (ResolvedIcon | null)[];
  try {
    answers = await resolveIcons(
      themeId,
      appearance,
      batch.map(([, request]) => request),
    );
  } catch (error) {
    console.warn("Icon resolution failed", error);
    return;
  }
  // The theme may have changed while the call was in flight; its caches were
  // cleared, and writing a stale answer into them would paint the old theme's
  // icons under the new theme's name. The id alone is not enough: an
  // appearance switch, or an install that rewrote the active theme's files,
  // keeps the id and empties the caches all the same — the generation is what
  // says "these caches are the ones this answer was for".
  if (isStale(themeId, at)) return;

  const resolved: Record<string, ResolvedIcon | null> = {};
  batch.forEach(([key], index) => {
    resolved[key] = answers[index] ?? null;
  });
  // Written into the existing cache, not spread into a copy. The cache is
  // keyed by path and only grows: scrolling a 50,000-file tree fills it with
  // tens of thousands of keys, and copying all of them for every batch (one
  // per rendered frame while scrolling) made each frame's cost grow with
  // everything ever shown. Rows select `resolved[key]`, a value, so a fresh
  // top-level state is all they need to see the new answers; nothing reads
  // the record's identity. `emptyCaches()` still swaps in a new one on a
  // theme change.
  baseStore.setState((state) => ({ resolved: Object.assign(state.resolved, resolved) }));

  const state = baseStore.getState();
  const wantedImages = new Set<string>();
  let sawGlyph = false;
  for (const answer of answers) {
    if (!answer) continue;
    if (answer.kind === "glyph") {
      sawGlyph = true;
      continue;
    }
    if (!(answer.definition in state.prepared)) wantedImages.add(answer.definition);
  }

  if (sawGlyph && state.fonts.length === 0) {
    void loadFonts(themeId, at);
  }
  if (wantedImages.size > 0) {
    void loadAssets(themeId, at, [...wantedImages]);
  }
}

/** Whether the caches have been thrown away since a request against `themeId`
 *  at generation `at` started. See `flush`. */
function isStale(themeId: string, at: number): boolean {
  const state = baseStore.getState();
  return state.themeId !== themeId || state.generation !== at;
}

async function loadAssets(themeId: string, at: number, definitions: string[]): Promise<void> {
  let assets: Record<string, IconAsset>;
  try {
    assets = await getIconThemeAssets(themeId, definitions);
  } catch (error) {
    console.warn("Icon assets failed to load", error);
    markMissing(themeId, at, definitions);
    return;
  }
  if (isStale(themeId, at)) return;
  const prepared: Record<string, PreparedIcon> = {};
  for (const [definition, asset] of Object.entries(assets)) {
    if (asset.kind === "svg") {
      const svg = sanitizeSvg(asset.source);
      // An unparseable or entirely-stripped icon is simply not cached, so the
      // row keeps its lucide fallback instead of rendering an empty box.
      if (svg) prepared[definition] = { svg, url: null };
    } else {
      prepared[definition] = { svg: null, url: asset.url };
    }
  }
  markMissing(
    themeId,
    at,
    definitions.filter((d) => !(d in prepared)),
  );
  if (Object.keys(prepared).length === 0) return;
  baseStore.setState((state) => ({ prepared: { ...state.prepared, ...prepared } }));
}

/** Record that `definitions` will not arrive under this theme generation. */
function markMissing(themeId: string, at: number, definitions: string[]): void {
  if (definitions.length === 0 || isStale(themeId, at)) return;
  const missing: Record<string, true> = {};
  for (const definition of definitions) missing[definition] = true;
  baseStore.setState((state) => ({ missing: { ...state.missing, ...missing } }));
}

async function loadFonts(themeId: string, at: number): Promise<void> {
  try {
    const fonts = await getIconThemeFonts(themeId);
    if (isStale(themeId, at)) return;
    if (fonts.length > 0) baseStore.setState({ fonts });
  } catch (error) {
    console.warn("Icon theme fonts failed to load", error);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let listening = false;

/** Start listening for installs and removals. Idempotent. */
export function startIconThemeCatalogListener(): void {
  if (listening) return;
  listening = true;
  void onIconThemesChanged(() => {
    // An install or a removal can change the *active* theme's files, so the
    // caches go as well as the catalog — including the picker's per-theme
    // preview cache, which is the only one keyed by a theme that is not this
    // one and would otherwise show a removed theme's icons.
    clearIconThemePreviews();
    pending.clear();
    baseStore.setState({ ...emptyCaches(), generation: nextGeneration() });
    void baseStore.getState().actions.load();
  }).catch((error) => {
    listening = false;
    console.warn("Icon theme listener failed", error);
  });
}

/**
 * Apply the persisted icon theme. Called from the settings side effects, the
 * same way `applyConfiguredTheme` is.
 */
export function applyConfiguredIconTheme(themeId: string, appearance: IconAppearance): void {
  startIconThemeCatalogListener();
  baseStore.getState().actions.setTheme(themeId, appearance);
  void baseStore.getState().actions.load();
}

/** Read one icon out of the cache, registering a want when it is missing. */
export function selectIcon(
  state: IconThemeState,
  path: string,
  kind: IconKind,
  languageId?: string,
): ResolvedIcon | null | undefined {
  return state.resolved[cacheKey({ path, kind, languageId })];
}

export { cacheKey };
export type { IconThemeState };
