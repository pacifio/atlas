use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    AuthenticateRequest, CancelNotification, CloseSessionRequest, ContentBlock,
    DeleteSessionRequest, ElicitationAction, ForkSessionRequest, ListSessionsRequest,
    LoadSessionRequest, LogoutRequest, McpServer,
    NewSessionRequest, PermissionOptionId, PromptRequest, RequestPermissionOutcome,
    SelectedPermissionOutcome, SessionConfigOptionValue, SessionId, SessionModeId,
    SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::capabilities::AgentCaps;
use crate::events::AcpEvent;
use crate::driver::{self, AgentRuntime, AuthMethodWire, SessionGuard};
use crate::error::{AcpError, Result};
use crate::events::EventSink;
use crate::schema::NewSessionInfo;
use crate::spawn::{explain_spawn_failure, resolve_command};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(pub Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

/// One session the AGENT reports it has stored (P2.3), flattened for the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    /// RFC-3339 per the schema; passed through verbatim rather than parsed, so
    /// an agent with a slightly different stamp still sorts on the frontend.
    pub updated_at: Option<String>,
}

/// One image attached to an outbound prompt (multimodal input): base64
/// `data` + its MIME type. The Tauri command folds these into the turn's
/// content via [`crate::prompt::compose`]; the resulting `ContentBlock::Image`
/// blocks are stripped again at send time unless the agent advertised
/// `promptCapabilities.image`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub mime_type: String,
    /// Raw base64 payload — no `data:` URI prefix.
    pub data_base64: String,
}

/// Description of an agent process that Atlas knows how to spawn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    pub spec_id: String,
    pub display_name: String,
    /// Shell-words–parseable command string (or a `{...}` JSON stdio spec).
    pub command: String,
    /// Where the user can get/install this agent — used by
    /// `explain_spawn_failure` for agents without a hardcoded hint (i.e.
    /// registry-installed externals; sourced from their manifest
    /// repository/website).
    #[serde(default)]
    pub help_url: Option<String>,
}

/// Provider of additional spawnable specs beyond [`AgentSpec::all_known`] —
/// implemented by the dynamic ACP registry (`atlas-registry`) so installed
/// external agents flow through the exact same spawn path as first-party ones.
pub trait SpecSource: Send + Sync {
    fn extra_specs(&self) -> Vec<AgentSpec>;
}

/// Everything Atlas knows about ONE first-party agent that isn't already in
/// its [`AgentSpec`] — the single source of truth that used to be spread
/// across four hand-synced lists (`AUTO_MANAGED_BUILTIN_IDS` here, a
/// `builtin_login_args` match, `BUILTIN_REGISTRY_IDS` in atlas-registry, and
/// `OPTIONAL_BUILTIN_AGENTS` / `PLUGIN_ID_BY_AGENT` in the frontend).
///
/// See [`BUILTIN_AGENTS`] for the table itself and the per-field rationale.
#[derive(Debug, Clone, Copy)]
pub struct BuiltinAgent {
    /// Matches [`AgentSpec::spec_id`].
    pub spec_id: &'static str,
    /// Ids in the ACP registry manifest that describe this same agent. They
    /// surface as "Built-in" in the marketplace and are never installable — an
    /// install would shadow the first-party spec.
    pub registry_ids: &'static [&'static str],
    /// The executable to look for on the user's `PATH` when deciding whether
    /// this agent is already installed system-wide. `None` = the agent is an
    /// npx-launched adapter, which is "runnable if Node exists" rather than
    /// "installed", so there is nothing to probe for.
    pub path_program: Option<&'static str>,
    /// argv appended to `path_program` to make it speak ACP over stdio.
    pub acp_args: &'static [&'static str],
    /// Atlas will download this agent's official binary from the registry
    /// manifest when no system install is found (see
    /// `RegistryStore::ensure_builtin`). Only true for the plain-CLI built-ins.
    pub auto_managed: bool,
    /// The user can turn this agent off in Settings → Agents. Claude, Codex
    /// and Cersei are the agents Atlas is built around and are never optional.
    pub optional: bool,
    /// The CLI argv that signs a user in, appended to whichever binary is
    /// resolved (system `PATH` install first, Atlas-managed download second).
    pub login_args: Option<&'static [&'static str]>,
}

/// The built-in agent table.
///
/// **Why `auto_managed` exists.** Claude and Codex spawn through `npx -y …`,
/// so npm fetches their adapter on first run and they work on a machine that
/// never installed anything by hand. cursor/opencode/kilo do not — their bare
/// commands (`cursor-agent acp`, `opencode acp`, `kilo acp`) simply ENOENT
/// there. `atlas-registry` closes that gap by downloading each one's official
/// binary from the ACP registry manifest and offering it as a dynamic spec.
/// For these ids ONLY, a dynamic spec's command REPLACES the bare command (see
/// [`AgentRegistry::known_specs`]) — every other id keeps first-party
/// precedence, so a registry install can never shadow a built-in agent.
///
/// **Why `login_args` exists.** Those same three adapters advertise an
/// `authMethod` but ship NO `_meta.terminal-auth` block, so there is nothing
/// for the host's terminal-auth runner to execute — and when Atlas downloaded
/// the CLI into its own app-data dir, the user had no binary on `PATH` to run
/// by hand either. Without this "sign in" is simply impossible from inside
/// Atlas: the agent answers every prompt with `Authentication required`
/// forever. Verified against the binaries (`--help`): cursor exposes a
/// top-level `login`; opencode (and its Kilo fork) nest it under `auth login`.
/// Each opens the browser and prints the URL on stdout, which the auth runner
/// already streams to the UI.
///
/// **Why `path_program` exists.** Atlas prefers whatever the user already
/// installed over its own downloaded copy (system-first). A hit here becomes
/// the top rung of the spawn precedence ladder in `atlas-registry`'s
/// `SpecSource::extra_specs`.
pub const BUILTIN_AGENTS: &[BuiltinAgent] = &[
    BuiltinAgent {
        spec_id: "claude-code-ts",
        // `claude-acp` in the manifest is the same adapter this launches via npx.
        registry_ids: &["claude-acp"],
        path_program: None,
        acp_args: &[],
        auto_managed: false,
        optional: false,
        login_args: None,
    },
    BuiltinAgent {
        spec_id: "claude-code-rs",
        registry_ids: &[],
        path_program: Some("claude-code-acp-rs"),
        acp_args: &[],
        auto_managed: false,
        optional: false,
        login_args: None,
    },
    BuiltinAgent {
        spec_id: "codex",
        registry_ids: &["codex-acp"],
        path_program: None,
        acp_args: &[],
        auto_managed: false,
        optional: false,
        login_args: None,
    },
    BuiltinAgent {
        spec_id: "opencode",
        registry_ids: &["opencode"],
        path_program: Some("opencode"),
        acp_args: &["acp"],
        auto_managed: true,
        optional: true,
        login_args: Some(&["auth", "login"]),
    },
    BuiltinAgent {
        spec_id: "cursor",
        registry_ids: &["cursor"],
        path_program: Some("cursor-agent"),
        acp_args: &["acp"],
        auto_managed: true,
        optional: true,
        login_args: Some(&["login"]),
    },
    BuiltinAgent {
        spec_id: "kilo",
        registry_ids: &["kilo"],
        path_program: Some("kilo"),
        acp_args: &["acp"],
        auto_managed: true,
        optional: true,
        login_args: Some(&["auth", "login"]),
    },
];

