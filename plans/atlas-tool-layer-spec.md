# Atlas Agent — Tool Layer Upgrade

**Status:** Implemented, with three gaps recorded below. D1–D13 have landed in
`crates/atlas-cersei/src/tools/`, with the guard's own test surface in
`tests/tool_gate.rs`, the enforcement ladder's in `tests/sandbox_tier0.rs`, and the
vendored-patch guards in `tests/vendor_patch_guard.rs`.

**Known gaps, stated rather than quietly closed:**

1. **D4 covers `Edit` only.** "This covers the edit tool, the whole-file write tool, the
   multi-edit tool, and the patch tool." `Write` and `NotebookEdit` are SDK-owned and write
   in place, as does `ApplyPatch` in the shell-first tier. Making them atomic means vendoring
   `cersei-tools`, which is a dependency commitment of the kind ADR-0001 weighs
   explicitly — not something to take on inside this change. The multi-edit half of this gap
   is *closed*: batched edits are now `Edit`'s `edits` array and go through the same atomic
   write as a single one. Story 2 holds for every batched or single string replacement, and
   not for whole-file writes, notebooks, or patches.
2. **D13's deferred tier does not exist.** There is no searchable catalogue, so notebook
   edit and code search sit in the structured tier rather than behind one. Story 45 is
   unmet. They are *registered*: dropping them would remove a capability users have today,
   which is worse than a slightly longer list. Third-party search is the exception — it
   cannot run without an API key, so it is registered only when one is set, which is a
   narrower fix than the tier and does not substitute for it.
3. **Tier-per-model is not decided.** It waits on the harness spec's evaluation matrix,
   so every model gets the structured tier.
**Depends on:** ADR-0001 (vendor seatbelt), ADR-0002 (keep Cersei as the engine), CONTEXT.md
**Companion to:** `atlas-agent-harness-spec.md` — that spec covers the turn; this one covers the tools.
**Supersedes:** the tool-layer section of `atlas-agent-harness-spec.md`, and the tool claims in the
"Cersei → Codex Core" research artifact, both of which were written before the tool sources were read.

---

## Problem Statement

Users report that the agent's tools do not work well. Reading the tool sources end to end, and
comparing them against Codex's equivalents, the reports are real but the cause is not what it
looks like.

**The tools themselves are well built.** The replacer runs nine matching strategies with
Levenshtein scoring, refuses ambiguous matches, and refuses a match whose span is wildly larger
than the requested text. The error strings show the model a numbered window of real nearby file
content and steer small files toward a whole-file rewrite. The edit tool normalises BOM and CRLF
for matching and restores both on write. The shell tool runs its child in its own process group so
cancellation kills grandchildren, writes output to a file rather than a pipe so a full pipe buffer
cannot deadlock its poll loop, returns a real settled result on cancellation, and correctly treats
a non-zero exit with output as a success because that is normal for grep, diff, and test runners.
Measured against Codex's tool layer, several of these are better.

**What is missing is the layer underneath them: durability, containment, and honesty.**

*Data loss.* The edit tool reads a file, matches, and writes, with nothing verifying the file is
unchanged since the model read it — a user editing in their editor while the agent works is
silently overwritten. Writes are not atomic, so a crash mid-write truncates source. The per-file
lock is keyed on an un-canonicalised path, so the same file reached by relative and absolute paths
takes two different locks and the serialisation guarantee does not hold.

*No containment.* Path resolution passes absolute paths through untouched and joins relative paths
without collapsing `..`. There is a test asserting this pass-through as correct behaviour. Nine of
the sixteen registered tools come from the SDK and perform no path checking at all.

*Silent failure.* Three separate tools convert an I/O or task failure into plausible-looking empty
output via `unwrap_or_default` — a failed output read becomes an empty command result, a panicked
directory walk becomes "no files found", and invalid UTF-8 becomes replacement characters the model
may write back into the file.

*The wrong half kept.* Output truncation keeps the head and discards the tail, which for a failing
build or test run discards the error. Each truncation also writes a full copy of the output to a
temp file that is never deleted, at a path outside the workspace — so under containment the model
would be told to read a file it will then be denied.

