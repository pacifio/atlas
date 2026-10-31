import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getSharedHighlighter,
  renderFileWithHighlighter,
  type DiffsHighlighter,
  type FileContents,
  type RenderFileOptions,
  type ThemedFileResult,
} from "@pierre/diffs";
import { DIFF_THEME_NAMES, ensureDiffTheme } from "./diff-theme";
import {
  FIRST_SCREEN_MAX_LINE,
  FIRST_SCREEN_MIN_LINES,
  colourFirstScreen,
  hasFirstScreenCache,
  missingFirstScreenGrammar,
  releaseFirstScreenCache,
  resetFirstScreenCache,
} from "./first-screen-highlight";

const OPTIONS: RenderFileOptions = {
  theme: DIFF_THEME_NAMES,
  useTokenTransformer: true,
  tokenizeMaxLineLength: 1_000,
};

function source(lines: number, ext = "ts"): FileContents {
  const body = Array.from({ length: lines }, (_, i) =>
    // A block comment over two lines: the second reads as comment only
    // because of the line above it.
    i % 7 === 0
      ? `/* block ${i}`
      : i % 7 === 1
        ? `   still a comment */`
        : `export const item${i} = { id: "sku-${i}", price: ${i} } as const; // note`,
  ).join("\n");
  return { name: `catalog.${ext}`, contents: body, cacheKey: `catalog-${lines}-${ext}` };
}

/** The plain render the pool gives the renderer for a window. */
function plainWindow(
  highlighter: DiffsHighlighter,
  file: FileContents,
  startingLine: number,
  totalLines: number,
): ThemedFileResult {
  return renderFileWithHighlighter(file, highlighter, OPTIONS, {
    forcePlainText: true,
    startingLine,
    totalLines,
  });
}

let highlighter: DiffsHighlighter;

beforeAll(async () => {
  ensureDiffTheme();
  highlighter = await getSharedHighlighter({
    themes: [DIFF_THEME_NAMES.light, DIFF_THEME_NAMES.dark],
    langs: ["text"],
    preferredHighlighter: "shiki-js",
  });
});

beforeEach(() => resetFirstScreenCache());

describe("missingFirstScreenGrammar", () => {
  it("names the grammar a long file lacks, and nothing for short or plain files", () => {
    expect(missingFirstScreenGrammar(source(FIRST_SCREEN_MIN_LINES, "py"))).toBe("python");
    expect(missingFirstScreenGrammar(source(FIRST_SCREEN_MIN_LINES - 10, "py"))).toBeNull();
    expect(missingFirstScreenGrammar(source(FIRST_SCREEN_MIN_LINES, "txt"))).toBeNull();
  });
});

describe("colourFirstScreen", () => {
  it("leaves a long file plain until its grammar is loaded", () => {
    const file = source(FIRST_SCREEN_MIN_LINES, "py");
    expect(
      colourFirstScreen(file, plainWindow(highlighter, file, 0, 100), 0, 100, undefined, OPTIONS),
    ).toBeNull();
  });

  describe("with the grammar loaded", () => {
    beforeAll(async () => {
      await getSharedHighlighter({
        themes: [DIFF_THEME_NAMES.light, DIFF_THEME_NAMES.dark],
        langs: ["text", "typescript"],
        preferredHighlighter: "shiki-js",
      });
    });

    it("colours the window's rows exactly as the whole file's highlight does", () => {
      const file = source(FIRST_SCREEN_MIN_LINES * 2);
      const whole = renderFileWithHighlighter(file, highlighter, OPTIONS);
      const plain = plainWindow(highlighter, file, 40, 120);
      const coloured = colourFirstScreen(file, plain, 40, 120, undefined, OPTIONS);
      expect(coloured).not.toBeNull();
      expect(coloured!.code.length).toBe(plain.code.length);
      for (let line = 40; line < 160; line++)
        expect(coloured!.code[line]).toEqual(whole.code[line]);
      // Block comments open above the window: the rows inside one still read as comment.
      expect(JSON.stringify(coloured!.code[50])).toContain("syntax-comment");
      expect(coloured!.themeStyles).toBe(plain.themeStyles);
    });

    it("lets go of a file's cached head when its view releases it, and only its", () => {
      const file = source(FIRST_SCREEN_MIN_LINES);
      colourFirstScreen(file, plainWindow(highlighter, file, 0, 50), 0, 50, undefined, OPTIONS);
      expect(hasFirstScreenCache()).toBe(true);

      releaseFirstScreenCache("some-other-file");
      expect(hasFirstScreenCache()).toBe(true);
      releaseFirstScreenCache(file.cacheKey);
      expect(hasFirstScreenCache()).toBe(false);
    });

    it("leaves short files, plain files and windows past the head alone", () => {
      const short = source(FIRST_SCREEN_MIN_LINES - 1);
      expect(
        colourFirstScreen(
          short,
          plainWindow(highlighter, short, 0, 100),
          0,
          100,
          undefined,
          OPTIONS,
        ),
      ).toBeNull();

      const text = source(FIRST_SCREEN_MIN_LINES, "txt");
      expect(
        colourFirstScreen(text, plainWindow(highlighter, text, 0, 100), 0, 100, undefined, OPTIONS),
      ).toBeNull();

      const deep = source(FIRST_SCREEN_MIN_LINES);
      const start = FIRST_SCREEN_MAX_LINE - 50;
      expect(
        colourFirstScreen(
          deep,
          plainWindow(highlighter, deep, start, 100),
          start,
          100,
          undefined,
          OPTIONS,
        ),
      ).toBeNull();
    });

    it("uses the renderer's line cache when it is given one", () => {
      const file = source(FIRST_SCREEN_MIN_LINES);
      const lines = file.contents.split(/(?<=\n)/);
      const whole = renderFileWithHighlighter(file, highlighter, OPTIONS);
      const coloured = colourFirstScreen(
        file,
        plainWindow(highlighter, file, 0, 80),
        0,
        80,
        lines,
        OPTIONS,
      );
      for (let line = 0; line < 80; line++) expect(coloured!.code[line]).toEqual(whole.code[line]);
    });
  });
});
