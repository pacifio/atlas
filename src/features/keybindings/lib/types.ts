/**
 * On-disk shape of `~/.config/atlas/keybindings.json`, mirrored by
 * `src-tauri/src/commands/keybindings.rs`. Rust validates the shape and owns
 * the file; the renderer resolves and dispatches (keydown is inherently a
 * renderer concern).
 *
 * A profile stores OVERRIDES only: a key present with a string[] replaces the
 * action's default combos, `null` unbinds it, and an absent key means "use
 * the default". New actions shipped in a later build therefore flow into
 * every existing profile without a migration.
 */
export interface KeybindingProfile {
  id: string;
  name: string;
  /** The built-in "Default" profile: always present, never editable, always
   *  has empty `bindings`. Duplicate it to start customising. */
  builtIn?: boolean;
  bindings: Record<string, string[] | null>;
}

export interface KeybindingsFile {
  version: 1;
  activeProfileId: string;
  profiles: KeybindingProfile[];
}

export const DEFAULT_PROFILE_ID = "default";

export const DEFAULT_KEYBINDINGS_FILE: KeybindingsFile = {
  version: 1,
  activeProfileId: DEFAULT_PROFILE_ID,
  profiles: [{ id: DEFAULT_PROFILE_ID, name: "Default", builtIn: true, bindings: {} }],
};
