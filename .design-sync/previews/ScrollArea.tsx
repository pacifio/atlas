import { ScrollArea } from "atlas";

const rows = [
  "chat-panel.tsx",
  "message-input.tsx",
  "session-sidebar.tsx",
  "chat-header.tsx",
  "use-pane-find.ts",
  "transcript-state.ts",
  "turn-card.tsx",
  "plan-dock.tsx",
  "permission-modal.tsx",
  "model-picker.tsx",
];

/** A plain overflow container — the scroll primitive Atlas panels sit in. */
export const Vertical = () => (
  <ScrollArea style={{ height: 150, width: 240 }}>
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((r) => (
        <div
          key={r}
          style={{
            padding: "5px 8px",
            fontSize: 11.5,
            color: "var(--text-secondary)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {r}
        </div>
      ))}
    </div>
  </ScrollArea>
);

export const Horizontal = () => (
  <ScrollArea style={{ width: 240 }}>
    <div style={{ display: "flex", gap: 8, width: 520 }}>
      {["Chat", "Editor", "Terminal", "Knowledge", "Timeline", "Spaces"].map((t) => (
        <span
          key={t}
          style={{
            whiteSpace: "nowrap",
            borderRadius: 4,
            background: "var(--bg-raised)",
            padding: "4px 10px",
            fontSize: 11.5,
            color: "var(--text-secondary)",
          }}
        >
          {t}
        </span>
      ))}
    </div>
  </ScrollArea>
);

export const ShortContent = () => (
  <ScrollArea style={{ height: 150, width: 240 }}>
    <div style={{ padding: 8, fontSize: 11.5, color: "var(--text-secondary)" }}>
      Content shorter than the box — no scrollbar appears.
    </div>
  </ScrollArea>
);
