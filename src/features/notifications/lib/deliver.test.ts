import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  add: vi.fn(),
  showNative: vi.fn(),
  chime: vi.fn(),
  openGitPanel: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/features/chat/lib/tab-project", () => ({ jumpToSession: vi.fn() }));
vi.mock("@/features/terminal/lib/jump-to-terminal", () => ({ jumpToTerminal: vi.fn() }));
vi.mock("@/lib/window-focus", () => ({ isWindowFocused: () => true }));
vi.mock("@/lib/notification-icon", () => ({ agentBannerIconPath: vi.fn() }));
vi.mock("@/lib/native-notify", () => ({
  nativeCapabilities: () => ({ images: false }),
  primeNativeNotificationPermission: vi.fn(),
  setNativeResponseHandler: vi.fn(),
  showNativeNotification: h.showNative,
}));
vi.mock("@/lib/chime", () => ({ playChime: h.chime }));
vi.mock("@/lib/dock-badge", () => ({ setDockBadge: vi.fn() }));
vi.mock("@/features/chat/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ sessions: {} }) },
}));
vi.mock("../components/notification-leading-icon", () => ({ notificationToastIcon: () => null }));
vi.mock("../stores/notifications-store", () => ({
  useNotificationsStore: { getState: () => ({ actions: { add: h.add }, items: [] }) },
}));
vi.mock("@/features/auth/stores/auth-store", () => ({ useAuthStore: { getState: vi.fn() } }));
vi.mock("@/features/chat/lib/agent-signin", () => ({ promptSignIn: vi.fn() }));
vi.mock("@/features/comms/stores/comms-store", () => ({ commsActions: vi.fn() }));
vi.mock("@/features/settings/lib/atlas-config-api", () => ({ openConfigFile: vi.fn() }));
vi.mock("@/features/git/lib/open-git-panel", () => ({ openGitPanel: h.openGitPanel }));
vi.mock("@/features/settings/lib/open-settings", () => ({ openSettingsSection: vi.fn() }));
vi.mock("@/features/updater/lib/restart-to-update", () => ({
  openUpdatePrompt: vi.fn(),
  restartToUpdate: vi.fn(),
}));
vi.mock("./permission-actions", () => ({ answerPermissionFromBanner: vi.fn() }));

import type { NotificationDecision } from "./decide";
import { deliverNotification } from "./deliver";
import { registerNotificationAction } from "./notification-actions";

let n = 0;
const decision = (over: Partial<NotificationDecision> = {}): NotificationDecision => ({
  kind: "git-behind",
  tier: "warning",
  title: "main has diverged from its remote",
  body: "3 local commits and 1 commit on the remote.",
  target: { type: "git-panel", projectId: "p1" },
  dedupeKey: `k${++n}`,
  groupKey: "git:p1",
  channels: { center: true, toast: true, native: true, badge: false, sound: false },
  actions: [
    { id: "git.choose-pull", label: "Rebase or merge…" },
    { id: "open", label: "Open" },
  ],
  toast: { variant: "default", durationMs: 15_000 },
  native: { title: "t", body: "b" },
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("deliverNotification", () => {
  it("keeps going when a channel throws: the center fails, the toast and banner still fire", () => {
    h.add.mockImplementationOnce(() => {
      throw new Error("store broke");
    });
    expect(deliverNotification(decision())).toBe(true);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.showNative).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("center failed for git-behind"),
      expect.any(Error),
    );
  });

  it("contains a rejecting banner instead of leaving it unhandled", async () => {
    h.showNative.mockRejectedValueOnce(new Error("notifier down"));
    deliverNotification(decision());
    await flush();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("native failed"),
      expect.any(Error),
    );
  });

  it("puts the first two actions on the toast, and each runs its handler", async () => {
    const choose = vi.fn();
    const off = registerNotificationAction("git.choose-pull", choose);
    deliverNotification(decision());
    const opts = h.toast.mock.calls[0][1];
    expect(opts.action.label).toBe("Rebase or merge…");
    expect(opts.cancel.label).toBe("Open");
    opts.action.onClick();
    await flush();
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "git-behind",
        target: { type: "git-panel", projectId: "p1" },
      }),
    );
    opts.cancel.onClick();
    await flush();
    expect(h.openGitPanel).toHaveBeenCalledWith("p1");
    off();
  });

  it("gives the banner every action but Open; a lone Open leaves it without buttons", () => {
    deliverNotification(decision());
    expect(h.showNative.mock.calls[0][0].actions).toEqual([
      { id: "git.choose-pull", label: "Rebase or merge…" },
    ]);
    deliverNotification(decision({ actions: [{ id: "open", label: "Open" }] }));
    expect(h.showNative.mock.calls[1][0].actions).toBeUndefined();
  });

  it("hands an action's args to its handler from the toast", async () => {
    const retry = vi.fn();
    const off = registerNotificationAction("agents.retry-update", retry);
    deliverNotification(
      decision({
        actions: [{ id: "agents.retry-update", label: "Retry", args: { pluginId: "cursor" } }],
      }),
    );
    h.toast.mock.calls[0][1].action.onClick();
    await flush();
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ args: { pluginId: "cursor" } }));
    off();
  });

  it("carries action args in the banner payload, not on its buttons", () => {
    deliverNotification(
      decision({
        actions: [
          { id: "agents.retry-update", label: "Retry", args: { pluginId: "cursor" } },
          { id: "open", label: "Open" },
        ],
      }),
    );
    const req = h.showNative.mock.calls[0][0];
    expect(req.actions).toEqual([
      { id: "agents.retry-update", label: "Retry", destructive: undefined },
    ]);
    expect(JSON.parse(req.payload).args).toEqual({ "agents.retry-update": { pluginId: "cursor" } });
  });

  it("gives the center item every action but Open (the card itself opens)", () => {
    deliverNotification(decision());
    expect(h.add.mock.calls[0][0].actions).toEqual([
      { id: "git.choose-pull", label: "Rebase or merge…" },
    ]);
  });

  it("announces each dedupe key once", () => {
    const d = decision();
    expect(deliverNotification(d)).toBe(true);
    expect(deliverNotification(d)).toBe(false);
    expect(h.toast).toHaveBeenCalledTimes(1);
  });
});
