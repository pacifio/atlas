# Atlas — Context

Glossary of domain terms as this project uses them. Decisions with lasting consequences live in `docs/adr/`.

## Session history domain

- **Thread** — one conversation as Atlas tracks it, keyed by an app-minted thread id. A thread exists independently of any agent process.
- **Draft** — a thread before its first sent message. Its ACP session id is never recorded, because the session is re-created whenever the chat is reopened and the id would be stale. A draft is visible while its chat is open and is removed when the chat closes unsent, so abandoned chats leave no history. *(Divergence from Zed, and from this ADR's original wording "drafts never create agent sessions": Atlas's chat panel opens an agent session when the tab mounts, so a draft usually does have a live session — just not a recorded one. Making that lazy is a chat-panel change, not a history one.)*
- **Session** — the agent-side conversation, identified by an ACP session id. A thread references at most one session.
- **Thread-metadata store** — the app-level SQLite store that is the *only* source for the session sidebar and history. Holds metadata only (ids, agent, titles, timestamps, worktree paths, archived flag) — never transcript content. See ADR-0001.
- **Archive** — a first-class thread state: out of the active sidebar, kept in history. Opening an archived thread unarchives it. Imported threads land archived.
- **Live thread feed** — the path that keeps a thread's store row current from the running conversation's own events (`ThreadRecorder`). The only writer besides import. Distinct from the *capture recorder* (`atlas-checkpoint`), which records the transcript and the usage.
- **Import** — user-initiated pull of an agent's sessions into the store via ACP `session/list`; metadata only; capability-gated; deduped by session id.
- **Backfill** — the one-time automatic import pass per installed agent on first launch after the history model shipped.
- **Resume** — turning a history row into a live session through the protocol: `session/load` (replays transcript) or `session/resume` (no replay, user notified), selected by advertised capability.
- **Capability gating** — every per-agent behavior is decided by the capabilities the agent advertised at `initialize`; agent-identity checks are forbidden. ("No ACP agent gets special treatment.")
- **Atlas-recorded usage** — the token totals Atlas's capture recorder wrote for a session (`atlas-checkpoint`), priced from the models.dev map Atlas caches. The only source for the usage widget, the usage panel and Mission Control; covers sessions run through Atlas and no others.
- **Turn / message** — a *turn* is one prompt and the answer to it; a *message* is one user or assistant row within it. Usage surfaces count messages, because that is what Atlas records per session.
- **Scrape readers** *(deleted)* — the per-agent readers of CLI private storage that used to build session history: Claude's `~/.claude/projects` JSONL, Kilo's SQLite, Codex's state DB, the Claude-directory watcher, and the JSONL replay behind the fast transcript paint. All gone; do not reintroduce. Reads of those directories that deliberately remain, none of them session history:
  - the **checkpoint importer**, whose contract is preserved verbatim;
  - the **memory corpus** and **skills** surfaces, which read instruction files (`CLAUDE.md`, `AGENTS.md`, skills, per-project memory notes) as documents;
  - the Memory panel's **Codex thread list**, which still queries `~/.codex/state_*.sqlite`. This one is a genuine exception rather than a category difference — it is a session list, read from another program's database, rendered as UI. It survived the history port because it belongs to the Memory panel rather than to the ACP stack. Flagged, not endorsed.

## Adjacent subsystems

- **Atlas Agent** — the native agent: the single first-party agent that ships with Atlas rather than being installed from the Marketplace. Its engine is a one-time port of Codex that lives in this repo and is maintained by us (ADR-0003). Exactly one native agent exists at a time; every other agent is an ACP agent. "Native agent" and "Atlas Agent" are synonyms from cutover onward. Its threads live in the same thread-metadata store as external agents', distinguished only by agent id — and that stored agent id remains the literal string `"cersei"`: it is a **storage key**, not a name. Every recorded thread resolves through it, so it was deliberately kept stable across the engine swap and outlived the retirement of the name it came from. Changing it is a data migration, not a rename.
- **Timeline / checkpoint** — the per-workspace observational record (`atlas-checkpoint`). Separate from the thread-metadata store; its importer may read CLIs' transcript files under its own contract, which the history model explicitly preserves.
- **Marketplace / registry** — where agents are installed from; the installed-agents map is what import enumerates.
- **Installed-agents map** — the one record of which ACP agents exist. Installing writes an entry, uninstalling removes it, and nothing else makes an agent runnable. A fresh install has an empty map and offers only the native agent. See ADR-0002.
- **Detection** — an agent found on the user's `PATH` that Atlas has *not* installed. An offer, never a spawn candidate: **accepting a detection** is a user action that writes an installed-agents-map entry pointing at their own binary, downloading nothing. Finding a binary installs nothing by itself.

