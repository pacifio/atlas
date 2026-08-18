# Atlas Agent — Robust BYOK Coding Harness

**Status:** Partly implemented · **Depends on:** ADR-0001 (vendor seatbelt), ADR-0002 (keep Cersei as the engine), CONTEXT.md
**Supersedes the recommendation in:** "Cersei → Codex Core" research artifact
**Superseded in part by:** `atlas-tool-layer-spec.md`, which replaces this document's
tool-layer claims. Three of them were written before the tool sources were read and are
wrong; they are corrected in place below.

## What has shipped

**Landed:** D2 (the gate, as one policy plus a decorator around every registered tool),
D3 (the runtime enforcement ladder, with a real macOS tier 0 and the tier reported in the
composer), D4 (tiers, defaulting to structured), D5 (the persistent terminal and the image
tool), the tool-resident half of D6 (read-before-edit ahead of execution, structured diffs
reaching the frontend), D10's vendor-patch guards — all four patches now have one, and `vendor/UPSTREAM.md`
records the pinned revision and every local change — and D11.

**Landed with a gap:** D3's ladder reports tiers 2 and 3, but nothing yet *selects*
them — the containment toggle the tier-2 row describes is not a setting a user can
reach. They are constructible and tested; they are not reachable.

**Not started, deliberately:** D7 (`WireAdapter`) and D9 (the BYOK evaluation matrix).
The ordering argument in *Further Notes* is the reason — measurement is the input to the
tier decision and can invalidate the adapter design, and the matrix needs live provider
keys and network. D8's frontend engine-identity collapse and the rest of D10 (the
upstream-tracking document, the toolchain pin, the session-directory hasher) are
repository-infrastructure work with no dependency on any of the above (the
upstream-tracking document itself did land, as `vendor/UPSTREAM.md`). The session-actor
half of D6 — supersede, RPC deadlines, the corrupt-session notice — lives in
`atlas-agents` and `src-tauri` and is tracked in `atlas-agent-stack-zed-parity.md`.

---

## Problem Statement

A user brings their own API key, picks Atlas Agent, and expects it to code as well as
Claude Code or Codex do. Four things stop that today.

**It is not safe.** The agent runs model-authored shell commands at the desktop app's
full privilege. No sandbox exists. File tools accept absolute paths and unnormalised
`..` segments, so an edit can land anywhere the process can write — and there is a test
asserting that pass-through as correct behaviour. The one control that exists is a
permission prompt, and it is broken in two ways: "Allow for this session" is a no-op
that re-prompts on the very next call, and every shell command is classified
identically, so `echo hi` interrupts the user as loudly as `rm -rf /`. Both defects
push people into bypass mode, which disables approval for everything including
arbitrary MCP server code.

**A turn is not accountable.** Pressing Stop does not stop writes. Sending a second
message while one is running interleaves two turns and silently loses one's history. A
failed turn discards the user's message and all partial output from both context and
disk. A corrupt session file loads as empty without saying so. No RPC has a timeout, so
a wedged adapter freezes the session permanently. The model reports an edit as rejected
*after* the write already landed. Thirteen of twenty-four engine events are swallowed by
a catch-all arm. Structured diffs are discarded before reaching the UI, so file-change
counts read zero with nothing erroring.

**It is not proven.** No full agent turn has ever been tested. The provider, the stream
decode, and the tool loop are entirely unexercised. The test that was written to answer
"which models can actually drive this harness" is a stub.

**It only reaches one model family well.** The provider layer supports Anthropic,
Gemini, and twelve OpenAI-compatible bases, but nothing above it adapts: tool schemas
are emitted one way, tool names can exceed what some providers accept, reasoning
signatures are not round-tripped, and there is no per-model tool selection. A user
bringing a mid-tier open-weights model gets the same tool set as a frontier model, and
nobody has measured whether it can drive it.

---

## Solution

Atlas Agent becomes a harness with four properties, in this order:

