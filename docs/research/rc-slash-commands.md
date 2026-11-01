# Remote Control: the desktop's slash commands on the web viewer

Research, 2026-10-23, branch `feat/universal-rc` (both repos, uncommitted).
The ask: "whatever we get as a slash command in the app also needs to be on the
web." This maps every row the desktop picker can show to where it comes from and
what executes it, says which of them a remote driver can already run, which need
a host-side path, which stay desktop-only, and lays out the additive changes.

Line numbers are as of this branch; count them again before editing.

## TL;DR

- The desktop picker has **one real source** — the bound agent's ACP
  `available_commands_update` — plus **three rows Atlas synthesizes in React**
  (`/login`, `/fork`, `/queue`). Skills are not a separate source: they arrive
  inside the ACP list (ADR-0005), with no marker distinguishing them.
- Every ACP-advertised command, native-agent commands included, is sent to the
  agent as **verbatim prompt text at byte 0**. A remote `rc.command { kind:
  "submit", content: "/compact" }` lands on the same `AgentHost::submit` →
  `dispatch` → `prompt::compose` path the window uses, with the text block
  first and nothing prepended. So **that whole class already works from the
  browser today** — the browser just has no picker and no list to draw.
- The list already travels: the `available_commands` delta is relayed like
  every envelope, and `SessionSnapshot.available_commands` is in the RC snapshot
  — **but** `snapshot.rs` lists it as *expendable* (cleared first when the
  snapshot is over its 1 MiB budget), and the web reducer **drops it on both
  paths** (`transcriptFromSnapshot` does not read it; `applyEnvelope` has no
  `available_commands` case).
