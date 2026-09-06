import { PanelSkeleton } from "atlas";

/** Static bars (no shimmer) so a lazy panel shows structure, not a spinner. */
export const Default = () => (
  <div style={{ width: 260 }}>
    <PanelSkeleton />
  </div>
);

export const WithLabel = () => (
  <div style={{ width: 260 }}>
    <PanelSkeleton label="Loading changes…" />
  </div>
);

export const FewRows = () => (
  <div style={{ width: 260 }}>
    <PanelSkeleton rows={3} label="Loading sessions…" />
  </div>
);

export const ManyRows = () => (
  <div style={{ width: 260 }}>
    <PanelSkeleton rows={10} />
  </div>
);
