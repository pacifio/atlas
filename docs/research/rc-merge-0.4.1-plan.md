# Plan: merge the Universal RC work into 0.4.1

Status: **steps 0–5 done on `feat/universal-rc-0.4.1`** (2026-11-01: `24611ee3` apply,
`b93f070c` wire, `9e325634` host, `3a734d10` store/libs/mocks, `5918203f` UI; hooks
green on the last). Step 6's `ci:local` and the `dev:app` run are what remain; the
server half is still uncommitted in `~/Codes/server`. Originally: The RC desktop work is `stash@{0}`
("feat/universal-rc WIP (RC work) 2026-11-01"), based on `9ef484d0`; `0.4.1` is 424
commits ahead (UI overhaul, sidebar rewrite, PR-watch wakes, sleep watch, reqwest 0.13).

Researched against `e92a1a15`; re-checked against `4d4d9f43` (#527, the slash-picker
freeze fix): the conflict set is identical and the three `message-input.tsx` blocks are
unchanged, but the pre-resolved copy of that one file in `.scratch/rc-merge/resolved/` is
stale (it lacks #527) — resolve it by hand from the plan, don't copy it.

The research was a trial `git stash apply` onto `0.4.1` in a throwaway worktree, read
by three agents (Rust + wire, header/sidebar/panel UI, store/libs/mocks). The
store/mocks half was resolved and verified (typecheck both tsconfigs, vitest, oxlint)
in a scratch copy; the other two halves are read-only analysis — nothing compiled.
Full per-block notes are the appendices; ready-to-copy resolutions of the 21
store/mocks files are in `.scratch/rc-merge/resolved/` (local only, never commit).

## Size

|                                | count                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| RC tracked changes             | 61 files (+3679 / −751)                                                             |
| RC new files                   | 75 (+25.9k lines, ~half research docs)                                              |
| merge cleanly                  | 36                                                                                  |
| conflict                       | 25 files, ~70 blocks                                                                |
| deleted upstream, edited by RC | 3 (`chat-header.tsx`, `session-sidebar.tsx`, `chat-panel-overview-margin.test.tsx`) |
| breaks git does not report     | ~15 (listed below)                                                                  |

Wire contract: **no collisions.** Both sides are additive (0.4.1: `slept_mid_turn`,
turn timing, three `Message` fields; RC: `user_message`, `queue_changed`,
`hold_changed`, optional `origin`, `envelope.seq`).

## Decisions (settled 2026-11-01)

1. **Where "Start remote control" lives.** 0.4.1's `session-header-order.test.tsx`
   locks the title bar to "Details, plus pins only while pinned". **Decided:** the RC
   status pill joins the title bar **only while a room is open** (same rule as pins —
   test stays green); **Start** becomes a row in the Details card
   (`session-details-card.tsx`, after `<ActivitySection>`). Accepted gap: in a wide
   window the Details card is not drawn on an empty session, so a room is started
   after the first prompt. (A command-palette action can be added later.)
2. **Atlas-sent prompts while a remote driver holds the seat** (PR-watch wakes,
   restart continuation). **Decided:** `PromptOrigin::Atlas` bypasses the seat check
   in `steering.rs::dispatch`; not queued.
3. **Atlas-sent prompts are not announced as `user_message`.** Otherwise the window
   draws a wake twice (0.4.1's `addInjectedPrompt` + the delta). **Decided:** no
   `stamp_user_message` for Atlas-origin prompts; they still appear in snapshots.
4. **Queued prompts and pasted text.** **Decided:** inline the text (0.4.1's
   behaviour, see step 3); the queue stays text-only. A `pasted_texts` param is a
   later slice.
5. Still open from the 2026-10-25 review (not merge blockers): QR code, the
   widening-mode denylist vs allowlist, invites for non-cloud-bound projects.

## Steps

### 0. Branch and apply

```bash
git switch -c feat/universal-rc-0.4.1 0.4.1
git stash apply stash@{0}        # apply, NOT pop — the stash survives a bad attempt
```

Then remove what must not ship with RC (unrelated or scratch):
`.scratch/rc-release/`, `vendor/atlas-engine/PERF-FIX-PLAN.md`,
`vendor/atlas-engine/docs-architecture-diagrams.md`, `vendor/atlas-engine/diagrams/`,
`crates/atlas-acp-thread/diagrams/`, `crates/atlas-acp-thread/acp-subsystem-map.mmd`.
Keep a copy outside the repo if any is wanted later. `.scratch/` is **not** gitignored.

### 1. Wire and delta crates

- `contract.rs`, `projection.rs`, `wire-shape-contract.test.ts`: keep both (both
  appended at the tail — 0.4.1's tail, then RC's).
- `projector.rs`: RC's user-message match, then 0.4.1's approximate-time marking.
- Add 0.4.1's three new `Message` fields to RC's struct literals:
  `projector.rs` ~942 (`announced_messages`), ~1899 (`user_message_delta`),
  `contract.rs` ~363 (`sample_user_message`).
- **Silent regression fix:** RC's `announced_messages` snapshot path skips 0.4.1's
  turn timing, so "Worked for" / "Stopped after" vanish after reload. Make
  `stamp_turns` `pub(crate)`, apply it (and per-entry marking) in
  `announced_messages`, and add a test that both snapshot paths agree after a
  finished turn.
- Check: `cargo test -p atlas-agent-wire`, `cargo test -p atlas-agent-delta`.

### 2. Rust host (`agent_host.rs`, `agents.rs`, `mod.rs`) — the hard part

- **Send path** (agent_host block 4, agents block 3): RC moved `send` into
  `steering.rs::dispatch`; 0.4.1 grew model refresh, open-turn books, held wakes,
  failure notes and `send_prompt(.., OutgoingPrompt, PromptOrigin)` (called from
  `pull_request_watch.rs` and restart continuation). Port 0.4.1's additions into
  `dispatch`; add `pastes` + `from_atlas` to RC's `Prompt`, `from_atlas` to
  `PromptSent`; keep `send_prompt` as a thin wrapper over `submit`; RC's prompt
  hooks call 0.4.1's `record_prompt`; drop `note_interaction` at steering.rs ~743 so
  Atlas-sent prompts don't count as interaction. Apply decisions 2 and 3 here.
- **Stop / settings** (agent_host block 5, agents block 4): take RC's (origin-aware)
  side, then add 0.4.1's `forget_wakes` + `end_pull_request_watches` to `stop`, add an
  `interrupt` to steering.rs, add `refresh_model` to `set_model`.
- **One `agents_cancel`:** the trial has two (agents.rs ~2606 and ~2620) — fails
  ipc-contract "exactly once". Keep 0.4.1's `stop: Option<bool>` signature plus RC's
  queue discard.
- **`agents_send`** takes both `pasted_texts` and `client_message_id`.
- **`resume_thread`** (block 6): `unarchive()` no longer exists — keep
  `reclaim_for_window`, drop the call.
- `ThreadRow` (block 8): keep 0.4.1's fields + RC's `held_working`.
- `install_manager`: manage `DeltaTaps` **before** `TauriDeltaSink::new`, or startup
  panics.
- Everything else (blocks 1–3, 7, 9, 10, `mod.rs`, imports): keep both; `pub mod rc;`
  stays.
- Breaks git didn't flag: `sleep_watch.rs` ~279/~338 need `seq`; `wake.rs` tests
  ~468/~531 call removed `host.send`, ~544 `host.stop` needs an origin.
- `crates/atlas-remote-control`: bump reqwest 0.12 → 0.13
  (`features = ["json", "rustls"]`), regenerate the lock.
- Sleep notices are emitted with `seq: 0`; make sure RC's room host
  (`host.rs` ~810) and the frontend `seq <= as_of_seq` filter don't drop them.
- Check: `cargo test -p atlas-remote-control`, `cargo check -p atlas`,
  `cargo test -p atlas --lib steering wake sleep_watch prompt_books agent_host`.

### 3. Chat store and libs (resolutions verified in scratch)

- New `src/features/chat/lib/queued-text.ts`: `inlineQueuedText(text, mentions)` =
  0.4.1's `withReviewCommentsInline(withCitesInline(withPastesInline(…)))`. It is
  **not idempotent** — run it exactly once per prompt.
- `chat-store.enqueueMessage(sessionId, text, mentions, id = null)` stores inlined
  text; `addMessage` keeps 0.4.1's `trustedMentionPaths` 5th param **and** RC's
  returned id.
- `turn-queue.enqueuePrompt(tabId, text, mentions)`: raw text + mentions to the store,
  `inlineQueuedText` to Rust. Already-inlined re-queues pass `[]`
  (`takeQueuedPrompts`, retry, `flushLocalQueue`).
- `chat-store.ts` ~3018: `"New Chat"` → `UNTITLED_SESSION` (else a remote driver's
  first prompt never titles the session; two steering tests fail).
- `agents-api.ts`: `send(…, pastedTexts?, clientMessageId?)`; 0.4.1's
  `cancel(key, { stop })` + RC's queue methods and `setHold`.
- `retry-turn.ts` ~202: `agents.send(key, prompt, undefined, undefined, undefined, clientMessageId)`.
- message-input (**by hand, not from `resolved/` — see status note above**): the
  `/queue` block and the running-send block keep 0.4.1's shape (`getMentions`,
  `forgetSentTexts`, `writeComposer("")`) and call `enqueuePrompt(tabId, text, mentions)`;
  the queue-edit block keeps 0.4.1's collapse-cites/pastes + `writeComposer` and calls
  `removeQueuedPrompt(tabId, i)`.
- transcript (add `!remoteDriving &&` to `canContinue`), transcript-rows,
  switch-agent, close-tab: per appendix C.

### 4. Mock backend

- Keep both in `misc.ts`, `base.ts`, `types.ts`, `northwind-misc.ts`; `fake-agent.ts`
  destructures `pastedTexts, clientMessageId`.
- Add `heldWorking: false` to 0.4.1-only ThreadRow literals
  (`scenarios/sidebar.ts`, `session-context.ts`, `session-projects.ts`).
- Add an `agents_set_hold` fake (emits `hold_changed`) — 0.4.1's
  mock-backend-contract requires every invoked command to be answered.

### 5. UI: re-home the RC header (needs decision 1)

- Delete `chat-header.tsx`, `chat-panel-overview-margin.test.tsx` (0.4.1 asserts the
  opposite), `chat-header-empty.test.tsx`. RC's `empty` header mode is dropped:
  0.4.1 already shows the header controls on the welcome screen.
- New `RcHeaderMenu` rendered before `<ChatPinnedMenu>` in `session-header.tsx`;
  `SessionHeaderControls` gets an `acpSessionId` prop from ChatPanel; title via
  `sessionDisplayTitle(...)`. Trigger copies `chat-pinned-menu.tsx`'s ghost
  `Button`; menu copies `SurfaceAdd`'s `DropdownMenu` (`center-panel.tsx`).
- New `RemoteControlSection` in the Details card, built from `DetailsSection` /
  `DetailsRow` like `activity-section.tsx`.
- `chat-panel.tsx` (9 blocks): `enqueuePrompt(tabId, actualContent, mentions)` ×4;
  `const clientMessageId = addMessage(…, trustedMentionPaths(mentions))` ×2;
  `agents.send(key, wirePrompt, attachments, resourceLinks, pastedTexts, clientMessageId)`;
  block 8 → take 0.4.1's side verbatim, delete RC's (it only references removed
  things), add `acpSessionId` to the portal; block 9 → 0.4.1 + `remoteDriver`.
  Also ~732 (auto-merged, wrong arity) → `enqueuePrompt(tabId, held.content, held.mentions ?? [])`.
- Sidebar: `session-sidebar.tsx` is gone. `snapshotLive(snapshot)` →
  `open-thread.ts` ~203; `heldWorking` → `SidebarSession`, `resolveSessionRowStatus`,
  `session-row.tsx`.
- Lint: `rc-status-pill.tsx` raw `<button>` with the old header's classes →
  `<Button variant="ghost" size="sm">` (else shadcn `no-restyle`); RC's raw
  `DropdownMenu.Item` → `@/ui/dropdown-menu`; drop redundant `disabled:opacity-50` in
  `rc-driver-bar.tsx`. Ratchet regexes found nothing banned.
- Copy: "take over from the chat header" → "take over at the composer"
  (`session-elicitation.tsx`, `elicitation-modal.tsx`); "(More menu)" in
  `rc-status-pill.tsx`.
- New tests: `rc-header-menu.test.tsx`, `remote-control-section.test.tsx`, a with-room
  case in `session-header-order.test.tsx`; stub the section in
  `session-details-card.test.tsx`. Fix old arity in `chat-store.steering.test.ts`;
  add `remoteAuthor: null` in `message-footer.test.ts`.

### 6. Verify

```bash
bun run typecheck
bun run test src/features/chat src/features/sidebar src/features/session-context src/dev
bun run test tests/                       # contracts: ipc, event, wire-shape, mock-backend, ratchet, rc-fixture-parity, cargo-workspace, ci-affected
bun run lint && bun run format:check
cargo test -p atlas-agent-wire -p atlas-agent-delta -p atlas-remote-control
cargo test -p atlas --lib
bun run ci:local                          # before the PR
```

Then a real `bun run dev:app` run: start a room, steer from the phone viewer, hand
over / take back, reload mid-turn ("Worked for" survives), a PR-watch wake while a
remote driver holds the seat.

### 7. Afterwards

- The server half (`~/Codes/server`, `feat/universal-rc`, 65 uncommitted changes)
  must land before RC does anything end-to-end.
- `docs/research/universal-rc-api-plan.md` is superseded by the decision audit — ship
  it marked as such or drop it.
- Drop `stash@{0}` only once the branch is committed.

## Appendix A — Rust and wire (agent notes)

Line numbers are into /tmp/rc-trial as it stands now, with the conflict markers still in.
"ours" means 0.4.1 (Updated upstream). "theirs" means RC (Stashed changes).

## Conflicted files, block by block

### crates/atlas-agent-delta/src/projector.rs (1 block)

- **1255–1279 `sync_entries`.** 0.4.1 added `if thread.entry_time_approximate(ix) { mark_time_approximate(&mut new) }` after `project_new`. RC replaced the `project_new` call with a `match` that pops a `pending_users` stamp and emits `user_message_delta` for `UserMessage` entries. **Rewrite:** keep RC's `match` whole, then add 0.4.1's `if thread.entry_time_approximate(ix) { mark_time_approximate(&mut new); }` before `drop(thread)`.
- **Compile breaks that git merged without a conflict:** 0.4.1 added `timestamp_approximate`, `worked_ms` and `stop_reason` to `Message` with no `Default`, so every struct literal must name them.
  - `announced_messages` at **942–953**: add `timestamp_approximate: thread.entry_time_approximate(ix), worked_ms: None, stop_reason: None`.
  - `user_message_delta` at **1899–1910**: add `timestamp_approximate: false, worked_ms: None, stop_reason: None`.
- **A regression that fails silently (must fix).** With a projection present, `AgentHost::build_snapshot` (agent_host.rs ~1757) serves `projected.messages`, which come from RC's `announced_messages`. That function copies `snapshot_messages` but misses two things 0.4.1 added:
  - the per-entry `timestamp_approximate` marking;
  - `stamp_turns`, which puts `worked_ms` and `stop_reason` on each turn's last assistant message.

  The effect: "Worked for" / "Stopped after" and the replay-time marker vanish on reload. No current test catches it, because 0.4.1's tests call `project::snapshot_messages` directly. **Fix:**
  1. In crates/atlas-agent-delta/src/project.rs, make `stamp_turns` `pub(crate)`.
  2. In `announced_messages`, build the same `entry_of` vector (`let before = out.len()` per entry, then resize) and mark `timestamp_approximate`.
  3. End with `project::stamp_turns(&mut out, &entry_of, thread.turns())`.
  4. Add a test asserting that `projector.snapshot(.., true, ..).messages` equals `project::snapshot_messages` after a finished turn.

### crates/atlas-agent-delta/tests/projection.rs (2 blocks, 2129–2451 and 2456–2755)

- Both sides only appended tests after `ordinary_tool_calls_announce_no_subagent` (base line 2063). Git interleaved the two tails.
  - 0.4.1's tail (286 lines): tool-call and turn timing, the late-stop test, "terminal drained late".
  - RC's tail (349 lines): `user_text`, `seqs`, stamped prompts, dense seq, snapshot-as-of-seq, pending permission and elicitation, mode said once.
- **Resolution:** replace both blocks with 0.4.1's full tail followed by RC's full tail. The quickest way is to rebuild from `git show 0.4.1:<file>` plus the tail of `git show 'stash@{0}:<file>'` from line 2084 on, keeping RC's three earlier hunks (13, 224, 606/641, 1108), which merged cleanly.
- No API drift: RC's tests match on `TurnFinished { .. }`, and the 0.4.1 tests make no 2-arg `note_model_changed` calls.

### crates/atlas-agent-wire/tests/contract.rs (1 block, 835–888)

- 0.4.1 added omission checks for the `TurnFinished` timing fields and the `Message` timing fields. RC added omission checks for `UserMessage.client_message_id` and for `origin` on mode, model and config. **Keep both**, 0.4.1's first.
- **Compile break outside the block:** `sample_user_message()` at **362–377** is RC's `Message` literal. Add `timestamp_approximate: false, worked_ms: None, stop_reason: None`. The golden is unchanged, because all three are skipped when unset.
- The auto-merged tables already list every variant (`contract_kind` 116–148, `expected` 47–99, goldens 537–691), including `slept_mid_turn`, `user_message`, `queue_changed` and `hold_changed`. Nothing more to do there.

### tests/wire-shape-contract.test.ts (1 block, 471–1015)

- Both sides appended `describe` blocks after the same `it`:
  - 0.4.1: slept_mid_turn #9, timing #10, comments #11, cite #12, review chip #12, pull requests #13, attached projects #14, linked PRs #15.
  - RC: "Universal RC: the room" #10, "RC groundwork" #9.
- **Resolution:** the 0.4.1 block, then `  });\n});\n\n` to close its last `it` and `describe`, then the RC block, then the existing shared trailer.
- Optionally renumber RC's two describes to #16 and #17. The current #9 and #10 now collide with 0.4.1's labels; this is cosmetic only.
- RC's test at ~1000 checks for `pub async fn agents_send(… client_message_id: Option<String>`. That still holds with `pasted_texts` added before it.

### src-tauri/src/commands/mod.rs (1 block, 79–87)

- 0.4.1 added `project_settings`, `project_sources`, `pull_request_watch`, `pull_requests` and `quit_guard`. RC added `rc`. **Keep both**, with `pub mod rc;` after `quit_guard`.

### src-tauri/src/commands/agents.rs (4 blocks)

1. **38–42 import.** 0.4.1 has `prompt::{self, ImageAttachment, PastedText, ResourceLinkSpec}`. RC dropped `self`. **Rewrite:** `use atlas_acp_thread::prompt::{ImageAttachment, PastedText, ResourceLinkSpec};`. Keep `self` only if `send_prompt` still composes content.
   - If you keep 0.4.1's `AppBooks::interaction` (see block 3), also re-add `use agent_client_protocol::schema::v1 as acp;`. RC removed it, and 0.4.1 code at ~2376 uses `acp::`.
2. **1005–1014 `install_manager`.** 0.4.1 builds the `SleepWatch`, manages it, and passes it to `TauriDeltaSink::new(app, sleep_watch)`. RC manages `DeltaTaps` before `TauriDeltaSink::new(app)`. **Keep both, in this order:** `let sleep_watch = …; app.manage(sleep_watch.clone()); app.manage(Arc::new(DeltaTaps::default())); let sink = Arc::new(TauriDeltaSink::new(app.clone(), sleep_watch));`.
   - `DeltaTaps` must be managed **before** the sink is built. The merged `TauriDeltaSink::new` at 107–152 calls `app.state::<Arc<DeltaTaps>>()`, which panics otherwise.
3. **2219–2531 `agents_send` and the send path. DANGEROUS.**
   - 0.4.1 added `pasted_texts: Option<Vec<PastedText>>` and moved everything into `send_prompt(app, host, key, OutgoingPrompt, PromptOrigin)`. That path goes through `record_prompt` with `PromptBooks` / `AppBooks`, skips `note_interaction` for `PromptOrigin::Atlas`, applies `prompt::with_pasted_texts(.., host.prompt_embedded_context(key)?)`, and ends with **`host.send(key, content)`**.
   - RC replaced all of it with `host.submit(key, Prompt, Origin::Local, SubmitPolicy::Now)` plus `AppPromptHooks`, and **removed `AgentHost::send`** (agent_host.rs block 4).
   - 0.4.1 code outside the conflict calls this API:
     - `pull_request_watch.rs:68,829` calls `send_prompt(.., OutgoingPrompt::text(..), PromptOrigin::Atlas)`. This is the wake delivery; `restart_continuation.rs:85` reaches it through `host.wake`.
     - `agents.rs:3541–3660` holds the `prompt_books_tests` for `record_prompt`.

   **Rewrite:**
   - `agents_send(key, text, attachments, resource_links, pasted_texts, client_message_id, host)` builds `Prompt { text, display: None, images, resource_links, pastes: pasted_texts.unwrap_or_default(), client_message_id, from_atlas: false }` and calls `host.submit(&key, prompt, Origin::Local, SubmitPolicy::Now)`.
   - Keep 0.4.1's `PromptOrigin`, `OutgoingPrompt`, `PromptBooks`, `PromptMeta` and `record_prompt` (its tests stay valid).
   - Keep `send_prompt` as a thin wrapper: `host.submit(key, Prompt { text, images, resource_links: links, pastes, from_atlas: origin == PromptOrigin::Atlas, ..Default::default() }, Origin::Local, SubmitPolicy::Now)`.
   - `AppPromptHooks::prompt_sent` calls `record_prompt(&AppBooks { app, host: &app.state::<Arc<AgentHost>>() }, …, if sent.from_atlas { Atlas } else { User })`.
   - Then **delete** the `history.note_interaction` call in `steering.rs:743–745`, so interaction is recorded once and still skipped for wakes.
   - Drop RC's own inline hook body.

4. **2599–2721 `agents_cancel`.**
   - 0.4.1 is `agents_cancel(key, stop: Option<bool>)`: `host.stop(&key)` when `stop`, otherwise `host.interrupt(&key)`. The 0.4.1 frontend sends `stop`.
   - RC is `agents_cancel(key)` calling `host.stop(&key, Origin::Local)`, plus 7 new commands: `agents_queue_add/remove/clear/pause/drain/send_now` and `agents_set_hold`.
   - **Rewrite:** keep 0.4.1's signature, with the `stop` arm calling `host.stop(&key, Origin::Local)` and the other arm `host.interrupt(&key)`. Then keep all of RC's new commands below it.

### src-tauri/src/commands/agent_host.rs (10 blocks)

1. **61–78 modules.** 0.4.1 has `mod open_turns; mod wake; pub use OpenTurn, PendingWake, WakeSource`. RC has `mod steering;` and the re-exports. **Keep both.**
2. **518–558 `AgentHost` fields.** 0.4.1 added `access_requests`, `wakes` and `open_turns`, plus the `type AccessAnswer`. RC added `turns`, `prompt_hooks`, `seats`, `session_end_observers`, plus `type SessionEndObserver`. **Keep both:** all seven fields in one struct, then both type aliases after the closing `}`.
3. **712–721 constructor.** **Keep both** field initialisers.
4. **1801–1915 `send` versus `default_model`. DANGEROUS.**
   - 0.4.1 rewrote `AgentHost::send`. It added `refresh_model`, `open_turns.begin/end` (with a superseded check), `drain_wakes_later` after the turn, and `history.note_failure` before `note_turn_failed`. It also added `take_left_open_turns` and `expect_continuation`.
   - RC deleted `send`, moving it into `steering.rs::dispatch` (724–816), and added `default_model`.
   - **Resolution:** take RC (no `send`) plus `default_model`, keep 0.4.1's `take_left_open_turns` and `expect_continuation`, and **port 0.4.1's additions into `steering.rs::dispatch`**:
     - after `refresh_branch` (~763): `self.refresh_model(&acp_id);` and `let thread = self.history().and_then(|h| h.thread_for(&acp_id)); if let Some(t) = thread { self.open_turns.begin(t); }`;
     - in the spawned task after `end_atlas_turn`: the superseded check followed by `open_turns.end(thread)`, then `this.drain_wakes_later(&session_key);`;
     - in the current-turn failure arm, before `note_turn_failed`: `if let Some(h) = this.history() { h.note_failure(&acp_id, Utc::now()); }`;
     - content: `prompt::with_pasted_texts(prompt::with_resource_links(prompt::compose(text, images), links), prompt.pastes, embedded)`, where `embedded = !pastes.is_empty() && self.prompt_embedded_context(..)?`;
     - add `pastes: Vec<PastedText>` and `from_atlas: bool` to `steering::Prompt` (it derives `Default`, so every `..Prompt::text(..)` site still compiles), and `from_atlas` to `PromptSent`.
5. **2130–2243 `cancel`, `stop`, `interrupt` and the settings verbs. DANGEROUS.**
   - 0.4.1 has `cancel(&key)`; `stop(&key)`, which calls `forget_wakes`, then `end_pull_request_watches`, then cancel; `interrupt(&key)`, which calls `forget_wakes` then cancel; and the 2-arg `set_mode`, `set_model` (now calling `refresh_model`) and `set_config_option`.
   - RC moved stop and the settings verbs to steering.rs with an `origin` parameter.
   - **Take RC** (the comment stub). Then:
     - in `steering.rs::stop` (558), add 0.4.1's `forget_wakes` and `end_pull_request_watches`, _before_ `discard_queue` and `cancel_turn`;
     - add `pub fn interrupt(&self, key) -> Result<()> { self.forget_wakes(..); self.cancel_turn(..); Ok(()) }` to steering.rs;
     - in `steering.rs::set_model`, add `self.refresh_model(&session_id);` after `note_model_changed`;
     - drop `cancel` (no remaining callers).
6. **2464–2469 `resume_thread`.** 0.4.1 has `lock(&self.sessions).contains_key(..)`. RC has `self.reclaim_for_window(..)` plus `history.store().unarchive(thread_id)`. **Rewrite:** `if self.reclaim_for_window(session_id.0.as_ref()) {` **without** `unarchive`. `ThreadMetadataStore::unarchive` no longer exists (settle replaced archive, a9ca312b), and 0.4.1's rule is that reopening doesn't change lifecycle state.
7. **2709–2723 `live_context`.** **Keep both** fields: `forks: …` and `held_working: self.held_working_sessions()`. The auto-merged `thread_row` (4184–4230) already reads both.
8. **3881–4036 `ThreadRow`.** The 0.4.1 side runs past the end of `ThreadRow` (closing `}` at **3895**) into `AttachedProjectWire` and the access-request helpers; RC only adds `held_working: bool`. **Resolution:** keep the 0.4.1 block verbatim, insert `pub held_working: bool,` with its doc comment inside `ThreadRow` just before 3895, and drop RC's half.
9. **4044–4051 `LiveContext`.** **Keep both** fields.
10. **5994–5998 the `no_live()` test helper.** **Keep both** initialisers.

## API drift in auto-merged and RC-only files (no conflict reported, still won't compile)

- **src-tauri/src/sleep_watch.rs**, new in 0.4.1. It builds `SessionDeltaEnvelope` without RC's `seq` at **279** and in the test helper at **338**. Add `seq: 0`.
  - These sleep notices are emitted outside the projector, so they are seq 0. RC's room host drops any envelope with `seq <= covered` (`crates/atlas-remote-control/src/host.rs:810–813`), so remote viewers silently never see `slept_mid_turn`. No resync storm, just a gap. Acceptable for now; note it as a follow-up.
  - Tell the frontend owner too: a seq-0 envelope must not be thrown away by a snapshot's `seq <= as_of_seq` filter.
- **src-tauri/src/commands/agent_host/wake.rs tests**, new in 0.4.1:
  - **468 and 531** call `host.send(&key, Vec::new())`, which is removed. Use `host.submit(&key, Prompt::default(), Origin::Local, SubmitPolicy::Now)`.
  - **544** calls `host.stop(&key)`. Use `host.stop(&key, Origin::Local)`.
- **The wake path and the seat.** `send_prompt` reaches `submit` with `Origin::Local`. While a remote driver holds the seat, `steering.rs::seat` (395–409) _refuses_ Local, so PR-watch wakes and restart continuations would fail with "X is driving". **Decide:** have `submit` skip `seat()` when `prompt.from_atlas` (my recommendation), or park them with `QueueIfBusy`.
- **Wakes and `user_message`.** If a wake prompt is stamped, the window gets both 0.4.1's `atlas:session-prompt-injected` row and a `user_message` with no `client_message_id`, so the prompt shows twice. **Recommend:** in `dispatch`, skip `stamp_user_message` when `from_atlas`. That matches 0.4.1's UI. The entry still reaches snapshots, because unstamped user entries are mirrored as `Projected::User`.
- **crates/atlas-remote-control/Cargo.toml:23.** It is still on `reqwest = "0.12"` with `rustls-tls`. 0.4.1 (097aaa2f) moved every atlas crate to 0.13 (`rustls`; `query` is now opt-in). It compiles, but drags in a second reqwest and the webpki-roots store. **Bump** it to `version = "0.13", features = ["json", "rustls"]`; it doesn't use `.query` or `.form`. Commit the regenerated `Cargo.lock`.
- **rc.rs.** Every host call it makes (`submit`, `stop(key, origin)`, the 3-arg `set_mode`/`set_model`, `set_config_option(.., origin)`, `answer_*`, `*_session`, `hold_session`, `release_session`, `observe_session_end`, `set_remote_driver`, `session_key`, `snapshot`, `snapshot_meta`) resolves to RC's own steering and agent_host code. `super::artifacts_cloud::{AppTokenSource, ArtifactsCloudState, is_cloud_bound}`, `capture::open_reader` and `auth::AuthState` all exist on 0.4.1. **No drift.**
- **lib.rs.** It auto-merged cleanly: `rc::install` at 374, the `rc_*` commands at 756–763, and `agents_queue_*` / `agents_set_hold` at 947–953. Nothing more needed there.
- **Crate registration** is complete: the members list (Cargo.toml:47), `[profile.dev.package.atlas-remote-control]` (837), `.github/ci-crates.json:100`, `src-tauri/Cargo.toml:130`, and `tests/ci-affected.test.ts:203`. The crate's only file reads are `include_str!("fixtures/…")` inside its own directory, so no `EXTRA_INPUTS` entry is needed.
- **Other envelope and `Message` literals** (memory_delta.rs, memory_server/bench.rs, capture.rs, agents.rs `transcript_to_messages`) merged with both sides' fields present. Nothing to do.
- **Queue and pastes (flag).** `agents_queue_add` takes text only, so a queued prompt drops the composer's pasted chips. Add `pasted_texts: Option<Vec<PastedText>>` to it if the composer queues pastes.

## Wire-contract risk

- **No collisions:**
  - 0.4.1 added the `slept_mid_turn` variant, optional `started_at_ms`/`ended_at_ms`/`worked_ms` on `turn_finished`, `ToolCall.started_at_ms`/`ended_at_ms`, and `Message.timestamp_approximate`/`worked_ms`/`stop_reason`.
  - RC added the `user_message`, `queue_changed` and `hold_changed` variants, optional `origin` on `mode_changed`/`model_changed`/`config_options_updated`, and `envelope.seq` (`#[serde(default)]`).
  - Every change on both sides is additive. No tag or field names overlap.
  - `Origin`'s inner `kind` tag is nested under `origin`, so it can't clash with the flattened envelope's `kind`.
- **The real risk is semantic, not naming:**
  - the snapshot built by `announced_messages` drops 0.4.1's timing and approximate fields (fix above);
  - seq-0 out-of-band envelopes from `sleep_watch` break RC's rule that every delta carries a dense seq.

## Resolution order and narrow checks

1. **Wire:** contract.rs (keep both, fix `sample_user_message`), then `cargo test -p atlas-agent-wire`.
2. **Delta:** projector.rs block plus the two `Message` literals plus `announced_messages` parity (`stamp_turns` → `pub(crate)`, new test), then the projection.rs tails. Run `cargo test -p atlas-agent-delta`.
3. **atlas-remote-control:** the reqwest bump, then `cargo test -p atlas-remote-control`.
4. **App crate:**
   - edits: mod.rs; agent_host.rs blocks 1–3 and 6–10 (mechanical); blocks 4–5 with the ports into steering.rs; agents.rs blocks 1–4; sleep_watch.rs `seq`; wake.rs tests;
   - checks: `cargo check -p atlas`, then `cargo test -p atlas --lib steering`, `cargo test -p atlas --lib wake`, `cargo test -p atlas --lib sleep_watch`, `cargo test -p atlas --lib prompt_books`, `cargo test -p atlas --lib agent_host`.
5. **Contracts:** `bun run test tests/wire-shape-contract.test.ts tests/ipc-contract.test.ts tests/event-contract.test.ts tests/ci-affected.test.ts tests/cargo-workspace.test.ts`.
   - ipc-contract has to see `agents_cancel {stop}`, `agents_send {pastedTexts, clientMessageId}`, and the new `agents_queue_*` / `rc_*` commands. That depends on how the frontend half resolves.
6. **Before the PR:** `bun run ci:local` (the clippy pass will flag unused imports left over from the send-path rewrite).

## Appendix B — header, sidebar, panel UI (agent notes)

### RC UI: where it goes in 0.4.1 (header, sidebar, chat-panel)

Paths are in /tmp/rc-trial unless they say otherwise. "U" means the 0.4.1 side, "RC" the stash side.

## 0. How the 0.4.1 layout differs

- There is no header row inside the chat any more. `SessionHeaderControls` (`src/features/chat/components/session-header.tsx:46-61`) is portalled by ChatPanel into the column header's slot (`center-panel.tsx:526-528` `<SessionHeaderSlot>`, store `stores/session-header-slot-store.ts`).
- What lives there now: `ChatPinnedMenu` (shown only while something is pinned) and then `SessionDetailsButton`.
- **The portal sits outside the `messages.length === 0` branch** (trial `chat-panel.tsx:1676-1688`). So the welcome screen already gets the same title-bar controls, and RC's `empty` mode has no reason to exist.
- `sessionId`: ChatPanel already has `const acpSessionId = session?.acpSessionId ?? ""` (U chat-panel:403). Pass it down as a prop.
- The title is no longer a ChatPanel value. `headerTitle` is gone. The breadcrumb computes it as `sessionDisplayTitle(session.title, session.firstUserContent)` (`center-panel.tsx:577-580`).
- Locked by `session-header-order.test.tsx:25-43`: "The title bar's session group is Details alone (the pins pill joins it only while something is pinned) ... the session's actions are its sidebar row's menu, and the Bash calls and Plans panels open from the Details card". **An always-visible RC button breaks this test, and it is a design-language change. Ask the user before doing it.**
- The `⋯` menu the header comment names (`session-actions-menu.tsx`) does not exist. The comment is stale. Bash calls and Plans moved to the Details card (`ActivitySection`). Fork moved to `prose-row-actions.tsx:103`, `lineage-section.tsx:97` and the `/fork` slash command.

## 1. RC's changes to the three deleted files

### chat-header.tsx (DU, deleted by 76681edd)

| RC change                                                                                                                         | Where it goes in 0.4.1                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lucide imports `RadioTower, Link, Square, Hand, Users`                                                                            | into the new RC components below                                                                                                                                                                                                                                                                                                                    |
| `sessionId` prop (RC :86-88)                                                                                                      | new `acpSessionId: string` prop on `SessionHeaderControls` (session-header.tsx:29-41), passed at chat-panel ~1678 as `acpSessionId={acpSessionId}`                                                                                                                                                                                                  |
| `empty` prop and every `!empty &&` wrapper (history button, new-session button, session picker, pins, filters, Bash, Plans, fork) | **drop.** Those controls no longer exist in the session view, and the title-bar portal already renders on the welcome screen                                                                                                                                                                                                                        |
| `const remote = useRemoteControl(sessionId, title)`                                                                               | inside a new `RcHeaderMenu` (below), called with the title computed via `sessionDisplayTitle` the way `MainTitle` does it (center-panel.tsx:577-580)                                                                                                                                                                                                |
| `<RcStatusPill control={remote} className={CONTROL_H, OUTLINE, rounded-full…}>` before the pins                                   | `SessionHeaderControls`, **first child**, before `<ChatPinnedMenu>` (session-header.tsx:57). It renders only while a room exists, the same rule the pins pill follows, so the order test stays green                                                                                                                                                |
| More-menu items while a room is active: "Take over from X", "Copy viewer link", "Share with <org>", "Stop remote control"         | in the pill's own dropdown (the pill becomes a `DropdownMenuTrigger`). See §2                                                                                                                                                                                                                                                                       |
| More-menu item "Remote control" (start), disabled with title "Available once the agent has connected"                             | new `RemoteControlSection` in the Details card, inserted after `<ActivitySection>` at `src/features/session-context/components/session-details-card.tsx:146`. See §2. An optional second entry point is the sidebar row menu (`src/features/sidebar/components/session-row-menu.tsx`, `SessionMenuItems`), shown only when the row is live in a tab |
| `onForkSession && !empty`                                                                                                         | drop (0.4.1 removed it from the header)                                                                                                                                                                                                                                                                                                             |

### session-sidebar.tsx (DU, deleted by 99af0098 "one sidebar, sessions first")

The replacement is `src/features/sidebar/` (`lib/sidebar-sessions.ts`, `lib/session-row-status.ts`, `components/session-row.tsx`, `components/sidebar-session-list.tsx`). The resume path moved to `src/features/chat/lib/open-thread.ts`.

1. `import { snapshotLive }` plus a 5th argument to `hydrateSessionSnapshot` (RC :601-607). This goes to **`src/features/chat/lib/open-thread.ts:203`**: `hydrateSessionSnapshot(targetTabId, snapshot.status, snapshot.plan, snapshot.subagents, snapshotLive(snapshot));`, plus `import { snapshotLive } from "./snapshot-message";` near :27. Its sibling `open-agent-session.ts:165` auto-merged correctly.
2. `heldWorking` on the item (RC :97, :128-129):
   - Add `heldWorking: boolean` to `SidebarSession` (`src/features/sidebar/lib/sidebar-sessions.ts:62`, next to `liveElsewhere`).
   - Add `heldWorking: thread.heldWorking,` at `:200`.
3. `status={live?.status ?? (item.heldWorking ? "running" : null)}` (RC :839-841).
   - Add `heldWorking?: boolean` to `resolveSessionRowStatus` (`src/features/sidebar/lib/session-row-status.ts:15-26`) and make it working: `if (input.live === "running" || input.liveElsewhere || input.heldWorking || input.watching) return "working";`.
   - Pass `heldWorking: session.heldWorking` at `session-row.tsx:254-258` and `:675-679`.
   - Nuance: RC let a live tab's status win outright. Here `live === "waiting"` still wins, but `heldWorking` would beat a tab's `"error"`. That is acceptable, because Rust only sets it while a turn runs.
   - Optional: add `|| row.heldWorking` to the settled shelf's "must be seen" filter at `sidebar-session-list.tsx:226-231`, next to `row.liveElsewhere`.
4. Typecheck fallout. `ThreadRow.heldWorking` is required (`history-api.ts:81`). 0.4.1-only mock fixtures that build ThreadRows need `heldWorking: false`: `src/dev/mock-backend/scenarios/{sidebar,session-projects,session-context}.ts`. `src/features/sidebar/lib/sidebar-sessions.test.ts` needs it on its fixtures and on its expected `SidebarSession`.

### chat-panel-overview-margin.test.tsx (DU, deleted by 76681edd)

**Drop it.** RC flipped it to "reserve the rail's width on the welcome screen". The rail (`ThreadOverviewPanel`, `overviewWidth` marginRight) no longer exists. Its replacement, `chat-panel-overview-layout.test.tsx:185`, asserts the opposite on purpose ("on an empty session: no reservation"), and U's `DockOpenFlag` is gated on `session.messages.length > 0` (chat-panel ~1670). Delete the file. Do not port RC's change.

## 2. Port design for the RC controls, in 0.4.1's own primitives

This adds no new visual pattern. Every element below copies an existing one.

### A. `RcStatusPill`, turned into the room's menu (title bar, only while a room exists)

- **Trigger:** copy `ChatPinnedMenu`'s trigger exactly (`chat-pinned-menu.tsx:56-64`):
  ```tsx
  <HintItem label="Pinned messages">
    <Popover.Trigger render={<Button variant="ghost" size="sm" aria-label=…><Pin size={12} /><span className="tabular-nums">{pins.length}</span></Button>} />
  ```
  So the pill is `<HintItem label={hintFor(control)}><DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="Remote control">…dot… {pillLabel} {viewers?<Users size={12}/><span className="tabular-nums">n</span>}</Button>} /></HintItem>`.
  - Remove RC's raw `<button className={className}>` and its `className` prop (rc-status-pill.tsx:61-76). Passing `rounded-full px-2.5 OUTLINE` to `Button` would trip `shadcn/no-restyle`, since only layout, font-mono, tabular-nums and capitalize are allowed.
  - Drop `text-xs leading-none` from the label span (:89), because Button `sm` already sets `text-xs`.
  - Keep the dot span and its `--atlas-pulse-color` style unchanged. It is the same recipe as `artifacts/components/session-detail.tsx:934-937`.
- **Menu:** copy the `SurfaceAdd` dropdown (`center-panel.tsx:1114-1144`): `<DropdownMenu>` → `<DropdownMenuContent align="end" sideOffset={4} className="min-w-48">` → `<DropdownMenuItem onClick=…><Hand size={14} />Take over from {driverLabel(d)}</DropdownMenuItem>`.
  - Items, each with RC's conditions: Take over (`remote.remoteDriver`), Copy viewer link, Share with {org} (`remote.shareWith`), `<DropdownMenuSeparator/>`, Stop remote control (`variant="destructive"` is the primitive's own variant; leave it off if a neutral Stop is wanted).
  - On an ended room the pill's only item is "Dismiss" (`remote.dismiss`). Alternatively keep RC's click-to-dismiss.
  - Use `@/ui/dropdown-menu` items with **no className**. RC's raw `DropdownMenu.Item className="flex h-[26px] … data-[disabled]:opacity-50"` strings must not be copied.
