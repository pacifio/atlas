# Requests

Asks the desktop makes of other teams, mostly the server team's gateway. Each is
written so the other team can act on it without reading the desktop code: who it is
from and to, the date, the priority, then the problem and the change wanted.

A request lives here while the desktop code or an ADR cites it, which is why this folder
is committed. It moves to `docs/archive/` once the other team has shipped the change
and the desktop no longer waits on it.

- `gateway-catalogue-metadata.md` - per-model metadata (context window and more) on `GET /v1/catalogue` (ADR-0007).
- `gateway-subagent-concurrency.md` - in-flight slots held after a client hang-up, and limits sized for subagents.
