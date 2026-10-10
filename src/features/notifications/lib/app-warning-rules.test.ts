import { describe, expect, it } from "vitest";
import {
  AUTOFETCH_FAIL_THRESHOLD,
  configErrorDedupeKey,
  decideAgentUpdateFailed,
  decideAutoFetchFailing,
  CHOOSE_PULL_ACTION_ID,
  decideBehind,
  decideConfigError,
  evaluateAutoFetch,
  evaluateBehind,
  evaluateConfigError,
  INITIAL_AUTOFETCH_STATE,
  INITIAL_BEHIND_STATE,
  INITIAL_CONFIG_STATE,
  summarizeConfigError,
  type AutoFetchWarnState,
  type BehindWarnState,
  type ConfigWarnState,
  type ProjectRef,
} from "./app-warning-rules";
import type { NotificationEnv } from "./decide";

const env = (over: Partial<NotificationEnv> = {}): NotificationEnv => ({
  windowFocused: true,
  sinceInputMs: 1_000,
  targetVisible: false,
  projectActive: true,
  away: false,
  ...over,
});
const project: ProjectRef = { projectId: "p1", projectName: "Atlas", projectActive: true };

function feedFetch(errors: (string | null)[]) {
  let state: AutoFetchWarnState = INITIAL_AUTOFETCH_STATE;
  const warnings: (number | null)[] = [];
  const resolved: (number | null)[] = [];
  for (const e of errors) {
    const r = evaluateAutoFetch(state, e);
    state = r.state;
    warnings.push(r.warning?.episode ?? null);
    resolved.push(r.resolved);
  }
  return { state, warnings, resolved };
}

describe("evaluateAutoFetch", () => {
  it("is silent below the threshold and fires exactly on the third failure", () => {
    expect(AUTOFETCH_FAIL_THRESHOLD).toBe(3);
    const { warnings } = feedFetch(["x", "x", "x"]);
    expect(warnings).toEqual([null, null, 1]);
  });

  it("fires once per failure run", () => {
    const { warnings } = feedFetch(["x", "x", "x", "x", "x", "x"]);
    expect(warnings.filter((w) => w !== null)).toEqual([1]);
  });

  it("a success resets the count and re-arms; the next run is a new episode", () => {
    const { warnings, resolved } = feedFetch(["x", "x", "x", null, "x", "x", "x"]);
    expect(warnings).toEqual([null, null, 1, null, null, null, 2]);
    expect(resolved).toEqual([null, null, null, 1, null, null, null]);
  });

  it("failures interrupted by a success never accumulate", () => {
    const { warnings, resolved } = feedFetch(["x", "x", null, "x", "x", null]);
    expect(warnings.every((w) => w === null)).toBe(true);
    expect(resolved.every((r) => r === null)).toBe(true);
  });

  it("carries the latest error in the warning", () => {
    let state = INITIAL_AUTOFETCH_STATE;
    for (const e of ["a", "b"]) state = evaluateAutoFetch(state, e).state;
    expect(evaluateAutoFetch(state, "boom").warning).toMatchObject({ error: "boom", failures: 3 });
  });

  it("a success with nothing pending changes nothing", () => {
    const r = evaluateAutoFetch(INITIAL_AUTOFETCH_STATE, null);
    expect(r.state).toBe(INITIAL_AUTOFETCH_STATE);
  });
});

function feedBehind(obs: [number, string][]) {
  let state: BehindWarnState = INITIAL_BEHIND_STATE;
  return obs.map(([behind, head]) => {
    const r = evaluateBehind(state, behind, head);
    state = r.state;
    return r.warning?.remoteHead ?? null;
  });
}

