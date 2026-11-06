// The Organisation agent's mark: Lucide's `MousePointer2`, filled — a cursor,
// the agent acting in the app on your behalf. One component so every place
// that names the agent (the sidebar row, the destination bar, its tab, the
// bar's Agent button, the palette) draws the same glyph. Typed as a Lucide
// icon, so it drops into anything that takes one (`DESTINATIONS`, `Icon`).

import { forwardRef } from "react";
import { MousePointer2, type LucideIcon, type LucideProps } from "lucide-react";

export const AgentIcon = forwardRef<SVGSVGElement, LucideProps>(function AgentIcon(props, ref) {
  return <MousePointer2 ref={ref} fill="currentColor" {...props} />;
}) as LucideIcon;
