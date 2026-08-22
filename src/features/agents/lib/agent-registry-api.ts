// Thin invoke wrappers for the ACP registry marketplace commands
// (src-tauri/src/commands/registry.rs). Mirrors agents-api.ts's style.

import { invoke } from "@tauri-apps/api/core";

export interface AcpRegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string | null;
  repository: string | null;
  website: string | null;
  /** base64 `data:image/svg+xml` URL — asset protocol can't serve hidden dirs. */
  iconDataUrl: string | null;
  installed: boolean;
  /** Duplicates a first-party Atlas agent — shown as "Built-in", not installable. */
  builtin: boolean;
  platformSupported: boolean;
  /** "" when unsupported; else "binary" | "npx". */
  distributionKind: string;
  /** Binary distribution with no published sha256. */
  unverified: boolean;
  unsupportedReason: string | null;
}

export interface AcpRegistryListing {
  entries: AcpRegistryEntry[];
  lastRefreshedAt: string | null;
  lastError: string | null;
}

export interface RegistryInstallProgress {
  agentId: string;
  received: number;
  total: number | null;
}

export const acpRegistry = {
  list: () => invoke<AcpRegistryListing>("acp_registry_list"),
  refresh: () => invoke<AcpRegistryListing>("acp_registry_refresh"),
  install: (agentId: string) => invoke<void>("acp_registry_install", { agentId }),
  uninstall: (agentId: string, purgeCache = true) =>
    invoke<void>("acp_registry_uninstall", { agentId, purgeCache }),
  metadata: (agentId: string) =>
    invoke<AcpRegistryEntry | null>("acp_registry_metadata", { agentId }),
};
