# Remote model, mode and option control for Universal RC

**Status:** research, 2026-10-23. No code changed. Everything cited is the uncommitted
`feat/universal-rc` state of both repos (`atlas` and `server`); line numbers are from
that working tree and will drift.

**Question.** What does it take for a remote Driver — the web viewer at
`/rc/rooms/{roomId}`, on a phone or a desktop browser — to change a desktop session's
LLM model, and alongside it the session mode and the agent's config options (effort /
thinking level), the way the desktop composer's model picker does?

**Short answer.** The command path is already built end to end (`set_model`, `set_mode`,
`set_config_option` relay → desktop gate → `AgentHost` steering entry), the deltas that
confirm a change are already relayed, and the kind-2 snapshot already carries the
model list, the mode list and the config options. What is missing is almost entirely
on the *reading* side: the web viewer reads only `current_mode` / `current_model` off
the snapshot and ignores `config_options_updated`, has no picker UI, and has no
pending/confirmed state for a setting command. Three small desktop corrections and
one consent decision round it out. Nothing new needs to be invented on the wire; one
optional additive field (`origin` on the two change deltas) is proposed for a later
slice.

---

## 1. Current state: how the desktop picker gets its data

### 1.1 The seam (agent-agnostic, ADR-0002)

Every per-session control is an optional capability on `AgentConnection`
(`crates/atlas-acp-thread/src/connection.rs`):

| control | trait | discovered by | lines |
| --- | --- | --- | --- |
| models | `AgentModelSelector` — `list_models`, `select_model`, `selected_model`, `watch` | `AgentConnection::model_selector(session)` returns `Some` | `:355-357`, `:595-614` |
| modes | `AgentSessionModes` — `current_mode`, `all_modes`, `set_mode` | `session_modes(session)` | `:363-365`, `:446-452` |
| config options | `AgentSessionConfigOptions` — `config_options`, `set_config_option` (returns the full confirmed list), `watch` | `session_config_options(session)` | `:367-371`, `:454-469` |

A model row on the seam is `AgentModelInfo { id, name, description, icon, is_latest,
cost, disabled, provider, legacy }` (`:631-650`); a list is `Flat` or `Grouped` by
provider name (`:655-658`). Nothing is keyed on an agent id.

### 1.2 ACP agents (Claude Code, OpenCode, …)

- **Modes** come on the `modes` field of the `session/new` / `session/load` response and
  are held in an `Arc<Mutex<acp::SessionModeState>>`; `AcpSessionModes` reads and sets
  them (`crates/atlas-agent-servers/src/connection.rs:1496-1553`). `set_mode` flips the
  local mode optimistically and rolls it back if `session/set_mode` fails or times out
  (`:1516-1552`). An agent that sends no `modes` (OpenCode) gets them synthesised from
  its `category: "mode"` config select (`session_modes_of`, `:1555+`).
- **Models** have no dedicated field in ACP 1.5.0: the picker is the `category: "model"`
  SELECT among the session config options. `model_select_of` lifts that one option into
  the seam's `AgentModelList::Flat` (groups flatten; a group's name becomes each model's
  `provider`) (`:1631-1700`). `AcpModelSelector::select_model` is therefore
  `session/set_config_option` on the model option's id, and the *response's*
  `config_options` is written back as the authoritative list (`:1747-1783`).
- **Config options** (thinking level, web search, persona…) are the raw
  `Vec<acp::SessionConfigOption>` from `session/new`, kept current by the
  `config_option_update` notification and by every `set_config_option` response
  (`:1789-1830`; `handlers.rs:842-868`). The schema's semantic categories are `Mode`,
  `Model`, `ModelConfig`, `ThoughtLevel`, `Other(String)`
  (`agent-client-protocol-schema-1.5.0/src/v1/agent.rs:2481-2493`); an option is
  `{ id, name, description?, category?, kind: Select{currentValue, options} | Boolean{currentValue} }`
  (`:2513-2540`).
- **Agent-driven changes** arrive as `session/update`: `CurrentModeUpdate` is mirrored
  onto the mode state (`handlers.rs:833-841`) and raised as `AcpThreadEvent::ModeUpdated`
  (`crates/atlas-acp-thread/src/thread.rs:1362-1365`); `ConfigOptionUpdate` is mirrored
  onto the option state (and onto the mode state for OpenCode-style agents,
  `handlers.rs:842-868`) and raised as `AcpThreadEvent::ConfigOptionsUpdated`
  (`thread.rs:1366-1369`).

### 1.3 The native Atlas Agent

- **Models** are the gateway's catalogue, fetched and cached under the engine home
  (ADR-0007), captured on the connection at connect as a `LiveCatalogue`.
  `EngineModelSelector::list_models` answers from it; `select_model` refuses a slug not
  in the catalogue, records the choice per session, and sends
  `thread/settings/update { model }` to the engine; `selected_model` is the per-session
  choice or the catalogue's first entitled row
  (`crates/atlas-native-agent/src/engine/connection.rs:3951-4037`).