**Safe by construction.** Enforcement moves *below* the tool. Every tool call passes
through one policy gate before anything executes — path containment, per-command risk
classification, approval with a cache that works, an OS sandbox, and an escalation path
when the sandbox denies. A tool cannot opt out, and adding a tool cannot add a hole.
The gate degrades at runtime rather than failing: full sandbox where available,
containment-only where not, approvals-only below that, and today's behaviour as the
floor — so the harness is never worse than the status quo on any host.

**Accountable per turn.** Stop means stopped. Two turns never interleave. Every tool
call the model made gets a paired result, including on cancel, error, timeout, and
sandbox denial. History survives failure, cancellation, and crash. Nothing is dropped
silently — every filter, cap, and skip emits a count.

**Model-adaptive.** One tool registry, two tiers. Frontier models get the short
shell-first set; weaker models get the structured set. Which model gets which tier is
decided by a measurement, not an assumption. A thin adapter seam serialises tools,
history, and streams per model family, so Anthropic, Gemini, and OpenAI-compatible
endpoints are all first-class.

**Provable.** A no-network turn harness, a mock provider behind the existing factory
seam, and a BYOK evaluation matrix that produces a published supported-model list
instead of a promise.

Cersei remains the engine. Codex contributes its enforcement mechanism and two missing
tools, vendored rather than depended upon.

---

## User Stories

### Safety

1. As a BYOK user, I want the agent's shell commands confined to my workspace, so that a misread instruction cannot reach my SSH keys or browser profile.
2. As a BYOK user, I want file reads, writes, and edits confined to my workspace, so that no tool can touch a path I did not open.
3. As a BYOK user, I want relative paths containing `..` to be resolved and rejected if they escape, so that containment is not defeated by a traversal string.
4. As a user, I want "Allow for this session" to actually remember my answer, so that approving a command once does not re-prompt me every single call.
5. As a user, I want low-risk commands to run without a prompt and destructive ones to always ask, so that I am interrupted proportionally to real risk.
6. As a user, I want a command the sandbox denies to offer me an escalation choice, so that a legitimate action outside the workspace is a decision rather than a dead end.
7. As a user who chooses bypass mode, I want it to relax approvals without disabling containment, so that "stop asking me" does not silently mean "you may edit anything on my disk."
8. As a user on a host with no sandbox support, I want the harness to fall back to containment and approvals rather than silently running unconfined, so that degradation is visible and safe.
9. As a security-conscious user, I want to see which roots the agent can read and write before I start a session, so that I can decide whether to proceed.
10. As a user, I want MCP server tools to pass through the same gate as built-in tools, so that installing a server does not bypass every control I configured.

### Turn integrity

11. As a user, when I press Stop, I want no further file writes to land, so that stopping is a fact rather than a request.
12. As a user, when I send a new message while a turn is running, I want the previous turn cancelled first, so that two turns never interleave in my transcript.
13. As a user, when a turn fails, I want my message and any partial output preserved in the session, so that I can see what happened and continue.
14. As a user, when the app crashes mid-turn, I want to reopen the session and find the turn marked failed rather than missing, so that I can trust my history.
15. As a user, I want a corrupt session file to load with a visible notice, so that I never mistake data loss for an empty conversation.
16. As a user, I want a wedged agent request to time out with an error, so that one bad adapter cannot freeze the session permanently.
17. As a user, I want a permission prompt still open when a turn ends to be swept, so that answering it late does not leave a spinner that never stops.
18. As a user, I want a cancelled tool call to appear as cancelled rather than completed, so that the transcript tells the truth.
19. As the agent, I want every tool call I made to receive a result, so that the next turn's request is valid and does not fail with an error about the previous turn.
20. As a user, I want to see accurate file-change counts for a turn, so that I know what was modified without re-reading the diff.

### Tools

