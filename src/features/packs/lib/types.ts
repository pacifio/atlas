// Packs feature — shared types. These mirror the Rust `commands/skills.rs`
// pack IPC contract exactly (serde emits camelCase). The frontend never touches
// the filesystem; all pack state flows through `packs-api.ts` → `invoke()`.
//
// A "pack" = one source GitHub repo, fetched whole and parsed into components.
// Discovery is the skills.sh search index; content comes from the source repo.

import type { Scope } from "../../skills/lib/types";

export type { Scope };

/** Component kinds a pack can ship (Rust `ComponentKind`, lowercase serde). */
export type ComponentKind = "skill" | "agent" | "command" | "hook" | "rule" | "script";

/** One skills.sh search hit. `source` is a GitHub `owner/repo`. */
export interface PackSearchHit {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

/** Optional `.claude-plugin/plugin.json` metadata. */
export interface PluginManifest {
  name?: string | null;
  version?: string | null;
  description?: string | null;
  author?: unknown;
}

/** One component discovered inside a pack. */
export interface PackComponent {
  kind: ComponentKind;
  relPath: string;
  name: string;
  /** Frontmatter description of the component's markdown (SKILL.md for a skill).
   *  Null for non-markdown components or when none is set. */
  description?: string | null;
}

/** A parsed pack: name, root dir, optional manifest, and every component. */
export interface Pack {
  name: string;
  root: string;
  manifest?: PluginManifest | null;
  components: PackComponent[];
}

/** Outcome of an install attempt against the existing store + lock. */
export type PackInstallState = "fresh" | "updated" | "alreadyInstalled" | "conflict";

export interface PackInstallResult {
  state: PackInstallState;
  pack: Pack;
  contentHash: string;
}

/** Result of a cheap update check (git ls-remote vs the installed commit). */
export interface PackUpdateCheck {
  hasUpdate: boolean;
  remoteCommit: string;
}

/** An installed pack as surfaced to the UI (manifest + provenance). */
export interface InstalledPack {
  pack: Pack;
  source: string;
  commit: string;
  installedAt: number;
  updatedAt: number;
}

/** Per-component result row from a project run. */
export interface PackProjectReport {
  kind: ComponentKind;
  name: string;
  /** "symlink" | "copy" | "settings-merge" | "append" | "skip" | "unsupported" | "conflict" */
  mode: string;
  /** "projected" | "skipped" | "conflict" */
  status: string;
}

/** One recorded projection of a pack component into a tool (ledger view). */
export interface PackProjectionView {
  tool: string;
  kind: ComponentKind;
  name: string;
  mode: string;
  targetRel: string;
}