- **Modes** are Atlas's four — `default` ("Ask"), `acceptEdits`, `plan`, `bypass` —
  translated to the engine's approval + sandbox policies (`engine/modes.rs:34-59`).
  `EngineSessionModes::set_mode` **refuses mid-turn**: "The permission mode can't change
  while a turn is running — … Stop the turn first." (`engine/connection.rs:3906-3925`).
  It records the mode only after the engine accepted it (`:3927-3940`) and raises no
  thread event — the host announces the change (§1.5).
- **Config options:** the native connection implements no `session_config_options`, so
  a native room never advertises `Capability::Config`.
- **Effort:** `AgentHost::set_effort` exists (`src-tauri/src/commands/agent_host.rs:1872-1882`,
  IPC `agents_set_effort`, `agents.rs:2107`) but is documented as **inert against the
  Atlas gateway** — the authored catalogue advertises no effort levels and the composer
  offers none (`agent_host.rs:1866-1871`). The store's `pushNativeEffortToAgent`
  (`src/features/chat/stores/chat-store.ts:280-289`) is reached only from the legacy
  `setNativeEffort` action; nothing mounted calls it. So "effort" for remote control
  means *ACP `thought_level` config options*, handled generically — no native effort verb
  is needed and none should be special-cased.
- **Catalogue refresh** (`refresh_native_models_with`, `agent_host.rs:1143-1250`): a
  same-fingerprint refresh swaps labels in place; a different fingerprint refuses while a
  turn runs, otherwise announces `agent_disconnected` on every native session and drops
  the connection (`:1236-1242`). The new list reaches the *window* through the IPC
  return value (`native-models-store.ts:48-49` → `setAcpModelsForAgent`), not a delta.

### 1.4 The snapshot (`agents_snapshot` / `snapshot_meta`)

`SessionSnapshot` (`agent_host.rs:158-204`) carries, among the live fields:

| field | source | line |
| --- | --- | --- |
| `current_mode`, `available_modes: Vec<SessionModeInfo>` | `modes_of` → `session_modes()` (`:1380-1400`) | `:164`, `:166` |
| `current_model` | the user's pick (`record.current_model`) else `selected_model()` — "the picker's value" (`:1526-1535`) | `:165` |
| `available_models: Vec<SessionModeInfo>` | `model_selector().list_models()` under `block_on` (both impls answer from memory), grouped lists flattened with the group as `provider` (`:1536-1565`) | `:167` |
| `config_options: Vec<serde_json::Value>` | `session_config_options().config_options()` serialised raw (`:1615-1625`) | `:169` |
| `as_of_seq`, `pending_permissions`, `pending_elicitation`, `queue`, `held` | projector / turn controller | `:190-204` |

`SessionModeInfo { id, name, description?, provider?, is_new?, legacy? }` is the one row
type for modes and models (`agent_host.rs:92-119`; TS mirror
`src/types/agents.ts:103-115`). `snapshot_meta` is the same shape without messages
(`:1484-1486`); `rc_start` reads it for capabilities (`rc.rs:275-288`).

### 1.5 The deltas that carry a change

`crates/atlas-agent-wire/src/delta.rs` (TS mirror `src/types/agents.ts`; contract held
by `crates/atlas-agent-wire/tests/contract.rs:117-124, 232-268` and
`tests/wire-shape-contract.test.ts`):

| delta | fields | emitted by |
| --- | --- | --- |
| `mode_changed` (`:87`) | `mode_id` | host after `set_mode` succeeds (`steering.rs:801` → `projector.rs:498-501`), **deduplicated** against the last announced mode (`mode_deltas`, `projector.rs:868-874`); and from the ACP echo `ModeUpdated` (`projector.rs:1165`) |
| `model_changed` (`:98`) | `model_id` | host after `set_model` succeeds (`steering.rs:828` → `projector.rs:449-457`), always |
| `config_options_updated` (`:130`) | `config_options: [raw option JSON]` | host with the `set_config_option` **response** (`steering.rs:871` → `projector.rs:464-476`) and from the ACP notification (`projector.rs:1166-1173`) |

There is no delta for "the available model list changed" by itself: for ACP agents the
list rides inside `config_options_updated` (the `category: "model"` select), for the
native agent a list change is a reconnect (§1.3).

### 1.6 The steering entry

`AgentHost::set_mode` / `set_model` / `set_config_option`
(`src-tauri/src/commands/agent_host/steering.rs:787-873`) are the single entry for the
window (`agents.rs:2085-2104` with `Origin::Local`) and the remote port
(`rc.rs:810-814` with `Origin::Remote`). Each: notes the steer, applies the seat check
(local only, `:283-297`), resolves the capability or fails "this agent has no session
modes / model selection / config options", calls the seam, then announces. The
`set_config_option` value mapping is `bool → boolean`, string → `value_id`, anything
else → its JSON text as a `value_id` (`:850-861`).