21. As a user, I want to start a dev server or a REPL and have it stay alive across turns, so that the agent can iterate against a running process.
22. As a user, I want to interact with a long-running process — send input, read output — so that the agent can drive an interactive command.
23. As a user, I want long-running commands not to be killed by a fixed timeout, so that a slow build completes.
24. As a user, I want to paste or attach a screenshot and have the agent look at it, so that I can point at a broken UI instead of describing it.
25. As a user on a frontier model, I want a short tool list, so that the model spends its attention on my problem rather than on tool selection.
26. As a user on a mid-tier model, I want explicit Read, Edit, List, Grep, and Glob tools, so that the model is not required to compose shell pipelines correctly.
27. As a user, I want rarely used tools to be discoverable rather than always present, so that the visible tool list stays short.
28. As the agent, I want an edit whose precondition fails to fail *before* touching the file, so that a rejection message and the file on disk never disagree.
29. As the agent, I want a fuzzy edit matcher that tolerates whitespace and punctuation variance, so that a near-miss on context does not force a full rewrite.
30. As a user, I want very large tool output truncated with a pointer to the full content, so that one command cannot consume my whole context window.
31. As a user, I want search tools that work without any model download, so that the agent can find code on a fresh install.

### BYOK

32. As a BYOK user with an Anthropic key, I want Atlas Agent to work with Claude models, so that I am not required to buy a separate coding subscription.
33. As a BYOK user with a Gemini key, I want the same, so that my existing provider choice is respected.
34. As a BYOK user with any OpenAI-compatible endpoint, I want the same, so that local and hosted open-weights models are first-class.
35. As a BYOK user, I want reasoning content to round-trip correctly, so that my second turn does not fail with an error caused by my first.
36. As a BYOK user, I want prompt caching used where my provider supports it, so that long sessions do not cost more than they should.
37. As a BYOK user, I want tool names that every provider accepts, so that installing an MCP server with a long name does not break my session.
38. As a BYOK user, I want to know before I start which models are supported at which quality level, so that I can choose one that will actually work.
39. As a BYOK user on a weaker model, I want the harness to select the tool tier that model can drive, so that I get working behaviour rather than a stream of malformed calls.
40. As a BYOK user, I want a provider error to be classified and retried when it is transient, so that a rate limit does not end my turn.
41. As a BYOK user, I want a non-retryable error explained in plain language, so that I know whether to fix my key or wait.

### Existing users and maintainers

42. As an existing user, I want my old sessions to open unchanged, so that upgrading never costs me history.
43. As a user with a Codex subscription, I want to keep using Codex as an engine, so that this work does not take something away from me.
44. As a maintainer, I want a full agent turn testable with no network, so that the provider, stream decode, and tool loop stop being unexercised.
45. As a maintainer, I want every vendored patch recorded with a guard, so that a re-vendor cannot silently drop one.
46. As a maintainer, I want one canonical engine-identity type in the frontend, so that adding an engine does not create a fifth divergent copy.
47. As a maintainer, I want a pinned Rust toolchain, so that the build is reproducible and a compiler upgrade cannot orphan stored data.
48. As a maintainer, I want telemetry on tool-call outcomes, so that "the tools don't work" becomes a specific, fixable claim.
49. As a contributor, I want the tool policy to be a pure function, so that I can add a rule and test it without running an agent.

---

## Implementation Decisions

### D1 — Engine: Cersei stays; Codex contributes mechanism, not dependency

Per ADR-0002, the turn loop, tool registry, context management, and provider layer
remain Cersei's. Codex's harness code is adopted per ADR-0001 by **vendoring** the
macOS sandbox profile generator and its policy data, not by taking a Cargo dependency —
the dependency route costs roughly two hundred additional crates on a macOS build
because the Windows sandbox crate is not target-gated, and pulls an OTLP exporter, a
proxy stack, an image decoder, and a Starlark interpreter to produce a command line.

The Starlark policy engine is rejected outright: it ships no rules, and the equivalent
default safety is a command classifier that is already compiled into the tree.

### D2 — `ToolPolicy`: one gate, applied once

