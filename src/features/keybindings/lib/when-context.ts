/**
 * The values `when` expressions are evaluated against, read fresh on every
 * keydown — cheaper than keeping a context store in step with focus.
 *
 * Surface focus follows the focused split's active tab, the same rule the
 * panels' own gates use (`useScopedHotkeys`' `tabId`): clicking a pane moves
 * pane focus without moving DOM focus. DOM focus inside an element marked
 * `data-when-scope="<variable>"` also sets that variable — that is how the
 * terminal and the model picker report themselves, and a marked surface takes
 * surface focus from the tab.
 */

import type { TabType } from "@/lib/constants";
import { deepActiveElement, shadowHost } from "@/lib/deep-active-element";
import { isLinux, isMac, isWindows } from "@/lib/platform";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { SURFACE_FOCUS_VARIABLES, type WhenContext } from "./when";

const TAB_SURFACE: Partial<Record<TabType, string>> = {
  terminal: "terminalFocus",
  chat: "chatFocus",
  editor: "editorFocus",
  knowledge: "knowledgeFocus",
  pdf: "pdfFocus",
  canvas: "canvasFocus",
  spaces: "canvasFocus",
  browser: "browserFocus",
  diff: "diffFocus",
  "session-changes": "diffFocus",
  "pull-request": "pullRequestFocus",
};

function isTextInput(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function liveWhenContext(): WhenContext {
  const ctx: Record<string, boolean> = { isMac, isWindows, isLinux };

  const { tabs, activeTabId, destination, destinationShown } = useLayoutStore.getState();
  // A destination on screen is what the keyboard is in (ADR-0024).
  const tab =
    destinationShown && destination
      ? destination
      : activeTabId
        ? tabs.find((t) => t.id === activeTabId)
        : undefined;
  const surface = tab ? TAB_SURFACE[tab.type] : undefined;
  if (surface) ctx[surface] = true;
  if (tab?.type === "knowledge") ctx.knowledgeOpen = true;

  const active = typeof document !== "undefined" ? deepActiveElement() : null;
  ctx.inputFocus = isTextInput(active);
  // Up through shadow hosts too: focus inside the file view's shadow root
  // still sits in the scopes around its host.
  for (let el = active; el; el = el.parentElement ?? shadowHost(el)) {
    const scope = el.getAttribute("data-when-scope");
    if (!scope) continue;
    if ((SURFACE_FOCUS_VARIABLES as readonly string[]).includes(scope)) {
      for (const v of SURFACE_FOCUS_VARIABLES) ctx[v] = false;
    }
    ctx[scope] = true;
  }
  return ctx;
}
