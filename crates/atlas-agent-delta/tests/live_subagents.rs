//! Does the backend catch the subagents real agents actually launch?
//!
//! Two layers, because each answers a different question and only one of them
//! can run in CI:
//!
//! - **Replay** (always): the `tool_call` / `tool_call_update` payloads three
//!   real agents sent while delegating, captured verbatim from a live run and
//!   checked into `tests/fixtures/`. Driven through the real `AcpThread` and
//!   the real projector, so a change to detection, projection or the wire that
//!   breaks a shipped agent fails here with no network, no keys and no agent
//!   installed. These fixtures found three bugs on the day they were taken
//!   (see the tests).
//! - **Live** (`--ignored`): the same assertions against the agent itself,
//!   spawned, authenticated and prompted for real. That is what proves the
//!   fixtures still describe the agent after it ships a new version.
//!
//! Capturing a new fixture: run the live test for that agent with
//! `ATLAS_SUBAGENT_CAPTURE=<path>` and it writes the payloads it saw.
//! **Redact before committing** — a prompt can quote anything in the repo.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection, AgentId as ThreadAgentId};
use atlas_agent_delta::{
    AgentId, DeltaProjector, DeltaSink, SessionDelta, SessionDeltaEnvelope, Subagent,
    SubagentStatus,
};
use futures::future::BoxFuture;
use futures::FutureExt;

// ------------------------------------------------------------------- harness

#[derive(Default)]
struct Recorder {
    envelopes: Mutex<Vec<SessionDeltaEnvelope>>,
}

impl DeltaSink for Recorder {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.envelopes.lock().unwrap().push(envelope);
    }
}

/// A connection that answers nothing: the replay drives the thread directly,
/// so no request ever leaves it.
struct StubConnection;

impl AgentConnection for StubConnection {
    fn agent_id(&self) -> ThreadAgentId {
        ThreadAgentId::new("replay")
    }
    fn telemetry_id(&self) -> Arc<str> {
        Arc::from("replay")
    }
    fn new_session(
        self: Arc<Self>,
        _work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, anyhow::Result<AcpThreadHandle>> {
        async { Err(anyhow::anyhow!("the replay opens no sessions")) }.boxed()
    }
    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &[]
    }
    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, anyhow::Result<()>> {
        async { Ok(()) }.boxed()
    }
    fn prompt(
        &self,
        _params: acp::PromptRequest,
    ) -> BoxFuture<'static, anyhow::Result<acp::PromptResponse>> {
        async { Ok(acp::PromptResponse::new(acp::StopReason::EndTurn)) }.boxed()
    }
    fn cancel(&self, _session_id: &acp::SessionId) {}
    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

/// The whole stack under one name: a thread, the projector watching it, and
/// the deltas that came out.
struct Replay {
    projector: Arc<DeltaProjector>,
    recorder: Arc<Recorder>,
    thread: AcpThreadHandle,
    session_id: acp::SessionId,
    events: Mutex<atlas_acp_thread::EventStream<atlas_acp_thread::AcpThreadEvent>>,
}

impl Replay {
    fn start() -> Self {
        let recorder = Arc::new(Recorder::default());
        let projector = DeltaProjector::new(recorder.clone());
        let session_id = acp::SessionId::new("replay");
        let events = (projector.thread_events())(&session_id);
        let thread = Arc::new(Mutex::new(AcpThread::new(
            session_id.clone(),
            Arc::new(StubConnection) as Arc<dyn AgentConnection>,
            vec![PathBuf::from("/tmp")],
            None,
            events,
        )));
        let events = projector
            .register(AgentId::new(), thread.clone())
            .expect("the session was registered");
        Self {
            projector,
            recorder,
            thread,
            session_id,
            events: Mutex::new(events),
        }
    }

    /// Feed one `session/update` payload, exactly as the agent sent it.
    fn update(&self, update: &serde_json::Value) {
        let parsed: acp::SessionUpdate = serde_json::from_value(update.clone())
            .unwrap_or_else(|e| panic!("the schema rejected a real agent's update: {e}\n{update}"));
        self.thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .handle_session_update(parsed)
            .expect("the thread accepts it");
        let mut events = self.events.lock().unwrap();
        while let Ok(event) = events.try_recv() {
            self.projector.apply(&self.session_id, event);
        }
    }

    fn feed(&self, updates: &[serde_json::Value]) {
        for update in updates {
            self.update(update);
        }
    }

    /// Opens a turn, as sending a prompt does: a capture is what an agent sent
    /// while one was running, and a child launched to run on its own runs for
    /// exactly as long as its turn.
    fn begin_turn(&self) {
        self.lock_thread().begin_turn();
        self.pump();
    }

    /// Ends the turn the capture ran in.
    fn end_turn(&self, stop_reason: acp::StopReason) {
        self.lock_thread().end_turn(stop_reason);
        self.pump();
    }

