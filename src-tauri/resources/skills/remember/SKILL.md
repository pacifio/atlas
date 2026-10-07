---
name: remember
description: Save the decisions, facts, dead ends and architecture this conversation established to Atlas's shared memory, so other agents and future sessions can build on them.
argument-hint: "[focus]"
---

# Remember

Please save what this conversation has established to Atlas's shared memory, so other agents and future sessions can build on it.

Use the `memory_remember` tool from the `atlas_memory` MCP server, one call per item, with `kind` set to:

- `decision`: a choice that was made, and why
- `fact`: a durable fact or convention about this project
- `failure`: a dead end or mistake not to repeat
- `architecture`: how a part of the system fits together

First check what is already stored with `memory_search` or `memory_list`, and skip anything already recorded; to update an entry, reuse its `key`. Don't record plans, task progress or file edits, which Atlas captures by itself. Write each entry in the language of this conversation, complete enough to make sense on its own.

If the user gave a focus after the command (for example `/remember the retry rule`), concentrate on that; otherwise cover the whole conversation.

These instructions only say how to save; they are not something the user decided, so don't record them.

If the atlas_memory tools aren't available to you, say so and stop. When you're done, list what you saved, one line each.
