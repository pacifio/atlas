# ADR-0018: A memory is used only as far as its evidence holds

**Status:** Accepted (2026-10-07). Milestone M3 of `docs/superpowers/plans/2026-10-03-memory-system/`.

**For agents:** if you are changing how a memory's validity is decided, read `crates/atlas-memory/src/citation.rs` (`cite`, `validate`, `ValidationCache`, `work_validity`), `src-tauri/src/commands/memory_capture.rs` (`work_evidence`) and `check_entries` in `src-tauri/src/commands/memory_server/tools.rs` first.

## Context

A memory says something about the code ("access tokens live 15 minutes", "auth signs with EdDSA"). The code moves on and the memory does not. Loaded as true, a stale memory is worse than none: the agent skips the check it would otherwise have made.

- GitHub Copilot Memory stores a citation with each memory and checks it against the current branch before the memory is used.
- VibeMemBench's runs found that memory which is never validated does not help coding agents, and memory-poisoning results show that an unchecked memory is also an attack surface.
- The Agent Memory Repo spec and Devin's memory carry a `source` (the session) on every entry but no evidence in the code, and check their sources only in a periodic "dreaming" pass. Between passes a memory the code no longer supports is still loaded as true.

Most memories cite no code: the extractor can't cite, and agents often don't. When the session recorder (`atlas-checkpoint`) captured the writing session, it knows which files that turn wrote (with a line fingerprint taken at write time) and which commits carried them.

## Decision

- **Citations are server-hashed.** `memory_remember` takes `evidence: [{path, lines, symbol?}]`. The server reads the lines from disk, refuses a path outside the scope root or a missing file, and stores the hash. An agent never supplies a hash. At most 8 citations, 200 lines each.
- **Every read checks.** `memory_get`, `memory_list`, `memory_search`, `memory_briefing` and the `memory_remember` result carry `validity` (`valid`, `moved`, `stale`, `unverifiable`) and the citations as found now. A citation is `valid` when the exact lines still hash the same, `moved` when the symbol's current span (through the open code index) or any same-length window of the file does, and `stale` otherwise. A file too large, binary or unreadable is `unverifiable`.
- **Stale memories leave the briefing and sink in search.** The briefing counts them in `staleHidden`; search keeps them after every memory that holds.
- **Commit evidence for uncited memories.** A decision, fact or architecture note with no citation is matched to the recorded turn it was written in. If that turn's files reached a commit, the memory carries `commits` and a validity from whether the files still hold the agent's work (the link rule's 50 % line containment), with `validityFrom: "commits"`. It is stale only when every landed file lost that work. A commit being orphaned (a squash merge) decides nothing. Citations, when present, decide alone.
- **Expiry.** A health pass archives a candidate nobody wrote or used for 28 days, and an active memory unused for 28 days only when its citations are stale. An active memory without citations never expires on time alone.

## Consequences

- Reads stay cheap: results are cached by file size and mtime, commit evidence is checked for at most 300 entries per read, and both caches are bounded.
- Extracted and captured memories have no citations; they get commit evidence when capture recorded the session, and nothing otherwise.
- A moved symbol is found by a same-length window search of the file. (Until ADR-0021 an open code index found it first; that path is gone, and this fallback is now the only one.)
- Commit evidence is computed at read time and stored nowhere: a rebase that re-points a commit, or a capture store that is deleted, changes the answer without a migration.
- Archiving is a revision (ADR-0017), so a restatement by another session revives an archived memory.
