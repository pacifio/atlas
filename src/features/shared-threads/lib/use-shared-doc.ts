import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { yCollab } from "y-codemirror.next";

import { remoteCaretField } from "@/features/editor/lib/remote-carets";

import {
  closeSharedDoc,
  onSharedDocUpdate,
  openSharedDoc,
  sendCursors,
  sendDocUpdate,
  type SharedDoc,
} from "./shared-threads-api";

/** Keystrokes are sent at most this often, as one update (ATL-407). */
export const BATCH_MS = 50;
/** Cursor moves are said at most this often. */
const CURSOR_MS = 150;
/** "Typing" lasts this long after the last keystroke. */
const TYPING_MS = 2_000;
/** The text type every replica's document keeps a file's content in. */
const TEXT_NAME = "content";
/** What Yjs is told a change came from when it came from the thread. */
const REMOTE = "shared-thread";

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A replica file bound to the editor: its document, and how to talk about it. */
export interface SharedBinding {
  doc: SharedDoc;
  ydoc: Y.Doc;
  ytext: Y.Text;
}

/**
 * Batch a document's local updates and hand each batch to `send`: one merged
 * update per `ms`. Updates that came from the thread are never sent back.
 * Answers a function that stops it (and sends what is pending).
 */
export function batchUpdates(
  ydoc: Y.Doc,
  send: (update: Uint8Array) => void,
  ms: number = BATCH_MS,
): () => void {
  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (pending.length === 0) return;
    const merged = pending.length === 1 ? pending[0]! : Y.mergeUpdates(pending);
    pending = [];
    send(merged);
  };
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    pending.push(update);
    timer ??= setTimeout(flush, ms);
  };
  ydoc.on("update", onUpdate);
  return () => {
    ydoc.off("update", onUpdate);
    if (timer) clearTimeout(timer);
    flush();
  };
}

/**
 * Bind the editor to `path` when it is a text file of a joined Shared Thread's
 * replica (ATL-407): keystrokes sync as they are typed, everybody else's
 * arrive as they land, and other editors still sync on save through the
 * replica's watcher.
 *
 * `pending` while asking; `binding` once bound, `null` for any other file.
 * If a batch is refused — a viewer, a closed thread, text that now looks like
 * a secret — the binding is dropped and `onRefused` gets the editor's text to
 * save to disk instead, where the usual rules for a save take over.
 */
export function useSharedDoc(
  path: string,
  onRefused: (text: string) => void,
): { pending: boolean; binding: SharedBinding | null } {
  const [state, setState] = useState<{ pending: boolean; binding: SharedBinding | null }>({
    pending: path !== "",
    binding: null,
  });
  const refusedRef = useRef(onRefused);
  refusedRef.current = onRefused;

  useEffect(() => {
    if (!path) {
      setState({ pending: false, binding: null });
      return;
    }
    let live = true;
    let stopBatching: (() => void) | null = null;
    let unlisten: (() => void) | null = null;
    let bound: SharedBinding | null = null;
    setState({ pending: true, binding: null });

    (async () => {
      let doc: SharedDoc | null = null;
      try {
        doc = await openSharedDoc(path);
      } catch {
        doc = null;
      }
      if (!live || !doc) {
        if (live) setState({ pending: false, binding: null });
        return;
      }
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, fromBase64(doc.state), REMOTE);
      const binding: SharedBinding = { doc, ydoc, ytext: ydoc.getText(TEXT_NAME) };
      bound = binding;
      const un = await onSharedDocUpdate((e) => {
        if (e.sharedThreadId === doc!.sharedThreadId && e.fileId === doc!.fileId) {
          Y.applyUpdate(ydoc, fromBase64(e.update), REMOTE);
        }
      });
      if (!live) {
        un();
        return;
      }
      unlisten = un;
      let refused = false;
      stopBatching = batchUpdates(ydoc, (update) => {
        sendDocUpdate(doc!.sharedThreadId, doc!.fileId, toBase64(update)).catch(() => {
          if (!live || refused) return;
          refused = true;
          // Leave keystroke sync; the editor saves to disk from here on.
          stopBatching?.();
          stopBatching = null;
          setState({ pending: false, binding: null });
          refusedRef.current(binding.ytext.toString());
        });
      });
      setState({ pending: false, binding });
    })();

    return () => {
      live = false;
      stopBatching?.();
      unlisten?.();
      if (bound) {
        void closeSharedDoc(bound.doc.sharedThreadId, bound.doc.fileId).catch(() => {});
        bound.ydoc.destroy();
      }
    };
  }, [path]);

  return state;
}

/**
 * The CodeMirror side of a binding: the document bound to the Yjs text,
 * everybody else's carets, and this person's selections and typing said to
 * the thread.
 */
export function sharedDocExtensions(binding: SharedBinding): Extension[] {
  const { sharedThreadId, fileId } = binding.doc;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let typing = false;
  let last: ViewUpdate["view"] | null = null;
  const say = () => {
    cursorTimer = null;
    if (!last) return;
    const ranges = last.state.selection.ranges
      .slice(0, 8)
      .map((r) => [r.anchor, r.head] as [number, number]);
    void sendCursors(sharedThreadId, fileId, ranges, typing).catch(() => {});
  };
  return [
    yCollab(binding.ytext, null),
    remoteCaretField,
    EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged) return;
      last = u.view;
      if (u.docChanged && u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"))) {
        typing = true;
        if (typingTimer) clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          typing = false;
          say();
        }, TYPING_MS);
      }
      cursorTimer ??= setTimeout(say, CURSOR_MS);
    }),
  ];
}
