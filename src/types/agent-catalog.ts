// TS mirror of `src-tauri/src/commands/catalog.rs` — the ONE backend answer to
// "which agents exist and how would each one launch right now".
//
// Keep in sync with the Rust structs; the wire shape is camelCase serde.

/** How a spawn of this agent would launch it right now.
 *
 *  The spawn ladder is gone (Zed port, ADR-0002): an agent is the native one, it
 *  is in the installed map, or it is not runnable. `system-path`,
 *  `managed-binary`, `auto-acquire` and `uvx` were rungs of that ladder and are
 *  never emitted any more. */
export type AgentSource =
  /** The native in-process agent — no subprocess at all. */
  | "in-process"
  /** Has an installed-map entry, so it is runnable. */
  | "installed"
  /** Installed and launched through `npx` — npm fetches it on first run. */
  | "npx"
  /** Found on the user's PATH but NOT installed. An offer to install, not a
   *  spawn candidate: accepting it writes a `custom` entry pointing at the
   *  copy the user already has. */
  | "detected"
  /** Nothing runnable — no install, no runner. */
  | "unavailable";

/** `"builtin"` is deliberately absent: Atlas ships no external agents of its
 *  own (ADR-0002), so every agent is either the native one or external. */
export type AgentKind = "native" | "external";

/** Whether the agent keeps a record Atlas can read. `claude_jsonl` is gone:
 *  Atlas no longer parses `~/.claude/projects` (ADR-0001), so the only agent
 *  with a readable store of its own is the native one. */
export type AgentTranscript = "none" | "cersei_json";

/** The CLI login Atlas can run for this agent right now. Absent means "there
 *  is no command to offer" — NOT "this agent has no sign-in". */
export interface AgentLoginSpec {
  program: string;
  args: string[];
}

export interface AgentCatalogEntry {
  /** Plugin/spec id — what every agent command takes. */
  id: string;
  /** Auth-method kinds the agent advertised at `initialize` (R6). **Empty
   *  before it has ever been spawned** — auth methods only exist after the
   *  handshake — so empty means "unknown", not "cannot sign in". */
  authKinds?: ("agent" | "env_var" | "terminal")[];
  /** Whether the agent advertised ACP `auth.logout` (A2). Same pre-spawn
   *  caveat as `authKinds` — false until the handshake has happened. */
  supportsLogout?: boolean;
  /** Whether the agent advertised `sessionCapabilities.fork` (P3.4). Same
   *  pre-spawn caveat as `authKinds`. */
  supportsFork?: boolean;
  /** Display alias UI state carries ("claude-code" for "claude-code-ts"). */
  agentType: string;
  name: string;
  description: string | null;
  version: string | null;
  kind: AgentKind;
  source: AgentSource;
  resolvedPath: string | null;
  /** Has an installed-map entry. A detected-on-PATH agent is
   *  `installed: false, source: "detected"` — the user installed it, not
   *  Atlas. */
  installed: boolean;
  supportsModes: boolean;
  supportsModels: boolean;
  transcript: AgentTranscript;
  login: AgentLoginSpec | null;
  iconDataUrl: string | null;
  helpUrl: string | null;
  repository: string | null;
  website: string | null;
  platformSupported: boolean;
  /** "" when unsupported; else "binary" | "npx". */
  distributionKind: string;
  unverified: boolean;
  unsupportedReason: string | null;
}

export interface AgentCatalog {
  entries: AgentCatalogEntry[];
  lastRefreshedAt: string | null;
  lastDiscoveredAt: string | null;
  lastError: string | null;
}

/** Why the catalog changed — payload of `atlas:agent-catalog:changed`. */
export type CatalogChangeReason =
  | "discovery"
  | "refresh"
  | "install"
  | "uninstall"
  /** The installed map landed at boot. */
  | "settings"
  /** An agent finished `initialize`, so its advertised capabilities
   *  (`authKinds`, `supportsFork`, …) are known for the first time. */
  | "spawn";

/** Coarse readiness, derived on the frontend so the backend never has to guess
 *  what the UI wants to group by. */
export type AgentAvailability =
  /** Spawns immediately. */
  | "ready"
  /** Works, but the first spawn downloads a binary first. */
  | "needs-download"
  /** Cannot spawn here at all. */
  | "unavailable";

export function availabilityOf(entry: AgentCatalogEntry): AgentAvailability {
  // A detection is not runnable until the user installs it, and an npx agent
  // pays npm's fetch on its first spawn.
  if (entry.source === "detected") return "needs-download";
  if (entry.source === "unavailable") return "unavailable";
  return "ready";
}