describe("evaluateBehind", () => {
  it("carries the ahead count into the warning, clamped to >= 0", () => {
    let state = evaluateBehind(INITIAL_BEHIND_STATE, 0, "a").state;
    expect(evaluateBehind(state, 1, "b", 3).warning).toEqual({
      behind: 1,
      ahead: 3,
      remoteHead: "b",
    });
    state = evaluateBehind(INITIAL_BEHIND_STATE, 0, "a").state;
    expect(evaluateBehind(state, 1, "b", -2).warning?.ahead).toBe(0);
    state = evaluateBehind(INITIAL_BEHIND_STATE, 0, "a").state;
    expect(evaluateBehind(state, 1, "b").warning?.ahead).toBe(0);
  });

  it("seeds silently on the first observation, even when already behind", () => {
    expect(feedBehind([[3, "a"]])).toEqual([null]);
  });

  it("fires on 0 -> >0 and not while it stays behind", () => {
    expect(
      feedBehind([
        [0, "a"],
        [1, "b"],
        [2, "c"],
      ]),
    ).toEqual([null, "b", null]);
  });

  it("re-arms once caught up, and fires for the next new remote head", () => {
    expect(
      feedBehind([
        [0, "a"],
        [1, "b"],
        [0, "b"],
        [2, "c"],
      ]),
    ).toEqual([null, "b", null, "c"]);
  });

  it("does not repeat for a head already announced", () => {
    expect(
      feedBehind([
        [0, "a"],
        [1, "b"],
        [0, "a"],
        [1, "b"],
      ]),
    ).toEqual([null, "b", null, null]);
  });

  it("ignores nonsense counts", () => {
    const s: BehindWarnState = { behind: 0, notifiedHead: null, liveHead: null };
    expect(evaluateBehind(s, -1, "x")).toEqual({ state: s, warning: null, resolved: null });
    expect(evaluateBehind(s, Number.NaN, "x")).toEqual({ state: s, warning: null, resolved: null });
  });

  it("resolves the live warning's head when the count returns to 0, once", () => {
    let state: BehindWarnState = INITIAL_BEHIND_STATE;
    const resolved = [
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [0, "c"],
      [0, "c"],
    ].map(([behind, head]) => {
      const r = evaluateBehind(state, behind as number, head as string);
      state = r.state;
      return r.resolved;
    });
    expect(resolved).toEqual([null, null, null, "b", null]);
  });

  it("does not resolve what was never warned about (seeded behind, then caught up)", () => {
    let state: BehindWarnState = INITIAL_BEHIND_STATE;
    state = evaluateBehind(state, 3, "a").state;
    expect(evaluateBehind(state, 0, "a").resolved).toBeNull();
  });
});

describe("evaluateConfigError", () => {
  const feed = (errors: (string | null)[]) => {
    let state: ConfigWarnState = INITIAL_CONFIG_STATE;
    return errors.map((e) => {
      const r = evaluateConfigError(state, e);
      state = r.state;
      return { warned: r.warning?.error ?? null, resolved: r.resolved };
    });
  };

  it("warns once per distinct error", () => {
    const out = feed(["bad", "bad", "worse", "worse", "bad"]);
    expect(out.map((o) => o.warned)).toEqual(["bad", null, "worse", null, "bad"]);
  });

  it("a clean load resolves the error and re-arms the same text", () => {
    const out = feed(["bad", null, "bad"]);
    expect(out[1].resolved).toBe("bad");
    expect(out[2].warned).toBe("bad");
  });

  it("a clean load with no error is a no-op", () => {
    expect(feed([null])[0]).toEqual({ warned: null, resolved: null });
  });
});

describe("summarizeConfigError", () => {
  it("drops the TOML code frame and keeps the message", () => {
    const raw = [
      "config.toml is not valid TOML: TOML parse error at line 3, column 9",
      "  |",
      "3 | theme = ",
      "  |         ^",
      "invalid string",
    ].join("\n");
    expect(summarizeConfigError(raw)).toBe(
      "config.toml is not valid TOML: TOML parse error at line 3, column 9 — invalid string",
    );
  });

  it("falls back when nothing is left", () => {
    expect(summarizeConfigError("  |\n")).toBe("config.toml could not be loaded.");
  });
});

