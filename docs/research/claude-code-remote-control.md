# How Claude Code Remote Control works (primary sources)

Researched 2026-10-23 against Anthropic's own documentation only. Every claim carries
the URL it came from; anything the sources do not state is marked **unconfirmed**.

Sources used (all first-party):

- RC — https://code.claude.com/docs/en/remote-control (the feature page; `docs.claude.com/en/docs/claude-code/remote-control` 301-redirects here)
- MOBILE — https://code.claude.com/docs/en/mobile
- WEB — https://code.claude.com/docs/en/claude-code-on-the-web
- PERM — https://code.claude.com/docs/en/permission-modes
- DESKTOP — https://code.claude.com/docs/en/desktop
- PROJECTS — https://code.claude.com/docs/en/claude-projects
- SECURITY — https://code.claude.com/docs/en/security
- DATA — https://code.claude.com/docs/en/data-usage
- AVAIL — https://code.claude.com/docs/en/feature-availability
- CLI — https://code.claude.com/docs/en/cli-reference
- SETTINGS — https://code.claude.com/docs/en/settings-reference
- ERRORS — https://code.claude.com/docs/en/errors
- XSESSION — https://code.claude.com/docs/en/cross-session-messaging
- W34 — https://code.claude.com/docs/en/whats-new/2026-w34
- CHANGELOG — https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- HC-TIPS — https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- HC-NOTES — https://support.claude.com/en/articles/12138966-release-notes

No dedicated Anthropic launch post for Remote Control was found on anthropic.com or
claude.com; the feature is documented through the docs, the changelog and the help
center. **Unconfirmed** that a separate announcement exists.

## What it is, in one paragraph

"Remote Control connects claude.ai/code or the Claude app for iOS and Android to a
Claude Code session running on your machine." "Claude keeps running locally the entire
time, so your code execution and filesystem access stay on your machine." "The web and
mobile interfaces are a window into that local session, so your computer has to stay on
and the `claude` process has to keep running." (RC) It is explicitly distinct from
cloud sessions: "`--cloud` creates cloud sessions. `--remote-control` is unrelated: it
lets you monitor and steer a local CLI session from claude.ai or the Claude app." (WEB)

Timeline from the changelog: `claude remote-control` subcommand added in v2.1.51
("enabling local environment serving for all users"); "Expand Remote Control to more
users" in v2.1.58; VS Code `/remote-control` in v2.1.79; "Remote Control is also out of
research preview" in the week of Aug 17-21 2026 (v2.1.234-239). (CHANGELOG, W34)

## 1. Identity and scope

**Identity = the claude.ai account (and organization) signed in on the laptop.**

- "A Remote Control session that you started while signed in through `/login` belongs
  to the claude.ai account and organization that were signed in at the time." (ERRORS,
  "Remote Control stopped because the signed-in account changed")
- If the account or org changes on the laptop, the session is torn down: "Claude Code
  stops the Remote Control session as soon as claude.ai confirms that the account or
  organization changed. Your local session keeps running without Remote Control."
  (ERRORS) Same for Desktop/IDE-hosted sessions: "If the app answers that it's signed
  out, or that it's now signed in to a different Claude account, Claude Code ends the
  Remote Control session." (ERRORS)
- API keys and long-lived tokens are not an identity for RC: "API keys are not
  supported" (RC); "`claude setup-token` or the `CLAUDE_CODE_OAUTH_TOKEN` environment
  variable ... can only make model requests, so they can't establish Remote Control
  sessions." (RC) Bedrock / Vertex / Foundry / any non-`api.anthropic.com`
  `ANTHROPIC_BASE_URL` / enterprise apps gateway: not available. (RC, AVAIL)

**The phone/web must sign in as the same account and organization.**

- "Sign in with the same claude.ai account and organization you use for Claude Code.
  Cloud sessions and Remote Control require a claude.ai account, so they aren't
  reachable with an Anthropic Console API key or from a third-party provider." (MOBILE)
- "A connected session appears in the session list at claude.ai/code and in the Claude
  apps on devices signed in to your claude.ai account." (DESKTOP)
- "Auto-connect signs in with your own claude.ai account, so a session it starts
  appears only in your own account's Claude apps and grants no one else access." (RC)
