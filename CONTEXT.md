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

## Retrieval vocabulary

The retrieval stack (codeindex · embed · memory) has its own collisions — a
row missing from any one of three stores becomes invisible when the words
blur. The bare word **"index" is banned** here: always qualify it.

**Document**:
One retrievable unit of text with a stable id — a whole-file summary
(`CodebaseDoc`), a memory note (`MemoryDoc`), or an extracted fact. A document
is what retrieval returns. Five shapes exist (`CodebaseDoc` / `CorpusDoc` /
`MemoryDoc` / `DocText` / `RetrievedDoc`); when the shape matters, use the
type name.
_Avoid_: bare "doc" where the shape matters.

**Chunk**:
A sub-document span embedded on its own (header + body + hash). Atlas does not
chunk yet; when it does, "chunk" means this and is never a synonym for
document.

**Corpus**:
The gathered set of documents a query runs against, resolved at query time.
Say which corpus: the code corpus, the memory corpus. The `source`/`corpus`
tag field on a doc is a *tag*, not the corpus.

**Vector index**:
An embedding store answering nearest-neighbor queries. Atlas has two, and they
are different things: the **engine store** (HNSW at
`.atlas/memory/hnsw.usearch`, behind `MemoryEngine::retrieve` — the agent
pull/push paths) and the **flat store** (`.atlas/memory-index/index.json`,
brute-force scanned by the Memory UIs).
_Avoid_: bare "index", "the memory index" without saying which.

**Lexical index**:
A keyword/BM25 store (FTS5, planned). None ships today; ripgrep is the floor.

**Manifest**:
The engine store's id→key map (`.atlas/memory/manifest.json`). Identity, never
content.

**Docstore**:
The engine store's id→text map (`.atlas/memory/docstore.json`). Content, never
vectors.

**Codebase index**:
The structural scan output at `.atlas/codebase-index/docs.json`
(`atlas_codeindex::CodebaseIndex`). An input corpus for embedding — not itself
a vector index.

The invariant the vocabulary protects: `Manifest` maps `id→key`, the vector
store maps `key→vector`, `Docstore` maps `id→text`; a row missing from any one
makes a document silently unretrievable. That is why every store write is
atomic (temp + rename), every scan skip is counted, and every retrieval path
emits one `atlas::retrieval` line.

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