    fn lock_thread(&self) -> std::sync::MutexGuard<'_, atlas_acp_thread::AcpThread> {
        self.thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn pump(&self) {
        let mut events = self.events.lock().unwrap();
        while let Ok(event) = events.try_recv() {
            self.projector.apply(&self.session_id, event);
        }
    }

    /// Each subagent as it last stood, in launch order.
    fn subagents(&self) -> Vec<Subagent> {
        let mut out: Vec<Subagent> = Vec::new();
        for envelope in self.recorder.envelopes.lock().unwrap().iter() {
            let SessionDelta::SubagentUpserted { subagent } = &envelope.delta else {
                continue;
            };
            match out
                .iter_mut()
                .find(|seen| seen.tool_call_id == subagent.tool_call_id)
            {
                Some(seen) => *seen = subagent.clone(),
                None => out.push(subagent.clone()),
            }
        }
        out
    }

    /// Tool calls the wire attributed to `tool_call_id`'s subagent.
    fn children_of(&self, tool_call_id: &str) -> Vec<String> {
        let mut out = Vec::new();
        for envelope in self.recorder.envelopes.lock().unwrap().iter() {
            let SessionDelta::ToolCallUpserted { tool_call, .. } = &envelope.delta else {
                continue;
            };
            if tool_call.parent_tool_call_id.as_deref() == Some(tool_call_id)
                && !out.contains(&tool_call.id)
            {
                out.push(tool_call.id.clone());
            }
        }
        out
    }
}

fn fixture(name: &str) -> Vec<serde_json::Value> {
    load(&format!("{name}-subagents.json"))
}

fn load(file: &str) -> Vec<serde_json::Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    serde_json::from_str(&text).expect("a list of session updates")
}

// -------------------------------------------------------------- replay tests

/// opencode, an OpenAI-backed agent that is neither Claude nor Codex, told to
/// run two children. It announces each as `title: "task"` with an EMPTY
/// input, then fills in the description, prompt and role in later updates.
///
/// That late fill is why detection re-runs on every update: detecting once
/// left both children named "Subagent" for their whole lives.
#[test]
fn opencode_delegating_twice_is_two_named_subagents() {
    let replay = Replay::start();
    replay.feed(&fixture("opencode"));

    let subagents = replay.subagents();
    assert_eq!(subagents.len(), 2, "both children");
    for subagent in &subagents {
        // Named from the description, which arrives in a LATER update than
        // the launch — the whole reason detection re-runs. Asserted as "not
        // the fallback" rather than as a literal: the description is model
        // output, and the same prompt produced "counter" on one run and
        // "Count files in directory" on the next. Both are correct, and a
        // test pinning either fails on the other.
        assert_ne!(
            subagent.name, "Subagent",
            "the late-arriving description names the child"
        );
        assert_eq!(subagent.role.as_deref(), Some("general"));
        assert!(subagent.prompt.is_some(), "the child's instructions travel");
        assert_eq!(
            subagent.status,
            SubagentStatus::Completed,
            "a synchronous delegation ends when its call does"
        );
    }
    let names: Vec<_> = subagents.iter().map(|s| s.name.as_str()).collect();
    assert_ne!(names[0], names[1], "two children, two names");
}

/// Claude Code, on the signed-in account, captured TWICE — because it does
/// two different things and only one of them was obvious.
///
/// An **async** launch answers with `status: "async_launched"` and the
/// `Agent` call goes `completed` the instant the child is spawned, while the
/// child's own tool calls keep arriving. A **synchronous** one has no such
/// marker and its call finishing really is the child finishing. The same
/// prompt produced one of each on consecutive runs.
///
/// Taking the call's status as the child's — the obvious implementation —
/// showed every async child as finished before it had done anything. So the
/// rule, not either run's outcome, is what is asserted here.
#[test]
fn a_claude_child_ends_when_its_work_does_not_when_its_launch_returns() {
    for (fixture_name, expected) in [
        ("claude-async", SubagentStatus::Running),
        ("claude-sync", SubagentStatus::Completed),
    ] {
        let replay = Replay::start();
        replay.begin_turn();
        replay.feed(&fixture(fixture_name));

        let subagents = replay.subagents();
        assert_eq!(
            subagents.len(),
            2,
            "{fixture_name}: two Agent calls, two children"
        );
        let counter = subagents
            .iter()
            .find(|s| s.name.starts_with("counter"))
            .unwrap_or_else(|| panic!("{fixture_name}: no counter child"));
        assert_eq!(
            counter.status,
            expected,
            "{fixture_name}: {:?}",
            subagents
                .iter()
                .map(|s| (&s.name, s.status))
                .collect::<Vec<_>>()
        );
        assert!(
            counter.role.is_some(),
            "{fixture_name}: the child's role travels"
        );
    }
}

