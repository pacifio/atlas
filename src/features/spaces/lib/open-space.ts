/**
 * Opening a conversation's Space: the one way the app does it, shared by the
 * conversation header's Space button and the UI tool server's `ui_open`
 * (target `space_page`, Atlas Agent's "open it for me").
 *
 * The realtime canvas opens as a CENTER tab (like a draft), not a sub-tab — a
 * canvas wants the whole window and should not move when somebody posts a
 * message underneath it. Open-or-refocus, one tab per conversation.
 */
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { SpacePage } from "./spaces-api";
import { useSpacesStore } from "../stores/spaces-store";

/** The conversation's Space tab, focused — opened first when there is none.
 *  Answers its tab id. */
export function openSpaceTab(convId: string, title: string): string {
  const layout = useLayoutStore.getState();
  const tabId = `spaces-${convId}`;
  if (layout.tabs.some((t) => t.id === tabId)) {
    layout.actions.setActiveTab(tabId);
    return tabId;
  }
  layout.actions.addTab({
    id: tabId,
    type: "spaces",
    title: `${title} — Space`,
    closable: true,
    dirty: false,
    data: { convId },
  });
  return tabId;
}

/** The conversation's Space tab, focused on `pageId`: the canvas lands on it
 *  when it connects, or switches to it at once when it is already showing
 *  the Space (`use-space-session.ts` takes the request). */
export function openSpaceOnPage(convId: string, title: string, pageId: string): string {
  useSpacesStore.getState().actions.requestPage(convId, pageId);
  return openSpaceTab(convId, title);
}

/** The page a canvas shows when it connects: the page asked for through
 *  {@link openSpaceOnPage}, when it is a page in the tree; else the page the
 *  Space remembers as active; else the first page. `null` for a Space with
 *  no page. */
export function landingPage(
  pages: SpacePage[],
  remembered: string | null,
  asked: string | null,
): string | null {
  const isPage = (id: string | null) =>
    id !== null && pages.some((p) => p.id === id && p.kind === "page");
  if (isPage(asked)) return asked;
  if (isPage(remembered)) return remembered;
  return pages.find((p) => p.kind === "page")?.id ?? null;
}
