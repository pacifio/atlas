import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import "../tiptap.css";
import { cn } from "@/lib/utils";
import { buildExtensions } from "../lib/extensions";
import { dropCachedDoc, getCachedDoc, setCachedDoc } from "../lib/blocks-cache";
import { AtlasBubbleMenu } from "./bubble-menu";

export interface TiptapEditorHandle {
  /** Serialize the current editor state to markdown. Called at save
   *  points (Cmd+S, blur, entry switch). Returns the latest markdown,
   *  or `null` if the editor isn't mounted. */
  flush(): Promise<string | null>;
  /** Whether the doc has been mutated since it was loaded/seeded or since
   *  the last `flush()`. Backed by an internal ref (updated synchronously in
   *  `onUpdate`), so it's a race-free source of truth for "is there anything
   *  to save?" — unlike a React state flag set via a deferred callback. */
  isDirty(): boolean;
  /** Drop the current `documentId` from the in-memory document cache.
   *  Use after `delete_knowledge_note`. */
  evict(id: string): void;
  /** Escape hatch: expose the underlying Tiptap editor for future menu
   *  wiring (slash menu commands, bubble menu actions, outline TOC
   *  walker). Phase C+ consumers. */
  getEditor(): Editor | null;
}

export interface TiptapEditorProps {
  /** Stable identifier for the open document. Changing it triggers an
   *  in-place content swap (no editor remount). */
  documentId: string;
  /** Markdown source. Parsed once on first load for this `documentId`
   *  and cached as JSON; subsequent visits hit the cache and skip the
   *  reparse. */
  initialMarkdown: string;
  editable?: boolean;
  /** Fires the first time the user mutates the doc after a load.
   *  Caller can use this to mark the panel dirty without paying a
   *  per-keystroke markdown serialization. */
  onDirty?: () => void;
  className?: string;
  placeholder?: string;
}

/**
 * Atlas Tiptap editor. Replaces the prior BlockNote shell.
 *
 * Performance contract:
 *  - One editor instance for the lifetime of this React fiber.
 *    Switching documents calls `editor.commands.setContent` in place
 *    rather than tearing the editor down.
 *  - No markdown serialization on keystroke. The caller drives saves
 *    via `ref.current.flush()` at known boundaries.
 *  - Parsed docs live in a module-level cache so revisiting a
 *    previously-loaded document is synchronous (JSON, not markdown).
 */
