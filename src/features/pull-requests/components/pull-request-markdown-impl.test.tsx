// @vitest-environment happy-dom
//
// A pull request's markdown: parsed once per text, file names drawn as chips
// that open the Code tab or Atlas's viewer, and — since anyone who can open a
// pull request writes this text — no chip, and no click, that reaches past the
// checkout or out of Atlas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const opener = vi.hoisted(() => ({
  openUrl: vi.fn(async () => {}),
  openPath: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => opener);
const openOutsideFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/external-editor/lib/preferred-editor", () => ({ openOutsideFile }));
const openInProject = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/explorer/lib/open-in-project", () => ({ openInProject }));
vi.mock("@/features/file-picker/lib/file-picker-api", () => ({
  fileIndex: { search: vi.fn(async () => []) },
}));
const { split } = vi.hoisted(() => ({ split: vi.fn() }));
vi.mock("../lib/pull-request-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/pull-request-markdown")>();
  split.mockImplementation(actual.splitPullRequestBody);
  return { ...actual, splitPullRequestBody: split };
});

import { changedFilesKey } from "../lib/pull-request-changed-files";
import {
  resetPullRequestCodeRequestsForTests,
  usePullRequestCodeRequests,
} from "../lib/pull-request-code-request";
import { PullRequestScopeContext, type PullRequestScope } from "./pull-request-context";
import PullRequestMarkdownImpl from "./pull-request-markdown-impl";

const ROOT = "/Users/dev/acme-app";
const CHANGED = [
  "crates/atlas-settings/src/settings_docs.gen.rs",
  "src/features/settings/lib/settings-registry.gen.ts",
  "docs/settings.json",
  "docs/reference/configuration.md",
];

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "pr_list_stats"
      ? [
          {
            number: 1,
            additions: 1,
            deletions: 1,
            files: CHANGED.map((path) => ({ path, additions: 1, deletions: 0 })),
            filesTruncated: false,
          },
        ]
      : null,
  );
});

afterEach(() => {
  cleanup();
  split.mockClear();
  vi.clearAllMocks();
  resetPullRequestCodeRequestsForTests();
});

const scope = (pending: string | null = null): PullRequestScope => ({
  repoPath: ROOT,
  number: 1,
  repositoryUrl: "https://github.com/acme/shop",
  agent: { fixFinding: null, pending },
});

function tree(value: PullRequestScope, text: string) {
  return (
    <QueryClientProvider client={client}>
      <PullRequestScopeContext.Provider value={value}>
        <PullRequestMarkdownImpl text={text} />
      </PullRequestScopeContext.Provider>
    </QueryClientProvider>
  );
}

const chips = (root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>(".atlas-file-chip")].map((el) => ({
    label: el.querySelector(".atlas-mention-chip__label")?.textContent ?? "",
    path: el.dataset.filePath ?? null,
    prFile: el.dataset.prFile ?? null,
  }));

const chipNamed = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".atlas-file-chip")].find(
    (el) => el.querySelector(".atlas-mention-chip__label")?.textContent === label,
  )!;

/** Nothing anywhere handed a path to the system, the file manager or an editor. */
function expectNothingLeftAtlas() {
  expect(opener.openUrl).not.toHaveBeenCalled();
  expect(opener.openPath).not.toHaveBeenCalled();
  expect(opener.revealItemInDir).not.toHaveBeenCalled();
  expect(openOutsideFile).not.toHaveBeenCalled();
}

describe("PullRequestMarkdownImpl", () => {
  it("parses a body once while only the scope around it changes", () => {
    client.setQueryData(changedFilesKey(ROOT, 1), [
      { number: 1, additions: 0, deletions: 0, files: [], filesTruncated: false },
    ]);
    const { rerender } = render(tree(scope(null), "Some **bold** text"));
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(split).toHaveBeenCalledTimes(1);

    // A new scope object: an agent action started, the panel re-rendered.
    rerender(tree(scope("explain"), "Some **bold** text"));
    rerender(tree(scope(null), "Some **bold** text"));
    expect(split).toHaveBeenCalledTimes(1);

    rerender(tree(scope(null), "Other text"));
    expect(split).toHaveBeenCalledTimes(2);
  });

  it("parses once more when the changed files land, and not again", async () => {
    const { rerender } = render(tree(scope(), "`docs/settings.json`"));
    await waitFor(() => expect(chips()[0]?.prFile).toBe("docs/settings.json"));
    expect(split).toHaveBeenCalledTimes(2);
    rerender(tree(scope("explain"), "`docs/settings.json`"));
    expect(split).toHaveBeenCalledTimes(2);
  });
});

