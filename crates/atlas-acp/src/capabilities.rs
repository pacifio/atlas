//! Capability truthfulness — one place that decides what Atlas advertises to an
//! agent, and one test that proves the advertisement is honest (P0.3,
//! `plans/atlas-acp-parity-loop.md`).
//!
//! ACP is a two-way protocol: `clientCapabilities` is a *promise* that Atlas will
//! serve certain agent→client methods. An agent that sees `fs.readTextFile: true`
//! will call `fs/read_text_file` and expect an answer; if no handler is
//! registered the SDK replies `-32601 method not found` and the agent's turn
//! fails in a way that looks like an agent bug. Over-advertising is therefore
//! strictly worse than advertising nothing — which is why the pre-P0.3 code
//! shipped a bare `ClientCapabilities::default()`.
//!
//! The rule this module enforces: **a flag flips to `true` in the same commit
//! that lands its handler, never before.** [`SERVED`] is the single table both
//! the wire value and the test read, so the two cannot drift. To land P1.2 you
//! flip `terminal` here and register the five handlers in `driver.rs`; the test
//! fails if you do either one alone.

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthCapabilities, BooleanConfigOptionCapabilities, ClientCapabilities,
    ClientSessionCapabilities, ElicitationCapabilities,
    FileSystemCapabilities, SessionConfigOptionsCapabilities,
};
use serde_json::{Map, Value};

/// What an advertised capability obliges Atlas to actually do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Obligation {
    /// The agent may call these methods on us; each needs a handler registered
    /// in `driver.rs`. Listed by their Rust request type, which is what the
    /// `.on_receive_request(async move |request: T, …>)` registration names.
    Requests(&'static [&'static str]),
    /// No inbound method — the agent instead sends notifications or changes its
    /// own behaviour, and the obligation is to render/honor what arrives. The
    /// string says where that lives, for humans.
    Rendering(&'static str),
}

/// Flags whose handlers exist but whose advertisement is deliberately withheld.
///
/// The advertised ⇔ handled invariant has exactly one legitimate exception: a
/// capability Atlas *can* serve but should not announce yet, because announcing
/// it changes agent behaviour in a way the UI cannot render. Listing the flag
/// here is the only way to opt out, and the test prints this rationale on
/// failure, so the exception can never be silent. Test-only: the wire value is
/// driven by each row's `advertised` field, so nothing in the lib build reads
/// this — it exists to constrain the tests, not the behaviour.
#[cfg(test)]
/// Empty since P1.4 flipped `terminal`. The mechanism stays: the next
/// capability whose handler outpaces its rendering needs it, and an empty table
/// keeps the tests honest rather than vacuous.
const HELD_BACK: &[(&str, &str)] = &[];

/// One `clientCapabilities` flag: what it promises, and whether we keep it.
#[derive(Debug, Clone, Copy)]
pub struct Served {
    /// Dotted path of the flag inside `clientCapabilities`.
    pub flag: &'static str,
    /// Whether [`client_capabilities`] sets it. **Flip only alongside the
    /// handler.**
    pub advertised: bool,
    pub obligation: Obligation,
    /// The parity-loop task that turns this on.
    pub task: &'static str,
}