## Talking to a model (Atlas Agent)

- **Atlas gateway** — Atlas's own LLM broker (`docs/reference/atlas-ai-api.md`), an
  OpenAI-Chat-Completions-compatible front door to Google Vertex. It is the *only* provider the
  native agent talks to: it holds the provider credentials, meters usage, and enforces the spend
  cap, so no provider key is ever on the device. Not to be confused with **BYOK**, which is a
  user's own key for a *non-native* agent and is untouched by any of this.
- **Wire dialect** — the request-and-response grammar a provider speaks. The engine was forked
  speaking exactly one, the **Responses** dialect; the port authors a second, **Chat Completions**
  against the gateway contract (`codex_api::atlas_chat`, spec D3). The two share the engine's
  internal item and event vocabulary and nothing below it — different route, different body,
  different stream grammar, different error table. A green suite on one says nothing about the
  other.
- **Spend cap** — the ceiling on what an account may spend, denominated in weighted tokens and
  reserved *before* the provider is called. A filled cap answers `402`, deliberately not `429`,
  because stock SDKs auto-retry `429` and a monthly ceiling cannot clear for weeks.
- **Disposition** — what the client should do about a gateway error, as decided from its status
  and `error.code` (`codex_api::atlas_gateway`, spec D13): stop, wait a stated interval, refresh
  the credential and try once, or retry cautiously. Deliberately not a boolean — "retryable"
  collapses three behaviours the gateway keeps apart.

## Vendored engine licensing (Apache-2.0)

`vendor/codex/` is a hard fork of OpenAI Codex under **Apache-2.0** (ADR-0003). Atlas's own
code is **MIT** (`LICENSE`). The two do not merge: Apache-2.0 code stays Apache-2.0 however it
is bundled, so its obligations travel with every build rather than being absorbed by Atlas's
licence. `tests/vendor-licensing.test.ts` enforces what follows; **D11 blocks all rename work
until it is green**, because doing the attribution first makes every later rename commit
trivially compliant.

- **Ship the licence and the notice (§4(a), §4(d)).** `vendor/codex/LICENSE` and
  `vendor/codex/NOTICE` are bundled into the app at `Contents/Resources/licenses/`, alongside
  Atlas's own. The obligation runs to *recipients*, so a file that only exists in the repo does
  not discharge it. The NOTICE keeps its Ratatui lines even though the TUI is dropped — §4(d)
  would permit removing them, simplicity favours leaving them — and travels **verbatim**,
  including the U+00A0 non-breaking spaces upstream put in it.

- **Mark what you changed (§4(b)).** Every vendored file Atlas modifies carries this line, first
  line of the file, before any module docs:

  ```
  // Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
  ```

  `<!-- … -->` in Markdown; a root `"$comment"` in JSON. Add it in the same commit as the edit —
  the test computes the modified set from git, so it notices on the next run either way.
  *(Caveat: `core/config.schema.json` is generated by schemars, and regenerating it drops the
  `$comment`. Re-add it if that ever happens.)*

- **Never strip attribution (§4(c)).** Copyright and attribution notices inside vendored sources
  are **not** touched by rename sweeps. The rule is: rename product branding, keep attribution.
  The Phase 5 sweep is exactly the operation that would violate this, which is why the rule is
  written down before that sweep runs.

- **Trademarks are a removal, not a preference (§6).** Apache-2.0 grants no trademark licence, so
  the rebrand *must* drop "Codex" and "OpenAI" as product-facing names — including the baked
  system prompt and the catalog `instructions_template` strings that self-identify as Codex.
  Required by the licence, not merely by taste. **Done (#55).** Two prompts reach a shipped
  turn — `models-manager/prompt.md` and `protocol/src/prompts/base_instructions/default.md` —
  and both now say Atlas Agent. Their §4(b) notices are HTML comments on line 1, **stripped when
  the file is read**: the notice must be in the file, and must not be in the model'''s context.
  The model-specific GPT-5 prompts under `core/` are left untouched: Atlas'''s catalogue serves
  no GPT-5 row, so they reach no user-facing surface, and §4(c) says leave what you do not need
  to change.

- **Atlas may claim its own modifications (§4).** Permitted, and it is not the same act as
  stripping upstream's — an added Atlas copyright line sits beside upstream's, never replacing
  it.
