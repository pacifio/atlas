import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the organisation calls that cross to the window (ADR-0014 over
 * ADR-0012's bridge): every tool the organisation tool server declares as
 * performed by the window (`WINDOW_TOOLS`) is a tool it offers, and has a
 * case in the window's dispatcher — and the dispatcher has no case for
 * anything else. The sibling of `ui-actions-contract.test.ts`.
 *
 * A window tool with no case answers "unknown organisation window action"
 * forever; a case with no window tool is dead code; a window tool that is not
 * declared goes out on the UI action event, where nothing performs it. None
 * of that is visible to either compiler, so it is read from source here.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const TOOLS_RS = "src-tauri/src/commands/org_server/tools/mod.rs";

function windowTools(): string[] {
  const src = read(TOOLS_RS);
  const m = src.match(/pub const WINDOW_TOOLS: &\[&str\] = &\[([^\]]*)\];/);
  if (!m) throw new Error("no WINDOW_TOOLS in the organisation tool server");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function offeredTools(): string[] {
  const src = read(TOOLS_RS);
  const body = src.slice(
    src.indexOf("pub(super) fn tools()"),
    src.indexOf("pub(super) fn tools_for("),
  );
  return [...body.matchAll(/tool\(\s*"(org_[a-z_]+)"/g)].map((m) => m[1]);
}

function dispatchedTools(): string[] {
  const src = read("src/features/org-actions/lib/org-window-actions.ts");
  return [...src.matchAll(/case "(org_[a-z_]+)":/g)].map((m) => m[1]);
}

describe("organisation window action contract", () => {
  it("finds the tools on both sides", () => {
    expect(windowTools().length).toBeGreaterThanOrEqual(1);
    expect(offeredTools().length).toBeGreaterThanOrEqual(12);
  });

  it("every window tool is a tool the model is offered", () => {
    for (const tool of windowTools()) expect(offeredTools()).toContain(tool);
  });

  it("every organisation tool that crosses to the window is performed by it, and nothing else", () => {
    expect([...dispatchedTools()].sort()).toEqual([...windowTools()].sort());
  });

  it("crosses on its own event, which the window listens for", () => {
    const rust = read("src-tauri/src/commands/org_server/mod.rs");
    const event = rust.match(/pub const ORG_WINDOW_ACTION_EVENT: &str = "([^"]+)";/)?.[1];
    expect(event).toBeTruthy();
    expect(read("src/features/org-actions/lib/org-actions-api.ts")).toContain(`"${event}"`);
    expect(read("src/features/ui-actions/lib/ui-actions-api.ts")).not.toContain(`"${event}"`);
  });
});
