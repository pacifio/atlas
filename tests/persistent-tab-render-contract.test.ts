import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards `CenterPanel`'s persistent-tab render path (the registry lives in
 * `tab-panels.tsx`).
 *
 * HISTORY. `TabContentContainer` used to mount persistent tab types through an
 * if/else-if chain keyed on `tab.type` that ended in an unconditional
 * `<TerminalPanel/>` fallback. `tsc` could not catch a missing branch there:
 * `tab.type` was typed as the full `TabType` union in every arm, so every
 * branch — including the fallback — type-checked whether or not it was the
 * *right* component. A type added to `PERSISTENT_TYPES` without a branch did
 * not fail to compile and did not throw; it silently fell into the terminal
 * branch and spawned a real PTY keyed to that tab's id.
 *
 * This shipped. Commit 32767aff8 ("comms UI update", 2026-09-11) added
 * `"spaces"` to `PERSISTENT_TYPES` and `IDLE_EXPENSIVE_TYPES` but never added
 * a matching branch, so opening a Space in alpha-0.3.2 mounted PowerShell
 * inside a tab titled "… — Space". Fixed by 1322c8f2.
 *
 * NOW. The lists are `as const` tuples, `persistentTabs` is narrowed by a type
 * predicate, and `PersistentPanel` is a `switch` whose `default` assigns
 * `tab.type` to `never`. A missing case is a COMPILE ERROR, which is a
 * stronger guarantee than anything this file can assert. What remains here is
 * the part the type system still cannot see:
 *
 *   1. that the `switch` has not been reshaped back into a catch-all — i.e.
 *      `<TerminalPanel/>` is only ever reached under `case "terminal":`;
 *   2. a readable, named restatement of the list relationship, so the failure
 *      message points at the history above rather than at a bare TS2322.
 *
 * We parse source text rather than rendering the component, matching
 * `ipc-contract.test.ts` / `state-payload-contract.test.ts`: it is cheap,
 * needs no DOM/store mocking, and importing `tab-panels.tsx` would pull in
 * the whole lazy-loaded panel tree and every store it touches.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAB_PANELS_PATH = path.join(
  REPO_ROOT,
  "src",
  "features",
  "layout",
  "components",
  "tab-panels.tsx",
);

function readSource(): string {
  return readFileSync(TAB_PANELS_PATH, "utf-8");
}

/** Pulls the quoted string literals out of one `as const` tuple declaration. */
function parseTypeList(source: string, name: string): string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`));
  if (!match) {
    throw new Error(
      `Could not find \`${name}\` in tab-panels.tsx — the parser needs updating to match a reshaped declaration.`,
    );
  }
  return [...match[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

/** The `case "..."` labels of the `PersistentPanel` switch. */
function parsePersistentPanelCases(source: string): string[] {
  const start = source.indexOf("function PersistentPanel(");
  if (start === -1) {
    throw new Error(
      "Could not locate `PersistentPanel` in tab-panels.tsx — the parser needs updating to match a reshaped render.",
    );
  }
  // The next top-level function, exported or not, ends the block — or the
  // scan runs on into `TabContent` and counts its cases too.
  const next = /\n(?:export )?function /g;
  next.lastIndex = start + 1;
  const end = next.exec(source)?.index ?? -1;
  const block = source.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
}

describe("CenterPanel persistent-tab render contract", () => {
  it("finds a non-trivial PERSISTENT_TYPES_LIST (parser smoke test)", () => {
    const persistentTypes = parseTypeList(readSource(), "PERSISTENT_TYPES_LIST");
    // Floor well under the real count (9 at time of writing) — a smoke alarm
    // for "the regex stopped matching", not a coverage target.
    expect(persistentTypes.length).toBeGreaterThanOrEqual(5);
  });

  it("gives every PERSISTENT_TYPES_LIST entry its own case in PersistentPanel", () => {
    const source = readSource();
    const persistentTypes = parseTypeList(source, "PERSISTENT_TYPES_LIST");
    const handled = new Set(parsePersistentPanelCases(source));

    const missing = persistentTypes.filter((t) => !handled.has(t));

    expect(
      missing,
      `PERSISTENT_TYPES_LIST contains ${JSON.stringify(missing)} with no matching ` +
        `\`case "…":\` in PersistentPanel. \`tsc\` should already have failed on the ` +
        `\`never\` default — if it did not, the exhaustiveness check has been ` +
        `weakened, and the type will mount the wrong panel (this is exactly how ` +
        `the Spaces tab regressed in 32767aff8).`,
    ).toEqual([]);
  });

  it("only mounts TerminalPanel under the terminal case", () => {
    // Blank out comment bodies rather than deleting them, so match indices
    // still line up with the real source for the `case` scan below. The
    // docblocks here talk *about* `<TerminalPanel/>` at length.
    const source = readSource().replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, (line) =>
      " ".repeat(line.length),
    );
    const mounts = [...source.matchAll(/<TerminalPanel[\s/>]/g)];

    expect(mounts.length, "expected exactly one <TerminalPanel/> mount site").toBe(1);

    for (const m of mounts) {
      const before = source.slice(0, m.index);
      const labels = [...before.matchAll(/case "([a-z-]+)":/g)];
      // Index rather than `.at(-1)`: `tsconfig.test.json` targets below ES2022.
      const nearest = labels.length > 0 ? labels[labels.length - 1][1] : undefined;
      expect(
        nearest,
        `<TerminalPanel/> is mounted under \`case "${nearest}":\`, not \`case "terminal":\`. ` +
          `A catch-all terminal is how a Space tab spawned a PTY in alpha-0.3.2 — ` +
          `every persistent type must mount its own panel explicitly.`,
      ).toBe("terminal");
    }
  });

  it("keeps IDLE_EXPENSIVE_TYPES_LIST a subset of PERSISTENT_TYPES_LIST", () => {
    // `satisfies readonly PersistentTabType[]` already enforces this at compile
    // time; asserted here so the failure names the consequence. A type in the
    // idle set but not the persistent set is never unmounted for background
    // projects — it just keeps burning CPU/GPU off-screen forever.
    const source = readSource();
    const persistent = new Set(parseTypeList(source, "PERSISTENT_TYPES_LIST"));
    const idle = parseTypeList(source, "IDLE_EXPENSIVE_TYPES_LIST");

    expect(idle.length).toBeGreaterThan(0);
    expect(idle.filter((t) => !persistent.has(t))).toEqual([]);
  });
});