- Of the three synthesized rows: `/queue` maps onto behaviour the remote already
  has (every remote submit is `QueueIfBusy`), `/fork` and `/login` are
  desktop-only by nature (a new tab; an OAuth dialog on the owner's machine).
- No new `rc.command` kind is required. The work is: keep the list in the RC
  snapshot, reduce it on the web, build the picker on the web composer, and
  share the three small behaviours (filter/sort, args-hint, byte-0 rule) as the
  desktop does them.

## 1. Inventory: what the desktop picker shows and where each row comes from

The picker is `src/features/chat/components/slash-command-picker.tsx`; the list it
receives is built once per session in
`src/features/chat/components/message-input.tsx:876-944`
(`agentSlashCommands`). Four handler kinds exist
(`slash-command-picker.tsx:39`): `"agent-login" | "fork" | "queue" | "passthrough"`.

| # | Row(s) | Source | Handler | What executes it | Where |
|---|---|---|---|---|---|
| 1 | Everything the agent advertises — e.g. Claude Code: `/review`, `/compact`, `/init`, every skill, plugin skills, MCP prompts; **native Atlas Agent**: `/compact`, `/diff`, `/goal <objective>`, `/init`, `/review`, `/status`, `/undo`, plus each discovered skill | ACP `available_commands_update` → `SessionDelta::AvailableCommands { commands }` | `passthrough` | Sent **verbatim as the prompt text**. External ACP agent: its own process resolves it (claude-agent-acp emits the result as `<local-command-stdout>` text chunks). Native agent: `engine/commands.rs::parse` in `EngineConnection::prompt` resolves it to a protocol call / canned turn / local reply / skill turn. | Delta: `crates/atlas-agent-wire/src/delta.rs:101`; projected `crates/atlas-agent-delta/src/projector.rs:1155`; thread keeps it `crates/atlas-acp-thread/src/thread.rs:1355-1360`, read back `:1216`. Snapshot: `src-tauri/src/commands/agent_host.rs:168` (struct), `:1610` (filled). Store: `chat-store.ts:2516` (delta), `:1398` `setAcpAvailableCommands` (snapshot path, `chat-panel.tsx:650`, `:913`, `session-sidebar.tsx:611`). TS types: `src/types/agents.ts:144`, `:329`; `src/types/agent.ts:360`. Native list: `crates/atlas-native-agent/src/engine/commands.rs:105`; published `engine/connection.rs:685`, `:757`; parsed `:1831`. |
| 1a | `/remember` | A bundled skill seeded into `~/.agents/skills`; advertised by every agent that sees it, like any skill | `passthrough` | The agent runs the skill; `switch-agent.ts` also sends it programmatically before a switch | `src/features/chat/lib/remember.ts:1-31` |
| 1b | (`login`) | Filtered **out** of the agent list | — | — | `message-input.tsx:898` |
| 2 | `/login` | Synthesized by React when `canSignIn(agentType)` | `agent-login` | Opens `AgentOAuthModal` via `promptSignIn(agentType, { reason })` — a window dialog, then a host OAuth flow | `message-input.tsx:916-921`, `:1439-1448`; `src/features/chat/lib/agent-signin.ts` |
| 3 | `/fork` | Synthesized when `agentCatalogEntry(agentType)?.supportsFork === true` | `fork` | `forkSessionToNewTab(tabId)` — a new tab bound to a forked session | `message-input.tsx:929-935`, `:1449-1455`; typed form intercepted at `:1764-1769` |
| 4 | `/queue <message>` | Synthesized for every agent | `queue` | `enqueuePrompt(tabId, text)` — the turn controller's queue (Rust, `steering.rs:333` `enqueue`) | `message-input.tsx:937-942`; typed form intercepted at `:1770-1776` |

Things that look like slash commands but are not rows: `/model`, `/approvals`
(mode), `/new`, `/mention` — the native agent deliberately does not advertise
them because the composer's pickers are the better surface
(`engine/commands.rs:30-35`). They are already covered remotely by
`set_model` / `set_mode` command kinds. `/clear` and `/logout` are blocklisted
by claude-agent-acp and never reach the list (`message-input.tsx:910-914`).

Per the ADRs there is **no local catalogue** (ADR-0005; the
"slash tokens pass through" ADR in `docs/adr/0003-slash-tokens-pass-through-skills-are-not-inlined.md`).
The picker shows "Loading commands…" while `availableCommands === undefined`
(`message-input.tsx:877`, `slash-command-picker.tsx:229`, `:274-279`).

### Skills metadata

There is none on the wire. ACP `AvailableCommand` is `{ name, description,
input?: { hint } | null, _meta? }` (`agent-client-protocol-schema-1.5.0/src/v1/client.rs:535-555`,
`:592-604`). Neither the native seam (`commands.rs:134-137` pushes
`AvailableCommand::new(name, description)` for a skill) nor claude-agent-acp
marks a row as a skill. The desktop picker therefore draws skills exactly as
commands, and the web should too. ADR-0004 (skill identity is canonical path,
picker identity is name) applies: the picker only ever knows the name.

### Arguments and the `input.hint`

`message-input.tsx:883-897` folds the hint into the row's `signature`:
`input != null` → `/${name} <${hint || "args"}>`; `input == null` → `/${name}`.
`commandRequiresArgs(cmd)` (`slash-command-picker.tsx:53`) is "signature
contains `<…>`"; `argsHint(cmd)` (`:64`) reads the word back out for the pill.
Note: Claude's rows carry `input: null` (mock `northwind-agent.ts:107-123`
mirrors the real shapes), the native agent sets `input` only on `/goal`
(`commands.rs:116`), and `/review <instructions>` takes optional input without
declaring it — the parser splits head from rest regardless (`commands.rs:188-206`).

### How the desktop picker opens, filters, sorts and commits

- **Trigger** (`src/features/chat/lib/cm-slash-extension.ts`): scanning back from
  the caret on the current line for a `/` whose previous char is
  start-of-line, whitespace, `(` or `[`; stops at the first whitespace. Reports
  `query` (text after `/`) and `atStart` (the `/` is document position 0).
- **Filter/sort** (`slash-command-picker.tsx:136-152`): empty query → the list
  in catalogue order (`[login?, …agent rows in advertised order, fork?, queue]`).
  Non-empty query → tiers: exact name (0), name prefix (1), name substring (2),
  description substring (3); unmatched rows dropped; alphabetical by name within
  a tier. Matches highlighted case-insensitively (`:96-114`).
- **Keys** (`message-input.tsx:1519-1570`): ↑/↓ move, Enter commits, Esc
  closes, Backspace falls through to the editor (deleting the `/` closes the
  picker), Tab completes to `/name ` without sending (passthrough rows only).