---

## 2. Current state: what RC already carries, and what is missing

### 2.1 Room creation and capabilities

`rc_start` advertises `Capability::Mode | Model | Config` iff `snapshot_meta`'s
`available_modes` / `available_models` / `config_options` are **non-empty at that
moment** (`src-tauri/src/commands/rc.rs:279-288`), and sends the agent id and the
current model as room metadata (`:296-297`; `HostConfig`, `:363-372`). The room record
stores them (`server: apps/ingest/src/rc-do.ts:135-137`; `packages/contracts/src/rc.ts:439-446`),
the list door returns them (`apps/ingest/src/rc.ts:177-182`), and the web's
`RcRoom.capabilities / agent / model` come from that list (`rc.ts:459-464`).

Gaps:

- Capabilities are computed once. A native session whose gateway fetch failed at start
  has an empty list and no `model` capability for the room's life, even after a Refresh.
  (Minor; the fix is to derive the capability from `model_selector().is_some()` rather
  than list length — §4.4.)
- `room.model` is the create-time value; `UpdateRcRoomRequest` cannot change it
  (`rc.ts:529-542`) and the host hello resends `cfg.model` unchanged on every redial
  (`crates/atlas-remote-control/src/host.rs:628-636`). The viewer already prefers the
  live transcript's model (`rc.rooms.$roomId.tsx:114-118`), so this is cosmetic.

### 2.2 The kind-2 snapshot

`AppSessionPort::snapshot` serialises the **whole** `SessionSnapshot` (`rc.rs:741-759`)
and `snapshot::prepare` redacts and fits it under 1 MiB (`snapshot.rs:27-50`). So the
browser **already receives** `available_models`, `available_modes`, `config_options`,
`current_model`, `current_mode` on every snapshot (joiner, gap, checkpoint, resync).

Gap: when the document is over budget, `fit` blanks `EXPENDABLE = ["available_commands",
"subagents", "config_options"]` *before* dropping any message (`snapshot.rs:19, 62-66`).
`available_models` / `available_modes` survive, but the config options — the thinking
and effort knobs — vanish exactly on long sessions. They are a few KiB; they should not
be expendable (§4.1).

### 2.3 Relayed deltas

Every `SessionDeltaEnvelope` for the session is offered to the room (`rc.rs:378-380` →
`host.rs:268-283`), batched (`batch.rs`: text chunks coalesce for 33 ms / 8 KiB, every
other kind flushes at once, `:20-27, :85-100`) and redacted. `mode_changed`,
`model_changed` and `config_options_updated` all reach the browser today.

What the web does with them (`apps/web/src/features/rc/rc-transcript.ts`):

- `transcriptFromSnapshot` reads `current_mode`, `current_model` and nothing else of the
  five (`:244-270`); `RcTranscript` has `mode: string | null`, `model: string | null`
  only (`:99-114`).
- `applyEnvelope` folds `mode_changed` and `model_changed` into those two strings
  (`:433-436`); `config_options_updated` falls to the `default` branch and is dropped
  (`:519-522`).
- The route shows the raw id in the header (`rc.rooms.$roomId.tsx:111-123`).

So the missing pieces for a picker are: the **lists** (models with `name`/`description`/
`provider`/`legacy`, modes with `name`/`description`), the **knobs** (parsed
`config_options` with `category`), the **current** values resolved to display names, and
a **pending** state. The ids alone are there.

### 2.4 Commands and results

- Web: `useRcRoom.send(command)` mints a ULID, stamps the last driver epoch, refuses
  to queue while not welcomed, keeps the last 20 entries with state
  `sent | pending | accepted | refused | no_answer` and folds `rc.command_result` /
  `rc.refused` into them (`apps/web/src/lib/use-rc-room.ts:57-70, 280-303, 455-478`).
  Only `submit` and `stop` are ever sent (`rc.rooms.$roomId.tsx:290-351`).
- Relay (`rc-do.ts:1446-1497`): `room_closed`, `owner_offline`, rate bucket, size
  (`rcCommandSizeProblem`, 8 KiB value cap), tier (`RC_COMMAND_MIN_TIER`: all three
  settings are `steer`, `rc.ts:888-895`), members-only (`set_config_option`, `:903`;
  `rc-do.ts:1458`), Driver-only including the owner (`:1465-1484`), epoch (`:1485`); then
  relayed with `from` and stored pending. The audit detail keeps `modeId` / `modelId` /
  the option `key` (`:2449-2463`).