/// Every `clientCapabilities` flag Atlas could set, and whether it does.
///
/// Rows with `advertised: false` are the honest gaps — the agent is told nothing
/// and will not call the method, which is the correct behaviour until the
/// handler exists.
pub const SERVED: &[Served] = &[
    Served {
        flag: "fs.readTextFile",
        advertised: true,
        obligation: Obligation::Requests(&["ReadTextFileRequest"]),
        task: "P1.3",
    },
    Served {
        flag: "fs.writeTextFile",
        advertised: true,
        obligation: Obligation::Requests(&["WriteTextFileRequest"]),
        task: "P1.3",
    },
    Served {
        flag: "terminal",
        // Advertised as of P1.4: the five handlers (P1.2) are backed by a render
        // path, so a spec-aware agent switching to `terminal/*` now shows live
        // output rather than an empty card. `terminal_pump` bridges the spec
        // path onto the `_meta.terminal_output` streaming the apply layer
        // already handles.
        advertised: true,
        obligation: Obligation::Requests(&[
            "CreateTerminalRequest",
            "TerminalOutputRequest",
            "WaitForTerminalExitRequest",
            "KillTerminalRequest",
            "ReleaseTerminalRequest",
        ]),
        task: "P1.2",
    },
    Served {
        flag: "elicitation",
        // Truthful as of P3.3: the handler is registered and both modes render
        // (URL reuses the sign-in modal's "open page" affordance; form builds
        // inputs from `requestedSchema`). An unanswerable elicitation resolves
        // as `cancel`, which ACP defines for exactly that case, so the agent is
        // never left blocked.
        advertised: true,
        obligation: Obligation::Requests(&["CreateElicitationRequest"]),
        task: "P3.3",
    },
    Served {
        flag: "auth.terminal",
        // Truthful as of A2: Atlas really does run terminal auth methods
        // (`agents_run_auth_method` spawns the CLI and streams its output).
        // Not a method of our own — it tells the AGENT it may return
        // `terminal`-variant auth methods from `initialize`.
        //
        // The proprietary `_meta["terminal-auth"]` flag stays alongside it, and
        // is not redundant: A1/R1 proved the typed `terminal.args` are relative
        // to a binary the protocol never names, so `_meta` remains the only
        // source of an executable command. Typed flag and `_meta` do different
        // jobs here.
        advertised: true,
        obligation: Obligation::Rendering(
            "src-tauri agents.rs `agents_run_auth_method` + `_meta[\"terminal-auth\"]`",
        ),
        task: "A2",
    },
    Served {
        flag: "session.configOptions.boolean",
        // Truthful as of P2.2: `apply.rs` emits a `ConfigOptionsUpdated` delta
        // (it used to store the update and drop it), and the composer renders
        // the agent's boolean + select knobs in its own pill group. Setting the
        // value back goes through `session/set_config_option` with the wire's
        // `Boolean` form — before P2.2 only the `ValueId` (select) form was
        // ever sent, so a boolean knob was advertised-but-unsettable.
        advertised: true,
        obligation: Obligation::Rendering(
            "atlas-agents apply.rs `config_option_update` -> composer options pill",
        ),
        task: "P2.2",
    },
    Served {
        flag: "plan",
        advertised: false,
        obligation: Obligation::Rendering("atlas-agents apply.rs `plan_update` / `plan_removed`"),
        task: "P3.1",
    },
];

/// Look up a flag's advertised state. Panics on an unknown flag — the argument
/// is always a literal from [`SERVED`], so a typo is a bug, not a runtime case.
#[must_use]
fn advertises(flag: &str) -> bool {
    SERVED
        .iter()
        .find(|s| s.flag == flag)
        .unwrap_or_else(|| panic!("unknown capability flag {flag:?} — add it to SERVED"))
        .advertised
}

/// Build the `clientCapabilities` Atlas sends with `initialize`.
///
/// Every typed flag is read from [`SERVED`] rather than written inline, so the
/// wire value and the truthfulness test can never disagree.
#[must_use]
pub fn client_capabilities() -> ClientCapabilities {
    let mut caps = ClientCapabilities::default();

    // Builders, not struct literals — these schema types are
    // `#[non_exhaustive]`, so a later ACP release can add a sub-capability
    // without breaking this call (and without silently advertising it).
    caps.fs = FileSystemCapabilities::new()
        .read_text_file(advertises("fs.readTextFile"))
        .write_text_file(advertises("fs.writeTextFile"));
    caps.terminal = advertises("terminal");
    caps.auth = AuthCapabilities::new().terminal(advertises("auth.terminal"));
    // Only the sub-capabilities we actually render are named. Note
    // `Some(Default::default())` would NOT be equivalent: per the schema,
    // supplying `{}` means "I accept every sub-capability", which is the exact
    // over-advertisement this module exists to prevent — so `configOptions` is
    // built explicitly with just the `boolean` flag P2.2 landed.
    if advertises("session.configOptions.boolean") {
        caps.session = Some(
            ClientSessionCapabilities::new().config_options(
                SessionConfigOptionsCapabilities::new()
                    .boolean(BooleanConfigOptionCapabilities::new()),
            ),
        );
    }
    if advertises("elicitation") {
        caps.elicitation = Some(ElicitationCapabilities::default());
    }
    // `plan` stays `None` until plan-operations rendering lands.

    caps.meta = Some(proprietary_meta());
    caps
}

