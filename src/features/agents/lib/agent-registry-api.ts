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
  platformSupported: boolean;
  /** "" when unsupported; else "binary" | "npx". */
  distributionKind: string;
  /** Binary distribution with no published sha256. */
  unverified: boolean;
  unsupportedReason: string | null;
}

export interface AcpRegistryListing {
  entries: AcpRegistryEntry[];
  /** RFC3339 time of the last successful network fetch. `null` means the
   *  entries (if any) came off the disk cache and were never confirmed. */
  lastRefreshedAt: string | null;
  lastError: string | null;
  /** A fetch is in flight in the backend right now — so an empty `entries` here
   *  means "not yet", not "nothing". */
  isFetching: boolean;
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
  /** Accept a detection: install the copy of the agent the user already has,
   *  as a `custom` entry pointing at the found binary. The only non-registry
   *  install path — see `acp_registry_install_detected`. */
  installDetected: (agentId: string) => invoke<void>("acp_registry_install_detected", { agentId }),
  uninstall: (agentId: string, purgeCache = true) =>
    invoke<void>("acp_registry_uninstall", { agentId, purgeCache }),
  metadata: (agentId: string) =>
    invoke<AcpRegistryEntry | null>("acp_registry_metadata", { agentId }),
};