- Desktop gate (`crates/atlas-remote-control/src/gate.rs:108-165`): epoch, seat,
  advertised capability (`:138`), widening (§3.4), size (`:172-197`). Then
  `AppSessionPort::execute` (`rc.rs:761-818`) calls the steering entry and maps a
  `HostError` to a gate by message heuristics (`refusal_for`, `:845-863`): "turn" /
  "running" / "busy" → `in_flight`; anything else → `in_flight` with code
  `agent_error`; the message travels (cut to 500 chars, `wire.rs:414`). A 30 s execute
  deadline answers `in_flight` / `desktop_timeout` (`host.rs:967-985`).

---

## 3. Current state: the desktop picker UI and its rules

### 3.1 Where it lives

- `ComposerGroupsMenu` in `src/features/chat/components/message-input.tsx:324-712` — the
  agent+model pill (`:667-685`) and the mode pill (`:688-711`) share one morphing panel.
  It reads `acpCurrentMode`, `acpAvailableModes`, `acpModesPending`, `acpCurrentModel`,
  `acpAvailableModels` off the chat store (`:334-343`), falls back to the per-agent
  localStorage cache for ACP agents but **not** for the native agent (ADR-0007: an empty
  native list must be visible, `:412-427`), and hands `ModelPicker` one `PickerAgent`
  per switchable agent (`:434-442`).
- `ModelPicker` (`model-picker.tsx:193-634`): rail of agents, search (`searchScore`,
  `:112-132`), rows grouped by the **provider the agent stated** (never inferred from
  the id, `:1-15`), starred models pinned first, "Legacy models" fold (`agentEntries`,
  `:137-191`), keyboard chords. A pick on the current agent is `setAcpModel(tabId, id)`;
  on another agent it is "switch agent, then start on this model" (`:588-595`).
- The mode list renders `availableModes` generically with `displayModeName` and a colour
  dot (`:545-575`). One per-agent special case remains: `claude-code` tabs render
  `CLAUDE_PERMISSION_MODES` from `claudePermissionMode` instead of the ACP list
  (`:443, :517-543`; store `:1259-1290`), and `mode_changed` is mirrored into
  `claudePermissionMode` only for known ids (`chat-store.ts:2550-2563`). Everything else
  is capability-driven.
- Config options are a separate right-anchored pill, `ComposerOptionsPill`
  (`composer-options-pill.tsx`), always rendered (loading → "Options" + spinner, knobs →
  "Options", none → "Default"). `parseConfigOptions` (`src/features/chat/lib/acp-config-options.ts:105+`)
  turns the raw list into `boolean` / `select` knobs and **drops `category: "mode"` and
  `"model"` selects** because those have their own pills (`OWNED_ELSEWHERE`, `:58`);
  `modelSelectOf` is the matching reader for the model pill (`:180-204`).

### 3.2 Optimistic vs confirmed on the desktop

- **Mode:** `setAcpMode` writes `acpCurrentMode` at once, persists the preference, then
  `pushAcpModeToAgent` invokes `agents_set_mode`; a rejection **reverts** the label
  (unless the user picked again) and shows a `toast.error` with the agent's words
  (`chat-store.ts:165-202, 1340-1356`). This is where "mode can't change mid-turn" is
  shown.
- **Model:** `setAcpModel` writes `acpCurrentModel`, then `pushAcpModelToAgent`; a
  rejection is only `console.warn`ed — the pill can lie if the native selector refuses
  an unknown slug (`:250-258, 1496-1502`). The `model_changed` delta confirms it for
  ACP agents; for the native agent the reducer **ignores** `model_changed`
  (`:2665-2673`, a guard left from the BYOK `provider/model` re-push loop that
  `ProviderModelPills` used to cause and that is no longer mounted,
  `message-input.tsx:2121`).
- **Config option:** no optimistic write at all; the confirmed list arrives as
  `config_options_updated` from the set *response* (`:1372-1398`). An agent that
  disagrees is therefore never shown wrong.

### 3.3 Mid-turn rules

- The composer never disables the pickers while a turn runs. The restriction is the
  agent's: the native engine refuses `set_mode` mid-turn (§1.3) and the store reverts
  and toasts. ACP agents accept `session/set_mode` whenever they like.
- `set_model` is never refused for timing by Atlas: the native selector records it and
  the next turn runs on it (`send_meta` reads `record.current_model`, `steering.rs:561-575`);
  ACP agents apply it on their side.
- `set_config_option` likewise.

Remotely, the same refusals come back as `rc.command_result { refusedBy:"desktop",
gate:"in_flight", code:"in_flight" | "agent_error", message }` (§2.4) — so a remote
picker needs exactly the desktop's shape: optimistic flip, revert on refusal, show the
message.

### 3.4 Consent today

