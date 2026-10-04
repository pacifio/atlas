<!-- Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md. -->
# Atlas's changes to this tree

This directory is a hard fork of an upstream engine under the Apache License 2.0
(`LICENSE`, `NOTICE`; fork point recorded in `docs/adr/0003-atlas-engine-fork-as-native-agent.md`).
Apache-2.0 §4(b) asks that modified files carry a prominent notice that they were changed.
Every source file Atlas has touched carries that notice on its first line. This file is the
same notice for the files that cannot carry one, and it states the one change that touched
the whole tree.

## The tree-wide change (ADR-0011)

Atlas renamed the fork: the directory, every crate, every identifier, environment variable,
on-disk name, protocol identifier and product-facing string that spelled the upstream's name
now spells Atlas Agent or `atlas-engine`. Nearly every file under this directory was modified
by that rename. Attribution and the licence texts were not touched; URLs to the upstream
project and the model identifiers it defined were kept as they were.

## Files modified without an in-file notice

Generated fixtures, regenerated after the rename and compared byte-for-byte by their tests,
so a header would be dropped or would fail the comparison:

- `app-server-protocol/schema/`
- `hooks/schema/`

Markdown the engine hands to the model verbatim (prompt templates, tool descriptions, the
sample skills it installs), modified by the rename; a comment in the file would reach the
model on every turn, so their notice lives here:

- `core/prompt_with_apply_patch_instructions.md`
- `core/templates/agents/orchestrator.md`
- `core/templates/model_instructions/gpt-5.2-codex_instructions_template.md`
- `memories/write/templates/memories/consolidation.md`
- `prompts/templates/realtime/backend_prompt.md`
- `skills/src/assets/samples/plugin-creator/SKILL.md`
- `skills/src/assets/samples/plugin-creator/references/installing-and-updating.md`
- `skills/src/assets/samples/plugin-creator/references/plugin-json-spec.md`
- `skills/src/assets/samples/skill-creator/SKILL.md`
- `skills/src/assets/samples/skill-installer/SKILL.md`

Files with no comment syntax, modified by the rename:

- `app-server/tests/suite/zsh`
- `chatgpt/tests/task_turn_fixture.json`
- `core/src/consequential_tool_message_templates.json`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__agents_md__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__apps_instructions__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__collaboration_mode__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__environment__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__environments_instructions__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__multi_agent_mode__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__permissions__tests__approved_prefix_is_rendered_without_reinjecting_permissions.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__permissions__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__plugins_instructions__tests__snapshots.snap`
- `core/src/context/world_state/snapshots/atlas_engine_core__context__world_state__realtime__tests__snapshots.snap`
- `core/src/guardian/snapshots/atlas_engine_core__guardian__tests__guardian_followup_review_request_layout.snap`
- `core/src/guardian/snapshots/atlas_engine_core__guardian__tests__guardian_review_request_layout.snap`
- `core/src/guardian/snapshots/atlas_engine_core__guardian__tests__network_access_guardian_prompt_layout.snap`
- `core/src/session/snapshots/atlas_engine_core__atlas_engine_tests__fork_startup_context_then_first_turn_diff.snap`
- `core/tests/suite/snapshots/all__suite__compact_remote__remote_manual_compact_api_auth_prompt_cache_key_request_diff.snap`
- `core/tests/suite/snapshots/all__suite__compact_remote__remote_manual_compact_chatgpt_auth_service_tier_prompt_cache_key_request_diff.snap`
- `core/tests/suite/snapshots/all__suite__mcp_tool_exposure__deferred_tools_initial_unchanged_and_removed.snap`
- `core/tests/suite/snapshots/all__suite__mcp_tool_exposure__deferred_tools_recover_during_sampling.snap`
- `core/tests/suite/snapshots/all__suite__mcp_tool_exposure__deferred_tools_resume_without_duplicate_update.snap`
- `models-manager/models.json`


## Prompt changes

- 2026-10: search guidance in all bundled prompts and model templates prefers Atlas's atlas_code grep/find_files tools, with shell rg as the fallback (ADR-0015).