*Unbounded memory.* Both the read tool and the shell tool load their entire input into memory before
applying any cap. Reading ten lines from a large file allocates the whole file twice; a command
emitting several gigabytes is fully buffered, then trimmed to thirty kilobytes, then copied again to
the leaked spill file.

*A dangerous dead classifier.* The SDK ships a command risk classifier that is substring matching on
a lowercased string, with no parsing. Its Critical tier maps to an unappealable block. `fork` is in
that tier, so forking a repository, or building with a feature named `fork`, would be hard-blocked.
Meanwhile `rm -r -f /` and `rm --recursive --force /` miss the Critical tier entirely, and
substring collisions in the low-risk list mis-tier common commands. It currently has zero call sites.
It must stay that way.

*Two capability gaps.* The shell is one-shot with a wall-clock timeout, so no dev server, REPL,
interactive command, or long build survives a call. And there is no image tool at all, so a user
cannot show the agent a screenshot of what is wrong.

---

## Solution

Keep the tools. Build the layer beneath them, and add the two that are missing.

**One gate, applied once.** Every registered tool — Atlas-authored, SDK-provided, and
MCP-discovered — is wrapped by a single guard at registry construction. The guard owns argument
coercion, path containment and canonicalisation, the read registry, risk classification, the
approval cache, sandbox selection, and denial escalation. No tool performs any of this itself, so a
tool added later inherits all of it without knowing it exists.

**Durability by default.** Canonicalised paths make the per-file lock correct. The read registry
makes staleness detectable and gives read-before-edit in both tool tiers, including when reads
happen through the shell. Every write is atomic. Every silent-failure path becomes a real error.

**Honest output.** Truncation keeps head *and* tail, reports true totals rather than post-cap ones,
and spills the full output inside the workspace where the model is permitted to read it. Caps apply
while streaming, so nothing is fully buffered before being discarded.

**Classification that cannot block.** A small whitelist of provably-safe commands, parsed properly,
failing closed on anything it cannot parse. Its only power is to skip a prompt. The sandbox is the
boundary; a pattern match is not.

**Two new tools.** A persistent terminal session, and an image viewer.

---

## User Stories

### Not losing work

1. As a user, I want the agent to refuse an edit to a file I changed since it last read it, so that my in-editor work is never silently overwritten.
2. As a user, I want file writes to be atomic, so that a crash or power loss during a write cannot truncate my source file.
3. As a user, I want concurrent edits to the same file to serialise correctly regardless of how the path was spelled, so that two tool calls cannot interleave writes to one file.
4. As a user, I want a tool that fails to say so, so that I never mistake an I/O error for an empty result.
5. As a user, I want a directory walk that panics to report an error, so that "no files found" always means the directory is empty.
6. As a user, I want a file with invalid encoding to be reported rather than silently substituted, so that the agent cannot write replacement characters back into my file.

### Containment

7. As a user, I want every file tool bound to my workspace, so that no tool can read or write a path I did not open.
8. As a user, I want paths containing `..` resolved and rejected when they escape, so that containment cannot be defeated by a traversal string.
9. As a user, I want SDK-provided and MCP-discovered tools contained on the same terms as Atlas's own, so that installing a server does not create an unguarded path.
10. As a user, I want a symlink pointing outside the workspace to be treated as outside it, so that containment is not defeated by indirection.

### Honest output

11. As a user, I want the end of a failing build's output preserved, so that the agent sees the error rather than the first thirty kilobytes of progress lines.
12. As a user, I want truncated output to report the true original size, so that neither I nor the model mistakes a capped window for the whole thing.
13. As a user, I want the full output of a truncated command to remain retrievable, so that the agent can go read the part it needs.
14. As a user, I want that retrievable copy to live somewhere the agent is allowed to read, so that the truncation notice is not an instruction the gate then denies.
15. As a user, I want temporary output files cleaned up when the session ends, so that long sessions do not fill my disk.
16. As a user, I want a command producing gigabytes of output not to exhaust memory, so that one runaway command cannot take down the app.
17. As a user, I want reading ten lines of a large file to be cheap, so that pagination is actually pagination.

