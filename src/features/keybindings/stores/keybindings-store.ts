import { create } from "zustand";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import { ACTION_BY_ID, type ActionId } from "../lib/actions";
import { loadKeybindings, saveKeybindings } from "../lib/keybindings-api";
import { resolveProfile, type ResolvedState } from "../lib/resolve";
import {
  DEFAULT_KEYBINDINGS_FILE,
  DEFAULT_PROFILE_ID,
  type KeybindingProfile,
  type KeybindingsFile,
} from "../lib/types";

/**
 * Keybinding profiles: the on-disk file plus the resolved dispatch map for
 * the active profile.
 *
 * Every mutation is optimistic — the file and `resolved` update synchronously
 * so the very next keydown already honours the change — then persisted with a
 * short debounce. A rejected save reverts to the last snapshot Rust accepted.
 * `resolved` starts from the registry defaults so shortcuts work before
 * `load()` returns.
 */

interface KeybindingsState {
  loaded: boolean;
  file: KeybindingsFile;
  path: string | null;
  warnings: string[];
  resolved: ResolvedState;
  /** True while the recorder popup owns the keyboard; dispatchers stay silent. */
  recording: boolean;
  actions: {
    load: () => Promise<void>;
    setRecording: (on: boolean) => void;
    setActiveProfile: (id: string) => void;
    createProfile: (name: string) => string;
    duplicateProfile: (id: string, name?: string) => string | null;
    renameProfile: (id: string, name: string) => void;
    deleteProfile: (id: string) => void;
    resetProfile: (id: string) => void;
    setBinding: (actionId: ActionId, combos: string[]) => void;
    addBinding: (actionId: ActionId, combo: string) => void;
    removeBinding: (actionId: ActionId, combo?: string) => void;
    resetBinding: (actionId: ActionId) => void;
    removeUnknown: (actionId: string) => void;
  };
}

const SAVE_DEBOUNCE_MS = 150;

function activeProfile(file: KeybindingsFile): KeybindingProfile | undefined {
  return file.profiles.find((p) => p.id === file.activeProfileId);
}

function newProfileId(file: KeybindingsFile): string {
  const taken = new Set(file.profiles.map((p) => p.id));
  let id = `profile-${Date.now().toString(36)}`;
  let n = 1;
  while (taken.has(id)) id = `profile-${Date.now().toString(36)}-${n++}`;
  return id;
}