/// Nothing Claude sends a client like Atlas says an async child ended: its end
/// goes only to a client that takes the agent's draft task updates. But the
/// agent holds the turn open until such children settle, so the turn ending
/// is their end — and a Stop is theirs too. Live, both rows sat on "running"
/// after the reply was in.
#[test]
fn an_async_claude_child_ends_with_its_turn() {
    for (stop_reason, expected) in [
        (acp::StopReason::EndTurn, SubagentStatus::Completed),
        (acp::StopReason::Cancelled, SubagentStatus::Interrupted),
    ] {
        let replay = Replay::start();
        replay.begin_turn();
        replay.feed(&fixture("claude-async"));
        replay.end_turn(stop_reason);

        let statuses: Vec<_> = replay.subagents().iter().map(|s| s.status).collect();
        assert_eq!(statuses, vec![expected; 2], "{stop_reason:?}");
        assert!(
            replay.subagents().iter().all(|s| s.ended_at_ms.is_some()),
            "a child that ended says when"
        );
        assert!(
            replay.subagents().iter().all(|s| s.result.is_none()),
            "the launch's receipt, written for the model, is not the child's answer"
        );
    }

    // A reopened session ends no turn: the replay is the whole of it, and
    // nothing in it is still running.
    let reopened = Replay::start();
    reopened.feed(&fixture("claude-async"));
    assert!(
        reopened
            .subagents()
            .iter()
            .all(|s| s.status == SubagentStatus::Completed),
        "a replayed async child is not left running forever"
    );
}

/// The other half of what only a live run shows: a child's own tool calls
/// arrive on the PARENT's session, interleaved with the parent's own, and
/// `_meta.claudeCode.parentToolUseId` is the only thing telling them apart.
/// Without it a client has nothing to nest a child's work under.
#[test]
fn a_claude_childs_own_work_is_attributed_to_it() {
    let replay = Replay::start();
    replay.feed(&fixture("claude-async"));

    let counter = replay
        .subagents()
        .into_iter()
        .find(|s| s.name.starts_with("counter"))
        .expect("the counter child");
    let children = replay.children_of(&counter.tool_call_id);
    assert!(
        !children.is_empty(),
        "the child ran a command and it was attributed to the child"
    );
    assert_eq!(
        counter.tool_call_count as usize,
        children.len(),
        "and the row counts exactly those"
    );
}

/// Codex, on the OpenAI key. It reports a child as a TREE: one call to start
/// it, one to complete it, each with its own id, both naming the same
/// `agentPath`. The path is the identity, so the steps are one row — and the
/// `started` call also completes immediately, so the activity kind decides
/// the status rather than the call.
#[test]
fn codex_lifecycle_steps_are_one_subagent_that_runs_then_completes() {
    let all = fixture("codex");
    let started: Vec<_> = all
        .iter()
        .take_while(|update| update["rawInput"]["activityKind"].as_str() != Some("completed"))
        .cloned()
        .collect();

    // Mid-flight: both children started, neither finished.
    let running = Replay::start();
    running.feed(&started);
    let names: Vec<_> = running
        .subagents()
        .iter()
        .map(|s| (s.name.clone(), s.status))
        .collect();
    assert_eq!(
        names,
        vec![
            ("Counter".to_owned(), SubagentStatus::Running),
            ("Greeter".to_owned(), SubagentStatus::Running),
        ],
        "a `started` step whose call completed is still a running child"
    );

    // The whole run: the same two rows, now finished.
    let done = Replay::start();
    done.feed(&all);
    let subagents = done.subagents();
    assert_eq!(
        subagents.len(),
        2,
        "four lifecycle calls, two children: the agent path is the identity"
    );
    assert!(
        subagents
            .iter()
            .all(|s| s.status == SubagentStatus::Completed),
        "{:?}",
        subagents.iter().map(|s| s.status).collect::<Vec<_>>()
    );
}

/// The guard, against every real payload at once: an agent's ordinary work
/// must never become a subagent row. These runs did far more than delegate —
/// they ran commands, read files, and Codex's `wait` tool takes an
/// `agentsStates` map — and only the delegations may show up.
#[test]
fn no_ordinary_tool_call_in_any_real_run_becomes_a_subagent() {
    for (agent, expected) in [
        ("opencode", 2),
        ("claude-async", 2),
        ("claude-sync", 2),
        ("codex", 2),
    ] {
        let replay = Replay::start();
        replay.feed(&fixture(agent));
        let subagents = replay.subagents();
        assert_eq!(
            subagents.len(),
            expected,
            "{agent} produced {:?}",
            subagents.iter().map(|s| s.name.clone()).collect::<Vec<_>>()
        );
    }
}

/// pi, asked to run two workers in parallel, did the work ITSELF: two shell
/// commands, no delegation. The hardest negative there is — a run that reads
/// like parallel children and is not — and it must produce no rows at all.
#[test]
fn an_agent_that_did_the_work_itself_has_no_subagents() {
    let replay = Replay::start();
    let updates = load("pi-no-subagents.json");
    assert!(!updates.is_empty(), "the fixture has traffic to judge");
    replay.feed(&updates);
    let names: Vec<String> = replay.subagents().into_iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        Vec::<String>::new(),
        "two parallel shell commands are not two children"
    );
}
