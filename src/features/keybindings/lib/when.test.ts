import { describe, expect, it } from "vitest";
import {
  evaluateWhen,
  neverMatches,
  panelWhenContext,
  parseWhen,
  parseWhenDraft,
  unknownWhenVariables,
  whenToExpression,
} from "./when";

const ast = (s: string) => parseWhen(s) ?? undefined;

describe("when expressions", () => {
  it("parses with ! tightest and || loosest, and prints canonically", () => {
    expect(whenToExpression(ast("a||b&&!c"))).toBe("a || (b && !c)");
    expect(whenToExpression(ast("!(a || b)"))).toBe("!(a || b)");
    expect(whenToExpression(ast("  terminalFocus  "))).toBe("terminalFocus");
  });

  it("rejects what isn't an expression", () => {
    for (const bad of ["&&", "a &&", "(a", "a)", "a b", "a & b", "1a", "!", "()"]) {
      expect(parseWhen(bad), bad).toBeNull();
    }
    expect(parseWhenDraft("")).toEqual({ ok: true, value: undefined });
    expect(parseWhenDraft("a &&").ok).toBe(false);
  });

  it("evaluates against a context; unset and unknown variables are false", () => {
    const ctx = { terminalFocus: true };
    expect(evaluateWhen(ast("!terminalFocus"), ctx)).toBe(false);
    expect(evaluateWhen(ast("chatFocus || terminalFocus"), ctx)).toBe(true);
    expect(evaluateWhen(ast("terminalFocus && mystery"), ctx)).toBe(false);
    expect(evaluateWhen(ast("true && !false"), {})).toBe(true);
    expect(evaluateWhen(undefined, {})).toBe(true);
  });

  it("lists variables Atlas doesn't provide", () => {
    expect(unknownWhenVariables(ast("terminalFocus && zz || aa"))).toEqual(["aa", "zz"]);
  });

  it("a panel's own variable is true and the other surfaces false when it asks", () => {
    const ctx = panelWhenContext({ chatFocus: true, inputFocus: true }, "terminalFocus");
    expect(ctx).toMatchObject({ terminalFocus: true, chatFocus: false, inputFocus: true });
  });

  it("flags a condition a scoped action's panel can never meet", () => {
    // Terminal find moved to chat: its handler lives in the terminal.
    expect(neverMatches(ast("chatFocus"), "terminalFocus")).toBe(true);
    expect(neverMatches(ast("terminalFocus && !inputFocus"), "terminalFocus")).toBe(false);
    expect(neverMatches(ast("!terminalFocus"), "global")).toBe(false);
    expect(neverMatches(ast("terminalFocus && chatFocus"), "global")).toBe(true);
    expect(neverMatches(ast("false"), "global")).toBe(true);
    expect(neverMatches(undefined, "terminalFocus")).toBe(false);
  });
});