A new module owns every pre-execution decision. It is a pure function over
`(tool_name, tool_input, session_mode, workspace_root, host_capabilities)` returning a
decision. It is applied by a single decorator wrapped around every registered tool at
registry construction, including SDK-provided tools and MCP-discovered tools. No tool
performs its own containment or approval logic.

Decision shape, which encodes the escalation contract more precisely than prose:

```
Decision:
  Allow { argv: Option<Vec<String>> }   // argv present when sandbox-wrapped
  Prompt { reason, risk, cache_key }    // cache_key is what "allow for session" stores
  Deny { reason }                       // never reaches the OS
```

Ordering inside the gate is fixed: **contain → classify → consult cache → prompt →
sandbox-wrap → execute → detect denial → escalate**. Escalation re-enters at the prompt
step with the denial as context, and a granted escalation runs uncontained *for that
call only* — it is never cached.

Containment resolves the path, collapses `..` lexically, normalises Unicode, and
rejects anything outside the workspace root. The algorithm already exists in the
checkpoint crate with tests covering traversal and home-directory escape; it is lifted
rather than rewritten. The existing test that asserts absolute-path pass-through is
deleted, because it asserts the bug.

~~Risk classification uses the command classifier already present in the tool SDK.~~
**Withdrawn on evidence; see the tool spec's D8.** That classifier substring-matches a
lowercased command with no parsing, and its top tier is an unappealable block containing
the token `fork` — so `gh repo fork` and `cargo build --features fork` would be impossible
to run, while `rm -r -f /` and `rm --recursive --force /` miss it entirely. It has no call
sites and gains none.

What replaced it: commands are **tokenised and parsed**; a small whitelist of read-only
commands may skip the prompt; anything unparseable fails closed; the destructive list only
*forces* a prompt the approval cache cannot suppress; and **no `Forbidden` outcome may
originate from pattern matching**. The sandbox is the boundary. This still delivers the
thing that mattered here — a *per-command* verdict, replacing a constant per tool with no
access to the input — which works because the runner already hands the tool input to the
permission policy.

### D3 — Sandbox as a runtime ladder, not a build-time choice

The gate selects the strongest enforcement the host supports, at runtime:

| Tier | Enforcement | Reached when |
|---|---|---|
| 0 | OS sandbox + containment + approvals | macOS with the system sandbox binary |
| 1 | Containment + approvals | sandbox unavailable |
| 2 | Approvals only | containment disabled by explicit user setting |
| 3 | Today's behaviour | never selected automatically; the floor |

The same binary degrades based on what is present. The tier in force is visible in the
session UI, because silent degradation is the failure this design exists to prevent.

Linux and Windows enforcement are out of scope (see Out of Scope) and land on Tier 1.

### D4 — Two tool tiers, one registry, plus a deferred tail

Registry construction takes a tier and emits one list. Tools not in either tier are
registered as deferred — described in a searchable catalogue rather than the default
tool list — because a long visible tool list degrades tool selection, and that harms
weaker models most.

| Tier | Contents |
|---|---|
| Shell-first | shell, persistent shell, patch-apply, image view, web fetch, web search, skill, plan, memory search, MCP tools |
| Structured | the above plus read, edit, list, grep, glob, write, multi-edit |
| Deferred | notebook edit, code search, third-party search |
| Platform-gated | PowerShell on Windows only |

Tier assignment per model comes from the evaluation matrix (D9), not from a hardcoded
table. Until the matrix exists, the default is the structured tier, because
over-provisioning tools degrades gracefully and under-provisioning does not.

The existing replacer is retained; a tripwire test already demonstrates it covers cases
the SDK's ladder misses. ~~The patch-apply tool adopts the multi-tier fuzzy context matcher
from Codex.~~ **Withdrawn on evidence; see the tool spec's D9.** Measured against Codex's
four-tier matcher, Atlas's ladder is better on the axes that matter: it refuses ambiguous
matches where Codex silently takes the first, refuses disproportionate matches where Codex
has no such guard, handles literal escapes, and its failure messages show real file content
where Codex's echo the failed pattern with no context.