/// Non-standard `_meta` opt-ins. These are not ACP capabilities — they are
/// per-adapter contracts that predate (or have no) spec equivalent. Unknown
/// `_meta` keys are ignored per the spec, so they are safe to send to any agent
/// and are kept as fallbacks even after the typed path lands.
fn proprietary_meta() -> Map<String, Value> {
    let mut meta = Map::new();
    // Makes claude-agent-acp populate `authMethods` with structured subprocess
    // specs we can actually run. Without it the adapter returns an empty list
    // and `/login` has no flow to launch.
    meta.insert("terminal-auth".into(), Value::Bool(true));
    // Opts into LIVE command output: claude-agent-acp and codex-acp share this
    // contract — a Bash-shaped tool_call carries `terminal_info` and its updates
    // stream `terminal_output` / `terminal_exit` in `_meta`, which the apply
    // layer folds into the tool call's visible result as it runs. Without the
    // flag both adapters only deliver output once the command has finished.
    // (Underscore vs. dash matches each adapter's key exactly — Zed sends both
    // spellings too.) P1.2 adds the spec `terminal/*` path alongside this.
    meta.insert("terminal_output".into(), Value::Bool(true));
    // Cursor-only (Zed sends it too): opts into parameterized model ids like
    // `gpt-5.4[reasoning=medium]`. Sent unconditionally because unknown meta
    // keys are ignored, which beats plumbing a per-spec meta field.
    meta.insert("parameterizedModelPicker".into(), Value::Bool(true));
    meta
}


/// What the **agent** advertised in its `InitializeResponse`.
///
/// Before P0.3 exactly two things were read off that response — `authMethods`
/// and `promptCapabilities.image` — and the rest was dropped on the floor, which
/// is why so much of the parity work had to guess. Every field here is consumed
/// by a specific downstream task; capturing them all in one pass means those
/// tasks are a read, not another round-trip:
///
/// | field | consumer |
/// |---|---|
/// | `prompt_image` | already live — gates `ContentBlock::Image` |
/// | `prompt_embedded_context` | P2.1 — embedded `Resource` vs `ResourceLink` |
/// | `mcp_*` | P1.1 (`mcpServers` transport choice), P3.5 (MCP-over-ACP) |
/// | `load_session` | P2.3 — resume eligibility, replacing the hardcoded per-plugin `TranscriptKind` |
/// | `session_list` / `session_delete` / `session_close` | P2.3 — sidebar + tab close |
/// | `session_additional_directories` | P3.2 |
/// | `session_fork` | P3.4 |
/// | `logout` | A2 |
/// | `providers` | P3.6 (needs the `unstable_llm_providers` schema feature from P0.1) |
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCaps {
    pub prompt_image: bool,
    pub prompt_audio: bool,
    pub prompt_embedded_context: bool,
    pub load_session: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub mcp_acp: bool,
    pub session_list: bool,
    pub session_delete: bool,
    pub session_additional_directories: bool,
    pub session_fork: bool,
    pub session_resume: bool,
    pub session_close: bool,
    pub logout: bool,
    pub providers: bool,
}