/// The table entry for `spec_id`, if it is a built-in.
pub fn builtin_agent(spec_id: &str) -> Option<&'static BuiltinAgent> {
    BUILTIN_AGENTS.iter().find(|b| b.spec_id == spec_id)
}

/// Whether Atlas downloads this agent's binary itself when no system install
/// is found (cursor / opencode / kilo).
pub fn is_auto_managed(spec_id: &str) -> bool {
    builtin_agent(spec_id).is_some_and(|b| b.auto_managed)
}

/// Every manifest id that duplicates a built-in. Registry entries with these
/// ids render as "Built-in" in the marketplace and are never installable.
pub fn builtin_registry_ids() -> Vec<&'static str> {
    BUILTIN_AGENTS
        .iter()
        .flat_map(|b| b.registry_ids.iter().copied())
        .collect()
}

/// The CLI argv that signs a user in to a built-in, appended to whichever
/// binary the host resolved for it. See [`BUILTIN_AGENTS`].
pub fn builtin_login_args(spec_id: &str) -> Option<&'static [&'static str]> {
    builtin_agent(spec_id).and_then(|b| b.login_args)
}

impl AgentSpec {
    pub fn claude_code_ts() -> Self {
        Self {
            spec_id: "claude-code-ts".into(),
            display_name: "Claude Code (canonical)".into(),
            // Upstream rename: `@zed-industries/claude-code-acp` was renamed
            // to `@agentclientprotocol/claude-agent-acp`. The old name still
            // resolves but no longer receives updates.
            command: "npx -y @agentclientprotocol/claude-agent-acp".into(),
            help_url: None,
        }
    }

    pub fn claude_code_rs() -> Self {
        Self {
            spec_id: "claude-code-rs".into(),
            display_name: "Claude Code (Rust)".into(),
            command: "claude-code-acp-rs".into(),
            help_url: None,
        }
    }

    /// Codex ACP bridge — speaks ACP over stdio around the Codex engine.
    /// Launched via `npx` (mirrors `claude_code_ts`); ships a `codex-acp` bin.
    /// Auth is inherited from the host env / `~/.codex` (ChatGPT login or
    /// `OPENAI_API_KEY`) — see `sanitize_host_env`.
    ///
    /// Uses `@agentclientprotocol/codex-acp` (the maintained replacement for the
    /// deprecated `@zed-industries/codex-acp`). CRITICAL: the old package shipped
    /// the Codex engine as a platform-specific **optional dependency**
    /// (`@zed-industries/codex-acp-darwin-arm64`); after an npm/npx cache clear
    /// npx would silently fail to reinstall that optional binary, and the agent
    /// crashed on launch with `ERR_MODULE_NOT_FOUND`. The new package has no
    /// optional platform binary — it depends on `@openai/codex` as a regular
    /// dependency + a pure-JS `dist/index.js`, so a clean/cold cache installs it
    /// reliably. Do NOT revert to `@zed-industries/codex-acp`.
    pub fn codex() -> Self {
        Self {
            spec_id: "codex".into(),
            display_name: "Codex (ACP)".into(),
            command: "npx -y @agentclientprotocol/codex-acp".into(),
            help_url: None,
        }
    }

    /// OpenCode — the `opencode` CLI speaks ACP natively over stdio via its
    /// `acp` subcommand (verified live against 1.3.15: protocol v1,
    /// `loadSession`, session `list`/`resume`/`fork`, image prompts, and a
    /// `models` blob + `build`/`plan` modes on `session/new`). Auth is the
    /// user's own `opencode auth login`; unauthenticated installs still work
    /// with the free OpenCode Zen models. Model selection uses
    /// `session/set_model` (it does NOT implement `session/set_config_option`)
    /// — see `AcpBackend::set_session_model`'s fallback.
    pub fn opencode() -> Self {
        Self {
            spec_id: "opencode".into(),
            display_name: "OpenCode".into(),
            command: "opencode acp".into(),
            help_url: None,
        }
    }

    /// Cursor — `cursor-agent acp` speaks stock ACP v1 over stdio (verified
    /// live against 2026.07.23 + the official doc, which names the binary
    /// `agent`; the installed CLI ships it as `cursor-agent`). Models arrive
    /// in the `session/new` `models` blob and switch via `session/set_model`
    /// (its `set_config_option` takes plain-string values our typed request
    /// can't produce — the backend's set_model fallback covers it). Modes are
    /// agent/plan/ask. Auth is the user's own `cursor-agent login`
    /// (method id `cursor_login`); quota exhaustion on free plans arrives as a
    /// NORMAL assistant message, not an error. Slash commands were never
    /// observed (`available_commands_update` may simply not fire).
    pub fn cursor() -> Self {
        Self {
            spec_id: "cursor".into(),
            display_name: "Cursor".into(),
            command: "cursor-agent acp".into(),
            help_url: None,
        }
    }

    /// Kilo Code — `kilo acp` (npm `@kilocode/cli`, an OpenCode fork) speaks
    /// ACP v1 as NDJSON over stdio (probed live against 7.4.20). It is on the
    /// newer config-options dialect: `session/new`/`load` return NO
    /// `modes`/`models` blobs — modes, models (~300, `provider/model`) and a
    /// reasoning-effort level all arrive as `configOptions` selects (see
    /// `schema.rs`'s normalisers). `session/set_mode` and
    /// `session/set_config_option` both work (the backend's set-model ladder
    /// succeeds on its first rung). `loadSession: true` with FULL transcript
    /// replay; ACP session ids are Kilo's real `ses_…` ids
    /// (`~/.local/share/kilo/kilo.db`). No terminal methods — shell output
    /// streams as `tool_call_update` content. Auth is the user's own
    /// `kilo auth login` (method id `kilo-login`); NOTE its `terminal-auth`
    /// meta still says `command: "opencode"` (fork residue) — never exec it
    /// verbatim. The embedded HTTP server makes `session/new` take ~1s extra.
    pub fn kilo() -> Self {
        Self {
            spec_id: "kilo".into(),
            display_name: "Kilo Code".into(),
            command: "kilo acp".into(),
            help_url: None,
        }
    }

