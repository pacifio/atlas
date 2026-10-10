// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanActions,
  hasUnread,
  isErrorKind,
  useNotificationsStore,
  visibleItems,
} from "./notifications-store";

beforeEach(() => {
  localStorage.clear();
  useNotificationsStore.setState({ items: [], panelOpen: false });
});

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

describe("persistence", () => {
  const KEY = "atlas-notifications";
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}").state;

  it("persists items but not the panel's open state", () => {
    add("org-a");
    useNotificationsStore.getState().actions.open("org-a");
    expect(stored().items).toHaveLength(1);
    expect(stored().panelOpen).toBeUndefined();
  });

  it("restores items on rehydrate, capped at 200, dropping unknown kinds", async () => {
    const item = (i: number, kind = "terminal-done") => ({
      id: `n${i}`,
      kind,
      title: "t",
      body: "b",
      timestamp: new Date(0).toISOString(),
      source: "terminal",
      orgId: "org-a",
      read: false,
    });
    const items = [item(-1, "chat-done"), ...Array.from({ length: 250 }, (_, i) => item(i))];
    // After any setState — a write would overwrite the fixture.
    localStorage.setItem(KEY, JSON.stringify({ state: { items }, version: 1 }));
    await useNotificationsStore.persist.rehydrate();
    const restored = useNotificationsStore.getState().items;
    expect(restored).toHaveLength(200);
    expect(restored[0].id).toBe("n0");
    expect(useNotificationsStore.getState().panelOpen).toBe(false);
    expect(visibleItems(restored, "org-b")).toHaveLength(0);
  });

  it("restores agentType, tolerating old items without it and malformed values", async () => {
    const item = (id: string, agentType?: unknown) => ({
      id,
      kind: "agent-done",
      title: "t",
      body: "b",
      timestamp: new Date(0).toISOString(),
      source: "agent",
      read: false,
      ...(agentType === undefined ? {} : { agentType }),
    });
    const items = [item("ok", "codex"), item("old"), item("bad", 7), item("empty", "")];
    localStorage.setItem(KEY, JSON.stringify({ state: { items }, version: 1 }));
    await useNotificationsStore.persist.rehydrate();
    const byId = Object.fromEntries(useNotificationsStore.getState().items.map((i) => [i.id, i]));
    expect(byId.ok.agentType).toBe("codex");
    expect(byId.old.agentType).toBeUndefined();
    expect(byId.bad.agentType).toBeUndefined();
    expect(byId.empty.agentType).toBeUndefined();
  });

  it("keeps app-level sign-in targets and drops malformed ones on restore", async () => {
    const item = (id: string, target: unknown) => ({
      id,
      kind: "agent-sign-in",
      title: "t",
      body: "b",
      timestamp: new Date(0).toISOString(),
      source: "agent",
      target,
      read: false,
    });
    const items = [
      item("ok", { type: "agent-sign-in", agentType: "cursor" }),
      item("atlas", { type: "atlas-sign-in" }),
      item("bad", { type: "agent-sign-in" }),
      item("chat", { type: "chat-conversation", convId: "c1" }),
      item("badchat", { type: "chat-conversation" }),
      item("upd", { type: "app-update" }),
      item("models", { type: "settings", section: "models" }),
      item("badsettings", { type: "settings", section: "nope" }),
      item("agents", { type: "settings", section: "agents" }),
      item("cfg", { type: "config-file" }),
      item("git", { type: "git-panel", projectId: "p1" }),
      item("badgit", { type: "git-panel" }),
    ];
    localStorage.setItem(KEY, JSON.stringify({ state: { items }, version: 1 }));
    await useNotificationsStore.persist.rehydrate();
    const byId = Object.fromEntries(useNotificationsStore.getState().items.map((i) => [i.id, i]));
    expect(byId.ok.target).toEqual({ type: "agent-sign-in", agentType: "cursor" });
    expect(byId.atlas.target).toEqual({ type: "atlas-sign-in" });
    expect(byId.bad.target).toBeUndefined();
    expect(byId.chat.target).toEqual({ type: "chat-conversation", convId: "c1" });
    expect(byId.badchat.target).toBeUndefined();
    expect(byId.upd.target).toEqual({ type: "app-update" });
    expect(byId.models.target).toEqual({ type: "settings", section: "models" });
    expect(byId.badsettings.target).toBeUndefined();
    expect(byId.agents.target).toEqual({ type: "settings", section: "agents" });
    expect(byId.cfg.target).toEqual({ type: "config-file" });
    expect(byId.git.target).toEqual({ type: "git-panel", projectId: "p1" });
    expect(byId.badgit.target).toBeUndefined();
  });
});

