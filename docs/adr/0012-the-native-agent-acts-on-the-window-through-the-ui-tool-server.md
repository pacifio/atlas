# ADR-0012: The native agent acts on the window through the UI tool server

**Status:** Accepted (2026-09-25)

## Context

Atlas Agent could pull shared memory (ADR-0010) but could not act on the app: it had no way to
open a file at a line, show the Changes panel, open a settings section, or type a command into a
terminal. The user wants it to drive the whole window the way a user does from the keyboard and
the palettes.

Two seams could carry that. The vendored engine has a **dynamic-tools** seam (`dynamic_tools` on
thread start, answered through the `item/tool/call` server request), which is native-only by
construction but which Atlas refuses today and which would put UI-driving code on the engine side
of the ADR-0004 boundary. The **in-process MCP tool server** is the route ADR-0010 already
established: a loopback HTTP service the host offers each session, whose tools the engine
projects as auto-approved and non-deferred (`engine/mcp.rs`) precisely because Atlas itself
offers them. The tool-server route reaches, by default, every agent that advertises HTTP MCP —
including third-party ACP agents — and Atlas's standing rule is that no per-agent behaviour is
ever decided by agent identity.

## Decision

**A second MCP service, `atlas_ui`, the UI tool server, mounted on the memory tool server's
listener behind the same token middleware and the same per-session bearer token.** The token
store binds one token per session, so a separately minted token would revoke the memory one;
sharing the listener is what makes a second Atlas-owned server possible at all.

**It is offered only to a connection that carries UI control.** `SessionMcpRequest` gains a
`ui_control` flag, a property of the *connection* like `http_mcp`: the in-process native
connection sets it, the ACP connection does not. Nothing anywhere branches on agent id. If an
ACP agent should one day act on the window, the change is "that connection carries UI control",
never "check who the agent is".

**Every call crosses to the webview as one UI action** — a Tauri event carrying a request id,
answered by one command — and the frontend owns the semantics entirely: it performs the action
through the app's existing openers and store actions and returns JSON that Rust forwards to the
model verbatim. Rust mirrors no focus state (docs/architecture.md's authoritative-state boundary keeps
layout and focus in the frontend). An action the window does not answer within ten seconds is a
tool error, never a hung turn.

**Auto-approved, behind one setting.** The engine grants every projected Atlas server
approve-without-prompt and a place in the model's initial tool list; the UI tool server inherits
both. The user's "Let Atlas Agent navigate the app" setting (default on) gates the offer for new
sessions and every call in running ones.

**Project-scoped, with three refusals and no override.** A UI action never switches projects; it
acts on whichever project's view is active and refuses tabs another project owns. It may not send
a message into, or switch the agent of, the chat the calling session runs in — only prefill or
insert text for the user to send. It may not close an editor with unsaved changes. The terminal
action types a line and leaves Enter to the user. These keep the whole surface non-destructive,
which is what makes auto-approval reasonable.

Three consequences of those rules, decided while building them (2026-09-25):

- **Running a keybinding command by id refuses the four global commands that would slip past a
  rule:** adding a project (it switches to it), closing the active tab (no unsaved-changes check —
  use the close action), cycling a chat's agent (use the chat action, which protects the caller's
  own chat), and cycling a chat's permission mode — an agent may never change the approval policy
  it runs under.
- **A typed terminal line must be one line.** A line break would run everything before it, which
  is Enter by another name.
- **A typed line goes into a fresh shell** in the target terminal tab, never into a shell the user
  is already using: typing into a running command would interleave with it, and the user could
  press Enter on a line they did not see arrive.

## Consequences

- The dynamic-tools seam stays unused for this; nothing under `vendor/atlas-engine` changes.
- Every native turn carries roughly 1.8 KB more tool schema in its fixed prefix
  (`docs/research/native-agent-input-tokens-measured.md`); the surface is kept to seven tools with
  one-clause descriptions for that reason.
- An ACP agent gets no UI tools, by the connection flag rather than by its name.
- A closed or unresponsive window fails the call, not the turn; the model reads the error.
- Prefill, insert and typed terminal lines act as the user and are visible in the window; each
  action is also one tool row in the chat and one audit row in the Logs panel. No toast.
- Reversed if the connection-level flag proves the wrong seam — for instance if per-*session*
  rather than per-connection consent is ever needed — in which case the flag moves onto the
  session request's own capabilities, still never onto agent identity.
