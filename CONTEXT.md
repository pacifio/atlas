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
- **Atlas-recorded usage** — the token totals Atlas's capture recorder wrote for a session (`atlas-checkpoint`), priced from the models.dev map Atlas caches. The only source for the usage widget and the Usage tab; covers sessions run through Atlas and no others.
- **Turn / message** — a *turn* is one prompt and the answer to it; a *message* is one user or assistant row within it. Usage surfaces count messages, because that is what Atlas records per session.
- **Scrape readers** *(deleted)* — the per-agent readers of CLI private storage that used to build session history: Claude's `~/.claude/projects` JSONL, Kilo's SQLite, Codex's state DB, the Claude-directory watcher, and the JSONL replay behind the fast transcript paint. All gone; do not reintroduce. Reads of those directories that deliberately remain, none of them session history:
  - the **checkpoint importer**, whose contract is preserved verbatim;
  - the **memory corpus** and **skills** surfaces, which read instruction files (`CLAUDE.md`, `AGENTS.md`, skills, per-project memory notes) as documents;
  - the Memory panel's **Codex thread list**, which still queries `~/.codex/state_*.sqlite`. This one is a genuine exception rather than a category difference — it is a session list, read from another program's database, rendered as UI. It survived the history port because it belongs to the Memory panel rather than to the ACP stack. Flagged, not endorsed.

## Adjacent subsystems

- **Project** — a folder opened in Atlas, tagged to an organisation and shown in the sidebar. The unit almost everything else is scoped to: the editor state, the file index, the git watcher, the knowledge base, the capture store. *Avoid: workspace.* The stored names still say `workspace` — `state.json`'s `workspaces` / `activeWorkspaceId`, the `workspace_id` columns in `sessions.db`, the `workspaceId` argument of the fileindex / recent-files / git-watch / mention commands and the events that carry it, the `"workspace"` mention tag, and the `workspace.*` keybinding action ids. Those are **storage keys**, not the concept: renaming one is a data migration that breaks existing installs, not a rename. Every such site carries a comment saying so.
- **Atlas Agent** — the native agent: the single first-party agent that ships with Atlas rather than being installed from the Marketplace. Its engine is a one-time hard fork of an Apache-2.0 upstream that lives in this repo under `vendor/atlas-engine` and is maintained by us (ADR-0003, ADR-0011). Exactly one native agent exists at a time; every other agent is an ACP agent. "Native agent" and "Atlas Agent" are synonyms. Its threads live in the same thread-metadata store as external agents', distinguished only by agent id, and that stored agent id is the literal string `"atlas-agent"` (`ATLAS_AGENT_ID` in Rust, `NATIVE_AGENT_ID` in TypeScript): a **storage key** every recorded thread resolves through. It was renamed once (ADR-0011) and the rows under the retired id were dropped rather than aliased; changing it again is a data migration, not a rename.
- **Timeline / checkpoint** — the per-project observational record (`atlas-checkpoint`). Separate from the thread-metadata store; its importer may read CLIs' transcript files under its own contract, which the history model explicitly preserves.
- **Marketplace / registry** — where agents are installed from; the installed-agents map is what import enumerates.
- **Installed-agents map** — the one record of which ACP agents exist. Installing writes an entry, uninstalling removes it, and nothing else makes an agent runnable. A fresh install has an empty map and offers only the native agent. See ADR-0002.
- **Detection** — an agent found on the user's `PATH` that Atlas has *not* installed. An offer, never a spawn candidate: **accepting a detection** is a user action that writes an installed-agents-map entry pointing at their own binary, downloading nothing. Finding a binary installs nothing by itself.

## Shared memory domain

**Shared memory** is the one record every agent on a project reads and writes, native and ACP alike, so that a second agent inherits what the first learned. It is Atlas-owned; no agent's private store is shared memory. It holds exactly six kinds of entry (decided 2026-09-17):

- **Active plan** — the agent's own structured plan list. One per project; a newer plan replaces the older one, and a plan that is done or abandoned clears it.
- **Decision** — a choice made and why. Keyed; a newer decision with the same key replaces the older one. Shown capped; never evicted.
- **File changed** — one entry per path with a summary of what was done. A repeat edit to the same path replaces the earlier entry. Shown capped; never evicted.
- **Fact** — a durable project fact or convention. Shown capped; never evicted.
- **Failure** — a dead end or anti-pattern, kept so a second agent does not repeat it. Shown capped; never evicted.
- **Architecture** — a structural note about how the system fits together. Shown capped; never evicted.

The six kinds have two lifetimes. **Working memory** is Active plan and File changed: it describes the current stretch of work, replaces by key, is always shown to an agent fresh, and never ages or travels beyond the project. **Durable memory** is Decision, Fact, Failure and Architecture: it accumulates, stays true across sessions, is what agents search, and is what can be promoted beyond one project. Both are shared memory.