    pub fn all_known() -> Vec<AgentSpec> {
        vec![
            Self::claude_code_ts(),
            Self::claude_code_rs(),
            Self::codex(),
            Self::opencode(),
            Self::cursor(),
            Self::kilo(),
        ]
    }
}

/// Public view of a spawned agent — what the Tauri layer hands back to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub agent_id: AgentId,
    pub spec_id: String,
    pub display_name: String,
}

struct AgentEntry {
    spec: AgentSpec,
    runtime: AgentRuntime,
}

/// Registry of live ACP agents. Cloneable handle — backed by an `Arc`.
#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<DashMap<AgentId, AgentEntry>>,
    /// Dynamic (registry-installed) specs, unioned into `known_specs`.
    /// `None` = first-party only (tests, minimal hosts).
    dynamic: Option<Arc<dyn SpecSource>>,
    /// App config dir holding `mcp-servers.json`. `None` = pass no MCP servers
    /// (tests, minimal hosts). See [`AgentRegistry::with_config_dir`].
    config_dir: Option<PathBuf>,
}

/// Bound an ACP request so a wedged adapter can't hang its caller forever
/// (H3): the actor's control ops and the host's session ops all resolve with
/// a typed [`AcpError::Timeout`] instead. `session/prompt` is deliberately
/// NOT bounded — turns are governed by the cancel machinery (CANCEL_GRACE).
async fn rpc_timeout<T>(
    rpc: &'static str,
    secs: u64,
    fut: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    match tokio::time::timeout(std::time::Duration::from_secs(secs), fut).await {
        Ok(res) => res,
        Err(_) => Err(AcpError::Timeout { rpc, secs }),
    }
}