describe("decisions", () => {
  it("auto-fetch: git-panel target, names the project only when inactive", () => {
    const w = { episode: 2, failures: 3, error: "Could not resolve host\nmore" };
    const here = decideAutoFetchFailing(project, w, env(), {})!;
    expect(here.kind).toBe("git-autofetch-failing");
    expect(here.tier).toBe("warning");
    expect(here.target).toEqual({ type: "git-panel", projectId: "p1", projectName: "Atlas" });
    expect(here.subtitle).toBeUndefined();
    expect(here.body).toBe("Could not resolve host");
    expect(here.dedupeKey).toBe("autofetch:p1:2");
    expect(here.channels).toMatchObject({ center: true, toast: true, native: false });
    const other = decideAutoFetchFailing({ ...project, projectActive: false }, w, env(), {})!;
    expect(other.subtitle).toBe("Atlas");
  });

  it("behind: keyed by the remote head, pluralises, offers only Open", () => {
    const d = decideBehind(project, "main", { behind: 1, ahead: 0, remoteHead: "abc" }, env(), {})!;
    expect(d.title).toBe("main is behind its remote");
    expect(d.body).toContain("1 new commit on");
    expect(d.dedupeKey).toBe("behind:p1:abc");
    expect(d.target.type).toBe("git-panel");
    expect(d.actions).toEqual([{ id: "open", label: "Open" }]);
    expect(
      decideBehind(project, null, { behind: 4, ahead: 0, remoteHead: "x" }, env(), {})!.body,
    ).toContain("4 new commits");
  });

  it("diverged with no saved preference: says so and offers the choice first", () => {
    const w = { behind: 1, ahead: 3, remoteHead: "abc" };
    const d = decideBehind(project, "main", w, env(), {}, "ask")!;
    expect(d.title).toBe("main has diverged from its remote");
    expect(d.body).toBe(
      "3 local commits and 1 commit on the remote. Choose whether to rebase or merge.",
    );
    expect(d.actions.map((a) => a.id)).toEqual([CHOOSE_PULL_ACTION_ID, "open"]);
    expect(d.dedupeKey).toBe("behind:p1:abc");
  });

  it("diverged with a saved preference: names it and offers no choice", () => {
    const w = { behind: 2, ahead: 1, remoteHead: "abc" };
    const d = decideBehind(project, "main", w, env(), {}, "rebase")!;
    expect(d.body).toBe(
      "1 local commit and 2 commits on the remote. Pulling will rebase, per your git config.",
    );
    expect(d.actions).toEqual([{ id: "open", label: "Open" }]);
  });

  it("config error: opens the file, key follows the error text", () => {
    const d = decideConfigError("config.toml is not valid TOML: bad", env(), {})!;
    expect(d.target).toEqual({ type: "config-file" });
    expect(d.body).toContain("not valid TOML: bad");
    expect(d.dedupeKey).toBe(configErrorDedupeKey("config.toml is not valid TOML: bad"));
    expect(configErrorDedupeKey("a")).not.toBe(configErrorDedupeKey("b"));
  });

  it("agent update failure: names the agent and error, opens the agents section", () => {
    const d = decideAgentUpdateFailed(
      { pluginId: "cursor", name: "Cursor", version: "1.2.0", error: "EACCES", seq: 1 },
      env(),
      {},
    )!;
    expect(d.title).toBe("Cursor couldn't update to v1.2.0");
    expect(d.body).toBe("EACCES");
    expect(d.target).toEqual({ type: "settings", section: "agents" });
    expect(d.dedupeKey).not.toBe(
      decideAgentUpdateFailed(
        { pluginId: "cursor", name: "Cursor", version: "1.2.0", error: "EACCES", seq: 2 },
        env(),
        {},
      )!.dedupeKey,
    );
  });

  it("warning banners are off by default tier prefs only when prefs say so", () => {
    const d = decideConfigError("x", env({ away: true, windowFocused: false }), {
      "config-error": { enabled: false, native: true, sound: true },
    });
    expect(d).toBeNull();
  });
});
