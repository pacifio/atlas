import { useCallback, useEffect, useRef, useState } from "react";
import { X, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "../stores/canvas-store";
import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "@/features/editor-notion/components/tiptap-editor";
import { IconPicker } from "@/features/knowledge/components/icon-picker";
import { ensureKnowledgeMentionCache } from "@/features/chat/lib/mentions";

interface NoteEditorPanelProps {
  noteId: string;
  projectPath: string;
  onClose: () => void;
  onJumpToNode?: (id: string) => void;
}

/**
 * Immersive slide-in editor for a canvas note — mirrors the notification panel
 * (right-in slide + backdrop blur + scrim). Reuses the KB `TiptapEditor` for the
 * body (so `@`-mentions to KB notes / repos work) and the KB `IconPicker` for the
 * emoji. Save follows the KB lesson: gate on the editor's live `isDirty()` and
 * flush on close / blur / unmount — never on a store-content baseline.
 */
export function NoteEditorPanel({
  noteId,
  projectPath,
  onClose,
}: NoteEditorPanelProps) {
  const nodes = useCanvasStore.use.nodes();
  const { updateNote, deleteNote } = useCanvasStore.use.actions();
  const note = nodes.find((n) => n.id === noteId) ?? null;

  const editorRef = useRef<TiptapEditorHandle>(null);
  const [iconAnchor, setIconAnchor] = useState<DOMRect | null>(null);

  // Warm the knowledge mention cache so the @-picker resolves KB notes/repos.
  useEffect(() => {
    void ensureKnowledgeMentionCache(projectPath);
  }, [projectPath]);

  const flushBody = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || !ed.isDirty()) return;
    void ed.flush().then((md) => {
      if (md !== null) updateNote(noteId, { body: md });
    });
  }, [noteId, updateNote]);

  // Flush on app blur + on unmount (e.g. switching to a connected note remounts
  // this panel via its `key`, so the outgoing note's body is saved first).
  useEffect(() => {
    const onBlur = () => flushBody();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      flushBody();
    };
  }, [flushBody]);

  const close = useCallback(() => {
    flushBody();
    onClose();
  }, [flushBody, onClose]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);

  // If the note was deleted out from under us, close.
  useEffect(() => {
    if (!note) onClose();
  }, [note, onClose]);

  if (!note) return null;

  return (
    <>
      {/* Scrim */}
      <div
        className="fixed inset-0 z-[9998] bg-black/10 animate-fade-in"
        onClick={close}
        aria-hidden
      />
      {/* Panel */}
      <aside
        className={cn(
          "fixed right-0 top-0 bottom-0 z-[9999] w-[400px] flex flex-col",
          "border-l border-[var(--border-default)]",
          "bg-[var(--bg-elevated)]/60 backdrop-blur-2xl backdrop-saturate-150",
          "shadow-[var(--shadow-overlay)] animate-slide-in-right",
        )}
      >
        {/* Header — matches the tab-bar height (29px) so the two rows align. */}
        <div className="flex items-center gap-1.5 px-2 h-[29px] border-b border-border-default shrink-0">
          <button
            type="button"
            title="Change icon"
            onClick={(e) =>
              setIconAnchor(e.currentTarget.getBoundingClientRect())
            }
            className="flex h-5 w-5 items-center justify-center rounded-md bg-white/10 hover:bg-white/15 transition-colors cursor-pointer shrink-0"
          >
            {note.icon ? (
              <span className="text-[12px] leading-none">{note.icon}</span>
            ) : (
              <span className="text-[11px] leading-none text-white/60">＋</span>
            )}
          </button>
          <input
            value={note.title}
            onChange={(e) => updateNote(noteId, { title: e.target.value })}
            placeholder="Untitled"
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
          />
          <button
            type="button"
            onClick={() => {
              deleteNote(noteId);
              onClose();
            }}
            title="Delete note"
            className="p-1 rounded hover:bg-white/10 text-[var(--text-tertiary)] hover:text-[var(--status-error)] cursor-pointer transition-colors"
          >
            <Trash2 size={12} />
          </button>
          <button
            type="button"
            onClick={close}
            title="Close"
            className="p-1 rounded hover:bg-white/10 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
          >
            <X size={12} />
          </button>
        </div>

        {/* Body — the editor fills the full width + height with comfortable
            padding. `!bg-transparent` drops the editor's default #000 so it
            shows the panel surface (matches the sidebar background). */}
        <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar px-5">
          <TiptapEditor
            ref={editorRef}
            documentId={`canvas:${noteId}`}
            initialMarkdown={note.body}
            placeholder="Write… use @ to reference a note or repo"
            className="min-h-full !bg-transparent"
          />
        </div>
      </aside>

      {iconAnchor && (
        <IconPicker
          value={note.icon ?? null}
          anchorRect={iconAnchor}
          onPick={(v) => updateNote(noteId, { icon: v ?? "" })}
          onClose={() => setIconAnchor(null)}
        />
      )}
    </>
  );
}
