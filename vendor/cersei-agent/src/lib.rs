//! cersei-agent: The high-level Agent API with builder pattern, agentic loop,
//! realtime event streaming, broadcast channels, and reporters.

pub mod agent_tool;
pub mod auto_dream;
pub mod compact;
pub mod context_analyzer;
pub mod coordinator;
pub mod delegate;
pub mod delegate_tool;
pub mod effort;
pub mod events;
pub mod reporters;
pub mod retry;
mod runner;
pub mod session_memory;
pub mod system_prompt;

// Re-export runner utilities
pub use runner::apply_tool_result_budget;

/// ATLAS PATCH marker (vendor/cersei-agent via `[patch.crates-io]`): the
/// runner races tool execution against the cancel token and synthesizes
/// paired cancelled tool_results for orphaned tool_use blocks (see runner.rs).
/// Referencing this constant fails to compile if a build resolves the
/// unpatched crates.io release, so the patch cannot silently regress.
pub const ATLAS_CANCEL_PATCH: &str = "tool-cancel-race-v1";

/// ATLAS PATCH marker (vendor/cersei-agent via `[patch.crates-io]`): the
/// `ToolEnd` event carries `ToolResult::metadata`, which upstream discards.
/// Referencing this constant fails to compile if a build resolves the
/// unpatched crates.io release, so the patch cannot silently regress.
pub const ATLAS_TOOL_METADATA_PATCH: &str = "tool-result-metadata-v1";

/// ATLAS PATCH marker: provider errors are classified as transient or permanent
/// and only the transient ones are retried, with backoff. Unpatched, a rate
/// limit ends the turn and a bad key is retried three times before it does.
pub const ATLAS_RETRY_PATCH: &str = "retry-classified-v1";

/// ATLAS PATCH marker: the delegate's provider factory is fallible, so a
/// rebuild error becomes a per-task delegate error rendered in the tool card
/// rather than a panic that aborts the whole parent turn through the actor's
/// supervisor.
pub const ATLAS_DELEGATE_PATCH: &str = "delegate-fallible-factory";

/// ATLAS PATCH marker: mid-turn steering. `Agent::steer` (and
/// `AgentControl::InjectMessage`) queue a user message that the runner injects
/// at the next tool-batch boundary instead of rejecting the send. Referencing
/// this constant fails to compile against the unpatched crates.io release.
pub const ATLAS_STEERING_PATCH: &str = "steering-queue-v1";

/// ATLAS PATCH marker: the doom-loop detector keys on (tool, input-hash) and
/// requires failures — a healthy Read/Edit alternation no longer trips it —
/// and a second trigger after the nudge escalates to a permission ask instead
/// of letting the model thrash to the turn cap.
pub const ATLAS_DOOM_LOOP_PATCH: &str = "doom-loop-input-hash-v1";

/// ATLAS PATCH marker: a MaxTokens stop that carries tool_use blocks fails
/// them closed (paired error tool_results) instead of leaving unpaired
/// tool_use in history — salvage-parsed JSON from a truncated stream
/// validates but lies, and an unpaired tool_use is an API error next turn.
pub const ATLAS_MAX_TOKENS_GUARD_PATCH: &str = "max-tokens-guard-v1";

/// ATLAS PATCH marker: auto-compaction fires a pre-compact hook with the full
/// message snapshot before summarization (contract C1 — the memory flush
/// runs here), and emits `CompactStart`/`CompactEnd` events, which upstream
/// defined but never emitted.
pub const ATLAS_PRE_COMPACT_PATCH: &str = "pre-compact-hook-v1";

/// ATLAS PATCH (M2, model profile): per-model adaptation knobs the crates.io
/// release lacks — a `context_window` override (the built-in substring table
/// defaults unknown models to 200k, so small models die by overflow instead
/// of compacting), the builder's `compact_threshold` actually honored by the
/// runner (it was stored and never read), and a `reasoning_effort` option
/// forwarded to providers that express thinking as an effort level rather
/// than a token budget (OpenAI o-series / gpt-5).
pub const ATLAS_MODEL_PROFILE_PATCH: &str = "model-profile-v1";

/// ATLAS PATCH (doom-loop-input-hash-v1): tool name of the synthetic
/// permission request the runner raises when the doom-loop detector fires a
/// second time. Not a real tool: permission policies special-case it (Atlas
/// always prompts unless in bypass mode).
pub const DOOM_LOOP_ASK: &str = "__doom_loop__";