- **Where:** a new file `src/features/chat/components/rc-header-menu.tsx` exporting `RcHeaderMenu({ tabId, acpSessionId })`. It calls `useRemoteControl(acpSessionId, title)`, with `title` from a `useChatStore` selector using `sessionDisplayTitle`, and returns `null` when `!remote.room`. Rendered in `SessionHeaderControls` before `ChatPinnedMenu` (session-header.tsx:57). Update the header comment at :12-17 to list it.
- `hintFor` text: replace "(More menu)" (rc-status-pill.tsx:44) with "Take over from this menu". Replace "Click to copy the viewer link" (:46) with "Options for the room".
- Either keep `rc-status-pill.tsx` as the pill body and drop its className prop, or fold it into `rc-header-menu.tsx`. Keep `pillLabel` exported, because `rc-driver-bar.test.tsx:36,163` imports it.

### B. Start: `RemoteControlSection` in the Details card

- Copy `ActivitySection` (`src/features/session-context/components/activity-section.tsx:44-55`): `<DetailsSection label="Remote control" title="Remote control" icon={RadioTower}>` with one `<DetailsRow>` of `<RowIcon icon=…/><RowLabel>…</RowLabel>`.
- No room: one row, "Start remote control". `DetailsRow` already supports `disabled` plus `title`, and it uses `aria-disabled` so the reason still shows on hover (details-rows.tsx:98-135). Use `title="Available once the agent has connected"` when there is no `acpSessionId`.
- Room open: show the state with `RowMeta` (Live · n watching / X driving), then rows for Copy viewer link and Stop. Or show just the state and leave the actions to the title-bar pill. Pick one; don't duplicate them.
- The card sits outside ChatPanel's tree. Read `acpSessionId` and the title from `useChatStore(s => s.sessions[tabId])` by `tabId`. Reads are fine; the card's contract (session-details-card.tsx:19-20) only forbids writes.
- `session-details-card.test.tsx:25-28` stubs every section. Add `vi.mock("./remote-control-section", …)`, or the real one renders.
- **Open gap, for the user to decide.** In docked mode (wide window) the Details card is not drawn on an empty session: `SessionDockLane` sits only in the non-empty branch (chat-panel ~1743), and test :185 pins "no reservation" on empty. The popover form works. That means "start a room from a fresh chat" (RC's reason for `empty`) only works in narrow windows. Options:
  - accept it (you start a room after the first prompt);
  - add a command-palette action (`src/features/keybindings/lib/actions.ts`, next to `chat.find` :352);
  - add a sidebar row-menu item, live rows only;
  - make an always-visible title-bar RadioTower `IconButton` (`icon={…} label=… size="sm" iconSize="md"`, as at session-details-button.tsx:109-118). This last one changes `session-header-order.test.tsx` and needs the user's approval.

### C. Things that already fit and only need copy fixes

- `rc-driver-bar.tsx`: `COMPOSER_STRIP` and `COMPOSER_STRIP_ACTION` exist in U (`composer-strip.ts:13-21`), and raw `<button className={cn(COMPOSER_STRIP_ACTION,"cursor-pointer")}>` is U's own pattern (`branch-changed-bar.tsx:76`, `live-elsewhere-bar.tsx:40`). Small fix: drop `disabled:opacity-50` at :62, :93 and :102. `COMPOSER_STRIP_ACTION` already styles `disabled:`, so the class makes it doubly dim.
- `session-elicitation.tsx` (RC notice): "take over from the chat header" → "take over at the composer". `RcDriverBar`'s Take over button is right below.
- `elicitation-modal.tsx` (RC notice): same fix, "Take over from the chat header" → "Take over at the composer". Both merged cleanly (status M). `data-testid` and the "Ada is driving" text are unchanged, so `session-elicitation.seat.test.tsx` still passes.
- `src/features/chat/lib/close-tab.ts:94` comment: "so the header can say why it ended" → "so the title-bar pill can say why it ended".

## 3. chat-panel.tsx: the 9 conflict blocks

All 0.4.1 changes in blocks 1-7: queued items now carry `mentions` (pastes, cites and review comments flattened into the text by `enqueueMessage`), `addMessage` gained `trustedMentionPaths`, and `agents.send` gained `pastedTexts`. All RC changes: the queue moved to Rust via `enqueuePrompt`, `addMessage` returns the bubble id, and `send` carries `clientMessageId`.

| #   | lines     | U                                                                                                                                                                                                       | RC                                                                                                                                                                                                         | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 1370-1374 | `enqueueMessage(tabId, actualContent, mentions)`                                                                                                                                                        | `enqueuePrompt(tabId, actualContent)`                                                                                                                                                                      | `enqueuePrompt(tabId, actualContent, mentions);`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | 1397-1401 | same, `cs.actions.`                                                                                                                                                                                     | same                                                                                                                                                                                                       | `enqueuePrompt(tabId, actualContent, mentions);`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | 1412-1416 | same                                                                                                                                                                                                    | same                                                                                                                                                                                                       | `enqueuePrompt(tabId, actualContent, mentions);`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | 1437-1441 | `addMessage(…, attachments, trustedMentionPaths(mentions))`                                                                                                                                             | `const clientMessageId = addMessage(…, attachments)`                                                                                                                                                       | `const clientMessageId = addMessage(tabId, "user", actualContent, attachments, trustedMentionPaths(mentions));`                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | 1466-1470 | enqueue with mentions                                                                                                                                                                                   | `enqueuePrompt`                                                                                                                                                                                            | `enqueuePrompt(tabId, actualContent, mentions);`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | 1492-1496 | as #4                                                                                                                                                                                                   | `clientMessageId = addMessage(…)`                                                                                                                                                                          | `clientMessageId = addMessage(tabId, "user", actualContent, attachments, trustedMentionPaths(mentions));`                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | 1572-1576 | `send(key, wirePrompt, attachments, resourceLinks, pastedTexts)`                                                                                                                                        | `send(…, resourceLinks, clientMessageId)`                                                                                                                                                                  | `await agents.send(key, wirePrompt, attachments, resourceLinks, pastedTexts, clientMessageId);`                                                                                                                                                                                                                                                                                                                                                                                                       |
| 8   | 1651-1907 | `conversationRef` drop zone with `--chat-dock-*` vars, `DockOpenFlag`, portalled `SessionHeaderControls`, `stageRef`, `data-chat-row`/`data-chat-column`, `SessionDockLane`, `data-chat-composer-stack` | the old layout plus a welcome-screen header (`ChatHeader … sessionId … empty`), `ThreadOverviewPanel` beside the welcome screen, and composer `marginRight` from `overviewWidth` whenever the rail is open | **Take U (1652-1759) verbatim, delete RC (1761-1906) entirely.** Its identifiers (`ChatHeader`, `headerTitle`, `roleFilter`, `filteredMessages`, `HEADER_INSET`, `overviewOpen`, `overviewWidth`, `ThreadOverviewPanel`, `chatSidebarVisible`, `onNewSessionStable`, `canFork`) appear nowhere else in the merged file. The only RC addition is one prop on the portal at ~1678: `acpSessionId={acpSessionId}` (for `RcHeaderMenu`). The trailing common lines (1908+) are already at U's indentation |
| 9   | 1919-1940 | `<SessionElicitation pending onClose>` at U's indentation                                                                                                                                               | same plus `remoteDriver={elicitationRemoteDriver}`                                                                                                                                                         | U's block plus the line `remoteDriver={elicitationRemoteDriver}`. `elicitationRemoteDriver` is defined at 317-318 (auto-merged)                                                                                                                                                                                                                                                                                                                                                                       |

What these resolutions depend on (other files, flagged for whoever owns them):

- **`turn-queue.ts` `enqueuePrompt(tabId, text, mentions: readonly MentionData[] = [])`** must flatten exactly as U's store did: `withReviewCommentsInline(withCitesInline(withPastesInline(text, mentions), mentions), mentions)` (U chat-store.ts:46-48, 1763-1772). It flattens _before_ both the local `enqueueMessage` and `addToRust`, so Rust's queued prompt carries the paste or cite text too. The store's `enqueueMessage` then keeps RC's `(sessionId, text, id?)` and takes text that is already flattened.
- **A hidden auto-merge hazard at chat-panel.tsx:732:** `actions.enqueueMessage(tabId, held.content, held.mentions ?? [])` is U code. Against RC's store signature it passes an array as `id`. Change it to `enqueuePrompt(tabId, held.content, held.mentions ?? [])`; the session is unbound there, so the item stays local. The same applies to U's other callers that pass mentions as the 3rd argument: `message-input.tsx` (U :1839, :1854), `retry-turn.ts` (:128), `switch-agent.ts` (:177, :363). All of them are conflicted files outside this report.
- **The chat-store `addMessage`** keeps both U's 5th parameter `trustedMentionPaths?` and RC's `=> string | undefined` return.
- **`agents-api.ts` `send`** becomes `(key, text, attachments?, resourceLinks?, pastedTexts?, clientMessageId?)`, and the Rust `agents_send` takes both `pasted_texts` and `client_message_id`. `ipc-contract` and `wire-shape-contract` check the field names.

## 4. RC tests to rewrite

| test                                                  | status                                                                 | action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-header-empty.test.tsx`                          | tests the deleted `ChatHeader` (`empty`, More menu, "Thread overview") | **delete.** Replace with (a) a new `rc-header-menu.test.tsx`: renders nothing with no room; with `useRcStore.getState().actions.upsert(room())` (fixture as in `rc-driver-bar.test.tsx:41-56`) shows the pill; the menu offers Take over only with a remote driver, Share only when `shareWith`, plus Copy link and Stop. (b) a second case in `session-header-order.test.tsx`: with no room the names stay `["Session details"]` (no change), and with a room they become `["Remote control", "Session details"]`. (c) a new `remote-control-section.test.tsx` (Details card): "Start remote control" has `aria-disabled="true"` and title "Available once the agent has connected" while unbound, and is enabled once `setAcpBinding` has run |
| `rc-driver-bar.test.tsx`                              | targets `RcDriverBar` plus `pillLabel`                                 | keeps working if `pillLabel` stays exported; no rewrite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session-elicitation.seat.test.tsx`                   | targets props that merged cleanly                                      | no rewrite; the copy fix in §2C keeps its assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chat-panel-overview-margin.test.tsx`                 | deleted upstream                                                       | delete (§1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `chat-panel-live-elsewhere.test.tsx` (M, auto-merged) | its RC hunks assert `queueAdd` args `[1] === "status?"`                | still valid if `enqueuePrompt` flattens with no mentions; recheck after the turn-queue change. Its `vi.mock("./chat-header")` is stale on U too and harmless                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session-details-card.test.tsx`                       | U                                                                      | add a stub for `./remote-control-section` (§2B)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sidebar-sessions.test.ts`                            | U                                                                      | add `heldWorking` to the fixtures and the expected rows (§1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 5. Ratchet and lint hazards in RC UI code

I scanned with the ratchet's own regexes (`tests/design-system-ratchet.test.ts:58-120`: arbitrary `text-/z-/shadow-/rounded-[…]`, `#hex`/`rgb()`/`hsl()`, `-white`/`-black`, stock ramps, bare `z-50+`, inline `zIndex`/`fontSize`/`boxShadow`). Coverage: `rc-driver-bar.tsx`, `rc-status-pill.tsx`, `use-remote-control.ts`, `rc-api.ts`, `rc-mirror.ts`, `src/dev/mock-backend/fixtures/rc.ts`, and every RC-added line under `src/features`, `src/components`, `src/ui` and `src/dev`. **Zero hits.**

The hazards are lint and restyle issues, plus code that would be lost if copied over from the deleted file:

| file:line                                                                                                                                   | issue                                                                                                                        | 0.4.1-compliant replacement                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rc-status-pill.tsx:61-76`                                                                                                                  | raw `<button className={className}>` that relies on `CONTROL_H`/`OUTLINE`/`rounded-full px-2.5` from the deleted chat-header | `<Button variant="ghost" size="sm">` (chat-pinned-menu.tsx:61). Passing that class string to `Button` would trip `shadcn/no-restyle`                                                                                                                                                             |
| `rc-status-pill.tsx:89, 91`                                                                                                                 | `text-xs leading-none` on the children                                                                                       | drop it; Button `sm` sets `text-xs`. Use `tabular-nums` for the count (allowed)                                                                                                                                                                                                                  |
| RC chat-header :337-388 (the More-menu RC items)                                                                                            | raw base-ui `DropdownMenu.Item` with `h-[26px] … text-[var(--secondary-foreground)] … data-[disabled]:opacity-50`            | `@/ui/dropdown-menu` `DropdownMenuItem` with no className (center-panel.tsx:1137). The primitive's `ITEM` already covers hover, focus and disabled                                                                                                                                               |
| RC chat-header :234-242 (pill className)                                                                                                    | `rounded-full px-2.5 OUTLINE` restyle                                                                                        | gone with the move to `Button`                                                                                                                                                                                                                                                                   |
| `rc-driver-bar.tsx:62, 93, 102`                                                                                                             | `disabled:opacity-50` stacked on `COMPOSER_STRIP_ACTION`'s own disabled styling                                              | `cn(COMPOSER_STRIP_ACTION, "cursor-pointer")` (branch-changed-bar.tsx:76)                                                                                                                                                                                                                        |
| `rc-status-pill.tsx:17-20`, `rc-driver-bar.tsx:48, 51-52, 79, 81-82`, `session-elicitation.tsx` notice `text-[var(--secondary-foreground)]` | `[var(--…)]` arbitrary colours: legal (not banned, and U's chat-pinned-menu uses them) but older style                       | optional: switch to U's utility tokens `bg-warning`/`bg-success`/`bg-muted-foreground`, `text-warning`, `text-foreground`, `text-muted-foreground`, `text-secondary-foreground` (`--color-success/warning` at globals.css:82-83; the modal's RC notice already uses `text-secondary-foreground`) |
| `rc-status-pill.tsx:81-88`                                                                                                                  | inline `style` sets `--atlas-pulse-color` with `color-mix(...)`                                                              | fine: not a banned property, and it is the same recipe as `session-detail.tsx:936`. `atlas-live-pulse` is on the `no-unknown-classes` allowlist                                                                                                                                                  |

## Appendix C — store, libs, mocks (agent notes)

### RC → 0.4.1 merge: chat store, chat libs, composer/transcript, mock backend

**What I checked.** I resolved every block below in a scratch copy at `/tmp/rc-plan/work` (an rsync of /tmp/rc-trial, using atlas's node_modules). In that copy, `tsc -p tsconfig.json` and `tsc -p tsconfig.test.json` are both clean, except for two files outside this scope (`chat-panel.tsx`, and the RC-only `chat-header-empty.test.tsx`). Every vitest suite under src/features/chat, src/dev and tests/ passes, except the out-of-scope items listed under "Not mine". oxlint is clean on every touched file.

**Ready-to-copy files.** `/tmp/rc-plan/resolved/<repo path>` holds 21 files. A resolver could copy these over the trial instead of hand-editing.

Line numbers below are /tmp/rc-trial line numbers. In the tables, "U" means upstream (0.4.1) and "S" means stash (RC).

## The one design decision: queued prompts with mentions

- **What 0.4.1 changed.** `enqueueMessage(sessionId, text, mentions)` now takes `mentions` as a required argument. It writes the text of pastes, cites and review comments into the queued string, appending each one. That makes it **not idempotent**: it must run exactly once per prompt.
- **What RC changed.** `enqueueMessage(sessionId, text, id?)`, plus `turn-queue.enqueuePrompt(tabId, text)`, which also sends the text to Rust (`agents.queueAdd`). RC's comment says "Queued prompts carry no mentions".
- **The fix.**
  - New pure helper `src/features/chat/lib/queued-text.ts`, exporting `inlineQueuedText(text, mentions)`. It wraps 0.4.1's `withReviewCommentsInline(withCitesInline(withPastesInline(…)))`.
  - The store keeps 0.4.1's required `mentions` and adds RC's optional id as a 4th argument: `enqueueMessage(sessionId, text, mentions, id = null)`. It stores `inlineQueuedText(text, mentions)`.
  - `enqueuePrompt(tabId, text, mentions)` passes `(text, mentions, marker)` to the store and sends `inlineQueuedText(text, mentions)` to Rust. That way the strip text and Rust's `queue_changed` text are the same string.
  - Callers that re-queue text that is already inlined pass `[]`. These are `takeQueuedPrompts`, retry's wire prompt, and `flushLocalQueue`, which already sends the stored text.
  - In `turn-queue.ts:50`, change the doc line to say the text is already inlined.

## Per-block resolutions

### src/features/chat/stores/chat-store.ts (6 blocks)

| line | 0.4.1                                                                                   | RC                                                     | resolution                                                                                                              |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 433  | `addMessage` gained a `trustedMentionPaths?` param; new `addInjectedPrompt` action type | `addMessage` returns `string \| undefined`             | **Keep both**: U's param list and `addInjectedPrompt`, with the return type changed to `=> string \| undefined`         |
| 632  | `enqueueMessage(sessionId, text, mentions: readonly MentionData[])` and its doc         | `enqueueMessage(sessionId, text, id?)`                 | **Rewrite**: `(sessionId, text, mentions: readonly MentionData[], id?: string \| null) => void`, merging the two docs   |
| 1157 | `addMessage: (…, attachments, trustedMentionPaths) =>`                                  | RC's `{ const id…; let added = false;` opener          | **Rewrite**: `addMessage: (sessionId, role, content, attachments, trustedMentionPaths) => {` followed by RC's two lines |
| 1211 | `}),`, then the new `addInjectedPrompt` impl                                            | `}); return added ? id : undefined; },`                | **S then U**: RC's closer first, then U's `addInjectedPrompt` impl unchanged                                            |
| 1864 | `(sessionId, text, mentions) =>`                                                        | `(sessionId, text, id = null) =>`                      | **Rewrite**: `(sessionId, text, mentions, id = null) =>`                                                                |
| 1872 | inline chain into `s.queues`                                                            | `s.queues = [...cur, text]; s.queueIds = [...ids, id]` | **Rewrite**: `s.queues[sessionId] = [...cur, inlineQueuedText(text, mentions)]; s.queueIds[sessionId] = [...ids, id];`  |

Auto-merged lines that also need edits in this file:

- **3018 (bug, tests catch it).** `applyUserMessage` checks `session.title === "New Chat"`. 0.4.1 renamed the untitled title to `UNTITLED_SESSION = "New session"` (line ~954). Change the check to `=== UNTITLED_SESSION`. Without this, a remote driver's first prompt never titles the session, and two tests in `chat-store.steering.test.ts` fail.
- **Imports, lines 29/48.** RC added a second import from `../lib/next-steps`. Merge it into `import { extractNextSteps, stripNextStepsDirective }`. Then replace the three `with*Inline` imports (lines 50–52) with `import { inlineQueuedText } from "../lib/queued-text"`.
- **Cross-scope risk.** 0.4.1's `addInjectedPrompt` draws pull-request-watch wakes (`atlas:session-prompt-injected`). Rust's wake delivery calls `send_prompt(…, PromptOrigin::Atlas)` (`pull_request_watch.rs:816`). If the Rust resolver routes that through steering `submit`, which calls `stamp_user_message`, the window draws the wake twice: once as the injected row and once as `user_message`. Atlas-origin wakes must stay unstamped; the projector is silent for unstamped entries, so that is safe. Tell the Rust resolver.

### src/features/chat/components/message-input.tsx (3)

| line | 0.4.1                                                                                                      | RC                                                                  | resolution                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1849 | `/queue` path: `getMentions()`, `enqueueMessage(…, mentions)`, `forgetSentTexts`, `writeComposer("")`      | `enqueuePrompt(tabId, queued)` and `inputRef.clear(); setValue("")` | **U shape, RC call**: `{ const mentions = …getMentions() ?? []; enqueuePrompt(tabId, queued, mentions); forgetSentTexts(mentions); } writeComposer("");` (drop RC's clear/setValue) |
| 1869 | paste/cite comment, `enqueueMessage(tabId, trimmed, mentions); forgetSentTexts(mentions);`                 | `enqueuePrompt(tabId, trimmed)`                                     | **U**, with `enqueueMessage` replaced by `enqueuePrompt(tabId, trimmed, mentions)`                                                                                                  |
| 1951 | chip edit: `collapseCites`/`collapsePastes`, `rememberMention`, `writeComposer(merged)`, `removeQueueItem` | raw `q`, `setValue`, `removeQueuedPrompt`                           | **U**, with `removeQueueItem(tabId, i)` replaced by `removeQueuedPrompt(tabId, i)`                                                                                                  |

Auto-merged parts are fine: the action destructure at line 724 already lost `enqueueMessage`/`removeQueueItem`, and `remoteDriving` plus the `RcDriverBar` mount survived.

### src/features/chat/components/transcript.tsx (2)

| line | 0.4.1                                                         | RC                                               | resolution                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 49   | `import { latestResponseRowId } from "../lib/message-footer"` | `import { useRcRemoteDriver } …rc-store`         | **Keep both**                                                                                                                                                                                                                                          |
| 378  | `canRetry`, plus new `canContinue` and `canBranch` selectors  | `remoteDriving` and `canRetry(…, remoteDriving)` | **S then U, minus U's `canRetry`**: RC's `remoteDriving` + `canRetry`, then U's `canContinue` and `canBranch`. _Recommended_: add `!remoteDriving &&` to `canContinue`. Continue sends a prompt, and only the driver may send; Rust refuses it anyway. |

### src/features/chat/components/transcript-rows.tsx (2)

| line | 0.4.1                                             | RC                                                                       | resolution                                                                                       |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 18   | dropped `Code2`/`FileDiff` from the lucide import | added `RadioTower`                                                       | **Rewrite**: `import { Brain, ChevronRight, Files, Paperclip, RadioTower } from "lucide-react";` |
| 179  | `{overflows && <ExpandToggle …/>}`                | the `remoteAuthor` caption span, then the unconditional `<ExpandToggle>` | **RC's span, then U's conditional ExpandToggle**                                                 |

### src/features/chat/lib/retry-turn.ts (1)

- **137.** 0.4.1 has `enqueueMessage(tabId, prompt, [])`; RC has `enqueuePrompt(tabId, prompt)`. Resolve to **`enqueuePrompt(tabId, prompt as string, [])`**. `prompt` is the wire text, so it needs no inlining.
- **202 (auto-merged, typecheck error TS2345).** 0.4.1 inserted `pastedTexts` as the 5th parameter of `agents.send`, so RC's `agents.send(key, prompt, undefined, undefined, clientMessageId)` now passes the id into `pastedTexts`. Change it to `agents.send(key, prompt, undefined, undefined, undefined, clientMessageId)`.

### src/features/chat/lib/retry-turn.test.ts (4)

| line     | resolution                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6        | U's typed `send` mock, plus RC's `queueAdd` mock                                                                                                                             |
| 22       | U's `send: (key, prompt) => send(key, prompt)`, plus RC's `queueAdd`. U's paste test asserts `send` args; the mocked `addMessage` returns undefined, so `send` gets 2 args.  |
| 186, 213 | RC's assertions, with the mentions argument added: `toHaveBeenCalledWith("tab", "hello", [], expect.stringMatching(/^pending:/))`, plus RC's `queueAdd(…, "hello", "hello")` |

### src/features/chat/lib/switch-agent.ts (2)

- **21.** Keep both import sets: 0.4.1's `trustedMentionPaths` and `saveLastAgentPref`, plus RC's `rc`/`roomOpen`, `useRcStore` and the `turn-queue` imports.
- **394.** Resolve to `for (const text of typed) enqueuePrompt(tabId, text, []);`.
- **Line 200 (auto-merged).** `actions.enqueueMessage(tabId, text, [])` stays as 0.4.1 wrote it. It is correct: the tab is unbound there, so the item is local with id `null`.

### src/features/chat/lib/close-tab.ts (1)

- **29.** This block is only the doc comment. Merge the text: "…dropped WITH the tab — unless the session is held, in which case Rust keeps it running and only the tab goes. A file tab with unsaved edits asks Save / Don't save / Cancel, and the last tab on a file drops its buffer. Other tabs close exactly as before."

### src/features/chat/lib/agents-api.ts (2)

- **150.** Keep both parameters, in this order: `pastedTexts?` (5th), then `clientMessageId?` (6th).
- **165.** Combine:
  - Both payload keys: `pastedTexts: …?? null, clientMessageId: clientMessageId ?? null`.
  - **0.4.1's** `cancel(key, opts?: { stop?: boolean })`, which sends `stop`, plus RC's note that Rust discards the queue.
  - All of RC's `queueAdd`, `queueRemove`, `queueClear`, `queuePause`, `queueDrain`, `queueSendNow` and `setHold`.
- **Rust side (not mine).** `agents_send` must take both `pasted_texts` and `client_message_id`. `agents_cancel` must keep `stop: Option<bool>` and RC's queue discard. Today the trial has **two** `fn agents_cancel` (`agents.rs:2606` and `:2620`), which fails ipc-contract's "registers every command name exactly once".

### src/dev/mock-backend/fixtures/misc.ts (11)

- **All 11 blocks (91, 132, 154, 178, 202, 224, 251, 275, 298, 322, 345): keep both.** 0.4.1 added `attachedProjects`, `model`, `pullRequests` and `forkedFromSessionId`; RC added `heldWorking: false`. Use U's lines, then `heldWorking: false`.

### src/dev/mock-backend/scenarios/base.ts (3), types.ts (2)

- **base.ts 27/70/197 and types.ts 15/77: keep both.** 0.4.1 added `project-sources` and `pull-requests`; RC added `rc`. Keep U, then RC, in each spot.

### src/dev/mock-backend/scenarios/northwind-misc.ts (1)

- **507.** Keep U's block (`attachedProjects` … `forkedFromSessionId`), then `heldWorking: false`.

### src/dev/mock-backend/fake-agent.ts (1)

- **895.** Use U's comment, with the signature extended: `agents_send: async ({ key, text: sent, pastedTexts, clientMessageId }) => {`. The body below the block (U's `receivedText`, then RC's `runTurn(s, String(text), clientMessageId…)`) already merged correctly.

## Breaks git did not report (found by typecheck/tests in the scratch copy)

| where                                                                                                          | break                                                                                                                   | fix                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry-turn.ts:202`                                                                                            | TS2345: `pastedTexts` slot                                                                                              | add one more `undefined` (see above)                                                                                                                                                                        |
| `chat-store.ts:3018`                                                                                           | `"New Chat"` is now `UNTITLED_SESSION`; 2 steering tests fail                                                           | `=== UNTITLED_SESSION`                                                                                                                                                                                      |
| `turn-queue.ts:64`                                                                                             | `enqueuePrompt` has no mentions; queued paste/cite text would be lost                                                   | add the `mentions` param and `inlineQueuedText` (see the design decision); run `bun run format` afterwards (oxfmt wants the signature on one line)                                                          |
| `chat-store.steering.test.ts:119,120,137`                                                                      | old `enqueueMessage(TAB, text, id)` arity                                                                               | `(TAB, "typed before the bind", [])`, `(TAB, "on its way", [], "pending:1")`, `(TAB, "x", [], "q-9")`                                                                                                       |
| `message-footer.test.ts:75` (a 0.4.1 file)                                                                     | `UserRow` now requires RC's `remoteAuthor`                                                                              | add `remoteAuthor: null,` after `contextBlocks: 0,`                                                                                                                                                         |
| `scenarios/sidebar.ts:113`, `session-context.ts:78`, `session-projects.ts:170` (0.4.1-only ThreadRow literals) | TS2741: missing `heldWorking`                                                                                           | add `heldWorking: false,` after `liveElsewhere`                                                                                                                                                             |
| `fake-agent.ts` `AgentResponses` (~736) and handlers                                                           | `agents_set_hold` is unmocked, and 0.4.1's new mock-backend-contract test "answers every command the app invokes" fails | add `agents_set_hold: Unit;` and a handler: `({ sessionId, held }) => { const s = sessions.get(String(sessionId)); if (s) void sendDelta({ kind: "hold_changed", ...at(s), held: !!held }); return null; }` |

No other drift. Every import in the RC-only files resolves against 0.4.1, with tsc clean: rc-api, rc-mirror, turn-queue, use-remote-control, dev-session-hold, rc-store (+ test), chat-store.steering.test, fixtures/rc.ts and rc-fixture-parity. 0.4.1 did not rename any chat-store selector, `agents-api` wrapper or mock type that these files use.

## Contract tests

- **ipc-contract.** RC adds 15 commands:
  - `rc_start`, `rc_stop`, `rc_status`, `rc_set_scope`, `rc_take_over`, `rc_answer_control`, `rc_grant_control`, `rc_kick` (in `commands/rc.rs`)
  - `agents_queue_add`, `agents_queue_remove`, `agents_queue_clear`, `agents_queue_pause`, `agents_queue_drain`, `agents_queue_send_now`, `agents_set_hold` (in `agents.rs`)

  All are registered in the auto-merged `lib.rs` (lines 756–763, 947–953), and each has a frontend literal (rc-api.ts, agents-api.ts). That satisfies 0.4.1's new "every registered command has a frontend caller" check. **Blockers are both on the Rust side:** the duplicate `agents_cancel` in agents.rs, and `commands/mod.rs` (conflicted) must keep `pub mod rc;`.

- **event-contract.** RC adds one channel, `atlas:rc`. It is `export const RC_EVENT` (rc-api.ts:14), listened at rc-api.ts:103, and produced by `rc.rs:73`. It passes; the mock's emit in fixtures/rc.ts is correctly not counted. The new delta kinds (`user_message`, `queue_changed`, `hold_changed`) ride the existing delta channel and are guarded by wire-shape-contract and `atlas-agent-wire/tests/contract.rs` (both conflicted, not mine).
- **state-payload-contract.** RC doesn't touch it; passes.
- **mock-backend-contract.** Fails only on `agents_set_hold` until the fake above is added. No overlaps: the rc_* commands live only in fixtures/rc, the queue commands only in fake-agent.
- **wire-shape-contract.** "ThreadRow matches Rust ThreadRow" will fail until the Rust `ThreadRow` conflict in `agent_host.rs` (~3881–4037) keeps both sides: 0.4.1's fields plus `held_working`. The test file itself is also conflicted (1 block): keep both.

## Not mine, but these break my files' tests

- **chat-panel.tsx.**
  - Every RC `enqueuePrompt(tabId, actualContent)` (trial ~1373/1400/1415/1469, plus the held path at ~732) must become `enqueuePrompt(tabId, actualContent, mentions)` (`held.mentions ?? []`).
  - The `clientMessageId` declared-before-use and the `agents.send` positional order (`…, pastedTexts, clientMessageId`) need the same fix as retry-turn.
  - `chat-panel-live-elsewhere.test.tsx` fails until this is done.
- **chat-header-empty.test.tsx (RC-only).** It imports `./chat-header`, which 0.4.1 deleted (76681edd, session overview card). The test needs porting to 0.4.1's replacement, or deleting, together with the chat-header DU resolution.

## Order and verification

1. Create `lib/queued-text.ts`, then resolve chat-store.ts (6 blocks + line 3018 + imports).
2. Edit turn-queue.ts (`enqueuePrompt` mentions), then agents-api.ts.
3. Resolve message-input, transcript, transcript-rows, retry-turn (+ line 202), switch-agent and close-tab.
4. Do the mock backend: misc, base, types, northwind-misc, fake-agent (+ the `agents_set_hold` fake), plus the 3 scenario `heldWorking` additions.
5. Fix the tests: retry-turn.test, chat-store.steering.test, message-footer.test.
6. Then chat-panel (other scope) and the Rust conflicts (agents.rs, agent_host.rs, mod.rs).

```bash
bun run typecheck
bun run test src/features/chat/stores src/features/chat/lib src/features/chat/components/message-input-queue-edit.test.tsx src/features/chat/components/rc-driver-bar.test.tsx src/features/chat/components/session-elicitation.seat.test.tsx src/dev
bun run test tests/ipc-contract.test.ts tests/event-contract.test.ts tests/mock-backend-contract.test.ts tests/state-payload-contract.test.ts tests/wire-shape-contract.test.ts tests/rc-fixture-parity.test.ts tests/design-system-ratchet.test.ts
bun run lint && bun run format:check
```

(After chat-panel is resolved, also run `src/features/chat/components/chat-panel-live-elsewhere.test.tsx`.)