/// Session-lifecycle RPCs (new/load/authenticate) — slow is plausible
/// (adapter cold start, browser OAuth handoff), so generous.
const LIFECYCLE_RPC_SECS: u64 = 30;
/// Session-tuning RPCs (set_mode / set_config_option) — cheap state flips;
/// anything past this is a wedged adapter.
const TUNING_RPC_SECS: u64 = 10;

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Production constructor: first-party specs plus whatever the dynamic
    /// registry store has installed.
    pub fn with_spec_source(source: Arc<dyn SpecSource>) -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            dynamic: Some(source),
            config_dir: None,
        }
    }

    /// Point the registry at the app config dir so `session/new` and
    /// `session/load` can pass the user's configured MCP servers (P1.1).
    /// Without this the registry still works — it simply sends no `mcpServers`,
    /// which is the pre-P1.1 behaviour.
    #[must_use]
    pub fn with_config_dir(mut self, config_dir: PathBuf) -> Self {
        self.config_dir = Some(config_dir);
        self
    }

    /// The user's MCP servers, filtered to the transports this agent advertised.
    /// Empty when no config dir is set, the file is absent/malformed, or every
    /// entry was filtered out — all of which are normal, not errors.
    fn mcp_servers_for(&self, agent_id: AgentId) -> Vec<McpServer> {
        let Some(dir) = self.config_dir.as_deref() else {
            return Vec::new();
        };
        let caps = self.agent_caps(agent_id).unwrap_or_default();
        crate::mcp::to_acp_servers(crate::mcp::load_configs(dir), caps)
    }

    /// First-party specs ∪ dynamic (registry-installed) specs. First-party
    /// wins on a spec-id collision — a registry install must never shadow a
    /// built-in agent.
    ///
    /// The one exception is the auto-managed built-ins (see
    /// [`BUILTIN_AGENTS`]): they have no npx distribution, so a resolved
    /// binary — the user's own system install first, Atlas's downloaded copy
    /// second — is strictly better than their bare-CLI command and takes over
    /// the `command` field IN PLACE: same id, same slot, same display name,
    /// never a second entry for one agent (the plugin catalog keys off
    /// `spec_id`). When nothing has been resolved the dynamic spec is simply
    /// absent and the bare command stands, which is the pre-existing behaviour.
    ///
    /// Note this loop is FIRST-DYNAMIC-WINS for ids it doesn't already know
    /// (`Some(_) => {}` keeps the earlier entry). The precedence ordering
    /// between a discovered binary, a managed download and a frozen install
    /// record therefore has to be resolved by the `SpecSource` itself, which
    /// emits exactly one spec per id.
    pub fn known_specs(&self) -> Vec<AgentSpec> {
        let mut specs = AgentSpec::all_known();
        if let Some(source) = &self.dynamic {
            for spec in source.extra_specs() {
                match specs.iter().position(|s| s.spec_id == spec.spec_id) {
                    Some(i) if is_auto_managed(&spec.spec_id) => {
                        specs[i].command = spec.command;
                    }
                    Some(_) => {}
                    None => specs.push(spec),
                }
            }
        }
        specs
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        self.inner
            .iter()
            .map(|e| AgentInfo {
                agent_id: *e.key(),
                spec_id: e.spec.spec_id.clone(),
                display_name: e.spec.display_name.clone(),
            })
            .collect()
    }

    /// Spawn an agent matching `spec_id`. Resolves once the protocol
    /// handshake completes (or fails).
    pub async fn spawn(
        &self,
        spec_id: &str,
        sink: Arc<dyn EventSink>,
    ) -> Result<AgentInfo> {
        let spec = self
            .known_specs()
            .into_iter()
            .find(|s| s.spec_id == spec_id)
            .ok_or_else(|| AcpError::UnknownSpec(spec_id.to_string()))?;

        let agent_id = AgentId::new();
        // Resolve the agent's program (e.g. `npx`) to an ABSOLUTE path via the
        // user's login shell, so the spawn never depends on the GUI process
        // PATH being correctly enriched. This is the belt to `enrich_path`'s
        // suspenders: the bundled/Finder-launched app inherits a minimal PATH,
        // and if the boot-time PATH merge times out or can't run, a bare `npx`
        // ENOENTs ("driver panicked"). Resolving here mirrors what the user's
        // terminal would find. Falls back to the bare command on failure.
        let command = {
            let c = spec.command.clone();
            tokio::task::spawn_blocking(move || resolve_command(&c))
                .await
                .unwrap_or_else(|_| spec.command.clone())
        };
        let runtime = driver::spawn_agent(agent_id, command, sink)
            .await
            .map_err(|e| explain_spawn_failure(&spec, e))?;

        let info = AgentInfo {
            agent_id,
            spec_id: spec.spec_id.clone(),
            display_name: spec.display_name.clone(),
        };
        self.inner.insert(agent_id, AgentEntry { spec, runtime });
        Ok(info)
    }

    /// Tear down every spawned agent (app quit): dropping each runtime's
    /// `shutdown_tx` lets the SDK close the subprocess's stdin and reap it —
    /// no orphaned `node`/`npx` processes after the app exits (M7).
    pub fn kill_all(&self) {
        let ids: Vec<AgentId> = self.inner.iter().map(|e| *e.key()).collect();
        for id in ids {
            let _ = self.kill(id);
        }
    }

    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        let mut entry = self
            .inner
            .get_mut(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(tx) = entry.runtime.shutdown_tx.take() {
            let _ = tx.send(());
        }
        drop(entry);
        self.inner.remove(&agent_id);
        Ok(())
    }

    /// Open a new session in `cwd` against the given agent. Registers
    /// a `SessionGuard` for the returned session id so the driver can
    /// gate inbound traffic on the session's lifecycle.
    pub async fn new_session(
        &self,
        agent_id: AgentId,
        cwd: PathBuf,
        additional_directories: Vec<PathBuf>,
    ) -> Result<NewSessionInfo> {
        let connection = self.connection(agent_id)?;
        let mcp_servers = self.mcp_servers_for(agent_id);
        let extra_dirs = self.additional_directories_for(agent_id, additional_directories);
        tracing::info!(
            target: "atlas_acp::registry",
            count = mcp_servers.len(),
            extra_dirs = extra_dirs.len(),
            "session/new: passing MCP servers"
        );
        let resp = rpc_timeout("session/new", LIFECYCLE_RPC_SECS, async {
            Ok(connection
                .send_request(
                    NewSessionRequest::new(cwd)
                        .mcp_servers(mcp_servers)
                        .additional_directories(extra_dirs),
                )
                .block_task()
                .await?)
        })
        .await?;
        self.register_session(agent_id, resp.session_id.clone())?;
        let session_id = resp.session_id.clone();
        let mut info: NewSessionInfo = resp.into();
        // Agents still on the pre-config-options dialect (OpenCode, Cursor)
        // answer with a top-level `models` blob that the typed
        // `NewSessionResponse` drops on the floor — without this their model
        // picker never renders. Recover it from the raw wire.
        if info.models.is_none() {
            info.models = self.take_sniffed_models(agent_id, session_id.0.as_ref());
        }
        // Diagnostic: surface what the agent advertised for model selection, so a
        // missing model picker can be diagnosed (agent didn't send `models` vs.
        // a parse gap). Logs once per new session.
        tracing::info!(
            target: "atlas_acp::registry",
            "new_session: modes_present={} models={}",
            info.modes.is_some(),
            info.models
                .as_ref()
                .map(|m| m.to_string())
                .unwrap_or_else(|| "none".into()),
        );
        Ok(info)
    }

    /// Resume a previously-saved session by id. Same guard registration
    /// as `new_session` — the resumed session can be cancelled / killed
    /// through the normal flow.
    pub async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> Result<Option<serde_json::Value>> {
        let connection = self.connection(agent_id)?;
        // A resumed session must get the same MCP servers as a fresh one — the
        // agent rebuilds its tool set from this request, so omitting them here
        // would make MCP tools vanish on resume.
        let mcp_servers = self.mcp_servers_for(agent_id);
        let resp = rpc_timeout("session/load", LIFECYCLE_RPC_SECS, async {
            Ok(connection
                .send_request(
                    LoadSessionRequest::new(session_id.clone(), cwd).mcp_servers(mcp_servers),
                )
                .block_task()
                .await?)
        })
        .await?;
        self.register_session(agent_id, session_id)?;
        // Project the (non_exhaustive, unstable-gated) `modes` blob to JSON the
        // same way `new_session` does, so the manager can seed the available
        // session-mode list for the resumed session. Config-options-dialect
        // agents (Kilo) advertise modes only as a `configOptions` select —
        // fall back to normalising that (mirrors `NewSessionInfo::from`).
        let modes = resp
            .modes
            .as_ref()
            .and_then(|m| serde_json::to_value(m).ok())
            .or_else(|| {
                serde_json::to_value(&resp.config_options)
                    .ok()
                    .and_then(|co| crate::schema::modes_blob_from_config_options(&co))
            });
        Ok(modes)
    }

    /// Run the agent's ACP `authenticate` flow for `method_id`. For Codex's
    /// "chatgpt" method this blocks while codex-acp runs a local login server
    /// and opens the browser to OpenAI (OAuth/PKCE); it resolves once the user
    /// completes sign-in (credentials land in `~/.codex/auth.json`).
    pub async fn authenticate(&self, agent_id: AgentId, method_id: String) -> Result<()> {
        let connection = self.connection(agent_id)?;
        // Bounded, but generously: this RPC legitimately waits on a HUMAN
        // completing browser sign-in (see doc above), so the tight
        // LIFECYCLE_RPC_SECS would break Codex ChatGPT login. 5 minutes turns
        // "forever" into "eventually fails visibly" without racing the user.
        rpc_timeout("authenticate", 300, async {
            connection
                .send_request(AuthenticateRequest::new(method_id))
                .block_task()
                .await?;
            Ok(())
        })
        .await
    }

    /// Tell the agent to close a session (P2.3, ACP `session/close`).
    ///
    /// `drop_session` only ever cleaned Atlas-side state — guards, terminals,
    /// buffered notifications — so every closed tab left the AGENT still
    /// holding that session's context, for the whole life of the process. Best
    /// effort and capability-gated: an agent that never advertised
    /// `sessionCapabilities.close` would answer `-32601`, and a tab close must
    /// not surface a protocol error.
    pub async fn close_session(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        if !self.agent_caps(agent_id).is_some_and(|c| c.session_close) {
            return Ok(());
        }
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/close", LIFECYCLE_RPC_SECS, async {
            connection
                .send_request(CloseSessionRequest::new(session_id))
                .block_task()
                .await?;
            Ok(())
        })
        .await
    }

    /// Extra workspace roots to hand the agent at `session/new` (P3.2).
    ///
    /// Gated on `sessionCapabilities.additionalDirectories`: an agent that
    /// never advertised it would reject or ignore the field.
    ///
    /// Caller-supplied, because the roots are a property of the SESSION and
    /// only the host knows them: they are fixed for the session's life and must
    /// be known before the first prompt, so they cannot be inferred from
    /// `@workspace` / `@repo` mentions (those are per-MESSAGE context, and
    /// promoting one would pin a directory the user referenced once as a
    /// permanent root).
    ///
    /// Atlas's own UI passes none today — a workspace has exactly one `path` —
    /// so in practice this is empty until Atlas grows multi-root sessions. The
    /// command accepts them regardless, so the feature is usable the moment
    /// there is something to pass.
    fn additional_directories_for(
        &self,
        agent_id: AgentId,
        requested: Vec<PathBuf>,
    ) -> Vec<PathBuf> {
        if requested.is_empty() {
            return Vec::new();
        }
        if !self
            .agent_caps(agent_id)
            .is_some_and(|c| c.session_additional_directories)
        {
            tracing::debug!(
                target: "atlas_acp::registry",
                count = requested.len(),
                "dropping additional directories — agent did not advertise the capability"
            );
            return Vec::new();
        }
        requested
    }

    /// Branch a session from its current state (P3.4, ACP `session/fork`).
    ///
    /// The forked session starts with the parent's history and diverges from
    /// there, which is what makes "try a different approach from here" possible
    /// without losing the thread that got you there. `None` when the agent
    /// never advertised `sessionCapabilities.fork`.
    pub async fn fork_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
        additional_directories: Vec<PathBuf>,
    ) -> Result<Option<NewSessionInfo>> {
        if !self.agent_caps(agent_id).is_some_and(|c| c.session_fork) {
            return Ok(None);
        }
        let connection = self.connection(agent_id)?;
        let mcp_servers = self.mcp_servers_for(agent_id);
        // A fork inherits the parent's roots; the caller re-supplies them.
        let extra_dirs = self.additional_directories_for(agent_id, additional_directories);
        let resp = rpc_timeout("session/fork", LIFECYCLE_RPC_SECS, async {
            Ok(connection
                .send_request(
                    ForkSessionRequest::new(session_id, cwd)
                        .mcp_servers(mcp_servers)
                        .additional_directories(extra_dirs),
                )
                .block_task()
                .await?)
        })
        .await?;
        // The fork is a real session on the agent — register a guard so it can
        // be cancelled and torn down through the normal path.
        self.register_session(agent_id, resp.session_id.clone())?;
        Ok(Some(NewSessionInfo {
            session_id: resp.session_id,
            modes: resp.modes.as_ref().and_then(|m| serde_json::to_value(m).ok()),
            models: None,
        }))
    }

    /// Answer an elicitation the agent raised (P3.3).
    ///
    /// `content` is the form's field map for an accept; `None` on decline or
    /// cancel. Unknown request ids are a no-op rather than an error — a user
    /// can answer a dialog whose agent already died, and that must not surface
    /// as a failure they can do nothing about.
    pub fn respond_elicitation(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        action: &str,
        content: Option<serde_json::Value>,
    ) -> Result<()> {
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
        let Some((_, pending)) = entry.runtime.pending_elicitations.remove(&request_id) else {
            return Ok(());
        };
        let outcome = match action {
            "accept" => {
                // Round-trip the field map through JSON: the value type is
                // `#[non_exhaustive]` and the UI produces plain JSON scalars.
                let parsed = content
                    .and_then(|c| serde_json::from_value(serde_json::json!({ "content": c })).ok())
                    .unwrap_or_default();
                ElicitationAction::Accept(parsed)
            }
            "decline" => ElicitationAction::Decline,
            _ => ElicitationAction::Cancel,
        };
        let _ = pending.sender.send(outcome);
        Ok(())
    }

    // ── P3.6 providers: BLOCKED at the library level ────────────────────
    //
    // `providers/list|set|disable` cannot be dispatched from this build. P0.1
    // made the schema TYPES reachable (`ProviderInfo`, `ListProvidersRequest`,
    // and `AgentCaps.providers` reads the capability today), but the JSON-RPC
    // plumbing lives in the top-level `agent-client-protocol` crate, and 1.3.0
    // does not mention `ListProvidersRequest` anywhere — so the types carry no
    // `JsonRpcRequest` impl and `send_request` will not accept them. There is
    // no raw-send escape hatch on the connection either.
    //
    // Unblocking needs a newer `agent-client-protocol` that wires the provider
    // methods. Nothing here is worth faking in the meantime: an agent that
    // advertises `providers` is still detected (`AgentCaps.providers`), so the
    // capability is captured and ready the day the dispatch exists.

    /// List the agent's own stored sessions for `cwd` (P2.3, ACP
    /// `session/list`).
    ///
    /// `None` when the agent never advertised `sessionCapabilities.list` — the
    /// caller then falls back to Atlas's per-agent disk scans. This is the
    /// method that makes any NEW ACP agent get sidebar history for free: today
    /// each agent needs a bespoke reader (Claude JSONL, Codex SQLite, Kilo
    /// SQLite, Cersei JSON, Atlas's own transcripts), and an agent Atlas has
    /// never heard of gets nothing.
    ///
    /// Pages through `next_cursor` so a long history is complete rather than
    /// truncated at whatever the agent's page size happens to be. Bounded by
    /// `MAX_SESSION_PAGES` so a misbehaving agent that always returns a cursor
    /// cannot spin here forever.
    pub async fn list_sessions(
        &self,
        agent_id: AgentId,
        cwd: PathBuf,
    ) -> Result<Option<Vec<AgentSessionInfo>>> {
        if !self.agent_caps(agent_id).is_some_and(|c| c.session_list) {
            return Ok(None);
        }
        const MAX_SESSION_PAGES: usize = 20;
        let connection = self.connection(agent_id)?;
        let mut out: Vec<AgentSessionInfo> = Vec::new();
        let mut cursor: Option<String> = None;
        for page in 0..MAX_SESSION_PAGES {
            let req = {
                let mut r = ListSessionsRequest::new().cwd(cwd.clone());
                if let Some(c) = cursor.take() {
                    r = r.cursor(c);
                }
                r
            };
            let resp = rpc_timeout("session/list", LIFECYCLE_RPC_SECS, async {
                Ok(connection.send_request(req).block_task().await?)
            })
            .await?;
            out.extend(resp.sessions.iter().map(|s| AgentSessionInfo {
                session_id: s.session_id.0.to_string(),
                cwd: s.cwd.to_string_lossy().into_owned(),
                title: s.title.clone(),
                updated_at: s.updated_at.clone(),
            }));
            match resp.next_cursor.clone() {
                Some(next) if page + 1 < MAX_SESSION_PAGES => cursor = Some(next),
                Some(_) => {
                    tracing::warn!(
                        target: "atlas_acp::registry",
                        pages = MAX_SESSION_PAGES,
                        "session/list still paging at the cap — returning what we have"
                    );
                    break;
                }
                None => break,
            }
        }
        Ok(Some(out))
    }

    /// Ask the agent to forget a stored session (P2.3, ACP `session/delete`).
    /// Capability-gated for the same reason as [`Self::close_session`].
    pub async fn delete_session(&self, agent_id: AgentId, session_id: SessionId) -> Result<bool> {
        if !self.agent_caps(agent_id).is_some_and(|c| c.session_delete) {
            return Ok(false);
        }
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/delete", LIFECYCLE_RPC_SECS, async {
            connection
                .send_request(DeleteSessionRequest::new(session_id))
                .block_task()
                .await?;
            Ok(true)
        })
        .await
    }

    /// Whether the agent said it can replay a stored session (P2.3).
    ///
    /// Replaces reading the hardcoded per-plugin `TranscriptKind` for resume
    /// eligibility: that table has to be edited by hand for every new agent,
    /// whereas this is what the agent itself reported at `initialize`.
    #[must_use]
    pub fn supports_load_session(&self, agent_id: AgentId) -> bool {
        self.agent_caps(agent_id).is_some_and(|c| c.load_session)
    }

    /// Sign the agent out (A2, ACP `logout`).
    ///
    /// Session-less by design — the request carries only `_meta`, because it
    /// drops the AGENT's stored credentials, not a session's. Both
    /// claude-agent-acp and codex-acp advertise `auth.logout` (captured live in
    /// the auth loop's R1), so this has real consumers.
    ///
    /// Bounded by the tight lifecycle timeout rather than `authenticate`'s
    /// 5-minute budget: nothing here waits on a human, so a wedged adapter
    /// should fail fast instead of hanging a settings click.
    pub async fn logout(&self, agent_id: AgentId) -> Result<()> {
        let connection = self.connection(agent_id)?;
        rpc_timeout("logout", LIFECYCLE_RPC_SECS, async {
            connection.send_request(LogoutRequest::new()).block_task().await?;
            Ok(())
        })
        .await
    }

    /// Install a lifecycle guard for a session. Idempotent — if a
    /// guard for this session already exists, the call is a no-op.
    /// Collect the legacy `models` blob the driver's wire tap captured for this
    /// session, if the agent sent one. `None` for agents on the config-options
    /// dialect (whose models come through the typed response) and for agents
    /// with no model selection at all.
    fn take_sniffed_models(&self, agent_id: AgentId, session_id: &str) -> Option<serde_json::Value> {
        self.inner
            .get(&agent_id)?
            .runtime
            .model_sniffer
            .take(session_id)
    }

    /// Called from `new_session` / `load_session`.
    pub fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        entry
            .runtime
            .session_guards
            .entry(session_id)
            .or_insert_with(|| Arc::new(SessionGuard::new()));
        Ok(())
    }

    /// Remove a session's guard. Called when the host-side session
    /// representation is being torn down (tab close, project switch,
    /// agent kill) so the driver's gates drop any further inbound
    /// traffic for this id.
    pub fn drop_session(&self, agent_id: AgentId, session_id: &SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        entry.runtime.session_guards.remove(session_id);
        // Kill any command this session's agent left running (P1.2). ACP
        // expects `terminal/release`, but a tab closed mid-build — or an agent
        // that dies before releasing — would otherwise orphan the child with
        // nothing left holding a handle to reap it.
        let reaped = entry
            .runtime
            .terminals
            .release_session(session_id.0.as_ref());
        if reaped > 0 {
            tracing::info!(
                target: "atlas_acp::registry",
                count = reaped,
                "drop_session: killed orphaned terminals"
            );
        }
        Ok(())
    }

    /// Re-arm the session's guard before starting a new turn. Bumps
    /// the turn epoch and clears the `cancelled` flag so inbound
    /// notifications / permission requests for this turn flow
    /// through. Called by the actor right before `send_prompt`.
    /// Returns the new turn epoch — the driver stamps it onto every
    /// event it emits for this session, and the actor matches the
    /// stamps against this value to drop stale-turn stragglers.
    pub fn mark_turn_started(
        &self,
        agent_id: AgentId,
        session_id: &SessionId,
    ) -> Result<u64> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(guard) = entry.runtime.session_guards.get(session_id) {
            return Ok(guard.mark_turn_started());
        }
        // Race: send arrived before register_session finished, or
        // the session was just dropped. Install a fresh guard so
        // the turn isn't auto-blocked.
        let guard = Arc::new(SessionGuard::new());
        let epoch = guard.mark_turn_started();
        entry
            .runtime
            .session_guards
            .insert(session_id.clone(), guard);
        Ok(epoch)
    }

    /// Send one turn's content. Resolves with the turn's `StopReason` when the
    /// agent finishes streaming; notifications fire over the event sink
    /// throughout the turn.
    ///
    /// Content arrives already composed (P0.2) — before that, images travelled
    /// out-of-band through a `stage_attachments` map that this method drained.
    /// The one thing that cannot move upstream is the capability filter below:
    /// this is the only layer that knows what the agent advertised.
    pub async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        content: Vec<ContentBlock>,
    ) -> Result<StopReason> {
        let image_supported = {
            let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
            entry.runtime.caps.prompt_image
        };
        let content = crate::prompt::strip_unsupported(content, image_supported);
        let connection = self.connection(agent_id)?;
        let resp = connection
            .send_request(PromptRequest::new(session_id.clone(), content))
            .block_task()
            .await?;
        // P2.5: `PromptResponse.usage` was discarded here. It arrives as an RPC
        // RESULT rather than a notification, so the driver task never sees it
        // and ACP agents showed no token usage at all — the existing usage UI
        // was native-agent-only for that reason alone. Re-emitted through the
        // same `AcpEvent::Usage` path the native agent uses, so nothing
        // downstream needed a new branch.
        if let Some(usage) = resp.usage.as_ref() {
            if let Some(entry) = self.inner.get(&agent_id) {
                entry.runtime.sink.emit(
                    agent_id,
                    AcpEvent::Usage {
                        session_id,
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        // ACP carries no pricing, so the session's running cost
                        // is left exactly as it was rather than reset.
                        cost: None,
                        cache_read_tokens: usage.cached_read_tokens,
                        cache_write_tokens: usage.cached_write_tokens,
                    },
                    None,
                );
            }
        }
        Ok(resp.stop_reason)
    }


    /// Whether the agent advertised `promptCapabilities.image` at
    /// initialize. `false` for unknown agents.
    pub fn prompt_image_supported(&self, agent_id: AgentId) -> bool {
        self.agent_caps(agent_id).is_some_and(|c| c.prompt_image)
    }

    /// Everything the agent advertised at `initialize` (P0.3). `None` for an
    /// agent that is not spawned. Downstream parity tasks read this instead of
    /// re-deriving capabilities from the wire.
    pub fn agent_caps(&self, agent_id: AgentId) -> Option<AgentCaps> {
        self.inner.get(&agent_id).map(|e| e.runtime.caps)
    }

    /// Switch the session's permission mode (default / acceptEdits / plan /
    /// dontAsk / bypassPermissions). Calling this with `bypassPermissions`
    /// stops the agent from ever emitting `RequestPermissionRequest` — the
    /// fix for "bypass mode still prompts".
    pub async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/set_mode", TUNING_RPC_SECS, async {
            connection
                .send_request(SetSessionModeRequest::new(
                    session_id,
                    SessionModeId::new(mode_id),
                ))
                .block_task()
                .await?;
            Ok(())
        })
        .await
    }

    /// `session/set_model` — the model-selection RPC agents with a `models`
    /// blob accept (OpenCode, Cursor; the TS SDK calls it
    /// `unstable_setSessionModel`). The Rust crate has no typed request for it,
    /// so it goes out as an `UntypedMessage`. Verified live against
    /// `opencode acp` 1.3.15 and `cursor-agent` 2026.07.23.
    pub async fn set_session_model(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        model_id: String,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/set_model", TUNING_RPC_SECS, async {
            let msg = agent_client_protocol::UntypedMessage::new(
                "session/set_model",
                serde_json::json!({ "sessionId": session_id, "modelId": model_id }),
            )?;
            connection.send_request(msg).block_task().await?;
            Ok(())
        })
        .await
    }

    /// Set a session config option (`session/set_config_option`) — the current
    /// mechanism Claude Code / Codex use for model (config_id "model"), effort,
    /// etc. `value` is the option's selected value id.
    pub async fn set_session_config_option(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        config_id: &str,
        value: String,
    ) -> Result<()> {
        self.set_config_option_value(
            agent_id,
            session_id,
            config_id,
            SessionConfigOptionValue::value_id(value),
        )
        .await
    }

    /// Set any advertised config option from a JSON value (P2.2).
    ///
    /// ACP has exactly two value shapes and they are not interchangeable on the
    /// wire, so the JSON type picks: a bool becomes `Boolean`, anything else is
    /// stringified into `ValueId` (the select form). Before this only the
    /// select form existed, which made every boolean knob an agent advertised —
    /// thinking toggles being the common one — unsettable.
    pub async fn set_config_option_json(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        config_id: &str,
        value: serde_json::Value,
    ) -> Result<()> {
        let wire = match value {
            serde_json::Value::Bool(b) => SessionConfigOptionValue::boolean(b),
            serde_json::Value::String(s) => SessionConfigOptionValue::value_id(s),
            other => SessionConfigOptionValue::value_id(other.to_string()),
        };
        self.set_config_option_value(agent_id, session_id, config_id, wire)
            .await
    }

    async fn set_config_option_value(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        config_id: &str,
        value: SessionConfigOptionValue,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/set_config_option", TUNING_RPC_SECS, async {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id,
                    config_id.to_string(),
                    value,
                ))
                .block_task()
                .await?;
            Ok(())
        })
        .await
    }

    /// Cancel an in-flight prompt turn. Three things happen:
    ///
    /// 1. The session's lifecycle guard is marked `cancelled`. From
    ///    this point until the next `mark_turn_started`, the driver
    ///    drops every inbound notification / permission request for
    ///    this session at the protocol boundary — no late popups, no
    ///    transcript contamination.
    /// 2. Already-pending permission senders are dropped so the
    ///    driver's `rx.await` resolves as `Cancelled` and the agent
    ///    gets a clean answer for in-flight requests.
    /// 3. `CancelNotification` is sent so the agent winds down the
    ///    turn and replies to `send_prompt` with
    ///    `StopReason::Cancelled` per ACP spec.
    pub fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(guard) = entry.runtime.session_guards.get(&session_id) {
            guard.mark_cancelled();
        }
        entry
            .runtime
            .pending_permissions
            .retain(|_, p| p.session_id != session_id);
        let connection = entry.runtime.connection.clone();
        drop(entry);
        connection
            .send_notification(CancelNotification::new(session_id))?;
        Ok(())
    }

    /// Drop every pending permission for a session, returning their ids.
    /// Dropping the oneshot sender resolves the driver's `rx.await` as
    /// `Cancelled`, so the agent gets a clean outcome for each in-flight
    /// request (ACP spec). Called by the session actor when a turn
    /// finalizes, so no modal survives its turn (H6/M3).
    pub fn take_pending_permissions(
        &self,
        agent_id: AgentId,
        session_id: &SessionId,
    ) -> Vec<Uuid> {
        let Some(entry) = self.inner.get(&agent_id) else {
            return Vec::new();
        };
        let ids: Vec<Uuid> = entry
            .runtime
            .pending_permissions
            .iter()
            .filter(|e| e.value().session_id == *session_id)
            .map(|e| *e.key())
            .collect();
        for id in &ids {
            entry.runtime.pending_permissions.remove(id);
        }
        ids
    }

    /// Resolve a permission request that the agent emitted earlier.
    pub fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        outcome: PermissionDecision,
    ) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        let (_, pending) = entry
            .runtime
            .pending_permissions
            .remove(&request_id)
            .ok_or(AcpError::UnknownPermissionRequest(request_id))?;
        let resolved = match outcome {
            PermissionDecision::Selected { option_id } => RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(PermissionOptionId::new(option_id)),
            ),
            PermissionDecision::Cancelled => RequestPermissionOutcome::Cancelled,
        };
        pending
            .sender
            .send(resolved)
            .map_err(|_| AcpError::other("permission handler already dropped"))?;
        Ok(())
    }

    fn connection(&self, agent_id: AgentId) -> Result<agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        Ok(entry.runtime.connection.clone())
    }

    /// Auth methods the agent advertised in its `initialize` response.
    /// Empty if the agent doesn't support any (or didn't run `initialize`
    /// successfully — though spawn would have errored in that case).
    pub fn auth_methods(&self, agent_id: AgentId) -> Result<Vec<AuthMethodWire>> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        Ok(entry.runtime.auth_methods.clone())
    }
}