export const TiptapEditor = forwardRef<TiptapEditorHandle, TiptapEditorProps>(
  function TiptapEditor(
    {
      documentId,
      initialMarkdown,
      editable = true,
      onDirty,
      className,
      placeholder,
    },
    ref,
  ) {
    const extensions = useMemo(
      () => buildExtensions({ placeholder }),
      [placeholder],
    );
    const loadedIdRef = useRef<string | null>(null);
    const dirtyRef = useRef(false);
    // Seed `swapping` true: tiptap dispatches an initial transaction
    // during the view-mount that fires onUpdate BEFORE onCreate runs,
    // so a parent setState there would land mid-render. onCreate
    // flips it false on the next microtask.
    const swappingRef = useRef(true);
    const onDirtyRef = useRef(onDirty);
    onDirtyRef.current = onDirty;
    // BubbleMenu reads `editor.view.dom` in a layout effect that runs
    // before EditorContent's view-mount layout effect (React commits
    // children bottom-up). Gate it until we know the view exists.
    const [viewReady, setViewReady] = useState(false);

    const editor = useEditor({
      extensions,
      editable,
      // Defer the first view render out of React's render pass. Otherwise
      // tiptap mounts our ReactNodeViewRenderer nodes (code-block/toggle/
      // callout) synchronously during render, and each one calls flushSync
      // mid-commit → "flushSync was called from inside a lifecycle" warning
      // storm + jank when a KB tab with those blocks is revealed on switch.
      immediatelyRender: false,
      // Open notes without focus so the suggestion plugin can't
      // activate from a cursor that landed near an `@` chip. User has
      // to click into the editor to focus + reposition the caret.
      autofocus: false,
      content: getInitialContent(documentId, initialMarkdown),
      onCreate: ({ editor }) => {
        // Stamp the id so onUpdate knows which entry to cache against.
        loadedIdRef.current = documentId;
        swappingRef.current = true;
        // Defer to a microtask: onCreate runs inside tiptap's mount effect,
        // so dispatching `rehydrateMentions`'s transaction here would mount
        // Mention/NodeView nodes mid-commit → flushSync-in-render warning.
        // The microtask runs before paint, so there's no visible flash of
        // raw `@kind:id` text.
        queueMicrotask(() => {
          if (editor.isDestroyed) return;
          // Re-wrap bare `@kind:id` text (tiptap-markdown parsed it as plain
          // text) back into atomic Mention nodes so the suggestion plugin
          // doesn't fire on them.
          rehydrateMentions(editor);
          cacheCurrentDoc(editor, documentId);
          swappingRef.current = false;
          setViewReady(true);
        });
      },
      onUpdate: ({ editor }) => {
        if (swappingRef.current) return;
        if (loadedIdRef.current) {
          cacheCurrentDoc(editor, loadedIdRef.current);
        }
        if (!dirtyRef.current) {
          dirtyRef.current = true;
          // Defer — onUpdate can fire synchronously during the parent's
          // first commit, and a synchronous setState there violates
          // React's render rules.
          queueMicrotask(() => onDirtyRef.current?.());
        }
      },
    });

    // Keep `editable` in sync — useEditor only reads it on mount.
    useEffect(() => {
      editor?.setEditable(editable);
    }, [editor, editable]);

    // documentId change: swap in the new doc in place. We `flush()` the
    // current doc first so unsaved edits get a chance to persist —
    // knowledge-panel's `handleSelectEntry` also flushes, but doing it
    // here too closes the race where the parent changes documentId
    // without going through that callback.
    useEffect(() => {
      if (!editor) return;
      if (loadedIdRef.current === documentId) return;
      // Cache the outgoing doc one more time in case onUpdate hadn't
      // fired since the last edit.
      if (loadedIdRef.current) {
        cacheCurrentDoc(editor, loadedIdRef.current);
      }
      swappingRef.current = true;
      const targetId = documentId;
      // Defer the `setContent` transaction out of this effect's commit phase.
      // setContent mounts ReactNodeViewRenderer nodes (code-block/toggle/
      // callout), whose renderer calls flushSync — dispatching it directly in
      // the effect warns "flushSync was called from inside a lifecycle". The
      // microtask runs before paint, so the swap is still visually immediate.
      queueMicrotask(() => {
        if (editor.isDestroyed) return;
        try {
          const cached = getCachedDoc(targetId);
          if (cached) {
            editor.commands.setContent(cached, { emitUpdate: false });
          } else if (initialMarkdown && initialMarkdown.trim().length > 0) {
            editor.commands.setContent(initialMarkdown, { emitUpdate: false });
            rehydrateMentions(editor);
            cacheCurrentDoc(editor, targetId);
          } else {
            editor.commands.setContent("", { emitUpdate: false });
          }
          loadedIdRef.current = targetId;
          dirtyRef.current = false;
        } finally {
          swappingRef.current = false;
        }
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentId, editor]);

    const flush = useCallback(async (): Promise<string | null> => {
      if (!editor || !loadedIdRef.current) return null;
      try {
        // tiptap-markdown registers a `markdown` storage slot at
        // runtime; @tiptap/core's Storage type doesn't know about it.
        const storage = editor.storage as unknown as Record<
          string,
          { getMarkdown?: () => string }
        >;
        const md = storage.markdown?.getMarkdown?.();
        cacheCurrentDoc(editor, loadedIdRef.current);
        dirtyRef.current = false;
        return typeof md === "string" ? md : null;
      } catch {
        return null;
      }
    }, [editor]);

    useImperativeHandle(
      ref,
      () => ({
        flush,
        isDirty: () => dirtyRef.current,
        evict: (id) => dropCachedDoc(id),
        getEditor: () => editor,
      }),
      [editor, flush],
    );

    return (
      <div
        className={cn("atlas-tiptap", className)}
        style={{ position: "relative" }}
      >
        <EditorContent editor={editor} />
        {editable && editor && viewReady && <AtlasBubbleMenu editor={editor} />}
      </div>
    );
  },
);

/** Resolve the initial doc handed to `useEditor` on first mount. Tiptap
 *  parses markdown strings via tiptap-markdown automatically; if we
 *  have a cached JSON doc we hand it that instead to skip the parse. */
function getInitialContent(documentId: string, initialMarkdown: string) {
  const cached = getCachedDoc(documentId);
  if (cached) return cached;
  return initialMarkdown && initialMarkdown.trim().length > 0
    ? initialMarkdown
    : "";
}

function cacheCurrentDoc(editor: Editor, id: string) {
  try {
    setCachedDoc(id, editor.getJSON());
  } catch {
    // ignore — non-fatal cache miss
  }
}

/**
 * Walk every text node in the doc and replace `@(knowledge|note|page):<id>`
 * substrings with atomic Mention nodes. Needed because tiptap-markdown
 * parses our serialized mention wire format back as plain text — and the
 * bare `@` character then re-triggers the `@`-suggestion picker as the
 * user navigates the cursor through it, causing the glitch the user
 * reported. Making the mention atomic again stops the picker from
 * firing on it.
 *
 * Walk-then-apply in reverse order so positions earlier in the doc
 * stay valid as we splice later in the doc.
 */
function rehydrateMentions(editor: Editor): void {
  const mentionType = editor.schema.nodes.mention;
  if (!mentionType) return;

  const replacements: Array<{
    from: number;
    to: number;
    attrs: { id: string; kind: string; label: string };
  }> = [];
  const re = /@(knowledge|note|page):([\w\-./]+)/g;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const [full, kind, id] = m;
      const from = pos + m.index;
      const to = from + full.length;
      replacements.push({ from, to, attrs: { id, kind, label: id } });
    }
  });

  if (replacements.length === 0) return;

  let tr = editor.state.tr;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    try {
      tr = tr.replaceWith(r.from, r.to, mentionType.create(r.attrs));
    } catch {
      // Skip malformed positions; the rest of the rehydration still wins.
    }
  }
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}
