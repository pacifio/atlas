# Telemetry

Atlas collects usage data to find out what breaks and what gets used. This file is
the complete catalogue: every event, every property, and the list of things that are
never collected under any circumstance.

If something is not in the table below, Atlas does not send it. If you find something
that contradicts this file, that is a bug — please open an issue.

- Emitter: [`src-tauri/src/telemetry/mod.rs`](src-tauri/src/telemetry/mod.rs) (Rust, all product events)
- Per-turn analytics: [`src-tauri/src/commands/agent_analytics.rs`](src-tauri/src/commands/agent_analytics.rs)
- Crash reporter: [`src/features/telemetry/posthog-client.ts`](src/features/telemetry/posthog-client.ts) (renderer failures only)
- Backend: [PostHog](https://posthog.com)

> **What changed in 0.2.4.** Through 0.2.3 this document promised that telemetry was
> anonymous permanently, and that signing in to an Atlas account would never be
> linked to it. **That is no longer true, and the change was deliberate.** Signing in
> now attributes your usage data to your account, and merges the anonymous history
> from that device into it. The consent toggle still governs everything: with it off,
> nothing is sent, and signing in sends nothing. See
> [Identity](#identity-one-device-plus-your-account-when-you-sign-in).

---

## Consent

The toggle is **Settings → General → "Share usage data"**. It defaults to **ON**, the
same opt-out posture as VS Code and Zed, and it can be turned off at any time — the
change takes effect immediately, without a restart.

With the toggle off, `capture()` returns before anything is queued. Nothing is
buffered for later, and nothing is sent.

A second toggle, **"Link usage data to my account"**, controls only the account
linkage below. Turning it off keeps you on the anonymous device identity even while
signed in. It cannot un-merge history PostHog has already attributed.

A build with no PostHog key resolved is **inert**: the client is constructed dead, the
frontend never loads `posthog-js` at all, and both toggles do nothing. Source builds
are inert unless you supply your own key (see [Self-hosting](#self-hosting-and-opting-out-entirely)).

---

## Identity: one device, plus your account when you sign in

**Signed out**, the identity is a single random UUID stored in
`<app_config_dir>/device.json`, generated on first launch. It is the PostHog
`distinct_id` for both the Rust emitter and the renderer's crash reporter, so one
machine maps to one person. It is not derived from your machine, your hardware, your
account, or anything about you — it is random bytes in a file. **Delete `device.json`
to reset your analytics identity.**

(Before 0.2.4 this id lived in `state.json`, where a bug wiped it on every settings
change — so a single install appeared in PostHog as a crowd of one-launch strangers.
An install upgrading from 0.2.3 keeps the id it already had.)

**Signed in**, Atlas sends PostHog an `$identify` that switches the identity to your
Atlas account id and carries `$anon_distinct_id` — the device id. PostHog **merges the
device person into the account person**, which means events that device sent *before*
you signed in are re-attributed to your account. That is retroactive, it is what
"merge" means, and it is stated here rather than buried because the previous version
of this document promised the opposite.

Signing out reverts to the device identity. It does not un-merge anything.

Two things still hold:

- **An install that has never opted in sends nothing extra as a result of signing
  in.** Identity is consent-gated like everything else. The account feature is not a
  telemetry backdoor.
- **Your avatar path is never sent.** It is an absolute local path, and paths do not
  leave your machine.

---

## Common properties

Every event carries these, and nothing else implicitly:

| Property | Value |
| --- | --- |
| `$lib` | `atlas-rust` (Rust emitter) or `atlas-js` (renderer crash reporter) |
| `app_version` | Atlas version, e.g. `0.2.4` |
| `os` | `macos`, `linux`, `windows` |
| `arch` | `aarch64`, `x86_64` |
| `$groups` | `{ organisation: <local org id> }` — whenever an Organisation is active |
| `atlas_org_id` | The same local Organisation id, as a plain property |
| `atlas_org_kind` | `cloud` (the org is synced) or `local` (it exists only on this machine) |

**Organisation scoping.** Every event is attributed to the Organisation you are
working in, so usage can be read per tenant rather than as one global stream.
That includes **local-only orgs and events sent while signed out** — the active
Organisation is a local fact, not an account one. The id that travels is always
the *local* id: a random UUID this install minted, meaningless to anyone else.

A **local** org's **name is never sent** — it is a string you typed into a box on
your own machine. Only a synced org's name and your role in it are sent, and only
via `$groupidentify` (both are already server-side and shared with everyone in
that org).

PostHog also records the ingest timestamp and the request's IP, which it uses for
coarse geo-resolution. Atlas sends no other device, network, or locale information.

---

## Event catalogue

### Lifecycle

| Event | When | Properties |
| --- | --- | --- |
| `app_started` | Atlas launches | `is_first_launch` (bool), `device_id_source` (`random` / `adopted`) |
| `rust_panic` | A Rust panic, sent synchronously from the panic hook | `location` (Atlas's own `file:line`), `message` (redacted of path / URL / email tokens, truncated to 160 chars) |

### Account

| Event | When | Properties |
| --- | --- | --- |
| `$identify` | Sign-in, or when your account details change | `$anon_distinct_id` (device id, on the merge only), `$set` → `email`, `name`, `atlas_account`, `atlas_org_count`, `atlas_active_org_id`; `$set_once` → `atlas_device_id` |
| `$groupidentify` | A **synced** Organisation becomes active (switch, sign-in, or "Turn on sync") | `$group_type: organisation`, `$group_key` (local org id), `$group_set` → `name`, `role`, `kind`. Never sent for a local-only org — there is nothing about it we are willing to describe. |
| `auth_signed_in` | A device-authorization grant completes | `org_count`, `has_active_org` |
| `auth_signed_out` | The user signs out from the account menu | `had_account` |

`auth_signed_out` records the *user's* action only; a session the server ended (expiry
or revocation) emits nothing, because folding the two together would leave a count
that means neither one thing nor the other.

`$identify` is idempotent — it is sent when something actually changed, not on every
relaunch. Switching directly from one account to another never carries
`$anon_distinct_id`: merging two accounts is irreversible in PostHog.

### Agents

| Event | When | Properties |
| --- | --- | --- |
| `agent_turn_started` | A turn begins | `agent_family`, `plugin_id`, `session_ref`, `turn_seq` |
| `agent_turn_completed` | A turn ends, however it ends | see below |

`agent_family` is `acp` or `cersei`; `plugin_id` is the real agent (`claude-code-ts`,
`codex`, `cersei`). `session_ref` is a salted, non-reversible 16-character digest that
joins a start to its completion — never the agent's real session id, which for Claude
Code appears in on-disk transcript paths. The salt is minted per launch and never
persisted.

`agent_turn_completed` carries:

- **Outcome** — `outcome` (`finished` / `failed` / `disconnected`), `stop_reason`,
  `error_kind`, `error_summary` (redacted, ≤160 chars), `duration_ms`
- **Tools** — `tool_call_count`, `tool_calls_completed`, `tool_calls_failed`,
  `tool_kinds` (a count per kind: read, edit, execute, search, fetch, …),
  `tool_names` (normalised; any MCP tool collapses to `mcp`), `distinct_tool_count`
- **Files** — `files_read`, `files_written` (distinct **counts**, derived from salted
  in-memory digests), `file_extensions` (e.g. `{ rs: 4, ts: 9 }`), `lines_added`,
  `lines_removed`
- **Tokens** — `turn_input_tokens`, `turn_output_tokens`, `turn_cost_usd` for the
  native agent; `context_used`, `context_size`, `context_pct` for ACP agents, which
  cannot report a token split. `token_source` (`usage` / `context` / `none`) says
  which. Absent rather than zero when unknown.
- **Session shape** — `permission_requests`, `permissions_resolved`, `retries`,
  `compactions`, `compression_saved_tokens`, `assistant_messages`, `plan_updates`,
  `mode_changes`, `model_id`

Note what these do **not** carry: no prompt, no response, no file path, no tool
argument, no tool output, no project or repository, no diff.

### Harness and retrieval health

| Event | When | Properties |
| --- | --- | --- |
| `harness_turn` | An Atlas Agent turn ends (mirrors the local `atlas::harness` tracing line) | `edit_calls`, `edit_not_found`, `doom_loop_triggers`, `steered`, `retries`, `compaction_events`, `permission_asks`, `tokens_in`, `tokens_out`, `wall_clock_ms` — counters only |
| `retrieval_invoked` | A memory/codebase retrieval path runs | `path` (one of four fixed names: `memory_retrieve` / `memory_chat` / `memory_index_query` / `codebase_status` — never a filesystem path), `invoked_by` (`push` / `tool` / `ui`), `n_results_bucket` (`0` / `1-3` / `4-10` / `11+`) |

These exist to answer "does the harness thrash?" and "is retrieval ever
invoked, and does it find anything?" — counts and buckets only. The richer
local lines (which additionally carry ladder-strategy names, corpus sizes, and
scores) stay on your machine in the process log; the PostHog copies are
whitelisted subsets, enforced in `telemetry/bridge.rs` and
`telemetry/retrieval.rs`.

### Other product events

| Event | When | Properties |
| --- | --- | --- |
| `model_chat_sent` | A direct model chat completes | `provider`, `model`, `input_tokens`, `output_tokens` |
| `code_review_completed` | An AI code review finishes | `provider`, `model` |

### Feedback

| Event | When | Properties |
| --- | --- | --- |
| `feedback_submitted` | You press Send in the feedback panel | `category`, `message` (verbatim), `has_screenshot`, `screenshot_bytes`, `screenshot_b64` (downscaled), `anonymous`, `account_id` / `account_email` / `active_org_id` (signed in and not anonymous), `telemetry_opt_in`, `source`, `active_tab` |

Feedback is the one thing here that is **not** redacted — your message is sent exactly
as you typed it, because a bug report with the paths stripped out is not a bug report.
A screenshot is attached only if you attach one; it is downscaled before sending, and
dropped if it is still too large (the words go regardless).

See [The two things that are not consent-gated](#the-two-things-that-are-not-consent-gated).

### Consent itself

| Event | When | Properties |
| --- | --- | --- |
| `telemetry_opt_in` | The toggle is switched on | *none* |
| `telemetry_opt_out` | The toggle is switched off | *none* |

`telemetry_opt_out` is sent while telemetry is still enabled, so nothing is
transmitted after the moment you opted out.

### Renderer crashes

`posthog-js` is loaded for **crash reporting only**. Autocapture, pageviews, page-leave
events, and session recording are all explicitly disabled — the renderer captures no
usage events of any kind.

| Event | When | Properties |
| --- | --- | --- |
| `$exception` | A React render error, uncaught `window.onerror`, or unhandled promise rejection | The error message and stack, plus `type` (`react_error_boundary` / `uncaught_error` / `unhandled_rejection`), `source`, and a truncated `component_stack` |

A short list of known-benign, non-actionable errors is dropped before it reaches
PostHog. Note that a JavaScript stack trace can contain bundled file names; it does not
contain your files, your project path, or your content.

---

## Never collected

None of the following leaves your machine as telemetry, with or without consent:

- **Prompts and responses.** No message you write to an agent, and nothing it writes back.
- **Code.** No file contents, no diffs, no patches, no repository names or remotes.
- **Paths.** No absolute or relative file paths, no project or directory names, no file
  names. Turn analytics count *distinct files* using salted in-memory digests that are
  never transmitted, and report the file **extension** only (`rs`, `ts`) — never the
  name, the stem, or the directory. A dotfile like `.env` reports no extension at all.
  Free-text fields (`message`, `error_summary`) run through a redactor that strips
  path-like, URL-like, and email-like tokens.
- **Tool arguments and tool output.** Counted and classified, never transmitted.
- **Knowledge, notes, canvases, chat history, memory.** None of it, in any form.
- **API keys and credentials.** No provider keys, no Atlas session token, no access JWT,
  no device code. These are never logged either.
- **Terminal input or output.**
- **Browser URLs, page contents, or history** from the in-app browser.
- **Your avatar path**, which is an absolute local path.
- **Keystrokes, screenshots, or session recordings** — except a screenshot you
  deliberately attach to feedback, which you can preview and remove before sending.

---

## The two things that are not consent-gated

**1. The auto-update check.** It queries PostHog's remote-config endpoint for the
latest version and download URL, carrying the device id and the common properties. It
is deliberately independent of the telemetry toggle, because an app that stops
learning about security updates when you decline analytics is a worse deal than the
one you thought you were making. It is not analytics and captures no event. It is
gated by its own setting: **Settings → Updates → "Automatic updates"**.

**2. Feedback you submit.** The feedback panel sends even when "Share usage data" is
off, because a button labelled "Send" that silently discards your bug report is worse
than the send itself. The panel says so on screen when the toggle is off, and every
submission carries `telemetry_opt_in` so its consent state travels with it. It never
sends anything you did not type or attach.

An inert build makes neither request.

---

## Deleting your data

Every event is attributed to either your device id or your Atlas account id. Ask us to
delete either person and everything attributed to it goes with it — open an issue or
use the feedback panel. Deleting `device.json` gives you a fresh anonymous identity
locally, but does not remove what was already sent.

---

## Self-hosting and opting out entirely

The PostHog key and host resolve in this order, first match winning:

1. `ATLAS_POSTHOG_KEY` / `POSTHOG_KEY` (+ `ATLAS_POSTHOG_HOST` / `POSTHOG_HOST`) from
   the environment or a `.env` file
2. `<app_config_dir>/telemetry.json` — `{ "key": "...", "host": "..." }`
3. A compile-time key baked into official release builds
4. Nothing — the client is permanently inert and makes no network calls

Point rungs 1 or 2 at your own PostHog project to keep your organisation's data in
your own instance. Build from source without a key to have no telemetry path at all.