/// Frontend-friendly permission outcome — the schema's enum is non_exhaustive
/// and has Selected wrapping a struct, awkward to serialize across the wire.
///
/// Struct variant (not tuple) because serde's internal tagging (`tag = "..."`)
/// only supports struct or unit variants; a tuple variant would silently lose
/// the inner value when deserialised across the Tauri boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PermissionDecision {
    Selected { option_id: String },
    Cancelled,
}

#[cfg(test)]
mod spec_source_tests {
    use super::*;

    struct FakeSource(Vec<AgentSpec>);
    impl SpecSource for FakeSource {
        fn extra_specs(&self) -> Vec<AgentSpec> {
            self.0.clone()
        }
    }

    fn external(spec_id: &str) -> AgentSpec {
        AgentSpec {
            spec_id: spec_id.into(),
            display_name: spec_id.into(),
            command: format!("npx -y {spec_id}"),
            help_url: Some("https://example.com".into()),
        }
    }

    #[test]
    fn known_specs_is_first_party_only_without_a_source() {
        let registry = AgentRegistry::new();
        let ids: Vec<String> = registry.known_specs().into_iter().map(|s| s.spec_id).collect();
        assert_eq!(
            ids,
            AgentSpec::all_known().into_iter().map(|s| s.spec_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn known_specs_unions_dynamic_specs() {
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![
            external("amp-acp"),
        ])));
        let ids: Vec<String> = registry.known_specs().into_iter().map(|s| s.spec_id).collect();
        assert!(ids.contains(&"amp-acp".to_string()));
        assert_eq!(ids.len(), AgentSpec::all_known().len() + 1);
    }