describe("markKindRead", () => {
  it("marks only matching unread items of the kind", () => {
    const { actions } = useNotificationsStore.getState();
    const base = { source: "agent" as const, title: "t", body: "b" };
    actions.add({
      ...base,
      kind: "agent-sign-in",
      target: { type: "agent-sign-in", agentType: "a" },
    });
    actions.add({
      ...base,
      kind: "agent-sign-in",
      target: { type: "agent-sign-in", agentType: "b" },
    });
    actions.add({ ...base, kind: "agent-failed" });
    actions.markKindRead(
      "agent-sign-in",
      (i) => i.target?.type === "agent-sign-in" && i.target.agentType === "a",
    );
    const read = useNotificationsStore
      .getState()
      .items.filter((i) => i.read)
      .map((i) => i.kind);
    expect(read).toEqual(["agent-sign-in"]);
  });
});

describe("item actions", () => {
  const KEY = "atlas-notifications";
  const gitTarget = { type: "git-panel" as const, projectId: "p1" };
  const addGit = (actions: { id: string; label: string }[]) =>
    useNotificationsStore.getState().actions.add({
      kind: "git-behind",
      source: "app",
      title: "main has diverged from its remote",
      body: "b",
      target: gitTarget,
      actions,
    });

  it("keeps actions beyond Open, at most two, dropping malformed ones", () => {
    expect(cleanActions([{ id: "open", label: "Open" }])).toBeUndefined();
    expect(
      cleanActions([
        { id: "git.choose-pull", label: "Rebase or merge…" },
        { id: "", label: "x" },
        { id: "y" },
        7,
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]),
    ).toEqual([
      { id: "git.choose-pull", label: "Rebase or merge…" },
      { id: "a", label: "A" },
    ]);
    expect(cleanActions("nope")).toBeUndefined();
  });

  it("cleanActions keeps an action's string args and drops anything else in them", () => {
    expect(
      cleanActions([
        { id: "agents.retry-update", label: "Retry", args: { pluginId: "cursor", n: 1 } },
        { id: "b", label: "B", args: "nope" },
      ]),
    ).toEqual([
      { id: "agents.retry-update", label: "Retry", args: { pluginId: "cursor" } },
      { id: "b", label: "B" },
    ]);
  });

  it("resolving an item marks it read and drops its actions; reading it does not", () => {
    addGit([{ id: "git.choose-pull", label: "Rebase or merge…" }]);
    const { actions } = useNotificationsStore.getState();
    actions.markReadWhere(() => true);
    expect(useNotificationsStore.getState().items[0].actions).toHaveLength(1);
    actions.resolveWhere((i) => i.kind === "git-behind");
    const [item] = useNotificationsStore.getState().items;
    expect(item).toMatchObject({ read: true, resolved: true });
    expect(item.actions).toBeUndefined();
  });

  it("restores actions on rehydrate, but never for a resolved item", async () => {
    const item = (id: string, extra: object) => ({
      id,
      kind: "git-behind",
      title: "t",
      body: "b",
      timestamp: new Date(0).toISOString(),
      source: "app",
      target: gitTarget,
      read: false,
      ...extra,
    });
    const actions = [{ id: "git.choose-pull", label: "Rebase or merge…" }];
    const items = [
      item("live", { actions }),
      item("done", { actions, resolved: true }),
      item("bad", { actions: [{ id: 3 }] }),
    ];
    localStorage.setItem(KEY, JSON.stringify({ state: { items }, version: 1 }));
    await useNotificationsStore.persist.rehydrate();
    const byId = Object.fromEntries(useNotificationsStore.getState().items.map((i) => [i.id, i]));
    expect(byId.live.actions).toEqual(actions);
    expect(byId.done.actions).toBeUndefined();
    expect(byId.bad.actions).toBeUndefined();
  });
});