impl AgentCaps {
    /// Project the schema's nested (and heavily `Option`-wrapped) capability
    /// tree into flat booleans. Every sub-capability is `Option<T>` where
    /// `Some(_)` means supported and the inner struct only carries `_meta`, so
    /// `.is_some()` is the whole test.
    #[must_use]
    pub fn from_agent(caps: &AgentCapabilities) -> Self {
        Self {
            prompt_image: caps.prompt_capabilities.image,
            prompt_audio: caps.prompt_capabilities.audio,
            prompt_embedded_context: caps.prompt_capabilities.embedded_context,
            load_session: caps.load_session,
            mcp_http: caps.mcp_capabilities.http,
            mcp_sse: caps.mcp_capabilities.sse,
            mcp_acp: caps.mcp_capabilities.acp,
            session_list: caps.session_capabilities.list.is_some(),
            session_delete: caps.session_capabilities.delete.is_some(),
            session_additional_directories: caps
                .session_capabilities
                .additional_directories
                .is_some(),
            session_fork: caps.session_capabilities.fork.is_some(),
            session_resume: caps.session_capabilities.resume.is_some(),
            session_close: caps.session_capabilities.close.is_some(),
            logout: caps.auth.logout.is_some(),
            providers: caps.providers.is_some(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The driver's own source, read at compile time. There is no runtime
    /// registry of handlers to introspect — the SDK's builder consumes each
    /// `.on_receive_request::<T>` closure and hands back an opaque connection —
    /// so matching against the registration site itself is the only way to tie
    /// an advertised flag to a handler that actually exists.
    const DRIVER_SRC: &str = include_str!("driver.rs");

    /// True when `driver.rs` registers an inbound handler for this request type.
    fn handler_registered(request_type: &str) -> bool {
        DRIVER_SRC.contains(&format!("request: {request_type},"))
            || DRIVER_SRC.contains(&format!("request: {request_type} "))
    }

    /// The core invariant: advertised ⇔ handled. Both directions matter.
    /// Advertising without a handler makes the agent call a method that answers
    /// `-32601` mid-turn; handling without advertising means the feature is dead
    /// code the agent will never exercise.
    #[test]
    fn every_advertised_capability_has_a_handler_and_vice_versa() {
        for served in SERVED {
            let Obligation::Requests(types) = served.obligation else {
                continue;
            };
            if let Some((_, why)) = HELD_BACK.iter().find(|(f, _)| *f == served.flag) {
                assert!(
                    !served.advertised,
                    "{:?} is in HELD_BACK but advertised=true — remove the \
                     HELD_BACK entry in the commit that flips it.\n  reason was: {why}",
                    served.flag,
                );
                continue;
            }
            for ty in types {
                assert_eq!(
                    served.advertised,
                    handler_registered(ty),
                    "capability {:?} ({}) advertises={} but driver.rs {} a handler \
                     for {ty}. Flip the flag and register the handler in the SAME commit.",
                    served.flag,
                    served.task,
                    served.advertised,
                    if handler_registered(ty) { "HAS" } else { "has no" },
                );
            }
        }
    }

    /// The held-back exception must stay honest in the other direction too: if
    /// the handlers were ever deleted, the entry would be silently protecting
    /// nothing and P1.4 would flip a flag with no implementation behind it.
    #[test]
    fn anything_held_back_really_does_have_its_handlers() {
        for (flag, _) in HELD_BACK {
            let served = SERVED.iter().find(|s| s.flag == *flag).expect("known flag");
            let Obligation::Requests(types) = served.obligation else {
                panic!("only request-serving flags can be held back");
            };
            for ty in types {
                assert!(
                    handler_registered(ty),
                    "{flag:?} is held back, which claims its handlers exist — but \
                     driver.rs has no handler for {ty}. Either the handler was \
                     deleted or the HELD_BACK entry is stale."
                );
            }
        }
    }

    /// Guards the matcher itself. If the SDK's registration syntax changes, the
    /// test above would silently see "no handler anywhere" and pass for every
    /// not-yet-advertised row — turning the whole check into a no-op.
    #[test]
    fn the_handler_matcher_finds_the_handlers_that_do_exist() {
        assert!(
            handler_registered("RequestPermissionRequest"),
            "permissions have been handled since long before P0.3; if this fails \
             the matcher no longer understands driver.rs's registration syntax \
             and every other truthfulness assertion is vacuous"
        );
    }

    #[test]
    fn the_wire_value_matches_the_table() {
        let caps = client_capabilities();
        assert_eq!(caps.fs.read_text_file, advertises("fs.readTextFile"));
        assert_eq!(caps.fs.write_text_file, advertises("fs.writeTextFile"));
        assert_eq!(caps.terminal, advertises("terminal"));
        assert_eq!(caps.auth.terminal, advertises("auth.terminal"));
    }

    /// `Some(Default::default())` would mean "every sub-capability accepted",
    /// so an un-landed feature must serialize as *absent*, not as `{}`.
    #[test]
    fn unlanded_capabilities_are_absent_not_empty_objects() {
        let caps = client_capabilities();
        // P2.2 landed `session`, but ONLY the sub-capability we render — the
        // schema treats a bare `{}` as "every sub-capability accepted".
        let session = caps.session.as_ref().expect("P2.2 landed session caps");
        let opts = session
            .config_options
            .as_ref()
            .expect("configOptions advertised");
        assert!(opts.boolean.is_some(), "boolean options are rendered");
        assert!(caps.plan.is_none(), "P3.1 has not landed");
        assert!(caps.elicitation.is_some(), "P3.3 landed elicitation");
        // `ClientCapabilities` has no `nes` field at all in this build: the
        // `unstable_nes` schema feature is deliberately off (P0.1/P3.6), so NES
        // is unrepresentable rather than merely unset.
    }

    /// A bare `{}` from an agent that advertises nothing must read as all-false,
    /// never as "unknown, assume yes".
    #[test]
    fn an_empty_agent_capabilities_object_grants_nothing() {
        let caps: AgentCapabilities = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(AgentCaps::from_agent(&caps), AgentCaps::default());
    }

    /// The sub-capabilities are `Option<T>` where the inner struct is empty —
    /// `Some({})` is the "supported" signal and must not be mistaken for absent.
    #[test]
    fn present_but_empty_sub_capabilities_read_as_supported() {
        let caps: AgentCapabilities = serde_json::from_value(serde_json::json!({
            "loadSession": true,
            "promptCapabilities": { "image": true, "embeddedContext": true },
            "mcpCapabilities": { "http": true },
            "sessionCapabilities": { "list": {}, "fork": {}, "close": {} },
            "auth": { "logout": {} },
        }))
        .unwrap();
        let got = AgentCaps::from_agent(&caps);
        assert!(got.load_session && got.prompt_image && got.prompt_embedded_context);
        assert!(got.mcp_http && !got.mcp_sse && !got.mcp_acp);
        assert!(got.session_list && got.session_fork && got.session_close);
        assert!(!got.session_delete && !got.session_resume);
        assert!(got.logout);
        assert!(!got.prompt_audio);
    }

    /// A2: `auth.terminal` is advertised, and the `_meta` fallback stays put.
    /// They are not redundant — A1/R1 proved the typed `terminal.args` are
    /// relative to a binary the protocol never names, so `_meta["terminal-auth"]`
    /// remains the ONLY source of an executable login command. Dropping it
    /// because the typed flag exists would break `/login` for Claude.
    #[test]
    fn the_typed_auth_flag_and_the_meta_fallback_coexist() {
        let caps = client_capabilities();
        assert!(caps.auth.terminal, "Atlas does run terminal auth methods");
        assert_eq!(
            caps.meta.as_ref().and_then(|m| m.get("terminal-auth")),
            Some(&Value::Bool(true)),
            "the _meta opt-in still carries the runnable command"
        );
    }

    /// `auth.logout` is the AGENT's capability, not ours — it must never appear
    /// in what Atlas advertises about itself.
    #[test]
    fn logout_is_read_from_the_agent_not_advertised_by_us() {
        assert!(
            !SERVED.iter().any(|s| s.flag.contains("logout")),
            "logout is an agent capability; Atlas consumes it via AgentCaps"
        );
        let caps: AgentCapabilities =
            serde_json::from_value(serde_json::json!({ "auth": { "logout": {} } })).unwrap();
        assert!(AgentCaps::from_agent(&caps).logout);
        let none: AgentCapabilities = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!AgentCaps::from_agent(&none).logout);
    }

    /// The three `_meta` opt-ins are load-bearing for the adapters we ship
    /// against; dropping one silently breaks `/login` or live terminal output.
    #[test]
    fn proprietary_meta_opt_ins_are_all_present() {
        let caps = client_capabilities();
        let meta = caps.meta.expect("meta must be sent");
        for key in ["terminal-auth", "terminal_output", "parameterizedModelPicker"] {
            assert_eq!(meta.get(key), Some(&Value::Bool(true)), "missing {key}");
        }
    }
}
