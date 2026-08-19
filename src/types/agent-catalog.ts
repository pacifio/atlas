// TS mirror of `src-tauri/src/commands/catalog.rs` — the ONE backend answer to
// "which agents exist and how would each one launch right now".
//
// Keep in sync with the Rust structs; the wire shape is camelCase serde.

/** How a spawn of this agent would launch it right now. */
export type AgentSource =
  /** The native in-process agent — no subprocess at all. */
  | "in-process"
  /** A system install found on the user's PATH (system-first, rung 1). */
  | "system-path"
  /** A binary Atlas downloaded into its app-data dir (rung 2). */
  | "managed-binary"
  /** A marketplace install record (rung 3). */
  | "installed"
  /** Launches via `npx -y <package>` — npm fetches it on first run. */
  | "npx"
  /** Launches via `uvx <package>` — needs uv on the machine. */
  | "uvx"
  /** An auto-managed built-in with nothing resolved yet: the next spawn
   *  downloads its official binary. */
  | "auto-acquire"
  /** Nothing runnable — no install, no download path, no runner. */
  | "unavailable";

export type AgentKind = "native" | "builtin" | "external";

export type AgentTranscript = "none" | "claude_jsonl" | "cersei_json";

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
  /** Has a marketplace install record. A discovered-on-PATH agent is
   *  `installed: false, source: "system-path"` — the user installed it, not
   *  Atlas. */
  installed: boolean;
  autoManaged: boolean;
  /** Can be turned off in Settings → Agents. */
  optional: boolean;
  disabled: boolean;
  supportsModes: boolean;
  supportsModels: boolean;
  transcript: AgentTranscript;
  login: AgentLoginSpec | null;
  iconDataUrl: string | null;
  helpUrl: string | null;
  repository: string | null;
  website: string | null;
  platformSupported: boolean;
  /** "" when unsupported; else "binary" | "npx" | "uvx". */
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
  | "settings"
  | "acquire"
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
  if (entry.source === "auto-acquire") return "needs-download";
  if (entry.source === "unavailable") return "unavailable";
  return "ready";
}