### Approvals and classification

18. As a user, I want commands the harness cannot confidently parse to prompt rather than auto-run, so that unusual shell syntax is never waved through.
19. As a user, I want a provably-safe read-only command to run without a prompt, so that exploration is not death by dialog.
20. As a user, I want no command hard-blocked by a pattern match, so that a legitimate command is never made impossible to run.
21. As a user, I want approving a command to be remembered for the session, so that the same prompt does not return on the next call.
22. As a user, I want a destructive command to prompt every time regardless of what I approved earlier, so that a broad approval cannot cover a narrow disaster.
23. As a user, I want the sandbox rather than a keyword list to be what actually stops a dangerous command, so that my protection does not depend on the spelling.

### Editing

24. As the agent, I want an edit whose text appears more than once to be refused, so that I do not silently change the wrong occurrence.
25. As the agent, I want an edit whose match spans far more than I asked for to be refused, so that I cannot corrupt unrelated code.
26. As the agent, I want a failed edit to show me real numbered lines from the file, so that I can correct it without a full re-read.
27. As the agent, I want minor indentation and whitespace drift tolerated, so that a near-miss does not force a rewrite.
28. As the agent, I want typographic quotes, dashes, and non-breaking spaces folded before matching, so that a smart quote I emitted does not fail against an ASCII file.
29. As the agent, I want text I escaped literally to still match, so that emitting a backslash-n does not break the edit.
30. As the agent, I want CRLF and BOM preserved on write, so that editing a Windows file does not rewrite every line ending.
31. As a user, I want an edit to report an accurate structured diff, so that file-change counts and the review view show what actually happened.

### The shell

32. As a user, I want to start a dev server and have it stay running across turns, so that the agent can iterate against it.
33. As a user, I want the agent to send input to a running process, so that it can drive a REPL, a prompt, or an interactive installer.
34. As a user, I want to read new output from a running process without restarting it, so that the agent can watch a build.
35. As a user, I want a long build not killed by a fixed timeout, so that slow compilation completes.
36. As a user, I want a stopped command to kill its whole process tree, so that a cancelled build leaves no orphaned compiler processes.
37. As a user, I want a cancelled command to return whatever output it produced, so that the agent learns something from the attempt.
38. As a user, I want a bounded number of background sessions with the most recent protected, so that long sessions do not accumulate processes without limit.
39. As a user, I want a non-zero exit with output treated as a result rather than a failure, so that grep finding nothing or a test reporting failures reads correctly.

### Seeing

40. As a user, I want to attach a screenshot and have the agent look at it, so that I can show a broken layout instead of describing it.
41. As a user, I want the image tool absent for models that cannot accept images, so that it fails at selection time rather than mid-turn.
42. As a user, I want a non-image file passed to the image tool rejected clearly, so that the agent gets a correctable error.

### Tiering and model fit

43. As a user on a frontier model, I want a short tool list, so that attention goes to my problem rather than tool selection.
44. As a user on a mid-tier model, I want explicit file tools, so that the model is not required to compose shell pipelines correctly.
45. As a user, I want rarely used tools searchable rather than always present, so that the visible list stays short.
46. As the agent, I want malformed arguments corrected before they reach a tool, so that a wrong field name or a double-encoded object does not waste a turn.
47. As the agent, I want that correction applied to every tool, so that SDK and MCP tools behave like Atlas's own.
48. As the agent, I want an argument decode failure to show me a concrete valid example, so that I can retry correctly rather than guess.

### Maintainers

49. As a maintainer, I want the guard to be a pure function, so that I can add a rule and test it without running an agent, a provider, or a network.
50. As a maintainer, I want tool tests that exercise the real permission path, so that approval behaviour is not untested.
51. As a maintainer, I want tool-call outcome telemetry, so that "the tools don't work" becomes a specific claim I can act on.

---

## Implementation Decisions

### D1 — One guard, applied at registry construction

