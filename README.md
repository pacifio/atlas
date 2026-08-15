[![Atlas](landing/banner.svg)](https://www.tryatlas.cc/)

<div align="center">

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/GmnFggaPfP)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/pacifio/atlas?include_prereleases&label=Release&style=for-the-badge)](https://github.com/pacifio/atlas/releases)
[![Contributors](https://img.shields.io/github/contributors/pacifio/atlas?style=for-the-badge)](https://github.com/pacifio/atlas/graphs/contributors)

**[Download](https://github.com/pacifio/atlas/releases)** · **[Discord](https://discord.gg/GmnFggaPfP)** · **[Docs](https://cersei.tryatlas.cc/docs)** · **[Contributing](CONTRIBUTING.md)** · **[Issues](https://github.com/pacifio/atlas/issues)** · **[Roadmap](#roadmap)**

<a href="https://github.com/pacifio/atlas"><img src="https://img.shields.io/github/stars/pacifio/atlas?style=social" alt="GitHub stars"></a>
<a href="https://github.com/pacifio/atlas"><img alt="GitHub forks" src="https://img.shields.io/github/forks/pacifio/atlas"></a>

<a href="https://trendshift.io/repositories/56020?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-56020" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/56020" alt="pacifio%2Fatlas | Trendshift" width="250" height="55"/></a>
<a href="https://trendshift.io/repositories/56020?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-56020" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/56020/daily?language=Rust" alt="pacifio%2Fatlas | Trendshift" width="250" height="55"/></a>

</div>

# Atlas

Atlas is open source source control for coding agents. Run multiple agents like Claude Code and Codex in parallel, track what each agent changes across your codebase, and query their sessions, decisions, and history from one place. Atlas gives your agents shared memory and context, so you can switch between agents without agents forgetting.

- **Run agents in parallel.** Multiple sessions across tabs, each streaming independently. Switching tabs never freezes or drops a run in flight.
- **One memory, three agents.** A decision Claude Code made shows up in Codex's next prompt. Plans, file changes, failures, and architecture notes are shared automatically, matched on-device against what you're asking about.
- **Your notes are agent context.** Markdown in `.atlas/knowledge/`, plus the `CLAUDE.md` and `AGENTS.md` you already wrote, feed every agent in the project.
- **`@` anything into a prompt.** Files, folders, symbols, branches, commits, notes, papers, and past sessions resolve locally before the prompt is sent.
- **Local by default.** Code, notes, and sessions stay on your machine. Sign in and create an organisation when you want to sync across a team.

**[Join the Discord](https://discord.gg/GmnFggaPfP)** · `#general` chat · `#dev` build questions · `#feature-requests` ideas · `#bugs` report breakage

Start with [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, or [open an issue](https://github.com/pacifio/atlas/issues) for anything you hit.

## Table of contents

- [Why Atlas](#why-atlas)
- [How it works](#how-it-works)
- [Checkpoints](#checkpoints)
- [Features](#features)
- [Download](#download)
- [Build from source](#build-from-source)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [Local by default](#local-by-default)
- [Links](#links)

## Why Atlas

Agents now write a large share of the code and keep none of the reasoning behind it. Atlas records both, and makes them queryable: what changed, by whose agent, at what point in time.

- **Agents start from zero every session.** Atlas keeps a persistent on-device memory of decisions, plans, and changes, and pushes the relevant parts into every turn.
- **Switching agents loses the thread.** The first message of a new session carries a curated fact pack and the tail of your last one, even when that session ran on a different agent.
- **You can't review what you can't see.** Every session is stored and searchable, next to a real commit graph and file-level diffs of what actually landed.
- **Context lives in ten places.** The knowledge base, `CLAUDE.md`, `AGENTS.md`, Claude Code's memory files, and Codex's history fold into one index every agent reads from.
- **Nothing is locked in.** Notes are markdown, canvases are JSON, sessions are JSONL, and the editor is a file on disk. Close Atlas and pick up in vim. The one exception is the checkpoint record — which agent session produced which commit — which is SQLite in the project's gitignored `.atlas/`, because it is queried, not read.
- **Built for agents from the ground up.** The agent runtime, shared memory, and session history are the foundation the rest of the app is built on.

## How it works

Atlas runs Claude Code and Codex as they are, and enriches what they see.

Both run as external subprocesses over [ACP](https://github.com/zed-industries/agent-client-protocol). The Atlas agent runs in-process on [Cersei](https://cersei.tryatlas.cc/docs), our Rust agent framework. All three go through the same send path, so everything below applies whichever one you pick.

Before your message reaches the agent, Atlas assembles context around it:

| Injected | Where it comes from | When |
|---|---|---|
| **`@` mentions** | Resolved locally in Rust before the prompt is sent. Notes, skills, papers, and past sessions are inlined; files and folders resolve to a path | Every turn |
| **Shared agent memory** | Active plan, decisions, file changes, failures, and architecture notes, written by any agent | Every turn |
| **Semantic matches** | Your message is embedded on-device and matched against the project's memory index | Every turn |
| **Session handoff** | A curated fact pack plus the tail of your last session in this project, including one from a different agent | First message |
| **What you already wrote** | Knowledge notes, `CLAUDE.md`, `AGENTS.md`, Claude Code's memory files, and Codex's history, folded into one index | Continuously |

- **One path, no per-agent special-casing.** Run your existing Claude Code or Codex subscription through Atlas and the session gets more context, with no change to how you work.
- **Claude Code's memory is visible to Codex, and the reverse.** Neither agent can read the other's history on its own.
- **Folders resolve to a pointer, not a paste.** `@`-ing a 5000-line file sends a path the agent reads on demand, so one mention doesn't occupy the context window for the rest of the session.
- **Embedding runs on your machine.** Retrieval never leaves the device.

## Checkpoints

Atlas records every agent session locally in `.atlas/sessions.db`, with secrets scrubbed before anything touches disk. When you commit — from any tool, even with Atlas closed — the commit is linked back to the session that produced it as a Checkpoint, and links survive rebases and amends. Local mode works fully offline with no account.

## Features

### Agents

| Capability | Description |
|---|---|
| **Multi-agent sessions** | Claude Code, Codex, and Atlas's native agent, selectable per session and running in parallel across tabs. Sessions are independent of tabs, so switching never drops a run in flight |
| **Shared agent memory** | On-device semantic index (local embeddings, HNSW search) that every agent reads from and writes to |
| **`@` mentions** | Local resolution of files, folders, symbols, branches, commits, notes, skills, papers, and past sessions |
| **Skills** | `SKILL.md` files scoped globally or per project, enabled per agent by symlinking into that agent's own skills directory |
| **Packs** | Install a GitHub repo of skills, subagents, commands, hooks, rules, and scripts, discovered through the skills.sh index |
| **Model chat** | Talk to a model directly in its own tab, with no agent loop around it |
| **Organisations** | Sign in, create an organisation, and sync across devices and teammates |

### Agent history

| Capability | Description |
|---|---|
| **Session capture** | Every session recorded to `.atlas/sessions.db`: prompts, messages, tool calls, the files each one touched, and the patches it applied |
| **Checkpoints** | Each session linked to the commits it produced. Commits are observed rather than intercepted, so one made from a terminal, from another editor, or while Atlas was closed still finds its session |
| **Survives history rewrites** | Links re-point through amend and rebase by patch-id reconciliation. When a squash makes the link genuinely ambiguous, it orphans instead of guessing |
| **Transcript import** | Backfills your existing Claude Code history, so the record starts before you installed Atlas |
| **Secrets scrubbed on write** | Redaction runs before anything is persisted, so the local store is never itself a disclosure risk |
| **Capture health** | One signal per workspace, OK, Degraded, or Stopped, each with a reason and the next step |
| **Mission control** | Dashboard for agent activity: usage over time, consumption breakdown, timelines, and a filterable log table |

Works with no account and no network.

### The workspace

| Capability | Description |
|---|---|
| **Editor** | CodeMirror editing surface, with per-project editor state restored across restarts |
| **Git** | Real commit graph with lane assignment, stage/unstage/commit, branch operations, and file-level diffs |
| **Terminal** | Block terminal where each command carries its own output, exit code, and duration, plus a full interactive surface for `vim`, `htop`, and friends |
| **Knowledge base** | Plain markdown notes in `.atlas/knowledge/`, versioned next to the code, with backlinks, a link graph, and export to HTML or a standalone server binary |
| **Research** | Search arXiv and Semantic Scholar, pull papers in, read them in-app, and `@`-mention them into a prompt |
| **Browser** | Native WebKit webview in a tab, with real logins, cookies, and a reader mode |
| **Spaces** | Spatial board for notes and their connections, persisted as JSON in the project |
| **Split view** | Up to three resizable columns, each with its own tabs |
| **Activity log** | Every significant event in the project, filterable, with rows you can pin across restarts |

## Download

Grab the latest `.dmg` from [tryatlas.cc](https://www.tryatlas.cc/) or the [releases page](https://github.com/pacifio/atlas/releases). macOS is the supported platform.

<!-- #todo homebrew tap so this becomes `brew install atlas` -->

## Build from source

Linux and Windows build from the same Tauri codebase but are untested.

To use the Claude Code agent, install the `claude` CLI and put it on your `PATH`. Atlas's native agent needs no external CLI.

Requires **[Bun](https://bun.sh/)**, **Rust** (stable, via [rustup](https://rustup.rs/)), and **Xcode Command Line Tools**.

### System Prerequisites
* **Linux System Dependencies**: GTK 3, WebKit2GTK (4.1), and GLib headers:

  * **Debian / Ubuntu / Linux Mint**:
    ```bash
    sudo apt install -y libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev
    ```
  * **Fedora / RHEL**:
    ```bash
    sudo dnf install glib2-devel gtk3-devel webkit2gtk4.1-devel
    ```
  * **Arch Linux / Manjaro**:
    ```bash
    sudo pacman -S glib2 gtk3 webkit2gtk-4.1
    ```
  * **openSUSE**:
    ```bash
    sudo zypper install glib2-devel gtk3-devel webkit2gtk3-devel
    ```
---
```bash
git clone https://github.com/pacifio/atlas
cd atlas
bun install
bun run dev:app
```

The first Rust compile takes a few minutes; after that it is seconds. Use `bun run dev` for frontend-only iteration, though anything calling `invoke()` needs `dev:app`.

Production builds:

```bash
bun run build:app       # .app bundle
bun run build:app:dmg   # .app + .dmg installer
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Two things catch people out:

- **Everyone forks.** Nobody has direct push access, including the core team. Fork, branch, open a PR.
- **Feature work targets the current version branch**, not `main`. `main` only receives a finished version branch, and that merge is the release.

[ARCHITECTURE.md](ARCHITECTURE.md) covers how Atlas is built. [SECURITY.md](SECURITY.md) covers reporting vulnerabilities.

## Roadmap

- **Source control for agents.** The organisation-wide half: agent history from every machine on the team rolled into one queryable record.
- **AI gateway via Atlas accounts.** Route any provider through your Atlas account, with usage and spend visible per person and per agent.
- **Timeline boards covering how team members are changing code.** A shared view of what each person's agents shipped, and when.
- **Organisational agents.** Agents scoped to a team, carrying the organisation's own memory, skills, and conventions.
- **Pick up work from any device.** Sessions, notes, and workspace state follow you to the next machine.
- **Issue tracking.** Issues that carry the agent sessions and commits that resolved them.
- **Shared documentation.** One knowledge base across the team, readable by every agent in it.

## Local by default

- **Your code, notes, and sessions stay on your machine.** Nothing is uploaded to run an agent.
- **Secrets are scrubbed before anything is written to disk.** Not before upload, before persistence.
- **Session capture is local-only by default.** The [Checkpoints](#checkpoints) record of your agent sessions is written to `.atlas/sessions.db` on your machine and stays there — no account required, and nothing sent anywhere until you explicitly opt in to sync.
- **Accounts are opt-in.** Sign in to create an organisation and sync across devices and teammates.
- **Anonymous usage analytics are on by default.** Coarse metadata, never code or prompts. [What's collected, and how to turn it off](TELEMETRY.md).

## Links

- **Website:** [tryatlas.cc](https://www.tryatlas.cc/)
- **Cersei docs:** [cersei.tryatlas.cc/docs](https://cersei.tryatlas.cc/docs)
- **Discord:** [discord.gg/GmnFggaPfP](https://discord.gg/GmnFggaPfP)
- **Issues:** [github.com/pacifio/atlas/issues](https://github.com/pacifio/atlas/issues)
- **Telemetry:** [what Atlas collects, and how to turn it off](TELEMETRY.md)

## License

MIT. See [LICENSE](LICENSE).
