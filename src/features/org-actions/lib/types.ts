/**
 * The wire of an organisation call's audit record (ADR-0014): Rust emits one
 * as `atlas:org-action` for every call the organisation tool server answers,
 * refusals included (`OrgActionRecord` in
 * `src-tauri/src/commands/org_server/audit.rs`).
 */

export interface OrgActionRecord {
  /** The calling session's id. */
  sessionId: string;
  agent: string;
  /** The tool the model called, e.g. `org_members`. */
  tool: string;
  /** The tool's arguments exactly as the model sent them. */
  arguments: Record<string, unknown>;
  /** Whether the call answered, rather than being refused or failing. */
  ok: boolean;
  /** What the model was answered: the JSON result, or why it was refused. */
  text: string;
}
