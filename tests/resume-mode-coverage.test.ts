import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every path that binds a tab to a live agent session must put the AGENT into
 * the mode the user last explicitly picked — not just the picker.
 *
 * `resume-mode.ts` (`applyModeOnResume`) is that one call, and it exists
 * because of issue 289's second bug: after a crash the engine came back on its
 * own default while the composer pill still showed the user's pick, so the
 * picker disagreed with the agent about what would be asked and what would
 * simply run. The three paths that existed when it landed — the history
 * sidebar, `openAgentSession`, and `session/new` — all call it.
 *
 * `rebindDisconnectedSession` (chat-panel) was the fourth, and it did not: it
 * respawns the agent and re-binds, and a bind does not clear
 * `acpModeExplicit`/`acpCurrentMode`, so the pill survived the restart while
 * the fresh agent enforced its own default. Same failure, one path over —
 * reachable from the "Restart agent" banner and from the next Send after a
 * disconnect, the latter with the queued prompt already racing it.
 *
 * Nothing type-checks this. `applyModeOnResume` returns `Promise<void>`, a
 * forgotten call is not a compile error, and the symptom is invisible until a
 * real agent runs a command under a mode the user never chose. So: read the
 * sources and assert each bind site calls it, the way
 * `ipc-contract.test.ts` / `next-steps-marker-parity.test.ts` do. Parsing text
 * rather than rendering means no store/DOM mocking and no agent.
 *
 * The list below is deliberately an ENUMERATION, not a search for every
 * `setAcpBinding` call: the point is to name the paths, so a new one has to be
 * added here and thought about rather than picked up silently. A site that
 * binds a session but is deliberately exempt says so in `note`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf8");

/** Where `applyModeOnResume` is implemented — the one definition. */
const RESUME_MODE = "src/features/chat/lib/resume-mode.ts";

/**
 * Every binding site, and the call that carries the user's pick to the agent.
 *
 * `via` is the expression whose result reaches `applyModeOnResume`; it has to
 * be a `SessionSnapshot` (that is what validates the pick against the live
 * advertised modes), which is why both callers fetch one rather than reusing
 * the init they bound with.
 */
const BIND_SITES = [
  {
    what: "session/new, at bind time",
    file: "src/features/chat/components/chat-panel.tsx",
    // The fresh-session arm inlines `resolveEffectiveMode` + `setMode` rather
    // than calling `applyModeOnResume`: it has the `SessionInit` already and
    // seeds Claude's own permission pill, which `applyModeOnResume` only
    // touches on an un-honoured pick. What must be present is the validation
    // and the push, in that order.
    via: "resolveEffectiveMode",
  },
  {
    what: "sidebar resume (openThread)",
    file: "src/features/chat/lib/open-thread.ts",
    via: "applyModeOnResume",
  },
  {
    what: "openAgentSession resume",
    file: "src/features/chat/lib/open-agent-session.ts",
    via: "applyModeOnResume",
  },
  {
    what: "rebind after an agent restart",
    file: "src/features/chat/components/chat-panel.tsx",
    via: "applyModeOnResume",
  },
] as const;

/** The body of the function that actually respawns and rebinds. */
function rebindBody(): string {
  const src = read("src/features/chat/components/chat-panel.tsx");
  const start = src.indexOf("async function respawnAndRebind");
  expect(start, "chat-panel.tsx no longer defines respawnAndRebind").toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n}\n", start));
}

describe("resume-mode coverage", () => {
  it("declares applyModeOnResume exactly once, for both the ACP and Claude pills", () => {
    const src = read(RESUME_MODE);
    expect(src.match(/export async function applyModeOnResume\b/g) ?? []).toHaveLength(1);
    // Both pills, or a Claude session silently stops being restored: the
    // generic ACP branch and the `isClaude` branch.
    expect(src).toMatch(/isClaude/);
    expect(src).toMatch(/setAcpModes/);
  });

  it.each(BIND_SITES)("$what re-applies the user's mode", ({ file, via }) => {
    const src = read(file);
    // The call, not the name: an import alone would satisfy `includes(via)`.
    expect(
      src.includes(`${via}(`),
      `${file}: no \`${via}\` — a session bound here would resume on the agent's own default while the pill kept showing the user's pick (issue 289).`,
    ).toBe(true);
  });

  it("pushes the mode to the agent rather than only seeding the picker", () => {
    // `applyModeOnResume`'s whole job is the `setMode` round-trip; a caller
    // that only wanted the pill seeded would use `setAcpModes` directly. If
    // the push ever goes, this is what catches it.
    const src = read(RESUME_MODE);
    expect(src).toMatch(/await agents\.setMode\(/);
  });

  it("restores the mode BEFORE the tab is bound", () => {
    // Ordering, not presence. The send gate is `setAcpBinding`, not
    // `setDisconnected(false)`: a tab whose agent died while starting has no
    // `acpSessionId`, so the bind is a `justBound` edge (`drain-gate.ts`) and
    // the queued message goes out on the next commit. A mode restored after
    // the bind races that message, and an `await` between the bind and
    // `setDisconnected(false)` lets it see the tab still disconnected and
    // start a second rebind. So: restore, then bind, then clear the flag.
    const body = rebindBody();
    const apply = body.indexOf("applyModeOnResume(");
    const bind = body.indexOf("setAcpBinding(");
    const settled = body.indexOf("setDisconnected(tabId, false)");
    expect(apply, "the rebind never calls applyModeOnResume").toBeGreaterThan(-1);
    expect(bind, "the rebind never binds the tab").toBeGreaterThan(-1);
    expect(settled, "the rebind never clears the disconnected flag").toBeGreaterThan(-1);
    expect(apply, "the mode must be applied before the tab is bound").toBeLessThan(bind);
    expect(
      body.slice(bind, settled),
      "nothing may be awaited between binding and clearing the disconnected flag",
    ).not.toMatch(/\bawait\b/);
  });

  it("joins a rebind already in flight instead of respawning twice", () => {
    // Restart and Send both call the rebind, and the bind itself drains the
    // queue into `handleSend`; without a per-tab guard each caller respawns
    // the agent and rebinds, and the loser can leave the tab on a session the
    // mode was never applied to.
    const src = read("src/features/chat/components/chat-panel.tsx");
    const start = src.indexOf("function rebindDisconnectedSession");
    expect(start).toBeGreaterThan(-1);
    const guard = src.slice(start, src.indexOf("\n}\n", start));
    expect(guard).toMatch(/rebindsInFlight\.get\(tabId\)/);
    expect(guard).toMatch(/rebindsInFlight\.delete\(tabId\)/);
  });

  it("treats a failed mode restore as a warning, not a failed rebind", () => {
    // The session exists at that point; failing the whole restart over a
    // snapshot that would not read would strand a working session behind
    // "The agent could not be restarted". So the restore needs its own `try`
    // whose `catch` warns and falls through — not the rebind's outer `catch`,
    // which does return false and is correct for a spawn that never landed.
    const body = rebindBody();
    const call = body.indexOf("applyModeOnResume(");
    expect(call).toBeGreaterThan(-1);
    // The innermost `try {` opening at or before the call.
    const tryStart = body.lastIndexOf("try {", call);
    expect(tryStart, "the mode restore must have its own try").toBeGreaterThan(-1);
    const catchStart = body.indexOf("} catch", call);
    expect(catchStart).toBeGreaterThan(-1);

    const handler = body.slice(catchStart, body.indexOf("}", body.indexOf(";", catchStart)));
    expect(handler).toMatch(/console\.warn\(/);
    expect(handler).not.toMatch(/return false/);
  });
});
