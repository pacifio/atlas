// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { DEFAULT_SETTINGS } from "./app-settings";
import type { ProjectSettingsInfo } from "./project-settings-api";

const updateProjectSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock("./atlas-config-api", () => ({
  updateSettings: vi.fn(),
  resetConfig: vi.fn(),
  onConfigChanged: () => Promise.resolve(() => {}),
  onConfigError: () => Promise.resolve(() => {}),
}));
vi.mock("./project-settings-api", () => ({
  getProjectSettings: () => new Promise(() => {}),
  updateProjectSettings: (...args: unknown[]) => updateProjectSettings(...args),
}));

const { useSettingsStore } = await import("../stores/settings-store");
const { useProjectSettingsStore, projectValue } = await import("../stores/project-settings-store");
const { PageScopeContext, useScopedSetting } = await import("./use-scoped-setting");

const PROJECT = "/work/app";
const info = (values: ProjectSettingsInfo["values"]): ProjectSettingsInfo => ({
  path: `${PROJECT}/.atlas/config.toml`,
  values,
  ignoredKeys: [],
  refusedKeys: [],
  error: null,
});

const inScope =
  (scope: string | null) =>
  ({ children }: { children: ReactNode }) => (
    <PageScopeContext.Provider value={scope}>{children}</PageScopeContext.Provider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, gitAutoFetch: true },
    actions: { ...useSettingsStore.getState().actions, updateSettings },
  });
  useProjectSettingsStore.setState({ byPath: { [PROJECT]: info({}) } });
});

describe("projectValue", () => {
  it("is the project's override when it has one, else the global value", () => {
    const byPath = { [PROJECT]: info({ gitAutoFetch: false }) };
    const global = { ...DEFAULT_SETTINGS, gitAutoFetch: true };
    expect(projectValue(byPath, PROJECT, "gitAutoFetch", global)).toBe(false);
    expect(projectValue(byPath, "/elsewhere", "gitAutoFetch", global)).toBe(true);
    expect(projectValue(byPath, null, "gitAutoFetch", global)).toBe(true);
  });
});

describe("useScopedSetting", () => {
  it("edits the global file under All projects", () => {
    const { result } = renderHook(() => useScopedSetting("gitAutoFetch"), {
      wrapper: inScope(null),
    });
    expect(result.current.value).toBe(true);
    act(() => result.current.set(false));
    expect(updateSettings).toHaveBeenCalledWith({ gitAutoFetch: false });
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  it("inherits under a project until the project overrides it", () => {
    const { result, rerender } = renderHook(() => useScopedSetting("gitAutoFetch"), {
      wrapper: inScope(PROJECT),
    });
    expect(result.current).toMatchObject({ value: true, overridden: false, resettable: false });

    act(() =>
      useProjectSettingsStore.setState({ byPath: { [PROJECT]: info({ gitAutoFetch: false }) } }),
    );
    rerender();
    expect(result.current).toMatchObject({ value: false, overridden: true, resettable: true });
  });

  it("writes and clears the project's override, never the global file", async () => {
    updateProjectSettings.mockResolvedValue(info({ gitAutoFetch: false }));
    const { result } = renderHook(() => useScopedSetting("gitAutoFetch"), {
      wrapper: inScope(PROJECT),
    });
    act(() => result.current.set(false));
    expect(updateProjectSettings).toHaveBeenLastCalledWith(PROJECT, { gitAutoFetch: false });
    act(() => result.current.reset());
    expect(updateProjectSettings).toHaveBeenLastCalledWith(PROJECT, { gitAutoFetch: null });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("locks a tighten-only key that is off for all projects", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, agentCodeTools: false } });
    const { result } = renderHook(() => useScopedSetting("agentCodeTools"), {
      wrapper: inScope(PROJECT),
    });
    expect(result.current.globalOnly).toBe(true);
    expect(result.current.lockedReason).toMatch(/never on/);
  });

  it("keeps a tighten-only row locked, but resettable, when the project already turned it off", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, agentCodeTools: false } });
    useProjectSettingsStore.setState({ byPath: { [PROJECT]: info({ agentCodeTools: false }) } });
    const { result } = renderHook(() => useScopedSetting("agentCodeTools"), {
      wrapper: inScope(PROJECT),
    });
    expect(result.current).toMatchObject({ globalOnly: true, overridden: true, resettable: true });
  });

  it("lets a project turn a tighten-only key off", () => {
    const { result } = renderHook(() => useScopedSetting("agentCodeTools"), {
      wrapper: inScope(PROJECT),
    });
    expect(result.current.globalOnly).toBe(false);
  });

  it("marks a key a project cannot set as global-only", () => {
    const { result } = renderHook(() => useScopedSetting("enterToSend"), {
      wrapper: inScope(PROJECT),
    });
    expect(result.current.globalOnly).toBe(true);
    expect(result.current.resettable).toBe(false);
  });
});
