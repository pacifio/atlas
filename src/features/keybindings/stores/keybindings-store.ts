import { create } from "zustand";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import { ACTION_BY_ID, type ActionId } from "../lib/actions";
import { loadKeybindings, saveKeybindings } from "../lib/keybindings-api";
import { PRESET_BY_ID, type PresetId } from "../lib/presets";
import { importProfile as parseProfile, type ImportResult } from "../lib/profile-transfer";
import { baseChords, resolveProfile, type ResolvedState } from "../lib/resolve";
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
  /** No keybindings.json on disk yet: the first-run keymap question is due.
   *  False until `load()` has answered, so a returning user is never asked
   *  while the answer is in flight. */
  firstRun: boolean;
  actions: {
    load: () => Promise<void>;
    setRecording: (on: boolean) => void;
    setActiveProfile: (id: string) => void;
    createProfile: (name: string) => string;
    /** New profile layered on `presetId`, made active. Reuses an untouched
     *  profile already based on it rather than stacking "VS Code 2". */
    createProfileFromPreset: (presetId: PresetId) => string;
    /** Change (or clear, with null) the preset under an existing profile. */
    setProfilePreset: (id: string, presetId: PresetId | null) => void;
    /** Parse an exported profile and add it as a new, active profile. */
    importProfile: (text: string) => ImportResult;
    /** Answer the first-run question: a preset, or null for "decide later".
     *  Either way the file is written, which is what records the answer. */
    completeOnboarding: (presetId: PresetId | null) => Promise<void>;
    duplicateProfile: (id: string, name?: string) => string | null;
    renameProfile: (id: string, name: string) => void;
    deleteProfile: (id: string) => void;
    resetProfile: (id: string) => void;
    setBinding: (actionId: ActionId, combos: string[]) => void;
    addBinding: (actionId: ActionId, combo: string) => void;
    removeBinding: (actionId: ActionId, combo?: string) => void;
    /** Replace an action's `when` ("" = always), or restore its own with
     *  null. */
    setWhen: (actionId: ActionId, expression: string | null) => void;
    /** Drop the action's chord override only, keeping any `when`. */
    resetChords: (actionId: ActionId) => void;
    /** Undo every override of the action: chords and `when`. */
    resetBinding: (actionId: ActionId) => void;
    removeUnknown: (actionId: string) => void;
  };
}

const SAVE_DEBOUNCE_MS = 150;

/** What the profile an edit to the built-in Default forks into is called. */
const FORK_NAME = "My keybindings";

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

function isEmpty(when: Record<string, string> | undefined): boolean {
  return !when || Object.keys(when).length === 0;
}

function withoutWhen(p: KeybindingProfile): KeybindingProfile {
  const { when: _drop, ...rest } = p;
  return rest;
}

/** `p` with `when` set, or without the key when there is nothing in it, so a
 *  profile that never touched a condition stays byte-identical on disk. */
function withWhen(p: KeybindingProfile, when: Record<string, string>): KeybindingProfile {
  return isEmpty(when) ? withoutWhen(p) : { ...p, when };
}