/// Sentinel content of the tool_result synthesized for a tool_use orphaned by
/// cancellation — keeps provider history valid for the next turn (every
/// tool_use must have a matching tool_result).
pub const TOOL_CANCELLED_MESSAGE: &str = "Tool cancelled by user.";

/// ATLAS PATCH (max-tokens-guard-v1): sentinel content of the tool_result
/// synthesized for a tool_use carried by a MaxTokens-stopped message. The
/// call was never executed; its salvage-parsed arguments may be incomplete.
pub const MAX_TOKENS_TOOL_MESSAGE: &str =
    "Response hit the output-token limit mid-call; this tool call was NOT \
     executed (its arguments may be incomplete). Re-issue the complete call.";

/// ATLAS PATCH (pre-compact-hook-v1): async callback invoked with a snapshot
/// of the full conversation right before auto-compaction summarizes it. The
/// hook must not assume any particular split point — it sees everything, and
/// what it wants to survive summarization it must persist itself.
pub type PreCompactHook = std::sync::Arc<
    dyn Fn(Vec<Message>) -> futures::future::BoxFuture<'static, ()> + Send + Sync,
>;

use cersei_hooks::Hook;
use cersei_mcp::McpServerConfig;
use cersei_memory::Memory;
use cersei_provider::Provider;
use cersei_tools::permissions::{AllowAll, PermissionPolicy};
use cersei_tools::{CostTracker, Tool};
use cersei_types::*;
use events::AgentEvent;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

// Re-exports
pub use events::{AgentStream, CompactReason, WarningState};
pub use reporters::Reporter;

// ─── Agent output ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AgentOutput {
    pub message: Message,
    pub usage: Usage,
    pub stop_reason: StopReason,
    pub turns: u32,
    pub tool_calls: Vec<ToolCallRecord>,
}

impl AgentOutput {
    pub fn text(&self) -> &str {
        self.message.get_text().unwrap_or("")
    }
}

#[derive(Debug, Clone)]
pub struct ToolCallRecord {
    pub name: String,
    pub id: String,
    pub input: serde_json::Value,
    pub result: String,
    pub is_error: bool,
    pub duration: Duration,
}

// ─── Agent ───────────────────────────────────────────────────────────────────

#[allow(dead_code)]
pub struct Agent {
    provider: Box<dyn Provider>,
    tools: Vec<Box<dyn Tool>>,
    system_prompt: Option<String>,
    append_system_prompt: Option<String>,
    model: Option<String>,
    max_turns: u32,
    max_tokens: u32,
    temperature: Option<f32>,
    thinking_budget: Option<u32>,
    reasoning_effort: Option<String>,
    context_window: Option<u64>,
    working_dir: PathBuf,
    permission_policy: Arc<dyn PermissionPolicy>,
    memory: Option<Arc<dyn Memory>>,
    session_id: Option<String>,
    hooks: Vec<Arc<dyn Hook>>,
    mcp_manager: Option<Arc<cersei_mcp::McpManager>>,
    event_handler: Option<Box<dyn Fn(&AgentEvent) + Send + Sync>>,
    broadcast_tx: Option<broadcast::Sender<AgentEvent>>,
    reporters: Vec<Arc<dyn Reporter>>,
    event_filter: Option<Box<dyn Fn(&AgentEvent) -> bool + Send + Sync>>,
    cost_tracker: Arc<CostTracker>,
    auto_compact: bool,
    compact_threshold: f64,
    tool_result_budget: usize,
    /// Cadence (in turns) at which `HookEvent::TurnsElapsed` fires. Default
    /// 10. Setting to 0 disables the event entirely. Used by the
    /// `SkillNudgeHook` for agent-curated skill review.
    pub(crate) turns_elapsed_cadence: u32,
    pub(crate) compression_level: Arc<parking_lot::Mutex<cersei_compression::CompressionLevel>>,
    pub benchmark_mode: bool,
    messages: Arc<parking_lot::Mutex<Vec<Message>>>,
    cumulative_usage: Arc<parking_lot::Mutex<Usage>>,
    cancel_token: tokio_util::sync::CancellationToken,
    /// ATLAS PATCH (steering-queue-v1): user messages queued while a turn is
    /// running. The runner drains this at every tool-batch boundary (and once
    /// more before finishing on EndTurn) and injects each as a user message.
    pub(crate) steering: parking_lot::Mutex<std::collections::VecDeque<String>>,
    /// ATLAS PATCH (pre-compact-hook-v1): awaited with the full message
    /// snapshot right before auto-compaction summarizes it (contract C1 —
    /// the pre-compaction memory flush registers here).
    pub(crate) pre_compact: Option<PreCompactHook>,
    /// Type-map injected into every `ToolContext` this agent builds. Used by
    /// orchestration layers (e.g. cersei-agentrl) to hand tools a dynamic tool
    /// registry, a sandbox handle, a Mailbox/KvStore, etc. at runtime.
    pub(crate) extensions: cersei_tools::Extensions,
}