- **Commit** (`handleSlashSelect`, `message-input.tsx:1433-1517`):
  `agent-login`/`fork` run their app handler; `disabled` (agent not authed)
  swallows passthrough; `commandRequiresArgs` → insert `/name ` and wait for
  Enter; otherwise replace the token with `/name` and — **only if `atStart`** —
  call `submit()` immediately. Mid-message the command is completed, not sent,
  because claude-agent-acp resolves a command only at byte 0 of the first text
  block (comment at `cm-slash-extension.ts:9-15`; `prompt.rs:43-46` keeps the
  text block first for the same reason).
- **Submit** (`message-input.tsx:1748-1810`): `/fork` and `/queue …` are
  intercepted; everything else is `onSend(trimmed, mentions, images)`. If a turn
  is running the text is queued (`enqueuePrompt`) rather than sent.

## 2. Can each class run from a remote surface?

The remote send path: browser `live.send({ kind: 'submit', content })`
(`apps/web/src/lib/use-rc-room.ts:485-505`) → room DO gates tier/driver/epoch/size
(`apps/ingest/src/rc-do.ts:1413-1500`) → desktop `gate::check`
(`crates/atlas-remote-control/src/gate.rs:108-162`) → `AppSessionPort::execute`
(`src-tauri/src/commands/rc.rs:761-780`): `Prompt::text(content)` with
`client_message_id`, `host.submit(&key, prompt, Origin::Remote, SubmitPolicy::QueueIfBusy)`
→ `steering.rs:305-331` → `dispatch` (`:579`) → `prompt::compose(text, images)`
(`crates/atlas-acp-thread/src/prompt.rs:50`: text block first, nothing prepended)
→ `manager.send` → `AgentConnection::prompt`. The `<atlas-memory>` prepend
mentioned at `agent_memory.rs:596` is historical (ADR-0010 made memory
pull-only); nothing on this branch prefixes the prompt.

| Class | Remote today? | Needs | Security notes for a non-owner driver |
|---|---|---|---|
| **1. ACP-advertised passthrough (external agents)** — `/compact`, `/review`, `/init`, skills, `/remember`, … | **Yes, unchanged.** The content reaches the agent at byte 0, exactly like a typed send. Already allowed: the gate takes any non-empty ≤ 32 KiB prompt under `Capability::Steer`. | Web: a list to draw and a picker. Nothing host-side. | Same exposure as any prompt the driver may already send: a skill is agent work under the session's permission mode, so approval gates still apply. `/compact` and `/undo`-like commands change the owner's session state irreversibly — no worse than a prompt, but worth the picker saying "runs on the owner's desktop". claude-agent-acp's `<local-command-stdout>` output is plain text through the normal chunk path, so it is redacted by `atlas_redact` like everything else. |
| **1 (native agent)** — `/compact`, `/diff`, `/goal`, `/init`, `/review`, `/status`, `/undo`, skills | **Yes, unchanged.** `EngineConnection::prompt` parses the text (`connection.rs:1831`) whoever sent it. | Nothing. | `/diff` runs `git diff HEAD` in the session cwd and pushes it into the transcript (`commands.rs:150`) — the driver already sees the agent's tool output, so this is not a new leak, but it is a 40 KB dump of the owner's working tree on request. `/undo` rewinds the owner's thread (`history_rewound` delta). Both are reasonable for `steer`; if a stricter stance is wanted, the gate can refuse content matching a host-configured denylist for non-owners — see §4.4 (optional). |
| **2. `/login`** | **No, and should not be.** It opens a dialog on the owner's screen and starts an OAuth flow for the owner's agent credentials. | Stay desktop-only. The web picker omits it (nothing to send). | A remote sign-in of the owner's agent is exactly the kind of widening the gates exist to stop. |
| **3. `/fork`** | **No.** `forkSessionToNewTab` is window state. A host-side fork exists (`agent_host.rs:1923-1936`, native-only downcast) but the forked session would be a *different* session, outside the room. | Desktop-only for now. Could become an `rc.command { kind: "fork" }` later if rooms ever follow a session family; not worth it now. | Creates agent sessions on the owner's machine — owner-only if ever added. |
| **4. `/queue <message>`** | **Effectively yes, as plain submit.** A remote submit is `SubmitPolicy::QueueIfBusy` (`rc.rs:779`): typed while a turn runs, it parks behind the turn; typed while idle, it starts a turn. The desktop's `/queue` differs only in *always* parking even when idle (`steering.rs:333` `enqueue`). | Two options: (a) **recommended** — the web picker offers `/queue <message>` as a client-side row that calls `send({ kind: 'submit', content: message })` and labels the result "Queued" when `transcript.status` is running, which is what the row means to a remote user anyway; (b) add `rc.command { kind: "enqueue" }` → `host.enqueue` to mirror park-while-idle. (b) is additive and small but needs the contract, the DO, the desktop wire, and three fixtures touched for a distinction a phone user does not need. Take (a). | None beyond submit. The queue is in Rust and the driver's items show with origin on the desktop (`queue_changed`). |

