import { beforeEach, describe, expect, it } from "vitest";
import { hasUnread, isErrorKind, useNotificationsStore, visibleItems } from "./notifications-store";

beforeEach(() => useNotificationsStore.setState({ items: [], panelOpen: false }));

const add = (
  orgId: string | undefined,
  kind: "terminal-done" | "terminal-failed" = "terminal-done",
) =>
  useNotificationsStore.getState().actions.add({
    kind,
    source: "terminal",
    title: "t",
    body: "b",
    tabId: "terminal",
    orgId,
  });

describe("org-scoped notifications", () => {
  it("shows only the active org's items plus untagged ones", () => {
    add("org-a");
    add("org-b");
    add(undefined);
    const items = useNotificationsStore.getState().items;
    expect(visibleItems(items, "org-a")).toHaveLength(2);
    expect(visibleItems(items, "org-b")).toHaveLength(2);
    expect(visibleItems(items, null)).toHaveLength(3);
  });

  it("unread and error flags are scoped too", () => {
    add("org-a", "terminal-failed");
    add("org-b");
    const items = useNotificationsStore.getState().items;
    expect(hasUnread(items, "org-a", isErrorKind)).toBe(true);
    expect(hasUnread(items, "org-b", isErrorKind)).toBe(false);
    expect(hasUnread(items, "org-b")).toBe(true);
  });

  it("opening the panel for one org leaves the other org's unread state alone", () => {
    add("org-a");
    add("org-b");
    useNotificationsStore.getState().actions.open("org-a");
    const items = useNotificationsStore.getState().items;
    expect(items.find((i) => i.orgId === "org-a")?.read).toBe(true);
    expect(items.find((i) => i.orgId === "org-b")?.read).toBe(false);
  });
});