What was taken instead: the one genuinely missing idea, punctuation normalisation, added as
a tenth strategy that folds typographic quotes, dashes and exotic spaces before comparing.
A behavioural fix landed with it — a candidate rejected as oversized used to abort the whole
ladder, so a later strategy that would have matched exactly never ran.

### D5 — Two new tools

**Persistent shell.** A session-scoped PTY with an LRU bound on live processes and
head/tail output buffering. The PTY library is already a dependency of the terminal
crate and is currently not exposed to the agent at all; this wires existing in-house
machinery rather than importing anything. Replaces the fixed-timeout, one-shot-only
constraint for long-running and interactive commands. The one-shot shell tool remains
for simple commands.

**Image view.** Reads an image from a contained path and returns it as model input.
Gated on the model's declared input modalities; absent from the tool list when the model
cannot accept images.

### D6 — Turn integrity

Fixes, all in the engine wrapper and the session actor, sourced from the existing
Zed-parity audit's ranked findings:

- Events carry the turn identity they belong to, so a superseded turn's output cannot
  land in the successor's transcript. A new prompt awaits cancellation of the running
  turn before sending.
- Native history is written under a single owner per session, so two concurrent turns
  cannot each clone and last-write-wins.
- Turn failure writes history and persists *before* returning.
- Session persistence is atomic (temp plus rename), and a corrupt file loads with a
  visible notice rather than as empty.
- Every agent RPC carries a deadline.
- On disconnect, the frontend clears the cache entry for the engine that actually
  disconnected.
- Pending permission requests are swept at turn end; a late response cannot emit a
  running status against a finished turn.
- Late tool calls arriving after idle are marked cancelled, not completed.

The read-before-edit precondition moves ahead of execution. Its current position after
the execution phase means the guard rewrites a successful result into an error while the
write is already on disk.

The event-translation layer's catch-all arm is replaced with explicit arms. Events with
no downstream meaning are logged and counted; none are silently discarded. Structured
diff content stops being flattened to a path, so the frontend receives real before/after
text and file-change accounting stops depending on re-derivation from vendor-flavoured
raw input.

### D7 — `WireAdapter`: three methods and a small capability set

A trait with exactly three responsibilities:

```
serialize_tools(&[ToolSpec], &ModelCapabilities) -> ProviderToolsJson
serialize_history(&[Message], &ModelCapabilities) -> ProviderRequestBody
parse_stream(ByteStream) -> Stream<Item = Result<TurnEvent, ProviderError>>
```

Plus a capability set on the model descriptor — deliberately a handful of booleans and
one enum, not a per-model matrix. A large capability table is how the previous attempt
produced dead code.

Implementations: Anthropic, Gemini, OpenAI-compatible. The existing provider layer
already handles all three transports; the adapter sits above it and owns only the
translation. The extraction happens while exactly one implementation exists behind the
trait, because retrofitting an abstraction after two concrete cases exist is materially
harder.

Cross-provider requirements the adapter owns:

- **Tool names.** Flattened to a single field matching the most restrictive accepted
  pattern, capped at the shortest accepted length, with deterministic collision handling.
  MCP-derived names commonly exceed the cap with real server names.
- **Patch tool encoding.** A JSON-schema variant of the patch tool for providers that do
  not support grammar-constrained tools. This does not exist in either upstream codebase
  and is net-new.
- **Reasoning round-trip.** Anthropic thinking signatures and Gemini thought signatures
  are carried opaquely and returned verbatim. Dropping either produces a failure on the
  *following* turn, not the one that caused it, which is why this is adapter-owned and
  golden-tested rather than left to callers.
- **Prompt caching.** Explicit breakpoint placement where the provider requires it,
  implicit where the provider handles it server-side.
- **Result pairing.** Every tool call in a request has a matching result, synthesised
  where necessary on cancel, error, timeout, or sandbox denial.