**Scope** of shared memory is the repository: every worktree and every subdirectory launch of one repository shares one memory. Outside a repository the scope is the directory the agent was started in.

Shared memory also records **session lifecycle** (session start and end, todo added and done, and which agent owns each session). Lifecycle is bookkeeping for the record, never something an agent is shown.

Terms that are *not* shared memory: **capture** (raw transcripts, see Timeline), **knowledge notes** (user-written pages in the Knowledge panel), the **codebase index** (derived from source), and any agent's own memory files (`CLAUDE.md`, `AGENTS.md`, Claude's auto-memory directory). These may be *sources* shared memory cites or imports, but an entry in them is not an entry in shared memory.

Shared memory reaches an agent one way only: it **pulls** it through the **memory tool server**, the in-process MCP server Atlas hands every session that can take it (ADR-0010). Nothing is prepended to a user's message; the text goes to the agent exactly as typed. The server's **instructions** are the protocol — read first, write as you learn — and its tools are, in that order: **`memory_briefing`** (the first look of a session: working memory, the **durable index**, the **curated pack** and the **recent-session handoff**), **`memory_changes`** (what *other* sessions recorded since this session's **last look**), **`memory_search`** (the record plus the codebase index's documents), **`memory_get`**, **`memory_list`**, **`memory_remember`** and **`memory_forget`**.

- The **durable index** is one capped line per durable entry, each kind's best up to its display cap, ranked by recency (two-week half-life), use count and confidence; `memory_get` expands a line. It lists shared-memory entries; it is not the codebase index, and not the retrieval index `memory_search` also searches.
- The **curated pack** is the high-signal part of the project's foreign memory files (Claude's memory directory, `CLAUDE.md`, `AGENTS.md`), recency-ranked and budget-bounded. The **recent-session handoff** is the tail of the most recent other session in the scope, whichever agent ran it, read from capture (or, where capture was never enabled, from Atlas's own session transcripts) — never from an agent's own files.
- A session's **last look** is the newest write it has seen, set by its briefing or its last changes call and forgotten when the session ends. It belongs to the session, not to the send path.

The **injected-context envelope** — `<atlas-memory>` … `</atlas-memory>` — is what Atlas *used to* prepend. Every Atlas reader still strips it (`atlas_agent_transcript::strip_injected_context`): the Claude memory directory, capture transcripts, the session handoff, the chat's echoed prompts. Files written while Atlas pushed still carry it, and the loop it once caused (an agent saved Atlas's block into its own memory file and Atlas read the copy back in as a new fact) must stay closed.

## Talking to a model (Atlas Agent)

- **Atlas gateway** — Atlas's own LLM broker (`docs/reference/atlas-ai-api.md`), an
  OpenAI-Chat-Completions-compatible front door to Google Vertex. It is the *only* provider the
  native agent talks to: it holds the provider credentials, meters usage, and enforces the spend
  cap, so no provider key is ever on the device. Not to be confused with **BYOK**, which is a
  user's own key for a *non-native* agent and is untouched by any of this.
- **Wire dialect** — the request-and-response grammar a provider speaks. The engine was forked
  speaking exactly one, the **Responses** dialect; the port authors a second, **Chat Completions**
  against the gateway contract (`atlas_engine_api::atlas_chat`, spec D3). The two share the engine's
  internal item and event vocabulary and nothing below it — different route, different body,
  different stream grammar, different error table. A green suite on one says nothing about the
  other.
- **Spend cap** — the ceiling on what an account may spend, denominated in weighted tokens and
  reserved *before* the provider is called. A filled cap answers `402`, deliberately not `429`,
  because stock SDKs auto-retry `429` and a monthly ceiling cannot clear for weeks.
- **Disposition** — what the client should do about a gateway error, as decided from its status
  and `error.code` (`atlas_engine_api::atlas_gateway`, spec D13): stop, wait a stated interval, refresh
  the credential and try once, or retry cautiously. Deliberately not a boolean — "retryable"
  collapses three behaviours the gateway keeps apart.

## UI actions (Atlas Agent)

- **UI action** — one request from Atlas Agent to do one thing in the Atlas window: open a file at a
  line, open a diff or a settings section, show a panel, activate or close a tab, run a keybinding
  action, steer a chat composer, type a line into a terminal, or report what the window shows. Each
  is performed by the app and answered with a result the agent reads; an action the window never
  answers fails after a bound rather than hanging the turn. *Avoid*: navigation, when the whole
  surface is meant — "navigate" is the user-facing label of the setting, not the term. Not a UI
  action: anything the agent does to files or shells through its own tools.
