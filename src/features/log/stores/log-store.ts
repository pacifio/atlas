import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";

export type LogSource =
  | "atlas"
  | "agent"
  | "chat"
  | "canvas"
  | "git"
  | "knowledge"
  | "github"
  | "editor"
  | "project"
  | "system";

export interface LogEntry {
  id: string;
  timestamp: string; // ISO
  source: LogSource;
  kind: string;
  summary: string;
  /** Owning Organisation, stamped at append time. Absent on entries written
   *  before the console was org-scoped — treated as belonging to whichever org
   *  is active, since that is the only org those entries could have come from
   *  on a single-org install. */
  orgId?: string;
  projectPath?: string;
  projectName?: string;
  payload?: Record<string, unknown>;
  pinned?: boolean;
}

interface LogState {
  buffer: LogEntry[];
  pinned: LogEntry[];
  ready: boolean;
  /** Project path whose persisted log is currently loaded into `buffer`. */
  loadedProject?: string;
  /** Organisation whose pinned entries are currently loaded. Switching orgs
   *  re-reads, exactly like switching projects re-reads the buffer. */
  loadedOrg?: string;
}

interface LogActions {
  actions: {
    append: (
      entry: Omit<LogEntry, "id" | "timestamp" | "pinned" | "projectName"> & {
        projectName?: string;
      },
    ) => void;
    pin: (id: string) => Promise<void>;
    unpin: (id: string) => Promise<void>;
    clearBuffer: () => void;
    clearPinned: () => Promise<void>;
    loadPinned: () => Promise<void>;
    /** Load a project's persisted activity log into the buffer (scopes the
     *  buffer to that project and restores it across restarts). */
    loadProject: (project: string) => Promise<void>;
    /** Re-scope the console to an Organisation: drop other orgs' buffered
     *  entries and load that org's pins. */
    setOrg: (orgId: string | null) => Promise<void>;
  };
}

const BUFFER_CAP = 500;

