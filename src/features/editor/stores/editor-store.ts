import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";

interface Buffer {
  path: string;
  originalContent: string;
  dirty: boolean;
  language: string;
  /** Disk mtime (unix ms) at the last read/save — the freshness gate for
   *  external-change revalidation. 0 until first known. */
  diskMtimeMs: number;
  /** Set when the file changed on disk while this buffer has unsaved edits, so
   *  the editor can offer a manual reload instead of clobbering the user's work. */
  externallyChanged: boolean;
}

interface EditorState {
  buffers: Record<string, Buffer>;
  activeBufferPath: string | null;
}

interface EditorActions {
  actions: {
    openBuffer: (path: string, content: string, mtimeMs?: number) => void;
    setDirty: (path: string, dirty: boolean) => void;
    markSaved: (path: string, content: string, mtimeMs?: number) => void;
    /** Overwrite a buffer's content from disk (external change, buffer clean). */
    reloadBuffer: (path: string, content: string, mtimeMs: number) => void;
    /** Flag a dirty buffer whose file changed on disk (no content overwrite). */
    markExternallyChanged: (path: string, mtimeMs: number) => void;
    closeBuffer: (path: string) => void;
    setActive: (path: string) => void;
  };
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    rs: "rust",
    py: "python",
    go: "go",
    rb: "ruby",
    java: "java",
    json: "json",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    sh: "shell",
    zsh: "shell",
    bash: "shell",
    sql: "sql",
    xml: "xml",
    svg: "xml",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    swift: "swift",
    kt: "kotlin",
  };
  return map[ext] ?? "plaintext";
}

export const useEditorStore = createSelectors(
  create<EditorState & EditorActions>()(
    immer((set) => ({
      buffers: {},
      activeBufferPath: null,
      actions: {
        openBuffer: (path, content, mtimeMs = 0) =>
          set((s) => {
            if (!s.buffers[path]) {
              s.buffers[path] = {
                path,
                originalContent: content,
                dirty: false,
                language: detectLanguage(path),
                diskMtimeMs: mtimeMs,
                externallyChanged: false,
              };
            }
            s.activeBufferPath = path;
          }),
        setDirty: (path, dirty) =>
          set((s) => {
            const buf = s.buffers[path];
            if (buf && buf.dirty !== dirty) {
              buf.dirty = dirty;
            }
          }),
        markSaved: (path, content, mtimeMs) =>
          set((s) => {
            const buf = s.buffers[path];
            if (buf) {
              buf.originalContent = content;
              buf.dirty = false;
              buf.externallyChanged = false;
              if (mtimeMs !== undefined) buf.diskMtimeMs = mtimeMs;
            }
          }),
        reloadBuffer: (path, content, mtimeMs) =>
          set((s) => {
            const buf = s.buffers[path];
            if (buf) {
              buf.originalContent = content;
              buf.dirty = false;
              buf.externallyChanged = false;
              buf.diskMtimeMs = mtimeMs;
            }
          }),
        markExternallyChanged: (path, mtimeMs) =>
          set((s) => {
            const buf = s.buffers[path];
            if (buf) {
              buf.externallyChanged = true;
              buf.diskMtimeMs = mtimeMs;
            }
          }),
        closeBuffer: (path) =>
          set((s) => {
            delete s.buffers[path];
            if (s.activeBufferPath === path) {
              const keys = Object.keys(s.buffers);
              s.activeBufferPath =
                keys.length > 0 ? keys[keys.length - 1] : null;
            }
          }),
        setActive: (path) =>
          set((s) => {
            s.activeBufferPath = path;
          }),
      },
    })),
  ),
);