A `Guarded<T: Tool>` decorator wraps every tool the registry emits, holding a shared `ToolPolicy`.
`ToolPolicy` owns the workspace root, the canonicalisation routine, the schema-driven coercion
table, the approval cache, the read registry, the classifier, and sandbox selection. It is the only
new seam in this spec.

Decision ordering inside the guard is fixed:

```
coerce args → contain paths → check freshness → classify → consult cache
  → prompt → sandbox-wrap → execute → detect denial → escalate → record
```

`Deny` returns before execution. `Escalate` re-enters at the prompt step carrying the denial, and a
granted escalation applies to that single call and is never cached.

No tool implements containment, coercion, approval, or sandboxing itself. Existing per-tool coercion
constants and the path-resolution helper are removed in favour of the guard.

### D2 — Containment, and the lock bug it fixes for free

Path containment resolves, collapses `..` lexically, normalises Unicode, resolves symlinks, and
rejects anything outside the workspace root. The algorithm already exists in the checkpoint crate
with tests covering traversal and home-directory escape; it is lifted rather than rewritten. The
existing test asserting absolute-path pass-through is deleted, because it asserts the defect.

The edit tool's per-file lock is re-keyed on the canonical path the guard produces. Today the lock
is keyed on the raw resolved path, so the same file reached three ways takes three different
mutexes. The lock map also gains eviction; it currently grows for the process lifetime.

Containment is advisory with respect to the shell — it binds tools that take paths. Shell commands
are bound by the sandbox, not by this. That distinction is in the glossary and must stay visible in
the UI.

### D3 — The read registry: staleness and read-before-edit in one mechanism

The guard records, per canonical path, the modification time and content hash observed whenever a
tool reads a file. A write-class tool consults that record before executing:

- **No record** → the file was never read this session. The edit is refused with an instruction to
  read first. This is the read-before-edit precondition, and because the guard sees every call, it
  works in the shell-first tier as well — a shell read that names a path registers it. That closes
  the gap left open in the harness spec, which assumed the precondition without saying how it worked
  when reads go through the shell.

  **The shell half was not built until later, and a test hid that.** `candidate_paths` looked only at
  declared path fields, so no shell command ever registered anything; the test asserting otherwise
  called `record_read` directly and proved only that the registry works. It surfaced when containing
  patch paths made the precondition reachable in the shell-first tier for the first time — and
  nothing in that tier could satisfy it, so its only structured editor was refused forever. Shell
  reads now register through `classify::read_paths`, which yields the file-like arguments of a
  command *only* when the whole command tokenises and classifies read-only. A write can therefore
  never vouch for its own freshness, and an unparseable command registers nothing: the failure mode
  is an unrecorded read costing one extra call, never a write wrongly believed to be fresh. The
  residual imprecision — a non-numeric flag value reaching the list — is asserted in
  `classify.rs` rather than hidden, and costs nothing because the guard registers only paths that
  resolve to a real file inside the workspace.
- **Record present and stale** → the file changed since the model read it. The edit is refused with
  the reason, so the model re-reads rather than clobbering the user's concurrent change.
- **Record present and fresh** → proceed.

**Repeat reads (as built).** The same data answers a third question the spec did not ask: a `Read`
whose tool, canonical path and range were already answered, of a file that still matches what it
looked like then, would return byte-identical output. It is answered with a stub naming the ways
forward — `offset`/`limit` for a different part, `Grep` to search, `Edit` to change it — instead of
the file. This is the largest single source of wasted context in a long turn: a 2000-line file costs
roughly 24k tokens per read, and nothing stopped the same file being read six times.

Two boundaries make it safe. The answered-reads record carries its **own** snapshot rather than
consulting the read registry, because a write refreshes the registry — a read taken after an edit
would otherwise look unchanged and hide the model's own change from it. And only `Read` is
short-circuited: `Grep` and `List` return a fraction of a file each, so suppressing them would trade
few tokens for a model confused about why its search returned nothing new.

The precondition is enforced **before execution**, not after. Today the equivalent guard lives in the
turn runner and fires after the write has landed, so the model is told the edit was rejected while the
file on disk says otherwise.

