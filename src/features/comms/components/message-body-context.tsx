// The member directory, handed to the mention chips.
//
// Its own module so the EAGER side (`message-body.tsx`, which provides it) and
// the LAZY side (`message-body-impl.tsx`, which consumes it) can share the
// context object without the provider dragging the markdown chunk in behind it.
//
// Context rather than a closure on purpose: it is what lets the component map
// in the impl be a module-level constant. A map rebuilt per render to capture
// `members` would defeat both `memo` on the row and react-markdown's own
// memoisation, on a component that re-renders for every reaction and hover.

import { createContext } from "react";
import type { OrgMemberProfile } from "../types";

export interface MentionDirectory {
  members: Map<string, OrgMemberProfile>;
  /** The current user — a mention of them is styled as addressed to you. */
  me: string;
}

const EMPTY: MentionDirectory = { members: new Map(), me: "" };

export const MentionContext = createContext<MentionDirectory>(EMPTY);
