import { TEAM_CHAT_TAB, useLayoutStore, type PlacementForm } from "../stores/layout-store";
import { destinationShown } from "./destinations";
import { revealSingleton, singletonShown } from "./singleton-surface";

/**
 * Team chat is both a surface and a destination (ADR-0024, amended
 * 2026-10-24): a tab beside a session, to answer someone while the agent
 * works, or the full window, to read the team's conversations. One per window
 * across both forms (`WINDOW_TYPES`): opening it in one form moves it out of
 * the other. It belongs to the window rather than the project, so it follows
 * the user between projects.
 *
 * The entry points pick the form:
 *  - the sidebar footer's button: the destination;
 *  - the surfaces pane's `+` menu and ⌘T: the surface (`openSurface`);
 *  - ⌘⇧C, the palette and the agent's UI tool: whichever form it was last
 *    shown in, the destination when it has never been shown.
 */

export type TeamChatForm = PlacementForm;

type LayoutSnapshot = ReturnType<typeof useLayoutStore.getState>;

/** Whether team chat is on screen as a surface tab. Selector-shaped. */
export function teamChatSurfaceShown(s: LayoutSnapshot): boolean {
  return singletonShown(s, "team-chat");
}

/** Whether team chat is the destination on screen. Selector-shaped. */
export function teamChatDestinationShown(s: LayoutSnapshot): boolean {
  return destinationShown(s, "team-chat");
}

/** Whether team chat is on screen, in either form. Selector-shaped. */
export function teamChatShown(s: LayoutSnapshot): boolean {
  return teamChatSurfaceShown(s) || teamChatDestinationShown(s);
}

/** The form team chat is in now (open, shown or not), else the form it was
 *  last shown in, else the destination. */
export function teamChatForm(s: LayoutSnapshot = useLayoutStore.getState()): TeamChatForm {
  if (s.destination?.type === "team-chat") return "destination";
  if (s.tabs.some((t) => t.type === "team-chat")) return "surface";
  return s.lastForm["team-chat"] ?? "destination";
}

/** Bring team chat on screen in `form` (default: `teamChatForm`), moving it
 *  out of the other form if it is there. */
export function revealTeamChat(form: TeamChatForm = teamChatForm()): void {
  if (form === "destination") useLayoutStore.getState().actions.showDestination(TEAM_CHAT_TAB);
  else revealSingleton(TEAM_CHAT_TAB);
}

/** ⌘⇧C: put team chat away when it is on screen (close the surface tab, or
 *  go back to the session from the destination, which stays mounted), else
 *  bring it back in the form it was last shown in. */
export function toggleTeamChat(): void {
  const s = useLayoutStore.getState();
  if (teamChatDestinationShown(s)) {
    s.actions.hideDestination();
    return;
  }
  if (teamChatSurfaceShown(s)) {
    const tab = s.tabs.find((t) => t.type === "team-chat");
    if (tab) s.actions.closeTab(tab.id);
    return;
  }
  revealTeamChat();
}

/** The sidebar footer's button: team chat as the destination, or back to the
 *  session when it is the destination on screen. */
export function toggleTeamChatDestination(): void {
  const s = useLayoutStore.getState();
  if (teamChatDestinationShown(s)) s.actions.hideDestination();
  else revealTeamChat("destination");
}
