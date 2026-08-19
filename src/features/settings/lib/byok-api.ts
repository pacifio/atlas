import { invoke } from "@tauri-apps/api/core";

/** Non-secret per-provider metadata returned by Rust (camelCase from serde). */
export interface ProviderKeyMeta {
  provider: string;
  last4: string;
  addedAt: string;
}

/**
 * BYOK bridge. Stored secrets live in a 0600 JSON file that Rust owns
 * (`byok.rs`) — NOT the OS keychain, despite what this comment used to claim
 * (E2). The frontend only ever sees metadata via `list`; the raw key never
 * reaches JS, and consumers that need it (the Model-Chat Rig backend) read it
 * Rust-side via `byok_get`.
 *
 * Two distinct sources feed this screen and they are not interchangeable:
 * stored keys (editable here, used by native Cersei + model-chat) and env keys
 * (read-only reflections of the system environment). For ACP agents the
 * environment is the ONLY channel — Atlas holds no agent credentials — which is
 * why env keys overlay stored ones in `builtin_agent_env`.
 */
/** One key imported from the user's environment (shell profile / process env).
 *  Never stored by Atlas — probed at runtime; only the var name + last4 reach
 *  the UI. When both an env key and a stored key exist, the env key wins. */
export interface EnvKeyMeta {
  provider: string;
  envVar: string;
  last4: string;
  /** `shell-env` persists (it is in the shell profile); `process-env` only
   *  exists because Atlas was launched from a terminal that had it exported. */
  source: "process-env" | "shell-env" | null;
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