### D4 — Atomic writes

Every tool that writes a file writes to a temporary file in the same directory and renames over the
target. This covers the edit tool, the whole-file write tool, the multi-edit tool, and the patch tool.
Direct writes to a target path are prohibited.

### D5 — Bounded memory

No tool loads an entire file or an entire command output into memory before applying a cap.

The read tool streams and counts lines, seeking to the requested offset, and stops once the line
limit or byte budget is reached. It reads bytes and decodes strictly, reporting an encoding error
rather than substituting replacement characters — invalid content the model might write back is
worse than a clear failure.

The shell tool applies its cap while draining, using a streaming head-and-tail ring rather than
reading the completed output file and trimming afterwards.

### D6 — Truncation, rewritten

Output capping keeps **head and tail** in a fifty-fifty split with an explicit marker naming the
number of omitted bytes, respecting character boundaries. Reported totals are the **true** pre-cap
figures. Where a cap applies at more than one layer, each layer's omission is stated separately, so
a large output can never present as a small one.

The full output spills to a session-scoped directory **inside the workspace**, so the gate permits
the model to read it. Spill files are written asynchronously and removed at session end. Today the
spill path is a system temp directory, which containment would deny, and nothing is ever cleaned up.

Standard output and standard error stay chronologically interleaved, as they are today. This is
deliberate and differs from Codex, which concatenates one after the other and loses the ordering
that makes build output readable.

### D7 — Argument coercion moves to dispatch

Unwrapping double-encoded arguments, renaming aliased fields, and stripping fully-enclosing code
fences move from individual tools into one pass in the guard, driven by each tool's declared schema
plus a shared alias table. SDK and MCP tools receive the same treatment; today they receive none.
Decode failures continue to return a concrete example of a valid argument object rather than a raw
deserialisation error.

### D8 — Classification may skip a prompt; it may never block

The SDK's existing risk classifier is **not** adopted. It performs substring matching on a lowercased
command with no parsing; its Critical tier is an unappealable block containing the token `fork`, which
would hard-block forking a repository or building a feature of that name; it misses spaced and
long-form variants of the destructive command it exists to catch; and substring collisions in its
low-risk list mis-tier common commands. It has no call sites today and gains none.

The replacement follows the structure Codex uses, which is sound even though its rule content is thin:

- Commands are **parsed**, not string-matched.
- A **small whitelist** of read-only commands may skip the prompt. Any redirect, subshell, command
  substitution, backtick, glob, or unparseable construct **fails closed** — not safe, therefore prompt.
- The dangerous-pattern list exists only to *force* a prompt that the cache cannot suppress. It never
  produces a block.
- **The sandbox is the boundary.** A classifier decides how often the user is interrupted; it is not
  a security control, and no `Forbidden` outcome may originate from pattern matching.

### D9 — The replacer stays, and gains one strategy

The nine-strategy replacer is retained. Compared against Codex's four-tier matcher it is better on
the axes that matter: it refuses ambiguous matches where Codex silently takes the first, it refuses
disproportionate matches where Codex has no such guard, it handles literal escapes, and its failure
messages show real file content where Codex's echo the failed pattern with no context. The earlier
recommendation to adopt Codex's matcher is withdrawn.

One addition: a normalisation strategy folding typographic punctuation before comparison — the dash
range, curly single and double quotes, and non-breaking and exotic spaces, each to their ASCII
equivalent. A model emitting a smart quote against an ASCII file currently fails all nine strategies.

One behavioural fix: a candidate rejected as disproportionate currently aborts the whole ladder. It
should reject that candidate and continue, so a later strategy can still succeed.

### D10 — Two new tools