export const useKeybindingsStore = createSelectors(
  create<KeybindingsState>((set, get) => {
    let lastSaved: KeybindingsFile = DEFAULT_KEYBINDINGS_FILE;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    const flush = async (force = false) => {
      if (inFlight) await inFlight;
      const file = get().file;
      if (file === lastSaved && !force) return;
      inFlight = (async () => {
        try {
          const normalized = await saveKeybindings(file);
          lastSaved = normalized;
          if (get().firstRun) set({ firstRun: false });
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

    /**
     * Apply `fn` to the active profile. The built-in Default never changes:
     * editing it forks it into "My keybindings" first and makes that the
     * active profile, so the first rebind just works instead of asking the
     * user to duplicate something they never knew existed.
     */
    const editActive = (fn: (p: KeybindingProfile) => KeybindingProfile) => {
      const file = get().file;
      const current = activeProfile(file);
      if (!current) return;
      if (current.builtIn) {
        const id = newProfileId(file);
        const fork = fn({
          id,
          name: uniqueName(file, FORK_NAME),
          ...(current.basedOn ? { basedOn: current.basedOn } : {}),
          bindings: { ...current.bindings },
        });
        // Nothing changed (a reset on Default, say): no fork.
        if (
          fork.basedOn === current.basedOn &&
          JSON.stringify(fork.bindings) === JSON.stringify(current.bindings) &&
          isEmpty(fork.when)
        ) {
          return;
        }
        commit({ ...file, activeProfileId: id, profiles: [...file.profiles, fork] });
        return;
      }
      commit({
        ...file,
        profiles: file.profiles.map((p) => (p.id === current.id ? fn(p) : p)),
      });
    };

    const createFromPreset = (presetId: PresetId): string => {
      const file = get().file;
      const reusable = file.profiles.find(
        (p) => p.basedOn === presetId && Object.keys(p.bindings).length === 0 && isEmpty(p.when),
      );
      if (reusable) {
        if (file.activeProfileId !== reusable.id) commit({ ...file, activeProfileId: reusable.id });
        return reusable.id;
      }
      const id = newProfileId(file);
      const label = PRESET_BY_ID.get(presetId)?.label ?? presetId;
      commit({
        ...file,
        activeProfileId: id,
        profiles: [
          ...file.profiles,
          { id, name: uniqueName(file, label), basedOn: presetId, bindings: {} },
        ],
      });
      return id;
    };

    const withBinding = (
      actionId: string,
      update: (
        prev: string[] | null | undefined,
        base: readonly string[],
      ) => string[] | null | undefined,
    ) =>
      editActive((p) => {
        const bindings = { ...p.bindings };
        const def = ACTION_BY_ID[actionId as ActionId];
        const preset = (p.basedOn && PRESET_BY_ID.get(p.basedOn)) || null;
        const next = update(
          Object.prototype.hasOwnProperty.call(bindings, actionId) ? bindings[actionId] : undefined,
          def ? baseChords(def, preset) : [],
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
      firstRun: false,
      actions: {
        load: async () => {
          try {
            const result = await loadKeybindings();
            lastSaved = result.file;
            set({
              loaded: true,
              firstRun: !result.exists,
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
        createProfileFromPreset: (presetId) => createFromPreset(presetId),
        setProfilePreset: (id, presetId) => {
          const file = get().file;
          const target = file.profiles.find((p) => p.id === id);
          if (!target || (target.basedOn ?? null) === presetId) return;
          const withPreset = (p: KeybindingProfile): KeybindingProfile => {
            const { basedOn: _drop, ...rest } = p;
            return presetId ? { ...rest, basedOn: presetId } : rest;
          };
          // The built-in can only be changed by forking it, and only the
          // active one is forked — a fork becomes the active profile.
          if (target.builtIn) {
            if (file.activeProfileId === id) editActive(withPreset);
            return;
          }
          commit({
            ...file,
            profiles: file.profiles.map((p) => (p.id === id ? withPreset(p) : p)),
          });
        },
        importProfile: (text) => {
          const result = parseProfile(text);
          if (!result.ok) return result;
          const file = get().file;
          const id = newProfileId(file);
          commit({
            ...file,
            activeProfileId: id,
            profiles: [
              ...file.profiles,
              { ...result.profile, id, name: uniqueName(file, result.profile.name) },
            ],
          });
          return result;
        },
        completeOnboarding: async (presetId) => {
          if (presetId) createFromPreset(presetId);
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
          // Hide the question now; a failed write toasts, and the question
          // simply comes back next launch.
          set({ firstRun: false });
          await flush(true);
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
                ...(source.basedOn ? { basedOn: source.basedOn } : {}),
                bindings: { ...source.bindings },
                ...(isEmpty(source.when) ? {} : { when: { ...source.when } }),
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
            profiles: file.profiles.map((p) =>
              p.id === id ? withoutWhen({ ...p, bindings: {} }) : p,
            ),
          });
        },
        setBinding: (actionId, combos) =>
          withBinding(actionId, () => (combos.length ? combos : null)),
        addBinding: (actionId, combo) =>
          withBinding(actionId, (prev, defaults) => {
            const base = prev === undefined ? [...defaults] : (prev ?? []);
            return base.includes(combo) ? base : [...base, combo];
          }),
        removeBinding: (actionId, combo) =>
          withBinding(actionId, (prev, defaults) => {
            if (combo === undefined) return null;
            const base = prev === undefined ? [...defaults] : (prev ?? []);
            const next = base.filter((c) => c !== combo);
            return next.length ? next : null;
          }),
        setWhen: (actionId, expression) =>
          editActive((p) => {
            const when = { ...p.when };
            if (expression === null) delete when[actionId];
            else when[actionId] = expression.trim();
            return withWhen(p, when);
          }),
        resetChords: (actionId) => withBinding(actionId, () => undefined),
        resetBinding: (actionId) =>
          editActive((p) => {
            const bindings = { ...p.bindings };
            const when = { ...p.when };
            delete bindings[actionId];
            delete when[actionId];
            return withWhen({ ...p, bindings }, when);
          }),
        removeUnknown: (actionId) =>
          editActive((p) => {
            const bindings = { ...p.bindings };
            const when = { ...p.when };
            delete bindings[actionId];
            delete when[actionId];
            return withWhen({ ...p, bindings }, when);
          }),
      },
    };
  }),
);

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
