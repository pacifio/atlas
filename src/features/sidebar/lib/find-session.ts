// "Find a session": show the sidebar and put the cursor in its search. The
// chat header's title is the way in from a session; the sidebar focuses the
// field when its request counter moves (`sidebar-store.ts`).

import { useProjectStore } from "@/features/projects/stores/project-store";
import { useSidebarStore } from "../stores/sidebar-store";

export function findSession(): void {
  useProjectStore.getState().actions.setSidebarOpen(true);
  // After the overlay has started to slide in: focusing a field that is
  // still `aria-hidden` and off screen would scroll the window to it.
  requestAnimationFrame(() => useSidebarStore.getState().actions.requestSearchFocus());
}
