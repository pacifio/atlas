import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  areFileRenderOptionsEqual,
  areLanguagesAttached,
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
  getSharedHighlighter,
  renderFileWithHighlighter,
  type DiffsThemeNames,
  type FileContents,
  type HighlighterTypes,
  type RenderFileOptions,
  type SupportedLanguages,
  type ThemedFileResult,
  type ThemesType,
} from "@pierre/diffs";

/**
 * The top of a long file coloured on the main thread, so its first screen
 * isn't plain while the workers tokenize the whole file.
 *
 * Until the workers' highlight lands, the renderer asks the pool for a plain
 * render of the rows in its window (`getPlainFileAST`). For a window near the
 * top of a long file, this swaps those rows for highlighted ones. It tokenizes
 * from line 1 to the window's end with the shared highlighter, the pool's
 * render options and the file's own grammar. A TextMate line's tokens depend
 * only on the lines before it, so the rows match the workers' exactly. When
 * the workers' result replaces them, nothing changes colour.
 *
 * It colours nothing when that wouldn't pay:
 * - a short file, whose workers answer quickly enough;
 * - a window that ends past `FIRST_SCREEN_MAX_LINE`: a jump deep into the
 *   file would mean tokenizing everything above it here;
 * - a grammar the main thread hasn't loaded yet. The file view loads it and
 *   draws the window again once it lands (`missingFirstScreenGrammar`).
 */

/** Below this many lines nothing here runs. The workers take about 60 ms per
 *  thousand lines, so a shorter file shows plain for a few frames at most. */
export const FIRST_SCREEN_MIN_LINES = 1_500;
/** Lines past this are left to the workers: tokenizing to them here would cost
 *  more than a frame. */
export const FIRST_SCREEN_MAX_LINE = 400;

type Lines = readonly string[];

interface HeadCache {
  cacheKey: string | undefined;
  contents: string;
  lineCount: number;
  /** Highlighted rows for lines `[0, code.length)`. */
  code: ThemedFileResult["code"];
  options: RenderFileOptions | null;
}

let cache: HeadCache | null = null;

function lineCountOf(file: FileContents, lines: Lines | undefined): number {
  if (lines) return lines.length;
  if (cache && cache.contents === file.contents) return cache.lineCount;
  let count = 1;
  for (let i = file.contents.indexOf("\n"); i !== -1; i = file.contents.indexOf("\n", i + 1)) {
    count += 1;
  }
  return count;
}

/** The text of the first `count` lines, line breaks included. */
function headText(file: FileContents, lines: Lines | undefined, count: number): string {
  if (lines) return lines.slice(0, count).join("");
  let end = 0;
  for (let n = 0; n < count; n++) {
    const next = file.contents.indexOf("\n", end);
    if (next === -1) return file.contents;
    end = next + 1;
  }
  return file.contents.slice(0, end);
}

/**
 * `plain` with the rows of `[startingLine, startingLine + totalLines)` that
 * fall in the file's first `FIRST_SCREEN_MAX_LINE` lines highlighted, or
 * `null` to keep `plain` as it is.
 */
export function colourFirstScreen(
  file: FileContents,
  plain: ThemedFileResult,
  startingLine: number,
  totalLines: number,
  lines: Lines | undefined,
  options: RenderFileOptions,
): ThemedFileResult | null {
  const lang = (file.lang ?? getFiletypeFromFileName(file.name)) as SupportedLanguages;
  if (lang === "text" || lang === "ansi") return null;
  const lineCount = lineCountOf(file, lines);
  if (lineCount < FIRST_SCREEN_MIN_LINES || lineCount > DEFAULT_TOKENIZE_MAX_LENGTH) return null;
  const end = Math.min(startingLine + totalLines, lineCount);
  if (end > FIRST_SCREEN_MAX_LINE || end <= startingLine) return null;
  if (!areLanguagesAttached(lang)) return null;
  const highlighter = getHighlighterIfLoaded();
  if (!highlighter) return null;

  if (
    !cache ||
    cache.cacheKey !== file.cacheKey ||
    cache.contents !== file.contents ||
    !cache.options ||
    !areFileRenderOptionsEqual(cache.options, options) ||
    cache.code.length < end
  ) {
    // Only to the window's end: tokenizing costs about 0.1 ms a line, so the
    // whole head would put tens of milliseconds in front of the first paint.
    // A window further down, before the workers land, tokenizes again.
    const count = end;
    const head = renderFileWithHighlighter(
      { ...file, contents: headText(file, lines, count), cacheKey: undefined },
      highlighter,
      options,
    );
    cache = {
      cacheKey: file.cacheKey,
      contents: file.contents,
      lineCount,
      // The head's last line break makes Shiki add an empty row past it.
      code: head.code.slice(0, count),
      options,
    };
  }

  const code = plain.code.slice();
  for (let line = startingLine; line < end; line++) {
    const row = cache.code[line];
    if (row !== undefined) code[line] = row;
  }
  return { ...plain, code };
}

/**
 * The grammar a long file needs on the main thread for its first screen, when
 * that thread hasn't loaded it yet; `null` when it has, or when the file is
 * short or plain. The file view loads it before its first render
 * (`loadFirstScreenGrammar`), since the plain rows already drawn are never
 * asked for again.
 */
export function missingFirstScreenGrammar(file: FileContents): SupportedLanguages | null {
  const lang = (file.lang ?? getFiletypeFromFileName(file.name)) as SupportedLanguages;
  if (lang === "text" || lang === "ansi" || areLanguagesAttached(lang)) return null;
  const lineCount = lineCountOf(file, undefined);
  if (lineCount < FIRST_SCREEN_MIN_LINES || lineCount > DEFAULT_TOKENIZE_MAX_LENGTH) return null;
  return lang;
}

/** Load `lang` into the shared highlighter, with the theme(s) the pool renders in. */
export function loadFirstScreenGrammar(
  lang: SupportedLanguages,
  theme: DiffsThemeNames | ThemesType,
  preferredHighlighter: HighlighterTypes,
): Promise<unknown> {
  const themes = typeof theme === "string" ? [theme] : [theme.light, theme.dark];
  return getSharedHighlighter({ themes, langs: ["text", lang], preferredHighlighter });
}

/**
 * Forget the cached head when it belongs to the file version `cacheKey`. The
 * cache keeps that version's whole text alive, so a view calls this when it
 * lets the version go (its tab closed, or the document replaced). Another
 * file's head is left alone.
 */
export function releaseFirstScreenCache(cacheKey: string | undefined): void {
  if (cache && cacheKey !== undefined && cache.cacheKey === cacheKey) cache = null;
}

/** Whether a head is cached (tests). */
export function hasFirstScreenCache(): boolean {
  return cache !== null;
}

/** Forget the cached head (tests). */
export function resetFirstScreenCache(): void {
  cache = null;
}
