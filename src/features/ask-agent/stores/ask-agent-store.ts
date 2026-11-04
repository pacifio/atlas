// The one ask box: what it was opened with and what it is anchored to. Any
// surface opens it (`openAskAgent` in `../lib/ask-agent.ts`); `AskAgentHost`,
// mounted once at the app root, draws it. Plain zustand, not Immer: the
// anchor is a DOM element.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import type { AgentContext } from "../lib/agent-context";
import type { AskResult } from "../lib/ask-agent";

/** What the box grows out of: an element, a rect (an element about to go
 *  away, such as a closing dialog's button), or nothing (centred near the
 *  top of the window). */
export type AskAnchor = Element | DOMRect | null;

export interface AskRequest {
  context: readonly AgentContext[];
  prompt?: string;
  /** Quick prompts the box offers as one-click fills ("Explain this change"). */
  suggestions?: readonly string[];
  anchor: AskAnchor;
  /** Opens with this session picked; else the session in view. */
  target?: string;
  /** Called once the box has handed the ask over (sent or drafted), not
   *  when it is cancelled: a surface that holds what it asked about (a
   *  review's comments) lets it go here. `kept` is which of `context` (by
   *  index) went with it: the user may have taken chips out. */
  onAsked?: (result: AskResult, kept: readonly number[]) => void;
}

interface AskAgentStoreState {
  /** Null while closed. */
  request: AskRequest | null;
  /** Bumped on every open, so a second open while open starts fresh. */
  serial: number;
  actions: {
    open: (request: AskRequest) => void;
    close: () => void;
  };
}

export const useAskAgentStore = createSelectors(
  create<AskAgentStoreState>()((set) => ({
    request: null,
    serial: 0,
    actions: {
      open: (request) => set((s) => ({ request, serial: s.serial + 1 })),
      close: () => set({ request: null }),
    },
  })),
);