    #[test]
    fn first_party_wins_on_spec_id_collision() {
        // A registry install must never shadow a built-in agent's command.
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![
            external("codex"),
        ])));
        let specs = registry.known_specs();
        let codex: Vec<&AgentSpec> = specs.iter().filter(|s| s.spec_id == "codex").collect();
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].command, AgentSpec::codex().command);
    }

    #[test]
    fn auto_managed_builtin_takes_the_dynamic_command_in_place() {
        // cursor/opencode/kilo have no npx distribution, so the registry's
        // downloaded binary replaces the bare CLI — but stays ONE entry with
        // the built-in's own display name.
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![
            external("cursor"),
        ])));
        let specs = registry.known_specs();
        let cursor: Vec<&AgentSpec> = specs.iter().filter(|s| s.spec_id == "cursor").collect();
        assert_eq!(cursor.len(), 1);
        assert_eq!(cursor[0].command, "npx -y cursor");
        assert_eq!(cursor[0].display_name, AgentSpec::cursor().display_name);
        assert_eq!(specs.len(), AgentSpec::all_known().len());
    }

    #[test]
    fn auto_managed_builtin_keeps_bare_command_without_a_dynamic_spec() {
        // Nothing acquired (offline / no manifest) → pre-existing behaviour.
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![])));
        let specs = registry.known_specs();
        let cursor = specs.iter().find(|s| s.spec_id == "cursor").unwrap();
        assert_eq!(cursor.command, "cursor-agent acp");
    }
}

