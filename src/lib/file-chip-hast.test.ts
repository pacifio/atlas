// @vitest-environment happy-dom
//
// The shared file-chip pass under each surface's policy: what becomes a chip,
// what it reads, and what it carries. The transcript's own behaviour is pinned
// by `markdown-file-chips.test.ts`; this covers the policies the other
// renderers use.

import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";

import { rehypeFileChips, type FileChipPolicy } from "./file-chip-hast";
import { buildFileLinkParentSuffixByPath, matchChangedFile } from "./workspace-path-match";

const ROOT = "/Users/dev/acme-app";

function render(markdown: string, policy: FileChipPolicy | null): Document {
  const html = String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeFileChips, policy)
      .use(rehypeStringify)
      .processSync(markdown),
  );
  return new DOMParser().parseFromString(html, "text/html");
}

const chips = (doc: Document) =>
  [...doc.querySelectorAll<HTMLElement>(".atlas-file-chip")].map((el) => ({
    label: el.querySelector(".atlas-mention-chip__label")?.textContent,
    suffix: el.querySelector(".atlas-file-chip__suffix")?.textContent ?? null,
    path: el.dataset.filePath,
    written: el.dataset.fileText,
    prFile: el.dataset.prFile ?? null,
    root: el.dataset.fileRoot ?? null,
  }));

const base: FileChipPolicy = { root: ROOT, label: "basename", folders: false };

describe("rehypeFileChips", () => {
  it("draws nothing without a policy", () => {
    expect(chips(render("`src/lib/api.ts`", null))).toEqual([]);
  });

  it("reads as the base name, keeps what was written, and never stamps the root", () => {
    expect(chips(render("`src/lib/api.ts:4`", base))).toEqual([
      {
        label: "api.ts",
        suffix: null,
        path: `${ROOT}/src/lib/api.ts`,
        written: "src/lib/api.ts:4",
        prFile: null,
        root: null,
      },
    ]);
  });

  it("tells two files of the same name apart by their folders", () => {
    const got = chips(render("`src/a/index.ts` and `src/b/index.ts` and `lib/x.ts`", base));
    expect(got.map((c) => [c.label, c.suffix])).toEqual([
      ["index.ts", "src/a"],
      ["index.ts", "src/b"],
      ["x.ts", null],
    ]);
  });

  it("leaves paths outside the root, folders and bundles as they were", () => {
    const doc = render(
      "`/etc/hosts` `../x/y.ts` `src/../../z.ts` [d](docs/) [app](build/Foo.app) `README.md`",
      base,
    );
    expect(chips(doc)).toEqual([]);
    expect(doc.querySelectorAll("code")).toHaveLength(4);
    expect(doc.querySelectorAll("a")).toHaveLength(2);
  });

  it("matches a pull request's changed files by path, tail and a unique bare name", () => {
    const policy: FileChipPolicy = {
      ...base,
      changedFiles: [
        "packages/web/src/lib/api.ts",
        "docs/settings.json",
        "a/index.ts",
        "b/index.ts",
      ],
    };
    const got = chips(
      render("`lib/api.ts` `settings.json` `index.ts` `packages/web/src/lib/api.ts:9`", policy),
    );
    expect(got.map((c) => [c.label, c.prFile, c.path])).toEqual([
      ["api.ts", "packages/web/src/lib/api.ts", `${ROOT}/packages/web/src/lib/api.ts`],
      ["settings.json", "docs/settings.json", `${ROOT}/docs/settings.json`],
      ["api.ts", "packages/web/src/lib/api.ts", `${ROOT}/packages/web/src/lib/api.ts`],
    ]);
  });

  it("resolves a document's relative links from its own folder, inside the root only", () => {
    const policy: FileChipPolicy = { ...base, linkBase: `${ROOT}/docs/guide` };
    const got = chips(
      render("[next](./next.md) [up](../index.md) [out](../../../elsewhere.md)", policy),
    );
    expect(got.map((c) => c.path)).toEqual([`${ROOT}/docs/guide/next.md`, `${ROOT}/docs/index.md`]);
  });

  it("keeps the transcript's form: the text as written, the root stamped", () => {
    const got = chips(render("`src/lib/api.ts`", { root: ROOT, stampRoot: true }));
    expect(got[0]).toMatchObject({ label: "src/lib/api.ts", root: ROOT });
  });
});

describe("matchChangedFile", () => {
  const changed = ["src/a/index.ts", "src/b/index.ts", "docs/settings.json"];

  it("refuses an ambiguous bare name and anything climbing out", () => {
    expect(matchChangedFile("index.ts", changed, ROOT)).toBeNull();
    expect(matchChangedFile("../docs/settings.json", changed, ROOT)).toBeNull();
    expect(matchChangedFile("Settings.JSON", changed, ROOT)).toBe("docs/settings.json");
  });

  it("drops the project's own folder repeated in front", () => {
    expect(matchChangedFile("acme-app/docs/settings.json", changed, ROOT)).toBe(
      "docs/settings.json",
    );
  });
});

describe("buildFileLinkParentSuffixByPath", () => {
  it("names at least two folders, more when two still collide", () => {
    const got = buildFileLinkParentSuffixByPath(["x/a/b/f.ts", "y/a/b/f.ts", "z/c/f.ts", "g.ts"]);
    expect(Object.fromEntries(got)).toEqual({
      "x/a/b/f.ts": "x/a/b",
      "y/a/b/f.ts": "y/a/b",
      "z/c/f.ts": "z/c",
    });
  });
});