**Persistent terminal.** Two tool surfaces rather than one with a mode flag: one that starts a
command and returns a session identifier if the process is still alive at the yield deadline, and
one that writes to an existing session and returns recent output, where an empty write polls without
sending anything. Sessions are held in a bounded store with a soft cap; the most recently used are
protected from eviction; already-exited processes are evicted before live ones; a session holding an
active interaction is never evicted. Output uses a streaming head-and-tail ring. Timeouts are
per-call, not per-session — a process outlives the call that started it and ends on its own exit,
eviction, or session teardown. Terminal allocation defaults **on**, unlike Codex, where the default
is off and consequently writes to the session are rejected; interactivity is the reason this tool
exists. The terminal library is already a dependency of another crate and is not currently exposed
to the agent.

**Image view.** Gated on the model's declared input modalities, so it is absent from the tool list
rather than failing at call time. Validation is a full decode — the cheapest way to keep non-images
out. Returned inline as image content, not as a file reference. Redacted in logs by byte count.
Errors are recoverable and returned to the model rather than aborting the turn.

### D11 — No silent failures

Every `unwrap_or_default` that converts a failure into plausible empty output is replaced with a real
error: the shell tool's output read, the directory walk's task result, and the read tool's decode.
This is the same invariant the retrieval plan states first, and the same class as the turn events
currently swallowed by a catch-all arm.

### D12 — Structured diffs are emitted

The edit tool already computes a real before-and-after and formats it into a display string. It will
additionally emit the structured pair, and the session layer will stop flattening structured diff
content down to a path. Without both halves, file-change accounting reads zero with nothing erroring.

### D13 — Tool tiers

The registry emits one list selected by tier, plus a searchable tail held out of the default set
because a long visible list degrades tool selection and that harms weaker models most.

- **Shell-first** — shell, persistent terminal, patch apply, image view, web fetch, web search,
  skill, plan, memory search, MCP tools.
- **Structured** — the above *minus patch apply*, plus read, edit, list, grep, glob, write.
- **Deferred** — notebook edit, code search, third-party search.
- **Platform-gated** — the Windows shell tool.

**One way to change a file (as built).** `Edit`, `MultiEdit`, `ApplyPatch` and `Write` were four
overlapping ways to do the same thing: 715 tokens of schema in every request, and four chances for a
weak model to choose wrong. `MultiEdit`'s schema was `Edit`'s with an array around it, so it folded
into `Edit` as an optional `edits` field — applied in order, written only if every one succeeds, and
now inheriting the ten-strategy replacer, the atomic write and the structured diff that the SDK's
version had none of. `ApplyPatch` is registered only in the shell-first tier, where it is the one way
to change a file without hand-composing shell redirection; in the structured tier `Edit` and `Write`
cover its ground with better errors. This mirrors Codex, whose entire file-mutation surface is a
single `apply_patch` covering create, update, delete and move for ~171 tokens.

Dropping it from the structured tier also closed a containment hole. The guard extracted patch paths
using the *Codex* dialect (`*** Add File:`) while the registered tool parses **unified diff**, so it
found no paths at all — which reads to the rest of the gate as "this call touches nothing": no
containment, no freshness check, and one shared approval key for every patch. A unified diff could
write anywhere on disk. `patch_paths` now understands both dialects, and takes the unified-diff write target from the `+++`
side with only `b/` stripped — exactly what the applier does, so containment checks the path the tool
will actually write to. `a_patch_cannot_write_outside_the_workspace` is the regression test, and it
fails against the previous commit.

The reach of this is bounded and worth stating: patch bodies are parsed for tools *named* like a
patch tool, so an MCP patch tool under some other name still contributes no paths, and a git patch
that names its files only in a `diff --git`/`rename from` header yields none either. Story 9 is
partial. Two things about the SDK's applier are worth recording while they are true: it never
compares the context lines it is given — it splices by line number — so a stale patch corrupts
silently rather than failing, which is why read-before-edit is load-bearing for it; and its
description tells the model it "supports … deleting files" when it contains no delete path at all.

**A context budget, enforced by a test (as built).** The tool list is re-sent on every request of
every turn, so its size is multiplied by the number of tool calls a turn makes. Measured on one
basis throughout — the env-gated third-party search tool excluded, since its cost is opt-in — it
reached 10,626 bytes across 16 tools with nobody watching, and folding the overlapping edit tools
together took it to 8,593 across 14. Counting the branch as a whole, including the search-tool
gating above, a request that carried 12,213 bytes across 17 tools now carries 8,593 across 14.

