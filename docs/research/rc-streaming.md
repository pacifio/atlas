# Why the RC viewer streams worse than the desktop, and what parity takes

Research, 2026-10-23. Branch `feat/universal-rc` in both repos (uncommitted). Read-only;
no code changed. Line numbers are as of this date and will drift.

Repos: desktop = `/Users/eemong/Codes/atlas`, server = `/Users/eemong/Codes/server`.

## Summary

The bytes are fine. The desktop coalesces the session's deltas into one binary frame
per 33 ms / 8 KiB (urgent deltas flush at once), the Durable Object relays each frame
to every caught-up socket before it touches storage, and the web reducer folds an
envelope in ~0.02 ms. Glass-to-glass the relay adds nothing a reader can see.

What the reader sees is the **page**, not the pipe:

1. **Every frame re-renders the whole transcript.** `RcTranscriptView` is an
   un-memoised `map` over every message, each through a regex markdown renderer.
   Measured: 2 ms/frame at 12 messages, 18 ms at 202, 55 ms at 602 (Bun SSR on an
   M-series Mac; a phone is 3–5× slower and React's DOM reconcile is on top). The
   desktop re-parses only the trailing markdown block (~0.3 ms) and reconciles only
   the rows that changed.
2. **Markdown does not format live, and barely formats at all.** `lib/markdown.tsx`
   renders fences, inline code, bold, italic, links. Headings, lists, tables,
   blockquotes, nested structure arrive as literal `#` and `-` characters. The
   desktop renders GFM with highlighting, block by block, as it streams.
3. **No "working" signal.** Between the prompt and the first token the page shows
   nothing. Thinking is a closed `Collapsible` labelled "Thinking" whether or not it
   is still arriving. A running tool is a badge; there is no "Running `bun test`"
   live line, no elapsed clock, no "3 done". The desktop has all of these.
4. **Autoscroll is a per-frame forced layout plus a post-paint jump**, with no
   jump-to-latest pill and no hold during a fling. On mobile Safari this is the
   blank-tiles-while-flicking class of bug the desktop already solved.
5. **Socket intake is one React state update per frame**, not per animation frame;
   nothing batches, nothing backstops a backgrounded tab, and a hidden phone tab that
   wakes replays the tail through the catch-up gate with the old transcript frozen
   on screen.
6. Tool output streams into the reducer but is invisible unless the row is open; the
   open `<pre>` does not follow its own tail. No turn boundaries, no footer, no
   "N older messages stayed on the desktop" line for a trimmed snapshot.
7. A host resync replaces the transcript with a snapshot whose message ids differ
   from the live `live-*` ids → full remount: scroll jumps, open tool rows close.

Parity does **not** need a wire change. It needs, in the server repo: an rAF-batched
publish in `use-rc-room.ts`; memoised rows keyed by stable ids; a row projection with
turns, a streaming tail and a working state; a block-split streaming markdown
renderer on `react-markdown` + `remark-gfm` (already a dependency, already used with
`skipHtml` in `entry-rail.tsx`, so §14.9's no-HTML rule holds); a port of the
desktop's scroll discipline; and the mobile details. Section 5 lists the files.

---

## 1. How the desktop streams and renders

### 1.1 Egress: projector → window → tap → room

- Every session delta leaves through one `Emitter`
  (`crates/atlas-agent-wire/src/delta.rs:257-293`); the envelope carries a dense,
  per-session `seq` (`delta.rs:228-241`).
- The Tauri `DeltaSink` is a middleware pipeline (`src-tauri/src/commands/agents.rs`):
  `BroadcastMiddleware` emits `atlas:agents` to the window (`agents.rs:184-190`);
  `TapMiddleware` runs **last** and synchronously on the emit thread, lossless by
  design because the broadcast bus drops for lagging subscribers
  (`agents.rs:100-104`, `109-171`).
- `rc_start` registers one tap per room before taking the first snapshot
  (`src-tauri/src/commands/rc.rs:373-380`); the tap only enqueues:
  `RoomHandle::offer` is a `try_send`, and a full queue flags an overflow that the
  host task answers with `rc.resync` + a fresh snapshot (`crates/atlas-remote-control/src/host.rs:268-282`, `720-724`).
- The host task's live loop (`host.rs:709-798`) accepts envelopes in seq order
  (`accept`, `host.rs:801-844`): a gap schedules a resync; the envelope is serialised
  and **redacted** (`atlas_redact::redact_json`, `host.rs:820-821`); `urgent =
  !is_streamed_text(..)` (`host.rs:819`), where streamed text is exactly
  `TextChunk | ThinkingChunk | ToolCallOutputChunk` (`batch.rs:22-29`).
- The coalescer (`batch.rs:85-101`) holds streamed text until 33 ms or 8 KiB
  (`lib.rs:71-73`, transcribed from `packages/contracts/src/rc.ts:184-185`) and
  flushes immediately on anything else; one flush is one kind-1 frame
  (`host.rs:846-859`). Net: ≤ ~30 frames/s, tool/permission/status never wait.
- Snapshots: `AppSessionPort::snapshot` reads the whole transcript on a blocking
  thread (`rc.rs:741-759`); `snapshot::prepare` redacts and fits it under 1 MiB by
  dropping `available_commands`/`subagents`/`config_options` first, then the oldest
  messages, recording `rc_trimmed_messages` (`snapshot.rs:18-19`, `27-95`). The
  document is the desktop's `SessionSnapshot` verbatim
  (`src-tauri/src/commands/agent_host.rs:158-199`: `messages`, `status`,
  `current_mode`, `current_model`, `plan`, `as_of_seq`, `pending_permissions`,
  `pending_elicitation`, `queue`).
- There is **no typewriter smoother on this branch.** The adaptive per-session
  smoother (`9cbd2df6`) is not an ancestor of HEAD; it was deliberately removed. The
  desktop's "smoothness" is batching and incremental rendering, not pacing. Parity
  means the same.

### 1.2 Window intake: one batch per animation frame

`src/App.tsx:690-1000` (listener installed at `src/features/chat/lib/agents-api.ts:284`):

- All deltas buffer in strict wire order in `pendingDeltas` (`App.tsx:694-705`).
  Consecutive same-session text/thinking chunks coalesce into the trailing entry
  (`bufferChunk`, `813-828`); `tool_call_upserted` dedupes by `(session, id)` in its
  original position (`859-873`); `tool_call_output_chunk` folds into a buffered
  upsert's `result` or concatenates with the previous chunk (`886-910`).
- `schedule` arms **both** a `requestAnimationFrame` and a 250 ms `setTimeout`
  backstop, because WebKit pauses rAF whenever the webview is not frontmost
  (`829-850`); `atlas:window-active` flushes on wake (`852-857`).
- The flush is held for an active scroll gesture (`isScrollHot()`,
  `src/lib/scroll-hot.ts`) for at most 400 ms (`757-791`), because a store update
  landing inside a momentum-scroll frame blanks tiles in WKWebView.
- One immer pass applies the whole batch: `applyAgentBatch`
  (`src/features/chat/stores/chat-store.ts:1793-1809`) → `applyDeltaToDraft`
  (`2101+`). The rules the web reducer copied: `text_chunk` appends to the trailing
  message that renders something (`2375-2382` → `appendTextToDraft` `2024-2068`);
  `thinking_chunk` to a trailing thinking message (`2384-2387`, `2070-2081`);
  `message_appended` pushes (`2389-2413`); `tool_call_upserted` replaces in place or
  joins the trailing tool message, stamping `startedAt` on first sight
  (`2415-2469`); `tool_call_output_chunk` appends to `result` (`2471-2480`).

### 1.3 Rendering the live turn

`src/features/chat/components/transcript.tsx`:

- Messages are projected to rows once per applied batch (`projectRows`,
  `src/features/chat/lib/turn-rows.ts:895+`; memoised at `transcript.tsx:382-408`).
  The last assistant message while `streaming` is the tail (`turn-rows.ts:929`);
  its thinking/prose rows carry `streaming: true` (`1016-1030`, `1089-1094`); a
  marker group in the live turn carries `running`, `liveLabel`, `liveTool`,
  `liveDone`, `liveStartedAt` (`1113-1139`); the turn footer is `streaming` until the
  turn ends (`1143-1179`).
- **Working state:** `working = isStreaming && last turn is not assistant`
  (`transcript.tsx:411-418`) mounts `LoadingState` (`221-225`): a pixel-grid loader,
  "Waiting for model" (`loading-state.tsx:68-75`), an elapsed clock written to the
  DOM through a ref on a 100 ms interval so React never re-renders for it
  (`83-111`), shown after 3 s, a stall affordance after 30 s (`57-66`).
- **Prose:** `ProseRowView` renders the streaming tail through `StreamingMarkdown`
  and a settled row through `CachedMarkdown` (`transcript-rows.tsx:334-346`).
  `StreamingMarkdown` (`streaming-markdown.tsx`) splits the source into top-level
  blocks at most once per animation frame (`useBlocks`, `209-262`) using
  `splitIncremental` (`src/lib/markdown-blocks.ts:83-98`: re-parses only from one
  block before the tail, exact by construction); settled blocks are LRU/worker cache
  hits (`CachedMarkdown`, `src/lib/markdown-cache.tsx`), the trailing block is
  `TransientMarkdown` (`54-151`): parsed inline when ≤ 2000 chars, otherwise a
  120 ms-throttled, latest-wins worker parse; an unclosed fence renders as plain
  `<pre>` until it closes (`169-181`); a caret follows the last block (`316`).
  The pipeline is unified → remark-gfm → rehype-highlight → rehype-sanitize →
  **HTML string → `dangerouslySetInnerHTML`** (`src/lib/markdown-render.ts:375-414`,
  `streaming-markdown.tsx:148`). That is the one part the web cannot take (§3.4).
- **Thinking:** a 26 px row, "Thinking…" with the brain glyph pulsing
  (`atlas-marker-running`) while streaming, "Thought process" after; collapsed by
  default, body is a `<pre>` (`transcript-rows.tsx:362-424`).
- **Tools:** one muted line per call with the tool glyph, shimmering while running
  (`436-518`); consecutive calls fold into one sentence line that, while live, names
  the running call, counts the ones done, and shows a live elapsed written to the DOM
  (`542-604`). Output and diffs open in the detail panel, never inline.
- **Autoscroll:** `use-transcript-scroll.ts` reads no layout in the scroll handler;
  geometry is cached and re-measured only on `ResizeObserver` (`121-126`,
  `240-259`); `atEndRef` is a ref, `AT_END = 80` px (`38`, `221-223`); `onScroll`
  marks the scroll hot and suspends hover (`226-234`). The follow is a
  `useLayoutEffect` on `[rows.length, tailLen, working]` that writes
  `scrollTop = 1 << 30` (never reads `scrollHeight`) when at the end, else counts
  unseen rows for the jump pill (`transcript.tsx:93-97`, `763-790`).
- Rows are windowed by a start index that never slides under a reader scrolled up
  (`transcript.tsx:420-440`), growing upward at a 2200 px margin
  (`use-transcript-scroll.ts:35`).
- History on this design: `d36808dc fix(chat): stop the streaming transcript
  flickering` (six causes; worth reading before porting the block renderer).

---

## 2. How the RC path streams and renders today

### 2.1 Server relay (`apps/ingest/src/rc-do.ts`)

- A host binary frame is relayed to every `ready` client **before** the ring or
  storage is touched (`binary`, `1156-1198`; `relayLive`, `1201-1207`; `sendFrame`,
  `1210-1227`). No parse, no delay. Lagging viewers (> 2 MiB unacked for 10 s) are
  cut `1013` and reconnect with `since` (`1389-1396`).
- Join: `clientHello` (`905-978`) → `enqueueJoin`/`serveJoins` under the room's
  in-flight budget (`983-1013`) → `joinPlan` (`1020-1033`: tail alone, or stored
  snapshot + tail, else wait) → `deliver` sends snapshot parts, tail frames, then
  `rc.synced { head }` (`1060-1089`). A joiner the room cannot serve is parked and a
  snapshot requested from the host (`1049-1058`); with no host it gets what there is
  plus `snapshot_unavailable` (`1097-1103`).
- A snapshot from the host is **stored and released to parked joiners only**; ready
  viewers are not redrawn (`snapshotPart`, `1257-1318`). Only a host-initiated
  resync (overflow / redial ahead of the room) sends `rc.resync { reason: "host" }`
  to ready viewers and re-serves them from scratch (`hostResync`, `1325-1355`).
  Checkpoint snapshots are requested when the stream goes quiet after ≥ half the
  tail budget (`checkpointQuiet`, `2019-2023`) — invisible to viewers.

### 2.2 Web intake (`apps/web/src/lib/use-rc-room.ts`)

- `onBinary` → `stream.apply(bytes)` → `publish()` → `setState` (`394-405`,
  `221-224`). **One React state update per socket frame**, no rAF, no batching, no
  backstop. At the desktop's ~30 frames/s that is ~30 full-page renders a second.
- `publish` is gated on `synced` (`222-224`); `rc.synced` sets it and draws the
  catch-up at once (`303-309`). The test pins this (`use-rc-room.test.tsx:155-168`).
- `rc.resync { reason: "host" }` clears `synced` and freezes the drawn transcript
  until the new snapshot and `rc.synced` arrive (`332-337`).
- Reconnection is driven only by `onclose` with jittered backoff (`432-451`); there is
  no `visibilitychange`, `online` or `pageshow` nudge. The 25 s `ping` (`428-430`)
  is what eventually notices a socket iOS killed in the background.
- `RcStream.apply` (`apps/web/src/features/rc/rc-stream.ts:86-133`) `JSON.parse`s
  each envelope and folds it; the snapshot is one `JSON.parse` of up to 1 MiB on the
  main thread (`135-154`).

### 2.3 Web reducer (`apps/web/src/features/rc/rc-transcript.ts`)

A faithful, immutable port of `applyDeltaToDraft`: `appendText` (`341-355`, trailing
renderable text message), `appendThinking` (`357-364`), `upsertTool` (`366-382`,
keeps earlier paths), `appendOutput` (`384-395`), terminal sweeps and stale-turn
drops (`441-456`, `514-553`), notices for abnormal stops (`419-425`). Ignored on
purpose: usage, context, config, commands, subagents, rate limits, holds (`554-557`).
Every change replaces only the touched message (`replaceAt`, `321-325`) — the
identity discipline a memoised row list needs is already there.

Measured (throwaway script, `/tmp/rc-bench`, Bun 1.3, M-series): reducer
0.010–0.023 ms per 2-chunk frame regardless of history length.

Two details that matter for rendering: live messages get random `live-*` ids
(`300-314`) and notices `notice-*` (`285-298`) — stable for the life of the page but
**different from the desktop ids a snapshot carries**; and `turnSeq` resets to 0 on
every snapshot (`transcriptFromSnapshot`, `257-279`).

### 2.4 Web rendering (`apps/web/src/features/rc/rc-render.tsx`)

- `RcTranscriptView` (`198-234`): `transcript.messages.map(...)`, no `memo` on any
  row, `key={m.id || i}`. Every frame re-renders every row.
- `AssistantRow` (`127-169`): thinking is a closed `Collapsible` with the static
  label "Thinking" (`146-158`); prose goes through `Markdown` from
  `apps/web/src/lib/markdown.tsx` (`159`); tool calls are a bordered list (`160-166`).
- `Markdown` (`markdown.tsx:235-283`): `splitBlocks` (fences vs paragraphs,
  `43-89`) and a single regex for inline code / link / bold / italic / mentions
  (`107-119`, `148-226`). No headings, lists, tables, blockquotes, nested lists, hr.
  An unclosed fence renders as code (`82-86`) — the right call, same as the desktop.
  Rendering the full `Markdown` for the whole transcript per frame is the cost in the
  summary; the regex loop on a single 20 KB paragraph is ~10 ms.
- `RcToolCallRow` (`50-92`): chevron, spinner while running, title, first path,
  status badge; output is a `<pre>` shown only when opened (`78-89`), capped at
  `max-h-80` with no follow-to-bottom; no elapsed, no "n done", no live line.
- Permission and elicitation cards (`172-191`, `221-226`) and the retry line
  (`227-231`) sit after the messages, not in the turn.

### 2.5 The page (`apps/web/src/routes/_app/rc.rooms.$roomId.tsx`)

- `Transcript` (`200-238`): `pinned` ref; `useEffect` on `[live.transcript]` writes
  `el.scrollTop = el.scrollHeight` (`204-207`) — a forced layout **read** every
  frame, after paint (one frame at the old position, then the jump); the pin
  threshold is 48 px measured in `onScroll` from `scrollHeight` (`213-216`), another
  read on every scroll event. No jump-to-latest pill, no unseen count, no hold for a
  fling. A skeleton shows until `synced` (`220-226`).
- Status: a header badge "Live" / "Catching up" / "Reconnecting" (`162-166`); the
  composer shows Stop while `status` is `running | waiting` (`288`, `342-347`).
  Nothing in the transcript says the agent is working.
- No turn boundaries; `plan` is in the reducer but not drawn; `rc_trimmed_messages`
  is read nowhere.
- Mobile: this page is the "mobile" surface (the PWA manifest is `standalone`,
  `apps/web/public/manifest.webmanifest`; there is no separate app under
  `apps/`). The layout uses `min-h-0 flex-1` without `dvh`; the `Textarea` is
  `text-sm` (iOS zooms inputs under 16 px on focus); no `visualViewport` handling.

### 2.6 Measurements

Per 33 ms frame of two text chunks, synthetic transcript, Bun SSR on an M-series Mac
(the browser's DOM reconcile is on top of these; a mid-range phone is 3–5× slower):

| prior turns | messages | snapshot | reducer | render **all** rows (today) | render tail only |
| ----------: | -------: | -------: | ------: | --------------------------: | ---------------: |
|           5 |       12 |    6 KiB | 0.02 ms |                     2.0 ms |          0.3 ms |
|          30 |       62 |   36 KiB | 0.01 ms |                     5.7 ms |          0.2 ms |
|         100 |      202 |  118 KiB | 0.01 ms |                    18.0 ms |          0.2 ms |
|         300 |      602 |  356 KiB | 0.02 ms |                    54.5 ms |          0.2 ms |

Renderer cost for one 2.8 KB GFM message: `react-markdown` + `remark-gfm` 6.0 ms,
`lib/markdown.tsx` 0.63 ms; `react-markdown` on a 120-char trailing block 0.46 ms.
So the richer renderer is affordable **only** if settled blocks are not re-rendered —
which is the desktop's design and the one to port.

---

## 3. Gaps, ranked by what the user sees

1. **Jank that grows with the conversation** (§2.4, §2.6). Whole-transcript
   re-render per frame; at 200 messages a frame budget is gone before React
   reconciles. On a phone this is dropped frames and a laggy scroll during every
   reply.
2. **Replies look like raw text until the turn ends — and still after.** No
   headings/lists/tables (§2.4); nothing formats block-by-block as it streams.
3. **Dead air.** Nothing between send and first token; "Thinking" never says it is
   live; running tools have no live line, elapsed or count (§2.4, §2.5). The reader
   cannot tell "working" from "stuck".
4. **Autoscroll feel.** Post-paint jump each frame, forced layout per frame and per
   scroll event, no pill when scrolled up, no fling hold (§2.5). Mobile Safari will
   show unpainted stretches during momentum scroll exactly as WKWebView did before
   `scroll-hot.ts`.
5. **Intake cadence.** One state update per socket frame (§2.2). With rAF batching
   the page would render at most once per display frame and the backstop would keep a
   backgrounded tab's transcript current.
6. **Tool output.** Streams in but is hidden unless opened; opened, it does not follow
   its tail; no cap for a 1 MB `cat` on a phone (§2.4).
7. **Turn structure.** No separator between turns, no footer (stop reason, duration),
   plan not drawn, queue not drawn in the thread (§2.5).
8. **Resync remount.** A host resync replaces the transcript with desktop-id messages;
   every `live-*` row remounts; scroll position and open tool rows are lost (§2.1,
   §2.3). Rare (overflow/redial), but it is the one visible glitch in the
   snapshot↔live seam.
9. **Mid-turn join.** A joiner gets the snapshot, the tail and `rc.synced`, then the
   whole page draws at once; a 1 MiB snapshot parses on the main thread (§2.2). The
   trimmed-messages count is never shown.
10. **Mobile lifecycle.** No redial on `visibilitychange`/`online`/`pageshow`; rAF
    (once added) pauses in a background tab; no `dvh`, keyboard or input-zoom handling
    (§2.2, §2.5).

Not a gap: the 33 ms coalescer, the relay, the seq/`as_of_seq` rules, redaction, the
reducer's semantics. Leave them.

---

## 4. Design to reach parity

Guiding rule: port the desktop's **mechanisms** (frame batching, incremental block
rendering, read-free scroll loop, DOM-written clocks, row projection), not its
renderer. §14.9 of `docs/research/universal-rc-api-plan.md` forbids an HTML path in
the RC feature; `react-markdown` renders to React elements and is already used with
`skipHtml` and a safe `urlTransform` in
`apps/web/src/components/session/entry-rail.tsx:351-370`, so it satisfies "a renderer
with the same guarantee" without a new dependency.

### 4.1 Server repo — `apps/web`

**A. Frame intake becomes per-animation-frame.** `src/lib/use-rc-room.ts`

- Keep `RcStream` applying frames synchronously as they land (seq/ack semantics are
  untouched). Replace `publish()`'s immediate `setState` with a scheduler modelled on
  `App.tsx:757-850`: one `requestAnimationFrame` **and** a 250 ms `setTimeout`
  backstop (rAF is paused in background tabs on every mobile browser), flushing one
  `setState({ transcript, incomplete })` with the latest `stream.transcript`. The
  `synced` gate stays exactly as it is; `rc.synced` flushes synchronously.
- Hold the flush while the reader is mid-fling: a `markScrollHot()`/`isScrollHot()`
  pair (copy `src/lib/scroll-hot.ts`), called from the transcript's `onScroll`, with
  the same 400 ms cap.
- Add `visibilitychange` (→ flush, and if the socket is not `OPEN`, redial now
  instead of waiting out the backoff), `online` and `pageshow` nudges — the web
  analogue of the host's `RoomHandle::nudge` (`host.rs:284-287`). `lastApplied` is
  kept, so the redial says hello with `since` and takes the tail path.
- Optional: parse the snapshot off-thread (a worker `JSON.parse` for > 256 KiB) so a
  mid-turn join on a phone does not block the main thread for the first paint.

**B. Stable identities and memoised rows.** `src/features/rc/rc-render.tsx`,
`rc-transcript.ts`

- `memo(UserRow)`, `memo(AssistantRow)`, `memo(RcToolCallRow)` keyed by message id /
  tool call id. The reducer already replaces only the touched message, so a frame
  re-renders exactly the trailing message. `key={m.id || i}` → always `m.id` (ensure
  the reducer never yields an empty id; `messageOf` falls back to `''` today at
  `rc-transcript.ts:201`).
- Tool-row open state keyed by `tool_call.id` in a small map on the view (not
  `useState` inside the row) so it survives a message object being replaced and a
  snapshot resync (tool call ids are the agent's, stable across snapshot and stream).
- On a host resync, reconcile ids: when the new snapshot's trailing messages match
  the drawn `live-*` messages (same role, content is a prefix/equal, same tool call
  ids), keep the drawn ids. Cheap, bounded to the last few messages, and it turns a
  remount into an update.

**C. A row projection with turns and a working state.** New
`src/features/rc/rc-rows.ts` (a small port of `turn-rows.ts`, no subagents, no
comments):

- Group `messages` into turns at each `user` message; emit a separator between
  turns, user row, thinking rows, prose rows, one marker-group row per run of
  consecutive tool messages, and a turn footer (stop reason from the existing
  notices, duration from the user message timestamp to the terminal).
- `streaming` on the trailing assistant rows while `status` is `running|waiting`;
  `working` when the live turn has no assistant row yet
  (`transcript.tsx:411-418`'s rule).
- Marker group while live: `liveLabel` = "Running {title}", `liveDone`, and a start
  time stamped by the reducer on first sight of a tool call (`startedAt: Date.now()`
  in `toolCallOf`'s upsert path, as the desktop does at `chat-store.ts:2451-2452`).
  After a mid-turn join the start is unknown — show no clock, as the desktop does
  for a pending call (`turn-rows.ts:1136-1139`).
- The reducer's `plan` becomes a row at the top of the live turn (desktop:
  `plan-tasks-pill.tsx`); `queue` becomes a line under the composer.

**D. Streaming markdown that formats block by block.** New
`src/features/rc/rc-streaming-markdown.tsx`

- Source split into top-level blocks with a port of `splitIncremental`
  (`src/lib/markdown-blocks.ts:48-137`). The desktop uses `remark-parse` positions;
  `react-markdown` pulls `remark-parse`/`unified` in transitively, but importing
  them directly means listing them in `package.json` — one line, worth a sentence in
  the PR rather than a hand-rolled splitter that will disagree with the renderer on
  what a block is. Port `markdown-blocks-incremental.test.ts`'s prefix property
  (incremental split == full split for every prefix).
- Settled blocks: `memo(Block)` keyed by its source string, rendered with
  `<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safe}
  components={{ img: link, a: safeAnchor }}>` — the `entry-rail.tsx` configuration,
  lifted into a shared `src/lib/rc-markdown.tsx` so both callers use one. The
  wrapper is `display: contents` so block margins collapse as one document
  (`streaming-markdown.tsx:25-28`; and read `d36808dc` for the rhythm-at-settle trap).
- Trailing block: re-rendered each frame (0.46 ms measured); an unclosed fence
  renders as a plain `<pre>` with the caret until it closes
  (`isIncompleteCodeFence`, `markdown-blocks.ts:159-171`); a caret after the last
  block while streaming (CSS-only, opacity animation).
- Split at most once per animation frame (`useBlocks`, `streaming-markdown.tsx:
  209-262`, including the StrictMode `rafRef` reset) — with the intake already on
  rAF this is one extra guard, not a second scheduler.
- Code highlighting: none on the web today. Leave it out of this pass (the desktop
  only highlights explicitly tagged fences and found auto-detect to be the dominant
  cost, `markdown-render.ts:385-390`). Adding `rehype-highlight` is a dependency
  discussion.
- `lib/markdown.tsx` stays for user prompts (chat parity, mentions) and for anything
  outside RC.

**E. Scroll discipline.** New `src/features/rc/use-rc-scroll.ts`, a port of
`src/features/chat/lib/use-transcript-scroll.ts` minus the upward-grow (until the
row window lands):

- No layout reads in `onScroll`; a `ResizeObserver` on content + scroller invalidates
  cached `scrollHeight`/`clientHeight`; `atEndRef` with `AT_END = 80`.
- Follow in a `useLayoutEffect` keyed on `[rows.length, tailLen, working]` writing
  `scrollTop = 1 << 30` (`transcript.tsx:763-790`). Never read `scrollHeight` in the
  follow.
- Jump-to-latest pill with the unseen row count when scrolled up (`more`,
  `newCount`); `markScrollHot()` in `onScroll` for the intake hold.
- Row window: start-index anchored, grows at the top on scroll
  (`transcript.tsx:420-440`, `use-transcript-scroll.ts:32-35`). On mobile this is
  what keeps a 600-message room cheap to mount; until it lands, `content-visibility:
  auto` with `contain-intrinsic-size` on settled rows is a one-line stopgap.

**F. Status in the thread.**

- Working indicator under the live turn (port `loading-state.tsx`: "Waiting for
  model", elapsed via a ref-written 100 ms timer that pauses when hidden, shown after
  3 s, "still going" after 30 s). The desktop's reason for the label wording is at
  `loading-state.tsx:68-75`; keep it.
- Thinking row: "Thinking…" with the pulsing glyph while streaming, "Thought process"
  after; collapsed by default; when expanded while streaming, the `<pre>` follows its
  tail.
- Marker group live line: glyph of the running tool, shimmer, "n done", elapsed.
- Tool output pane: when open and running, stick to bottom; render only the last
  64 KiB with a "… earlier output on the desktop" lead (the desktop opens output in
  a panel; a phone has no panel).
- Header badge stays; add a one-line "{n} older messages stayed on the desktop" from
  `rc_trimmed_messages` when present.

**G. Mobile.**

- `100dvh` on the route shell, `overscroll-behavior: contain` on the scroller,
  `touch-action: pan-y`, passive scroll listener.
- `Textarea` ≥ 16 px on touch (iOS focus zoom), `visualViewport` `resize` →
  re-follow the live edge when the keyboard opens/closes.
- Everything in A (backstop, visibility redial) is the mobile-lifecycle fix.
- Settled thinking/tool `<pre>` blocks capped (`max-h`) with `overflow:auto`, so a
  long reply never becomes a 40-screen scroll of monospace.

**H. Tests (server repo).**

- `src/lib/use-rc-room.test.tsx`: with fake timers and a stubbed rAF — N binary
  frames in one tick produce one state update; a frame with rAF paused is published by
  the 250 ms backstop; `visibilitychange` flushes and redials a closed socket with
  `since`; the catch-up gate test at `155-168` still passes unchanged.
- `src/features/rc/rc-stream.test.ts`: unchanged (no semantic change).
- `src/features/rc/rc-transcript.test.ts`: `startedAt` stamped on first upsert only;
  id reconciliation on resync keeps drawn ids; `turnSeq` after snapshot.
- `src/features/rc/rc-rows.test.ts`: turn grouping, `streaming`/`working`, marker
  group live label/count, footer stop reason.
- `src/features/rc/rc-streaming-markdown.test.tsx`: incremental split == full split
  for every prefix of fixtures with setext headings, lazy continuation, lists,
  fences; unclosed fence is `<pre>`; settled block component does not re-render when
  the tail grows (render-count spy); no `dangerouslySetInnerHTML` in the feature;
  `<script>`, `javascript:` and `![](https://…)` render as text/link
  (`rc-render.test.tsx` already holds the last three — extend to the new renderer).
- `src/features/rc/use-rc-scroll.test.ts`: `atEnd` latch, pill count, no
  `scrollHeight` read in the scroll handler (spy on the getter).
- A `vitest bench` (or keep the throwaway script's shape) asserting render time is
  flat in transcript length — the regression that caused this document.

### 4.2 Desktop repo — `atlas`

Nothing is required for parity. Two small, optional improvements:

- `crates/atlas-remote-control/src/snapshot.rs`: nothing. `rc_trimmed_messages` is
  already there for F.
- `src-tauri/src/commands/rc.rs` / `host.rs`: nothing on the hot path. The 33 ms
  window is the right number (the page renders at 60 Hz; the window bounds the
  object's fan-out).
- If the team wants a tool-call clock to survive a mid-turn join, see §5.

### 4.3 Order of work

1. A + B (intake on rAF, memoised rows, stable ids) — removes gap 1 and 5 with no
   visual change; measurable with the bench.
2. E (scroll hook, pill, hold) — gap 4.
3. C + F (rows, working state, live tool line, thinking state) — gap 3, 7.
4. D (streaming markdown on react-markdown) — gap 2, 6.
5. G (mobile) and the resync reconciliation in B — gaps 8, 9, 10.

---

## 5. Wire / delta changes

**None needed.** Every signal the design uses is on the wire already: `status` with
`turn_seq` marks a turn's start; `user_message` is the turn boundary and carries the
timestamp the working clock counts from; `turn_finished.stop_reason` /
`turn_failed.error` feed the footer; `thinking_chunk`, `tool_call_output_chunk`,
`plan_updated`, `queue_changed`, `retry_status` are all relayed verbatim and already
reduced; the snapshot carries `rc_trimmed_messages`.

A tool call's elapsed clock for a viewer who joined mid-call needs **no new field**:
`ToolCall.started_at_ms` / `ended_at_ms` (`crates/atlas-agent-wire/src/types.rs`) are
already stamped by the projector on first sight and on settling, travel on both
`tool_call_upserted` and the snapshot, and are covered by the wire contract tests. The
web's `toolCallOf` reads them; without them it would stamp `Date.now()` on first sight
as the desktop store once did.

Do not change `is_streamed_text` (`batch.rs:22-29`), the coalescing constants, or the
snapshot's `EXPENDABLE` list; the viewer draws none of what they drop.