impl Agent {
    pub fn builder() -> AgentBuilder {
        AgentBuilder::default()
    }

    /// Run a prompt through the agentic loop.
    pub async fn run(&self, prompt: &str) -> cersei_types::Result<AgentOutput> {
        runner::run_agent(self, prompt).await
    }

    /// Run with streaming — returns a stream of AgentEvents.
    /// Takes `Arc<Self>` so the agent can safely outlive the caller in the spawned task.
    pub fn run_stream(self: &Arc<Self>, prompt: &str) -> AgentStream {
        let (event_tx, event_rx) = mpsc::channel(512);
        let (control_tx, control_rx) = mpsc::channel(64);

        let prompt = prompt.to_string();
        let agent = Arc::clone(self);

        tokio::spawn(async move {
            let result =
                runner::run_agent_streaming(&agent, &prompt, event_tx.clone(), control_rx).await;
            match result {
                Ok(output) => {
                    let _ = event_tx.send(AgentEvent::Complete(output)).await;
                }
                Err(e) => {
                    let _ = event_tx.send(AgentEvent::Error(e.to_string())).await;
                }
            }
        });

        AgentStream::new(event_rx, control_tx)
    }

    /// Multi-turn: send a follow-up message in the same conversation.
    pub async fn reply(&self, message: &str) -> cersei_types::Result<AgentOutput> {
        runner::run_agent(self, message).await
    }

    /// Access the conversation history.
    pub fn messages(&self) -> Vec<Message> {
        self.messages.lock().clone()
    }

    /// Get cumulative usage/cost.
    pub fn usage(&self) -> Usage {
        self.cumulative_usage.lock().clone()
    }

    /// Cancel a running agent.
    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }

    /// ATLAS PATCH (steering-queue-v1): queue a user course-correction for a
    /// running turn. The runner injects it before the next model call, after
    /// the in-flight tool batch settles — no message lands between a
    /// permission prompt and its approval.
    pub fn steer(&self, text: impl Into<String>) {
        self.steering.lock().push_back(text.into());
    }

    /// ATLAS PATCH (steering-queue-v1): drain steered messages the run never
    /// got to inject (it ended first). Callers recover these into history so
    /// a send routed to `steer` in the closing race window is not lost.
    pub fn take_steered(&self) -> Vec<String> {
        self.steering.lock().drain(..).collect()
    }

    /// Get the current tool-output compression level.
    pub fn compression_level(&self) -> cersei_compression::CompressionLevel {
        *self.compression_level.lock()
    }

    /// Change the tool-output compression level at runtime. Takes effect on
    /// the next tool call.
    pub fn set_compression_level(&self, level: cersei_compression::CompressionLevel) {
        *self.compression_level.lock() = level;
    }

    /// Subscribe to the broadcast channel (requires enable_broadcast on builder).
    pub fn subscribe(&self) -> Option<broadcast::Receiver<AgentEvent>> {
        self.broadcast_tx.as_ref().map(|tx| tx.subscribe())
    }

    /// Emit an event to all listeners.
    pub(crate) fn emit(&self, event: AgentEvent) {
        // Apply filter
        if let Some(filter) = &self.event_filter {
            if !filter(&event) {
                return;
            }
        }

        // Callback handler
        if let Some(handler) = &self.event_handler {
            handler(&event);
        }

        // Broadcast channel
        if let Some(tx) = &self.broadcast_tx {
            let _ = tx.send(event.clone());
        }

        // Reporters
        for reporter in &self.reporters {
            let reporter = Arc::clone(reporter);
            let event = event.clone();
            tokio::spawn(async move {
                reporter.on_event(&event).await;
            });
        }
    }
}

// ─── Agent builder ───────────────────────────────────────────────────────────