describe("file chips in a pull request", () => {
  const body = [
    "| Output | What it is |",
    "| --- | --- |",
    "| `crates/atlas-settings/src/settings_docs.gen.rs` | the docs |",
    "| `src/features/settings/lib/settings-registry.gen.ts` | the registry |",
    "| `settings.json` | the docs site |",
    "| `docs/reference/configuration.md:12` | the table |",
    "",
    "Also `src/lib/api.ts`, and `config.toml` is not one of the changed files.",
  ].join("\n");

  it("draws a file name as a chip with its base name, matched to the changed file", async () => {
    render(tree(scope(), body));
    await waitFor(() => expect(chips()).toHaveLength(5));
    expect(chips()).toEqual([
      {
        label: "settings_docs.gen.rs",
        path: `${ROOT}/crates/atlas-settings/src/settings_docs.gen.rs`,
        prFile: "crates/atlas-settings/src/settings_docs.gen.rs",
      },
      {
        label: "settings-registry.gen.ts",
        path: `${ROOT}/src/features/settings/lib/settings-registry.gen.ts`,
        prFile: "src/features/settings/lib/settings-registry.gen.ts",
      },
      // A bare name, matched because exactly one changed file has it.
      { label: "settings.json", path: `${ROOT}/docs/settings.json`, prFile: "docs/settings.json" },
      {
        label: "configuration.md",
        path: `${ROOT}/docs/reference/configuration.md`,
        prFile: "docs/reference/configuration.md",
      },
      // In the checkout but not changed: the viewer, not the Code tab.
      { label: "api.ts", path: `${ROOT}/src/lib/api.ts`, prFile: null },
    ]);
    // A bare name no changed file has stays code.
    expect(screen.getByText("config.toml").tagName).toBe("CODE");
    // The icon slot is there for the icon theme to paint.
    expect(document.querySelectorAll("[data-file-icon]")).toHaveLength(5);
  });

  it("opens a changed file in the Code tab when the panel has claimed the pull request", async () => {
    const asks: unknown[] = [];
    function Panel() {
      const { request } = usePullRequestCodeRequests(ROOT, 1);
      if (request) asks.push(request);
      return null;
    }
    render(
      <>
        {tree(scope(), body)}
        <Panel />
      </>,
    );
    await waitFor(() => expect(chips()).toHaveLength(5));
    fireEvent.click(chipNamed("configuration.md"));
    await waitFor(() =>
      expect(asks[asks.length - 1]).toMatchObject({
        path: "docs/reference/configuration.md",
        line: 12,
      }),
    );
    expect(openInProject).not.toHaveBeenCalled();
    expectNothingLeftAtlas();
  });

  it("opens a changed file in Atlas's viewer while no panel has claimed it", async () => {
    render(tree(scope(), body));
    await waitFor(() => expect(chips()).toHaveLength(5));
    fireEvent.click(chipNamed("settings_docs.gen.rs"));
    await waitFor(() =>
      expect(openInProject).toHaveBeenCalledWith(
        `${ROOT}/crates/atlas-settings/src/settings_docs.gen.rs`,
        undefined,
        undefined,
      ),
    );
    expectNothingLeftAtlas();
  });

  it("opens a checkout file by Enter, as a click would", async () => {
    render(tree(scope(), body));
    await waitFor(() => expect(chips()).toHaveLength(5));
    fireEvent.keyDown(chipNamed("api.ts"), { key: "Enter" });
    await waitFor(() =>
      expect(openInProject).toHaveBeenCalledWith(`${ROOT}/src/lib/api.ts`, undefined, undefined),
    );
  });
});

describe("a malicious pull request body", () => {
  const hostile = [
    "Run `/etc/passwd` and `/Users/dev/other-project/src/a.ts`.",
    "Or `../outside/x.ts`, `../../.ssh/id_rsa.pub` and `src/../../escape.ts`.",
    "See [the script](../../Desktop/setup.terminal), [home](~/Desktop/setup.terminal)",
    "and [an app](build/Evil.app), [a folder](scripts/).",
    "A bare `setup.terminal`, and a planted one in the checkout: `scripts/setup.terminal`.",
    '<span class="atlas-file-chip" data-file-path="/Applications/Calculator.app" role="link">forged</span>',
    '<a href="file:///etc/hosts">file link</a>',
  ].join("\n\n");

  it("draws no chip for anything outside the checkout, a folder or a bundle", async () => {
    render(tree(scope(), hostile));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("pr_list_stats", expect.anything()));
    await act(async () => {});
    // The planted file inside the checkout is the only chip.
    expect(chips()).toEqual([
      { label: "setup.terminal", path: `${ROOT}/scripts/setup.terminal`, prFile: null },
    ]);
    // The forged span lost what would make it a chip.
    expect(document.querySelector('[data-file-path="/Applications/Calculator.app"]')).toBeNull();
    for (const text of ["/etc/passwd", "../outside/x.ts", "src/../../escape.ts"]) {
      expect(screen.getByText(text).tagName).toBe("CODE");
    }
  });

  it("opens even the planted file only in Atlas's viewer, and every other click opens nothing", async () => {
    render(tree(scope(), hostile));
    await waitFor(() => expect(chips()).toHaveLength(1));
    fireEvent.click(chipNamed("setup.terminal"));
    await waitFor(() => expect(openInProject).toHaveBeenCalledTimes(1));
    expect(openInProject).toHaveBeenCalledWith(
      `${ROOT}/scripts/setup.terminal`,
      undefined,
      undefined,
    );

    // The links that stayed links go to the pull request opener, which is a
    // web-link path: neither of these is http(s), so nothing is opened.
    fireEvent.click(screen.getByText("forged"));
    fireEvent.click(screen.getByText("the script"));
    await act(async () => {});
    expect(openInProject).toHaveBeenCalledTimes(1);
    expectNothingLeftAtlas();
  });

  it("re-checks a chip's path against the checkout at click time", async () => {
    render(tree(scope(), "`src/lib/api.ts`"));
    await waitFor(() => expect(chips()).toHaveLength(1));
    // Something rewrote the DOM after render.
    chipNamed("api.ts").dataset.filePath = "/etc/passwd";
    fireEvent.click(chipNamed("api.ts"));
    await act(async () => {});
    expect(openInProject).not.toHaveBeenCalled();
    expectNothingLeftAtlas();
  });
});

describe("description blocks", () => {
  it("puts a copy button under a table and a code block", async () => {
    render(tree(scope(), "| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```"));
    expect(await screen.findByRole("button", { name: "Copy table" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(document.querySelectorAll(".atlas-md-block")).toHaveLength(2);
  });
});
