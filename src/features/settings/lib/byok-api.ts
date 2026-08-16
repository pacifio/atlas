import { invoke } from "@tauri-apps/api/core";

/** Non-secret per-provider metadata returned by Rust (camelCase from serde). */
export interface ProviderKeyMeta {
  provider: string;
  last4: string;
  addedAt: string;
}

/**
 * BYOK keychain bridge. Secrets live in the OS keychain (Rust `byok.rs`); the
 * frontend only ever sees metadata via `list`. The raw key never reaches JS:
 * consumers that need it (the Model-Chat Rig backend) read it Rust-side via the
 * `byok_get` command. `last4` + `addedAt` are computed here so Rust never has
 * to slice the secret.
 */
/** One key imported from the user's environment (shell profile / process env).
 *  Never stored by Atlas — probed at runtime; only the var name + last4 reach
 *  the UI. When both an env key and a stored key exist, the env key wins. */
export interface EnvKeyMeta {
  provider: string;
  envVar: string;
  last4: string;
}

export const byok = {
  list: () => invoke<ProviderKeyMeta[]>("byok_list"),

  /** Env-imported keys. First call may take a few seconds (login-shell probe). */
  envList: () => invoke<EnvKeyMeta[]>("byok_env_list"),

  set: (provider: string, key: string) =>
    invoke<void>("byok_set", {
      provider,
      key,
      last4: key.slice(-4),
      addedAt: new Date().toISOString(),
    }),

  delete: (provider: string) => invoke<void>("byok_delete", { provider }),
};