- **Error classification.** Transient versus permanent, with backoff for the former and
  a plain-language explanation for the latter.

### D8 — Identity, migration, and compatibility

Atlas Agent is a distinct engine identity from the engine shipping today, per the
glossary. The four divergent frontend engine-identity unions are collapsed into the one
canonical type **before** a new member is added, and the Rust-side registry is
reconciled with it.

Existing sessions are read, never migrated. The current deserialiser is retained
permanently as a replay-only path. On-disk directory names and stored preference keys
that carry the old engine name are read from both the old and new locations, writing only
to the new.

The Codex engine remains available and is not removed.

### D9 — Measurement before adaptation

The BYOK evaluation matrix is written and run **before** adapter work begins, against
the stack as it exists today. It measures, per model tier, first-attempt edit acceptance
and multi-step task completion across a fixed task set. Its output is a committed table
and a published supported-model list.

Tool-call outcome telemetry lands with it: one structured record per tool call carrying
tool name, tier, decision, outcome, and latency — no arguments, no paths, no content.
This is what turns "the tools don't work" into a specific claim. It follows the schema
and redaction discipline already established for retrieval telemetry.

### D10 — Vendor hygiene

The vendored fork gains an upstream-tracking document recording the pinned upstream
revision and every local patch. There are currently four patches, one of which has no
guard constant and no mention in any manifest comment, and is therefore the one a
re-vendor will silently drop. Every patch gains a guard constant referenced from a
compile-time assertion, matching the pattern already used for the streaming fix that
previously regressed out of the build.

Two of the four patches solve problems that are not engine-specific — incremental UTF-8
decoding across stream chunk boundaries, and provider retry classification. Both are
required by any provider implementation and are treated as harness-level concerns, not
vendor patches, going forward.

A toolchain pin is added. The repository currently has none while already using a newer
language edition in one crate. Separately, the session-directory hash is moved off the
standard library's default hasher, whose output is explicitly not stable across compiler
releases — a toolchain bump would otherwise orphan every stored session.

### D11 — Interaction with the retrieval plan

`BashTool` is the retrieval plan's bottom fallback tier. Containment changes its
behaviour: shelling out to a search binary outside the workspace root will be denied.
This is intentional and must be reflected in the retrieval plan's ladder rather than
discovered later.

Search tool inventory is unified with the tier decision rather than decided separately:
the shell-first tier searches via the shell, the structured tier gets in-process grep and
glob, and a ranked code-search tool replaces both only if the retrieval evaluation shows
ranked results beat plain search. Four concurrent ways to search code is the exact
tool-count problem that harms weaker models.

---

## Testing Decisions

**What makes a good test here.** Tests assert externally observable behaviour: the
decision a policy returns, the bytes an adapter emits, the sequence of session updates a
turn produces. They do not assert that a particular function was called, that a struct
has a field, or that an internal type has a shape. A test that must change when an
implementation is refactored without behaviour changing is a defect in the test.

**`ToolPolicy` — table-driven, pure.** The highest-value seam in this spec, because it
is a pure function. Cases: absolute path outside root denied; traversal collapsed and
denied; path inside root allowed; symlink escaping the root denied; low-risk command
allowed without prompt; destructive command always prompts regardless of cache; cache
hit suppresses a second prompt for the same key; cache miss on a different key prompts;
escalation grant is not cached; each ladder tier produces the expected decision on the
same input. No agent, no network, no filesystem beyond a temp root.

**`WireAdapter` — golden tests, both directions.** Request direction: a fixed message and
tool list serialises to an expected body per provider family, asserted against a checked-in
golden file. Response direction: fixed stream bytes parse into an expected event sequence.
Specific cases with their own tests, because each fails a turn late and is therefore
expensive to debug from a bug report: reasoning signature preserved across a round trip;
tool name exceeding the cap truncated deterministically without collision; cancelled tool
call yields a synthesised paired result; patch tool encoded per the model's declared
capability. The mock-stream builder pattern is lifted from Codex's test support.

