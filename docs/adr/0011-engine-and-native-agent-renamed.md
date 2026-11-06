# ADR-0011: The engine is `atlas-engine`, the native agent is Atlas Agent (`atlas-agent`)

**Status:** Accepted (2026-09-23)

## Context

ADR-0003 replaced the native agent's experimental SDK with a one-time hard fork of OpenAI's
Codex and named the product "Atlas Agent", but it deliberately left two names in the tree. The
stored agent id stayed the experimental SDK's name, `"cersei"`, as a storage key every recorded
thread resolved through (spec D7). The fork itself stayed `vendor/codex`: 110 crates named
`codex-*`, and inside them the original's name in identifiers, env vars, the default home
directory, the project-local `.codex/` config directory it read from user repos, keychain
entries, the MCP client identity, OTel metric names and the wire schema.

Both leftovers had a cost that grew with the code. Coding agents working in the tree kept
finding the retired names and reasoning from them: that a "Cersei" path still existed, that
`codex_core` was an external dependency, that `~/.codex` was Atlas's state. The licence's
trademark clause (§6) already required the product-facing removal (done in #55 for the two
shipped prompts); the rest was a matter of finishing the job.

## Decision

Rename both, completely, in one sweep, and keep them out with a test.

- **The native agent's stored id is `"atlas-agent"`** (`ATLAS_AGENT_ID` in Rust,
  `NATIVE_AGENT_ID` in TypeScript). **No migration**: the thread-metadata store's V3 step
  deletes the rows recorded under the retired id; checkpoint rows under the old `source` degrade
  to `acp` through the existing parser fallback; the two localStorage preference keys and the
  memory-corpus doc ids are simply new keys; keychain entries the engine may have written under
  its old service names are orphaned (Atlas never used that path). Pre-launch, nothing to keep.
- **The engine tree is `vendor/atlas-engine`, and its crates are `atlas-engine-*`** (`atlas_engine_*`
  identifiers, `AtlasEngine*` types). Not `atlas-agent-*`: Atlas already owns the MIT crates
  `crates/atlas-agent-{manager,store,servers,delta,transcript,wire}`, and the distinct prefix keeps
  the MIT/Apache boundary visible in a crate name and lets the quarantine test keep keying on it.
- **Everything the user, the model, a repo, or another process can see says Atlas Agent:** env
  vars `ATLAS_AGENT_*` (the ones the sandbox injects into every child process included), default
  home `~/.atlas-agent` (Atlas still overrides it to `<config_dir>/atlas-agent/engine`),
  project-local `.atlas-agent/` (config, hooks, rules, skills), keychain services
  `"Atlas Agent …"`, originator `atlas_agent`, MCP client `atlas-agent` / "Atlas Agent", MCP
  `_meta` keys `atlas-agent/*`, OTel metrics `atlas_agent.*`, the Apps MCP server `atlas_apps`,
  wire fields `atlasAgentHome` / `dotAtlasAgentFolder`, proto packages `atlas_engine.*`.
- **The telemetry family is `native`** (`plugin_id` carries `atlas-agent`): two axes, two names.
  PostHog funnels keyed on the old family break; accepted.
- **Binaries and their arg0 dispatch renamed in lockstep** (`atlas-engine-linux-sandbox`,
  `atlas-engine-execve-wrapper`, `--atlas-engine-run-as-*`): a mismatch here disables the
  sandbox silently rather than failing to compile, so the Linux sandboxed tests are the guard.
- **Dead upstream material deleted rather than renamed:** the 112 Bazel build files, the two
  OpenAI sample skills, the upstream-client originator allow-list.

### What keeps the word, and why (the residue)

`tests/no-legacy-names.test.ts` keeps both names out, in two regimes. The retired SDK's name is
banned everywhere but the rows below that mention it. The original's name is banned outright in
the engine's own territory (the engine tree, the seam crate, the manifests, CI, the contract
tests, the living docs) and, everywhere else, only in the spellings the engine used — its crate
and module identifiers, `vendor/codex`, its home field, its error and auth types, and prose that
calls the engine by it — because the app layer legitimately names the third-party Codex CLI.

| Where | Why |
| --- | --- |
| `vendor/atlas-engine/LICENSE`, `NOTICE`; `src-tauri/licenses/OpenAI-Codex-*.txt` | Apache-2.0 §4(a)/(d): verbatim, and the bundled copies' filenames name the upstream work |
| The §4(b) notice line `Modified by Atlas from upstream OpenAI Codex …` | It names the original work |
| URLs (`github.com/openai/codex`, `chatgpt.com/…`, `openai.com/…`) | URLs are never renamed |
| OpenAI model ids (`gpt-5-codex`, `codex-auto-review`, …) and the model-keyed prompt files under `core/` | Wire values that belong to the model's vendor; no Atlas turn reaches those files |
| OpenAI's Codex CLI as a third-party ACP agent (`codex`, `codex-acp`, `@openai/codex-*`, its `CODEX_API_KEY` pass-through, the Memory panel's `~/.codex` reader, its icon and brand colour) | A different product that users install from the Marketplace |
| `tests/vendor-licensing.test.ts` | Names the path the engine was first imported under, where its git history lives |
| `crates/atlas-thread-metadata/src/schema.rs` | The V3 migration deletes the rows under the retired id |
| `docs/adr/*`, `docs/archive/*` | The historical record |

### How the sweep ran

`scripts/one-off/rename-engine.py` (committed with its output; delete it once the rename has landed) applied
these rules most-specific first, word-bounded, skipping the protected tokens above:
`vendor/codex` → `vendor/atlas-engine`; proto packages `codex.X.` → `atlas_engine.X.`;
product tokens (`codex_home`, `dot_codex_folder`, `codex_apps`, the MCP meta keys, the OTel
metric names, the originator, the keychain names) → `atlas_agent*`/`atlas-agent`/`atlas_apps`;
`codex-` → `atlas-engine-`; `codex_` → `atlas_engine_`; `CODEX_` → `ATLAS_AGENT_`;
`Codex<Upper>` → `AtlasEngine<Upper>`; `.codex` → `.atlas-agent`; and bare words split by
context — an identifier in code becomes `atlas_engine` / `AtlasEngine`, a word in a string,
comment or prose becomes `atlas-agent` / `Atlas Agent`. Schema exports, the compressed schema
blobs, `config.schema.json` and the insta snapshots were regenerated afterwards.

## Consequences

- Nearly every engine source file now carries the §4(b) change notice. Files with no comment
  syntax are listed in `vendor/atlas-engine/ATLAS-CHANGES.md`, the tree-level notice the
  licensing test holds them to.
- `.atlas-agent/` is now read from repos the way `.codex/` was: the behaviour is unchanged,
  the directory is ours.
- Any local thread rows, preferences or engine caches from before the rename are gone or
  rebuilt on first launch.
- Manually cherry-picking a fix from upstream now means renaming it first. Accepted in
  ADR-0003 already; this makes it a little more so.