| rule | side | where |
| --- | --- | --- |
| steering is the Driver's alone, owner included (`stop` excepted) | relay, then desktop | `rc-do.ts:1465-1484`; `gate.rs:120-137` |
| `set_mode` / `set_model` / `set_config_option` need tier `steer` | relay | `rc.ts:888-895`, `rc-do.ts:1457` |
| `set_config_option` is members-only (a link Driver is refused `tier`) | relay | `rc.ts:903`, `rc-do.ts:1458` |
| kind must be in the advertised capabilities | desktop | `gate.rs:138-144` |
| non-owner `set_mode` to an id containing `bypass`, `full`, `yolo`, `danger`, `unrestricted`, `auto` → `widening` | desktop | `gate.rs:103, 145-152` |
| non-owner `set_config_option`, **any key** → `widening` | desktop | `gate.rs:153-160` |
| non-owner `answer_permission` with a standing option → `widening` | desktop (the side that knows the option kind) | `rc.rs:788-797` |

---

## 4. Design

Principles: additive wire only (new optional fields, no renamed or removed ones);
capability over identity (nothing branches on an agent id); the desktop decides consent
for what it alone understands; the web renders what the desktop advertises and never
guesses a list.

### 4.1 Data on the wire

**No new frame or command kind.** The snapshot already carries the lists; the three
existing deltas already carry changes. Changes:

1. **Snapshot fit order** (`crates/atlas-remote-control/src/snapshot.rs:19`): remove
   `config_options` from `EXPENDABLE`, or order the pass as `available_commands`,
   `subagents`, oldest messages, and only then `config_options`. The knobs are bounded
   (an agent's options are a handful of selects) and the whole point of the join
   snapshot is to be the viewer's source of what is pickable.
2. **Snapshot fields the web must read** (no desktop change): `available_models[]`,
   `available_modes[]`, `config_options[]`, `current_model`, `current_mode`, `plugin_id`.
3. **Deltas the web must fold** (no desktop change): `config_options_updated` →
   re-derive the model list via the `category: "model"` select *when the agent has no
   other list* (mirror of `modelSelectOf`), re-parse the knobs, and update the mode via a
   `category: "mode"` select for OpenCode-style agents; `model_changed` / `mode_changed`
   → the current value, resolved against the lists for display.
4. **Optional, later (additive):** `origin: Option<Origin>` on `ModeChanged`,
   `ModelChanged` and `ConfigOptionsUpdated` (`delta.rs:87, 98, 130`), stamped by the
   steering entry from the `Origin` it already has, so both the desktop pill and the web
   can say "Ada switched to Sonnet". Serde `skip_serializing_if = Option::is_none`; the
   TS union gains `origin?: Origin`; contract fixtures in
   `crates/atlas-agent-wire/tests/contract.rs:232-268` and
   `tests/wire-shape-contract.test.ts` gain the field. Not needed for the first slice.
5. **Hello / room model freshness (optional):** `HostConfig.model` could be re-read from
   `snapshot_meta` on each redial (`host.rs:628-636`), so the room list shows the model
   a joiner will see. Cosmetic.

### 4.2 Commands

Unchanged: `set_model { modelId }`, `set_mode { modeId }`, `set_config_option { key,
value }` (`rc.ts:855-875`; `wire.rs:278-309`). `key` is the ACP config option **id**
(`SessionConfigOption.id`), `value` is `true|false` for a boolean knob or the choice's
`value` id (string) for a select — exactly what `steering.rs:850-861` maps. The model
pick sends the model's `id` as the snapshot lists it (the native agent validates it
against the catalogue; an ACP agent receives it as its model select's value id).

### 4.3 Gates and consent — reconciling the plan with the built code

Plan `docs/research/universal-rc-api-plan.md` §5.4 (`:546-589`) and §11.1 gate 13
(`:1919-1945`) versus `gate.rs` / `rc.rs`:

| rule | plan | built | proposal |
| --- | --- | --- | --- |
| `set_model`, non-widening `set_mode` | Driver at tier `steer` (owner while Driver) | same | keep |
| `set_config_option` by a **member** Driver | allowed for "non-widening keys": a substring deny-list (`permission`, `approve`, `sandbox`, `bypass`, `network`, `trust`) **plus "unknown key → owner-only"** | **every** key refused `widening` for a non-owner (`gate.rs:153-160`) | implement the plan, using the ACP **category** as the "known key" signal (§4.3.1). Today a member cannot change a thinking level from their phone at all, which defeats the effort use case |
| `set_config_option` by a **link** Driver | refused `tier` at the relay (members-only) | same (`rc-do.ts:1458`) | keep |
| `set_mode` to bypass / full-access | **"desktop local UI only"** — nobody remote, the owner included; Claude Code's own rule ("you can't select Bypass permissions from the app", `docs/research/claude-code-remote-control.md:244-247`) | owner allowed remotely; non-owner refused `widening` (`gate.rs:145-152`; test `the_owner_steers_and_answers`, `:233-255`) | **decide.** Recommended: follow the plan — a widening mode is refused `widening` for *every* remote origin with the message "choose this on the desktop"; a phone that is left unlocked must not be able to un-sandbox the machine. The owner's remote standing grants (`rc.rs:792`) and config options stay as built (they are agent-scoped, not machine-scoped) |
| widening words | not specified beyond "bypass / full-access" | `bypass, full, yolo, danger, unrestricted, auto` (`gate.rs:103`) | keep (one ACP agent's `auto` genuinely auto-approves); add `dontask` / `dont_ask` for agents that advertise a "don't ask" mode; **move the list to a shared contract constant** (`RC_WIDENING_MODE_WORDS` in `packages/contracts/src/rc.ts`, transcribed in `wire.rs`, held equal by `tests/contract.rs:181-230`) so the web can pre-disable those rows instead of letting a member hit the refusal |

#### 4.3.1 Category-based config consent (desktop)

The relay cannot classify a key; the desktop can, because it holds the advertised
option. Two layers, the same split as `answer_permission` (`gate.rs` pure, `rc.rs` the
side that knows the option):

- `gate.rs` (pure): for a non-owner, refuse `SetConfigOption` when `key` matches the
  deny-list substrings (`permission`, `approve`, `sandbox`, `bypass`, `network`, `trust`,
  `yolo`, `danger`). Keep it a unit-tested table.
- `rc.rs` `AppSessionPort::execute`: for a non-owner, look the option up —
  new `AgentHost::config_option_category(&key, &config_id) ->
  Option<acp::SessionConfigOptionCategory>` reading
  `session_config_options().config_options()` — and allow only
  `ThoughtLevel | ModelConfig | Model`; `Mode`, `Other(_)`, and an option the agent no
  longer lists are refused `widening` ("only the owner may change this session's
  options"). Boolean knobs with no category stay owner-only (a "web search" toggle is
  `Other`). This is the plan's "unknown key → owner-only" with the agent's own semantic
  tag as the classifier — generic under ADR-0002.

### 4.4 Capabilities

- `rc_start`: derive `Capability::Model` / `Mode` / `Config` from the connection
  advertising the control, not from a non-empty list at that instant. Cheapest form: a
  small `AgentHost::session_controls(&key) -> SessionControls { modes, models, config }`
  (three `is_some()` checks on the connection), used at `rc.rs:279-288`. The gate's
  capability check (`gate.rs:138`) then matches what the agent can do for the room's
  life.
- The web uses `room.capabilities` (from the list query, already loaded) only as a
  pre-snapshot hint; once the snapshot is in, an empty list hides the control.

### 4.5 The web viewer

New file `apps/web/src/features/rc/rc-controls.tsx`, rendered inside `Composer`
(`rc.rooms.$roomId.tsx:290-351`) on the footer row before Stop / Send — on every width,
since the aside is hidden below `@4xl` (`:143`) and the composer is not.

**Transcript model.** Extend `RcTranscript` (additive, defaults in `emptyTranscript`):

```ts
models: Array<{ id; name; description: string | null; provider: string | null; legacy: boolean; isNew: boolean }>
modes: Array<{ id; name; description: string | null }>
options: Array<RcConfigOption>   // a port of the desktop's parseConfigOptions, keeping `category`
```

filled by `transcriptFromSnapshot` from `available_models` / `available_modes` /
`config_options`, and by `applyEnvelope` on `config_options_updated` (models from the
`category: "model"` select only when `available_models` was empty, so an ACP agent's
list never doubles; modes from a `category: "mode"` select; knobs always). `mode` /
`model` stay the ids; a `labelOf(list, id)` helper resolves names for the header and the
pills.

**Controls, one implementation each, both breakpoints:**

| control | widget (existing primitives, `apps/web/src/components/ui/`) | notes |
| --- | --- | --- |
| Model | `Select` with `variant="ghost"` trigger; `SelectGroup` per `provider` (the agent's stated grouping, as the desktop rail); a trailing "Legacy" group for `legacy` rows; `description` as a second line; `ModelBadge`'s family mark on the trigger | `select.tsx`; `model-badge.tsx` already maps ids to marks |
| Mode | `DropdownMenu` + `DropdownMenuRadioGroup` / `DropdownMenuRadioItem` with the description; widening ids (shared `RC_WIDENING_MODE_WORDS`) rendered **disabled** with "Desktop only" (or "Owner only" if the owner decision in §4.3 keeps the built behaviour) | `dropdown-menu.tsx:31, :175` |
| Options | `DropdownMenu`: a `DropdownMenuSub` per select knob (radio items), a `DropdownMenuCheckboxItem` per boolean; owner-only categories disabled with "Owner only" for non-owners; hidden for link visitors (members-only at the relay) | `dropdown-menu.tsx:105-175` |

Mobile: base-ui popups are touch-usable, but a long model list on a phone reads better
as a bottom sheet. The app has no `useIsMobile`; `mesh-stage.tsx:156-159` shows the
house pattern (`window.matchMedia` in `useSyncExternalStore`-style state). Proposal: a
`ChoicePicker` component with one props shape `{ label, groups, current, pending,
disabledReason, onPick }` that renders the `Select` / `DropdownMenu` above 640 px and a
`Sheet side="bottom"` (`sheet.tsx:37-78`) with 44 px rows below it. Same data, same
handlers, one test surface.

**Enablement** (per control, in this order; each yields the disabled reason shown as
the trigger's title / sheet footer):

1. `steerBlock(live, offline, directory) === null` (`rc.rooms.$roomId.tsx:250-263`) —
   Driver, connected, owner online.
2. `rcTierAllows(you.tier, kind)` (`rc.ts:906`).
3. `set_config_option`: `you.principal.kind === "user"`.
4. list non-empty (snapshot) — or, before the first snapshot, `room.capabilities`
   includes the kind.
5. not pending (one setting command in flight per control).

**Optimistic vs confirmed.** A small `useSettingCommand(live, kind)` hook:

- `pick(value)` → `live.send({kind, …})`; on `ok:false` (not connected / too big) show
  the reason inline; else hold `pending = { commandId, value }`, render the picked value
  dimmed with a `Spinner`, disable the control.
- Watch `live.commands` for that `commandId`:
  - `accepted` → clear pending. Treat as confirmed: the `model_changed` delta follows
    for a model, `config_options_updated` for a knob, and `mode_changed` follows for a
    mode **unless it was already current** (the host deduplicates, `projector.rs:868-874`)
    — so never wait on the delta.
  - `refused` → clear pending, keep the transcript's value, show `message` in the
    footer line (the existing `commandLine`, extended with nouns "Model" / "Mode" /
    "Option", `rc.rooms.$roomId.tsx:272-288`); branch wording on `gate` / `code`:
    `in_flight` → "while a turn is running"; `widening` → "only from the desktop /
    owner"; `agent_error` → the agent's words; `tier` / `not_driver` as today.
  - `no_answer` (`relay_timeout`) → clear pending after the 30 s deadline, show
    "No answer from the desktop yet", and let the next delta or snapshot decide.
- A `model_changed` / `mode_changed` / `config_options_updated` that arrives while
  pending with a *different* value (someone else changed it) wins and clears pending.

**Header.** Replace the mono ids (`:111-123`) with the resolved names and the
`ModelBadge` mark; keep the ids as `title`.

### 4.6 Desktop corrections surfaced by this review

1. `chat-store.ts:2665-2673` — stop ignoring `model_changed` for the native agent, or
   accept it when `model_id` is in `acpAvailableModels`. As written, a remote
   `set_model` on a native session runs the next turn on the new model
   (`steering.rs:824-826`) while the desktop pill keeps the old one. Verify
   `setNativeModel` has no mounted caller first (`ProviderModelPills` is not rendered,
   `message-input.tsx:2121`).
2. `chat-store.ts:250-258` — `pushAcpModelToAgent` swallows a refusal; mirror
   `revertRefusedMode` so a refused model pick reverts and toasts like a mode does. Not
   RC-specific, but the remote picker will be held to that standard and the desktop
   should match.
3. `rc.rs:845-863` `refusal_for` — "unknown session" currently maps to `not_pending`;
   after a native catalogue refresh drops the connection (§1.3) every command on the
   room fails that way. Map it to `room_closed`-like wording or add a code
   (`session_gone`) so the web can say "the desktop restarted this session". Edge case;
   note only.

---

## 5. Per-repo file change list

### 5.1 `atlas` (desktop)

| file | change |
| --- | --- |
| `crates/atlas-remote-control/src/snapshot.rs` | `config_options` out of `EXPENDABLE` (or last); test that a trimmed snapshot keeps it |
| `crates/atlas-remote-control/src/gate.rs` | non-owner `SetConfigOption`: deny-list on `key` instead of blanket refusal; widening-mode rule applied to every remote origin (if §4.3 is decided that way); words from `wire.rs` |
| `crates/atlas-remote-control/src/wire.rs` | `pub const WIDENING_MODE_WORDS` transcribed from the server contract (+ `dontask`) |
| `crates/atlas-remote-control/tests/contract.rs` + `tests/fixtures/rc-frames-v1.json` | hold the word list equal to the server's `rcConstants` |
| `src-tauri/src/commands/rc.rs` | `execute`: category check for non-owner `SetConfigOption` via `AgentHost::config_option_category`; `rc_start`: capabilities from `session_controls`; optional `refusal_for` code for "unknown session"; hello model refresh (optional) |
| `src-tauri/src/commands/agent_host.rs` / `agent_host/steering.rs` | `config_option_category(key, config_id)`, `session_controls(key)`; optional `origin` stamping on `note_mode_changed` / `note_model_changed` / `note_config_options` |
| `crates/atlas-agent-delta/src/projector.rs`, `crates/atlas-agent-wire/src/delta.rs`, `src/types/agents.ts` | only if the optional `origin` field is taken (additive) |
| `src/features/chat/stores/chat-store.ts` | §4.6 items 1–2 |
| `docs/research/universal-rc-api-plan.md` §5.4 / §11.1 | record the decided owner-remote-bypass rule and the category classifier |

### 5.2 `server`

| file | change |
| --- | --- |
| `packages/contracts/src/rc.ts` | `RC_WIDENING_MODE_WORDS` + `rcConstants.wideningModeWords`; regenerate `fixtures/rc-frames-v1.json` |
| `apps/ingest/test/rc-wire.test.ts` | the fixture-equals-code assertion covers the new constant (existing mechanism) |
| `apps/web/src/features/rc/rc-transcript.ts` | `models` / `modes` / `options` on `RcTranscript`; snapshot reader; `config_options_updated` fold; `labelOf` |
| `apps/web/src/features/rc/rc-config-options.ts` (new) | port of `parseConfigOptions` / `modelSelectOf` / `modeSelectOf`, keeping `category` |
| `apps/web/src/features/rc/rc-controls.tsx` (new) | `SessionControls`, `ChoicePicker` (popup / bottom sheet), `useSettingCommand` |
| `apps/web/src/routes/_app/rc.rooms.$roomId.tsx` | mount the controls in `Composer`; header labels via `labelOf` + `ModelBadge`; `commandLine` nouns for the three kinds |
| `apps/web/src/lib/use-rc-room.ts` | none required (`commands` already carries what the hook needs); optionally expose `pendingOf(commandId)` |

No relay (`rc-do.ts`) change: the gates it applies are the right ones.

---

## 6. Tests

### 6.1 `atlas`

- `gate.rs` unit tests: a member Driver may set a key not on the deny-list; `permission`
  / `sandbox` / `network` keys are `widening`; `bypassPermissions`, `full-access`,
  `dontAsk` are `widening` for the chosen set of origins; the owner's `plan` passes.
- `rc.rs` tests: `config_option_category` classification — `thought_level` allowed for
  a non-owner, `Other` / missing refused `widening`, owner always allowed; `refusal_for`
  unchanged for the mid-turn message (existing test `:870-889`).
- `snapshot.rs`: a long transcript still carries `config_options`,
  `available_models`, `available_modes` after trimming.
- `crates/atlas-remote-control/tests/contract.rs`: the widening-word list equals the
  server fixture (extend `the_constants_and_codes_agree`, `:218`).
- `steering.rs` integration (existing `GatedNative` fixture, `:997-1080`): a remote
  `set_model` announces `model_changed`; a remote `set_mode` mid-turn comes back as an
  error whose message contains "turn".
- `chat-store` vitest: `model_changed` on a native session updates `acpCurrentModel`;
  a refused `agents_set_model` reverts and toasts.
- If the optional `origin` field is taken: `crates/atlas-agent-wire/tests/contract.rs`
  golden JSON and `tests/wire-shape-contract.test.ts` field lists.

### 6.2 `server`

- `apps/ingest/test/rc-commands.test.ts`: already covers relay refusal of
  `set_config_option` from a link principal, the 8 KiB value cap (`:131-136`), the
  Driver-only rule for `set_mode` / `set_model` (`:316-320`) and the desktop `widening`
  echo (`:110-128`). Add: `modelId` / `modeId` / `key` land in the audit detail.
- `apps/web/src/features/rc/rc-transcript.test.ts`: the snapshot fills `models` /
  `modes` / `options` with names, providers and `legacy`; `config_options_updated`
  re-derives the model list only when the snapshot carried none, re-parses knobs, and
  mirrors an OpenCode-style mode select; `model_changed` with an id absent from the list
  still sets `model` (defensive reader).
- `apps/web/src/features/rc/rc-controls.test.tsx` (new): disabled with the right
  reason for a visitor, a non-driver, an offline owner, a link principal on Options,
  a member on an owner-only category, a widening mode; optimistic pick → `accepted`
  clears pending; `refused` reverts and shows the message; `no_answer` releases after
  the deadline; a foreign `model_changed` while pending wins; the bottom sheet renders
  below 640 px with the same rows.
- `apps/web/src/lib/use-rc-room.test.tsx`: nothing new unless `pendingOf` is added.

---

## 7. Open points to decide before building

1. **Owner + bypass from a remote surface** (§4.3): plan and Claude Code say never;
   built code says the owner may. Recommendation: never.
2. **Which categories a member may set** (§4.3.1): proposed `ThoughtLevel | ModelConfig
   | Model`; `Mode` stays on `set_mode`'s rule; everything else owner-only.
3. **Native catalogue refresh while a room is open** (§1.3, §4.6.3): the connection
   drop forgets the session; the room's port goes stale. Out of scope here; flag the
   message.
4. **`origin` on the change deltas** (§4.1.4): worth taking in the same slice if the
   web is going to show "Ada switched the model" — it is three optional fields and two
   contract fixtures.
