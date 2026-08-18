import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Upload, X } from "lucide-react";
import { evictCoverUrl } from "../lib/cover-url-cache";

interface CoverPickerProps {
  value: string | null;
  projectPath: string;
  entryId: string;
  anchorRect: DOMRect | null;
  onPick: (cover: string | null) => void;
  onClose: () => void;
}

/** Synthetic prefixes the renderer detects to paint a gradient instead
 *  of loading an image off disk. */
const GRADIENTS: Array<{ id: string; css: string; label: string }> = [
  {
    id: "gradient:slate-1",
    label: "Slate fade",
    css: "linear-gradient(135deg, #1f1f1f, #2a2a2a 60%, #161616)",
  },
  {
    id: "gradient:warm-1",
    label: "Warm ember",
    css: "linear-gradient(135deg, #2a1d18, #382318 60%, #1d1411)",
  },
  {
    id: "gradient:moss-1",
    label: "Moss",
    css: "linear-gradient(135deg, #1a2422, #1f2e2a 60%, #131c1a)",
  },
  {
    id: "gradient:dusk-1",
    label: "Dusk",
    css: "linear-gradient(135deg, #1d1d2a, #232336 60%, #14141d)",
  },
  {
    id: "gradient:rose-1",
    label: "Rose",
    css: "linear-gradient(135deg, #271922, #36202d 60%, #1a1218)",
  },
  {
    id: "gradient:gold-1",
    label: "Honey",
    css: "linear-gradient(135deg, #2a2317, #36301a 60%, #1a1610)",
  },
];

export function gradientCss(id: string): string | null {
  return GRADIENTS.find((g) => g.id === id)?.css ?? null;
}

export function CoverPicker({
  value,
  projectPath,
  entryId,
  anchorRect,
  onPick,
  onClose,
}: CoverPickerProps) {
  const popRef = useRef<HTMLDivElement>(null);

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

  const handleUpload = async () => {
    try {
      const selected = await openFileDialog({
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      const rel = await invoke<string>("knowledge_cover_upload", {
        projectPath,
        entryId,
        srcPath: selected as string,
      });
      // The ref is entry-id-stable (`covers/<entryId>.<ext>`) — a re-upload
      // reuses it, so the cached data URL must go or the old image shows.
      evictCoverUrl(projectPath, rel);
      onPick(rel);
      onClose();
    } catch (e) {
      console.error("cover upload failed", e);
    }
  };

  if (!anchorRect) return null;
  const PICKER_W = 320;
  const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - PICKER_W - 8);
  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 280);

  return createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed",
        left,
        top,
        width: PICKER_W,
        background: "var(--bg-overlay)",
        border: "1px solid var(--border-strong)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        zIndex: 1000,
        padding: 8,
      }}
    >
      <div className="eyebrow" style={{ fontSize: 9.5, padding: "4px 4px 6px" }}>
        Gradient
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 6,
          marginBottom: 8,
        }}
      >
        {GRADIENTS.map((g) => (
          <button
            key={g.id}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onPick(g.id);
              onClose();
            }}
            title={g.label}
            style={{
              height: 50,
              borderRadius: 6,
              background: g.css,
              border:
                value === g.id ? "2px solid var(--text-primary)" : "1px solid var(--border-subtle)",
              cursor: "pointer",
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={handleUpload}
        style={{
          width: "100%",
          height: 28,
          background: "var(--bg-elevated-2)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 6,
          color: "var(--text-secondary)",
          fontSize: 12,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        }}
      >
        <Upload size={11} strokeWidth={1.6} /> Upload from disk
      </button>

      {value && (
        <button
          type="button"
          onMouseDown={(e) => {
            // Use mousedown so the outside-click handler (also on
            // mousedown) doesn't fire onClose mid-flight and racy-eat
            // the pick. preventDefault keeps focus from jumping.
            e.preventDefault();
            e.stopPropagation();
            onPick(null);
            onClose();
          }}
          style={{
            width: "100%",
            marginTop: 6,
            height: 24,
            background: "transparent",
            border: 0,
            color: "var(--text-tertiary)",
            fontSize: 11,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <X size={10} /> Remove cover
        </button>
      )}
    </div>,
    document.body,
  );
}
