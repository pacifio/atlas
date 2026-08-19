# Atlas

A desktop coding application that runs agentic coding sessions against whatever
model the user brings. This glossary fixes the vocabulary for the agent subsystem,
where several words are currently used for more than one thing.

## Language

**Engine**:
The component that runs a turn: talks to a model, dispatches tools, and produces
events. Each engine is user-selectable at session start.
_Avoid_: agent, runtime, driver.

**Atlas Agent**:
The native, in-process engine that works with any BYOK provider. Distinct from
**Atlas**, the display name of the engine shipping today. When the distinction
matters, say "Atlas Agent" or "the current native engine" — never bare "Atlas",
which names the application.
_Avoid_: the native agent, Cersei backend (that names the implementation, not the product).

**Backend**:
The implementation strategy behind an engine — in-process or external subprocess.
Two exist. An engine selects one; users never see the word.
_Avoid_: adapter, connection, transport.

**Wire Adapter**:
The translation between the internal request/event representation and one model
family's HTTP format. One adapter per family, not per model.
_Avoid_: provider (that means the vendor), client, driver.

**BYOK**:
Bring Your Own Key. A user-supplied credential for a model vendor, as opposed to
a subscription to a first-party coding product.

**Harness**:
Everything around the model that is not the model: turn loop, tool registry,
context management, compaction, approvals, sandbox.
_Avoid_: framework, SDK, core.

**Turn**:
One user prompt and everything that follows until the engine stops emitting tool
calls. A session is a sequence of turns.
_Avoid_: round, iteration, exchange.

**Containment**:
Advisory restriction of a tool's file paths to the workspace root, enforced in
Atlas before a tool runs. Distinct from **Sandbox**, which is OS-level enforcement
that also binds shell commands. Containment can be bypassed by a shell; a sandbox
cannot.
_Avoid_: path validation, jail, restriction.

**Gate**:
The single decision point every tool call passes through before anything runs.
It owns coercion, containment, the read registry, classification, the approval
cache, and sandbox selection. Realised as one policy object per session plus a
decorator around every registered tool. "The gate" names the concept; the tool
that implements it is not the gate.
_Avoid_: middleware, interceptor, hook.

**Read registry**:
The record, per canonical path, of what a tool saw when it last read a file. It
answers two questions with one mechanism: has this file been read at all this
session (the read-before-edit precondition), and has it changed since (staleness).
Because the gate sees every call, a shell command that names a path registers it,
so the precondition holds in both tool tiers.
_Avoid_: file cache, snapshot.

**Repeat read**:
A read whose answer is already in the conversation: the same tool, path and range, of a
file that has not changed since. The gate answers it with a stub naming the ways forward
rather than the file, because the second copy costs the whole file in context and carries
no information. Distinct from a *stale* read, where the file did change and the full
contents are served.
_Avoid_: cache hit, dedupe.

**Enforcement tier**:
Which rung of the ladder is actually in force for a session — sandbox, containment,
approvals, or nothing. Resolved at runtime from what the host provides, and always
reported to the user. A tier is a fact about the host, not a user setting; the user
setting that can lower it is the containment toggle.
_Avoid_: security level, mode (that names the permission mode).

**Shell-first tier**:
A tool set where the model reads and searches through the shell and edits through
a patch tool. Suits frontier models.

**Structured tier**:
A tool set with explicit Read, Edit, List, and Grep tools. Suits models that
cannot reliably drive a shell. Which model gets which tier is decided by
measurement, not assumption.

## Adoption vocabulary

Three distinct commitments, often collapsed under "fork". Say which one is meant.

**Lift**:
Take a dependency on an upstream crate unchanged. Only viable when its transitive
closure is small enough to accept whole.

**Vendor**:
Copy specific source files and data into `vendor/`, with an `UPSTREAM.md` pinning
the source revision and listing every local patch. Chosen when the mechanism is
wanted but the dependency graph is not.

**Fork**:
Take ownership of a codebase and diverge freely, accepting that upstream fixes
must be ported by hand forever.
