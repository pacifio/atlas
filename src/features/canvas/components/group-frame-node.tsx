import { memo } from "react";

/** A subtle dashed frame behind an AI group's members. Rendered as a
 *  non-interactive React Flow node placed FIRST in the node array (and thus
 *  painted below every real node), so nodes always sit above the border. */
export const GroupFrameNode = memo(function GroupFrameNode() {
  return (
    <div className="h-full w-full rounded-lg border border-dashed border-white/30" />
  );
});