- Cloud-session teleport uses the same rule: "You must be authenticated to the same
  claude.ai account used in the cloud session." (WEB)

**Can anyone other than the owner see or join?** Not by default. The docs describe the
session as visible only to the owner's own account (quotes above). There is no
"invite", "hand control" or "join" concept anywhere in RC, MOBILE, DESKTOP or
CHANGELOG. The only cross-user mechanism documented at claude.ai/code is "Share
sessions" (Private/Team on Team+Enterprise, Private/Public on Pro/Max), described under
cloud sessions, and it is a read-only snapshot: "Recipients see the latest state when
they open the link, but their view doesn't update in real time." (WEB) **Unconfirmed**
whether that share toggle is offered on a Remote Control session at all; the RC page
never mentions sharing.

**Device binding is optional, on top of the account.** "Trusted Devices" (beta,
off by default): "It ties Remote Control access to a known device and a recent
authentication, not just a signed-in account." Requires "an enrolled device" and "a
recent sign-in: the member's sign-in must be no more than 18 hours old", refreshed via
"Face ID, Touch ID, Windows Hello, or a passkey". "The machine running Claude Code
receives its own credential automatically when the developer signs in to the CLI."
Members manage devices at claude.ai/settings/account; admins can "Sign out everywhere".
(RC) Help center: Team/Enterprise admins "can now require members to verify their
device before viewing or steering local Claude Code sessions remotely" (June 25 2026,
HC-NOTES).

**How a session is discovered on the phone: all three — list, link, QR.**

- List: "Open claude.ai/code or the Claude app and find the session by name in the
  session list. In the Claude mobile app, tap **Code** in the navigation to reach the
  session list. Remote Control sessions show a computer icon with a green status dot
  when online." (RC)
- Link: "Open the session URL in any browser to go directly to the session on
  claude.ai/code." (RC) The CLI "displays a session URL"; the session ID is "the part
  of the session's URL at claude.ai/code between `/code/` and any `?`". (RC)
- QR: "Scan the QR code shown alongside the session URL to open it directly in the
  Claude app. With `claude remote-control`, press spacebar to toggle the QR code
  display." (RC) VS Code "does not accept a name argument or display a QR code." (RC)