**Byte-0 rule on the web.** The web composer is a plain `<Textarea>`; the
picker must mirror `atStart`: commit sends immediately only when the `/` is at
offset 0 of the textarea value; otherwise it completes the token and leaves the
caret after it. Without this, a mid-message pick would ship prose and silently
do nothing — the same trap the desktop comment warns about.

**Gating on the web.** The composer is already driver-only (`steerBlock`,
`rc.rooms.$roomId.tsx:245-258`, and the DO/desktop gates behind it). The picker
inherits that: it only opens while `block === null`, which also covers "owner
offline" (every command is refused `owner_offline` by the DO, so a picker that
opened then would only produce refusals).

## 3. What the browser receives today

| Hop | State | Evidence |
|---|---|---|
| `available_commands` delta relayed | **Yes.** The RC tap is lossless on every envelope (`host.rs:5-9`, `offer` `:268`), with the kind treated as "urgent" (not streamed text) so it is flushed without coalescing (`:819`). | `crates/atlas-remote-control/src/host.rs` |
| In the RC snapshot | **Yes, but expendable.** `SessionSnapshot.available_commands` is serialised whole (`rc.rs:741-759` uses `host.snapshot` → full struct), then `snapshot::prepare` clears it **first** when the document is over the 1 MiB cap minus 32 KiB headroom (`snapshot.rs:19`, `:62-66`) — before any message is dropped. A late joiner on a long session gets `available_commands: []` while the transcript is still trimmed to fit. The list is small (a few KB; ~60 skills ≈ 10 KB) and the viewer now needs it. | `crates/atlas-remote-control/src/snapshot.rs` |
| Web reducer, snapshot path | **Dropped.** `transcriptFromSnapshot` reads `messages`, `status`, `current_mode`, `current_model`, `title`, `plan`, `pending_permissions`, `pending_elicitation`, `queue` and nothing else. | `apps/web/src/features/rc/rc-transcript.ts:257-283` |
| Web reducer, delta path | **Dropped.** `applyEnvelope` has no `available_commands` case; the kind falls to the "ignore unknown" branch (test `rc-transcript.test.ts:226`). | `rc-transcript.ts:437-560` |
| `RcTranscript` shape | No field for it. | `rc-transcript.ts:93-109` |
| Web page | Draws `room.agent` (plugin id) in the header (`rc.rooms.$roomId.tsx:115`) — usable as the picker's footer label ("claude-code commands"). | |

So the wire is already right; the two edges that lose the list are the
desktop's over-budget trim and the web reducer.

## 4. Design

Additive only. No wire variant, no snapshot field, no new command kind is
required; one ordering change in the snapshot trim and a handful of web files.

### 4.1 Desktop: keep the list in a trimmed snapshot

`crates/atlas-remote-control/src/snapshot.rs`:

- Remove `available_commands` from `EXPENDABLE` (`:19`), leaving `subagents`
  and `config_options` there. Clear it only in the "still over after four
  passes" fallback (`:42-49`) alongside `messages`, with a short comment: the
  viewer's slash picker reads it, so it outlives the oldest messages; it is
  bounded by what one agent advertises, not by the transcript.
