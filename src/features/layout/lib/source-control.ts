import { useLayoutStore, type SourceControlSection, type Tab } from "../stores/layout-store";
import { revealSingleton, singletonShown, toggleSingleton } from "./singleton-surface";

/**
 * Source control is a surface: a singleton tab that opens in the surfaces
 * pane beside the agent, like every other surface.
 */

const TAB: Tab = {
  id: "source-control",
  type: "source-control",
  title: "Source control",
  closable: true,
  dirty: false,
  data: {},
};

/** Whether source control is on screen. Selector-shaped. */
export function sourceControlShown(s: ReturnType<typeof useLayoutStore.getState>): boolean {
  return singletonShown(s, "source-control");
}

/** Bring source control on screen, on `section` when given. */
export function revealSourceControl(section?: SourceControlSection): void {
  if (section) useLayoutStore.getState().actions.setSourceControlSection(section);
  revealSingleton(TAB);
}

/** ⌘⇧B: close source control when it is on screen, else reveal it. */
export function toggleSourceControl(): void {
  toggleSingleton(TAB);
}
