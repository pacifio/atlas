# `.agents/skills` is the canonical store; ACP advertisement is the picker

Atlas had built a second skill ecosystem alongside skills.sh — its own canonical store at `.atlas/skills`, its own GitHub clone-and-install, and its own symlink projections into the same agent directories skills.sh writes to, sharing only the skills.sh search index for discovery. We are collapsing that: `~/.agents/skills` and `<project>/.agents/skills` become Atlas's canonical store, Atlas stops injecting anything of its own, and the slash picker is sourced purely from what the bound agent advertises over ACP.

The chain that makes this work is already in place and needs nothing from Atlas: a skill installed into `.agents/skills` is projected by symlink into each agent's skills directory, each agent discovers its own projections, and each agent advertises what it found over ACP. Atlas reads that advertisement. It does not need its own registry to answer "what can the user type after `/`".

## Considered Options

- **Keep the fork and reconcile** — identity by canonical path, conflict states for same-name-different-path, provenance threaded through the registry, four channels scanned. Rejected: this is all machinery for keeping two stores coherent, and the second store had zero installs on the maintainer's machine while `~/.agents/skills` had 61.
- **Zed's scoping** — manage skills only for Atlas's own agent and ignore external ones. Rejected: the cross-agent projection matrix is what Atlas's Skills UI is for, and it survives convergence intact.
- **Merge ACP advertisement with a local registry in the picker** — rejected as unnecessary once there is one store; the agent's own advertisement is authoritative about what it will resolve, and a local list can only disagree with it.

## Consequences

The symlink rejection in the external-skill scan is not patched, it becomes moot: with one store, every symlink in an agent's skills directory is a projection of something in `.agents/skills`, and resolving them is ordinary discovery rather than reconciliation.

Atlas's Skills UI keeps its whole surface — registry browsing, per-agent projection toggles, adopt, promote, uninstall — because those already write exactly the symlinks skills.sh writes. Only the store path changes.

Installing becomes a single act. Today install writes the canonical copy and creates no projections at all, leaving a skill no agent can see until the user finds the per-agent toggles in another tab. Once the store is the one agents already read, install should ask which agents to project to and do it immediately, the way `npx skills add` does. The per-agent toggles remain, for changing your mind later.

Plugin-bundled skills (Claude Code and Codex) remain a genuinely foreign channel: read-only, not projected, not installable through Atlas. They still reach the picker, because the agent advertises them.

The picker is empty for the few seconds between session start and the first `available_commands_update`. Accepted as the cost of having no second source of truth; the gap needs a loading state rather than a fallback catalogue.

Anyone who installed skills through Atlas before this change has content in `.atlas/skills` that needs migrating to `.agents/skills`.