function uniqueName(file: KeybindingsFile, base: string): string {
  const names = new Set(file.profiles.map((p) => p.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export const useKeybindingsStore = createSelectors(
  create<KeybindingsState>((set, get) => {
    let lastSaved: KeybindingsFile = DEFAULT_KEYBINDINGS_FILE;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    const flush = async () => {
      if (inFlight) await inFlight;
      const file = get().file;
      if (file === lastSaved) return;
      inFlight = (async () => {
        try {
          const normalized = await saveKeybindings(file);
          lastSaved = normalized;
          // Only adopt Rust's normalised copy if nothing changed meanwhile.
          if (get().file === file) {
            set({ file: normalized, resolved: resolveProfile(activeProfile(normalized)) });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          toast.error(`Keybindings not saved: ${message}`);
          set({ file: lastSaved, resolved: resolveProfile(activeProfile(lastSaved)) });
        } finally {
          inFlight = null;
        }
      })();
      await inFlight;
    };

    const commit = (file: KeybindingsFile) => {
      set({ file, resolved: resolveProfile(activeProfile(file)) });
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    };

    /** Apply `fn` to the active profile unless it is the locked built-in. */
    const editActive = (fn: (p: KeybindingProfile) => KeybindingProfile) => {
      const file = get().file;
      const current = activeProfile(file);
      if (!current || current.builtIn) return;
      commit({
        ...file,
        profiles: file.profiles.map((p) => (p.id === current.id ? fn(p) : p)),
      });
    };

    const withBinding = (
      actionId: string,
      update: (prev: string[] | null | undefined) => string[] | null | undefined,
    ) =>
      editActive((p) => {
        const bindings = { ...p.bindings };
        const next = update(
          Object.prototype.hasOwnProperty.call(bindings, actionId) ? bindings[actionId] : undefined,
        );
        if (next === undefined) delete bindings[actionId];
        else bindings[actionId] = next;
        return { ...p, bindings };
      });

    return {
      loaded: false,
      file: DEFAULT_KEYBINDINGS_FILE,
      path: null,
      warnings: [],
      resolved: resolveProfile(undefined),
      recording: false,
      actions: {
        load: async () => {
          try {
            const result = await loadKeybindings();
            lastSaved = result.file;
            set({
              loaded: true,
              file: result.file,
              path: result.path,
              warnings: result.warnings,
              resolved: resolveProfile(activeProfile(result.file)),
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            set({ loaded: true, warnings: [`Could not load keybindings: ${message}`] });
          }
        },
        setRecording: (on) => set({ recording: on }),
        setActiveProfile: (id) => {
          const file = get().file;
          if (!file.profiles.some((p) => p.id === id) || file.activeProfileId === id) return;
          commit({ ...file, activeProfileId: id });
        },
        createProfile: (name) => {
          const file = get().file;
          const id = newProfileId(file);
          commit({
            ...file,
            activeProfileId: id,
            profiles: [
              ...file.profiles,
              { id, name: uniqueName(file, name.trim() || "Profile"), bindings: {} },
            ],
          });
          return id;
        },
        duplicateProfile: (sourceId, name) => {
          const file = get().file;
          const source = file.profiles.find((p) => p.id === sourceId);
          if (!source) return null;
          const id = newProfileId(file);
          commit({
            ...file,
            activeProfileId: id,
            profiles: [
              ...file.profiles,
              {
                id,
                name: uniqueName(file, name?.trim() || `${source.name} copy`),
                bindings: { ...source.bindings },
              },
            ],
          });
          return id;
        },
        renameProfile: (id, name) => {
          const file = get().file;
          const trimmed = name.trim();
          if (!trimmed) return;
          const target = file.profiles.find((p) => p.id === id);
          if (!target || target.builtIn || target.name === trimmed) return;
          commit({
            ...file,
            profiles: file.profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
          });
        },
        deleteProfile: (id) => {
          const file = get().file;
          const target = file.profiles.find((p) => p.id === id);
          if (!target || target.builtIn) return;
          commit({
            ...file,
            activeProfileId:
              file.activeProfileId === id ? DEFAULT_PROFILE_ID : file.activeProfileId,
            profiles: file.profiles.filter((p) => p.id !== id),
          });
        },
        resetProfile: (id) => {
          const file = get().file;
          const target = file.profiles.find((p) => p.id === id);
          if (!target || target.builtIn) return;
          commit({
            ...file,
            profiles: file.profiles.map((p) => (p.id === id ? { ...p, bindings: {} } : p)),
          });
        },
        setBinding: (actionId, combos) =>
          withBinding(actionId, () => (combos.length ? combos : null)),
        addBinding: (actionId, combo) =>
          withBinding(actionId, (prev) => {
            const base = prev === undefined ? defaultsFor(actionId) : (prev ?? []);
            return base.includes(combo) ? base : [...base, combo];
          }),
        removeBinding: (actionId, combo) =>
          withBinding(actionId, (prev) => {
            if (combo === undefined) return null;
            const base = prev === undefined ? defaultsFor(actionId) : (prev ?? []);
            const next = base.filter((c) => c !== combo);
            return next.length ? next : null;
          }),
        resetBinding: (actionId) => withBinding(actionId, () => undefined),
        removeUnknown: (actionId) => withBinding(actionId, () => undefined),
      },
    };
  }),
);

function defaultsFor(actionId: ActionId): string[] {
  return [...(ACTION_BY_ID[actionId]?.defaults ?? [])];
}

/** Reload from disk when the window regains focus — cheap stand-in for a file
 *  watcher, so a hand edit to keybindings.json lands without a relaunch. */
export function watchKeybindingsOnFocus(): () => void {
  const onFocus = () => {
    const { loaded, file } = useKeybindingsStore.getState();
    if (!loaded) return;
    void loadKeybindings()
      .then((result) => {
        if (JSON.stringify(result.file) === JSON.stringify(file)) return;
        useKeybindingsStore.setState({
          file: result.file,
          warnings: result.warnings,
          resolved: resolveProfile(activeProfile(result.file)),
        });
      })
      .catch(() => {});
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}