pub struct AgentBuilder {
    provider: Option<Box<dyn Provider>>,
    tools: Vec<Box<dyn Tool>>,
    system_prompt: Option<String>,
    append_system_prompt: Option<String>,
    model: Option<String>,
    max_turns: u32,
    max_tokens: u32,
    temperature: Option<f32>,
    thinking_budget: Option<u32>,
    reasoning_effort: Option<String>,
    context_window: Option<u64>,
    seed_usage: Option<Usage>,
    working_dir: Option<PathBuf>,
    permission_policy: Option<Arc<dyn PermissionPolicy>>,
    memory: Option<Arc<dyn Memory>>,
    session_id: Option<String>,
    hooks: Vec<Arc<dyn Hook>>,
    mcp_servers: Vec<McpServerConfig>,
    event_handler: Option<Box<dyn Fn(&AgentEvent) + Send + Sync>>,
    broadcast_capacity: Option<usize>,
    reporters: Vec<Arc<dyn Reporter>>,
    event_filter: Option<Box<dyn Fn(&AgentEvent) -> bool + Send + Sync>>,
    cancel_token: Option<tokio_util::sync::CancellationToken>,
    auto_compact: bool,
    compact_threshold: f64,
    tool_result_budget: usize,
    turns_elapsed_cadence: u32,
    compression_level: cersei_compression::CompressionLevel,
    initial_messages: Option<Vec<Message>>,
    benchmark_mode: bool,
    extensions: cersei_tools::Extensions,
    pre_compact: Option<PreCompactHook>,
}

impl Default for AgentBuilder {
    fn default() -> Self {
        Self {
            provider: None,
            tools: Vec::new(),
            system_prompt: None,
            append_system_prompt: None,
            model: None,
            max_turns: 10,
            max_tokens: 16384,
            temperature: None,
            thinking_budget: None,
            reasoning_effort: None,
            context_window: None,
            seed_usage: None,
            working_dir: None,
            permission_policy: None,
            memory: None,
            session_id: None,
            hooks: Vec::new(),
            mcp_servers: Vec::new(),
            event_handler: None,
            broadcast_capacity: None,
            reporters: Vec::new(),
            event_filter: None,
            cancel_token: None,
            auto_compact: true,
            compact_threshold: 0.9,
            tool_result_budget: 50_000,
            turns_elapsed_cadence: 10,
            compression_level: cersei_compression::CompressionLevel::Off,
            initial_messages: None,
            benchmark_mode: false,
            extensions: cersei_tools::Extensions::default(),
            pre_compact: None,
        }
    }
}

impl AgentBuilder {
    pub fn provider(mut self, p: impl Provider + 'static) -> Self {
        self.provider = Some(Box::new(p));
        self
    }

    /// Accept a pre-boxed provider. Useful when the caller already has a
    /// `Box<dyn Provider>` (e.g., the delegation primitive, which builds
    /// child providers via a factory closure).
    pub fn provider_boxed(mut self, p: Box<dyn Provider>) -> Self {
        self.provider = Some(p);
        self
    }

    pub fn tool(mut self, t: impl Tool + 'static) -> Self {
        self.tools.push(Box::new(t));
        self
    }

    pub fn tools(mut self, ts: Vec<Box<dyn Tool>>) -> Self {
        self.tools.extend(ts);
        self
    }

    pub fn system_prompt(mut self, s: impl Into<String>) -> Self {
        self.system_prompt = Some(s.into());
        self
    }

    pub fn append_system_prompt(mut self, s: impl Into<String>) -> Self {
        self.append_system_prompt = Some(s.into());
        self
    }

    pub fn model(mut self, m: impl Into<String>) -> Self {
        self.model = Some(m.into());
        self
    }

    pub fn max_turns(mut self, n: u32) -> Self {
        self.max_turns = n;
        self
    }

    pub fn max_tokens(mut self, n: u32) -> Self {
        self.max_tokens = n;
        self
    }

    pub fn temperature(mut self, t: f32) -> Self {
        self.temperature = Some(t);
        self
    }

    pub fn thinking_budget(mut self, tokens: u32) -> Self {
        self.thinking_budget = Some(tokens);
        self
    }

    /// ATLAS PATCH (model-profile-v1): thinking expressed as an effort level
    /// ("low" | "medium" | "high") for providers that take one instead of a
    /// token budget (OpenAI o-series / gpt-5).
    pub fn reasoning_effort(mut self, level: impl Into<String>) -> Self {
        self.reasoning_effort = Some(level.into());
        self
    }