`the_tool_list_stays_within_its_context_budget` fails when the list grows, and names the largest
tools when it does — so the cost of a new tool is argued for in review rather than appearing
silently in every user's context window.

**Registration gating (as built).** The deferred tier does not exist yet, so its three tools sit in
the structured tier — but a tool that *cannot run* is registered nowhere. The tool list is re-sent on
every request of every turn, so a schema nobody can use is charged to the user once per model call:
across a sixteen-call turn the third-party search tool alone was ~6k tokens for a tool that errors
without an API key. It is now present only when its key is set, which takes the structured tier from
~3,050 to ~2,650 tokens per request for everyone who has not set one. Code search stays
unconditional: it is BM25 over the working tree — no index, no key, no network — and returns ranked
snippets with line numbers, so it often answers what would otherwise cost a whole-file read. The
Windows shell tool is `cfg`-gated rather than registered everywhere, and the image tool is absent for
a model that cannot accept images.

Tier assignment per model comes from the evaluation matrix defined in the harness spec. Until that
exists the default is the structured tier, because over-provisioning tools degrades gracefully and
under-provisioning does not.

---

## Testing Decisions

**What makes a good test here.** Tests assert externally observable behaviour: the decision the guard
returns, the bytes a tool produces, the state of a file on disk afterwards. They do not assert that a
helper was called or that a struct has a given shape. Two of the three highest-value targets are
already pure functions, which is why this spec adds only one seam.

**The guard — table-driven, pure, no I/O beyond a temp root.** This is the highest-value test surface
in the spec. Cases: absolute path outside the root denied; traversal collapsed and denied; symlink
escaping the root denied; path inside the root allowed; write with no read record refused; write
against a stale record refused with the reason; write against a fresh record allowed; whitelisted
read-only command skips the prompt; a command with a redirect or subshell fails the parse and prompts;
no input produces a block; cache hit suppresses a repeat prompt; a destructive command prompts despite
a cache hit; an escalation grant is not written to the cache; each enforcement tier yields the expected
decision for the same input.

**The replacer — extend the existing suite.** It already has strategy-level tests. Add: typographic
punctuation folding matches an ASCII file; a disproportionate candidate does not abort the ladder when
a later strategy would succeed; ambiguous match still refused after the new strategy is added.

**Truncation — pure function.** Head and tail both retained; marker states the true omitted count;
totals reported are pre-cap; character boundaries respected at both cut points; spill path is inside
the workspace; spill file removed on cleanup.

**Tool-level — extend the existing pattern.** The current tool tests use a temporary directory and a
throwaway context, and are a good model. Two changes: the throwaway context currently uses a
permit-everything policy, so a variant carrying a real policy is added and the containment and
freshness cases run through it; and each fixed defect gets a regression test — atomic write survives
a simulated interruption, a stale file is refused, an I/O failure surfaces as an error rather than
empty output, a large file is paginated without a full read.

**Persistent terminal — lifecycle.** A session survives across calls; an empty write polls without
sending; output is delivered incrementally and not re-delivered; the store evicts an exited session
before a live one; the most recent sessions are protected; teardown terminates everything.

**Prior art in this repository.** The read and edit test modules are the model for tool tests. The
session actor's async suite, including its paused-clock tests, is the model for anything with a
deadline. The checkpoint crate's path-resolution tests are the model for containment cases and are
the source of the algorithm. The capability tripwire test that asserts Atlas's tools out-perform their
SDK equivalents is retained and extended to cover the new strategy.

---

## Out of Scope

- **The wire adapter and multi-provider support.** Covered by the harness spec; independent of this work.
- **Linux and Windows sandboxing.** Both land on the containment-and-approvals tier. Packaging and
  dependency-weight problems respectively.
- **Adopting Codex's patch matcher.** Explicitly rejected in D9 on evidence.
- **Adopting the Starlark policy engine.** Ships no rules; embeds an interpreter for nothing.
- **Adopting the SDK's risk classifier.** Explicitly rejected in D8.
- **Retrieval tooling.** Gated on its own telemetry. Note the overlap: containment changes what the
  shell fallback can reach, which the retrieval plan's bottom tier depends on.
