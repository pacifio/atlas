import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface IconPickerProps {
  value: string | null;
  anchorRect: DOMRect | null;
  onPick: (icon: string | null) => void;
  onClose: () => void;
}

/** Curated emoji grid for page icons. Three rows by topic so it stays
 *  short — full emoji-mart would be overkill for this slot. Users can
 *  type in any character via the free-form field at the bottom. */
const GROUPS: Array<{ label: string; emojis: string[] }> = [
  {
    label: "Documents",
    emojis: [
      "📄",
      "📝",
      "📖",
      "📕",
      "📗",
      "📘",
      "📙",
      "📚",
      "📓",
      "📔",
      "📋",
      "📑",
      "📰",
      "🗒️",
      "🗂️",
      "🗃️",
      "🗄️",
    ],
  },
  {
    label: "Symbols",
    emojis: [
      "✦",
      "✧",
      "✩",
      "✪",
      "✫",
      "★",
      "☆",
      "❖",
      "◆",
      "◇",
      "●",
      "○",
      "▲",
      "△",
      "■",
      "□",
      "▪",
      "▫",
    ],
  },
  {
    label: "Tech",
    emojis: [
      "💻",
      "🖥️",
      "⌨️",
      "🖱️",
      "💾",
      "💿",
      "🧠",
      "⚙️",
      "🔧",
      "🛠️",
      "🔩",
      "🧪",
      "🧬",
      "🧮",
      "📡",
      "🛰️",
    ],
  },
  {
    label: "Concepts",
    emojis: [
      "💡",
      "🔥",
      "⚡",
      "✨",
      "🌟",
      "🎯",
      "🚀",
      "🛸",
      "🌐",
      "🧭",
      "🗺️",
      "📌",
      "📍",
      "🎨",
      "🏗️",
      "🧱",
    ],
  },
  {
    label: "People",
    emojis: ["👤", "👥", "🧑‍💻", "🧑‍🔬", "🧑‍🏫", "🤖", "🦾", "💬", "🗣️", "💭"],
  },
  {
    label: "Time",
    emojis: ["📅", "🗓️", "⏰", "⏱️", "⏳", "🕰️", "📆"],
  },
];

export function IconPicker({ value, anchorRect, onPick, onClose }: IconPickerProps) {
  const [draft, setDraft] = useState(value ?? "");
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(value ?? ""), [value]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!anchorRect) return null;
  const PICKER_W = 320;
  // Anchor immediately under the icon tile. Clamp to viewport so the
  // popup doesn't leak off-screen when the tile sits near the edge.
  const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - PICKER_W - 8);
  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 320);

  // Portal into document.body so an ancestor with `transform` /
  // `overflow: hidden` / scrolling can't pull the fixed-position popup
  // out of place (the editor body sits inside a scroller).
  return createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed",
        left,
        top,
        width: PICKER_W,
        maxHeight: 360,
        overflowY: "auto",
        background: "var(--bg-overlay)",
        border: "1px solid var(--border-strong)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        zIndex: 1000,
        padding: 8,
      }}
    >
      {GROUPS.map((g) => (
        <div key={g.label} style={{ marginBottom: 6 }}>
          <div className="eyebrow" style={{ fontSize: 9.5, padding: "4px 4px 2px" }}>
            {g.label}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(8, 1fr)",
              gap: 2,
            }}
          >
            {g.emojis.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  onPick(e);
                  onClose();
                }}
                title={e}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 5,
                  background: value === e ? "var(--bg-active)" : "transparent",
                  border: 0,
                  fontSize: 18,
                  lineHeight: 1,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(ev) => {
                  if (value !== e) ev.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(ev) => {
                  if (value !== e) ev.currentTarget.style.background = "transparent";
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div
        style={{
          marginTop: 6,
          paddingTop: 8,
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onPick(draft.trim() || null);
              onClose();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="Custom emoji or text…"
          style={{
            flex: 1,
            height: 26,
            padding: "0 8px",
            background: "var(--bg-input)",
            border: "1px solid var(--border-default)",
            borderRadius: 5,
            fontSize: 12,
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onPick(null);
              onClose();
            }}
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              padding: "0 6px",
            }}
            title="Remove icon"
          >
            clear
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
