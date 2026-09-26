# The organisation tool server's fixed-prefix cost — measured

**Date:** 2026-09-26. **Branch:** `feat/agent-org-tools` @ `3eb8302b` plus the measuring test. **Status:** research; the only code added is the test that measures.

**Question.** Every native turn that is offered the organisation tool server (`atlas_org`, ADR-0014) carries its tool schemas in the request's fixed prefix. How many bytes, and roughly how many tokens, does it add? The UI tool server's seven tools were recorded at roughly 1.8 KB (ADR-0012, Consequences).

**Method.** The same one as `native-agent-input-tokens-measured.md` §3.1: exact JSON bytes of the tool schemas, converted to tokens at that note's measured ratio of **~3.6 bytes per token on Sonnet 4.6**, with its caveat that Opus 5 counted the same bytes about 35 % higher. Three figures:

1. **The `tools/list` result** the server answers, serialised as it goes over MCP (`tools_list(admin)`, including the `ttlMs` and `cacheScope` cache fields).
2. **The tools as the Chat Completions dialect puts them on the wire.** The dialect flattens each MCP server's namespace into one plain `function` per tool named `atlas_org__<tool>` (`vendor/atlas-engine/atlas-engine-api/src/atlas_chat/request.rs`, `reshape_tools` / `reshape_one`), so each tool is rebuilt here as `{"type":"function","function":{"name","description","parameters"}}`. This is the figure that is billed. It assumes the engine passes the MCP `inputSchema` through unchanged as `parameters`; any sanitising it does would shift it by a few bytes.
3. **The server's `INSTRUCTIONS`.** The engine records them as the namespace's description (`atlas-engine-mcp/src/rmcp_client.rs`, `namespace_description`), but `reshape_tools` only walks the namespace's child tools, so **on the Chat Completions wire the instructions are not sent**. They are listed as the cost they would add on a dialect that does send namespace descriptions.

## Result

| What | Member (12 tools) | Admin (13 tools) |
|---|---|---|
| `tools/list` JSON | 7,071 B (~1,960 tok) | 7,791 B (~2,160 tok) |
| **Chat wire tools** | **7,477 B (~2,080 tok)** | **8,237 B (~2,290 tok)** |
| `INSTRUCTIONS` (not on the Chat wire) | 1,043 B (~290 tok) | 1,043 B (~290 tok) |
| Wire tools + instructions (upper bound) | 8,520 B (~2,370 tok) | 9,280 B (~2,580 tok) |

So the organisation tool server adds about **7.5 KB, ~2.1k Sonnet tokens (~2.8k on Opus 5), to every native request** of a session that is offered it, and 0.76 KB more for an admin. That is about four times the UI tool server's ~1.8 KB, and well over the ~3 KB target. It is paid on every request, not per turn: a turn with N tool calls is N+1 requests (`native-agent-input-tokens-measured.md` §2).

### Per tool (Chat wire bytes, largest first)

| Bytes | Tool | Why it is large |
|---|---|---|
| 1,333 | `org_page_write` | the only nested schema: the diagram document's node and edge objects, with four enums |
| 1,094 | `org_sessions` | seven filter parameters, each with a description, and the longest tool description |
| 786 | `org_send` | four parameters with sentence-length descriptions (`to`, `mention`, `session`) |
| 760 | `org_member_activity` | admins only; a three-clause description plus four parameters |
| 726 | `org_session` | five parameters |
| 687 | `org_comment_reply` | the same `mention` description as `org_send` |
| 529 | `org_inbox` | |
| 498 | `org_comment_resolve` | |
| 448 | `org_comments` | |
| 435 | `org_page_create` | |
| 346 | `org_conversations` | |
| 313 | `org_members` | |
| 282 | `org_whoami` | |

The two largest, `org_page_write` and `org_sessions`, are 2.4 KB, a third of the total. Repeated parameter descriptions are the other visible cost: `session` ("A recorded session id, or \"current\" (the default).") appears on four tools, `since`/`until`/`workspace` on two, and the ~100-byte `mention` description on two.

## After the trim (review follow-up)

The prefix was cut toward the ~3 KB target, and the test now fails when a member's tools on the Chat wire exceed **3.5 KB** (and an admin's, with the instructions, 4.5 KB).

| What | Member (12 tools) | Admin (13 tools) |
|---|---|---|
| `tools/list` JSON | 3,089 B (~860 tok) | 3,425 B (~950 tok) |
| **Chat wire tools** | **3,495 B (~970 tok)** | **3,871 B (~1,080 tok)** |
| `INSTRUCTIONS` (not on the Chat wire) | 214 B | 214 B |

From 7,902 B (the figure after the `workspace` arguments of the one-Workspace policy were added) to 3,495 B for a member, by:

- `org_page_write`'s `document` is one object whose description gives the item shape of `nodes` and `edges` in one line, derived from `diagram.rs`'s `NODE_KINDS`, `SHAPES` and `ANCHORS`; the checking stays in Rust.
- One-clause tool descriptions; defaults, caps, windows and limits are left to the answers, which report them.
- Properties are described only where the name does not say it: `session` ("Id, link or current") on `org_comments`, `org_session` and `org_send`; `to` and an admin's `member` ("Name, id or atlas-org:// link"); `author` ("me, name, id or link"); `part` is an enum.
- No `required` arrays: every missing argument is refused in words by the code, which is where the rule is enforced.
- `limit` on `org_inbox` and `org_session`, and `live` on `org_sessions`, are no longer advertised; the code still honours them when passed.
- `INSTRUCTIONS` is three sentences. Because the Chat wire drops them, every rule that must reach the model is also in a description (`org_whoami`: "call first"; the outward tools: "the user approves first"; `org_inbox`: "read-only"), and each rule the model could break is enforced in code. `the_rules_the_model_must_see_ride_in_the_tool_descriptions` pins this.

Set `ORG_PREFIX_DUMP=1` to print every tool as it goes on the wire.

## How to reproduce

```sh
cd src-tauri
cargo test -p atlas --lib org_server_prefix -- --nocapture
```

The test is `org_server_prefix_bytes_are_measured` in `src-tauri/src/commands/org_server/tests.rs`. It prints the three figures and the per-tool table, and fails past the budgets above, so a growing description is a decision rather than drift. Run `bun run clean:rust` afterwards.
