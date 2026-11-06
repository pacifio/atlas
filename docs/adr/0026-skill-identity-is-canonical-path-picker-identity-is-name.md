---
status: superseded by ADR-0005
---

# Skill identity is the canonical path; picker identity is the name

> Superseded. The reconciliation described here was machinery for keeping two
> canonical stores coherent. ADR-0005 removes the second store, so most of it is
> no longer needed. The name-identity rule for the picker survives; the registry
> reconciliation does not.

Atlas discovers skills through several channels that all write into the same agent directories, so the same skill is routinely visible more than once. We use two identity keys, because the Skills UI and the slash picker answer different questions. The Skills registry keys on **canonical path** (the real path after resolving symlinks): entries that resolve to the same path are one skill with several projections, and two entries sharing a name but not a canonical path are a conflict, surfaced as one row rather than silently collapsed. The slash picker keys on **name**, because the name is what the user types and exactly one thing will resolve when they type it.

## Considered Options

- **Reject symlinks in agent skill directories** — the original behaviour, and the cause of skills.sh installs being invisible. It assumed every symlink in an agent directory was an Atlas-authored projection. It also discards the most useful fact available: a projection into an agent's directory is direct evidence that agent can see the skill.
- **Show only the shared store and ignore agent directories** — hardcodes one channel's current layout, and breaks when a channel projects somewhere new or a new agent is added.
- **One identity key for both surfaces** — no single key works. Canonical path is unavailable in the picker, where ACP advertises a name and description and no path. Name alone is wrong for the registry, where two same-named skills from different channels are a real situation the user must be able to see and resolve.

## Consequences

Projections are data, not noise. The set of agent directories a canonical path is projected into is what makes "applicable to the bound agent" answerable, which is what lets registry-discovered skills be merged into the picker safely.

Atlas is a registrar, not an owner: it discovers every channel and writes only to skills it authored. skills.sh-managed and plugin-managed files are read-only to Atlas.

Conflicts become a state the Skills UI has to render. Silently deduping by name — the prior behaviour — hides a situation the user has to fix themselves.