/// The builtin table is the single source of truth for four things that used
/// to be hand-synced lists. These guard it against drifting from the specs it
/// annotates.
#[cfg(test)]
mod builtin_table_tests {
    use super::*;

    #[test]
    fn every_table_id_is_a_real_spec_and_every_spec_is_in_the_table() {
        let spec_ids: Vec<String> = AgentSpec::all_known().into_iter().map(|s| s.spec_id).collect();
        let table_ids: Vec<&str> = BUILTIN_AGENTS.iter().map(|b| b.spec_id).collect();
        for id in &table_ids {
            assert!(spec_ids.iter().any(|s| s == id), "{id} has no AgentSpec");
        }
        for id in &spec_ids {
            assert!(
                table_ids.iter().any(|t| t == id),
                "{id} is missing from BUILTIN_AGENTS"
            );
        }
        assert_eq!(table_ids.len(), spec_ids.len(), "no duplicate table entries");
    }

    #[test]
    fn the_auto_managed_set_is_exactly_the_three_plain_cli_builtins() {
        let auto: Vec<&str> = BUILTIN_AGENTS
            .iter()
            .filter(|b| b.auto_managed)
            .map(|b| b.spec_id)
            .collect();
        assert_eq!(auto, vec!["opencode", "cursor", "kilo"]);
        // Optional-in-Settings and auto-managed are the same set: only agents
        // Atlas downloads for you may be turned off.
        let optional: Vec<&str> = BUILTIN_AGENTS
            .iter()
            .filter(|b| b.optional)
            .map(|b| b.spec_id)
            .collect();
        assert_eq!(auto, optional);
    }

