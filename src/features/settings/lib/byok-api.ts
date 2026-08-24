import { invoke } from "@tauri-apps/api/core";

/**
 * BYOK bridge — a view onto the user's shell environment.
 *
 * Atlas stores no keys. Every entry below is an `export VAR=...` in a shell
 * profile (editable) or a value inherited from the ambient environment
 * (read-only — Atlas won't guess at a file it didn't find the value in).
 *
 * Secrets stay in Rust: the list carries only `last4`, and the full value is
 * fetched one at a time via `reveal` so a list render never ships every key to
 * the webview.
 */

/** One recognised provider key Atlas can see. */
export interface EnvEntry {
  provider: string;
  envVar: string;
  last4: string;
  /** Profile file holding it, when there is one. */
  file: string | null;
  /** 1-based line in `file`. */
  line: number | null;
  /** False when it exists only in the live environment. */
  editable: boolean;
}

export interface ScannedFile {
  path: string;
  exists: boolean;
}

/** Which profile files Atlas reads, and where a new key would be written. */
export interface ProfileInfo {
  shell: string;
  target: string;
  scanned: ScannedFile[];
}

/** Compact provider→key view, for "which providers are usable" checks. */
export interface EnvKeyMeta {
  provider: string;
  envVar: string;
  last4: string;
}

export const byok = {
  /** Provider → env key, for "which providers are usable" checks. */
  envList: () => invoke<EnvKeyMeta[]>("byok_env_list"),

  /** Full editor listing: every recognised var, with its file + line. */
  entries: () => invoke<EnvEntry[]>("byok_env_entries"),

  profileInfo: () => invoke<ProfileInfo>("byok_profile_info"),

  /** Full value for one variable (show / copy). */
  reveal: (envVar: string) => invoke<string | null>("byok_env_reveal", { envVar }),

  /** Write or replace the assignment; resolves to the file that changed. */
  set: (envVar: string, value: string) => invoke<string>("byok_env_set", { envVar, value }),

  /** Remove the assignment from the profile that defines it. */
  unset: (envVar: string) => invoke<void>("byok_env_unset", { envVar }),
};
