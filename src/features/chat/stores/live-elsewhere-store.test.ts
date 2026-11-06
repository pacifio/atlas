import { beforeEach, describe, expect, it } from "vitest";
import { useLiveElsewhereStore } from "./live-elsewhere-store";

const { setLive, sendAnyway } = useLiveElsewhereStore.getState().actions;
const state = () => useLiveElsewhereStore.getState();

beforeEach(() => useLiveElsewhereStore.setState({ live: {}, overridden: {} }));

describe("live-elsewhere store", () => {
  it("replaces the live set wholesale", () => {
    setLive(["a", "b"]);
    expect(Object.keys(state().live).sort()).toEqual(["a", "b"]);
    setLive(["b"]);
    expect(Object.keys(state().live)).toEqual(["b"]);
  });

  it("keeps the same live object when nothing changed, so subscribers stay quiet", () => {
    setLive(["a"]);
    const before = state().live;
    setLive(["a"]);
    expect(state().live).toBe(before);
  });

  it("remembers a Send anyway while the session stays live", () => {
    setLive(["a"]);
    sendAnyway("a");
    setLive(["a", "b"]);
    expect(state().overridden.a).toBe(true);
    expect(state().overridden.b).toBeUndefined();
  });

  it("drops the override once the session stops being live, so a later spell asks again", () => {
    setLive(["a"]);
    sendAnyway("a");
    setLive([]);
    expect(state().overridden.a).toBeUndefined();
    setLive(["a"]);
    expect(state().overridden.a).toBeUndefined();
  });
});