**Full turn — mock provider behind the existing factory seam.** The provider factory is
already an injection point and was already made fallible by a vendored patch. A mock
provider driven by scripted responses lets a complete turn run with no network: prompt in,
tool calls dispatched through the real policy gate and real tools against a temp
workspace, session updates out. Assertions are on the emitted update sequence. This is
the first full-turn test in the repository; the connection is currently faked, so the
provider, stream decode, and tool loop are unexercised.

Turn-integrity cases run here: stop produces no writes after the stop point; a second
prompt supersedes without interleaving; a failed turn persists history; a cancelled tool
call appears cancelled; every tool call has a paired result.

**Regression guards.** The existing tripwire pattern is retained and extended: the test
that asserts Atlas-owned tools out-perform their SDK equivalents keeps the structured
tier honest, and each vendored patch gains a compile-time guard constant. The test
currently asserting absolute-path pass-through is deleted, not adapted.

**Prior art in this repository.** The session actor's async test suite is the model for
turn tests, including its use of paused-clock tests for deadline behaviour. The checkpoint
crate's path-resolution tests are the model for containment cases and are the source of
the algorithm itself. The streaming-fix guard is the model for patch guards.

**What is not tested.** Sandbox profile *content* is not unit-tested — it is vendored
security policy data, and its correctness is established by an integration test asserting
that a known-sensitive path is unreadable and a workspace path is readable under Tier 0.

---

## Out of Scope

- **Forking the Codex core.** Settled in ADR-0002.
- **Linux and Windows OS sandboxing.** Linux requires shipping a separate sandbox
  executable as a packaged sidecar, which is a packaging workstream rather than a code
  change. Windows has no path short of the dependency ADR-0001 rejects. Both land on
  ladder Tier 1 — containment and approvals — which is a real improvement over today.
- **The Starlark policy engine.** Rejected in ADR-0001.
- **Network mediation.** No proxy, no per-host policy. Sandbox network posture is
  all-or-nothing for now.
- **Replacing the graph memory store.** Known defective, tracked separately.
- **Retrieval State 3.** Chunking, lexical index, and model swap are gated on their own
  telemetry in the retrieval plan. Only the tool-inventory overlap is decided here.
- **Multi-agent orchestration and sub-agent spawning.**
- **Embedding the Codex app-server in-process.** A worthwhile contained improvement to
  the Codex engine — it removes a network install and two subprocess hops — but it is
  OpenAI-only on the wire and therefore does nothing for this spec's goal.
- **Removing Cersei from the memory, code-index, and review crates.** Their coupling is
  thin and none of it is on this critical path.

---

## Further Notes

**Ordering is not arbitrary, and it held.** Safety shipped first because it is independent
of every other decision here and fixes live defects. Measurement ships second because it is the
input to the tier decision and can invalidate the adapter design. The adapter ships last
because it is the largest piece and the only one that cannot be undone cheaply.

**Two cost anchors worth keeping in view.** The nearest-neighbour precedent for a second
wire format — same vendor, same JSON idioms — was roughly three thousand lines when it
was removed from Codex, and its encoder dropped several message variants as
unrepresentable. A more distant provider is more work, not less. Separately, the failure
mode for reasoning round-tripping is a request failure on the turn *after* the one that
caused it, which is why golden tests for it are specified rather than assumed.

**The claim to make publicly.** "Any model you bring runs safely, keeps a valid
conversation, and never silently loses your work — and the ones strong enough to code,
code well." Not "the same quality bar on any model." A harness raises the floor; the
model sets the ceiling. The evaluation matrix exists so that the supported-model list is
published rather than promised.

**An outcome this spec permits.** If the evaluation shows that the models users actually
bring require the structured tier, then the shell-first tier is a frontier-model
optimisation rather than the primary design, and the tool layer is the product rather
than the adapter. That would be a finding, not a failure — the measurement is placed
before the adapter precisely so that it can be a decision instead of a discovery made
months in.
