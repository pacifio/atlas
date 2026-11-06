import { EditorSelection, EditorState } from "@codemirror/state";
import { SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { searchCount, searchCountLabel } from "./search-count";

const stateWith = (doc: string, query: Partial<ConstructorParameters<typeof SearchQuery>[0]>) => {
  const base = EditorState.create({ doc, extensions: [search()] });
  return base.update({ effects: setSearchQuery.of(new SearchQuery({ search: "", ...query })) })
    .state;
};

describe("searchCount", () => {
  it("counts matches and finds the selected one", () => {
    let state = stateWith("foo bar foo baz foo", { search: "foo" });
    expect(searchCount(state)).toEqual({ total: 3, capped: false, current: 0 });
    state = state.update({ selection: EditorSelection.single(8, 11) }).state;
    expect(searchCount(state)?.current).toBe(2);
    expect(searchCountLabel(searchCount(state))).toBe("2 of 3");
  });

  it("is null with no query or an invalid regex", () => {
    expect(searchCount(stateWith("x", { search: "" }))).toBeNull();
    expect(searchCount(stateWith("x", { search: "(", regexp: true }))).toBeNull();
  });

  it("stops at the cap", () => {
    const count = searchCount(stateWith("a".repeat(50), { search: "a" }), 10);
    expect(count).toEqual({ total: 10, capped: true, current: 0 });
    expect(searchCountLabel(count)).toBe("10+ matches");
  });

  it("says when nothing matches", () => {
    expect(searchCountLabel(searchCount(stateWith("abc", { search: "z" })))).toBe("No results");
  });
});
