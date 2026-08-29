# Slash tokens pass through to the agent; skills are not inlined

Atlas had two ways to invoke a skill: the `#` mention rail, which read `SKILL.md` and spliced its body into the outgoing prompt via `compose_prompt`, and the `/` picker, which sent the literal token for the bound agent's own machinery to resolve. We are keeping passthrough as the single mechanism and retiring the inline skill rail, because inlining cannot carry arguments, drops a skill's bundled reference files, and spends the whole body on every send whether the model needs it or not.

## Considered Options

- **Inline everywhere** (`compose_prompt` for every agent) — uniform, and the only option that works for an agent with no native skill machinery. Rejected: it has no `$ARGUMENTS` substitution, so a skill can never take arguments; it inlines only `SKILL.md`, so skills that point at bundled files (`references/*.md`, format docs) arrive with dangling references; and it clips at 32KB.
- **Mechanism per row** — agent-advertised commands pass through, registry-discovered skills inline, deduped in favour of passthrough. Rejected: the same visible row would behave differently depending on the bound agent, with nothing in the UI to distinguish them.
- **Keep `#` for agents that lack native skill support** — rejected as it preserves the surface we are removing, with worse consistency than the status quo.

## Consequences

The `#` rail is not deleted — it keeps `@file`, `~knowledge`, `@session`, papers, and components, which is what splicing content into a prompt is actually for. Only its skill branch goes.

Passthrough depends on the bound agent advertising its skills over ACP, so Atlas's own skill registry must discover skills that agents can already see — including `npx skills` projections, which the external scanner currently rejects because they are symlinks.

The native in-process agent (cersei) has native skill machinery of its own but no ACP command advertisement, so it is left with no explicit skill invocation once `#` is removed. Accepted deliberately: cersei is scheduled for replacement by a different agent harness, and building it a slash resolver would be work thrown away.