- Optionally cap it defensively: if the serialised list is over, say, 64 KiB,
  truncate to the first N rows rather than clearing — an agent advertising
  hundreds of MCP prompts should not cost a joiner the picker. (Only if a real
  list is seen to be that big; measure first with Claude Code + plugins.)
- Test (existing `mod tests`): a 200-message snapshot with a 20-row
  `available_commands` under a 64 KiB cap keeps the rows and drops messages.

No change to `SessionSnapshot`, `SessionDelta`, `wire.rs`, `gate.rs`,
`rc-do.ts`, or the fixtures.

### 4.2 Web: carry the list in the transcript

`apps/web/src/features/rc/rc-transcript.ts`:

- Add to `RcTranscript`: `commands: Array<RcCommand> | null` where
  `RcCommand = { name: string; description: string; hint: string | null; takesInput: boolean }`.
  `null` = not yet announced (the desktop's `undefined` → "Loading commands…"
  state); `[]` = the agent advertises nothing.
- `commandOf(v: unknown): RcCommand | null` — same normalisation as
  `message-input.tsx:883-897`: strip a leading `/` from `name`, `takesInput =
  input != null`, `hint = typeof input?.hint === 'string' ? input.hint : null`;
  drop rows with an empty name and the `login` row (the one row the desktop
  also filters).
- `transcriptFromSnapshot`: `commands: arr(s.available_commands).map(commandOf).filter(...)`,
  but keep the desktop's rule from `chat-store.ts:1414`: a snapshot with an
  empty list must **not** erase a list a delta already delivered — relevant on
  `rc.resync { reason: "host" }` where a trimmed snapshot (pre-4.1 desktops)
  replaces the transcript. Implement as: if the incoming snapshot's list is
  empty and the previous transcript had rows, carry the previous rows. This
  needs `transcriptFromSnapshot(snapshot, previous?)`; `RcStream.finishSnapshot`
  already has `this.transcript` to pass.
- `applyEnvelope`: `case 'available_commands': return { ...t, commands: … }`.
- Nothing in `rc-stream.ts` or `use-rc-room.ts` changes: the transcript is
  published as a whole.

### 4.3 Web: the picker in the RC composer

Reuse the pattern the chat composer already has for `@` mentions
(`apps/web/src/components/chat/composer.tsx:176-184`, `:341-352`, `:638-674`):
a `<Textarea>`, a `query(text, caret)` helper, a base-ui `Popover` (`#/components/ui/popover`,
`side="top" align="start"`, `initialFocus={false}` and `finalFocus={area}` so
the textarea never loses focus), a `role="listbox"` of `role="option"` buttons
with `onMouseDown={e => e.preventDefault()}` + `onClick`, `ArrowUp/Down` cycling,
`Enter`/`Tab` picking, `Escape` closing. That is the same mechanism the desktop
picker uses (`slash-command-picker.tsx:236-265`), minus CodeMirror.

Proposed files (web repo):

- `apps/web/src/features/rc/rc-slash.ts` — pure helpers, tested:
  - `slashQuery(value, caret): { start, q, atStart } | null` — mirrors
    `cm-slash-extension.ts::detectTrigger` with the `mentionQuery` regex style
    (`chat-transcript.ts:178-186`): `/(^|[\s([])\/([^\s/]{0,64})$/` on the text
    before the caret; `atStart = start === 0`.
  - `rankCommands(commands, q): RcCommand[]` — the desktop's four tiers and
    alphabetical tie-break (`slash-command-picker.tsx:136-152`), returning the
    full list in catalogue order on an empty query.
  - `argsHint(cmd)` → `cmd.hint ?? 'args'`.
  - `localRows(transcript): RcCommand[]` — `[{ name: 'queue', description:
    'Queue a message to run when the agent is free', hint: 'message',
    takesInput: true }]`. No `/login`, no `/fork` (§2).
- `apps/web/src/features/rc/rc-slash-picker.tsx` — the popover + listbox,
  props `{ open, rows, active, loading, footer, onPick, onHover }`. Uses the
  existing `Kbd` for the footer hint ("↑↓ · ↵ run · ⎋ close"), `Badge
  variant="outline"` for the args pill, `mono` for `/name`, `bg-element-hover`
  / `aria-selected:` for the active row — all existing tokens; no new visual
  pattern (the design-language rule).
