// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  EXTENSION_LANGUAGE,
  isHighlightable,
  LANGUAGE_IDS,
  loadLanguageExtension,
  PLAINTEXT,
  type EditorLanguage,
} from "./languages";

/**
 * The bug these tests exist for: a file extension mapped to a language id that
 * had no CodeMirror loader, so the editor claimed to know the language and
 * rendered it as flat text (issue #75).
 *
 * `EXTENSION_LANGUAGE`'s type already makes that unrepresentable, but the type
 * only covers the *table*. These cover the other half — that every id actually
 * resolves to a real grammar at runtime, which no type can assert because the
 * loaders are dynamic imports.
 *
 * happy-dom: `@codemirror/lang-*` pulls in `@codemirror/view` transitively,
 * which touches `document` at import time.
 */

/** A loaded language extension is a non-empty CodeMirror `Extension`. */
function isRealExtension(ext: unknown): boolean {
  return Array.isArray(ext) ? ext.length > 0 : ext !== null && ext !== undefined;
}

describe("language registry", () => {
  describe("extension table", () => {
    it.each(Object.entries(EXTENSION_LANGUAGE))(
      "maps .%s to a language that is either loadable or explicitly plaintext",
      (_ext, language) => {
        expect(language === PLAINTEXT || LANGUAGE_IDS.includes(language)).toBe(true);
      },
    );

    it("has no entry whose language id lacks a loader", () => {
      const orphans = Object.entries(EXTENSION_LANGUAGE).filter(
        ([, language]) => language !== PLAINTEXT && !LANGUAGE_IDS.includes(language),
      );
      expect(orphans).toEqual([]);
    });

    it("never lists an extension as plaintext when a grammar also claims it", () => {
      // `EXTENSION_LANGUAGE` spreads the plaintext set first so an explicit
      // entry wins. This is the assertion that keeps that ordering honest: a
      // language gaining a real loader must not be shadowed by its old
      // plaintext entry, in either direction.
      const plaintextExts = Object.entries(EXTENSION_LANGUAGE)
        .filter(([, language]) => language === PLAINTEXT)
        .map(([ext]) => ext);
      const grammarExts = Object.entries(EXTENSION_LANGUAGE)
        .filter(([, language]) => language !== PLAINTEXT)
        .map(([ext]) => ext);
      expect(plaintextExts.filter((ext) => grammarExts.includes(ext))).toEqual([]);
    });

    it("keys are bare, lowercase extensions — `detectLanguage` looks them up that way", () => {
      for (const ext of Object.keys(EXTENSION_LANGUAGE)) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext.startsWith(".")).toBe(false);
      }
    });
  });

  describe("loaders", () => {
    // The real assertion of the issue: every advertised language parses.
    it.each(LANGUAGE_IDS)("%s resolves to a real CodeMirror extension", async (id) => {
      expect(isRealExtension(await loadLanguageExtension(id))).toBe(true);
    });

    it("plaintext resolves to an empty extension rather than throwing", async () => {
      expect(await loadLanguageExtension(PLAINTEXT)).toEqual([]);
    });

    it("every language id is reachable from at least one file extension", () => {
      const reachable = new Set<EditorLanguage>(Object.values(EXTENSION_LANGUAGE));
      expect(LANGUAGE_IDS.filter((id) => !reachable.has(id))).toEqual([]);
    });
  });

  describe("detectLanguage", () => {
    it.each([
      ["/repo/src/main.ts", "typescript"],
      ["/repo/src/app.tsx", "typescript"],
      ["/repo/src/index.mjs", "javascript"],
      ["/repo/src/lib.rs", "rust"],
      ["/repo/main.go", "go"],
      ["/repo/setup.py", "python"],
      ["/repo/package.json", "json"],
      ["/repo/.github/workflows/ci.yml", "yaml"],
      ["/repo/README.md", "markdown"],
      ["/repo/styles/app.scss", "scss"],
      ["/repo/icons/logo.svg", "xml"],
    ] as const)("detects %s as %s", (path, expected) => {
      expect(detectLanguage(path)).toBe(expected);
    });

    it.each([
      ["an unknown extension", "/repo/notes.wat"],
      ["no extension at all", "/repo/Makefile"],
      ["a dotfile, whose name is not an extension", "/repo/.env"],
      ["an untitled scratch buffer", "untitled:1717171717"],
      ["an empty path", ""],
    ])("degrades to plaintext for %s", (_label, path) => {
      expect(detectLanguage(path)).toBe(PLAINTEXT);
    });

    it.each(["/repo/deploy.sh", "/repo/Gemfile.rb", "/repo/Cargo.toml", "/repo/App.swift"])(
      "degrades %s to plaintext explicitly, not by omission",
      (path) => {
        expect(detectLanguage(path)).toBe(PLAINTEXT);
        // The distinction that matters: the extension is *listed* as plaintext,
        // so nobody later assumes it was simply forgotten.
        expect(EXTENSION_LANGUAGE[path.split(".").pop()!]).toBe(PLAINTEXT);
      },
    );

    it("is case-insensitive — macOS paths arrive in whatever case the user typed", () => {
      expect(detectLanguage("/repo/README.MD")).toBe("markdown");
      expect(detectLanguage("/repo/Component.TSX")).toBe("typescript");
    });

    it("reads the basename, so a dotted directory is not an extension", () => {
      expect(detectLanguage("/repo/v1.2/Makefile")).toBe(PLAINTEXT);
      expect(detectLanguage("/repo/v1.2/main.rs")).toBe("rust");
    });

    it("takes the last extension of a compound name", () => {
      expect(detectLanguage("/repo/types/global.d.ts")).toBe("typescript");
    });
  });

  describe("isHighlightable", () => {
    it("is true for a parseable language and false for plaintext", () => {
      expect(isHighlightable("typescript")).toBe(true);
      expect(isHighlightable(PLAINTEXT)).toBe(false);
    });
  });
});
