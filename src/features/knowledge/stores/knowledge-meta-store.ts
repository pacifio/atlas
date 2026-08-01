import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";

export interface PageMeta {
  icon?: string | null;
  cover?: string | null;
  title?: string | null;
  status?: string | null;
  tags?: string[];
  owner?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PageMetaPatch {
  icon?: string | null;
  cover?: string | null;
  title?: string | null;
  status?: string | null;
  tags?: string[];
  owner?: string | null;
}

interface MetaFile {
  version: number;
  pages: Record<string, RustPageMeta>;
}

interface RustPageMeta {
  icon?: string | null;
  cover?: string | null;
  title?: string | null;
  status?: string | null;
  tags?: string[];
  owner?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function fromRust(m: RustPageMeta): PageMeta {
  return {
    icon: m.icon ?? null,
    cover: m.cover ?? null,
    title: m.title ?? null,
    status: m.status ?? null,
    tags: m.tags ?? [],
    owner: m.owner ?? null,
    createdAt: m.created_at ?? null,
    updatedAt: m.updated_at ?? null,
  };
}

interface KnowledgeMetaState {
  /** Last project we hydrated for — `null` when not bound to anything. */
  projectPath: string | null;
  pages: Record<string, PageMeta>;
  loading: boolean;
  actions: {
    /** Hydrate from disk + start listening. Idempotent per project path. */
    bind: (projectPath: string) => Promise<void>;
    unbind: () => void;
    /** Merge a patch into the active page and persist (debounced in Rust). */
    patch: (entryId: string, patch: PageMetaPatch) => Promise<void>;
    /** Drop a page's metadata entirely (e.g. after `delete_knowledge_note`). */
    drop: (entryId: string) => Promise<void>;
  };
}

let unlisten: UnlistenFn | null = null;

// Re-push knowledge titles + icons into the Rust mention cache so the
// @-/~ picker shows real titles + emoji instead of note ids. Must run
// after a bulk meta hydrate (not just single-title patches) — the
// initial `entries` publish happens before `_meta.json` loads, so
// without this the cache stays stuck on filename-style ids. Lazy import
// avoids a static cycle with chat/lib/mentions (which imports this store).
function republishMentionCache() {
  void import("@/features/chat/lib/mentions").then((m) =>
    m.publishKnowledgeToMentionCache(),
  );
}

const store = create<KnowledgeMetaState>()((set, get) => ({
  projectPath: null,
  pages: {},
  loading: false,
  actions: {
    bind: async (projectPath) => {
      // Already bound to this project — re-hydrate silently in case the
      // metadata file changed under us, but don't toggle loading.
      if (get().projectPath === projectPath && unlisten) {
        try {
          const file = await invoke<MetaFile>("knowledge_meta_load", {
            projectPath,
          });
          set({ pages: mapPages(file.pages) });
          republishMentionCache();
        } catch {
          // ignore
        }
        return;
      }
      get().actions.unbind();
      set({ projectPath, loading: true, pages: {} });
      try {
        const file = await invoke<MetaFile>("knowledge_meta_load", {
          projectPath,
        });
        set({ pages: mapPages(file.pages), loading: false });
        republishMentionCache();
      } catch {
        set({ loading: false });
      }
      // Re-load when Rust emits a meta-changed event for this project.
      // Other open projects share the same global event channel, so we
      // filter by payload.projectPath defensively.
      unlisten = await listen<{ projectPath: string }>(
        "atlas:knowledge:meta-changed",
        async (event) => {
          const current = get().projectPath;
          if (!current || event.payload?.projectPath !== current) return;
          try {
            const fresh = await invoke<MetaFile>("knowledge_meta_load", {
              projectPath: current,
            });
            set({ pages: mapPages(fresh.pages) });
            republishMentionCache();
          } catch {
            // ignore
          }
        },
      );
    },
    unbind: () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      set({ projectPath: null, pages: {} });
    },
    patch: async (entryId, patch) => {
      const { projectPath, pages } = get();
      if (!projectPath) return;

      // Optimistic in-memory merge so the UI updates immediately; the
      // event listener reconciles when Rust persists.
      const existing = pages[entryId] ?? {};
      const optimistic: PageMeta = {
        ...existing,
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.cover !== undefined ? { cover: patch.cover } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
        updatedAt: new Date().toISOString(),
      };
      set({ pages: { ...pages, [entryId]: optimistic } });

      try {
        // Rust expects `Option<Option<T>>` shape: explicit `null` clears,
        // missing field leaves unchanged. JSON `null` ⇒ Some(None).
        await invoke("knowledge_meta_patch", {
          projectPath,
          entryId,
          patch: toRustPatch(patch),
        });
        // If this patch touched the page-header title or icon, republish
        // the mention cache so @-/~ picker results immediately reflect
        // the new label/emoji.
        if (patch.title !== undefined || patch.icon !== undefined) {
          republishMentionCache();
        }
      } catch {
        // On error, restore the prior state.
        set({ pages });
      }
    },
    drop: async (entryId) => {
      const { projectPath, pages } = get();
      if (!projectPath) return;
      if (!(entryId in pages)) return;
      const next = { ...pages };
      delete next[entryId];
      set({ pages: next });
      try {
        await invoke("knowledge_meta_delete", { projectPath, entryId });
      } catch {
        // ignore — re-hydrate via event will reconcile if needed
      }
    },
  },
}));

function mapPages(raw: Record<string, RustPageMeta>): Record<string, PageMeta> {
  const out: Record<string, PageMeta> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = fromRust(v);
  }
  return out;
}

function toRustPatch(p: PageMetaPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.icon !== undefined) out.icon = p.icon;
  if (p.cover !== undefined) out.cover = p.cover;
  if (p.title !== undefined) out.title = p.title;
  if (p.status !== undefined) out.status = p.status;
  if (p.tags !== undefined) out.tags = p.tags;
  if (p.owner !== undefined) out.owner = p.owner;
  return out;
}

export const useKnowledgeMetaStore = createSelectors(store);

/** Convenience hook for a single page's meta with safe defaults. */
export function usePageMeta(entryId: string | null | undefined): PageMeta {
  const pages = useKnowledgeMetaStore.use.pages();
  if (!entryId) return { tags: [] };
  return pages[entryId] ?? { tags: [] };
}