- **UI tool server** — the second in-process tool server Atlas hands a session that carries UI
  control, beside the memory tool server (ADR-0010). Its tools are the only way an agent acts on the
  window. Auto-approved because Atlas itself offers it; switched off for everyone by the user's
  "Let Atlas Agent navigate the app" setting.
- **UI control** — what a *connection* carries to be offered the UI tool server: that its agent runs
  inside the Atlas process, so Atlas vouches for what its tool calls may do. Today only the native
  connection carries it. Like every other per-agent behaviour it is never decided by agent identity;
  letting an ACP agent act on the window would mean that connection carrying UI control, not a
  check on who it is. See ADR-0012.
- **Project-scoped** — a UI action acts on the view of whichever project is active in the window,
  and never switches projects: there is no "open project" action, and an action aimed at a tab that
  belongs to another project is refused and says which project owns it. The calling session's own
  project need not be the active one; what the user is looking at is what the agent acts on, and
  the window's state report says whether the two differ.
- **Own-session refusal** — a UI action may not send a message into, or switch the agent of, the
  chat the calling session runs in; it may only prefill or insert text for the user to send. Closing
  an editor with unsaved changes is refused the same way. These are refusals, not prompts: there is
  no override.

## Organisation actions (Atlas Agent)

*Decided 2026-09-26. The cloud-side words are the server's own (its `CONTEXT.md`, §Session Artifacts), so the two glossaries do not drift.*

- **Workspace** — the cloud aggregate a Project is bound to: the organisation-visible record of that Project's recorded sessions, checkpoints and comments, and the thing the server scopes reads and the socket to. This is the *one* sense in which "workspace" is a live word here; the storage-key sense under **Project** stays deprecated. A Project binds to at most one Workspace.
- **Recorded session** — the Timeline's record of a Session: written locally first (`atlas-checkpoint`), synced into the Workspace, and what teammates see and comment on. It carries an author, and it is **live** while its agent is still writing (the server's rule: written within 90 s and active within 60 min). The running chat's own recorded session is the **current** one. *Avoid: capture, for this concept; "capture" is the client-internal name of the recorder, not the record.*
- **Comment** — a teammate's note on a recorded session, anchored to the session or to one of its messages, tool calls or checkpoints; threaded (a root and replies); a root can be **resolved** by anyone who can read the Workspace. Mentions inside a comment are user ids the server parses.
- **Session Reference** — a chat message's pointer to a recorded session (or a checkpoint), carried on the message and rendered as a card. The proper way for a session report to point at its session; a plain link is the fallback when the Workspace is not organisation-visible.

- **Organisation** — the tenant a signed-in user belongs to, with a roster of members. A Project is tagged to one. *Avoid: org API / teams API as product names; there is one organisation surface, and "teams" is not a thing the server has.*
- **Member** — a user in an organisation's roster, with exactly one **role**: `admin`, `product_owner`, `developer` or `member`. There is no *owner*; the member who created the organisation is an admin. On the recorded-work surface roles are flat: anyone who can see a Workspace can read, comment, resolve and search it. Admin is only for managing the organisation, its members and its Workspaces.
- **Chat** — the organisation's messaging: **conversations** (a *channel*, a *DM* or a *group DM*), their messages, and **Spaces**. This is what "the teams API" meant. A **Space** belongs to a conversation and holds **pages**: canvases of nodes (note, text, shape, media, group) joined by edges. *Avoid: teams, workspace chat.*
- **Organisation tool server** — the third in-process tool server (after memory, ADR-0010, and UI, ADR-0012), `atlas_org`, through which Atlas Agent reads the organisation (recorded sessions, comments, members, conversations) and acts in it (posts, DMs, resolves comments, writes Space pages). Mounted on the same listener and the same per-session token as the other two; offered only to a connection that carries **organisation access** (a connection property, like UI control, never an agent-id check), switched by one setting, and only when the session's Project is cloud-bound. A tool call acts in the organisation the session's Project is bound to, never in whichever organisation the window is showing.
- **Outward action** — a tool call that reaches another person: sending a message, creating a DM or channel, posting. An outward action asks the user first (allow once / allow for this session / reject), in the user's name, like a shell command. Resolving a comment and creating a page are *not* outward actions: visible, reversible, auto-approved with an audit row.
- **Session report** — a prose summary Atlas Agent writes from a recorded session, plus the link to it on the timeline, sent as one chat message. It is written, not rendered: it is not a page and not a file.
- **Clarifying question** — a structured question Atlas Agent puts to the user mid-turn, with options, when a request is ambiguous ("four comments match; which?"). Blocks the turn; rendered on the same question card ACP agents already use. A capability of Atlas Agent in every mode, not of the organisation tools alone.
- **Member activity** — what an admin can ask for about a member: the recorded sessions, checkpoints, insertions, deletions and Atlas-recorded tokens attributed to that member over a window. Folded on the client from the recorded sessions; the server has no per-member metric. *Avoid: performance, productivity, code shipped* — it counts what was recorded through Atlas and nothing else.