- Machine-level discovery (server mode only): "Any machine running `claude
  remote-control` now shows up as a device card at the top of the Code tab in the
  Claude app ... Tap it to pick a directory and start a session there." (W34) The help
  center phrases it as "`claude remote-control` lets you spawn a new local session from
  the mobile app." (HC-TIPS)
- Naming: title precedence is `--name` / `--remote-control "name"` /
  `/remote-control name` → `/rename` → last meaningful message → auto name like
  `myhost-graceful-unicorn` (hostname prefix, overridable with
  `--remote-control-session-name-prefix` or `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX`).
  Renaming from the phone updates the local title too. (RC)

## 2. Session lifecycle

**Start (three CLI modes + Desktop/VS Code):**

| How | What it does | Source |
| --- | --- | --- |
| `claude remote-control` (server mode) | "The process stays running in your terminal in server mode, waiting for remote connections." No local chat; serves up to `--capacity` (default 32) sessions; `--spawn same-dir \| worktree \| session`; `--permission-mode`, `--name`, `--chrome`, `--continue`, `--session-id`, `--[no-]create-session-in-dir`. One-time `Enable Remote Control? (y/n)` consent, plus workspace-trust prompt in untrusted dirs. | RC, CLI |
| `claude --remote-control` / `--rc` ["name"] | "a full interactive session in your terminal that you can also control from claude.ai or the Claude app" | RC, CLI |
| `/remote-control` / `/rc` [name] inside a session | "starts a Remote Control session that carries over your current conversation history"; one-time **Enable Remote Control** dialog; run again to open status panel / disconnect | RC |
| VS Code / Desktop `/remote-control` | Same; Desktop also has a per-session **Remote Control** switch and "Connect new sessions to Remote Control" setting | RC, DESKTOP |
| Auto-connect | `/config` → **Enable Remote Control for all sessions**, or `remoteControlAtStartup: true` in user or managed settings; a project `.claude/settings.json` can only turn it *off* ("a checked-in file can't turn on Remote Control for everyone who opens the repository") | RC, SETTINGS |

"One remote session per interactive process ... Use server mode to run multiple
concurrent sessions from a single process." (RC)

**While connected:** "the conversation and the progress of subagents and dynamic
workflows stay in sync across all connected devices, so you can send messages from your
terminal, browser, and phone interchangeably." (RC) The terminal shows an `/rc active`
footer pill linking to the session. (RC)

**Terminal closed / process stopped → session goes offline (not deleted).** "If you
close the terminal, quit the Desktop app or VS Code that runs the session on your
machine, or otherwise stop the `claude` process, the session goes offline until you
bring it back. If you run `claude` from a terminal on a remote machine, start it
inside `tmux` or `screen`." (RC)

**Laptop sleep / network drop → automatic reconnect.** "if your laptop sleeps or your
network drops, Claude Code reconnects automatically when your machine comes back
online." (RC, MOBILE) Projects: "The thread pauses while that computer is asleep, and
stops if the desktop app or `claude remote-control` quits." Desktop has "Keep this
computer awake for Remote Control". (PROJECTS)

**Extended outage limits:** server mode "gives up after roughly 10 minutes and the
`claude remote-control` process exits"; interactive mode "retries for as long as the
outage lasts". HTTP 403 from a VPN/proxy: retries "for up to three minutes". Presence
heartbeats: disconnect after "about 30 minutes" of unreachability → `/remote-control`
to reconnect. (RC) Server-side cleanup: "after your machine was offline long enough that
the server cleaned up the Remote Control environment your machine was serving. The
sessions in that environment ended, and you can't resume them." (ERRORS) The exact
offline threshold is **unconfirmed** (not stated).

**Resume after stopping the server:** `claude remote-control` (brings back every
session), `--continue` (the one it started with), `--session-id <id>`. "These commands
work for about four hours after the server stopped. After that, run `claude
remote-control` to start a new session." Interactive/`/rc` sessions come back via
`claude --continue` / `--resume`, which "reconnects to the Remote Control session
recorded in that conversation". (RC)

**One host at a time.** "If you resume the conversation in a second terminal while the
first one still has Remote Control on, Claude Code prints a `Remote Control not started
here` notice in the second terminal ... Run `/remote-control` in the second terminal
to move Remote Control to it." Failure reason "Another connection took over this
session: another device or Claude Code session has it now." (RC)

**Ending:** `/exit` from any surface archives the session ("Fixed Remote Control `/exit`
not reliably archiving the session", v2.1.81; "Fixed Remote Control sessions not being
archived when Claude Code exits", v2.1.113 — CHANGELOG). The session can be ended or
archived from the phone/web: "This session was ended or archived from another device or
app". Archiving in Desktop "archives the session's Remote Control copy too". Delete at
claude.ai/code is permanent. (RC, DESKTOP, WEB) Org policy flipping off mid-session
disconnects and archives. (RC)

**Time limits:** none documented for a connected session. Credentials are short-lived
and renewed; if renewal fails "The connection keeps working for about 26 hours; if it
still cannot sign in then, it stops." (ERRORS) Forwarded non-permission dialogs expire
after five minutes (`dialogExpiry`); permission prompts and `AskUserQuestion` "stay open
until you answer them". (RC)

## 3. Transport and security model (as the docs describe it)

- **Outbound-only from the laptop, relayed by Anthropic.** "Your local Claude Code
  session makes outbound HTTPS requests only and never opens inbound ports on your
  machine. When you start Remote Control, it registers with the Anthropic API and polls
  for work. When you connect from another device, the server routes messages between
  the web or mobile client and your local session over a streaming connection." (RC)
  "Remote Control requires access to the Anthropic API on port 443." (RC) Idle poll was
  cut to "once per 10 minutes while connected ... transport loss immediately wakes fast
  polling" (CHANGELOG v2.1.7x range).
- **Encryption:** "All traffic travels through the Anthropic API over TLS, the same
  transport security as any Claude Code session." (RC) No end-to-end encryption is
  claimed; **unconfirmed** that any exists — the transcript is readable server-side
  (next bullet).
- **Server-side transcript while connected.** "While Remote Control is connected, the
  session transcript, including your messages, Claude's responses, and tool activity,
  is stored on Anthropic servers. The stored transcript keeps the conversation in sync
  across your devices and lets the session reconnect after a network drop." Retained
  under the normal data-usage policy. (RC, DATA) ZDR and HIPAA orgs "can't enable
  Remote Control". (RC)
- **Credentials:** "The connection uses multiple short-lived credentials, each scoped
  to a single purpose and expiring independently" (RC); "to limit the blast radius of
  any single compromised credential" (SECURITY). Teleport errors mention "The
  connection token is short-lived and scoped to your account." (WEB)
- **Permission approval from the phone: yes.** "Claude Code keeps permission prompts
  and `AskUserQuestion` questions open until you answer them" from the remote session
  (RC); push option "**Push when actions required** for permission prompts and
  questions" (RC); "Fixed Remote Control sessions not showing a pending permission
  prompt or dialog to viewers that connected after it appeared" (CHANGELOG v2.1.217);
  "Fixed Remote Control session status staying stuck on 'Requires Action' after a
  permission is resolved" (v2.1.85). Projects: "any permission prompt it raises waits
  for your answer in the thread". (PROJECTS) The `bypassPermissions` mode cannot be
  selected remotely (PERM). The Fable usage-credits consent prompt is the one dialog
  that is *not* forwarded. (RC)
- **Not sandboxed by RC itself.** "No cloud VMs or sandboxing are involved." (SECURITY)
  `--sandbox` flags were removed from `claude remote-control` in v2.1.300; sandboxing
  comes from settings. (RC)
- **Session-switching semantics:** `/clear` resets connected devices; `/resume` or
  `/teleport` in the terminal switches which conversation the device is attached to
  without sending it the earlier history. (RC)

## 4. What the phone / web UI can do

From RC, MOBILE, PERM, W34 and CHANGELOG:

- **Prompt** and queue messages; "Fixed a Remote Control prompt being lost when another
  queued prompt in the same batch failed" (CHANGELOG v2.1.299). Take back a queued
  message (WEB).
- **Attach photos and files**: photos are seen directly (also saved to
  `~/.claude/uploads/`); other files are "downloaded to your machine and passed to
  Claude as `@` file references"; `@` autocompletes local paths. (RC, MOBILE)
- **Stop / interrupt**: "Fixed Remote Control stop/interrupt from claude.ai not fully
  canceling the CLI session the same way local Esc does" (CHANGELOG v2.1.133). Stop a
  running subagent or workflow from the device: "Stop one of them from the device, and
  Claude Code stops that task on your machine." (RC)
- **Approve permissions / answer questions** (see section 3).
- **Change permission mode**: web "mode dropdown next to the prompt box"; mobile "tap
  the **+** button in the prompt box, then **Permission**". RC sessions offer "Manual,
  Accept edits, Plan, and Auto ... you can't select Bypass permissions from the app".
  The dropdown mirrors the terminal's mode and updates both ways. (PERM, MOBILE)
- **Change model and effort**: picking a model from the device runs the session on it
  (v2.1.238+); `/model <name>` sent from the device also sets the local default;
  effort via `/effort` or the effort control (v2.1.234+), refused if pinned by
  `CLAUDE_CODE_EFFORT_LEVEL`. (RC)
- **See diffs**: "a connected device's diff pane shows your changes" — against the
  default branch's split point (including uncommitted edits) or only uncommitted
  changes when on the default branch. (RC)
- **See subagent/workflow progress** and background tasks, including ones started
  before the device connected. (RC)
- **Rename** the session (syncs back to `claude --resume`). (RC)
- **Slash commands that work remotely**: `/compact`, `/clear`, `/context`, `/usage`,
  `/exit`, `/usage-credits`, `/recap`, `/reload-plugins`; argument-form `/model`,
  `/effort`, `/fast`, `/color`, `/rename`, `/autocompact`, `/advisor`,
  `/output-style`, `/focus`; `/mcp` (text summary / reconnect / enable / disable);
  `/config key=value` on mobile. Local-only: `/plugin`, `/resume`, `/claude-api`,
  `!` shell lines ("goes to Claude as a message"). (RC)
- **Push notifications** to the phone when Claude decides or when action is required;
  skipped while you are typing in the connected terminal. (RC)
- **Start a new session on the machine** from the device card (server mode). (W34)

## 5. Plan / tier / org gating

- Plans: "available on Pro, Max, Team, and Enterprise plans. API keys are not
  supported." (RC) Feature table: Pro ✓, Max ✓, Team "Admin-enabled", Enterprise
  "Admin-enabled". (AVAIL) Help center: "Pro, Max, Team, and Enterprise plans on CLI
  v2.1.51+". (HC-TIPS)
- **Needs a claude.ai subscription sign-in, not an org.** Available on Pro, Max, Ultra,
  Team and Enterprise (API keys are not supported); Pro, Max and Ultra are individual
  plans and work with no org. (AVAIL, RC) Internally there *is* always an org record — the
  error "Unable to determine your organization for Remote Control eligibility" exists
  even for individuals, and a Pro/Max user can be wrongly checked against a stale
  Team/Enterprise org from an earlier login. (RC)
- **Team/Enterprise: off by default, Owner toggle.** "On Team and Enterprise, an Owner
  must first enable the Remote Control toggle in Claude Code admin settings." "Remote
  Control is off by default on Team and Enterprise plans ... This toggle is a
  server-side organization setting." (RC) Claude Code refreshes the policy "about once
  an hour"; turning it off mid-session disconnects and archives. (RC)
- **Enterprise custom roles** must grant both "the cloud sessions permission and the
  **Claude Code remote control** permission". (RC)
- **Device-level kill switch** for IT: `disableRemoteControl` ("Turn off Remote Control
  everywhere it can start") in managed settings, "independent of the organization-wide
  toggle and of how you're signed in". (RC, SETTINGS, DESKTOP)
- **Compliance exclusions:** ZDR and HIPAA orgs cannot enable it (Owner sees the toggle
  "grayed out"). (RC)
- **Telemetry/feature-flag coupling:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or
  `DISABLE_GROWTHBOOK` makes RC unavailable; `DISABLE_TELEMETRY` / `DO_NOT_TRACK` only
  block it when Trusted Devices is required. (RC, DATA)
- **Trusted Devices** (beta) is a further per-org (Owner) or per-account (Pro, Max,
  Ultra) opt-in, "off by default". (RC)

## 6. Multiple viewers, sharing, handing control

- **Multiple devices of the same account can be connected at once**, all live: "all
  connected devices", "send messages from your terminal, browser, and phone
  interchangeably", and changelog wording about "viewers that connected after
  [a prompt] appeared". (RC, CHANGELOG v2.1.217) There is no documented "driver" lock
  among the owner's devices; every connected surface can send. The only exclusivity is
  on the *host* side: one Claude Code process owns the remote session at a time
  ("Another connection took over this session"). (RC)
- **No multi-user viewing or co-driving is documented.** No invite, no guest, no
  hand-off, no per-viewer permission appear in RC, MOBILE, DESKTOP, W34, HC-TIPS or the
  changelog. The session is scoped to one account/org and "grants no one else access".
  (RC) The claude.ai/code "Share sessions" toggle exists for the session list (Team
  visibility on Team/Enterprise, Public on Pro/Max) but is a non-live, read-only link
  view and is documented under cloud sessions; its applicability to RC sessions is
  **unconfirmed**. (WEB)
- The closest thing to "another agent joining" is cross-session messaging: the owner's
  *own* sessions on other machines or in the cloud can message each other "Through
  Anthropic servers, arriving over that machine's Remote Control connection", with an
  optional approval gate for cross-machine messages. Still single-account. (XSESSION)
- Dispatch is a separate, Desktop-only, Pro/Max-only "secure remote control for the
  Claude Desktop app", not multi-user either. (HC-TIPS, MOBILE)

## What this means for Atlas RC

Concrete rules to copy from Claude Code (each with the source it comes from), and
where Atlas intentionally goes further.

**Identity**

1. An RC session belongs to the **account (plus org) signed in on the hosting machine
   at start time**; a sign-in change on the host ends the RC session but leaves the
   local session running. (ERRORS, RC)
2. The phone/web must be signed in to the **same account and org**; the session shows
   up only in that account's apps and "grants no one else access" by default. (MOBILE,
   DESKTOP, RC)
3. Account identity is the floor; **device trust is an optional layer** (enrolled
   device + sign-in younger than 18 h, biometric step-up, revocable device list, admin
   "sign out everywhere"). Worth designing the hook for even if v1 ships without it.
   (RC)
4. Machine-token / API-key identities cannot start RC (full-scope login only). (RC)

**Discovery**

5. Offer all three: **a "my sessions" list** with an online/offline dot and a computer
   icon, **a deep link URL** containing the session id, and **a QR code** of that URL
   shown in the host UI. (RC)
6. Server/"device" mode: a host advertising itself shows as a **device card** at the
   top of the phone's list, from which the phone can pick a directory and start a new
   session. (W34)
7. Session title precedence: explicit name → user rename → last meaningful message →
   `hostname-adjective-noun`; renames from the phone propagate back to the host. (RC)

**Lifecycle**

8. Explicit opt-in to connect (one-time consent dialog, then per-session command or an
   auto-connect setting that project config can only turn *off*). (RC)
9. Host process death → session **offline, not deleted**; sleep/network loss →
   **automatic reconnect**; outage bounds (server mode gives up after ~10 min,
   interactive keeps retrying; 403 retry window 3 min; heartbeat loss 30 min). (RC)
10. Stopped host sessions are **resumable for a bounded window (~4 h)**, after which
    the server cleans up and the owner is told "N sessions ended while offline". (RC,
    ERRORS)
11. **One host per remote session**; a second host must explicitly take it over. (RC)
12. Ending/archiving is allowed from any surface; org policy revoked mid-session
    disconnects and archives. (RC)
13. Permission prompts and questions **never expire**; other forwarded dialogs expire
    (default 5 min, configurable). (RC)

**Transport**

14. Host is **outbound-only HTTPS**, registers and polls, then streams; the relay is
    the vendor server; TLS in transit; multiple short-lived single-purpose credentials.
    (RC, SECURITY)
15. The transcript is **mirrored server-side while connected** so viewers can join
    late and reconnects recover; be explicit about that in the privacy copy, and allow
    compliance-configured tenants to disable RC entirely. (RC, DATA)

**Phone abilities**

16. Prompt + queue + un-queue; attach photos (seen directly) and files (downloaded to
    host and referenced); stop/interrupt the turn; stop a subagent/background task;
    answer permission prompts and questions; switch permission mode (everything except
    bypass); change model and effort; view the diff pane; rename; a defined allowlist
    of text-output slash commands. (RC, PERM, MOBILE, WEB)
17. Push notifications: two toggles only ("when the agent decides", "when action is
    required"), suppressed while the user is active on the host. (RC)

**Gating**

18. Individual paid plans (Pro, Max, Ultra) get it with no org; Team/Enterprise are **off by default
    with an Owner toggle** that is server-side and re-checked by the host roughly
    hourly; a per-device managed `disableRemoteControl` kill switch sits underneath;
    compliance modes (ZDR/HIPAA equivalents) hard-disable it. (RC, AVAIL, SETTINGS)

**Where Atlas deliberately diverges**

- *Every ACP agent, not one vendor's CLI.* Nothing in Claude Code's model depends on
  the agent; the host-side rules above (account-bound session, outbound-only relay,
  prompt/permission forwarding) are agent-agnostic and map onto Atlas's existing
  session-delta wire.
- *Multiplayer with one driver at a time* has **no precedent in Claude Code**: its
  only multi-device story is the owner's own devices, all live and all able to send,
  with exclusivity only on the host side; its only cross-user story is a read-only,
  non-live share link scoped Team/Public. Atlas's invite + single-driver design is
  therefore an addition, and should keep Claude Code's invariants intact for the
  owner: the session still belongs to the owner's account, the owner's host is the
  single authority, and a guest's rights are a strict subset of the owner's (viewer
  by default, driver on hand-off, never able to change the host's sign-in, policy,
  or bypass mode).