    #[test]
    fn login_argv_matches_each_cli() {
        // Verified against the real binaries' `--help`: cursor exposes a
        // top-level `login`; opencode/kilo nest it under `auth login`.
        assert_eq!(builtin_login_args("cursor"), Some(&["login"][..]));
        assert_eq!(builtin_login_args("opencode"), Some(&["auth", "login"][..]));
        assert_eq!(builtin_login_args("kilo"), Some(&["auth", "login"][..]));
        assert_eq!(builtin_login_args("codex"), None);
        assert_eq!(builtin_login_args("claude-code-ts"), None);
        assert_eq!(builtin_login_args("amp-acp"), None);
    }

    #[test]
    fn auto_managed_builtins_are_probeable_and_speak_acp() {
        // An auto-managed agent Atlas can't look for on PATH would silently
        // never take the system-first path.
        for b in BUILTIN_AGENTS.iter().filter(|b| b.auto_managed) {
            assert!(b.path_program.is_some(), "{} needs a path_program", b.spec_id);
            assert_eq!(b.acp_args, &["acp"], "{} argv", b.spec_id);
            assert!(b.login_args.is_some(), "{} needs login_args", b.spec_id);
        }
    }

    #[test]
    fn builtin_registry_ids_covers_every_manifest_duplicate() {
        let ids = builtin_registry_ids();
        for id in ["claude-acp", "codex-acp", "opencode", "cursor", "kilo"] {
            assert!(ids.contains(&id), "{id} must be marked built-in");
        }
        assert_eq!(ids.len(), 5, "no extras — an entry here blocks an install");
    }

    #[test]
    fn probe_programs_match_the_bare_spec_commands() {
        // `path_program` must be the same executable the bare command names,
        // or a PATH hit would spawn a different binary than the fallback.
        for b in BUILTIN_AGENTS {
            let Some(program) = b.path_program else { continue };
            let spec = AgentSpec::all_known()
                .into_iter()
                .find(|s| s.spec_id == b.spec_id)
                .unwrap();
            let mut tokens = spec.command.split_whitespace();
            assert_eq!(tokens.next(), Some(program), "{} program", b.spec_id);
            let args: Vec<&str> = tokens.collect();
            assert_eq!(args, b.acp_args, "{} args", b.spec_id);
        }
    }
}