    /// ATLAS PATCH (model-profile-v1): override the model's context window
    /// for compaction decisions. Without it unknown models fall into the
    /// substring table's 200k default and overflow instead of compacting.
    pub fn context_window(mut self, tokens: u64) -> Self {
        self.context_window = Some(tokens);
        self
    }

    /// Seed the agent's cumulative token/cost usage. Use this when rebuilding an
    /// agent per turn so cumulative totals carry over instead of resetting to zero.
    pub fn with_cumulative_usage(mut self, usage: Usage) -> Self {
        self.seed_usage = Some(usage);
        self
    }

    pub fn working_dir(mut self, p: impl Into<PathBuf>) -> Self {
        self.working_dir = Some(p.into());
        self
    }

    pub fn permission_policy(mut self, p: impl PermissionPolicy + 'static) -> Self {
        self.permission_policy = Some(Arc::new(p));
        self
    }

    pub fn memory(mut self, m: impl Memory + 'static) -> Self {
        self.memory = Some(Arc::new(m));
        self
    }

    pub fn session_id(mut self, id: impl Into<String>) -> Self {
        self.session_id = Some(id.into());
        self
    }

    pub fn hook(mut self, h: impl Hook + 'static) -> Self {
        self.hooks.push(Arc::new(h));
        self
    }

    pub fn mcp_server(mut self, config: McpServerConfig) -> Self {
        self.mcp_servers.push(config);
        self
    }

    pub fn on_event(mut self, f: impl Fn(&AgentEvent) + Send + Sync + 'static) -> Self {
        self.event_handler = Some(Box::new(f));
        self
    }

    pub fn enable_broadcast(mut self, capacity: usize) -> Self {
        self.broadcast_capacity = Some(capacity);
        self
    }

    pub fn reporter(mut self, r: impl Reporter + 'static) -> Self {
        self.reporters.push(Arc::new(r));
        self
    }

    pub fn event_filter(mut self, f: impl Fn(&AgentEvent) -> bool + Send + Sync + 'static) -> Self {
        self.event_filter = Some(Box::new(f));
        self
    }

    pub fn cancel_token(mut self, token: tokio_util::sync::CancellationToken) -> Self {
        self.cancel_token = Some(token);
        self
    }

    pub fn auto_compact(mut self, enabled: bool) -> Self {
        self.auto_compact = enabled;
        self
    }

    pub fn compact_threshold(mut self, threshold: f64) -> Self {
        self.compact_threshold = threshold;
        self
    }

    pub fn tool_result_budget(mut self, chars: usize) -> Self {
        self.tool_result_budget = chars;
        self
    }

    /// Set the tool-output compression level (default `Off`). Compression is
    /// applied to each tool result before the per-result cap and the overall
    /// tool-result budget run.
    /// How often `HookEvent::TurnsElapsed` fires (default 10). Set to 0 to
    /// disable. Used by skill-nudge hooks for agent-curated skill review.
    pub fn turns_elapsed_cadence(mut self, n: u32) -> Self {
        self.turns_elapsed_cadence = n;
        self
    }

    pub fn compression_level(mut self, level: cersei_compression::CompressionLevel) -> Self {
        self.compression_level = level;
        self
    }

    /// Pre-populate conversation history (for provider switching mid-session).
    pub fn with_messages(mut self, msgs: Vec<Message>) -> Self {
        self.initial_messages = Some(msgs);
        self
    }

    /// Enable benchmark mode (self-verification loop for terminal-bench).
    pub fn benchmark_mode(mut self, enabled: bool) -> Self {
        self.benchmark_mode = enabled;
        self
    }

    /// Inject a type-map that is cloned into every `ToolContext` this agent
    /// builds, letting tools retrieve runtime-injected handles (dynamic tool
    /// registry, sandbox, Mailbox/KvStore) via `ctx.extensions.get::<T>()`.
    pub fn extensions(mut self, ext: cersei_tools::Extensions) -> Self {
        self.extensions = ext;
        self
    }

    /// ATLAS PATCH (pre-compact-hook-v1): async hook awaited with the full
    /// message snapshot right before auto-compaction summarizes it. What the
    /// hook wants to survive summarization it must persist itself; it must
    /// not assume any particular split point.
    pub fn on_pre_compact(mut self, hook: PreCompactHook) -> Self {
        self.pre_compact = Some(hook);
        self
    }

