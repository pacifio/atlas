import { useCallback } from "react";

/** Drag-resize helpers. Each handle is a 4px-wide invisible strip on
 *  the panel border; mousedown captures pointer + listens for global
 *  mousemove until release. `from` is the side being resized. */
export function useKnowledgeResize(
  sidebarWidth: number,
  inspectorWidth: number,
  setKnowledgeSidebarWidth: (width: number) => void,
  setKnowledgeInspectorWidth: (width: number) => void,
) {
  return useCallback(
    (e: React.MouseEvent, from: "sidebar" | "inspector") => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = from === "sidebar" ? sidebarWidth : inspectorWidth;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        if (from === "sidebar") {
          setKnowledgeSidebarWidth(startW + dx);
        } else {
          // Inspector grows when dragged LEFT, so flip the delta.
          setKnowledgeInspectorWidth(startW - dx);
        }
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth, inspectorWidth, setKnowledgeSidebarWidth, setKnowledgeInspectorWidth],
  );
}