- `apps/web/src/routes/_app/rc.rooms.$roomId.tsx` `Composer` (`:283-355`):
  track `caret` on `onSelect`/`onKeyUp`/`onClick` like the chat composer; derive
  `query = slashQuery(text, caret)`; `rows = rankCommands([...agent, ...local], q)`;
  `onKeyDown` routes keys to the picker first when open; `pick(cmd)`:
  - `takesInput` → replace `/q` with `/name ` and keep typing;
  - else replace with `/name`; if `query.atStart` → `submit()` now (the
    desktop's auto-send); else leave it (completion only).
  - `queue` is a local row: on submit, `/queue <msg>` is rewritten to
    `send({ kind: 'submit', content: msg })` (§2 option a); an empty `/queue` is
    refused locally with the same "a prompt needs some text" wording the gate
    uses.
  - `commandLine()` (`:267`) gains a "Queued" wording when the submit was sent
    while `busy` — the desktop shows a queue chip; the web shows a line.
  - Footer label: `${room.agent} commands` when known, else "Commands";
    `loading` = `transcript.commands === null` → the picker renders the
    desktop's "Loading commands…" row.
- Mobile/touch: the chat composer's mention popover already works on touch
  (`onClick` picks; base-ui positions inside `--available-height`). Two
  additions for phones: (1) rows ≥ 40 px tall so they are tappable (the
  desktop's 26 px rows are mouse-sized), (2) because the virtual keyboard
  eats half the viewport, cap the list at ~5 visible rows with scroll and keep
  `side="top"`. No breakpoint code is needed; the shell is already responsive
  and the RC page has no breakpoint classes of its own.
- Driver-only: the picker is mounted only when `block === null`, i.e. the page
  is the driver with a steer tier on an open, owner-online room. Visitors can
  see the command list in the DriverCard if desired (read-only "what this agent
  can do") — optional; not needed for parity.

### 4.4 Optional: a host-side denylist for non-owner drivers

Not needed for parity and not recommended as a first step. If product wants
"a guest may not `/undo` the owner's thread", the cheapest honest gate is in
`gate.rs::check` under `if !is_owner`: refuse a `Submit` whose trimmed content's
first token is in a small host list (`/undo`, `/init`), with
`Gate::Widening`-style wording. It stays agent-agnostic (string match on what the
driver typed, not on the agent id). Pair it with a web-side row filter so the
picker does not offer what the desktop will refuse. Leave it out unless asked.

### 4.5 Rendering `<local-command-stdout>` on the web

claude-agent-acp answers a passthrough command with
`<local-command-stdout>…</local-command-stdout>` inside normal text chunks.
The desktop renders them as markdown text today (there is no stripping in the
desktop renderer either — grep finds only the comments in `message-input.tsx`
and `slash-command-picker.tsx`). The web's `Markdown` subset never produces
HTML (`rc-render.tsx:20-37`), so the tags will show as literal text. Parity
means doing what the desktop does; a later shared improvement would strip the
pair in both `replyText` (`rc-transcript.ts:591`) and the desktop's message
renderer in one change. Note it; do not block on it.

## 5. Gaps, in order of what blocks the feature

1. **Web reducer drops the list** (both paths) — the feature cannot draw anything
   until §4.2 lands. Blocking.
2. **Desktop snapshot trim clears the list first** — a late joiner on a long
   session loses the picker (and a `host` resync with a trimmed snapshot would
   erase it, hence the carry-forward rule). §4.1. Blocking for long sessions.
3. **No picker in the RC composer** — §4.3. Blocking.
4. `/queue` semantics differ slightly (park-while-idle vs submit) — handled as a
   local row; no wire change. Not blocking.
5. `/fork`, `/login` stay desktop-only — by design. Say so in the picker's
   absence rather than drawing dimmed rows (the desktop retired dimmed guard
   rows for the same reason, `message-input.tsx:910-914`).
6. `<local-command-stdout>` tags render literally on both surfaces — shared,
   non-blocking.

## 6. File change list

### atlas (desktop)

| File | Change |
|---|---|
| `crates/atlas-remote-control/src/snapshot.rs` | Take `available_commands` out of `EXPENDABLE`; clear it only in the final fallback; module doc lists it among the fields the viewer reads; new test. |
| `docs/research/universal-rc-seam.md` (Q2 table) or the RC design doc | One line: the command list is a viewer field, not expendable. |
| *(nothing else)* | No `SessionDelta` / `SessionSnapshot` / `wire.rs` / `gate.rs` / `rc.rs` / fixture / `tests/wire-shape-contract.test.ts` change. |

### server (web)

| File | Change |
|---|---|
| `apps/web/src/features/rc/rc-transcript.ts` | `RcCommand`, `commandOf`, `commands` on `RcTranscript` (+ `emptyTranscript`), snapshot read with carry-forward, `available_commands` delta case. |
| `apps/web/src/features/rc/rc-stream.ts` | Pass the previous transcript into `transcriptFromSnapshot` (one line in `finishSnapshot`). |
| `apps/web/src/features/rc/rc-slash.ts` (new) | `slashQuery`, `rankCommands`, `argsHint`, `localRows`. |
| `apps/web/src/features/rc/rc-slash-picker.tsx` (new) | The popover listbox, reusing `Popover`, `Badge`, `Kbd`, `Icon`. |
| `apps/web/src/routes/_app/rc.rooms.$roomId.tsx` | `Composer`: caret tracking, picker wiring, key routing, `/queue` rewrite, footer label from `room.agent`, "Queued" command line. |
| `packages/contracts/src/rc.ts` | None. (If the fixture snapshot in `apps/ingest/test` or `thread-wire-v1.json` is extended with an `available_commands` example, the desktop `tests/contract.rs` round-trip keeps it honest — optional.) |

## 7. Tests

### atlas

- `crates/atlas-remote-control/src/snapshot.rs` `mod tests`:
  `a_long_transcript_keeps_the_command_list_and_drops_messages_first` — 200
  messages + 20 commands under a 64 KiB cap: `available_commands.len() == 20`,
  `rc_trimmed_messages > 0`.
- Existing `a_small_snapshot_passes_through_whole` already proves the field
  survives untouched when under budget.
- No change to `crates/atlas-agent-wire/tests/contract.rs` (the
  `available_commands` kind and `["commands"]` field list are already there,
  `:66`, `:516-518`) or to `tests/wire-shape-contract.test.ts`.

### server

- `apps/web/src/features/rc/rc-transcript.test.ts`:
  - snapshot: reads `available_commands` into `commands` with `/` stripped,
    `login` dropped, `hint`/`takesInput` derived; an empty snapshot list keeps
    the previous rows; a missing field → `null`.
  - deltas: `available_commands` replaces the list; the "ignores a kind it does
    not know" case still holds for a genuinely unknown kind.
- `apps/web/src/features/rc/rc-slash.test.ts` (new):
  - `slashQuery`: opens at line start, after whitespace, after `(`/`[`; not
    inside a word (`a/b`), not in a URL (`https://`); `atStart` only at offset 0;
    closes on whitespace after the token.
  - `rankCommands`: the four tiers in order, alphabetical within a tier,
    unmatched dropped, empty query = catalogue order — the same cases a
    desktop test would state for `slash-command-picker.tsx:136-152`.
  - `localRows` contains `queue` and never `login`/`fork`.
- `apps/web/src/features/rc/rc-render.test.tsx` or a new
  `rc-slash-picker.test.tsx`: the picker renders no HTML path for a description
  (the feature's standing rule, `rc-render.tsx:20-37`): a description of
  `<img src=x>` is the characters, not an element.
- `apps/ingest/test/rc-*.test.ts`: nothing — the relay does not look inside
  `content`.

### Manual

Desktop (`bun run dev:app`) + web, one room, Claude Code and Atlas Agent each:
late-join a session longer than 1 MiB and confirm the picker has rows; send
`/compact` from a phone and watch the desktop's transcript; send `/goal ship
it` and confirm the arg reaches the native parser; `/queue hello` while a turn
runs and confirm the desktop's queue chip shows the remote origin; confirm a
`view`-tier member never sees the picker.
