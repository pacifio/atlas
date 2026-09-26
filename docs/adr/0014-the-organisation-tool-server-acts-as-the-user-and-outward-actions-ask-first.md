# ADR-0014: The organisation tool server acts as the signed-in user, and outward actions ask first

**Status:** Accepted (2026-09-26)

## Context

The user wants Atlas Agent to read the organisation's recorded work (recorded sessions, comments,
members, conversations) and act in it: post a session report to a channel or a DM, reply to and
resolve comments, write a page in a Space. The server has no bot or service identity; every call
carries the signed-in user's JWT and everything written appears as that user. The desktop already
holds every needed client in Rust (`atlas-comms`, `atlas-artifacts`, `atlas-checkpoint::sync`,
`AuthCore`), and the renderer never holds a token.

Two Atlas-offered tool servers exist (ADR-0010 memory, ADR-0012 UI). Both are projected into the
engine as auto-approved, and ADR-0012 makes that acceptable by keeping its whole surface
non-destructive by rule. Sending a message to a colleague cannot be made non-destructive by rule:
it is not undoable and it is in the user's name.

## Decision

**A third MCP service, `atlas_org`, the organisation tool server, mounted on the same listener
behind the same per-session token as the other two.** It is offered only to a connection that
carries **organisation access**, a connection property like UI control (the in-process native
connection sets it; ACP does not; nothing branches on agent id), behind one setting (default on,
checked at offer and on every call), and only when the session's Project is cloud-bound.

**A tool call acts in the organisation the session's Project is bound to**, carried on the
per-session grant when the offer settles, never in whichever organisation the window is showing
and never chosen by the model. The app's two org ids (active, comms) are not consulted; if chat is
targeting a different organisation, chat tools refuse.

**Outward actions ask first.** A call that reaches another person (sending a message, replying on
a comment thread, creating a DM) is projected with per-tool `Prompt` approval, so the existing
approval card (allow once / allow for this session / reject) shows the recipient and the full body
before anything leaves the device. Resolving a comment and creating or writing a page are visible
and reversible, so they stay auto-approved with the audit rows ADR-0012 established. This is the
first Atlas-offered server that prompts, and that departure from ADR-0012 is deliberate.

**Roles are the server's.** The recorded-work surface is flat server-side (anyone who can see a
Workspace may read, comment, resolve, search). The client mirrors the caller's role only to omit
the one admin tool (member activity) from the offer and to explain a 403; it enforces nothing the
server does not.

## Consequences

- No attribution marker is appended to agent-written messages: the user approved the exact words,
  and a text suffix is not provenance. A "via Atlas Agent" server field is a server follow-up.
- Search by member or date is a client-side fold over the board (default 14 days, at most 500
  recorded sessions, truncation reported), because the server filters only by Workspace and keyword.
- A session report carries a Session Reference; when the Workspace is not organisation-visible the
  reference is dropped for the plain link and the model is told.
- Space page content crosses to the webview as a node-and-edge JSON with optional positions; the
  frontend owns layout and the Yjs codec, and Rust stays a pipe (`crates/atlas-comms/src/spaces.rs`).
- Twelve flat tools, roughly 3 KB of fixed prefix per native turn.
- The engine asks for a prompted tool with an MCP elicitation of its own and keeps no session
  approval for one, so the native seam serves that one elicitation (ADR-0013) and remembers "allow
  for this session" per session and tool itself (`engine/tool_approvals.rs`).
- Consent is enforced by the tool server, not by the engine's ask alone: the native seam records
  each call the user approves (on its card, or under "allow for this session") through the host in
  a one-shot `OutwardConsent` keyed by session, tool and arguments, and `atlas_org` posts only a
  call it finds there — so in bypass mode, where the engine runs a prompted tool unasked, an
  outward action is refused and nothing is sent.
- Reversed the same way as ADR-0012: if per-session consent is ever needed, the flag moves onto
  the session request, still never onto agent identity.
