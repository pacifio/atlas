import { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";

export interface OutlineHeading {
  /** Stable slug derived from text — stable across edits as long as the
   *  heading text doesn't change. Suffixed with the doc index if two
   *  headings end up with the same slug. */
  id: string;
  label: string;
  level: 2 | 3;
  /** ProseMirror doc position of the heading node (use with
   *  `editor.view.coordsAtPos(pos)` or `setTextSelection(pos)`). */
  pos: number;
}

function slugify(text: string): string {
  return (
    "h-" +
    text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60)
  );
}

/** Walk the doc once and emit headings — used by both the hook and any
 *  imperative callers that just want a snapshot. */
export function extractOutline(editor: Editor): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const slugCount = new Map<string, number>();
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const level = node.attrs.level as number;
    if (level !== 2 && level !== 3) return true;
    const label = node.textContent.trim();
    if (!label) return true;
    const base = slugify(label);
    const n = slugCount.get(base) ?? 0;
    slugCount.set(base, n + 1);
    out.push({
      id: n === 0 ? base : `${base}-${n}`,
      label,
      level: level as 2 | 3,
      pos,
    });
    return false; // headings have no nested headings
  });
  return out;
}

/** Outline that stays in sync with the editor's content. */
export function useEditorOutline(editor: Editor | null): OutlineHeading[] {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const bump = () => setVersion((v) => v + 1);
    editor.on("update", bump);
    editor.on("create", bump);
    return () => {
      editor.off("update", bump);
      editor.off("create", bump);
    };
  }, [editor]);
  return useMemo(
    () => (editor ? extractOutline(editor) : []),
    // version forces recompute when the editor reports an update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, version],
  );
}

/** Returns the id of the heading whose top is closest to (but above) the
 *  scroll container's top. Recomputes on scroll + on outline changes. */
export function useActiveHeading(
  editor: Editor | null,
  headings: OutlineHeading[],
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!editor || headings.length === 0) {
      setActiveId(null);
      return;
    }
    let view;
    try {
      view = editor.view;
    } catch {
      return;
    }
    const scroller = findScrollParent(view.dom);
    if (!scroller) return;

    const update = () => {
      const scrollTop = scroller.getBoundingClientRect().top;
      let best: { id: string; delta: number } | null = null;
      for (const h of headings) {
        try {
          const coords = view.coordsAtPos(h.pos);
          // Want the heading whose top is closest to (but not past)
          // the scroller top. A small offset lets the next heading
          // "claim" the active state slightly before it hits the very
          // top, which feels right when reading.
          const delta = coords.top - (scrollTop + 24);
          if (delta <= 0) {
            if (!best || Math.abs(delta) < Math.abs(best.delta)) {
              best = { id: h.id, delta };
            }
          }
        } catch {
          // ignore — position may be stale mid-transaction
        }
      }
      setActiveId(best?.id ?? headings[0]?.id ?? null);
    };

    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [editor, headings]);

  return activeId;
}

/** Scroll to the heading at the given doc position, centered-ish. */
export function jumpToHeading(editor: Editor, pos: number): void {
  let view;
  try {
    view = editor.view;
  } catch {
    return;
  }
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  if (dom?.scrollIntoView) {
    dom.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // Fallback: dispatch a scroll-into-view tr at the position.
  try {
    const { state } = view;
    const tr = state.tr
      .setSelection(
        // setTextSelection via tr.doc helper isn't on Transaction; let the
        // chain command do it instead.
        state.selection,
      )
      .scrollIntoView();
    void tr;
    editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
  } catch {
    // ignore
  }
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el?.parentElement ?? null;
  while (cur) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      cur.scrollHeight > cur.clientHeight
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}
