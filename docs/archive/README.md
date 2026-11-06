# Archive

Specs and research that did their job and were superseded: the Codex port spec and
its four research documents, the rename spec, and a few finished investigations. They
stay for the record and are not kept current.

A doc moves here when its decision has landed (or been replaced) and the living docs
(`docs/architecture.md`, `docs/adr/`) say the same thing better. Docs that predate the
ADR-0011 rename carry a "Historical" banner; their paths and names are as they were.
Past that banner, nothing in here is edited, and nothing moves back out.

- `atlas-agent-codex-port-spec.md` - the spec for the one-time engine port (ADR-0003).
- `atlas-agent-rename-spec.md` - the step-by-step plan behind ADR-0011.
- `codex-atlas-gateway-fit.md` - does the ported engine fit the Atlas AI gateway.
- `codex-atlas-integration-surface.md` - in-process linking versus a spawned app-server.
- `codex-cutover-survival-list.md` - what must survive the cutover, and whether the reliability claim holds.
- `codex-fork-seam.md` - primary-source research on the fork seam, licensing and security history.
- `native-agent-gemini-glm-failures.md` - why Gemini tool calls 400 and GLM could not say hello.
- `shared-memory-system.md` - how shared memory worked, and how it became one memory for every agent.
- `stress-run-fixes-2026-09.md` - root causes and plan for five stress-run issues.
- `windows-support-2026-09.md` - every change from the September Windows session.
- `windows-terminal-spawn.md` - a terminal window per tool call on Windows.
- `radix-to-base-ui/` - per-component notes from the Radix to Base UI migration.