- **Turn-level fixes** — supersede, deadlines, crash recovery, event accounting. Harness spec.
- **Replacing the engine.** Settled in ADR-0002.

---

## Further Notes

**On the reports that started this.** The public issue tracker contains no report of a tool failing;
its themes are engine selection, cryptic error presentation, and UI polish. That absence is not
evidence the reports are wrong — it is evidence they arrive through another channel. What the source
reading establishes is that several defects would reach a user *as* "the tools don't work" while being
nothing of the kind: an edit reported as rejected after the write landed, an approval control that
silently does nothing, output whose failing half was discarded, and a directory walk that reports
"no files found" when it panicked. Fixing those is the fastest route to finding out what remains.

**Sequencing (as built).** Containment, canonicalisation, the read registry, atomic writes, and the
silent-failure purge came first. They are roughly three hundred and fifty lines, need no new dependencies, and each
one fixes a defect that is live today. Truncation and streaming caps follow. The two new tools and the
tier split come last, because they are additive and nothing currently depends on them.

**A note on what not to change.** The replacer's strategy ladder, the corrective error strings, the
BOM and line-ending handling, the process-group kill, the file-backed output capture that avoids pipe
deadlock, and the treatment of a non-zero exit with output as a success are all correct and hard-won.
Several are better than the equivalent in the harness this project considered porting. This spec is a
durability layer beneath them, not a rewrite of them.

**Telemetry.** One structured record per tool call — tool name, tier, outcome, latency. No arguments,
no paths, no content. Emitted through `tracing` under the `atlas::tool_call` target, so it is a local
trace rather than anything that leaves the machine; `TELEMETRY.md` covers what does. It is what
converts the next round of reports into something specific.

**What landed differently from the spec, and why.**

* *D6, the string-in/string-out capper.* The spec describes capping as a function over a
  finished string. As built there is only the streaming ring: capping has to happen
  *while* output arrives, or the gigabyte has already been allocated by the time anyone
  decides to discard it. A string variant was written, had no production caller, and was
  removed.
* *D1, per-tool coercion constants.* "Existing per-tool coercion constants … are removed
  in favour of the guard." The constants are gone — there is one table and one function —
  but Atlas-owned tools still *call* that function themselves. It is idempotent, and it
  keeps a tool invoked directly (a test, a benchmark, the offline eval) behaving the way
  it does in a session.
* *D5, the shell's capture file.* The spec has the full output spill inside the workspace. As built,
  the **live** capture file is in the system temp directory and only a **capped** run copies a
  retained version into the workspace. Writing a file into the workspace on every shell call —
  including the overwhelming majority that are never truncated — would churn the user's `git status`
  and every file watcher pointed at their project. Story 14 still holds: the path the truncation
  notice names is inside the workspace and the gate permits reading it.
* *D10, image validation.* The spec says a full decode. As built it is container-header sniffing.
  A full decode additionally catches a *corrupt* image, which the provider rejects anyway, and it
  would cost an image-decoding crate and its dependency tree for a validity check — the same
  dependency-weight argument ADR-0001 makes. Header sniffing catches what actually happens: a model
  passing a `.rs` file, or a `.png` that is really HTML.
* *D3, the freshness record.* The spec says modification time **and content hash**. As built it is
  modification time and length. On every filesystem Atlas ships to, `mtime` has nanosecond
  granularity, so the case a hash would additionally catch — a same-length rewrite inside one clock
  tick — does not arise, and hashing would cost a second full read of every file on the hot path.
* *D12 needed a vendored patch.* `ToolEnd` did not carry `ToolResult::metadata`, so a tool's
  structured half was discarded at the event boundary regardless of what the tool computed. The
  patch is recorded as `tool-result-metadata-v1` with a compile-time guard, per the harness spec's
  vendor-hygiene discipline. The same patch is what lets the image tool return image content at all.
