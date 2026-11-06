# ADR-0021: The code index is removed; code search stays, on demand only

**Status:** Accepted (2026-10-15). Supersedes ADR-0015's index half and ADR-0016 in full.

**For agents:** `atlas_code` exists and serves exactly two tools, `grep` and `find_files`. There is
no `find_symbol`, `outline`, `read_symbol`, `related`, `impact_of_diff`, `repo_map`,
`semantic_search` or `task_context`, and no `codebase_index_*` command. Nothing in Atlas indexes a
repository. If you are looking for the symbol table, it is gone — read the files.

## Context

ADR-0015 gave agents a search tool and, with it, a per-project code index: tree-sitter extraction
into SQLite, a symbol table, a reference graph, chunk embeddings behind a 95 MB on-device model, and
a trigram prefilter over the git HEAD tree with a working-tree overlay. ADR-0016 added
`task_context`, which pulls a seed from that index at the start of a task.

The index was correct and it was fast per query. The cost was not in the queries — it was in
keeping it true:

- **It rebuilt on every change.** The file watcher forwarded every surviving debounce batch into the
  index worker; the git watcher reconciled the whole project on any HEAD, index or ref move; and the
  frontend fired a full `codebase_index_build` four seconds after *every agent turn, for every
  agent*. On a repository this size an ordinary editing session meant near-continuous tree-sitter
  parsing, SQLite writes and embedding work behind the UI.
- **Nothing the user did made it stop.** The watchers fed it whether or not any agent ever called a
  code tool, and the only switch — "Let agents search code with Atlas" — gated the tools, not the
  indexing.
- **It pulled a second embedding model in.** Memory already ships one; the index wanted its own
  (95 MB, or 522 MB for the larger choice), with a composer strip asking the user to download it.

The benefit was a better first search. The cost was paid continuously, by every user, on every
keystroke-sized change, whether or not anyone searched.

## Decision

**The index goes; the search engine stays.** `crates/atlas-codeindex` and `crates/atlas-grepindex`
are deleted, as is `src-tauri/src/commands/code_index/`. `crates/atlas-search` — on-demand grep and
file-find, no persistence, no watcher, nothing resident — is untouched and still backs:

- `atlas_code`'s `grep` and `find_files` for agents, and
- the project search overlay (`code_grep`), the user's own Cmd+Shift+F.

**Everything that only existed to feed or read the index goes with it:** both watcher feeds, the
after-every-turn rebuild, the composer's index pill and its "Enable semantic search" strip, the two
code-embedding models and the `codeEmbeddingModelId` setting, and the `@symbol` mention kind, whose
only source was the symbol table.

**Memory keeps its own retrieval.** `atlas-embed` and `atlas-retrieval` were shared; they stay, and
memory's embedding model is untouched. What changes is ADR-0018's symbol relocation: a cited symbol
that moved was found through the index when one was open, and is now found by the same-length window
search of the file that ADR-0018 already specified as the fallback.

## Consequences

- Nothing is parsed, embedded or written to disk in response to a file change. The watchers still
  drive the explorer and git; they no longer drive an indexer.
- Agents search by reading, as every coding agent outside Atlas already does. `grep` and
  `find_files` are the tools; they cost nothing between calls.
- An agent that relied on `semantic_search` for a plain-English question now has to grep. That is
  the trade this ADR accepts: a worse first search, in exchange for an app that is idle when the
  user is idle.
- `.atlasignore` is gone — it configured the index's skips and nothing else reads it.
- A prompt saved before this change may still contain an `@symbol:` mention. It deserializes and
  renders as a chip; it is just no longer offered in the picker.