    pub fn build(self) -> cersei_types::Result<Agent> {
        let provider = self
            .provider
            .ok_or_else(|| CerseiError::Config("Provider is required".into()))?;

        let working_dir = self
            .working_dir
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let broadcast_tx = self.broadcast_capacity.map(|cap| {
            let (tx, _) = broadcast::channel(cap);
            tx
        });

        Ok(Agent {
            provider,
            tools: self.tools,
            system_prompt: self.system_prompt,
            append_system_prompt: self.append_system_prompt,
            model: self.model,
            max_turns: self.max_turns,
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            thinking_budget: self.thinking_budget,
            reasoning_effort: self.reasoning_effort,
            context_window: self.context_window,
            working_dir,
            permission_policy: self.permission_policy.unwrap_or_else(|| Arc::new(AllowAll)),
            memory: self.memory,
            session_id: self.session_id,
            hooks: self.hooks,
            mcp_manager: None, // TODO: connect MCP servers
            event_handler: self.event_handler,
            broadcast_tx,
            reporters: self.reporters,
            event_filter: self.event_filter,
            cost_tracker: Arc::new(CostTracker::new()),
            auto_compact: self.auto_compact,
            compact_threshold: self.compact_threshold,
            tool_result_budget: self.tool_result_budget,
            turns_elapsed_cadence: if self.turns_elapsed_cadence == 0 {
                u32::MAX
            } else {
                self.turns_elapsed_cadence
            },
            compression_level: Arc::new(parking_lot::Mutex::new(self.compression_level)),
            benchmark_mode: self.benchmark_mode,
            messages: Arc::new(parking_lot::Mutex::new(
                self.initial_messages.unwrap_or_default(),
            )),
            cumulative_usage: Arc::new(parking_lot::Mutex::new(
                self.seed_usage.unwrap_or_default(),
            )),
            cancel_token: self
                .cancel_token
                .unwrap_or_else(tokio_util::sync::CancellationToken::new),
            steering: parking_lot::Mutex::new(std::collections::VecDeque::new()),
            pre_compact: self.pre_compact,
            extensions: self.extensions,
        })
    }

    /// Build + run in one shot.
    pub async fn run_with(self, prompt: &str) -> cersei_types::Result<AgentOutput> {
        self.build()?.run(prompt).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cersei_provider::{
        CompletionRequest, CompletionStream, ProviderCapabilities, Provider,
    };

    /// Minimal provider that never produces output — enough to `build()` an agent.
    struct StubProvider;

    #[async_trait::async_trait]
    impl Provider for StubProvider {
        fn name(&self) -> &str {
            "stub"
        }
        fn context_window(&self, _model: &str) -> u64 {
            1000
        }
        fn capabilities(&self, _model: &str) -> ProviderCapabilities {
            ProviderCapabilities::default()
        }
        async fn complete(&self, _request: CompletionRequest) -> cersei_types::Result<CompletionStream> {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            Ok(CompletionStream::new(rx))
        }
    }

    #[test]
    fn model_profile_knobs_reach_the_agent() {
        // ATLAS PATCH (model-profile-v1): the two new builder knobs and the
        // previously-dead compact_threshold land on the built agent.
        let agent = Agent::builder()
            .provider(StubProvider)
            .context_window(32_768)
            .reasoning_effort("high")
            .compact_threshold(0.75)
            .build()
            .unwrap();
        assert_eq!(agent.context_window, Some(32_768));
        assert_eq!(agent.reasoning_effort.as_deref(), Some("high"));
        assert!((agent.compact_threshold - 0.75).abs() < f64::EPSILON);

        let default_agent = Agent::builder().provider(StubProvider).build().unwrap();
        assert_eq!(default_agent.context_window, None);
        assert_eq!(default_agent.reasoning_effort, None);
    }

    #[test]
    fn cumulative_usage_defaults_to_zero() {
        let agent = Agent::builder().provider(StubProvider).build().unwrap();
        assert_eq!(agent.usage().input_tokens, 0);
        assert_eq!(agent.usage().output_tokens, 0);
    }

    #[test]
    fn seeded_cumulative_usage_is_restored() {
        let seed = Usage {
            input_tokens: 1234,
            output_tokens: 567,
            total_tokens: 1801,
            ..Default::default()
        };
        let agent = Agent::builder()
            .provider(StubProvider)
            .with_cumulative_usage(seed.clone())
            .build()
            .unwrap();
        let restored = agent.usage();
        assert_eq!(restored.input_tokens, 1234);
        assert_eq!(restored.output_tokens, 567);
        assert_eq!(restored.total_tokens, 1801);
    }
}