function genId(): string {
  return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The Organisation the console is scoped to. `null` only before hydrate. */
function activeOrg(): string | null {
  return useOrgStore.getState().activeOrganisationId;
}

export const useLogStore = createSelectors(
  create<LogState & LogActions>()(
    immer((set, get) => ({
      buffer: [],
      pinned: [],
      ready: false,
      actions: {
        append: (entry) => {
          const project = useProjectStore.getState().currentProject;
          const orgId = useOrgStore.getState().activeOrganisationId ?? undefined;
          const projectPath = entry.projectPath ?? project?.path ?? undefined;
          const projectName =
            entry.projectName ??
            (project && projectPath === project.path ? project.name : undefined);
          const full: LogEntry = {
            ...entry,
            id: genId(),
            timestamp: nowIso(),
            orgId,
            projectPath,
            projectName,
          };
          set((s) => {
            s.buffer.unshift(full);
            if (s.buffer.length > BUFFER_CAP) s.buffer.length = BUFFER_CAP;
          });
          // Persist project-scoped entries so the activity log survives restarts
          // and stays per-project. App-level entries (no project) stay in-memory.
          if (projectPath) {
            void invoke("append_project_log", {
              project: projectPath,
              entryJson: JSON.stringify(full),
            }).catch(() => {});
          }
        },
        pin: async (id) => {
          // Find the entry in buffer or pinned.
          const inBuffer = get().buffer.find((e) => e.id === id);
          const target: LogEntry | undefined = inBuffer
            ? { ...inBuffer, pinned: true }
            : get().pinned.find((e) => e.id === id);
          if (!target) return;
          set((s) => {
            if (!s.pinned.some((e) => e.id === id)) {
              s.pinned.unshift({ ...target, pinned: true });
            }
            const i = s.buffer.findIndex((e) => e.id === id);
            if (i !== -1) s.buffer[i].pinned = true;
          });
          try {
            const org = activeOrg();
            if (org) {
              await invoke("append_pinned_log", {
                org,
                entryJson: JSON.stringify(target),
              });
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("pin log entry failed", err);
          }
        },
        unpin: async (id) => {
          set((s) => {
            s.pinned = s.pinned.filter((e) => e.id !== id);
            const i = s.buffer.findIndex((e) => e.id === id);
            if (i !== -1) s.buffer[i].pinned = false;
          });
          try {
            const org = activeOrg();
            const remaining = get().pinned;
            const body =
              remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : "");
            if (org) await invoke("rewrite_pinned_log", { org, entriesJson: body });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("unpin log entry failed", err);
          }
        },
        clearBuffer: () => {
          const project = useProjectStore.getState().currentProject?.path;
          set((s) => {
            // Keep entries from OTHER projects; clear the current project's.
            s.buffer = project ? s.buffer.filter((e) => e.projectPath !== project) : [];
          });
          if (project) {
            void invoke("clear_project_log", { project }).catch(() => {});
          }
        },
        clearPinned: async () => {
          set((s) => {
            s.pinned = [];
            for (const e of s.buffer) e.pinned = false;
          });
          try {
            const org = activeOrg();
            if (org) await invoke("clear_pinned_log", { org });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("clear pinned log failed", err);
          }
        },
        loadPinned: async () => {
          const org = activeOrg();
          // Keyed on the org, not a one-shot `ready` flag: an org switch has to
          // be able to re-read, and the old guard made the first org's pins the
          // only ones the console would ever show.
          if (get().ready && get().loadedOrg === org) return;
          if (!org) {
            set((s) => {
              s.pinned = [];
              s.ready = true;
            });
            return;
          }
          try {
            const text = await invoke<string>("load_pinned_log", { org });
            const lines = text.split("\n").filter((l) => l.trim());
            const parsed: LogEntry[] = [];
            for (const l of lines) {
              try {
                const obj = JSON.parse(l) as LogEntry;
                parsed.push({ ...obj, pinned: true });
              } catch {
                // skip malformed line
              }
            }
            parsed.reverse(); // newest first
            set((s) => {
              s.pinned = parsed;
              s.ready = true;
              s.loadedOrg = org;
            });
          } catch {
            set((s) => {
              s.ready = true;
              s.loadedOrg = org;
            });
          }
        },
        loadProject: async (project) => {
          if (!project || get().loadedProject === project) return;
          let fileEntries: LogEntry[] = [];
          try {
            const text = await invoke<string>("load_project_log", { project });
            for (const l of text.split("\n")) {
              const t = l.trim();
              if (!t) continue;
              try {
                fileEntries.push(JSON.parse(t) as LogEntry);
              } catch {
                // skip malformed line
              }
            }
          } catch {
            fileEntries = [];
          }
          set((s) => {
            // Scope the buffer to this project: union of persisted entries +
            // any in-session entries already buffered for it, deduped by id,
            // newest first.
            const byId = new Map<string, LogEntry>();
            for (const e of fileEntries) byId.set(e.id, e);
            for (const e of s.buffer) {
              if (e.projectPath === project) byId.set(e.id, e);
            }
            const merged = Array.from(byId.values()).sort((a, b) =>
              b.timestamp.localeCompare(a.timestamp),
            );
            if (merged.length > BUFFER_CAP) merged.length = BUFFER_CAP;
            s.buffer = merged;
            s.loadedProject = project;
          });
        },

        setOrg: async (orgId) => {
          if (get().loadedOrg === orgId) return;
          set((s) => {
            // Drop the outgoing org's entries. An org switch tears down its
            // whole workspace set, so leaving its activity in the console would
            // show work from projects that are no longer even mounted.
            s.buffer = orgId ? s.buffer.filter((e) => e.orgId === orgId) : [];
            s.pinned = [];
            s.ready = false;
            s.loadedProject = undefined;
            s.loadedOrg = undefined;
          });
          await get().actions.loadPinned();
        },
      },
    })),
  ),
);