## Vendored engine licensing (Apache-2.0)

`vendor/atlas-engine/` is a hard fork of an upstream engine under **Apache-2.0** (ADR-0003;
renamed in ADR-0011 — the upstream's name appears in this tree only where the licence
requires it). Atlas's own code is **MIT** (`LICENSE`). The two do not merge: Apache-2.0 code
stays Apache-2.0 however it is bundled, so its obligations travel with every build rather than
being absorbed by Atlas's licence. `tests/vendor-licensing.test.ts` enforces what follows; the
attribution work landed first (D11) so that the rename sweep was trivially compliant.

- **Ship the licence and the notice (§4(a), §4(d)).** `vendor/atlas-engine/LICENSE` and
  `vendor/atlas-engine/NOTICE` are bundled into the app at `Contents/Resources/licenses/`, alongside
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
  the test compares every file against the fork commit's tree by blob hash, so it notices on
  the next run either way. Since the ADR-0011 sweep touched nearly every file, nearly every
  file carries it. Files with no comment syntax (insta snapshots, the compressed schema blobs,
  images, fixtures read verbatim) are listed in `vendor/atlas-engine/ATLAS-CHANGES.md` instead,
  which is the tree-level notice for them; the test holds those to that list.
  *(Caveat: `core/config.schema.json` is generated by schemars, and regenerating it drops the
  `$comment`. Re-add it if that ever happens.)*

- **Never strip attribution (§4(c)).** Copyright and attribution notices inside vendored sources
  are **not** touched by rename sweeps. The rule is: rename product branding, keep attribution.
  The ADR-0011 sweep was exactly the operation that could have violated this, which is why the
  rule was written down before it ran; it protected the LICENSE, the NOTICE, the §4(b) notice
  line, every URL and every upstream model id.

- **Trademarks are a removal, not a preference (§6).** Apache-2.0 grants no trademark licence, so
  the rebrand *must* drop the upstream's product name and "OpenAI" as product-facing names —
  including the baked system prompt and the catalog `instructions_template` strings that
  self-identified as the upstream product.
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
## Theming

- **Theme** — one named, shareable description of how Atlas looks, covering the whole app: chrome, editor, terminal, diffs and syntax. Holds a dark and/or light **variant**. There is exactly one active theme; there is no separate editor theme. *Avoid*: interface theme, editor theme, colour scheme.
- **Variant** — the dark or light half of a theme. A theme may ship only one.
- **Base tokens** — the required colours of a variant, named exactly as shadcn/ui names them, so any shadcn or tweakcn theme is a valid set of base tokens. *Avoid*: shadcn tokens.
- **Palette** — an optional small set of named hues (red, orange, yellow, green, cyan, blue, purple, pink) in a variant, from which syntax, terminal and status colours are derived when not set explicitly.
- **Theme keys** — optional, Atlas-specific colours in a variant, named by role in Zed's dotted style (`element.hover`, `terminal.ansi.red`, `syntax.keyword`). Any key a theme omits is derived from the palette, then the base tokens, then Atlas's defaults.
- **Theme override** — a user's settings-level patch of keys on top of the active theme. Changes that user's Atlas only; it is not a theme.
- **Theme import** — a one-time conversion of a shadcn/tweakcn, Zed or VS Code theme into an Atlas theme. The result is an ordinary Atlas theme; the source is not read again.
- **Icon theme** — a named mapping from files and folders (by name, extension or language) to icons, in VS Code's icon-theme format so VS Code icon themes can be used as-is. Chosen independently of the colour theme. *Avoid*: file icon pack, icon set.
- **Derived variable** — a colour Atlas computes from a key or a base token and no theme may set, because it is a function rather than a judgement (a status badge's fill is its status foreground at 12%). Written to `:root` like a key, absent from the schema, so writing one in a theme file is an unknown-key warning. *Avoid*: computed key, implicit key.
- **Appearance** — which of the two a variant is, `dark` or `light`. The user's `themeMode` (`system` / `dark` / `light`) is what they asked for; the appearance is what it resolved to, and a theme with only the other variant resolves to that one. *Avoid*: mode, when the resolved answer is meant.
- **Scale** — a named, finite ladder of non-colour values: type, control heights, radius, elevation, z-index layers, motion durations, icon sizes. A scale step is named, never measured (`text-xs`, not `text-[11px]`). Scales are app-owned; a theme sets `radius`, the fonts, `tracking-normal` and the shadow ramp, and nothing else on this side. Reference: `docs/reference/design-system.md`. *Avoid*: token, for a non-colour value.
