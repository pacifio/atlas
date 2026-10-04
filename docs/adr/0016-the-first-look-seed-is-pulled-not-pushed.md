# ADR-0016: The first-look code seed is a tool the agent pulls, not context Atlas pushes

**Status:** Accepted (2026-10-04). Phase 4 of `docs/superpowers/plans/2026-10-03-codeindex-search/`.

**For agents:** if an agent starts a code task without looking at the repository first, look at the code tool server's `task_context` tool and its instructions (`src-tauri/src/commands/code_index/semantic_tools.rs`, `code_server/tools.rs` `INSTRUCTIONS`), not at `agents_send`. Nothing is prepended to a prompt.

## Context

The retrieval research behind the code index (`docs/research/codeindex-search/06-agentic-retrieval-literature.md` §2.3) has one result that bears directly on how an agent should start a task. On Agent Retrieval Bench, seeding the agent's first turn with a few fused top hits raised the share of runs that reached a gold file from 51% to 80%, and moved the first gold hit from step 3 to step 1 (RRF seeds; lexical seeds gave about the same gain). The same report recommends a small personalized repository map beside those hits.

The obvious way to use that result is to push: compose a repo map and the top hits for the user's request and prepend them to the first prompt. ADR-0010 removed exactly that kind of push for memory, for reasons that apply here too:
- a push has to guess what a turn needs, and pays its cost on every send, including chat-only turns that need no code;
- it moves slash commands off byte 0 unless special-cased;
- it echoes Atlas's own text back through agents' transcripts.

The research also warns against deciding "nothing relevant" from a raw score threshold, which is what an automatic push would have to do to skip trivial turns.

## Decision

**The seed is a tool: `task_context(task, files?)` on `atlas_code`.** It returns a repo map personalized to the identifiers and files the task names, then the top five `semantic_search` hits for the task, within one output budget split between the two. It works without an embedding model (keyword + symbol search) and says so.

**The agent decides when to call it.** The server instructions recommend it "once at the start of an unfamiliar task", and its description says to skip it for questions that need no code. That is Repoformer-style self-selective retrieval: the model, not a score threshold, decides whether a first look is worth its tokens.

**Nothing is injected into prompts.** `task_context` stays code-only. The session handoff (what the last agent did) is memory's `memory_briefing`, so the two never duplicate each other.

## Consequences

- Cheap to ignore: an agent that does not call it pays only the tool's schema in its fixed prefix.
- An agent that never calls tools gets no seed. This is the same accepted trade-off as ADR-0010.
- Measurable: the Phase 4 evaluation harness (`crates/atlas-codeindex/examples/eval_retrieval.rs`) measures the retrieval underneath, and a `+seed` ablation of agent runs can compare sessions with and without the call.
- Reversed if agents systematically skip the tool on tasks where it would have helped. A push would then need a gate that is not a score threshold.
