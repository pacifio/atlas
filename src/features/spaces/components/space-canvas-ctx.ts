import { createContext, useContext } from "react";
import type * as Y from "yjs";

/**
 * What a space node component needs from its surface: the live doc to write
 * into and whether writes are allowed. Nodes read their *display* data from
 * xyflow props (rebuilt per revision); writes go straight to the Y.Doc in a
 * LOCAL transaction — the doc is the state, there is no store mirror.
 */
export interface SpaceCanvasCtx {
  convId: string;
  doc: () => Y.Doc | null;
  readOnly: boolean;
}

export const SpaceCanvasContext = createContext<SpaceCanvasCtx | null>(null);

export function useSpaceCanvas(): SpaceCanvasCtx {
  const ctx = useContext(SpaceCanvasContext);
  if (!ctx) throw new Error("useSpaceCanvas outside SpaceCanvasContext");
  return ctx;
}
